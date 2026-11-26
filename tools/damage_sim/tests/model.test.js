/*
 * Tests for damage_model.js against the extracted data.
 *
 *   node --test tools/damage_sim/tests/
 *
 * Fixture tests run without game assets. The remaining tests use the BT preset as extracted on
 * 2026-11-25 (python3 extract.py) and skip if their data or geometry is missing.
 */
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {spawnSync} = require("node:child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const M = require("../damage_model.js");
const {buildPoints} = require("../balance_points.js");
const {buildBalanceRows, balanceCsv} = require("../sim.js");
const {parseRpt, analyse, formatAnalysis} = require("../calibrate.js");

const DATA_DIR = require("../data_dir.js")();
const DATA_FILE = path.join(DATA_DIR, "game_data.json");
const SERVER_FILE = path.join(DATA_DIR, "server_settings.json");
const GEOMETRY_FILE = path.join(DATA_DIR, "body_geometry.js");
const ROSTER_FILE = path.join(DATA_DIR, "roster.js");
const haveData = fs.existsSync(DATA_FILE);
const data = haveData ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : null;
const server = fs.existsSync(SERVER_FILE) ? JSON.parse(fs.readFileSync(SERVER_FILE, "utf8")) : null;
const geometry = fs.existsSync(GEOMETRY_FILE) ? (() => {
    const t = fs.readFileSync(GEOMETRY_FILE, "utf8");
    return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
})() : null;

const LOADOUT = {uniform: "TIOW_Mk7PowerArmor_1_BT", vest: "TIOW_Mk7Limbs_BT", helmet: "TIOW_MK7Helmet_BT", backpack: ""};
const base = (extra) => Object.assign({weapon: "BT_TyrianBolter", distance: 100, impact: "HitChest", loadout: LOADOUT,
    samples: 200, seed: 3}, extra);
const opts = {skip: haveData ? false : "run python3 extract.py first"};
const readRpt = (name) => parseRpt(fs.readFileSync(path.join(__dirname, "fixtures", `${name}.rpt`), "utf8"));
const within = (value, lo, hi) => assert.ok(value >= lo && value <= hi, `${value} not in [${lo}, ${hi}]`);
const WB_CLASS = "30k_Steve_Tactical_Legionary_MK_4_WB";
const WB_UNIFORM = "30k_Steve_Armour_MK_4_WB";

// Older extracted presets do not have model fields; use the known test model
// in that case. The reader test covers extraction and page trimming separately.
function withModel(d, uniform, model, aiClass) {
    const gear = d.gear;
    const cls = gear.uniforms[uniform].unitClass;
    const unit = gear.units[cls];
    const ai = gear.aiUnits[aiClass];
    return {...d, gear: {...gear, units: {...gear.units, [cls]: {model, ...unit}},
        aiUnits: ai ? {...gear.aiUnits, [aiClass]: {model, ...ai}} : gear.aiUnits}};
}

test("calibration reads SQF and recovers known direct and blast settings", () => {
    const records = parseRpt(fs.readFileSync(path.join(__dirname, "fixtures", "sample.rpt"), "utf8"));
    const fixtureData = require("./fixtures/sample-data.json");
    assert.deepStrictEqual(records[0].payload[3], [["label", 'Bench "test"'], ["enabled", true]]);
    const result = analyse(records, fixtureData, {geometry: {hitpoints: {spine3: [[0.25, -0.92, 0.2]]}}});
    assert.ok(Math.abs(result.settings.engine_damageScale / 0.7 - 1) < 0.05);
    assert.ok(Math.abs(result.settings.engine_speedExponent / 1.5 - 1) < 0.05);
    assert.strictEqual(result.settings.engine_blastFalloffEnd, 3.5);
    assert.deepStrictEqual(result.direct.samples.map((s) => [s.speed, s.armor]), [[250, 10], [500, 10], [1000, 10]]);
    assert.strictEqual(result.shots[0].hits.length, 1);
    assert.deepStrictEqual(result.shots[0].cycles[0].deltas, {HitChest: 0.0875});
    assert.strictEqual(result.shots[3].structuralDelta, 1e-5);
    assert.strictEqual(result.counts.noHitpointReached, 1);
    assert.strictEqual(result.agreement.ray.percent, 100);
    assert.strictEqual(result.agreement.impact.percent, 0);
    assert.strictEqual(result.settings.engine_hitpointTest, "ray");
    assert.strictEqual(result.settings.engine_hitpointFalloff, false);
    assert.throws(() => parseRpt('1:00 "BWB|HD|[1,]"'), /RPT line 1 \(HD\)/);
});

test("calibration isolates the latest RUN and locks impact attribution at the first cycle HD", () => {
    const records = parseRpt(fs.readFileSync(path.join(__dirname, "fixtures", "sample.rpt"), "utf8"));
    const fixtureData = require("./fixtures/sample-data.json");
    const latest = records.slice(0, records.findIndex((r) => r.type === "WOUND") + 1);
    latest.splice(-1, 0, {type: "HITPART", payload: [1, ["pelvis"], [0, 0, 0], 200, [], 0, 0, "meat.bisurf", true, "BenchRound"]});
    const result = analyse([...records, ...latest], fixtureData);
    assert.strictEqual(result.runNumber, 2);
    assert.strictEqual(result.counts.shots, 1);
    const [shot] = result.shots;
    assert.deepStrictEqual(shot.hits.map((hit) => hit.selection), ["spine3", "pelvis"]);
    assert.strictEqual(shot.cycles[0].selection, "spine3");
    assert.strictEqual(shot.cycles[0].speed, 250);
    assert.deepStrictEqual(shot.cycles[0].woundDamages, [[0.0875, "Body", 0.875]]);
    assert.strictEqual(shot.aceDamage, 0.0875);
});

test("calibration recovers torso damage and penetration from the WB Mk 4 battery", () => {
    const records = readRpt("battery-wb-mk4");
    const result = analyse(records, require("./fixtures/battery-wb-mk4-data.json"));
    within(result.settings.engine_damageScale, 0.8, 1.0);
    within(result.hitsPerRound.medianOnHit, 2, 4);
    assert.strictEqual(result.hitsPerRound.histogram[0], 16);
    within(result.speedLossBySurface["meat.bisurf"].medianLoss, 100, 250);
    within(result.speedLossBySurface["meatbones.bisurf"].medianLoss, 500, 1000);
    assert.strictEqual(result.missesByAim.head, 15);
    assert.strictEqual(result.shots.reduce((total, shot) => total + shot.woundEvents, 0), 246);
    assert.match(formatAnalysis(result), /Blast: 9\/9 shots have no HD records/);
    assert.strictEqual(result.blast.fit, null);
});

test("calibration pools torso cycles from all three WB Mk 4 runs", () => {
    const records = [readRpt("battery-wb-mk4"), readRpt("battery-wb-mk4-apose"), readRpt("battery-wb-mk4-aim")];
    const result = analyse(records, require("./fixtures/battery-wb-mk4-data.json"));
    assert.deepStrictEqual([...new Set(result.direct.samples.map((s) => s.run))], [1, 2, 3]);
    assert.strictEqual(result.shots.filter((s) => s.run === 2 && s.hits.length === 1 && s.kind !== "blast").length, 130);
    within(result.settings.engine_damageScale, 0.85, 1.0);
    within(result.settings.engine_speedCapRatio, 0.75, 1.0);
    within(result.settings.engine_speedExponent, 0.35, 0.8);
    assert.strictEqual(result.settings.engine_blastFalloffEnd, 1.7);
});

test("calibration CLI runs all three WB Mk 4 fixtures without extracted data", (t) => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "damage-sim-test-"));
    t.after(() => fs.rmSync(dataDir, {recursive: true, force: true}));
    const result = spawnSync(process.execPath, ["sim.js", "calibrate",
        "--rpt", "tests/fixtures/battery-wb-mk4.rpt",
        "--rpt", "tests/fixtures/battery-wb-mk4-apose.rpt",
        "--rpt", "tests/fixtures/battery-wb-mk4-aim.rpt"], {
        cwd: path.resolve(__dirname, ".."),
        env: {...process.env, DAMAGE_SIM_DATA_DIR: dataDir},
        encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(result.stdout, /latest RUN from each of 3 RPTs/);
});

