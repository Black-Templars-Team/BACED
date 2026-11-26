"use strict";
const model = require("./damage_model.js");

const SHOT_RECORD_TYPES = new Set(["POSE", "SHOT", "FIRED", "HITPART", "HD", "WOUND", "STATE", "BLASTPOS"]);
const RECORD_TYPES = new Set(["RUN", "SELECTIONS", "AIM", "DONE", ...SHOT_RECORD_TYPES]);
// The locked battery poses: unarmed A-pose, standing with a rifle, kneeling with a rifle.
const STANDING_ANIMS = new Set(["amovpercmstpsnonwnondnon", "amovpercmstpsraswrfldnon", "amovpknlmstpsraswrfldnon"]);

// SQF strings escape quotes by doubling them, and leave backslashes literal.
function parsePayload(text) {
    const token = /\s*(\[|\]|,|"(?:[^"]|"")*"|true|false|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/iy;
    let offset = 0;
    function take() {
        token.lastIndex = offset;
        const match = token.exec(text);
        if (!match) throw new Error(`unexpected token at payload column ${offset + 1}`);
        offset = token.lastIndex;
        return match[1];
    }
    function value(first) {
        if (first === "[") {
            const items = [];
            let next = take();
            if (next === "]") return items;
            for (;;) {
                items.push(value(next));
                const sep = take();
                if (sep === "]") return items;
                if (sep !== ",") throw new Error("expected ',' or ']'");
                next = take();
            }
        }
        if (first.startsWith('"')) return first.slice(1, -1).replace(/""/g, '"');
        if (/^(true|false)$/i.test(first)) return first.toLowerCase() === "true";
        const number = Number(first);
        if (!Number.isFinite(number)) throw new Error(`invalid value ${first}`);
        return number;
    }
    const payload = value(take());
    if (!Array.isArray(payload) || !/^\s*"?\s*$/.test(text.slice(offset))) throw new Error("expected an SQF array payload");
    return payload;
}

function parseRpt(text) {
    const records = [];
    for (const [index, line] of text.split(/\r?\n/).entries()) {
        const tag = /BWB\|([A-Z]+)\|/.exec(line);
        if (!tag || !RECORD_TYPES.has(tag[1])) continue;
        try {
            records.push({type: tag[1], payload: parsePayload(line.slice(tag.index + tag[0].length)), line: index + 1});
        } catch (err) {
            throw new Error(`RPT line ${index + 1} (${tag[1]}): ${err.message}`);
        }
    }
    return records;
}

const positive = (x) => Number.isFinite(x) && x > 0;
const sum = (rows, fn) => rows.reduce((total, row) => total + fn(row), 0);
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length ? (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2 : null;
};
const SELECTION_HITPOINT = new Map(Object.entries(model.IMPACTS).map(([name, info]) => [info.selection, name]));
for (const side of ["left", "right"]) {
    SELECTION_HITPOINT.set(`${side}arm`, SELECTION_HITPOINT.get(`${side}forearm`));
    SELECTION_HITPOINT.set(`${side}upleg`, SELECTION_HITPOINT.get(`${side}leg`));
}

function addRow(groups, key, row) {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
}

function fitDirect(rows) {
    const groups = new Map();
    for (const row of rows) addRow(groups, `${row.typicalSpeed}:${Math.floor(row.speed / 50)}`, row);
    const bins = [...groups.values()].map((group) => {
        const y = Math.log(median(group.map((r) => r.ratio)));
        const spread = median(group.map((r) => Math.abs(Math.log(r.ratio) - y)));
        return {x: Math.log(median(group.map((r) => r.speed)) / group[0].typicalSpeed), y,
            weight: 1 / (0.05 + spread) ** 2};
    });
    if (new Set(bins.map((b) => b.x)).size < 3) return null;
    const weight = sum(bins, (b) => b.weight);
    let best = null;
    for (let c = 30; c <= 150; c++) {
        const capRatio = c / 100;
        const x = bins.map((b) => Math.min(0, b.x - Math.log(capRatio)));
        for (let k = 8; k <= 100; k++) {
            const exponent = k / 40;
            const residuals = bins.map((b, i) => b.y - exponent * x[i]);
            // Fit bin medians, downweighting bins with inconsistent damage ratios.
            const mean = residuals.reduce((total, r, i) => total + r * bins[i].weight, 0) / weight;
            const lo = Math.max(50, Math.min(150, Math.floor(100 * Math.exp(mean))));
            for (let s = lo; s <= Math.min(150, lo + 1); s++) {
                const scale = s / 100, intercept = Math.log(scale);
                const sse = residuals.reduce((total, r, i) => total + bins[i].weight * (r - intercept) ** 2, 0);
                if (!best || sse < best.sse) best = {scale, capRatio, exponent, sse};
            }
        }
    }
    return {...best, bins: bins.length, logRmse: Math.sqrt(best.sse / weight)};
}

