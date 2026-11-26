#!/usr/bin/env node
/*
 * Command-line front end to damage_model.js, for scripts and agents.
 *
 *   node sim.js find <text> [--kind weapon|uniform|vest|helmet|backpack|ammo|unit]
 *   node sim.js weapon <WeaponClass>                     # muzzles, magazines, ammo stats
 *   node sim.js run --weapon C [--magazine C] [--muzzle M] [--distance 100] [--impact HitChest]
 *                   [--uniform C --vest C --helmet C --backpack C] [--mode auto|bco|vanilla] [--wounds baced|ace]
 *                   [--halo none|bronze|silver|gold|refractor] [--magazines 1] [--fire-mode FullAuto]
 *                   [--ai | --unit C] [--stance standing|crouched] [--spread 2 (mrad shooter error)] [--aim x,y (metres)] [--no-geometry]
 *                   [--blast-distance N (metres, for --impact Blast)] [--compare-armor-pen]
 *                   Standing marine geometry is capped at engine_standingCeiling (game model metres).
 *                   [--mod-defaults (ignore data/server_settings.json)] [--samples 2000]
 *                   [--set name=value ...] [--settings cba_settings.sqf] [--json] [--trace] [--trace-hit N]
 *   node sim.js sweep --weapon C --distances 0,100,300,600 [run options]   # one line per distance
 *   node sim.js balance [scenario options] [--outcome down|dead] [--reload 3] [--other-mods] [--runs 100] [--csv | --json]
 *   node sim.js calibrate --rpt path[,path...] [--rpt path] [--json]      # fit engine assumptions
 *
 * Default loadout: TIOW Mk 7 Black Templars (uniform, pauldrons, helmet).
 */
"use strict";
const fs = require("fs");
const path = require("path");
const model = require("./damage_model.js");
const {buildPoints, BALANCE_COLUMNS, balanceRow, balanceCsv} = require("./balance_points.js");
const calibration = require("./calibrate.js");
const DATA_DIR = require("./data_dir.js")();
const DATA = path.join(DATA_DIR, "game_data.json");
const DEFAULT_LOADOUT = {
    uniform: "TIOW_Mk7PowerArmor_1_BT", vest: "TIOW_Mk7Limbs_BT", helmet: "TIOW_MK7Helmet_BT", backpack: "",
};

function loadData(args) {
    if (!fs.existsSync(DATA)) {
        console.error("No data/game_data.json yet: run `python3 extract.py` first.");
        process.exit(2);
    }
    const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
    const server = path.join(DATA_DIR, "server_settings.json");
    if (!args["mod-defaults"] && fs.existsSync(server)) data.serverSettings = JSON.parse(fs.readFileSync(server, "utf8"));
    return data;
}

function loadGeometry(args) {
    const file = path.join(DATA_DIR, "body_geometry.js");
    if (args["no-geometry"] || !fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
}

function parseArgs(argv) {
    const out = {_: [], set: [], rpt: []};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) { out._.push(a); continue; }
        const key = a.slice(2);
        const next = argv[i + 1];
        const flag = next === undefined || next.startsWith("--");
        if (key === "set") { out.set.push(next); i++; continue; }
        if (key === "rpt") { out.rpt.push(flag ? "" : next); if (!flag) i++; continue; }
        out[key] = flag ? true : next;
        if (!flag) i++;
    }
    return out;
}

function coerce(raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw !== "" && !isNaN(Number(raw))) return Number(raw);
    return raw;
}

// `force name = value;` lines from an exported cba_settings.sqf
function readCbaSettings(file) {
    const out = {};
    const text = fs.readFileSync(file, "utf8");
    const re = /^\s*(?:force\s+)*(\w+)\s*=\s*(.+?);\s*$/gim;
    let m;
    while ((m = re.exec(text))) {
        let value = m[2].trim();
        if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/""/g, "\"");
        out[m[1]] = coerce(value);
    }
    return out;
}