test("A-pose calibration aligns torso and leg selections and recovers spread defaults", {skip: !haveData || !geometry}, () => {
    const records = [readRpt("battery-wb-mk4-apose"), readRpt("battery-wb-mk4-aim")];
    const fit = analyse(records, data, {geometry});
    const {heightOffset, depthSign, matchRate, groups} = fit.transform;
    within(heightOffset, 1.2, 1.4);
    assert.deepStrictEqual({heightOffset, depthSign, matchRate}, M.GAME_TO_FIGURE);
    assert.ok(groups.torsoLeg.matches / groups.torsoLeg.total > 0.7);
    assert.ok(fit.agreement.ray.weightedPercent > fit.baseline.ray.weightedPercent);
    const defaults = M.settingDefaults({});
    for (const suffix of ["Test", "Falloff", "RadiusScale"]) {
        const key = `engine_hitpoint${suffix}`;
        assert.strictEqual(fit.settings[key], defaults[key]);
    }
});

test("calibration recovers known settings using the extracted loadout and ammo", opts, () => {
    const ammo = "BT_MSB_Rnd";
    const {hit, typicalSpeed} = data.ammo[ammo];
    const lines = [["RUN", [[], "", "", [], "vanilla", ammo, "", LOADOUT.uniform, LOADOUT.vest, LOADOUT.helmet, ""]]];
    for (const [id, ratio] of [0.35, 0.6, 1].entries()) {
        const delta = 0.7 * hit * ratio ** 1.5 / 140; // Mk 7 chest armor from the extracted-data armor test.
        lines.push(["SHOT", [id, "direct", "spine3", typicalSpeed * ratio, []]],
            ["HITPART", [id, ["spine3"], [], typicalSpeed * ratio, [], 0, 0, "", true, ammo, id]],
            ["HD", [id, "spine3", "HitChest", 0, delta, 0, delta, ammo, true, 1, id]],
            ["WOUND", [id, [[delta, "Body", delta * 140]], ammo, id]]);
    }
    const result = analyse(parseRpt(lines.map(([type, fields]) => `BWB|${type}|${JSON.stringify(fields)}`).join("\n")), data);
    assert.ok(Math.abs(result.settings.engine_damageScale / 0.7 - 1) < 0.05);
    assert.ok(Math.abs(result.settings.engine_speedExponent / 1.5 - 1) < 0.05);
});

test("ACE armor: log scaling of the Mk7 pauldrons, engine sum unscaled", opts, () => {
    const gear = M.resolveLoadout(data, LOADOUT);
    const armor = M.hitpointArmor(gear, "HitChest");
    // uniform 40 x HitChest 1, pauldrons 100 at passThrough 0.1 -> log10(100 / 0.1^0.6) x 10
    assert.ok(Math.abs(armor.vest.armor - 26.0) < 0.1, armor.vest.armor);
    assert.ok(Math.abs(armor.ace - 66.0) < 0.1, armor.ace);
    assert.strictEqual(armor.engine, 140);
});

test("ACE damage type comes from CfgAmmo inheritance", opts, () => {
    assert.strictEqual(M.damageTypeOf(data, "BT_CHB_Rnd"), "bolt"); // inherited from BT_MSB_Rnd's BACED patch
    assert.strictEqual(M.damageTypeOf(data, "explosion"), "unknown");
});

test("Black Carapace with mod defaults: the 600 torso plate absorbs 7 bolter hits, the 8th downs him", opts, () => {
    const r = M.simulate(data, base({mode: "bco", magazines: 1}));
    assert.strictEqual(r.scenario.path, "bco");
    assert.strictEqual(r.burst.pUnconsciousBy[6], 0);
    assert.strictEqual(r.burst.pUnconsciousBy[7], 1);
    assert.strictEqual(r.stats.pWound, 0);
});