function fitBlast(groups) {
    // Each run/ammo pair can have a different full-strength delta. Fit that
    // amplitude at each candidate endpoint, so only the curve shape is shared.
    const series = [...groups.values()].filter((rows) => rows.some((r) => r.delta > 0) &&
        rows.some((r) => r.distance > r.radius) && new Set(rows.map((r) => r.distance)).size > 1);
    if (!series.length) return null;
    const tolerance = 1e-12 * sum(series, (rows) => sum(rows, (r) => r.delta ** 2));
    let best = null;
    let tied = false;
    for (let step = 10; step <= 80; step++) {
        const end = step / 10;
        const amplitudes = [];
        const sse = sum(series, (rows) => {
            const factors = rows.map((r) => model.blastFalloff(r.distance, r.radius, end));
            const norm = sum(factors, (f) => f * f);
            const amplitude = norm ? rows.reduce((total, r, i) => total + r.delta * factors[i], 0) / norm : 0;
            amplitudes.push({run: rows[0].run, ammo: rows[0].ammo, amplitude});
            return rows.reduce((total, r, i) => total + (r.delta - amplitude * factors[i]) ** 2, 0);
        });
        if (!best || sse < best.sse - tolerance) {
            best = {end, sse, samples: sum(series, (rows) => rows.length), amplitudes};
            tied = false;
        } else if (Math.abs(sse - best.sse) <= tolerance) tied = true;
    }
    return {...best, tied};
}

function getRun(payload, data) {
    const [productVersion, aceVersion, cbaVersion, settingsPairs, mode, ammo, targetClass,
        uniform, vest, helmet, backpack] = payload;
    const loadout = {uniform, vest, helmet, backpack};
    const gear = model.resolveLoadout(data, loadout);
    const missing = ["uniform", "vest", "helmet"].filter((key) => loadout[key] && !gear[key]).map((key) => loadout[key]);
    if (!gear.unit && (uniform || !targetClass || !data.gear.units[targetClass])) missing.push("unit armor");
    if (!uniform && data.gear.units[targetClass]) gear.unit = data.gear.units[targetClass];
    const hitpoints = new Map(Object.keys(gear.unit?.hitpoints || {}).map((name) => [name.toLowerCase(), name]));
    return {productVersion, aceVersion, cbaVersion, settingsPairs, mode, ammo, targetClass, loadout, gear, missing, hitpoints};
}

function groupShot(records, run) {
    const hits = [], cycles = [], events = {};
    let lastHit = null, cycle = null, structuralDelta = 0;
    for (const {type, payload} of records) {
        (events[type] ||= []).push(payload);
        if (type === "HITPART" && positive(payload[3])) {
            const [, selections, modelPos, speed, , , , surface, , ammo] = payload;
            const selection = selections[0]?.toLowerCase() ?? null;
            const mapped = SELECTION_HITPOINT.get(selection);
            lastHit = {selection, hitpoint: mapped ? run.hitpoints.get(mapped.toLowerCase()) || mapped : null,
                modelPos, speed, surface: surface.toLowerCase().split(/[\\/]/).pop(), ammo};
            hits.push(lastHit);
        } else if (type === "HD") {
            const [, , hitpoint, , , , delta, ammo, , context] = payload;
            if (!hitpoint && Number.isFinite(delta)) structuralDelta = Math.max(structuralDelta, delta);
            // ACE's synthetic bracket can arrive after WOUND; it is not a new impact cycle.
            if (!hitpoint || hitpoint.toLowerCase() === "ace_hdbracket" || (context !== 1 && context !== 2)) continue;
            cycle ||= {hit: lastHit, deltas: new Map(), ammo};
            const key = run.hitpoints.get(hitpoint.toLowerCase()) || hitpoint.toLowerCase();
            if (Number.isFinite(delta)) cycle.deltas.set(key, Math.max(cycle.deltas.get(key) ?? -Infinity, delta));
        } else if (type === "WOUND" && cycle) {
            cycles.push({...cycle.hit, ammo: cycle.hit?.ammo || cycle.ammo || payload[2],
                deltas: Object.fromEntries(cycle.deltas), woundDamages: payload[1]});
            cycle = null;
        }
    }
    return {hits, cycles, events, structuralDelta};
}

