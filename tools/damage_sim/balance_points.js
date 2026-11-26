/* Shared weapon and ammunition points for the balancing tab and Node. */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory(require("./damage_model.js"));
    } else {
        root.BalancePoints = factory(root.DamageModel);
    }
})(typeof window !== "undefined" ? window : this, function (M) {
    "use strict";

    const GENERATIONS = ["Firstborn", "Primaris"];
    const RELIQUARY = "Reliquary";
    const COLOR_WORDS = /\s*-\s*(black|red|white|blue|green|yellow|purple|ivory|gold|silver|stripes?|checker|imperial)\s*$/i;
    const NO_DAMAGE_SIMULATION = ["shotIlluminating", "shotSmoke", "shotSmokeX", "shotCM", "shotNVGMarker"];
    const certKey = (m) => (m.cert === RELIQUARY ? RELIQUARY : `${m.generation}:${m.cert}`);

    function buildCerts(roster) {
        const certs = [];
        for (const gen of GENERATIONS) {
            ((roster.certs || {})[gen] || []).forEach((name, index) => certs.push({key: `${gen}:${name}`, gen, name, index}));
        }
        certs.push({key: RELIQUARY, gen: RELIQUARY, name: RELIQUARY});
        return certs;
    }

    function doesDamage(ammo, name) {
        const a = ammo[name];
        if (!a || NO_DAMAGE_SIMULATION.includes(a.simulation)) return false;
        if ((a.hit || 0) > 0 || (a.indirectHit || 0) > 0) return true;
        const sub = Array.isArray(a.submunitionAmmo) ? a.submunitionAmmo[0] : a.submunitionAmmo;
        return Boolean(sub && ammo[sub] && ((ammo[sub].hit || 0) > 0 || (ammo[sub].indirectHit || 0) > 0));
    }
    function baseName(name) {
        return name.replace(/\[[^\]]*\]|\([^)]*\)/g, " ").replace(COLOR_WORDS, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    }
    function variantLabel(cls) {
        if (/_LSLOT$/i.test(cls)) return "launcher slot";
        if (/_Secondary$/i.test(cls)) return "secondary slot";
        return cls;
    }

    // Colour variants and copies with identical stats collapse into one point.
    function buildPoints(gameData, roster) {
        const {weapons, magazines, ammo} = gameData;
        const bySig = new Map();
        const add = (cls, memberships) => {
            const w = weapons[cls];
            if (!w) return;
            for (const muzzle of w.muzzles) {
                const mode = M.fastestMode(muzzle);
                const modeName = mode && mode.name;
                const muzzleDisplay = muzzle.displayName === "this" ? "" : muzzle.displayName;
                const modeLabel = (modeName !== "this" && modeName) || muzzleDisplay || "Default";
                const seenAmmo = new Set();
                for (const magName of muzzle.magazines) {
                    const mag = magazines[magName];
                    if (!mag || seenAmmo.has(mag.ammo) || !doesDamage(ammo, mag.ammo)) continue;
                    seenAmmo.add(mag.ammo);
                    const sig = [baseName(w.displayName), muzzle.name === "this" ? "" : baseName(muzzle.displayName || muzzle.name),
                        mag.ammo, mag.count, mag.initSpeed, muzzle.initSpeed, mode ? mode.reloadTime : 0, mode ? mode.dispersion : 0,
                        muzzle.magazineReloadTime || 0].join("|");
                    let p = bySig.get(sig);
                    if (!p) {
                        p = {id: sig, ammo: mag.ammo, classes: [], memberships: [], mods: new Set()};
                        bySig.set(sig, p);
                    }
                    if (!p.classes.includes(cls)) p.classes.push(cls);
                    p.mods.add(w.mod || "");
                    for (const m of memberships) {
                        if (!p.memberships.some((x) => certKey(x) === certKey(m) && x.acquisition === m.acquisition)) p.memberships.push(m);
                    }
                    // A roster class names the point, not an unlisted colour variant.
                    if (!p.weapon || (memberships.length && p.memberships.length === memberships.length)) {
                        Object.assign(p, {weapon: cls, muzzle: muzzle.name, magazine: magName, name: w.displayName, mod: w.mod || "",
                            muzzleName: muzzle.name === "this" ? "" : (muzzle.displayName || muzzle.name), magazineName: mag.displayName, modeLabel});
                    }
                }
            }
        };
        for (const [cls, memberships] of Object.entries(roster.classes)) add(cls, memberships);
        for (const cls of roster.otherMods) add(cls, []);

        const points = [...bySig.values()];
        const certOrder = new Map(buildCerts(roster).map((c, i) => [c.key, i]));
        const classesByName = new Map();
        for (const p of points) {
            p.certKeys = [...new Set(p.memberships.map(certKey))].sort((a, b) => (certOrder.get(a) ?? -1) - (certOrder.get(b) ?? -1));
            p.roster = p.certKeys.length > 0;
            if (!classesByName.has(p.name)) classesByName.set(p.name, new Set());
            classesByName.get(p.name).add(p.weapon);
        }
        for (const p of points) {
            const classes = classesByName.get(p.name);
            if (classes.size < 2) continue;
            const label = variantLabel(p.weapon);
            p.variant = [...classes].some((cls) => cls !== p.weapon && variantLabel(cls) === label) ? p.weapon : label;
        }
        return points;
    }

    function rankMods(points) {
        const counts = new Map();
        for (const p of points) if (!p.roster) counts.set(p.mod, (counts.get(p.mod) || 0) + 1);
        return [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a));
    }

    const BALANCE_COLUMNS = ["name", "variant", "class", "magazine", "ammo", "certs", "acquisition",
        "shots50", "shots25", "shots75", "spread", "pHit", "ttk", "ttk25", "ttk75", "magazinesToDown", "modeLabel", "rpm"];

    function balanceRow(p, r) {
        return {
            name: p.name, variant: p.variant || "", class: p.weapon, magazine: r.magazine, ammo: r.ammo,
            certs: p.certKeys.join("; "), acquisition: [...new Set(p.memberships.map((m) => m.acquisition))].join("; "),
            shots50: r.shots50, shots25: r.shots25, shots75: r.shots75, spread: r.spread, pHit: r.pHit,
            ttk: r.ttk, ttk25: r.ttk25, ttk75: r.ttk75,
            magazinesToDown: r.shots50 === null ? null : r.shots50 / r.roundsPerMag,
            modeLabel: p.modeLabel, rpm: r.reloadTime > 0 ? Math.round(60 / r.reloadTime) : null,
        };
    }

    function balanceCsv(rows) {
        const escape = (value) => {
            const text = String(value ?? "");
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        };
        return [BALANCE_COLUMNS.join(","), ...rows.map((row) => BALANCE_COLUMNS.map((key) => escape(row[key])).join(","))].join("\n") + "\n";
    }

    return {buildCerts, buildPoints, rankMods, GENERATIONS, RELIQUARY, BALANCE_COLUMNS, balanceRow, balanceCsv};
});