function scenarioFrom(args) {
    const settings = {};
    if (args.settings) Object.assign(settings, readCbaSettings(args.settings));
    for (const pair of args.set) {
        const eq = pair.indexOf("=");
        settings[pair.slice(0, eq)] = coerce(pair.slice(eq + 1));
    }
    const aim = args.aim ? String(args.aim).split(",").map(Number) : null;
    return {
        weapon: args.weapon, magazine: args.magazine, muzzle: args.muzzle, fireMode: args["fire-mode"],
        target: args.ai ? "ai" : "player", unit: args.unit, magazines: Number(args.magazines || 1),
        target_stance: args.stance,
        spreadMrad: Number(args.spread || 0), aim: aim ? {x: aim[0], y: aim[1]} : undefined, viewShot: args["view-shot"] ? Number(args["view-shot"]) : undefined,
        distance: Number(args.distance || 0), impact: args.impact || "HitChest",
        blastDistance: Number(args["blast-distance"] || 0), compareArmorPen: Boolean(args["compare-armor-pen"]),
        loadout: {
            uniform: args.uniform || DEFAULT_LOADOUT.uniform, vest: args.vest === undefined ? DEFAULT_LOADOUT.vest : args.vest,
            helmet: args.helmet === undefined ? DEFAULT_LOADOUT.helmet : args.helmet, backpack: args.backpack || "",
        },
        mode: args.mode || "auto", ironHalo: args.halo || "none", woundSet: args.wounds ?? "baced",
        samples: Number(args.samples || 2000), seed: Number(args.seed || 1),
        pellets: args.pellets === undefined ? undefined : Number(args.pellets),
        traceHit: args["trace-hit"] === undefined ? undefined : Number(args["trace-hit"]),
        settings: settings,
    };
}

function buildBalanceRows(data, points, scenario) {
    return points.map((p) => {
        const r = model.shotsToKill(data, {...scenario, weapon: p.weapon, muzzle: p.muzzle, magazine: p.magazine});
        return balanceRow(p, r);
    }).sort((a, b) => (a.ttk === null) - (b.ttk === null) || a.ttk - b.ttk);
}

function balanceTable(rows) {
    const cells = [BALANCE_COLUMNS, ...rows.map((row) => BALANCE_COLUMNS.map((key) => {
        if (row[key] == null) return "";
        if (key === "pHit") return `${f(100 * row[key], 1)}%`;
        return f(row[key], 3);
    }))];
    const widths = BALANCE_COLUMNS.map((_, i) => cells.reduce((w, row) => Math.max(w, row[i].length), 0));
    return cells.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n") + "\n";
}

function printBalance(data, geometry, args) {
    const outcome = args.outcome ?? "down";
    const assumedReload = Number(args.reload ?? 3);
    const runs = Number(args.runs ?? 100);
    if (!["down", "dead"].includes(outcome) || args.reload === true || !Number.isFinite(assumedReload) || assumedReload < 0 ||
        args.runs === true || !Number.isSafeInteger(runs) || runs < 1 || (args.csv && args.json)) {
        console.error("Usage: node sim.js balance [scenario options] [--outcome down|dead] [--reload 3] [--other-mods] [--runs 100] [--csv | --json]");
        process.exitCode = 1;
        return;
    }
    const file = path.join(DATA_DIR, "roster.js");
    if (!fs.existsSync(file)) {
        console.error("No roster.js in the data directory: run `python3 build_page.py` first.");
        process.exitCode = 2;
        return;
    }
    const source = fs.readFileSync(file, "utf8");
    const roster = JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("}") + 1));
    const points = buildPoints(data, roster).filter((p) => p.roster || args["other-mods"]);
    const rows = buildBalanceRows(data, points, {...scenarioFrom(args), geometry, outcome, assumedReload, runs});
    process.stdout.write(args.json ? JSON.stringify(rows, null, 2) + "\n" : args.csv ? balanceCsv(rows) : balanceTable(rows));
}

const pct = (x) => (x * 100).toFixed(x < 0.1 && x > 0 ? 1 : 0) + "%";
const f = model.fmt;
const medianShot = (curve) => curve.findIndex((p) => p >= 0.5) + 1;
const showShot = (shot, length) => shot || `>${length}`;
const onOff = (enabled) => enabled ? "on" : "off";