test("Server settings switch Black Carapace to HUD only and players never die", {skip: !haveData || !server}, () => {
    const d = Object.assign({}, data, {serverSettings: server});
    const r = M.simulate(d, base({mode: "bco", magazines: 1}));
    assert.strictEqual(r.scenario.path, "vanilla");
    assert.ok(r.bcoBlockedBySetting);
    assert.strictEqual(r.burst.pFatalBy[r.burst.shots - 1], 0);
    assert.ok(r.burst.pUnconsciousBy[r.burst.shots - 1] > 0.9);
});

test("Server settings: an AI target dies where a player would go unconscious", {skip: !haveData || !server}, () => {
    const d = Object.assign({}, data, {serverSettings: server});
    const r = M.simulate(d, base({target: "ai", magazines: 1}));
    const last = r.burst.shots - 1;
    assert.ok(r.burst.pFatalBy[last] > 0.9, r.burst.pFatalBy[last]);
    assert.ok(Math.abs(r.burst.pFatalBy[last] - r.burst.pUnconsciousBy[last]) < 0.05);
});

test("Overrides change the result without touching the data", opts, () => {
    const before = JSON.stringify(data.gear.vests.TIOW_Mk7Limbs_BT);
    const plain = M.simulate(data, base({mode: "vanilla"}));
    const heavy = M.simulate(data, base({mode: "vanilla", overrides: {vest: {HitChest: {armor: 1500}}}}));
    assert.strictEqual(JSON.stringify(data.gear.vests.TIOW_Mk7Limbs_BT), before);
    assert.strictEqual(heavy.armor.engine, 1540);
    assert.notStrictEqual(heavy.stats.meanWoundDamage, plain.stats.meanWoundDamage);
});

test("Shot cloud: aim at the chest lands on spine3, far off the body misses", {skip: !haveData || !geometry}, () => {
    const prep = M.prepare(data, base({geometry: geometry, dispersion: 0, spreadMrad: 0}));
    const rng = {random: (m) => 0.5 * (m === undefined ? 1 : m)};
    const hit = M.sampleShot(prep, rng);
    assert.ok(hit.hit);
    assert.strictEqual(hit.selection, "spine3");
    assert.ok(hit.hitpoints.some((h) => h[0] === "HitChest"));
    const far = M.prepare(data, base({geometry: geometry, dispersion: 0, spreadMrad: 0, aim: {x: 3, y: 3}}));
    assert.strictEqual(M.sampleShot(far, rng).hit, false);
});

test("Engine penetration visits ordered entries, skips exits and stops when speed runs out", () => {
    const fixture = require("./fixtures/sample-data.json");
    const bench = {...fixture,
        weapons: {Bench: {muzzles: [{name: "this", initSpeed: 0, magazines: ["BenchMag"]}]}},
        magazines: {BenchMag: {initSpeed: 850, ammo: "BenchRound"}},
        ace: {damageTypes: {unknown: {woundHandlers: []}}},
    };
    const face = (z) => [[-1, -1, z], [-1, 1, z], [1, 1, z], [1, -1, z]];
    const mesh = {
        fireFaces: [face(0.5), face(0.1).reverse(), face(0), face(1.5), face(0.5), face(0.8), face(2)],
        fireSelections: ["spine2", "spine3", "leftforearm", "neck", "spine2", "pelvis", "spine3"],
        hitpoints: {spine3: [[0, 0, 0], [0, 0, 0.5], [0, 0, 0.8], [0, 0, 1.5]]},
    };
    const sc = {weapon: "Bench", mode: "vanilla", loadout: {uniform: "BenchUniform", vest: "BenchVest"},
        geometry: mesh, aim: {x: 0, y: 0}, samples: 2, traceHit: 1};
    const entries = (r) => r.trace.filter((t) => t.stage === "engine" && t.detail?.entry).map((t) => t.detail);
    const stopped = M.simulate(bench, sc);
    assert.deepStrictEqual(entries(stopped).map((e) => e.v), [850, 764]);
    assert.strictEqual(stopped.stats.meanWoundEvents, 2);

    const through = M.simulate(bench, {...sc, settings: {engine_torsoStops: false}});
    assert.deepStrictEqual(entries(through).map((e) => Math.round(e.v)), [850, 764, 529]);
    const speedFactors = [850, 764, 528.5].map((v) => Math.sqrt(v / 890));
    assert.deepStrictEqual(entries(through).map((e) => e.speedFactor), speedFactors);
    assert.strictEqual(through.stats.meanWoundEvents, 3);
    assert.ok(Math.abs(through.stats.meanAceDamage - 0.91 * speedFactors.reduce((sum, factor) => sum + factor, 0)) < 1e-9);

    const simple = M.simulate(bench, {...sc, geometry: null});
    assert.strictEqual(simple.stats.meanWoundEvents, 1);
    assert.ok(Math.abs(simple.stats.meanAceDamage - 0.91 * speedFactors[0]) < 1e-9);

    const spread = M.simulate(bench, {...sc, settings: {engine_hitpointTest: "impact"},
        geometry: {...mesh, hitpoints: {spine3: [[0, 0, 0.5]]}}});
    assert.strictEqual(spread.stats.meanWoundEvents, 1);
    assert.deepStrictEqual(spread.trace.filter((t) => t.stage === "engine" && t.detail?.entry).map((t) => t.detail.v), [764]);
});

test("BACED damage types and ammo patches are exported", opts, () => {
    for (const type of ["bolt", "plasma", "melta", "laser", "volkite"]) {
        assert.ok(data.ace.damageTypes[type], `missing BACED damage type: ${type}`);
    }
    assert.strictEqual(data.ammo.TIOW_SmBoltRound.ACE_damageType, "bolt");
    assert.ok(data.baced.loaded.includes("baced_medical"));
});