const point = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
// WOUND tuples carry the damage first; the third field is the armor-adjusted value, not ACE wound damage.
const woundDamage = ([, damages]) => sum(damages, ([damage]) => positive(damage) ? damage : 0);
const emptyScore = () => ({matches: 0, total: 0, overlap: 0, weightedOverlap: 0});

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function segmentDistanceSquared(offset, edge, lengthSquared) {
    const t = lengthSquared ? Math.max(0, Math.min(1, dot(offset, edge) / lengthSquared)) : 0;
    return (offset[0] - t * edge[0]) ** 2 + (offset[1] - t * edge[1]) ** 2 + (offset[2] - t * edge[2]) ** 2;
}

function fitTransform(geometry, hits) {
    if (!geometry.fireFaces?.length || !hits.length) return null;
    // Fan-triangulate as in raycast. Use distance to the surface, not to face centroids.
    const triangles = geometry.fireFaces.flatMap(([a, ...rest], f) => rest.slice(1).map((c, i) => {
        const b = rest[i], ab = sub(b, a), ac = sub(c, a), bc = sub(c, b);
        const aa = dot(ab, ab), cc = dot(ac, ac), cross = dot(ab, ac);
        return {a, b, ab, ac, bc, aa, cc, cross, bb: dot(bc, bc), det: aa * cc - cross ** 2,
            selection: geometry.fireSelections[f]?.toLowerCase()};
    }));
    let best = null;
    for (const depthSign of [1, -1]) {
        for (let h = 100; h <= 160; h++) {
            const transform = {heightOffset: h / 100, depthSign};
            let matches = 0;
            const groups = {torsoLeg: {matches: 0, total: 0}, arms: {matches: 0, total: 0}};
            for (const hit of hits) {
                const p = model.gameToFigure(hit.modelPos, transform);
                let distance = Infinity, nearest;
                for (const {a, b, ab, ac, bc, aa, cc, bb, cross, det, selection} of triangles) {
                    const ap = sub(p, a), u = dot(ap, ab), v = dot(ap, ac);
                    const s = cc * u - cross * v, t = aa * v - cross * u;
                    const d = det > 0 && s >= 0 && t >= 0 && s + t <= det
                        ? dot(ap, ap) - (s * u + t * v) / det
                        : Math.min(segmentDistanceSquared(ap, ab, aa), segmentDistanceSquared(ap, ac, cc),
                            segmentDistanceSquared(sub(p, b), bc, bb));
                    if (d < distance) { distance = d; nearest = selection; }
                }
                const matched = hit.selection === nearest;
                if (matched) matches++;
                const part = selectionPart(hit.selection);
                const group = part?.endsWith("Arm") ? groups.arms :
                    part === "Body" || part?.endsWith("Leg") ? groups.torsoLeg : null;
                if (group) { group.total++; group.matches += Number(matched); }
            }
            if (!best || matches > best.matches) best = {...transform, matches, total: hits.length, matchRate: matches / hits.length, groups};
        }
    }
    return best;
}

const SPREAD_MODES = ["ray", "rayFalloff", "impact", "impactFalloff"];
const selectionPart = (selection) => model.IMPACTS[SELECTION_HITPOINT.get(selection)]?.part;