function printResult(r, withTrace) {
    const s = r.scenario;
    console.log(`${s.weapon} [${s.weaponClass}] / ${s.magazine} -> ${s.ammo}` + (s.pellets > 1 ? ` x${s.pellets}` : ""));
    const target = s.unit ? `AI target ${s.unit.displayName} [${s.unit.class}]` : `${s.isPlayer ? "player" : "AI"} target`;
    console.log(`  ${target} (${s.target_stance}), aim ${s.impactLabel} at ${s.distance} m, ${s.fireMode} (${f(s.reloadTime, 3)} s, dispersion ${f(s.dispersion * 1000, 2)} mrad), ` +
        `${s.magazines} x ${s.roundsPerMag} rounds; path: ${s.path === "bco" ? "Black Carapace armor mode" : "engine + ACE HandleDamage"}, ACE damage type "${s.damageType}"`);
    const b = r.ballistics;
    console.log(`  v0 ${f(b.v0)} m/s (${b.v0Rule}), impact ${f(b.v)} m/s (${f(b.speedRatio * 100)}% of typicalSpeed), flight ${f(b.time, 2)} s` +
        (b.outOfRange ? "  ** beyond timeToLive: round expires before reaching target **" : ""));
    const a = r.ammo;
    console.log(`  ammo hit ${a.hit} indirectHit ${a.indirectHit || 0} caliber ${a.caliber || 0} typicalSpeed ${a.typicalSpeed || 0} explosive ${a.explosive || 0}`);
    if (s.impact === "Blast") {
        console.log(`  blast only: round bursts ${f(r.blast.distance)} m from the target without a direct hit; blast falloff factor ${f(r.blast.falloff, 2)}` +
            (s.path === "bco" ? " (Black Carapace uses this only to check whether the blast reaches the target)" : ""));
    } else if (r.blast.directIncludesBlast) {
        console.log("  direct hit: full-strength splash is folded into the final impact's damage event");
    } else if (s.path === "bco" && r.blast.indirectHit > 0) {
        console.log("  direct hit: the Black Carapace same-frame guard drops the blast from the same round");
    }
    if (r.armor) {
        const v = r.armor.vest;
        console.log(`  armor on ${s.impact}: engine ${f(r.armor.engine)} | ACE ${f(r.armor.ace)}` +
            (v.scaled ? ` (vest ${v.raw} log-scaled to ${f(v.armor)})` : ""));
    }
    if (r.bco) {
        console.log(`  Black Carapace tier ${r.bco.tier || "fallback"} / helmet ${r.bco.helmetTier || (r.bco.hasHelmet ? "?" : "not listed")}; plates ` +
            Object.entries(r.bco.plates).map(([k, v]) => `${k} ${v}`).join(", ") + `; threshold ${r.bco.threshold}, modifier ${r.bco.modifier}` +
            (r.bco.shield ? `, Iron Halo ${r.bco.shield}` : ""));
    } else if (r.bcoBlockedBySetting) {
        console.log("  (Black Carapace is in HUD-only mode on this server: its armor does nothing)");
    } else if (r.bcoAvailable) {
        console.log("  (uniform is Black Carapace-capable; this run models the suit OFF)");
    }
    const st = r.stats;
    const hitRate = s.impact === "Blast" ? "" : `P(hits body) ${pct(st.pHit)}, `;
    console.log(`  one shot: ${hitRate}P(any wound) ${pct(st.pWound)}, mean wounds ${f(st.meanWounds, 2)}, mean wound damage ${f(st.meanWoundDamage, 3)}`);
    if (s.path === "vanilla") console.log(`           mean ACE wound events ${f(st.meanWoundEvents, 2)}, mean total ACE event damage ${f(st.meanAceDamage, 3)} per round`);
    console.log(`           P(down) ${pct(st.pUnconscious)}, P(cardiac arrest) ${pct(st.pCardiac)}, P(dead) ${pct(st.pFatal)}, P(fracture) ${pct(st.pFracture)}, P(pneumothorax) ${pct(st.pPneumothorax)}`);
    console.log(`           pain ${f(st.meanPain, 2)}, bleeding ${f(st.meanBleeding, 4)} -> Class III blood loss in ${f(st.bleed.toClass3, 0)} s`);
    for (const w of r.woundTable.slice(0, 8)) {
        console.log(`    ${pct(w.chance).padStart(5)}  ${w.part.padEnd(8)} ${w.wound}`);
    }
    const bu = r.burst;
    const cmp = r.compare;
    const baseLabel = cmp ? `, ACE armor penetration ${onOff(!cmp.armorPen)}` : "";
    console.log(`  ${bu.shots} shots (${bu.runs} simulated bursts${baseLabel}): down in half of them by shot ${showShot(medianShot(bu.pUnconsciousBy), bu.shots)}, ` +
        `dead in half by shot ${showShot(medianShot(bu.pFatalBy), bu.shots)}; P(down by last shot) ${pct(bu.pUnconsciousBy[bu.shots - 1])}, P(dead) ${pct(bu.pFatalBy[bu.shots - 1])}`);
    if (cmp) console.log(`  Comparison (ACE armor penetration ${onOff(cmp.armorPen)}): down in half by shot ${showShot(cmp.downShot, bu.shots)}, ` +
        `dead in half by shot ${showShot(cmp.deadShot, bu.shots)}`);
    const v = r.view;
    console.log(`  representative burst at shot ${v.shot}: state ${v.state}, blood ${f(v.bloodVolume, 2)} L, pain ${f(v.pain, 2)}, wounds ` +
        (Object.entries(v.openWounds).map(([p, ws]) => `${p}: ${ws.map((w) => `${w[1]}x class ${w[0]}`).join(" ")}`).join("; ") || "none"));
    if (Object.keys(r.unknownHandlers).length) {
        console.log("  ! wound handlers not modelled (passed through): " + Object.entries(r.unknownHandlers).map(([k, v]) => `${k} (${v})`).join(", "));
    }
    if (withTrace) {
        console.log(`  trace (hit ${r.traceHit} of the burst, one sample):`);
        for (const t of r.trace) console.log(`    [${t.stage}] ${t.text}`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (["run", "sweep", "balance"].includes(cmd) && args.wounds !== undefined && !["baced", "ace"].includes(args.wounds)) {
        console.error("--wounds must be baced or ace");
        process.exitCode = 1;
        return;
    }
    if (cmd === "calibrate") {
        const rptPaths = args.rpt.flatMap((value) => value.split(",").map((file) => file.trim()));
        if (!rptPaths.length || rptPaths.some((file) => !file)) {
            console.error("Usage: node sim.js calibrate --rpt path[,path...] [--rpt path] [--json]");
            process.exitCode = 1;
            return;
        }
        try {
            const records = rptPaths.map((file) => calibration.parseRpt(fs.readFileSync(file, "utf8")));
            const fixtures = path.join(__dirname, "tests", "fixtures");
            const sample = rptPaths.every((file) => path.resolve(file) === path.join(fixtures, "sample.rpt"));
            const battery = rptPaths.every((file) => ["battery-wb-mk4.rpt", "battery-wb-mk4-apose.rpt", "battery-wb-mk4-aim.rpt"]
                .some((name) => path.resolve(file) === path.join(fixtures, name)));
            // The battery fixture has a minimal snapshot of its effective torso armor and ammo.
            const fixtureData = sample ? "sample-data.json" : battery && !fs.existsSync(DATA) ? "battery-wb-mk4-data.json" : null;
            const data = fixtureData ? JSON.parse(fs.readFileSync(path.join(fixtures, fixtureData), "utf8")) : loadData(args);
            const result = calibration.analyse(records, data, {geometry: sample ? null : loadGeometry(args)});
            console.log(args.json ? JSON.stringify(result, null, 2) : calibration.formatAnalysis(result));
        } catch (err) {
            console.error(`Calibration failed: ${err.message}`);
            process.exitCode = 1;
        }
        return;
    }
    const data = loadData(args);
    const geometry = loadGeometry(args);
    if (cmd === "balance") { printBalance(data, geometry, args); return; }
    if (cmd === "find") {
        const q = String(args._[1] || "").toLowerCase();
        const kinds = {
            weapon: data.weapons, uniform: data.gear.uniforms, vest: data.gear.vests, helmet: data.gear.helmets,
            backpack: data.gear.backpacks, ammo: data.ammo, unit: data.gear.aiUnits || {},
        };
        for (const [kind, table] of Object.entries(kinds)) {
            if (args.kind && args.kind !== kind) continue;
            for (const [cls, v] of Object.entries(table)) {
                const name = v.displayName || "";
                const fields = kind === "unit" ? [cls, name, v.factionName, v.mod] : [cls, name];
                if (fields.some((value) => String(value || "").toLowerCase().includes(q))) {
                    const faction = kind === "unit" && v.factionName ? ` (${v.factionName})` : "";
                    console.log(`${kind.padEnd(8)} ${cls.padEnd(44)} ${name}${faction}  [${v.mod || ""}]`);
                }
            }
        }
        return;
    }
    if (cmd === "weapon") {
        const w = data.weapons[args._[1]];
        if (!w) { console.error("unknown weapon"); process.exit(1); }
        console.log(`${w.displayName} [${args._[1]}] from ${w.mod}` + (w.patchedBy.length ? `, patched by ${w.patchedBy.join(", ")}` : ""));
        for (const m of w.muzzles) {
            console.log(`  muzzle ${m.name} initSpeed ${m.initSpeed}, modes ${m.modes.map((x) => `${x.name}@${f(x.reloadTime, 3)}s`).join(" ")}`);
            for (const mag of m.magazines) {
                const mg = data.magazines[mag];
                if (!mg) continue;
                const a = data.ammo[mg.ammo] || {};
                console.log(`    ${mag.padEnd(40)} ${mg.ammo.padEnd(36)} hit ${a.hit} ind ${a.indirectHit || 0} cal ${a.caliber || 0} v0 ${mg.initSpeed} typ ${a.typicalSpeed || 0} type ${model.damageTypeOf(data, mg.ammo)}`);
            }
        }
        return;
    }
    if (cmd === "run" || cmd === "sweep") {
        if (!args.weapon) { console.error("--weapon is required"); process.exit(1); }
        const distances = cmd === "sweep" ? String(args.distances || "0,50,100,200,400,800").split(",").map(Number) : [null];
        const results = [];
        for (const d of distances) {
            const sc = scenarioFrom(args);
            sc.geometry = geometry;
            if (d !== null) sc.distance = d;
            results.push(model.simulate(data, sc));
        }
        if (args.json) {
            process.stdout.write(JSON.stringify(cmd === "run" ? results[0] : results, null, 2) + "\n");
            return;
        }
        if (cmd === "run") { printResult(results[0], args.trace); return; }
        console.log("dist   v(m/s)  P(wound) wounds  P(uncon) P(fatal) top wound" + (args["compare-armor-pen"] ? " | median shots (down/dead)" : ""));
        for (const r of results) {
            const top = r.woundTable[0];
            const bu = r.burst;
            const cmp = r.compare;
            const medians = (down, dead) => `${showShot(down, bu.shots)}/${showShot(dead, bu.shots)}`;
            const comparison = cmp ? ` | ACE armor penetration ${onOff(!cmp.armorPen)} ${medians(medianShot(bu.pUnconsciousBy), medianShot(bu.pFatalBy))}; ` +
                `${onOff(cmp.armorPen)} ${medians(cmp.downShot, cmp.deadShot)}` : "";
            console.log(`${String(r.scenario.distance).padEnd(6)} ${f(r.ballistics.v).padEnd(7)} ${pct(r.stats.pWound).padEnd(8)} ${f(r.stats.meanWounds, 2).padEnd(7)} ` +
                `${pct(r.stats.pUnconscious).padEnd(8)} ${pct(r.stats.pFatal).padEnd(8)} ${top ? `${top.part} ${top.wound} (${pct(top.chance)})` : "-"}${comparison}`);
        }
        return;
    }
    console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 18).join("\n"));
}

if (require.main === module) main();
module.exports = {buildBalanceRows, balanceCsv};