test("CTR Bolt Rifle with the suit off uses BACED bolt wounds and labels", opts, () => {
    const r = M.simulate(data, base({weapon: "CTR_Bolt_Rifle", unit: WB_CLASS, mode: "vanilla", traceHit: 1}));
    assert.strictEqual(r.scenario.path, "vanilla");
    assert.ok(r.trace.some(t => t.text.includes('damage type "bolt"')));
    assert.ok(r.traceWounds.some(w => ["BoltWound", "Contusion", "Laceration"].includes(w.type)));
    assert.strictEqual(M.woundLabel({type: "BoltWound", category: 0}, data), "Minor Bolt Puncture");
    assert.strictEqual(M.woundLabel({type: "Contusion", category: 1}, data), "Medium Contusion");
});

test("CTR Bolt Rifle chest shots use the selected wound set",
    {skip: !data?.aceOriginal && "run python3 extract.py with BACED to export both wound sets"}, () => {
        const sc = base({weapon: "CTR_Bolt_Rifle", unit: WB_CLASS, mode: "vanilla", traceHit: 1});
        const baced = M.simulate(data, {...sc, woundSet: "baced"});
        const original = M.simulate(data, {...sc, woundSet: "ace"});
        const bacedChest = baced.traceWounds.filter(w => w.part === "Body");
        const originalChest = original.traceWounds.filter(w => w.part === "Body");
        assert.ok(bacedChest.some(w => w.type === "BoltWound"), JSON.stringify(bacedChest));
        assert.equal(M.damageTypeOf(data, "BT_MSB_Rnd", "baced"), "bolt");
        assert.equal(M.damageTypeOf(data, "BT_MSB_Rnd", "ace"), "bullet");
        assert.ok(originalChest.some(w => ["VelocityWound", "Avulsion"].includes(w.type)), JSON.stringify(originalChest));
        assert.ok(original.traceWounds.every(w => w.type !== "BoltWound"));
    });

test("The selected wound set drives wound creation and displayed names", () => {
    const fixture = require("./fixtures/sample-data.json");
    const woundSet = (damageType, woundType, woundNames) => ({
        wounds: {[woundType]: {pain: 0.1, bleeding: 0.1}}, woundNames,
        damageTypes: {[damageType]: {thresholds: [[0, 1]], selectionSpecific: false,
            woundHandlers: [["ace_medical_damage_woundsHandlerBase"]],
            wounds: {[woundType]: {weighting: [[0, 1]], damageMultiplier: 1, sizeMultiplier: 1,
                painMultiplier: 1, bleedingMultiplier: 1}}}},
    });
    const bench = {...fixture,
        weapons: {Bench: {muzzles: [{name: "this", initSpeed: 0, magazines: ["BenchMag"]}]}},
        magazines: {BenchMag: {initSpeed: 1000, ammo: "BenchRound"}},
        ammo: {BenchRound: {...fixture.ammo.BenchRound, ACE_damageType: "bolt", ACE_damageTypeOriginal: "bullet"}},
        ace: woundSet("bolt", "BoltWound", {BoltWound: Array(3).fill("Bolt Puncture")}),
        aceOriginal: woundSet("bullet", "VelocityWound", {}),
    };
    const sc = {weapon: "Bench", impact: "HitChest", mode: "vanilla", loadout: {uniform: "BenchUniform"},
        samples: 2, traceHit: 1};
    const baced = M.simulate(bench, sc);
    const original = M.simulate(bench, {...sc, woundSet: "ace"});
    assert.equal(baced.traceWounds[0].type, "BoltWound");
    assert.equal(original.traceWounds[0].type, "VelocityWound");
    assert.equal(baced.woundTable[0].wound, "Bolt Puncture");
    assert.match(original.woundTable[0].wound, /VelocityWound$/);
});

test("Original ACE distinguishes an unset ammo damage type from an unchanged one", () => {
    const ace = {damageTypes: {bullet: {}}, woundNames: {VelocityWound: ["Patched label"]}};
    const data = {ace, aceOriginal: {...ace, woundNames: {}}, ammo: {
        unset: {ACE_damageType: "bullet", ACE_damageTypeOriginal: null},
        unchanged: {ACE_damageType: "bullet"},
    }};
    assert.equal(M.damageTypeOf(data, "unset"), "bullet");
    assert.equal(M.damageTypeOf(data, "unset", "ace"), "unknown");
    assert.equal(M.damageTypeOf(data, "unchanged", "ace"), "bullet");
    assert.equal(M.damageTypeOf({...data, aceOriginal: null}, "unset", "ace"), "bullet");
    const wound = {type: "VelocityWound", category: 0};
    assert.equal(M.woundLabel(wound, data), "Patched label");
    assert.equal(M.woundLabel(wound, data, "ace"), "Minor VelocityWound");
});

test("CTR Bolt Rifle at 100 m: WB Mk 4 chest aim gives battery-scale damage per round",
    {skip: !haveData || !geometry ? "requires the extracted preset and body geometry" : false}, () => {
        const r = M.simulate(data, {weapon: "CTR_Bolt_Rifle", unit: "30k_Steve_Tactical_Legionary_MK_4_WB",
            distance: 100, impact: "HitChest", mode: "vanilla", geometry,
            settings: {ace_medical_alternateArmorPenetration: false}});
        const {meanAceDamage, meanWoundEvents} = r.stats;
         within(meanAceDamage, 1.3, 2.3);
         within(meanWoundEvents, 1.0, 1.5);
    });