function spreadRows(geometry, rows, transform) {
    return rows.flatMap(({run, cycle}) => {
        // Compare only hitpoints the geometry model can test, not engine bookkeeping or aggregate points.
        const supported = Object.keys(model.IMPACTS).filter((name) => {
            const hp = run.gear.unit.hitpoints[name];
            return hp && geometry.hitpoints[String(hp.name).toLowerCase()]?.length;
        });
        if (!supported.length) return [];
        const position = model.gameToFigure(cycle.modelPos, transform);
        // Undo armor before comparing relative damage to the sphere weights.
        const actual = supported.map((name) => {
            const key = run.hitpoints.get(name.toLowerCase());
            return [name, Math.max(0, cycle.deltas[key] || 0) * model.hitpointArmor(run.gear, key).engine];
        });
        const max = Math.max(...actual.map(([, delta]) => delta));
        return [{gear: run.gear, position, actual, max}];
    });
}

function compareHitpoints(geometry, rows, radiusScale) {
    const agreement = Object.fromEntries(SPREAD_MODES.map((mode) => [mode, emptyScore()]));
    for (const mode of SPREAD_MODES) {
        const test = mode.startsWith("ray") ? "ray" : "impact";
        const falloff = mode.endsWith("Falloff");
        const score = agreement[mode];
        for (const {gear, position, actual, max} of rows) {
            const {reached} = model.testHitpoints(geometry, gear, position, test, falloff, radiusScale);
            const predicted = new Map(reached);
            let intersection = 0, union = 0, weightMin = 0, weightMax = 0;
            for (const [name, delta] of actual) {
                const a = max ? delta / max : 0, p = predicted.get(name) || 0;
                if (a || p) union++;
                if (a && p) intersection++;
                weightMin += Math.min(a, p);
                weightMax += Math.max(a, p);
            }
            score.total++;
            if (intersection === union) score.matches++;
            score.overlap += union ? intersection / union : 1;
            score.weightedOverlap += weightMax ? weightMin / weightMax : 1;
        }
    }
    for (const score of Object.values(agreement)) {
        score.percent = score.total ? 100 * score.overlap / score.total : null;
        score.weightedPercent = score.total ? 100 * score.weightedOverlap / score.total : null;
    }
    return agreement;
}

