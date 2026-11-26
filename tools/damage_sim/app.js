/* Astartes Wound Bench: UI over damage_model.js. Data: data/page_data.js (GAME_DATA), optional body figure and ACE menu images. */
(function () {
    "use strict";
    const D = window.GAME_DATA;
    const G = window.BODY_GEOMETRY || null;
    const ACE_IMG = window.ACE_BODY_IMAGES || {};
    const M = window.DamageModel;
    const $ = (id) => document.getElementById(id);
    const f = M.fmt;
    const SVG_NS = "http://www.w3.org/2000/svg";
    const STORE_KEY = "astartes-wound-bench-v2";
    const AI_UNITS = D.gear.aiUnits || {};
    const aiClasses = Object.keys(AI_UNITS);
    const defaultAiUnit = aiClasses.find((cls) => /^BT_/i.test(cls) ||
        /templar/i.test(`${AI_UNITS[cls].faction} ${AI_UNITS[cls].factionName}`)) || aiClasses[0] || "";
    const DEFAULTS = {
        target: "player", weapon: "BT_TyrianBolter", muzzle: "", fireMode: "", magazine: "", distance: 100, magazines: 1, spread: 2,
        impact: "HitChest", aim: null, blastDistance: 0, target_stance: "standing",
        aiUnit: defaultAiUnit, aiBrowse: "units", aiSelections: {}, aiFilter: "", comparePen: false,
        loadout: {uniform: "TIOW_Mk7PowerArmor_1_BT", vest: "TIOW_Mk7Limbs_BT", helmet: "TIOW_MK7Helmet_BT", backpack: ""},
        bco: "on", halo: "none", inspect: 0, smooth: false, acePart: -1, modDefaults: false, settings: {}, overrides: {},
        tab: "single",
        balance: {outcome: "down", reload: 3, otherMods: false, hidden: {}, acquisition: {default: true, earnable: true, relic: true}},
    };
    const PART_NAMES = ["Head", "Torso", "Left Arm", "Right Arm", "Left Leg", "Right Leg"];
    const PART_KEYS = ["head", "body", "leftarm", "rightarm", "leftleg", "rightleg"];

    let state = load();
    let lastResult = null;

    function load() {
        let saved = null;
        try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch (e) { saved = null; }
        const s = JSON.parse(JSON.stringify(DEFAULTS));
        if (saved && typeof saved === "object") {
            Object.assign(s, saved);
            s.loadout = Object.assign({}, DEFAULTS.loadout, saved.loadout || {});
            s.balance = Object.assign({}, DEFAULTS.balance, saved.balance || {});
            s.balance.acquisition = Object.assign({}, DEFAULTS.balance.acquisition, s.balance.acquisition);
        }
        if (s.tab !== "balance") s.tab = "single";
        if (!D.weapons[s.weapon]) s.weapon = DEFAULTS.weapon;
        if (!Object.hasOwn(AI_UNITS, s.aiUnit)) s.aiUnit = defaultAiUnit;
        if (s.aiBrowse !== "groups") s.aiBrowse = "units";
        if (s.target_stance !== "crouched") s.target_stance = "standing";
        s.aiSelections = Object.assign({}, s.aiSelections);
        if (typeof s.aiFilter !== "string") s.aiFilter = "";
        s.overrides = s.overrides || {};
        if (Object.hasOwn(s.overrides, "ammo") || Object.hasOwn(s.overrides, "magazine")) {
            const muzzles = D.weapons[s.weapon]?.muzzles || [];
            const muzzle = muzzles.find((m) => m.name === s.muzzle) || muzzles[0];
            const mags = (muzzle?.magazines || []).filter((m) => D.ammo[D.magazines[m]?.ammo]);
            const mag = mags.includes(s.magazine) ? s.magazine : mags[0];
            for (const [kind, cls] of [["ammo", D.magazines[mag]?.ammo], ["magazine", mag]]) {
                const patch = s.overrides[kind];
                if (cls && patch && Object.keys(patch).length) {
                    const byClass = s.overrides[kind + "ByClass"] ||= {};
                    byClass[cls] = Object.assign({}, patch, byClass[cls]);
                }
                delete s.overrides[kind];
            }
            persist(s);
        }
        return s;
    }
    function save() { persist(state); }
    function persist(s) {
        try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* storage unavailable: fine */ }
    }
    const MOD_DEFAULT_DATA = Object.assign({}, D, {serverSettings: {}});
    function dataForRun() { return state.modDefaults ? MOD_DEFAULT_DATA : D; }
    const defaultsCache = {};
    function settingDefaults() {
        const key = state.modDefaults ? "mod" : "server";
        if (!defaultsCache[key]) {
            const d = M.settingDefaults(dataForRun());
            const lower = {};
            for (const k of Object.keys(d)) lower[k.toLowerCase()] = d[k];
            defaultsCache[key] = {values: d, lower: lower};
        }
        return defaultsCache[key];
    }

    // ------------------------------------------------------------------ DOM helpers
    function el(tag, attrs, children) {
        const node = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) {
            if (v === undefined || v === null || v === false) continue;
            if (k === "class") node.className = v;
            else if (k === "text") node.textContent = v;
            else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
            else node.setAttribute(k, v === true ? "" : v);
        }
        for (const c of [].concat(children || [])) {
            if (c === null || c === undefined || c === false) continue;
            node.append(c instanceof Node ? c : document.createTextNode(String(c)));
        }
        return node;
    }
    function svg(tag, attrs) {
        const node = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
        return node;
    }
    const pct = (x) => (x >= 0.995 ? "100%" : x > 0 && x < 0.01 ? "<1%" : Math.round(x * 100) + "%");
    function partName(p) {
        return {Head: "head", Body: "torso", LeftArm: "left arm", RightArm: "right arm", LeftLeg: "left leg", RightLeg: "right leg"}[p] || p;
    }
    function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
    function resolvedName(name, cls) { return name && !/^[$@]STR/i.test(name) ? name : cls; }
    function namedClass(name, cls) {
        const label = resolvedName(name, cls);
        return label === cls ? cls : `${label} (${cls})`;
    }

    // ------------------------------------------------------------------ pickers
    function fillSelect(select, items, value, limit) {
        select.textContent = "";
        let count = 0;
        for (const it of items) {
            if (limit && count >= limit && it.value !== value) continue;
            const opt = el("option", {value: it.value, text: it.label});
            if (it.value === value) opt.selected = true;
            select.append(opt);
            count++;
        }
    }
    function matches(query, cls, item) {
        if (!query) return true;
        const hay = (cls + " " + (item.displayName || "") + " " + (item.mod || "")).toLowerCase();
        return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    }
    const weaponItems = Object.entries(D.weapons)
        .map(([cls, w]) => ({value: cls, label: `${w.displayName}  ·  ${w.mod || ""}`, cls: cls, w: w}))
        .sort((a, b) => a.label.localeCompare(b.label));

    function renderWeaponList() {
        const q = $("weaponFilter").value.trim();
        const items = weaponItems.filter((it) => matches(q, it.cls, it.w));
        if (!items.some((it) => it.value === state.weapon)) {
            const w = D.weapons[state.weapon];
            items.unshift({value: state.weapon, label: `${w.displayName}  ·  ${w.mod || ""}`});
        }
        fillSelect($("weapon"), items, state.weapon, 400);
        const w = D.weapons[state.weapon];
        $("weaponHint").textContent = `${w.displayName} · ${w.mod || ""} · ${state.weapon}` + (q ? ` (${items.length} match)` : "");
    }
    function currentMuzzle() {
        const w = D.weapons[state.weapon];
        return w.muzzles.find((m) => m.name === state.muzzle) || w.muzzles[0];
    }
    function renderMuzzleAndMags() {
        const w = D.weapons[state.weapon];
        $("muzzleField").hidden = w.muzzles.length < 2;
        if (!w.muzzles.some((m) => m.name === state.muzzle)) state.muzzle = w.muzzles[0].name;
        fillSelect($("muzzle"), w.muzzles.map((m) => ({value: m.name, label: m.name === "this" ? "Main" : `${m.displayName} (${m.name})`})), state.muzzle);
        const muzzle = currentMuzzle();
        const modes = (muzzle.modes || []).filter((m) => m.showToPlayer !== 0);
        if (!modes.some((m) => m.name === state.fireMode)) state.fireMode = modes.length ? modes[modes.length - 1].name : "";
        fillSelect($("fireMode"), modes.map((m) => ({value: m.name,
            label: `${m.name} · ${m.reloadTime > 0 ? Math.round(60 / m.reloadTime) + " rpm" : "?"} · ${f(m.dispersion * 1000, 2)} mrad`})), state.fireMode);
        const mags = muzzle.magazines.filter((m) => D.magazines[m] && D.ammo[D.magazines[m].ammo]);
        if (!mags.includes(state.magazine)) state.magazine = mags[0];
        fillSelect($("magazine"), mags.map((m) => {
            const mg = D.magazines[m];
            const a = D.ammo[mg.ammo];
            return {value: m, label: `${mg.displayName} · ${f(mg.count)} rnd · hit ${f(a.hit)}${a.indirectHit ? " +" + f(a.indirectHit) + " blast" : ""}`};
        }), state.magazine);
        renderMagHint();
    }
    function renderMagHint() {
        const mg = D.magazines[state.magazine];
        const mode = (currentMuzzle().modes || []).find((m) => m.name === state.fireMode);
        const rounds = Math.round((mg && mg.count) || 1);
        const total = Math.min(600, rounds * state.magazines);
        const secs = mode ? (total - 1) * mode.reloadTime : 0;
        $("magHint").textContent = `${rounds} rounds a magazine · ${total} shots` + (secs > 0 ? ` over ${f(secs, 1)} s of trigger time` : "") +
            (rounds * state.magazines > 600 ? " (capped at 600)" : "");
    }

    const GEAR = [
        {key: "uniform", table: D.gear.uniforms, empty: false},
        {key: "vest", table: D.gear.vests, empty: true},
        {key: "helmet", table: D.gear.helmets, empty: true},
        {key: "backpack", table: D.gear.backpacks, empty: true},
    ];
    function renderGear(key) {
        const g = GEAR.find((x) => x.key === key);
        const q = $(key + "Filter").value.trim();
        const items = Object.entries(g.table)
            .filter(([cls, v]) => matches(q, cls, v) || cls === state.loadout[key])
            .map(([cls, v]) => ({value: cls, label: `${v.displayName || cls}  ·  ${v.mod || ""}`}))
            .sort((a, b) => a.label.localeCompare(b.label));
        if (g.empty) items.unshift({value: "", label: `No ${key}`});
        fillSelect($(key), items, state.loadout[key], 500);
    }

    const SIDE_NAMES = ["OPFOR", "BLUFOR", "Independent", "Civilian"];
    function sideLabel(side, name) {
        const aliases = {east: 0, west: 1, indep: 2, guer: 2, independent: 2, civ: 3, civilian: 3};
        return SIDE_NAMES[side] || SIDE_NAMES[aliases[String(side).toLowerCase()]] || resolvedName(name, side) || "Other";
    }
    function browseRow(entry, cls, group) {
        const option = (value, label) => ({value: String(value ?? ""), label: resolvedName(label, value) || "Other"});
        const category = group ? entry.category : entry.subcategory;
        return {
            aiSide: option(entry.side, sideLabel(entry.side, entry.sideName)),
            aiFaction: option(entry.faction, entry.factionName),
            aiCategory: option(category, group ? entry.categoryName : resolvedName(category, entry.category)),
            aiGroup: group ? option(entry.group, entry.name) : null,
            aiUnit: option(cls, namedClass(AI_UNITS[cls].displayName, cls)),
        };
    }
    const AI_ROWS = {
        units: aiClasses.map((cls) => browseRow(AI_UNITS[cls], cls, false)),
        groups: (D.groups || []).flatMap((group) => [...new Set(group.units)]
            .filter((cls) => Object.hasOwn(AI_UNITS, cls)).map((cls) => browseRow(group, cls, true))),
    };
    const AI_SELECTS = ["aiSide", "aiFaction", "aiCategory", "aiGroup", "aiUnit"];
    function renderAiPicker(changed) {
        const mode = state.aiBrowse;
        const previous = state.aiUnit;
        const path = Object.assign({}, state.aiSelections[mode]);
        const ids = AI_SELECTS.filter((id) => id !== "aiGroup" || mode === "groups");
        if (changed) {
            const index = ids.indexOf(changed);
            path[changed] = $(changed).value;
            for (const id of ids.slice(index + 1)) delete path[id];
        }
        $("browseUnits").checked = mode === "units";
        $("browseGroups").checked = mode === "groups";
        $("aiGroupField").hidden = mode !== "groups";
        const q = state.aiFilter.trim().toLowerCase();
        const words = q ? q.split(/\s+/) : [];
        let rows = AI_ROWS[mode].filter((row) => {
            if (!q) return true;
            const cls = row.aiUnit.value;
            const unit = AI_UNITS[cls];
            const hay = [row.aiUnit.label, unit.faction, unit.factionName, unit.mod,
                row.aiFaction.value, row.aiFaction.label].join(" ").toLowerCase();
            return words.every((word) => hay.includes(word));
        });
        for (const id of ids) {
            const options = new Map(rows.map((row) => [row[id].value, row[id]]));
            const items = [...options.values()].sort((a, b) => a.label.localeCompare(b.label));
            const preferred = rows.find((row) => row.aiUnit.value === previous);
            const value = options.has(path[id]) ? path[id] : (preferred?.[id] || items[0])?.value;
            fillSelect($(id), items, value);
            $(id).disabled = !items.length;
            if (items.length) path[id] = value;
            rows = rows.filter((row) => row[id].value === value);
        }
        if (rows.length) {
            state.aiUnit = path.aiUnit;
            state.aiSelections[mode] = path;
        }
        const unit = AI_UNITS[state.aiUnit];
        $("aiHint").hidden = Boolean(rows.length);
        $("aiHint").textContent = (q ? "No matching units." : `No ${mode} in the catalog.`) +
            (unit ? " The current target is unchanged." : "");
        $("aiSummary").replaceChildren(...(unit ? [
            ["Class", state.aiUnit],
            ...GEAR.map(({key, table}) => [capital(key), unit[key] ? namedClass(table[unit[key]]?.displayName, unit[key]) : "None"]),
        ].flatMap(([key, value]) => [el("dt", {text: key}), el("dd", {text: value})]) : []));
    }

    function currentLoadout() {
        return state.target === "ai" ? AI_UNITS[state.aiUnit] || {} : state.loadout;
    }
    function currentUnitClass() { return D.gear.uniforms[currentLoadout().uniform]?.unitClass; }

    function bcoInfo() {
        try {
            const r = M.prepare(dataForRun(), scenario({mode: "bco", geometry: null}));
            return {available: Boolean(r.bco && r.bco.hasUniform), hudOnly: Boolean(r.settings.HOV_HUD_ONLY)};
        } catch (e) { return {available: false, hudOnly: false}; }
    }
    function renderTarget() {
        $("targetStance").value = state.target_stance;
        $("targetPlayer").checked = state.target !== "ai";
        $("targetAi").checked = state.target === "ai";
        $("loadoutField").hidden = state.target === "ai";
        $("unitField").hidden = state.target !== "ai";
        const s = settingDefaults();
        const v = (k) => settingValue(k, s);
        $("targetHint").textContent = state.target === "ai"
            ? `Damage threshold ${v("ace_medical_AIDamageThreshold")}; ${v("ace_medical_statemachine_AIUnconsciousness") ? "can go unconscious" : "dies instead of going unconscious"}; fatal injuries: ${M.FATAL_INJURY_LABELS[v("ace_medical_statemachine_fatalInjuriesAI")].toLowerCase()}.`
            : `Damage threshold ${v("ace_medical_playerDamageThreshold")}; death chance ${v("ace_medical_deathChance")}; fatal injuries: ${M.FATAL_INJURY_LABELS[v("ace_medical_statemachine_fatalInjuriesPlayer")].toLowerCase()}.`;
    }
    function renderBco() {
        const info = D.bco ? bcoInfo() : {available: false, hudOnly: false};
        const usable = info.available && !info.hudOnly;
        $("bcoOn").disabled = !usable || state.target === "ai";
        $("bcoOff").disabled = !usable || state.target === "ai";
        const on = usable && (state.target === "ai" || state.bco === "on");
        $("bcoOn").checked = on;
        $("bcoOff").checked = !on;
        $("haloField").hidden = !on;
        $("halo").value = state.halo;
        $("bcoHint").textContent = !D.bco ? "Black Carapace Overhaul is not in the mod list."
            : !info.available ? "This uniform is not on any Black Carapace armor list, so the engine and ACE handle every hit."
            : info.hudOnly ? "HOV_HUD_ONLY is on in these settings: the suit is cosmetic and its plates never absorb anything."
            : state.target === "ai" ? "AI wearing a listed suit are always in armor mode."
            : on ? "Plates and the Iron Halo absorb hits first; only the overflow reaches ACE."
            : "Engine damage goes straight into ACE, as before the suit boots.";
    }

    // ------------------------------------------------------------------ aim figure
    function hpCentre(hp) {
        const cfg = D.gear.units[currentUnitClass()]?.hitpoints[hp];
        const pts = G && cfg && G.hitpoints[String(cfg.name).toLowerCase()];
        if (!pts || !pts.length) return {x: 0, y: 0.4};
        return {x: pts.reduce((a, p) => a + p[0], 0) / pts.length, y: pts.reduce((a, p) => a + p[1], 0) / pts.length};
    }
    function renderAimLegend() {
        const box = $("aimLegend");
        if (!box) return;
        box.hidden = !G || state.impact === "Blast";
        box.replaceChildren();
        if (state.tab !== "balance") {
            box.append(
                el("span", {}, [el("span", {class: "dot", style: "background: var(--hit)"}), "landed on the body"]),
                el("span", {}, [el("span", {class: "dot", style: "background: var(--miss)"}), "missed"]),
            );
        }
        box.append(el("span", {}, [el("span", {class: "dot ring"}), "aim point"]));
    }
    function renderAimControls() {
        renderAimLegend();
        const presets = Object.entries(M.IMPACTS).map(([k, v]) => ({value: k, label: "Aim at " + v.label.toLowerCase()}));
        if (state.impact === "Blast") presets.unshift({value: "Blast", label: "Indirect splash"});
        else if (state.aim) presets.unshift({value: "custom", label: "Custom point"});
        fillSelect($("aimPreset"), presets, state.aim ? "custom" : state.impact);
        $("blastBtn").setAttribute("aria-pressed", String(state.impact === "Blast"));
        $("blastDistanceField").hidden = state.impact !== "Blast";
        $("aimCanvas").hidden = !G;
        $("bodySvg").hidden = Boolean(G);
        for (const z of document.querySelectorAll(".zone")) z.setAttribute("aria-pressed", String(z.dataset.hp === state.impact));
        renderAimHint();
        drawAim();
    }
    function renderAimHint(r) {
        const blast = r && r.blast;
        const hint = [];
        if (state.impact === "Blast") {
            hint.push("The round bursts next to the target without hitting it (a near miss or ground hit); only its splash (indirectHit) applies, falling off past indirectHitRange (engine assumption). A direct hit with an explosive round already includes its blast with the suit off.");
            if (blast) {
                hint.push(`This round: indirectHit ${f(blast.indirectHit)}, indirectHitRange ${f(blast.indirectHitRange)} m.`);
                if (r.bco) hint.push("Black Carapace uses the full config blast damage wherever the splash still reaches.");
            }
        } else {
            hint.push(G ? "Click the figure to aim; arrow keys nudge the aim point." : "Pick where the round lands.");
            if (blast?.indirectHit > 0) {
                hint.push(blast.directIncludesBlast || blast.explosive > 0
                    ? `With the suit off, splash (indirectHit ${f(blast.indirectHit)}) is folded into the final impact. With Black Carapace on, the same-frame guard drops it.`
                    : `The model does not add splash to direct hits from this non-explosive round (indirectHit ${f(blast.indirectHit)}).`);
            }
        }
        $("aimHint").textContent = hint.join(" ");
    }
    function toPx(x, y) { return [(x - G.minx) * G.scale, (G.maxy - y) * G.scale]; }
    function fromPx(px, py) { return {x: px / G.scale + G.minx, y: G.maxy - py / G.scale}; }
    let figureImg = null;
    function drawAim() {
        if (!G) return;
        const c = $("aimCanvas");
        const dpr = window.devicePixelRatio || 1;
        c.width = G.width * dpr;
        c.height = G.height * dpr;
        c.style.aspectRatio = `${G.width} / ${G.height}`;
        const ctx = c.getContext("2d");
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, G.width, G.height);
        const css = getComputedStyle(document.documentElement);
        const paint = () => {
            ctx.drawImage(figureImg, 0, 0, G.width, G.height);
            if (state.tab !== "balance" && lastResult && lastResult.burst.cloud && state.impact !== "Blast") {
                for (const [x, y, hit] of lastResult.burst.cloud) {
                    const [px, py] = toPx(x, y);
                    ctx.fillStyle = hit ? css.getPropertyValue("--hit") : css.getPropertyValue("--miss");
                    ctx.globalAlpha = hit ? 0.75 : 0.55;
                    ctx.beginPath();
                    ctx.arc(px, py, 1.6, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.globalAlpha = 1;
            }
            if (state.impact !== "Blast") {
                const aim = state.aim || hpCentre(state.impact);
                const [ax, ay] = toPx(aim.x, aim.y);
                ctx.strokeStyle = css.getPropertyValue("--fatal");
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(ax, ay, 7, 0, Math.PI * 2);
                ctx.moveTo(ax - 12, ay); ctx.lineTo(ax - 4, ay);
                ctx.moveTo(ax + 4, ay); ctx.lineTo(ax + 12, ay);
                ctx.moveTo(ax, ay - 12); ctx.lineTo(ax, ay - 4);
                ctx.moveTo(ax, ay + 4); ctx.lineTo(ax, ay + 12);
                ctx.stroke();
            }
        };
        if (!figureImg) {
            figureImg = new Image();
            figureImg.onload = paint;
            figureImg.src = G.image;
        } else if (figureImg.complete) {
            paint();
        }
    }

    // ------------------------------------------------------------------ scenario
    function scenario(extra) {
        return Object.assign({
            weapon: state.weapon, muzzle: state.muzzle, magazine: state.magazine, fireMode: state.fireMode,
            distance: Number(state.distance) || 0, magazines: state.magazines, spreadMrad: Number(state.spread) || 0,
            target: state.target, impact: state.impact, aim: state.aim || undefined, geometry: G,
            target_stance: state.target_stance,
            unit: state.target === "ai" ? state.aiUnit || undefined : undefined,
            loadout: state.target === "player" ? state.loadout : undefined,
            mode: state.target === "ai" ? "auto" : state.bco === "on" ? "bco" : "vanilla", ironHalo: state.halo,
            compareArmorPen: state.comparePen, blastDistance: state.blastDistance,
            samples: 900, seed: 7, traceHit: state.inspect || undefined, viewShot: state.inspect || undefined,
            settings: state.settings, overrides: cleanOverrides(),
        }, extra || {});
    }
    function cleanOverrides() {
        const prune = (o) => {
            if (!o || typeof o !== "object") return o;
            for (const k of Object.keys(o)) {
                o[k] = prune(o[k]);
                if (o[k] && typeof o[k] === "object" && Object.keys(o[k]).length === 0) delete o[k];
            }
            return o;
        };
        const o = prune(JSON.parse(JSON.stringify(state.overrides || {})));
        return Object.keys(o).length ? o : undefined;
    }

    let timer = 0;
    function update(immediate) {
        save();
        clearTimeout(timer);
        timer = setTimeout(run, immediate ? 0 : 150);
    }
    function resetChangedValues() {
        state.settings = {}; state.overrides = {}; renderTarget(); renderBco(); update(true);
    }
    function run() {
        if (state.tab === "balance") {
            if (window.WoundBench.balance) window.WoundBench.balance.update();
            return;
        }
        let r;
        try {
            r = M.simulate(dataForRun(), scenario());
        } catch (err) {
            $("lead").replaceChildren(el("p", {class: "err", text: "This combination cannot be simulated: " + err.message}));
            return;
        }
        lastResult = r;
        renderAimHint(r);
        renderLead(r);
        renderMedical(r);
        renderOneHit(r);
        renderChain(r);
        renderSources(r);
        drawAim();
    }

    // ------------------------------------------------------------------ lead
    function firstAt(arr, p) {
        const i = arr.findIndex((x) => x >= p);
        return i < 0 ? null : i + 1;
    }
    function neverDiesReason() {
        const s = settingDefaults();
        const v = (k) => settingValue(k, s);
        if (state.target !== "ai") {
            if (v("ace_medical_deathChance") === 0) return "Player death chance is 0, so ACE never raises a fatal injury on a player.";
            if (v("ace_medical_statemachine_fatalInjuriesPlayer") === 2) return "Fatal injuries are set to never kill players; he can only bleed out in cardiac arrest.";
        }
        return "";
    }
    function neverDiesShort() {
        const s = settingDefaults();
        const v = (k) => settingValue(k, s);
        if (state.target !== "ai" && v("ace_medical_deathChance") === 0) return "player death chance is 0";
        if (state.target !== "ai" && v("ace_medical_statemachine_fatalInjuriesPlayer") === 2) return "fatal injuries never kill players";
        return "";
    }
    // Every value the user changed, as "label base → value"
    function changedValues() {
        const out = [];
        const defaults = settingDefaults();
        for (const [k, v] of Object.entries(state.settings)) {
            out.push(`${k} ${fmtVal(baseValue(k, defaults))} → ${fmtVal(v)}`);
        }
        const loadout = currentLoadout();
        const unit = D.gear.units[currentUnitClass()];
        const walk = (obj, path) => {
            for (const [k, v] of Object.entries(obj || {})) {
                const p = path.concat(k);
                if (v && typeof v === "object") { walk(v, p); continue; }
                let base, label;
                if (p[0] === "ammoByClass") { base = D.ammo[p[1]]?.[k]; label = `${p[1]} ${k}`; }
                else if (p[0] === "magazineByClass") { base = D.magazines[p[1]]?.[k]; label = `${p[1]} ${k}`; }
                else if (p[0] === "unit") { base = unit[k]; label = `Unit ${k}`; }
                else if (p[0] === "unitHitpoint") { base = (unit.hitpoints[p[1]] || {})[k]; label = `${p[1]} ${k}`; }
                else if (p[0] === "vest" || p[0] === "helmet") {
                    const item = (p[0] === "vest" ? D.gear.vests : D.gear.helmets)[loadout[p[0]]];
                    base = ((item && item.protection[p[1]]) || {})[k];
                    label = `${capital(p[0])} ${k} on ${p[1]}`;
                } else if (p[0] === "bco") {
                    const b = baseBco();
                    base = p[1] === "plates" ? b.plates[k] : b[k];
                    label = p[1] === "plates" ? `${capital(ZONES[k])} plate` : `Black Carapace ${k}`;
                } else { label = p.join(" "); }
                out.push(`${label} ${base === undefined ? "?" : fmtVal(base)} → ${fmtVal(v)}`);
            }
        };
        walk(state.overrides, []);
        return out;
    }
    function renderLead(r) {
        const b = r.burst;
        const down = firstAt(b.pUnconsciousBy, 0.5);
        const dead = firstAt(b.pFatalBy, 0.5);
        const box = $("lead");
        box.textContent = "";
        if (r.ballistics.outOfRange) {
            box.append(el("p", {class: "err", text: `The round expires after ${f(D.ammo[r.scenario.ammo].timeToLive || 0)} s of flight, before it covers ${r.scenario.distance} m.`}));
        }
        const unit = r.scenario.unit;
        const who = unit ? `AI target: ${namedClass(unit.displayName, unit.class)}` : r.scenario.isPlayer ? "player target" : "AI target";
        box.append(el("div", {class: "lead-figures"}, [
            el("div", {class: "hero", text: down ? `Down at shot ${down}` : `Standing after ${b.shots} shots`}),
            dead ? el("div", {class: "lead-second"}, [el("span", {class: "status-dot", style: "background: var(--fatal)"}), `Dead at shot ${dead}`])
                : el("div", {class: "lead-second", style: "color: var(--ink-2)"}, [`Not killed in ${b.shots} shots`,
                    neverDiesReason() ? el("div", {class: "hint", style: "font-weight:400", text: neverDiesShort()}) : null]),
        ]));
        if (r.compare) {
            const shot = (n) => n === null ? "never" : `at shot ${n}`;
            box.append(el("p", {class: "lead-context", text: `With ACE armor penetration ${penLabel(r)}: down ${shot(r.compare.downShot)}, dead ${shot(r.compare.deadShot)}.`}));
        }
        if (r.bco) {
            box.append(el("p", {class: "hint", style: "margin:0", text: "ACE armor penetration has no effect in Black Carapace armor mode: the suit's remaining damage goes through addDamageToUnit, which the armor penetration handler skips."}));
        }
        const changes = changedValues();
        if (changes.length) {
            box.append(el("div", {class: "changes"}, [el("span", {class: "label", text: "Changed values: "}),
                el("span", {text: changes.join(" · ")}),
                el("button", {type: "button", class: "reset", text: "reset all", onclick: resetChangedValues})]));
        }
        const aim = state.impact === "Blast" ? `blast only, ${f(r.blast.distance)} m from the burst`
            : `aiming at ${state.aim ? "a custom point" : r.scenario.impactLabel.toLowerCase()}`;
        const parts = [`${r.scenario.weapon} on ${r.scenario.fireMode}, ${r.scenario.magazine}, ${r.scenario.distance} m, ${who}, ${aim}.`];
        if (down) parts.push(`Half of ${b.runs} simulated bursts had him down by shot ${down}` + (b.interval > 0 ? `, ${f((down - 1) * b.interval, 1)} s after the first shot.` : "."));

        const meanHit = b.pHitPerShot.reduce((a, x) => a + x, 0) / Math.max(1, b.pHitPerShot.length);
        if (r.scenario.geometry && state.impact !== "Blast") parts.push(`${pct(meanHit)} of shots land on the body.`);
        if (r.bcoBlockedBySetting) parts.push("Black Carapace is cosmetic-only in these settings.");
        box.append(el("p", {class: "lead-context", text: parts.join(" ")}));
        box.append(burstChart(r));
        box.append(burstTable(r));
    }

    function penLabel(r) { return r.compare.armorPen ? "on" : "off"; }
    function seriesKey(s) {
        return el("span", {class: "series-key", style: `border-color:${s.color};border-top-style:${s.dash ? "dashed" : "solid"}`});
    }
    function burstChart(r) {
        const b = r.burst;
        const n = b.shots;
        const W = 680, H = 200, padL = 46, padR = r.compare ? 174 : 130, padT = 10, padB = 38;
        const zone = r.bco && state.impact !== "Blast" ? zoneKey(r) : null;
        const plateH = zone ? 50 : 0;
        const total = H + plateH;
        const x = (i) => padL + (n === 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
        const y = (p) => padT + (1 - p) * (H - padT - padB);
        const root = svg("svg", {viewBox: `0 0 ${W} ${total}`, role: "img",
            "aria-label": `Running chance that the target is down or dead after each of ${n} shots`});
        const grid = svg("g", {class: "grid"});
        const axis = svg("g", {class: "axis"});
        for (const p of [0, 0.25, 0.5, 0.75, 1]) {
            grid.append(svg("line", {x1: padL, x2: W - padR, y1: y(p), y2: y(p)}));
            const t = svg("text", {x: padL - 6, y: y(p) + 4, "text-anchor": "end"});
            t.textContent = Math.round(p * 100) + "%";
            axis.append(t);
        }
        const step = Math.max(1, Math.ceil(n / 12));
        for (let i = 0; i < n; i += step) {
            const t = svg("text", {x: x(i), y: H - padB + 16, "text-anchor": "middle"});
            t.textContent = String(i + 1);
            axis.append(t);
        }
        const xTitle = svg("text", {x: (padL + W - padR) / 2, y: H - 4, "text-anchor": "middle", class: "axis-title"});
        xTitle.textContent = "Shot number";
        axis.append(xTitle);
        // magazine changes
        for (let m = 1; m * b.roundsPerMag < n; m++) {
            const xm = x(m * b.roundsPerMag - 0.5);
            grid.append(svg("line", {x1: xm, x2: xm, y1: padT, y2: H - padB, "stroke-dasharray": "0", stroke: "var(--ink-3)", opacity: 0.5}));
            const t = svg("text", {x: xm + 4, y: padT + 10});
            t.textContent = `mag ${m + 1}`;
            axis.append(t);
        }
        root.append(grid, axis);
        const series = [
            {label: "Down", legend: "Down (unconscious, cardiac arrest or dead)", data: b.pUnconsciousBy, color: "var(--uncon)"},
            {label: "Dead", data: b.pFatalBy, color: "var(--fatal)"},
        ];
        if (r.compare) {
            const pen = `armor pen. ${penLabel(r)}`;
            series.push(
                {label: `Down, ${pen}`, data: r.compare.pUnconsciousBy, color: "var(--uncon)", dash: true},
                {label: `Dead, ${pen}`, data: r.compare.pFatalBy, color: "var(--fatal)", dash: true},
            );
        }
        for (const s of series) {
            root.append(svg("path", {d: state.smooth ? smoothPath(s.data, x, y) : stepPath(s.data, x, y), fill: "none", stroke: s.color,
                "stroke-width": s.dash ? 3 : 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash ? "5 5" : "none"}));
        }
        const endpoints = series.map((s) => ({s, last: s.data[n - 1]})).sort((a, b) => b.last - a.last);
        // Pack end labels top to bottom, reserving a row for each remaining label.
        let labelY = padT - 12;
        endpoints.forEach(({s, last}, i) => {
            const endX = x(n - 1), endY = y(last);
            labelY = Math.max(labelY + 14, Math.min(endY, H - padB - 14 * (endpoints.length - 1 - i)));
            root.append(svg("line", {x1: endX, x2: endX + 12, y1: endY, y2: labelY, stroke: s.color,
                "stroke-dasharray": s.dash ? "3 2" : "none"}));
            root.append(svg("circle", {cx: endX, cy: endY, r: 3, fill: s.color, stroke: "var(--surface)", "stroke-width": 1}));
            const lbl = svg("text", {x: endX + 16, y: labelY + 4, fill: "var(--ink-2)", "font-size": 12});
            lbl.textContent = `${s.label} ${pct(last)}`;
            root.append(lbl);
        });
        const inspect = r.view.shot - 1;
        root.append(svg("line", {x1: x(inspect), x2: x(inspect), y1: padT, y2: H - padB, stroke: "var(--accent)", "stroke-width": 1.5}));
        const inspectLabel = svg("text", {x: x(inspect) + (inspect > n * 0.7 ? -4 : 4), y: H - padB - 6, fill: "var(--accent)", "font-size": 11,
            "text-anchor": inspect > n * 0.7 ? "end" : "start"});
        inspectLabel.textContent = `shot ${inspect + 1} (inspected below)`;
        root.append(inspectLabel);
        if (zone) {
            const full = r.bco.plates[zone] || 1;
            const top = H + 6, h = plateH - 16;
            const g = svg("g", {class: "axis"});
            const bw = Math.max(1, Math.min(20, (W - padL - padR) / n - 2));
            b.plates.forEach((p, i) => {
                if (!p) return;
                const v = Math.max(0, p[zone]);
                const bh = (v / full) * h;
                if (bh > 0) g.append(svg("path", {d: roundTop(x(i) - bw / 2, top + h - bh, bw, bh, Math.min(3, bh, bw / 2)), fill: "var(--plate)"}));
            });
            g.append(svg("line", {x1: padL, x2: W - padR, y1: top + h + 0.5, y2: top + h + 0.5, stroke: "var(--line)"}));
            const cap = svg("text", {x: W - padR + 10, y: top + 12});
            cap.textContent = `${capital(ZONES[zone])} plate left`;
            g.append(cap);
            root.append(g);
        }
        const tip = el("div", {class: "tip", hidden: true});
        const cross = svg("line", {y1: padT, y2: H - padB, stroke: "var(--ink-3)", "stroke-width": 1, visibility: "hidden"});
        root.append(cross);
        const hit = svg("rect", {x: padL - 10, y: 0, width: W - padL - padR + 20, height: total, fill: "transparent", tabindex: 0,
            "aria-label": "Shots: use arrow keys to read values, Enter to inspect"});
        root.append(hit);
        let focusIndex = inspect;
        const show = (i) => {
            i = Math.max(0, Math.min(n - 1, i));
            focusIndex = i;
            cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
            tip.hidden = false;
            const rows = [el("div", {class: "row"}, [el("span", {text: "Shot"}), el("span", {class: "v", text: String(i + 1)})])];
            for (const s of series) {
                rows.push(el("div", {class: "row"}, [el("span", {}, [seriesKey(s), `${s.label} by now`]),
                    el("span", {class: "v", text: pct(s.data[i])})]));
            }
            rows.push(el("div", {class: "row"}, [el("span", {text: "This shot lands"}), el("span", {class: "v", text: pct(b.pHitPerShot[i])})]));
            rows.push(el("div", {class: "row"}, [el("span", {text: "Wounds from it"}), el("span", {class: "v", text: f(b.meanWoundsPerHit[i], 2)})]));
            if (zone && b.plates[i]) rows.push(el("div", {class: "row"}, [el("span", {text: "Plate after"}), el("span", {class: "v", text: f(b.plates[i][zone])})]));
            tip.replaceChildren(...rows);
            const box = root.getBoundingClientRect();
            tip.style.left = Math.max(0, Math.min(box.width - 200, (x(i) / W) * box.width + 12)) + "px";
            tip.style.top = "8px";
        };
        const hide = () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); };
        const idx = (evt) => {
            const box = root.getBoundingClientRect();
            const vx = ((evt.clientX - box.left) / box.width) * W;
            return Math.round(((vx - padL) / (W - padL - padR)) * (n - 1));
        };
        hit.addEventListener("pointermove", (e) => show(idx(e)));
        hit.addEventListener("pointerleave", hide);
        hit.addEventListener("focus", () => show(focusIndex));
        hit.addEventListener("blur", hide);
        hit.addEventListener("keydown", (e) => {
            if (e.key === "ArrowRight") { show(focusIndex + 1); e.preventDefault(); }
            if (e.key === "ArrowLeft") { show(focusIndex - 1); e.preventDefault(); }
            if (e.key === "Enter") inspectShot(focusIndex + 1);
        });
        const inspectShot = (shot) => {
            state.inspect = shot;
            update(true);
            const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
            $("medical").scrollIntoView({behavior: reduce ? "auto" : "smooth", block: "start"});
        };
        hit.addEventListener("click", (e) => inspectShot(Math.max(1, Math.min(n, idx(e) + 1))));
        const smooth = el("label", {class: "check"}, [el("input", {type: "checkbox", id: "smooth"}), "Smooth lines"]);
        smooth.firstChild.checked = state.smooth;
        smooth.firstChild.addEventListener("change", (e) => { state.smooth = e.target.checked; save(); renderLead(lastResult); });
        const compare = el("label", {class: "check"}, [el("input", {type: "checkbox", id: "comparePen", checked: state.comparePen}), "Compare ACE armor penetration"]);
        compare.firstChild.addEventListener("change", (e) => { state.comparePen = e.target.checked; update(true); });
        const head = el("div", {class: "chart-head"}, [
            el("div", {class: "legend"}, series.map((s) => el("span", {}, [seriesKey(s), s.legend || s.label]))),
            el("div", {class: "toolbar"}, [smooth, compare]),
        ]);
        const read = el("p", {class: "hint", style: "margin:0",
            text: `How to read it: each line is a running chance, not progress toward a state. A point at shot 12 and 70% means 70% of the ${b.runs} simulated bursts had the target down by shot 12. The blue line is the shot inspected below; click the chart to move it.`});
        const wrap = el("div", {class: "chart-box"}, [root, tip]);
        return el("div", {style: "display:grid;gap:8px"}, [head, read, wrap]);
    }
    function stepPath(data, x, y) {
        let d = `M ${x(0)} ${y(data[0])}`;
        for (let i = 1; i < data.length; i++) d += ` L ${x(i)} ${y(data[i - 1])} L ${x(i)} ${y(data[i])}`;
        return d;
    }
    // Monotone cubic (Fritsch-Carlson): smooth without overshooting the 0..100% range
    function smoothPath(data, x, y) {
        const n = data.length;
        if (n < 3) return stepPath(data, x, y);
        const px = data.map((_, i) => x(i)), py = data.map((v) => y(v));
        const dx = [], m = [], t = new Array(n);
        for (let i = 0; i < n - 1; i++) { dx.push(px[i + 1] - px[i]); m.push((py[i + 1] - py[i]) / dx[i]); }
        t[0] = m[0]; t[n - 1] = m[n - 2];
        for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
        for (let i = 0; i < n - 1; i++) {
            if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
            const a = t[i] / m[i], b2 = t[i + 1] / m[i], h = a * a + b2 * b2;
            if (h > 9) { const k = 3 / Math.sqrt(h); t[i] = k * a * m[i]; t[i + 1] = k * b2 * m[i]; }
        }
        let d = `M ${px[0]} ${py[0]}`;
        for (let i = 0; i < n - 1; i++) {
            const h = dx[i] / 3;
            d += ` C ${px[i] + h} ${py[i] + t[i] * h} ${px[i + 1] - h} ${py[i + 1] - t[i + 1] * h} ${px[i + 1]} ${py[i + 1]}`;
        }
        return d;
    }
    function roundTop(x0, y0, w, h, r) {
        return `M ${x0} ${y0 + h} L ${x0} ${y0 + r} Q ${x0} ${y0} ${x0 + r} ${y0} L ${x0 + w - r} ${y0} Q ${x0 + w} ${y0} ${x0 + w} ${y0 + r} L ${x0 + w} ${y0 + h} Z`;
    }
    function burstTable(r) {
        const b = r.burst;
        const zone = r.bco && state.impact !== "Blast" ? zoneKey(r) : null;
        const compareHead = r.compare ? ["Down", "Dead"].map((label) => el("th", {class: "n", text: `${label}, armor pen. ${penLabel(r)}`})) : [];
        const head = el("tr", {}, [el("th", {class: "n", text: "Shot"}), el("th", {class: "n", text: "Down by now"}), el("th", {class: "n", text: "Dead by now"}), ...compareHead,
            el("th", {class: "n", text: "Lands"}), el("th", {class: "n", text: "Wounds from it"}), zone ? el("th", {class: "n", text: "Plate after"}) : null]);
        const rows = b.pUnconsciousBy.map((u, i) => el("tr", {}, [el("td", {class: "n", text: String(i + 1)}), el("td", {class: "n", text: pct(u)}),
            el("td", {class: "n", text: pct(b.pFatalBy[i])}),
            ...(r.compare ? [r.compare.pUnconsciousBy[i], r.compare.pFatalBy[i]].map((p) => el("td", {class: "n", text: pct(p)})) : []),
            el("td", {class: "n", text: pct(b.pHitPerShot[i])}), el("td", {class: "n", text: f(b.meanWoundsPerHit[i], 2)}),
            zone ? el("td", {class: "n", text: b.plates[i] ? f(b.plates[i][zone]) : "-"}) : null]));
        return el("details", {}, [el("summary", {text: "Table view"}), el("div", {class: "table-scroll"}, el("table", {}, [el("thead", {}, head), el("tbody", {}, rows)]))]);
    }

    const ZONES = {head: "head", body: "torso", armL: "left arm", armR: "right arm", legL: "left leg", legR: "right leg"};
    function zoneKey(r) {
        const impact = M.IMPACTS[r.scenario.impact] ? r.scenario.impact : "HitChest";
        return {Head: "head", Body: "body", LeftArm: "armL", RightArm: "armR", LeftLeg: "legL", RightLeg: "legR"}[M.IMPACTS[impact].part];
    }

    // ------------------------------------------------------------------ ACE medical menu replica
    const ACE_DEFAULT_BLOOD = [[0, 0, 0, 1], [1, 0.95, 0.64, 1], [1, 0.87, 0.46, 1], [1, 0.8, 0.33, 1], [1, 0.72, 0.24, 1], [1, 0.63, 0.15, 1], [1, 0.54, 0.08, 1], [1, 0.43, 0.02, 1], [1, 0.3, 0, 1], [1, 0, 0, 1]];
    const ACE_DEFAULT_DAMAGE = [[0, 0, 0, 1], [0.75, 0.95, 1, 1], [0.62, 0.86, 1, 1], [0.54, 0.77, 1, 1], [0.48, 0.67, 1, 1], [0.42, 0.57, 1, 1], [0.37, 0.47, 1, 1], [0.31, 0.36, 1, 1], [0.22, 0.23, 1, 1], [0, 0, 1, 1]];
    const NONISSUE = [1, 1, 1, 0.33];
    const WOUND_NAMES = {
        Abrasion: ["Minor Scrape", "Medium Scrape", "Large Scrape"], Avulsion: ["Minor Avulsion", "Medium Avulsion", "Large Avulsion"],
        Contusion: ["Minor Bruise", "Medium Bruise", "Large Bruise"], Crush: ["Minor Crushed Tissue", "Medium Crushed Tissue", "Large Crushed Tissue"],
        Cut: ["Small Cut", "Medium Cut", "Large Cut"], Laceration: ["Small Tear", "Medium Tear", "Large Tear"],
        VelocityWound: ["Small Velocity Wound", "Medium Velocity Wound", "Large Velocity Wound"],
        PunctureWound: ["Minor Puncture Wound", "Medium Puncture Wound", "Large Puncture Wound"],
        ThermalBurn: ["Minor Thermal Burn", "Medium Thermal Burn", "Major Thermal Burn"],
    };
    function aceColor(kind, index) {
        const v = settingValue(`ace_medical_gui_${kind}Color_${index}`, settingDefaults());
        if (Array.isArray(v) && v.length >= 3) return v;
        return (kind === "bloodLoss" ? ACE_DEFAULT_BLOOD : ACE_DEFAULT_DAMAGE)[index];
    }
    function rgba(c) { return `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${c[3] === undefined ? 1 : c[3]})`; }
    function partBloodLoss(view, i) {
        return (view.openWounds[PART_KEYS[i]] || []).reduce((a, w) => a + w[1] * w[2], 0);
    }
    // fnc_updateBodyImage colour for one body part
    function bodyPartColor(view, i) {
        const s = settingDefaults();
        const v = (k) => settingValue(k, s);
        const loss = partBloodLoss(view, i);
        if (loss > 0) return aceColor("bloodLoss", Math.ceil(Math.min(1, Math.max(0, loss / 0.5)) * 9));
        let threshold = view.damageThreshold;
        const useLimbs = [false, !view.isPlayer, true][v("ace_medical_useLimbDamage")];
        if (i > 3) threshold = v("ace_medical_limbDamageThreshold") !== 0 && useLimbs ? threshold * v("ace_medical_limbDamageThreshold") : 0.3 * 4;
        else if (i > 1) threshold = v("ace_medical_limbDamageThreshold") !== 0 && useLimbs ? threshold * v("ace_medical_limbDamageThreshold") : 0.5 * 4;
        else if (i === 0) threshold *= 1.25;
        else threshold *= 1.5;
        const dmg = Math.min(1, view.bodyPartDamage[i] / Math.max(0.01, threshold));
        return aceColor("damage", Math.ceil(Math.min(1, Math.max(0, dmg / 0.8)) * 9));
    }
    // fnc_updateInjuryList
    function injuryList(view, part) {
        const s = settingDefaults();
        const v = (k) => settingValue(k, s);
        const out = [];
        if (view.bleeding > 0) {
            if (v("ace_medical_gui_showBleeding") === 1) {
                out.push(["Bleeding", [1, 0, 0, 1]]);
            } else if (v("ace_medical_gui_showBleeding") === 2) {
                const ratio = view.bleeding * v("ace_medical_bleedingCoefficient") / 0.5;  // bleed rate / knock-out rate at the same cardiac output
                out.push(ratio < 0.1 ? ["Slow bleeding", [1, 1, 0, 1]] : ratio < 0.5 ? ["Moderate bleeding", [1, 0.67, 0, 1]]
                    : ratio < 1 ? ["Severe bleeding", [1, 0.33, 0, 1]] : ["Massive bleeding", [1, 0, 0, 1]]);
            }
        } else {
            out.push(["No bleeding", NONISSUE]);
        }
        if (v("ace_medical_gui_showBloodlossEntry") !== false) {
            const bv = view.bloodVolume;
            const cls = bv < 3.6 ? 4 : bv < 4.2 ? 3 : bv < 5.1 ? 2 : bv < 6.0 ? 1 : 0;
            out.push([["No blood loss", "Lost some blood", "Lost a lot of blood", "Lost a large amount of blood", "Lost a fatal amount of blood"][cls],
                [NONISSUE, [1, 1, 0, 1], [1, 0.67, 0, 1], [1, 0.33, 0, 1], [1, 0, 0, 1]][cls]]);
        }
        out.push(["No IV", NONISSUE]);
        if (view.state === "ok") {
            const thr = v("ace_medical_painUnconsciousThreshold");
            out.push(view.pain > 0 ? [view.pain > thr ? "In severe pain" : view.pain > thr / 5 ? "In pain" : "In mild pain", [1, 1, 1, 1]] : ["No pain", NONISSUE]);
        }
        out.push(["", [1, 1, 1, 1]]);
        out.push([PART_NAMES[part], [1, 1, 1, 1]]);
        if (view.fractures[part] === 1) out.push(["Fractured", [1, 0, 0, 1]]);
        const classes = Object.keys(D.ace.wounds);
        const wounds = (view.openWounds[PART_KEYS[part]] || []).filter((w) => w[1] > 0);
        if (!wounds.length) out.push(["No injuries on this bodypart...", NONISSUE]);
        for (const w of wounds) {
            const cls = classes[Math.floor(w[0] / 10)];
            const category = w[0] % 10;
            const name = D.ace.woundNames?.[cls]?.[category] || WOUND_NAMES[cls]?.[category] || cls;
            out.push([w[1] >= 1 ? `${Math.ceil(w[1])}x ${name}` : `Partial ${name}`, [1, 1, 1, 1]]);
        }
        return out;
    }

    const LAYERS = {
        parts: ["head", "torso", "arm_left", "arm_right", "leg_left", "leg_right"],
        bones: [null, null, "arm_left_b", "arm_right_b", "leg_left_b", "leg_right_b"],
        select: ["head_s", "torso_s", "arm_left_s", "arm_right_s", "leg_left_s", "leg_right_s"],
    };
    const images = {};
    const alphaMaps = {};
    function aceImage(name, onload) {
        if (!ACE_IMG[name]) return null;
        if (!images[name]) {
            images[name] = new Image();
            images[name].onload = () => { alphaMaps[name] = null; onload(); };
            images[name].src = ACE_IMG[name];
        }
        return images[name].complete && images[name].naturalWidth ? images[name] : null;
    }
    function tinted(img, color) {
        const c = document.createElement("canvas");
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        x.globalCompositeOperation = "multiply";
        x.fillStyle = rgba(color);
        x.fillRect(0, 0, c.width, c.height);
        x.globalCompositeOperation = "destination-in";
        x.drawImage(img, 0, 0);
        return c;
    }
    function alphaAt(name, px, py) {
        const img = images[name];
        if (!img || !img.complete) return 0;
        if (!alphaMaps[name]) {
            const c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            const x = c.getContext("2d");
            x.drawImage(img, 0, 0);
            alphaMaps[name] = {w: c.width, data: x.getImageData(0, 0, c.width, c.height).data};
        }
        const m = alphaMaps[name];
        const i = (Math.floor(py) * m.w + Math.floor(px)) * 4 + 3;
        return m.data[i] || 0;
    }
    function drawAceBody(canvas, view, part) {
        const redraw = () => drawAceBody(canvas, view, part);
        const ctx = canvas.getContext("2d");
        canvas.width = 512; canvas.height = 512;
        ctx.clearRect(0, 0, 512, 512);
        const bg = aceImage("background", redraw);
        if (bg) ctx.drawImage(bg, 0, 0);
        LAYERS.parts.forEach((name, i) => {
            const img = aceImage(name, redraw);
            if (img) ctx.drawImage(tinted(img, bodyPartColor(view, i)), 0, 0);
        });
        LAYERS.bones.forEach((name, i) => {
            if (!name || view.fractures[i] !== 1) return;
            const img = aceImage(name, redraw);
            if (img) ctx.drawImage(tinted(img, [1, 0, 0, 1]), 0, 0);
        });
        const sel = aceImage(LAYERS.select[part], redraw);
        if (sel) ctx.drawImage(tinted(sel, settingValue("ace_medical_gui_bodyPartOutlineColor", settingDefaults()) || [1, 1, 1, 1]), 0, 0);
    }
    function defaultPart(view) {
        let best = 1, score = -1;
        for (let i = 0; i < 6; i++) {
            const sc = partBloodLoss(view, i) * 10 + view.bodyPartDamage[i] + (view.fractures[i] ? 5 : 0);
            if (sc > score) { score = sc; best = i; }
        }
        return best;
    }

    function renderMedical(r) {
        const view = r.view;
        const box = $("medical");
        box.textContent = "";
        const shots = r.burst.shots;
        const range = el("input", {type: "range", id: "inspectSlider", min: 1, max: shots, step: 1, value: String(view.shot), "aria-label": "Shot to inspect"});
        const num = el("input", {type: "number", id: "inspectShot", min: 1, max: shots, step: 1, value: String(view.shot)});
        const setShot = (v) => { state.inspect = Math.max(1, Math.min(shots, Number(v) || 1)); update(); };
        range.addEventListener("input", () => { num.value = range.value; setShot(range.value); });
        num.addEventListener("change", () => setShot(num.value));
        const auto = el("button", {type: "button", class: "plain", text: "Back to the down shot", disabled: !state.inspect, onclick: () => { state.inspect = 0; update(true); }});
        box.append(el("div", {class: "chain-head"}, [el("h2", {text: "Example burst · medical menu after shot " + view.shot}),
            el("div", {class: "inspect"}, [el("label", {for: "inspectShot", class: "hint", text: "Shot"}), num, range, auto])]));
        box.append(el("p", {class: "hint", style: "margin:6px 0 0",
            text: `One of the ${r.burst.runs} simulated bursts, picked because it went down closest to the median, replayed to shot ${view.shot} (${f(view.time, 1)} s after the first). It is an example, not an average. The blue line on the chart marks this shot; the slider moves both. Colours, wording and order follow ACE's medical menu with these settings. Click a body part.`}));
        const part = state.acePart >= 0 ? state.acePart : defaultPart(view);
        const canvas = el("canvas", {class: "ace-body", tabindex: 0, "aria-label": "Body status, click to select a body part"});
        canvas.addEventListener("click", (e) => {
            const rect = canvas.getBoundingClientRect();
            const px = (e.clientX - rect.left) / rect.width * 512, py = (e.clientY - rect.top) / rect.height * 512;
            for (let i = 0; i < 6; i++) {
                if (alphaAt(LAYERS.parts[i], px, py) > 20) { state.acePart = i; save(); renderMedical(lastResult); return; }
            }
        });
        canvas.addEventListener("keydown", (e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") { state.acePart = (part + 1) % 6; save(); renderMedical(lastResult); e.preventDefault(); }
            if (e.key === "ArrowLeft" || e.key === "ArrowUp") { state.acePart = (part + 5) % 6; save(); renderMedical(lastResult); e.preventDefault(); }
        });
        drawAceBody(canvas, view, part);
        const list = el("div", {class: "ace-list", role: "list"}, injuryList(view, part).map(([text, color]) =>
            el("div", {role: "listitem", style: `color:${rgba(color)}`, text: text || " "})));
        const who = r.scenario.isPlayer ? "Space Marine (player)" : "Space Marine (AI)";
        box.append(el("div", {class: "ace-menu"}, [
            el("div", {class: "ace-title", text: who}),
            el("div", {class: "ace-cols"}, [
                el("div", {class: "ace-status"}, [el("div", {class: "ace-head", style: "width:100%", text: "STATUS"}), canvas,
                    el("div", {class: "ace-part-pick", text: PART_NAMES[part]})]),
                el("div", {}, [el("div", {class: "ace-head", text: "OVERVIEW"}), list]),
            ]),
            el("div", {class: "ace-state", text: stateLine(view)}),
        ]));
    }
    function stateLine(view) {
        const label = {ok: "Conscious", unconscious: "Unconscious", cardiac: "Cardiac arrest", dead: "Dead"}[view.state];
        const bits = [`State: ${label}`, `blood ${f(view.bloodVolume, 2)} of 6 L`, `pain ${f(view.pain, 2)}`];
        if (view.plates) bits.push("plates " + ["head", "body", "armL", "armR", "legL", "legR"].map((z) => `${ZONES[z]} ${f(view.plates[z])}`).join(", "));
        return bits.join(" · ");
    }

    // ------------------------------------------------------------------ one shot
    function renderOneHit(r) {
        const st = r.stats;
        const box = $("onehit");
        box.textContent = "";
        box.append(el("h2", {text: "One shot on an unhurt target"}));
        const list = el("div", {});
        if (r.woundTable.length === 0) {
            list.append(el("p", {class: "empty", text: st.pHit === 0 ? "Every shot misses the body at this range and aim."
                : r.bco ? "No wound. The armor plate or Iron Halo absorbs the first hit; the chart shows when it gives way."
                : "No wound. The damage that reaches ACE is too small to create one."}));
        }
        for (const w of r.woundTable.slice(0, 8)) {
            list.append(el("div", {class: "wound-row"}, [
                el("span", {class: "pct", text: pct(w.chance)}),
                el("div", {}, [el("span", {class: "name", text: w.wound}), el("span", {class: "part", text: partName(w.part)}),
                    el("div", {class: "bar"}, el("span", {style: `width:${Math.round(w.chance * 100)}%`}))]),
            ]));
        }
        const zones = Object.entries(st.hitZones || {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([k, v]) => `${k.toLowerCase()} ${pct(v / Math.max(1e-9, st.samples))}`).join(", ");
        const facts = el("div", {class: "facts"}, [
            fact(pct(st.pHit), "shots that land on the body" + (zones ? `: ${zones}` : "")),
            fact(pct(st.pWound), "shots that wound"),
            fact(pct(st.pUnconscious), "down from one shot"),
            fact(pct(st.pFatal), "dead from one shot"),
            fact(f(st.meanPain, 2), "pain (0 to 1)"),
            fact(st.meanBleeding > 0 ? f(st.bleed.toClass3 / 60, 1) + " min" : "none", "bleeding to 30% blood loss, untreated at 80 bpm"),
            fact(pct(st.pFracture), "fracture"),
            fact(pct(st.pPneumothorax), "pneumothorax (KAT)"),
        ]);
        box.append(el("div", {class: "onehit-grid"}, [list, facts]));
    }
    function fact(v, l) { return el("div", {class: "fact"}, [el("div", {class: "v", text: v}), el("div", {class: "l", text: l})]); }

    // ------------------------------------------------------------------ chain with inline parameters
    function settingValue(key, defaults) {
        const own = Object.keys(state.settings).find((k) => k.toLowerCase() === key.toLowerCase());
        if (own !== undefined) return state.settings[own];
        return baseValue(key, defaults);
    }
    function baseValue(key, defaults) {
        return (defaults || settingDefaults()).lower[key.toLowerCase()];
    }
    function settingSource(key) {
        const server = !state.modDefaults && D.serverSettings && Object.keys(D.serverSettings).some((k) => k.toLowerCase() === key.toLowerCase());
        const s = D.settings[key] || D.settings[Object.keys(D.settings).find((k) => k.toLowerCase() === key.toLowerCase())];
        if (server) return "server setting" + (s ? ` · ${s.mod}` : "");
        return s ? `CBA setting · ${s.mod}` : (key.startsWith("engine_") ? "model assumption" : "ACE constant");
    }
    function param(spec) {
        const isSetting = spec.setting !== undefined;
        const defaults = settingDefaults();
        const base = isSetting ? (baseValue(spec.setting, defaults) ?? spec.base) : spec.base;
        const current = isSetting ? settingValue(spec.setting, defaults) : getPath(state.overrides, spec.path);
        const value = current === undefined ? base : current;
        const changed = current !== undefined && current !== base;
        const id = "p_" + (spec.setting || spec.path.join("_"));
        const commit = (v) => {
            if (isSetting) {
                const own = Object.keys(state.settings).find((k) => k.toLowerCase() === spec.setting.toLowerCase());
                if (own) delete state.settings[own];
                if (v !== base) state.settings[spec.setting] = v;
            } else {
                setPath(state.overrides, spec.path, v === base ? undefined : v);
            }
            if (spec.after) spec.after();
            update();
        };
        let control;
        if (spec.type === "bool") {
            control = el("input", {type: "checkbox", id: id});
            control.checked = Boolean(value);
            control.addEventListener("change", () => commit(control.checked));
        } else if (spec.options) {
            control = el("select", {id: id});
            for (const o of spec.options) {
                const opt = el("option", {value: String(o[0]), text: o[1]});
                if (String(o[0]) === String(value)) opt.selected = true;
                control.append(opt);
            }
            control.addEventListener("change", () => commit(typeof spec.options[0][0] === "number" ? Number(control.value) : control.value));
        } else {
            control = el("input", {type: "number", id: id, step: spec.step || "any", value: String(value ?? "")});
            control.addEventListener("change", () => {
                const v = control.value === "" ? base : Number(control.value);
                if (!Number.isNaN(v)) commit(v);
            });
        }
        const reset = changed ? el("button", {type: "button", class: "reset", text: "reset", "aria-label": "Reset " + spec.label, onclick: () => commit(base)}) : null;
        const src = spec.source || (isSetting ? settingSource(spec.setting) : "");
        return el("div", {class: "param" + (changed ? " changed" : "")}, [
            el("label", {for: id, text: spec.label}),
            el("div", {class: "ctl"}, [control, spec.unit ? el("span", {class: "hint", text: spec.unit}) : null, reset]),
            el("span", {class: "src", text: (changed ? `was ${fmtVal(base)} · ` : "") + src}),
        ]);
    }
    function fmtVal(v) { return typeof v === "number" ? f(v, 4) : String(v); }
    function getPath(obj, path) {
        let o = obj;
        for (const k of path) { if (o === undefined || o === null) return undefined; o = o[k]; }
        return o;
    }
    function setPath(obj, path, value) {
        let o = obj;
        for (let i = 0; i < path.length - 1; i++) { o[path[i]] = o[path[i]] || {}; o = o[path[i]]; }
        if (value === undefined) delete o[path[path.length - 1]];
        else o[path[path.length - 1]] = value;
    }
    function traceOf(r, stage) { return r.trace.filter((t) => t.stage === stage); }
    function step(title, opts) {
        return el("li", {}, [el("div", {}, [
            el("div", {class: "step-title"}, [title, opts.badge ? el("span", {class: "badge" + (opts.assume ? " assume" : ""), text: opts.badge}) : null]),
            opts.result ? el("div", {class: "step-result"}, [].concat(opts.result)) : null,
            opts.text ? el("p", {class: "step-text", text: opts.text}) : null,
            opts.params && opts.params.length ? el("div", {class: "params"}, opts.params) : null,
        ])]);
    }

    function renderChain(r) {
        const box = $("chain");
        box.textContent = "";
        box.append(el("div", {class: "chain-head"}, [el("h2", {text: `Why, step by step: shot ${r.traceHit}`}),
            el("span", {class: "hint", text: `Same example burst as the medical menu.` + (r.firstWoundHit ? ` First wound at shot ${r.firstWoundHit}.` : "")})]));
        box.append(el("p", {class: "hint", style: "margin:6px 0 0", text: "Edit any value in these steps and the whole page re-runs; changed values are listed under the headline. ENGINE ASSUMPTION marks steps where Arma's engine maths is closed source: they follow BI's documentation and carry scale values you can calibrate against an in-game test."}));
        const steps = el("ol", {class: "steps"});
        const items = [flightStep(r), landingStep(r)].concat(r.scenario.path === "bco" ? bcoSteps(r) : vanillaSteps(r)).concat(commonSteps(r));
        for (const it of items) if (it) steps.append(it);
        box.append(steps);
    }
    function ammoParams(r, keys, cls = r.scenario.ammo) {
        const a = D.ammo[cls];
        const labels = {hit: "Ammo hit", typicalSpeed: "Ammo typicalSpeed", caliber: "Ammo caliber", airFriction: "Ammo airFriction",
            indirectHit: "Ammo indirectHit", indirectHitRange: "Ammo indirectHitRange", explosive: "Ammo explosive"};
        return keys.map((k) => param({label: labels[k], path: ["ammoByClass", cls, k], base: a[k] || 0,
            source: `${cls} · ${(a.valueSource && a.valueSource[k]) || a.mod}`, unit: k === "typicalSpeed" ? "m/s" : ""}));
    }
    function flightStep(r) {
        const b = r.ballistics;
        const mg = D.magazines[r.scenario.magazineClass];
        const params = [];
        if (b.v0Rule !== "weapon initSpeed overrides magazine") {
            params.push(param({label: "Magazine initSpeed", path: ["magazineByClass", r.scenario.magazineClass, "initSpeed"], base: mg.initSpeed, unit: "m/s", source: `${r.scenario.magazineClass} · ${mg.mod}`}));
        }
        const fired = r.scenario.firedAmmo;
        params.push(...ammoParams(r, ["airFriction"], D.ammo[fired].simulation === "shotSubmunitions" ? r.scenario.ammo : fired));
        return step("Flight to target", {result: `v0 ${f(b.v0)} m/s (${b.v0Rule}) → ${f(b.v)} m/s at ${r.scenario.distance} m, ${f(b.time, 2)} s of flight`,
            text: b.powered ? "Rocket or missile: speed is taken as launch speed; motor thrust is not modelled."
                : `Speed falls as v0 × e^(airFriction × distance). ${r.scenario.path === "bco" ? "With the suit on, speed only matters for whether the round arrives." : "Direct engine damage levels off above the speed cap."}`,
            params: params});
    }
    function landingStep(r) {
        const g = traceOf(r, "geometry");
        if (!r.scenario.geometry) return g.length ? step("Where the round lands", {result: g.map((t) => t.text).join(" · ")}) : null;
        const s = r.scenario;
        const params = [
            param({label: "Hitpoint test", setting: "engine_hitpointTest", options: [["ray", "Sphere touches the shot line"], ["impact", "Sphere around the impact point"]]}),
            param({label: "Damage falls off inside the sphere", setting: "engine_hitpointFalloff", type: "bool"}),
            param({label: "Hitpoint radius multiplier", setting: "engine_hitpointRadiusScale", step: 0.05}),
            param({label: "Standing marine ceiling", setting: "engine_standingCeiling", unit: "game model m", step: 0.01}),
        ];
        if (s.path !== "bco") {
            params.push(param({label: "Speed loss after limb hit", setting: "engine_penLossLimb", unit: "m/s per m", step: 1}),
                param({label: "Torso hit stops the round", setting: "engine_torsoStops", type: "bool"}));
        }
        const spreadText = `weapon dispersion ${f(s.dispersion * 1000, 2)} mrad (${f(s.dispersion * s.distance * 100, 1)} cm at ${s.distance} m) + aim error ${f(s.spreadMrad, 1)} mrad`;
        return step("Where the round lands", {badge: "engine assumption", assume: true,
            result: [spreadText, el("br"), g.map((t) => t.text).join(" · ") || "no shot"],
            text: "Shots spread uniformly over the dispersion disk plus normal aim error. " + (s.path === "bco"
                ? "Black Carapace uses the first fire-geometry face."
                : "Each entry tests its hitpoint spheres. A direct head selection also hits face, neck and head at full strength. Limb hits let the round continue at reduced speed; torso hits stop it by default."),
            params: params});
    }
    function vanillaSteps(r) {
        const out = [];
        const eng = traceOf(r, "engine");
        const direct = eng.find((t) => t.detail && t.detail.entry);
        const a = D.ammo[r.scenario.ammo];
        if (direct) {
            const e = direct.detail.entry;
            const ar = e.armor;
            const hpName = e.hitpoint;
            const loadout = currentLoadout();
            const unitClass = currentUnitClass();
            const unit = D.gear.units[unitClass];
            const hp = unit.hitpoints[hpName] || {armor: 1};
            const lines = [
                `At ${f(direct.detail.v)} m/s: hit ${f(a.hit)} × speed factor ${f(direct.detail.speedFactor, 3)} = ${f(direct.detail.hitEff, 2)}`,
                el("br"), `engine armor on ${hpName} = unit ${f(unit.armor)} × hitpoint ${f(hp.armor)} + vest ${f(ar.vest.raw ?? 0)} + helmet ${f(ar.helmet.raw ?? 0)} = ${f(ar.engine)}`,
                el("br"), `HandleDamage receives ${f(e.newDamage, 4)}` + (e.minimalHitBlocked ? " (below minimalHit, dropped)" : ""),
            ];
            const vestBase = D.gear.vests[loadout.vest]?.protection?.[hpName];
            const helmBase = D.gear.helmets[loadout.helmet]?.protection?.[hpName];
            const params = ammoParams(r, ["hit", "typicalSpeed"]).concat([
                param({label: "Unit armor", path: ["unit", "armor"], base: unit.armor, source: `${unitClass} · ${unit.mod}`}),
                param({label: `${hpName} armor`, path: ["unitHitpoint", hpName, "armor"], base: hp.armor, source: "unit HitPoints"}),
            ]);
            if (loadout.vest) params.push(param({label: `Vest armor on ${hpName}`, path: ["vest", hpName, "armor"], base: vestBase ? vestBase.armor : 0,
                source: vestBase ? `${loadout.vest} · ${vestBase.source || ""}` : "vest does not cover this hitpoint"}));
            if (loadout.helmet) params.push(param({label: `Helmet armor on ${hpName}`, path: ["helmet", hpName, "armor"], base: helmBase ? helmBase.armor : 0,
                source: helmBase ? `${loadout.helmet} · ${helmBase.source || ""}` : "helmet does not cover this hitpoint"}));
            params.push(param({label: "Engine damage scale", setting: "engine_damageScale", step: 0.01}),
                param({label: "Speed cap (fraction of typicalSpeed)", setting: "engine_speedCapRatio", step: 0.01}),
                param({label: "Speed exponent", setting: "engine_speedExponent", step: 0.05}));
            out.push(step("Engine hitpoint damage", {badge: "engine assumption", assume: true, result: lines,
                text: "Each impact uses hit × speed factor × damage scale ÷ summed armor. The defaults come from a pooled fit of three CTR Bolt Round / WB Mk 4 runs.",
                params: params}));
            const hd = traceOf(r, "handleDamage").find((t) => t.detail);
            const top = hd && hd.detail ? hd.detail.allDamages[0] : null;
            const aceLines = [`ACE armor = uniform ${f(ar.uniform.armor)} + vest ${f(ar.vest.armor)}${ar.vest.scaled ? ` (${f(ar.vest.raw)} log-scaled)` : ""} + helmet ${f(ar.helmet.armor)}${ar.helmet.scaled ? ` (${f(ar.helmet.raw)} log-scaled)` : ""} = ${f(ar.ace, 1)}`];
            if (top) aceLines.push(el("br"), `real damage ${f(top[2], 3)} on ${partName(top[1])} (engine ${f(top[0], 4)} × ${f(ar.ace, 1)})`);
            const ptParams = [];
            if (vestBase) ptParams.push(param({label: "Vest passThrough", path: ["vest", hpName, "passThrough"], base: vestBase.passThrough, step: 0.05, source: "vest HitpointsProtectionInfo"}));
            if (helmBase) ptParams.push(param({label: "Helmet passThrough", path: ["helmet", hpName, "passThrough"], base: helmBase.passThrough, step: 0.05, source: "helmet HitpointsProtectionInfo"}));
            out.push(step("ACE reads the armor and picks the body part", {result: aceLines,
                text: ar.vest.scaled || ar.helmet.scaled
                    ? "ACE caps very high item armor with log10(armor ÷ passThrough^k) × 10, so its armor is lower than the engine's. With armor penetration on, that gap makes ACE underestimate impact speed."
                    : "ACE multiplies the engine damage back by its own armor sum to find which body part took the hit.",
                params: ptParams}));
        } else if (eng.length && !eng[0].text.startsWith("blast")) {
            out.push(step("Engine hitpoint damage", {badge: "engine assumption", assume: true, result: eng[0].text}));
        }
        const blast = eng.find((t) => t.text.startsWith("blast"));
        if (blast) {
            const splashOnly = r.scenario.impact === "Blast";
            out.push(step(splashOnly ? "Blast on every hitpoint" : "Blast from the same round", {badge: "engine assumption", assume: true,
                result: blast.text,
                text: splashOnly ? "Blast-only damage falls to zero at indirectHitRange times the falloff endpoint."
                    : "The final impact keeps the larger of the direct and splash damage at each hitpoint before ACE processes it.",
                params: [...ammoParams(r, ["indirectHit", "indirectHitRange", "explosive"]), ...(splashOnly
                    ? [param({label: "Blast falloff endpoint (fraction of indirectHitRange)", setting: "engine_blastFalloffEnd", step: 0.1})] : [])]}));
        }
        out.push(handlerStep(r));
        const pen = traceOf(r, "armorPen");
        const penOn = settingValue("ace_medical_alternateArmorPenetration");
        const d = pen.length ? pen[0].detail : null;
        out.push(step("ACE armor penetration", {
            result: d ? [`ACE estimates an impact speed of ${f(d.impactSpeed)} m/s`, el("br"),
                `armor ${f(d.armor, 1)} → level ${d.level}, plate ${d.thickness} mm RHA`, el("br"),
                `penetration ${f(a.caliber)} × 0.015 × ${f(d.impactSpeed)} = ${f(d.penDepth, 1)} → ${pct(Math.min(1, d.penRatio))} of the plate`, el("br"),
                `damage = ${f(a.hit)} × ${f(Math.min(1, d.penRatio), 3)} ÷ 10 = ${f(d.finalDamage, 3)}`]
                : (pen.length ? pen[0].text : penOn ? "not reached on this shot" : "off in these settings: the engine damage goes to the wound step unchanged"),
            text: penOn ? "When on, this replaces the engine damage for bullets: it guesses impact speed from real damage ÷ hit, then compares caliber × speed with the plate." : "",
            params: ammoParams(r, ["caliber"]).concat([param({label: "Armor penetration on", setting: "ace_medical_alternateArmorPenetration", type: "bool"})]),
        }));
        return out;
    }
    function handlerStep(r) {
        const ev = traceOf(r, "event").find((t) => t.text.startsWith("woundReceived"));
        if (!ev) return null;
        return step("ACE damage type and wound handlers", {result: ev.text.replace("woundReceived: ", ""),
            text: "Handlers run in reverse config order. Black Carapace's handler only acts on scripted damage while the suit is on; KAT's rolls chest injuries without changing wounds."});
    }
    function bcoSteps(r) {
        const out = [];
        const a = D.ammo[r.scenario.ammo];
        const bt = traceOf(r, "bco");
        const before = r.tracePlatesBefore || r.bco.plates;
        const base = baseBco();
        out.push(step("Black Carapace catches the hit", {result: `damage = round(hit ${f(a.hit)}) = ${Math.round(a.hit)}`,
            text: "The suit sets allowDamage false, so the engine and ACE HandleDamage never run for real projectiles. Its HitPart handler uses the config hit as is.",
            params: ammoParams(r, ["hit"]).concat(state.impact === "Blast" ? ammoParams(r, ["indirectHit", "explosive"]) : [])}));
        if (state.halo !== "none") {
            out.push(step("Iron Halo", {result: `shield ${f(before.shield ?? r.bco.shield)} of ${f(r.bco.shield)}`,
                text: (bt.find((t) => t.text.startsWith("Iron Halo")) || {text: "The shield takes the hit first."}).text,
                params: [param({label: "Shield strength", path: ["bco", "shield"], base: r.bco.shield, source: "CBA setting · Iron Halo tier"})]}));
        }
        if (state.impact !== "Blast") {
            const plateNote = bt.filter((t) => / plate |head hit/.test(t.text)).map((t) => t.text).join(" ");
            const zoneMatch = /^(\w+) plate/.exec(plateNote);
            const zone = zoneMatch && ZONES[zoneMatch[1]] ? zoneMatch[1] : zoneKey(r);
            out.push(step(`${capital(ZONES[zone])} plate`, {result: `before this shot: ${f(before[zone])} of ${f(r.bco.plates[zone])}`,
                text: plateNote || "The round missed.",
                params: [
                    param({label: `${capital(ZONES[zone])} plate`, path: ["bco", "plates", zone], base: base.plates[zone], source: `CBA setting · ${r.bco.tier || "fallback"}`}),
                    param({label: "Damage threshold", path: ["bco", "threshold"], base: base.threshold, source: "CBA setting · per armor tier"}),
                ]}));
            const blast = bt.find((t) => t.text.startsWith("blast (same round)"));
            if (blast) out.push(step("Blast from the same round", {result: blast.text}));
        } else {
            out.push(step("Blast on every hitpoint", {result: (bt.find((t) => t.text.startsWith("blast")) || {text: ""}).text,
                text: "HitPart reports the full config indirectHit for any blast hit that reaches the target."}));
        }
        const rest = bt.find((t) => t.text.startsWith("rest "));
        out.push(step("Damage that reaches ACE", {result: rest ? rest.text : "nothing: the plate held",
            text: "Overflow up to 80 becomes overflow ÷ 25 as \"bullet\" damage on the hit part. Above 80, six coin flips each add overflow ÷ 75 as \"explosion\" damage to a random head, torso or arm.",
            params: [param({label: "Damage modifier", path: ["bco", "modifier"], base: base.modifier, step: 0.05, source: "CBA setting · per armor tier"})]}));
        out.push(handlerStep(r));
        return out;
    }
    function baseBco() {
        const p = M.prepare(dataForRun(), scenario({overrides: undefined, mode: "bco", geometry: null}));
        return p.bco || {plates: {}, threshold: 0, modifier: 1};
    }
    function commonSteps(r) {
        const out = [];
        const base = traceOf(r, "base");
        const chips = r.traceWounds.map((w) => el("span", {class: "wound-chip"},
            `${M.woundLabel(w, D)} on ${partName(w.part)} (damage ${f(w.damage, 2)}, bleeding ${f(w.bleeding, 3)}${w.effect ? ", " + w.effect : ""})`));
        out.push(step("Wounds", {result: base.map((t) => t.text).join(" · ") || "no wound event on this shot",
            params: chips.length ? [el("div", {style: "grid-column: 1 / -1"}, chips)] : []}));
        out.push(step("Chest injuries (KAT)", {result: settingValue("kat_breathing_enable") ? `pneumothorax on ${pct(r.stats.pPneumothorax)} of single shots, deep penetrating injury on ${pct(r.stats.pDeepPenetrating)}` : "off in these settings",
            text: "Torso hits with at least the threshold of damage roll the chance; more damage raises it by up to 30 points.",
            params: [
                param({label: "KAT breathing on", setting: "kat_breathing_enable", type: "bool"}),
                param({label: "Pneumothorax chance", setting: "kat_breathing_pneumothoraxChance", unit: "%"}),
                param({label: "Damage threshold", setting: "kat_breathing_pneumothoraxDamageThreshold", step: 0.05}),
                param({label: "Deep injury chance", setting: "kat_breathing_deepPenetratingInjuryChance", unit: "%"}),
            ]}));
        const st = traceOf(r, "state").map((t) => t.text);
        const tu = r.traceUnit;
        const ai = !r.scenario.isPlayer;
        const fatalOptions = M.FATAL_INJURY_LABELS.map((l, i) => [i, l]);
        out.push(step("Unconscious, cardiac arrest or dead", {
            result: [`after this shot: ${tu.state}, pain ${f(tu.pain, 2)}, head ${f(tu.bodyPartDamage[0], 2)}, torso ${f(tu.bodyPartDamage[1], 2)}`, el("br"),
                st.length ? st.join(" · ") : "no state change on this shot"],
            text: "Unconscious when head damage passes half the damage threshold, penetrating torso damage passes it, or a pain roll hits. Fatal checks run per wound: a heavy headshot, a 5% heart shot, or summed trauma on a Weibull curve. Players only raise a fatal injury on a death-chance roll; AI always do. A fatal injury kills, or sends to cardiac arrest, depending on the fatal injuries setting.",
            params: (ai ? [
                param({label: "AI damage threshold", setting: "ace_medical_AIDamageThreshold", step: 0.1}),
                param({label: "AI can go unconscious", setting: "ace_medical_statemachine_AIUnconsciousness", type: "bool"}),
                param({label: "Fatal injuries (AI)", setting: "ace_medical_statemachine_fatalInjuriesAI", options: fatalOptions}),
            ] : [
                param({label: "Player damage threshold", setting: "ace_medical_playerDamageThreshold", step: 0.1}),
                param({label: "Death chance (players)", setting: "ace_medical_deathChance", step: 0.05}),
                param({label: "Fatal injuries (player)", setting: "ace_medical_statemachine_fatalInjuriesPlayer", options: fatalOptions}),
            ]).concat([
                param({label: "Fatal damage source", setting: "ace_medical_fatalDamageSource", options: [[0, "Vital shots only"], [1, "Sum of trauma"], [2, "Either"]]}),
                param({label: "Pain unconscious threshold", setting: "ace_medical_painUnconsciousThreshold", step: 0.05}),
                param({label: "Pain unconscious chance", setting: "ace_medical_painUnconsciousChance", step: 0.05}),
                param({label: "Pain coefficient", setting: "ace_medical_painCoefficient", step: 0.1}),
                param({label: "Fracture chance", setting: "ace_medical_fractureChance", step: 0.05}),
                param({label: "Bleeding coefficient", setting: "ace_medical_bleedingCoefficient", step: 0.1}),
            ])}));
        return out;
    }

    // ------------------------------------------------------------------ sources and import
    function renderSources(r) {
        const box = $("sources");
        box.textContent = "";
        const changed = Object.keys(state.settings).length + countLeaves(state.overrides);
        const unknown = Object.entries(r.unknownHandlers);
        const notModelled = Object.entries(D.damageScriptMods || {});
        const serverCount = Object.keys(D.serverSettings || {}).length;
        box.append(el("h2", {text: "Data and settings"}));
        box.append(el("p", {text: `Configs merged from ${D.mods.length} mods of the ${D.preset.replace(".preset2", "")} preset plus Arma 3, extracted ${D.generated}. ` +
            `${new Set(D.skippedPbos.filter((p) => !p.reason.startsWith("skipWhen")).map((p) => p.pbo.split("\\")[0])).size} PBOs had a config that could not be read (voice packs, terrains, UI mods); ` +
            `${D.skippedPbos.filter((p) => p.reason.startsWith("skipWhen")).length} optional compatibility addons switch themselves off because their target mod is not loaded.`}));
        box.append(el("p", {text: D.baced
            ? `BACED addons: ${D.baced.loaded.length} loaded (built ${D.baced.built}), ${D.baced.skipped.length} skipped because their mod is not in the preset`
            : "BACED addons not loaded: run hemtt build, then extract.py"}));
        if (serverCount) {
            const pick = el("div", {class: "seg", role: "radiogroup", "aria-label": "Settings base"}, [
                el("input", {type: "radio", name: "base", id: "baseServer", checked: !state.modDefaults}), el("label", {for: "baseServer", text: `Server settings (${serverCount} values)`}),
                el("input", {type: "radio", name: "base", id: "baseMod", checked: state.modDefaults}), el("label", {for: "baseMod", text: "Mod defaults"}),
            ]);
            pick.querySelector("#baseServer").addEventListener("change", () => { state.modDefaults = false; renderTarget(); renderBco(); update(true); });
            pick.querySelector("#baseMod").addEventListener("change", () => { state.modDefaults = true; renderTarget(); renderBco(); update(true); });
            box.append(el("div", {class: "field"}, [el("span", {class: "label", text: "Values every step starts from"}), pick]));
        }
        if (unknown.length) box.append(el("p", {class: "err", text: "Wound handlers not modelled, passed through unchanged: " + unknown.map(([k, v]) => `${k} (${v})`).join(", ")}));
        box.append(el("details", {}, [el("summary", {text: `Mods with their own damage scripts (${notModelled.length}); modelled: Black Carapace, KAT, ACE`}),
            el("ul", {}, notModelled.map(([mod, kinds]) => el("li", {text: `${mod}: ${kinds.join(", ")}`})))]));
        const area = el("textarea", {id: "cbaImport", placeholder: "force ace_medical_playerDamageThreshold = 3;\nforce HOV_MK7_BODY_ARMOR = 800;", "aria-label": "cba_settings.sqf contents"});
        const msg = el("span", {class: "hint", id: "importMsg"});
        const apply = el("button", {type: "button", class: "plain", text: "Apply settings", onclick: () => {
            const parsed = parseCba(area.value);
            const n = Object.keys(parsed).length;
            Object.assign(state.settings, parsed);
            msg.textContent = n ? `Applied ${n} settings.` : "No `name = value;` lines found.";
            renderTarget(); renderBco(); update(true);
        }});
        const resetAll = changed > 0 && el("button", {type: "button", class: "plain", text: `Reset ${changed} changed values`, onclick: resetChangedValues});
        box.append(el("div", {class: "field"}, [el("label", {for: "cbaImport", text: "Paste another cba_settings.sqf (Addon Options → Export) to apply its values on top"}), area,
            el("div", {class: "toolbar"}, [apply, resetAll, msg])]));
        box.append(el("p", {class: "hint", text: "The same model runs from the command line for scripts and agents: node tools/damage_sim/sim.js run --weapon BT_TyrianBolter --distance 100 --trace"}));
    }
    function countLeaves(o) {
        let n = 0;
        for (const v of Object.values(o || {})) n += v && typeof v === "object" ? countLeaves(v) : 1;
        return n;
    }
    function parseCba(text) {
        const out = {};
        const re = /^\s*(?:force\s+)*(\w+)\s*=\s*(.+?);\s*$/gim;
        let m;
        while ((m = re.exec(text))) {
            let v = m[2].trim();
            if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/""/g, "\"");
            else if (v === "true" || v === "false") v = v === "true";
            else if (/^\[.*\]$/.test(v)) { try { v = JSON.parse(v); } catch (e) { /* keep text */ } }
            else if (!Number.isNaN(Number(v))) v = Number(v);
            out[m[1]] = v;
        }
        return out;
    }

    // ------------------------------------------------------------------ wiring
    function wire() {
        $("meta").textContent = `${D.preset.replace(".preset2", "")} preset · ${D.mods.length} mods · extracted ${D.generated}`;
        const refreshTarget = () => { renderTarget(); renderBco(); renderAimControls(); update(); };
        const clearArmorOverrides = (resetInspect = true) => {
            for (const key of ["unit", "unitHitpoint", "vest", "helmet", "bco"]) delete state.overrides[key];
            if (resetInspect) state.inspect = 0;
        };
        for (const id of ["targetPlayer", "targetAi"]) $(id).addEventListener("change", (e) => {
            state.target = e.target.value;
            clearArmorOverrides();
            refreshTarget();
        });
        $("targetStance").addEventListener("change", (e) => {
            state.target_stance = e.target.value;
            state.inspect = 0;
            update();
        });
        const browse = (changed) => {
            const previous = state.aiUnit;
            renderAiPicker(changed);
            if (state.aiUnit !== previous) {
                clearArmorOverrides();
                refreshTarget();
            } else save();
        };
        for (const id of ["browseUnits", "browseGroups"]) $(id).addEventListener("change", (e) => {
            state.aiBrowse = e.target.value;
            browse();
        });
        for (const id of AI_SELECTS) $(id).addEventListener("change", () => browse(id));
        $("aiFilter").addEventListener("input", (e) => { state.aiFilter = e.target.value; browse(); });
        $("weaponFilter").addEventListener("input", renderWeaponList);
        $("weapon").addEventListener("change", () => {
            state.weapon = $("weapon").value;
            state.muzzle = ""; state.fireMode = ""; state.magazine = ""; state.inspect = 0;
            renderMuzzleAndMags(); renderWeaponList(); update();
        });
        $("muzzle").addEventListener("change", () => { state.muzzle = $("muzzle").value; state.magazine = ""; state.fireMode = ""; renderMuzzleAndMags(); update(); });
        $("fireMode").addEventListener("change", () => { state.fireMode = $("fireMode").value; renderMagHint(); update(); });
        $("magazine").addEventListener("change", () => { state.magazine = $("magazine").value; state.inspect = 0; renderMagHint(); update(); });
        const setDistance = (v) => {
            state.distance = Math.max(0, Number(v) || 0);
            $("distance").value = String(state.distance);
            $("distanceSlider").value = String(Math.min(1500, state.distance));
            update();
        };
        $("distance").addEventListener("change", () => setDistance($("distance").value));
        $("distanceSlider").addEventListener("input", () => setDistance($("distanceSlider").value));
        const setMags = (v) => {
            state.magazines = Math.max(1, Math.min(20, Math.round(Number(v) || 1)));
            $("magazines").value = String(state.magazines);
            $("magazinesSlider").value = String(Math.min(10, state.magazines));
            state.inspect = 0;
            renderMagHint(); update();
        };
        $("magazines").addEventListener("change", () => setMags($("magazines").value));
        $("magazinesSlider").addEventListener("input", () => setMags($("magazinesSlider").value));
        $("spread").addEventListener("change", () => { state.spread = Math.max(0, Number($("spread").value) || 0); update(); });
        $("aimPreset").addEventListener("change", () => {
            const v = $("aimPreset").value;
            if (v === "custom") return;
            state.impact = v; state.aim = null; state.inspect = 0; renderAimControls(); update();
        });
        $("blastBtn").addEventListener("click", () => { state.impact = "Blast"; state.aim = null; state.inspect = 0; renderAimControls(); update(); });
        $("blastDistance").addEventListener("change", (e) => {
            state.blastDistance = Math.max(0, Number(e.target.value) || 0);
            e.target.value = String(state.blastDistance);
            update();
        });
        const canvas = $("aimCanvas");
        canvas.addEventListener("click", (e) => {
            if (!G) return;
            const rect = canvas.getBoundingClientRect();
            state.aim = fromPx((e.clientX - rect.left) / rect.width * G.width, (e.clientY - rect.top) / rect.height * G.height);
            if (state.impact === "Blast") state.impact = "HitChest";
            state.inspect = 0;
            renderAimControls(); update();
        });
        canvas.addEventListener("keydown", (e) => {
            const d = {ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, 0.05], ArrowDown: [0, -0.05]}[e.key];
            if (!d || !G) return;
            e.preventDefault();
            const aim = state.aim || hpCentre(state.impact === "Blast" ? "HitChest" : state.impact);
            state.aim = {x: aim.x + d[0], y: aim.y + d[1]};
            if (state.impact === "Blast") state.impact = "HitChest";
            renderAimControls(); update();
        });
        for (const z of document.querySelectorAll(".zone")) {
            const pickZone = () => { state.impact = z.dataset.hp; state.aim = null; renderAimControls(); update(); };
            z.addEventListener("click", pickZone);
            z.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickZone(); } });
        }
        for (const g of GEAR) {
            $(g.key + "Filter").addEventListener("input", () => renderGear(g.key));
            $(g.key).addEventListener("change", () => { state.loadout[g.key] = $(g.key).value; clearArmorOverrides(false); renderBco(); renderAimControls(); update(); });
        }
        $("bcoOn").addEventListener("change", () => { state.bco = "on"; state.inspect = 0; renderBco(); update(); });
        $("bcoOff").addEventListener("change", () => { state.bco = "off"; state.inspect = 0; renderBco(); update(); });
        $("halo").addEventListener("change", () => { state.halo = $("halo").value; update(); });
        $("tabSingle").addEventListener("click", () => setTab("single"));
        $("tabBalance").addEventListener("click", () => setTab("balance"));
        for (const id of ["tabSingle", "tabBalance"]) $(id).addEventListener("keydown", (e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            const next = id === "tabSingle" ? "tabBalance" : "tabSingle";
            $(next).focus();
            setTab(next === "tabSingle" ? "single" : "balance");
        });
        window.addEventListener("resize", () => drawAim());
    }

    // ------------------------------------------------------------------ tabs
    function setTab(tab) {
        state.tab = tab;
        renderTab();
        renderAimLegend();
        drawAim();
        update(true);
    }
    function renderTab() {
        const balance = state.tab === "balance";
        document.body.classList.toggle("tab-balance", balance);
        $("tabSingle").setAttribute("aria-selected", String(!balance));
        $("tabBalance").setAttribute("aria-selected", String(balance));
        $("tabSingle").tabIndex = balance ? -1 : 0;
        $("tabBalance").tabIndex = balance ? 0 : -1;
        $("balance").hidden = !balance;
    }
    // Weapon balancing (balance.js) opens a point here
    function openSingle(weapon, muzzle, magazine) {
        state.weapon = weapon; state.muzzle = muzzle; state.magazine = magazine; state.fireMode = "";
        state.inspect = 0;
        $("weaponFilter").value = "";
        renderWeaponList(); renderMuzzleAndMags();
        setTab("single");
        window.scrollTo({top: 0});
    }
    window.WoundBench = {
        state: state, save: save, update: update, scenario: scenario, resetChangedValues: resetChangedValues,
        dataForRun: dataForRun, el: el, svg: svg, openSingle: openSingle, geometry: G, balance: null,
    };

    function init() {
        wire();
        renderTab();
        renderWeaponList();
        renderMuzzleAndMags();
        for (const g of GEAR) renderGear(g.key);
        $("aiFilter").value = state.aiFilter;
        renderAiPicker();
        $("distance").value = String(state.distance);
        $("distanceSlider").value = String(Math.min(1500, state.distance));
        $("magazines").value = String(state.magazines);
        $("magazinesSlider").value = String(Math.min(10, state.magazines));
        $("spread").value = String(state.spread);
        $("blastDistance").value = String(state.blastDistance);
        renderTarget();
        renderAimControls();
        renderBco();
        run();
    }
    init();
})();