// The head calibration batteries used ACE's bullet wound rules, before BACED's bolt patch.
test("CTR Bolt Rifle vs WB Mk 4 on server settings: crouched head hits kill, standing head hits miss",
    {skip: !haveData || !server ? "requires the extracted preset and server settings" : false}, () => {
        const d = withModel({...data, serverSettings: server}, WB_UNIFORM, "tiow_sm\\marine\\model\\mk4_uniform.p3d", WB_CLASS);
        const sc = {weapon: "CTR_Bolt_Rifle", unit: "30k_Steve_Tactical_Legionary_MK_4_WB", distance: 100,
            mode: "vanilla", geometry: null, samples: 2000, seed: 1, traceHit: 1,
            overrides: {ammo: {ACE_damageType: "bullet"}}};
        for (const impact of ["HitHead", "HitFace", "HitNeck"]) {
            const crouched = M.simulate(d, {...sc, impact, target_stance: "crouched"});
            within(crouched.stats.meanWoundDamage, 1.5, 2.0);
            assert.ok(crouched.stats.pFatal >= 0.8, `P(dead) = ${crouched.stats.pFatal}`);
            assert.ok(crouched.woundTable.length && crouched.woundTable.every((w) => w.part === "Head"));
            const per = crouched.trace.find((t) => t.detail?.entry).detail.hitpoints;
            for (const [hp, armor] of [["HitHead", 75], ["HitFace", 40], ["HitNeck", 140]]) {
                assert.strictEqual(per[hp].armor.engine, armor);
                within(per[hp].newDamage * armor / 80, 0.9, 0.92);
            }
            const standing = M.simulate(d, {...sc, impact});
            assert.strictEqual(standing.scenario.target_stance, "standing");
            assert.strictEqual(standing.stats.pHit, 0);
            assert.strictEqual(standing.stats.pWound, 0);
            assert.ok(standing.stats.pFatal < 0.05);
            assert.ok(standing.trace.some((t) => t.text.includes("head ceiling (~1.90 m) blocked")));
        }
    });

test("CTR Bolt Rifle at 100 m: crouched WB Mk 4 head aim hits the reference figure",
    {skip: !haveData || !geometry ? "requires the extracted preset and body geometry" : false}, () => {
        const r = M.simulate(data, {weapon: "CTR_Bolt_Rifle", unit: "30k_Steve_Tactical_Legionary_MK_4_WB",
            distance: 100, impact: "HitHead", target_stance: "crouched", geometry, seed: 1,
            overrides: {ammo: {ACE_damageType: "bullet"}}});
        assert.ok(r.stats.pHit > 0.9, `P(hits body) = ${r.stats.pHit}`);
        assert.ok(r.stats.pFatal >= 0.8, `P(dead) = ${r.stats.pFatal}`);
    });

test("WB Mk 4 geometry distinguishes direct head selections from torso hitpoint spread", opts, () => {
    const d = withModel(data, WB_UNIFORM, "tiow_sm\\marine\\model\\mk4_uniform.p3d");
    const face = [[-1, -1, 0], [-1, 1, 0], [1, 1, 0], [1, -1, 0]];
    const mesh = {fireFaces: [face], fireSelections: ["head"], hitpoints: {}};
    const sc = {weapon: "CTR_Bolt_Rifle", loadout: {uniform: "30k_Steve_Armour_MK_4_WB"},
        mode: "vanilla", geometry: mesh, aim: {x: 0, y: 0.7}, samples: 2, overrides: {ammo: {indirectHit: 0}}};
    const crouched = M.simulate(d, {...sc, target_stance: "crouched"});
    const hitpoints = (r) => r.trace.find((t) => t.detail?.entry).detail.hitpoints;
    assert.deepStrictEqual(Object.keys(hitpoints(crouched)).sort(), ["HitFace", "HitHead", "HitNeck"]);
    const standing = M.simulate(d, sc);
    assert.strictEqual(standing.stats.pHit, 0);
    assert.ok(standing.trace.some((t) => t.text.includes("head ceiling")));
    const torsoMesh = {...mesh, fireSelections: ["spine3"], hitpoints: {head: [[0, 0.59, 0]], spine3: [[0, 0.57, 0]]}};
    const highTorso = M.simulate(d, {...sc, geometry: torsoMesh});
    assert.strictEqual(highTorso.stats.pHit, 0);
    assert.ok(highTorso.trace.some((t) => t.text.includes("blocked spine3")));
    const torso = M.simulate(d, {...sc, aim: {x: 0, y: 0.57}, impact: "HitHead", geometry: torsoMesh});
    assert.strictEqual(torso.stats.pHit, 1);
    assert.deepStrictEqual(Object.keys(hitpoints(torso)).sort(), ["HitChest", "HitHead"]);
});

test("TIOW Mk 7 default loadout: a head aim lands only when crouched", {skip: !haveData || !geometry}, () => {
    const d = withModel(data, LOADOUT.uniform, "\\TIOW_SM/Marine/model/mk7_uniform.p3d");
    for (const mesh of [geometry, null]) {
        const sc = base({mode: "vanilla", geometry: mesh, impact: "HitHead", dispersion: 0, samples: 2, traceHit: 1});
        const standing = M.simulate(d, sc);
        assert.strictEqual(standing.stats.pHit, 0);
        assert.ok(standing.trace.some((t) => t.text.includes("head ceiling")));
        const crouched = M.simulate(d, {...sc, target_stance: "crouched"});
        assert.strictEqual(crouched.stats.pHit, 1);
        assert.ok(crouched.trace.some((t) => t.detail?.entry && t.detail.hitpoints.HitHead));
        if (mesh) {
            const raised = M.simulate(d, {...sc, settings: {engine_standingCeiling: 2.30}});
            assert.strictEqual(raised.stats.pHit, 1);
        }
    }
});

test("AI unit selects its configured loadout and uses AI medical rules", opts, () => {
    const [cls, unit] = Object.entries(data.gear.aiUnits).find(([, u]) => u.vest && u.helmet);
    const prep = M.prepare(data, base({unit: cls, target: "player", loadout: {uniform: "ignored"}}));
    assert.strictEqual(prep.isPlayer, false);
    assert.deepStrictEqual(prep.gear, M.resolveLoadout(data, unit));
    assert.deepStrictEqual(prep.unit, {class: cls, displayName: unit.displayName, factionName: unit.factionName, subcategory: unit.subcategory});
    assert.throws(() => M.prepare(data, base({unit: "missing_test_unit"})), /unknown AI unit missing_test_unit/);
});

const EXPLOSIVE = {ammo: {hit: 90, indirectHit: 120, indirectHitRange: 2, explosive: 1}};