function analyse(records, data, {geometry = null} = {}) {
    const logs = Array.isArray(records[0]) ? records : [records];
    let runNumber = 0;
    const runs = [], shotGroups = [];
    const notes = new Set();
    for (const log of logs) {
        const start = log.findLastIndex(({type}) => type === "RUN");
        if (start < 0) throw new Error("No BWB RUN records found in RPT");
        runNumber += log.slice(0, start + 1).filter((r) => r.type === "RUN").length;
        const run = getRun(log[start].payload, data);
        const {gear, hitpoints, ...meta} = run;
        runs.push(meta);
        if (run.missing.length) notes.add(`Missing armor data (${run.missing.join(", ")}); skipping direct fit.`);
        const groups = new Map();
        for (const record of log.slice(start + 1)) {
            if (SHOT_RECORD_TYPES.has(record.type)) addRow(groups, record.payload[0], record);
        }
        for (const [id, shotRecords] of groups) shotGroups.push({id, shotRecords, run, runNumber});
    }

    const direct = [], blast = [], shots = [];
    const blastGroups = new Map(), hitsHistogram = new Map(), losses = new Map(), misses = new Map(), speeds = new Map();
    const counts = {shots: 0, direct: 0, range: 0, blast: 0, blastWithHD: 0, withHitPart: 0,
        noHitpointReached: 0, wrongPose: 0};
    const transformHits = [], torsoLeg = [], arms = [];
    if (!geometry) notes.add("Hitpoint agreement needs data/body_geometry.js for the target model.");
    for (const {id, shotRecords, run, runNumber} of shotGroups) {
        const {hits, cycles, events, structuralDelta} = groupShot(shotRecords, run);
        if (!events.SHOT && !events.FIRED) continue;
        if (events.POSE?.some(([, anim]) => typeof anim !== "string" || !STANDING_ANIMS.has(anim.toLowerCase()))) {
            counts.wrongPose++;
            continue;
        }
        const [, kind = "manual", aim, shotSpeed] = events.SHOT?.[0] || [];
        const ref = {run: runNumber, shotId: id};
        const wounds = events.WOUND || [];
        const aceDamage = sum(wounds, woundDamage);
        const noHitpointReached = hits.length > 0 && !wounds.length && !events.HD?.some((hd) =>
            hd[2] && (hd[9] === 1 || hd[9] === 2) && positive(hd[6]));
        counts.shots++;
        if (["direct", "range", "blast"].includes(kind)) counts[kind]++;
        if (hits.length) counts.withHitPart++;
        if (noHitpointReached) counts.noHitpointReached++;
        shots.push({...ref, kind, aim, shotSpeed, hits, cycles, structuralDelta, noHitpointReached,
            aceDamage, woundEvents: wounds.length, events});

        if (kind === "blast") {
            const distance = events.BLASTPOS?.at(-1)?.[1] ?? aim;
            const ammoName = hits[0]?.ammo || events.FIRED?.[0]?.[1] || run.ammo;
            const withHD = Boolean(events.HD?.length);
            if (withHD) counts.blastWithHD++;
            if (!Number.isFinite(distance) || distance < 0) continue;
            const delta = cycles.length ? Math.max(0, ...cycles.flatMap((c) => Object.values(c.deltas))) : null;
            const row = {...ref, ammo: ammoName, distance, radius: data.ammo[ammoName]?.indirectHitRange ?? null, delta, withHD};
            blast.push(row);
            if (cycles.length && positive(row.radius)) addRow(blastGroups, `${runNumber}:${ammoName}`, row);
            else if (cycles.length) notes.add(`No indirectHitRange for blast ammo: ${ammoName}`);
            continue;
        }

        hitsHistogram.set(hits.length, (hitsHistogram.get(hits.length) || 0) + 1);
        if (geometry) transformHits.push(...hits.filter((hit) => hit.selection && point(hit.modelPos)));
        if (!hits.length && typeof aim === "string") {
            const name = aim.toLowerCase();
            misses.set(name, (misses.get(name) || 0) + 1);
        }
        if (positive(shotSpeed)) addRow(speeds, shotSpeed, {aceDamage, woundEvents: wounds.length, hit: hits.length > 0});
        for (let i = 1; i < hits.length; i++) {
            const prev = hits[i - 1], next = hits[i];
            if (!prev.surface || !point(prev.modelPos) || !point(next.modelPos)) continue;
            const distance = Math.hypot(...prev.modelPos.map((p, axis) => p - next.modelPos[axis]));
            if (distance > 0) addRow(losses, prev.surface, {loss: (prev.speed - next.speed) / distance, ratio: next.speed / prev.speed});
        }
        for (const cycle of cycles) {
            const {selection, hitpoint, speed, ammo: ammoName, deltas} = cycle;
            const part = selectionPart(selection);
            if (geometry && run.gear.unit && point(cycle.modelPos)) {
                if (part?.endsWith("Arm")) arms.push({run, cycle});
                else if (part === "Body" || part?.endsWith("Leg")) torsoLeg.push({run, cycle});
            }
            if (part !== "Body" ||
                !positive(deltas[hitpoint]) || run.missing.length) continue;
            const ammo = data.ammo[ammoName];
            if (!ammo) notes.add(`Ammo not found in extracted data: ${ammoName}`);
            if (!positive(ammo?.hit) || !positive(ammo?.typicalSpeed) || !run.hitpoints.has(hitpoint.toLowerCase())) continue;
            const armor = model.hitpointArmor(run.gear, hitpoint).engine;
            const delta = deltas[hitpoint];
            direct.push({...ref, ammo: ammoName, speed, typicalSpeed: ammo.typicalSpeed, hitpoint, delta, armor,
                ratio: delta * armor / ammo.hit});
        }
    }
    const directFit = fitDirect(direct);
    const blastFit = fitBlast(blastGroups);
    const settings = {};
    if (directFit) {
        settings.engine_damageScale = directFit.scale;
        settings.engine_speedCapRatio = directFit.capRatio;
        settings.engine_speedExponent = directFit.exponent;
    }
    if (blastFit && !blastFit.tied) settings.engine_blastFalloffEnd = blastFit.end;
    const transform = geometry ? fitTransform(geometry, transformHits) : null;
    const mappedTorsoLeg = spreadRows(geometry, torsoLeg, transform || model.GAME_TO_FIGURE);
    const mappedArms = spreadRows(geometry, arms, transform || model.GAME_TO_FIGURE);
    const baseline = compareHitpoints(geometry, mappedTorsoLeg, 1);
    const rank = (scores) => Object.entries(scores).sort(([, a], [, b]) => b.weightedPercent - a.weightedPercent);
    let agreement = baseline, radiusScale = 1;
    let ranked = rank(agreement);
    // Search radius only when no unscaled model reaches 70% weighted overlap.
    if (ranked[0][1].total && ranked[0][1].weightedPercent < 70) {
        for (let r = 10; r <= 60; r++) {
            if (r === 20) continue;
            const scores = compareHitpoints(geometry, mappedTorsoLeg, r / 20);
            const candidate = rank(scores);
            if (candidate[0][1].weightedPercent > ranked[0][1].weightedPercent) {
                agreement = scores;
                ranked = candidate;
                radiusScale = r / 20;
            }
        }
    }
    const armAgreement = compareHitpoints(geometry, mappedArms, radiusScale);
    if (ranked[0][1].total) {
        const best = ranked[0][0];
        settings.engine_hitpointTest = best.startsWith("ray") ? "ray" : "impact";
        settings.engine_hitpointFalloff = best.endsWith("Falloff");
        settings.engine_hitpointRadiusScale = radiusScale;
    }
    if (!directFit && (counts.direct || counts.range)) notes.add("Torso fit needs usable positive deltas in at least three speed bins.");
    if (counts.blastWithHD && (!blastFit || blastFit.tied)) notes.add("Blast samples do not uniquely identify an endpoint; collect more distances around the falloff.");
    const roundHits = shots.filter((s) => s.kind !== "blast").map((s) => s.hits.length);
    const aceByShotSpeed = [...speeds].sort(([a], [b]) => a - b).map(([speed, rows]) => {
        const hitRows = rows.filter((r) => r.hit);
        return {speed, rounds: rows.length, hitRounds: hitRows.length,
            meanDamage: sum(rows, (r) => r.aceDamage) / rows.length,
            meanWoundEvents: sum(rows, (r) => r.woundEvents) / rows.length,
            meanDamageOnHit: hitRows.length ? sum(hitRows, (r) => r.aceDamage) / hitRows.length : null,
            meanWoundEventsOnHit: hitRows.length ? sum(hitRows, (r) => r.woundEvents) / hitRows.length : null};
    });
    return {runs, runNumber, counts, shots, direct: {samples: direct, fit: directFit},
        hitsPerRound: {histogram: Object.fromEntries(hitsHistogram), median: median(roundHits), medianOnHit: median(roundHits.filter(positive))},
        speedLossBySurface: Object.fromEntries([...losses].map(([surface, rows]) => [surface, {samples: rows.length,
            medianLoss: median(rows.map((r) => r.loss)), medianSpeedRatio: median(rows.map((r) => r.ratio))}])),
        aceByShotSpeed, missesByAim: Object.fromEntries(misses), blast: {samples: blast, fit: blastFit},
        transform, baseline, radiusScale, agreement, armAgreement, settings, notes: [...notes]};
}