test("Rounds that expire before reaching the target are misses for direct hits and blast", () => {
    const fixture = require("./fixtures/sample-data.json");
    const bench = {...fixture,
        weapons: {Bench: {muzzles: [{name: "this", initSpeed: 0, magazines: ["BenchMag"]}]}},
        magazines: {BenchMag: {initSpeed: 850, ammo: "BenchRound"}},
        ace: {
            damageTypes: {unknown: {woundHandlers: [["ace_medical_damage_woundsHandlerBase"]], thresholds: [[0, 0], [1, 1]],
                wounds: {testWound: {weighting: [[0, 1]], damageMultiplier: 1, sizeMultiplier: 1, painMultiplier: 1, bleedingMultiplier: 1}}}},
            wounds: {testWound: {pain: 1, bleeding: 1}},
        },
    };
    const sc = {weapon: "Bench", mode: "vanilla", target: "ai", loadout: {uniform: "BenchUniform"},
        distance: 100, pellets: 2, samples: 2, runs: 4, maxShots: 4, overrides: EXPLOSIVE};
    for (const impact of ["HitChest", "Blast"]) {
        const live = {...sc, impact};
        assert.strictEqual(M.simulate(bench, live).stats.pWound, 1);
        assert.ok(Number.isInteger(M.shotsToKill(bench, live).shots50));

        const expired = {...live, overrides: {ammo: {...EXPLOSIVE.ammo, timeToLive: 0.01}}};
        const result = M.simulate(bench, expired);
        assert.strictEqual(result.ballistics.outOfRange, true);
        assert.strictEqual(result.stats.pHit, 0);
        assert.strictEqual(result.stats.pWound, 0);
        assert.deepStrictEqual(result.traceShots.map((shot) => shot.hit), [false, false]);
        assert.ok(result.trace.some((entry) => entry.text === "the round expires (timeToLive) before reaching the target"));
        const down = M.shotsToKill(bench, expired);
        assert.strictEqual(down.pHit, 0);
        assert.strictEqual(down.shots50, null);
    }
});

test("Direct explosive hits fold splash into the final damage cycle with the suit off", opts, () => {
    const sc = base({samples: 20, traceHit: 1, pellets: 1, overrides: EXPLOSIVE, blastDistance: 20});
    const off = M.simulate(data, {...sc, mode: "vanilla"});
    assert.deepStrictEqual(off.trace.filter((t) => t.stage === "handleDamage" && t.detail).map((t) => t.text.split(":")[0]),
        ["direct"]);
    assert.ok(off.trace.some((t) => t.text.includes("folded into the final impact")));
    assert.deepStrictEqual(off.blast, {indirectHit: 120, indirectHitRange: 2, explosive: 1, directIncludesBlast: true, falloff: 1, distance: 20});

    const on = M.simulate(data, {...sc, mode: "bco", settings: {HOV_HUD_ONLY: false}});
    assert.strictEqual(on.scenario.path, "bco");
    assert.strictEqual(on.blast.directIncludesBlast, false);
    assert.strictEqual(on.trace.filter((t) => t.stage === "bco" && t.text.startsWith("HitPart:")).length, 1);
    assert.ok(on.trace.some((t) => t.text.includes("dropped by the same-frame guard")));
    assert.ok(!on.trace.some((t) => t.stage === "handleDamage" || t.text.startsWith("blast:")));
});

test("Blast-only damage falls to zero beyond the blast radius", opts, () => {
    const sc = base({samples: 20, traceHit: 1, pellets: 1, impact: "Blast", overrides: EXPLOSIVE,
        settings: {HOV_HUD_ONLY: false, engine_applyMinimalHit: false}});
    for (const mode of ["vanilla", "bco"]) {
        const near = M.simulate(data, {...sc, mode, blastDistance: 2});
        const mid = M.simulate(data, {...sc, mode, blastDistance: 2.7});
        const far = M.simulate(data, {...sc, mode, blastDistance: 3.5});
        assert.strictEqual(near.blast.falloff, 1);
        assert.ok(Math.abs(mid.blast.falloff - 0.5) < 1e-9);
        assert.strictEqual(far.blast.falloff, 0);
        assert.strictEqual(far.stats.pWound, 0);
        assert.ok(far.trace.some((t) => t.text.includes("blast does not reach the target")));
        if (mode === "bco") {
            assert.deepStrictEqual(far.view.plates, far.tracePlatesBefore);
            assert.deepStrictEqual(mid.view.plates, near.view.plates);
            assert.notDeepStrictEqual(near.view.plates, near.tracePlatesBefore);
        } else {
            const engineDamage = (r) => r.trace.find((t) => t.stage === "handleDamage" && t.text.startsWith("blast: ACE picks")).detail.allDamages[0][0];
            assert.ok(Math.abs(engineDamage(mid) - engineDamage(near) / 2) < 1e-9);
        }
    }
});

test("ACE armor penetration comparison matches an independent burst with the flipped setting", opts, () => {
    const sc = base({mode: "vanilla", samples: 20, settings: {ACE_MEDICAL_ALTERNATEARMORPENETRATION: false}});
    const plain = M.simulate(data, sc);
    const compared = M.simulate(data, {...sc, compareArmorPen: true});
    const flipped = M.simulate(data, {...sc, settings: {ace_medical_alternateArmorPenetration: true}});
    assert.ok(!Object.prototype.hasOwnProperty.call(plain, "compare"));
    assert.deepStrictEqual(compared.burst, plain.burst);
    assert.strictEqual(compared.compare.armorPen, true);
    for (const [curve, median] of [["pUnconsciousBy", "downShot"], ["pFatalBy", "deadShot"]]) {
        assert.strictEqual(compared.compare[curve].length, plain.burst.shots);
        assert.deepStrictEqual(compared.compare[curve], flipped.burst[curve]);
        assert.strictEqual(compared.compare[median], (flipped.burst[curve].findIndex((p) => p >= 0.5) + 1) || null);
    }
});

test("weapon balancing: labels distinguish classes without splitting identical stats", () => {
    const weapon = (dispersion, displayName, modeName = "this") => ({displayName: "Pistol", muzzles: [{name: "this", displayName,
        magazines: ["Mag"], modes: [{name: modeName, reloadTime: 0.1, dispersion}]}]});
    const fixture = {
        weapons: {Pistol: weapon(0, "Main muzzle"), Pistol_Copy: weapon(0, "Copy muzzle"),
            Pistol_Secondary: weapon(1, "this"), Pistol_LSLOT: weapon(2, "Launcher", "Single")},
        magazines: {Mag: {ammo: "Round", count: 8}}, ammo: {Round: {hit: 1}},
    };
    const cert = {generation: "Firstborn", cert: "Tactical", acquisition: "default"};
    const points = buildPoints(fixture, {classes: {Pistol: [cert], Pistol_Secondary: [cert]},
        otherMods: ["Pistol_Copy", "Pistol_LSLOT"], certs: {Firstborn: ["Tactical"]}});
    assert.deepStrictEqual(points.map((p) => [p.classes, p.variant, p.modeLabel]), [
        [["Pistol", "Pistol_Copy"], "Pistol", "Main muzzle"],
        [["Pistol_Secondary"], "secondary slot", "Default"],
        [["Pistol_LSLOT"], "launcher slot", "Single"],
    ]);
});

function magazineBalanceFixture(second = {}) {
    const first = {ammo: "Round", count: 8, initSpeed: 100};
    return {
        weapons: {Pistol: {displayName: "Pistol", muzzles: [{name: "this", magazines: ["First", "Second"], modes: []}]}},
        magazines: {First: first, Second: {...first, ...second}},
        ammo: {Round: {hit: 1}},
    };
}
const magazineBalanceRoster = {classes: {Pistol: [{generation: "Firstborn", cert: "Tactical", acquisition: "default"}]},
    otherMods: [], certs: {Firstborn: ["Tactical"]}};

test("weapon balancing: magazines with the same ammo but different capacities are distinct", () => {
    const points = buildPoints(magazineBalanceFixture({count: 16}), magazineBalanceRoster);
    assert.deepStrictEqual(points.map((p) => p.magazine), ["First", "Second"]);
});

test("weapon balancing: a magazine speed edit splits an alias without changing the unedited point", () => {
    const fixture = magazineBalanceFixture();
    const original = buildPoints(fixture, magazineBalanceRoster);
    assert.deepStrictEqual(original.map((p) => p.magazine), ["First"]);
    const edited = buildPoints(fixture, magazineBalanceRoster, {magazineByClass: {Second: {initSpeed: 200}}});
    assert.deepStrictEqual(edited.map((p) => p.magazine), ["First", "Second"]);
    assert.strictEqual(edited[0].id, original[0].id);
    assert.notStrictEqual(edited[1].id, original[0].id);
    assert.deepStrictEqual(buildPoints(fixture, magazineBalanceRoster), original);
});

test("weapon balancing: ammo class edits affect whether a submunition point does damage", () => {
    const fixture = magazineBalanceFixture();
    fixture.ammo = {Round: {hit: 1, submunitionAmmo: ["Pellet"]}, Pellet: {hit: 1}};
    assert.strictEqual(buildPoints(fixture, magazineBalanceRoster).length, 1);
    assert.deepStrictEqual(buildPoints(fixture, magazineBalanceRoster, {ammoByClass: {Round: {hit: 0}}}), []);
    assert.strictEqual(buildPoints(fixture, magazineBalanceRoster, {ammoByClass: {Round: {hit: 0}, Pellet: {hit: 1}}}).length, 1);
});

test("weapon balancing: extracted missile launcher classes have distinct variants and player-facing mode labels",
    {skip: !haveData || !fs.existsSync(ROSTER_FILE) ? "game_data.json and generated roster.js are required" : false}, () => {
        const source = fs.readFileSync(ROSTER_FILE, "utf8");
        const roster = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1));
        const points = buildPoints(data, roster);
        const variants = new Map(points.filter((p) => p.name === "[Astartes] Missile Launcher").map((p) => [p.weapon, p.variant]));
        assert.strictEqual(variants.size, 2);
        assert.strictEqual(variants.get("TIOW_SM_Rocket_1_LSLOT"), "launcher slot");
        assert.ok([...variants.values()].every(Boolean));
        assert.strictEqual(new Set(variants.values()).size, 2);
        assert.ok(points.every((p) => p.modeLabel && p.modeLabel !== "this"));
    });

test("weapon balancing: time to shot n adds one reload per magazine change", () => {
    assert.strictEqual(M.timeToShot(1, 0.1, 10, 3), 0);
    assert.strictEqual(M.timeToShot(10, 0.1, 10, 3), 0.9);
    // Shot 11 opens the second magazine
    within(M.timeToShot(11, 0.1, 10, 3), 4 - 1e-9, 4 + 1e-9);
    within(M.timeToShot(21, 0.1, 10, 3), 8 - 1e-9, 8 + 1e-9);
});

test("weapon balancing: the fastest player mode is used", () => {
    const muzzle = {modes: [
        {name: "Single", reloadTime: 0.2, dispersion: 0.001, showToPlayer: 1},
        {name: "Auto", reloadTime: 0.1, dispersion: 0.003, showToPlayer: 1},
        {name: "AutoTight", reloadTime: 0.1, dispersion: 0.002, showToPlayer: 1},
        {name: "AiOnly", reloadTime: 0.05, dispersion: 0, showToPlayer: 0},
    ]};
    assert.strictEqual(M.fastestMode(muzzle).name, "AutoTight");
});