function formatAnalysis(result) {
    const {counts, direct, blast, transform, agreement, armAgreement, settings, notes} = result;
    const number = (value) => String(Number(value.toPrecision(6)));
    const agree = ({matches, total, percent, weightedPercent}) => total
        ? `${percent.toFixed(1)}% overlap, ${weightedPercent.toFixed(1)}% damage-weighted overlap (${matches}/${total} exact)` : "n/a";
    const lines = [
        `Calibration: ${result.runs.length > 1 ? `latest RUN from each of ${result.runs.length} RPTs` : `latest RUN (#${result.runNumber})`}, ${counts.shots} shot(s) (${counts.direct} direct, ${counts.range} range, ${counts.blast} blast)`,
        `Shots in wrong pose: ${counts.wrongPose} (excluded)`,
        "Measurement                Result",
        `engine_damageScale         ${direct.fit ? number(direct.fit.scale) : "n/a"} (${direct.samples.length} torso cycles)`,
        `engine_speedCapRatio       ${direct.fit ? number(direct.fit.capRatio) : "n/a"}`,
        `engine_speedExponent       ${direct.fit ? number(direct.fit.exponent) : "n/a"}`,
        `Game-to-figure fit         ${transform ? `H=${transform.heightOffset.toFixed(2)} m, s=${transform.depthSign}; ${(100 * transform.matchRate).toFixed(1)}% selection match (${transform.matches}/${transform.total})` : "n/a"}`,
        ...(transform ? Object.entries(transform.groups).map(([group, {matches, total}]) =>
            `Selection match ${group}: ${total ? `${(100 * matches / total).toFixed(1)}% (${matches}/${total})` : "n/a"}`) : []),
        ...(result.radiusScale !== 1 ? SPREAD_MODES.map((mode) => `Hitpoints torso/legs ${mode} (scale 1): ${agree(result.baseline[mode])}`) : []),
        `Hitpoint radius scale      ${settings.engine_hitpointRadiusScale ?? "n/a"}`,
        ...[["torso/legs", agreement], ["arms", armAgreement]].flatMap(([group, scores]) =>
            SPREAD_MODES.map((mode) => `Hitpoints ${group} ${mode}: ${agree(scores[mode])}`)),
        `Blast falloff end          ${blast.fit && !blast.fit.tied ? number(blast.fit.end) : "n/a"} (${blast.samples.length} samples)`,
        `No hitpoint reached        ${counts.noHitpointReached}/${counts.withHitPart} shots with real HITPART`,
        `Hits per round             median ${result.hitsPerRound.median ?? "n/a"} (on hit: ${result.hitsPerRound.medianOnHit ?? "n/a"}); histogram (hits: rounds) ${Object.entries(result.hitsPerRound.histogram).map(([hits, rounds]) => `${hits}: ${rounds}`).join(", ") || "n/a"}`,
    ];
    for (const [surface, row] of Object.entries(result.speedLossBySurface)) {
        lines.push(`Speed loss: ${surface}: ${number(row.medianLoss)} m/s/m (median speed ratio ${number(row.medianSpeedRatio)}, ${row.samples} pairs)`);
    }
    if (result.aceByShotSpeed.length) {
        const means = (all, onHit) => `${number(all)} (${onHit === null ? "n/a" : number(onHit)})`;
        lines.push("", "SHOT speed (m/s)   Rounds (hit)   Mean ACE damage (on hit)   Mean WOUND events (on hit)");
        for (const row of result.aceByShotSpeed) {
            lines.push(`${String(row.speed).padEnd(19)}${`${row.rounds} (${row.hitRounds})`.padEnd(15)}${means(row.meanDamage, row.meanDamageOnHit).padEnd(27)}${means(row.meanWoundEvents, row.meanWoundEventsOnHit)}`);
        }
    }
    lines.push("", `Shots with no real HITPART by aim: ${Object.entries(result.missesByAim).map(([aim, misses]) => `${aim}: ${misses}`).join(", ") || "none"}`);
    if (counts.blast) lines.push(`Blast: ${counts.blast - counts.blastWithHD}/${counts.blast} shots have no HD records.`);
    if (blast.samples.length) {
        lines.push("", "Run  Shot       Distance (m)   Max delta");
        for (const sample of blast.samples) {
            const delta = sample.delta === null ? (sample.withHD ? "no complete cycle" : "no HD") : number(sample.delta);
            lines.push(`${String(sample.run).padEnd(5)}${String(sample.shotId).padEnd(11)}${number(sample.distance).padEnd(15)}${delta}`);
        }
    }
    if (Object.keys(settings).length) {
        lines.push("", "Suggested overrides:");
        for (const [name, value] of Object.entries(settings)) lines.push(`  --set ${name}=${typeof value === "number" ? number(value) : value}`);
    }
    for (const note of notes) lines.push(`Note: ${note}`);
    return lines.join("\n");
}

module.exports = {parseRpt, analyse, formatAnalysis};