test("weapon balancing: shotsToKill on the Tyrian bolter", opts, () => {
    const r = M.shotsToKill(data, base({target: "player", mode: "vanilla", spreadMrad: 2, geometry, settings: server || {},
        outcome: "down", assumedReload: 3, runs: 60}));
    const muzzle = data.weapons.BT_TyrianBolter.muzzles[0];
    assert.strictEqual(r.reloadTime, M.fastestMode(muzzle).reloadTime);
    assert.ok(Number.isInteger(r.shots50) && r.shots50 > 0, `shots50 ${r.shots50}`);
    assert.ok(Number.isInteger(r.shots25) && r.shots25 > 0);
    assert.ok(r.shots25 <= r.shots50 && r.shots50 <= r.shots75);
    assert.ok(r.spread >= 1);
    assert.strictEqual(r.spread, r.shots75 / r.shots25);
    assert.ok(r.pHit > 0 && r.pHit <= 1);
    within(r.ttk, 0, 600);
    assert.strictEqual(r.ttk, M.timeToShot(r.shots50, r.reloadTime, r.roundsPerMag, r.magazineReload));
    assert.strictEqual(r.ttk25, M.timeToShot(r.shots25, r.reloadTime, r.roundsPerMag, r.magazineReload));
    assert.strictEqual(r.ttk75, M.timeToShot(r.shots75, r.reloadTime, r.roundsPerMag, r.magazineReload));
    assert.strictEqual(r.magazineReload, Math.max(muzzle.magazineReloadTime || 0, 3));
});

test("weapon balancing: CLI rows include both points and sort capped outcomes last", opts, () => {
    const cert = {generation: "Firstborn", cert: "Tactical", acquisition: "default"};
    const classes = {Taj_Heavy_Bolt_Pistol: [cert], BT_TyrianBolter: [cert]};
    const points = buildPoints(data, {classes, otherMods: [], certs: {Firstborn: ["Tactical"]}})
        .filter((p, i, all) => all.findIndex((q) => q.weapon === p.weapon) === i);
    const [pistol, bolter] = points;
    const rows = buildBalanceRows(data, points, base({mode: "vanilla", runs: 12, assumedReload: 3,
        overrides: {ammoByClass: {[pistol.ammo]: {hit: 0, indirectHit: 0}}}}));
    const header = "name,variant,class,magazine,ammo,certs,acquisition,shots50,shots25,shots75,spread,pHit,ttk,ttk25,ttk75,magazinesToDown,modeLabel,rpm";
    assert.deepStrictEqual(rows.map((r) => r.class), [bolter.weapon, pistol.weapon]);
    const [hit, capped] = rows;
    assert.strictEqual(Object.keys(hit).join(","), header);
    assert.strictEqual(hit.magazine, bolter.magazine);
    assert.strictEqual(hit.ammo, bolter.ammo);
    assert.strictEqual(hit.certs, "Firstborn:Tactical");
    assert.strictEqual(hit.acquisition, "default");
    assert.ok(hit.ttk >= 0 && hit.pHit > 0 && hit.rpm > 0);
    assert.strictEqual(hit.magazinesToDown, hit.shots50 / data.magazines[bolter.magazine].count);
    assert.strictEqual(hit.modeLabel, bolter.modeLabel);
    assert.strictEqual(capped.shots50, null);
    assert.strictEqual(capped.ttk, null);
    assert.strictEqual(capped.magazinesToDown, null);
    const csv = balanceCsv([{...hit, name: 'Bolter, "Tyrian"'}, capped]);
    const [csvHeader, first, last] = csv.trimEnd().split("\n");
    assert.strictEqual(csvHeader, header);
    assert.ok(first.startsWith('"Bolter, ""Tyrian""",'));
    assert.strictEqual(last.split(",")[12], "");
});

test("weapon balancing: ammoByClass changes only weapons firing the edited ammo", opts, () => {
    const tyrian = base({target: "player", mode: "vanilla", outcome: "down", runs: 12});
    const pistol = {...tyrian, weapon: "Taj_Heavy_Bolt_Pistol"};
    const original = M.shotsToKill(data, tyrian);
    const other = M.shotsToKill(data, pistol);
    assert.notStrictEqual(other.ammo, original.ammo);
    assert.ok(original.shots50 > 0);
    const overrides = {ammoByClass: {[original.ammo]: {hit: 0, indirectHit: 0}}};
    assert.strictEqual(M.shotsToKill(data, {...tyrian, overrides}).shots50, null);
    assert.deepStrictEqual(M.shotsToKill(data, {...pistol, overrides}), other);
    assert.deepStrictEqual(M.shotsToKill(data, tyrian), original);
});

test("class overrides distinguish magazine aliases and preserve submunition patches", () => {
    const input = {weapons: {Bench: {muzzles: [{magazines: ["First", "Second"]}]}},
        magazines: {First: {ammo: "Carrier", initSpeed: 100}, Second: {ammo: "Carrier", initSpeed: 100}},
        ammo: {Carrier: {submunitionAmmo: ["Pellet"], hit: 0}, Pellet: {hit: 5}}};
    const overrides = {magazineByClass: {First: {initSpeed: 200}}, ammoByClass: {Carrier: {hit: 7}, Pellet: {hit: 9}}};
    const first = M.applyOverrides(input, {weapon: "Bench", overrides});
    const second = M.applyOverrides(input, {weapon: "Bench", magazine: "Second", overrides});
    assert.strictEqual(first.magazines.First.initSpeed, 200);
    assert.strictEqual(second.magazines.Second.initSpeed, 100);
    for (const result of [first, second]) {
        assert.strictEqual(result.ammo.Carrier.hit, 7);
        assert.strictEqual(result.ammo.Pellet.hit, 9);
    }
    const carrierOnly = M.applyOverrides(input, {weapon: "Bench", overrides: {ammoByClass: {Carrier: {hit: 7}}}});
    assert.strictEqual(carrierOnly.ammo.Pellet.hit, 7);
    assert.strictEqual(input.ammo.Pellet.hit, 5);
    assert.strictEqual(input.magazines.First.initSpeed, 100);
});

test("weapon balancing: misses at the shot cap have no outcome percentiles", {skip: !haveData || !geometry}, () => {
    const r = M.shotsToKill(data, base({target: "player", mode: "vanilla", geometry, aim: {x: 3, y: 3}, dispersion: 0,
        outcome: "down", maxShots: 1}));
    assert.deepStrictEqual([r.shots25, r.shots50, r.shots75, r.ttk25, r.ttk, r.ttk75, r.spread], Array(7).fill(null));
    assert.strictEqual(r.pHit, 0);
});
