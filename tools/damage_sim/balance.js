/*
 * Weapon balancing tab: every cert and relic weapon (and optionally other 40k mods) as one scatter plot,
 * Median time to down against consistency, magazine use, or acquisition tier.
 * The target, aim and armor come from the page's left column (app.js); data/roster.js lists the weapons.
 */
(function () {
    "use strict";
    const WB = window.WoundBench;
    const M = window.DamageModel;
    const D = window.GAME_DATA;
    const R = window.ROSTER || {classes: {}, unmatched: [], otherMods: [], certs: {}};
    if (!WB) return;
    const {buildCerts, buildPoints, rankMods, GENERATIONS, RELIQUARY, BALANCE_COLUMNS, balanceRow, balanceCsv} = window.BalancePoints;
    const {el, svg, state} = WB;
    const $ = (id) => document.getElementById(id);
    const B = state.balance;

    const RUNS = 100;                 // bursts per point: enough for a stable median, fast enough to redo live
    const MAX_SHOTS = 600;            // same cap as the single weapon view
    const MAX_WORKERS = 4;
    const SLICE_MS = 25;              // main-thread fallback: yield this often
    const REDRAW_MS = 250;            // redraw while points arrive
    const PICK_RADIUS = 14;           // px: hover/tap target, larger than the mark
    const MARK_R = 5.5;               // marks >= 8 px across
    const ZOOM_STEP = 1.25;
    const MIN_CHART_H = 380;          // phones: keep the plot tall enough to read
    const SLOTS = 7;                  // validated categorical slots (--s1..--s7)
    const TIME_TICKS = [0, 0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
    const Y_LABELS = {consistency: "Consistency", magazines: "Magazines to down", acquisition: "Acquisition tier"};
    const yChoice = () => Object.hasOwn(Y_LABELS, B.yAxis) ? B.yAxis : "consistency";
    const tx = (t) => B.logTime ? Math.log10(1 + t) : t;

    const SHAPES = {Firstborn: "circle", Primaris: "diamond", Reliquary: "triangle", mixed: "circle"};
    const ACQUISITION = {default: "Default (free)", earnable: "Earnable (3 Ceramite)", relic: "Relic (3 Gold)"};
    const TIERS = ["default", "earnable", "relic"];
    const certKey = (m) => m.cert === RELIQUARY ? RELIQUARY : `${m.generation}:${m.cert}`;

    // ------------------------------------------------------------------ certs and colours
    const certs = buildCerts(R).map((c) => ({...c, color: c.gen === RELIQUARY ? "var(--ink)" : `var(--s${(c.index % SLOTS) + 1})`}));
    const certByKey = Object.fromEntries(certs.map((c) => [c.key, c]));
    let POINTS = [];

    // Other mods: the most frequent get a slot each, the rest share a muted ring
    let topMods = [], modColor = {};
    const OTHER_MODS_KEY = "mod:*";
    const modKey = (mod) => (topMods.indexOf(mod) < SLOTS ? `mod:${mod}` : OTHER_MODS_KEY);

    // ------------------------------------------------------------------ results and the job queue
    const cache = new Map();          // scenario key + point id -> shotsToKill result (or {error})
    let queue = [];
    let currentKey = "";
    let editedClasses = [];
    let pool = null;                  // null until tried; [] when workers are unavailable
    let fallbackTimer = 0;
    let redrawTimer = 0;

    function baseScenario() {
        // Keep shared inputs such as woundSet in the scenario used for the cache key.
        const s = WB.scenario({
            weapon: undefined, muzzle: undefined, magazine: undefined, fireMode: undefined, magazines: 1,
            compareArmorPen: false, traceHit: undefined, viewShot: undefined, samples: undefined,
            outcome: B.outcome, assumedReload: Math.max(0, Number(B.reload) || 0), runs: RUNS, maxShots: MAX_SHOTS, seed: 7,
        });
        delete s.geometry;
        return s;
    }
    function visibleCandidates() {
        return POINTS.filter((p) => p.roster || B.otherMods);
    }
    function schedule() {
        const base = baseScenario();
        const key = JSON.stringify([base, state.modDefaults]);
        if (key !== currentKey) {
            const overrides = base.overrides || {};
            editedClasses = [...new Set([...Object.keys(overrides.ammoByClass || {}), ...Object.keys(overrides.magazineByClass || {})])].sort();
            POINTS = buildPoints(D, R, overrides);
            topMods = rankMods(POINTS);
            modColor = Object.fromEntries(topMods.map((mod, i) => [mod, i < SLOTS ? `var(--s${i + 1})` : "var(--ink-3)"]));
            currentKey = key;
        }
        queue = visibleCandidates().filter((p) => !cache.has(currentKey + "#" + p.id))
            .map((p) => ({key: currentKey, point: p, scenario: Object.assign({}, base, {weapon: p.weapon, muzzle: p.muzzle, magazine: p.magazine})}));
        startPool();
        pump();
        render();
    }
    function store(job, result) {
        cache.set(job.key + "#" + job.point.id, result);
        if (job.key === currentKey && !redrawTimer) redrawTimer = setTimeout(() => { redrawTimer = 0; render(); }, REDRAW_MS);
    }
    function runHere(job) {
        try {
            store(job, M.shotsToKill(WB.dataForRun(), Object.assign({}, job.scenario, {geometry: WB.geometry})));
        } catch (err) {
            store(job, {error: err.message});
        }
    }

    // Blob worker that loads the model and data from the page's own files; file:// and strict hosts refuse it
    function startPool() {
        if (pool !== null) return;
        pool = [];
        const base = document.baseURI;
        const urls = ["damage_model.js", "data/page_data.js", "data/body_geometry.js"].map((u) => new URL(u, base).href);
        const source = `self.window = self;
            let ready = false, data = null, modData = null;
            self.onmessage = (e) => {
                const m = e.data;
                if (m.type === "init") {
                    try {
                        importScripts(m.urls[0], m.urls[1]);
                        try { importScripts(m.urls[2]); } catch (err) { /* body figure is optional */ }
                        data = self.GAME_DATA; modData = Object.assign({}, data, {serverSettings: {}});
                        ready = true; postMessage({type: "ready"});
                    } catch (err) { postMessage({type: "failed", error: String(err)}); }
                    return;
                }
                try {
                    const sc = Object.assign({}, m.scenario, {geometry: self.BODY_GEOMETRY || null});
                    postMessage({type: "result", id: m.id, result: self.DamageModel.shotsToKill(m.modDefaults ? modData : data, sc)});
                } catch (err) { postMessage({type: "result", id: m.id, result: {error: String(err.message || err)}}); }
            };`;
        let url;
        try {
            url = URL.createObjectURL(new Blob([source], {type: "text/javascript"}));
        } catch (err) {
            return;
        }
        const count = Math.max(1, Math.min(MAX_WORKERS, (navigator.hardwareConcurrency || 2) - 1));
        for (let i = 0; i < count; i++) {
            let worker;
            try { worker = new Worker(url); } catch (err) { break; }
            const slot = {worker: worker, ready: false, job: null, seq: 0};
            worker.onmessage = (e) => {
                const m = e.data;
                if (m.type === "ready") { slot.ready = true; pump(); return; }
                if (m.type === "failed") { dropWorker(slot); return; }
                if (slot.job && m.id === slot.seq) { store(slot.job, m.result); slot.job = null; pump(); }
            };
            worker.onerror = (e) => { e.preventDefault(); dropWorker(slot); };
            worker.postMessage({type: "init", urls: urls});
            pool.push(slot);
        }
    }
    function dropWorker(slot) {
        if (slot.job) queue.unshift(slot.job);
        slot.worker.terminate();
        pool = pool.filter((x) => x !== slot);
        pump();
    }
    function pump() {
        if (pool.length) {
            for (const slot of pool) {
                if (!slot.ready || slot.job || !queue.length) continue;
                slot.job = queue.shift();
                slot.seq++;
                slot.worker.postMessage({type: "job", id: slot.seq, scenario: slot.job.scenario, modDefaults: Boolean(state.modDefaults)});
            }
            return;
        }
        // No workers: work through the queue on the main thread in short slices
        if (fallbackTimer || !queue.length) return;
        fallbackTimer = setTimeout(function slice() {
            const end = performance.now() + SLICE_MS;
            while (queue.length && performance.now() < end) runHere(queue.shift());
            fallbackTimer = queue.length && !pool.length ? setTimeout(slice, 0) : 0;
            if (!queue.length) render();
        }, 0);
    }

    // ------------------------------------------------------------------ view state
    let view = null;                  // {x0, x1, y0, y1} in axis coordinates
    let userView = false;             // fit to the data until the viewer zooms or pans
    let hoverId = null, pinnedId = null, focusId = null, highlight = null;
    let expanded = false;

    function certVisible(key) { return !B.hidden[key]; }
    function membershipVisible(m) { return certVisible(certKey(m)) && B.acquisition[m.acquisition]; }
    function visibleCertKeys(p) { return [...new Set(p.memberships.filter(membershipVisible).map(certKey))]; }
    function pointVisible(p) {
        if (!p.roster) return B.otherMods && !B.hidden[modKey(p.mod)];
        return p.memberships.some(membershipVisible);
    }
    function resultOf(p) { return cache.get(currentKey + "#" + p.id); }
    function computedVisible() {
        const out = [];
        for (const p of POINTS) {
            if (!pointVisible(p)) continue;
            const r = resultOf(p);
            if (r && !r.error) out.push({p: p, r: r});
        }
        return out;
    }
    function yValue({p, r}, choice) {
        if (choice === "acquisition") {
            // Use the cheapest acquisition route among the memberships the current filters show.
            const tier = TIERS.findIndex((key) => B.acquisition[key] &&
                p.memberships.some((m) => m.acquisition === key && certVisible(certKey(m))));
            return tier < 0 ? null : tier;
        }
        const value = choice === "magazines" ? r.shots50 / r.roundsPerMag : r.spread;
        return value > 0 && Number.isFinite(value) ? Math.log10(value) : null;
    }
    function fullView(items, timed, choice) {
        const times = (items.length ? items : timed).map((it) => it.r.ttk).sort((a, b) => a - b);
        const fit = times[Math.ceil(times.length * 0.95) - 1];
        const x1 = tx(fit > 0 ? fit : 1);
        if (choice === "acquisition") return {x0: 0, x1, y0: -0.5, y1: 2.5};
        const ys = items.map((it) => it.y);
        const y0 = choice === "consistency" ? 0 : Math.min(Math.log10(0.5), ...ys);
        const yTop = Math.max(Math.log10(choice === "consistency" ? 5 : 2), ...ys);
        return {x0: 0, x1, y0, y1: yTop + (yTop - y0) * 0.06};
    }
    function linearTimeTicks(width) {
        const rough = (view.x1 - view.x0) / Math.max(2, Math.floor(width / 65));
        if (!Number.isFinite(rough) || rough <= 0) return [];
        const base = 10 ** Math.floor(Math.log10(rough));
        const step = base * ([1, 2, 5, 10].find((n) => n * base >= rough) || 10);
        const ticks = [];
        for (let i = Math.max(0, Math.ceil(view.x0 / step)); i <= Math.floor(view.x1 / step); i++) {
            ticks.push(Number((i * step).toPrecision(6)));
        }
        return ticks;
    }
    function idHash(id) {
        let h = 2166136261;
        for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
        return h >>> 0;
    }

    // ------------------------------------------------------------------ marks
    function shapePath(shape, cx, cy, r) {
        if (shape === "diamond") {
            const d = r * 1.25;
            return `M${cx} ${cy - d}L${cx + d} ${cy}L${cx} ${cy + d}L${cx - d} ${cy}Z`;
        }
        if (shape === "triangle") {
            const d = r * 1.3;
            return `M${cx} ${cy - d}L${cx + d * 0.95} ${cy + d * 0.7}L${cx - d * 0.95} ${cy + d * 0.7}Z`;
        }
        return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
    function shapeOf(p) {
        const gens = new Set(p.certKeys.map((k) => certByKey[k].gen));
        if (gens.size === 1) return SHAPES[[...gens][0]];
        gens.delete(RELIQUARY);
        return gens.size === 1 ? SHAPES[[...gens][0]] : SHAPES.mixed;
    }
    let clipSeq = 0;
    // A weapon several certs can field: equal slices of each cert's colour inside the shape
    function drawMark(p, cx, cy, defs, hollow) {
        const g = svg("g", {class: "pt"});
        if (!p.roster) {
            g.append(svg("circle", {class: "mark-ring", cx: cx, cy: cy, r: MARK_R - 1, stroke: modColor[p.mod]}));
            return g;
        }
        const shape = shapeOf(p);
        const outline = shapePath(shape, cx, cy, MARK_R);
        const keys = visibleCertKeys(p);
        if (keys.length === 1) {
            const color = certByKey[keys[0]].color;
            g.append(svg("path", hollow ? {class: "mark-ring", d: outline, stroke: color} : {class: "mark", d: outline, fill: color}));
            return g;
        }
        const id = `bclip${++clipSeq}`;
        const clip = svg("clipPath", {id: id});
        clip.append(svg("path", {d: hollow ? outline + shapePath(shape, cx, cy, MARK_R - 2) : outline, "clip-rule": "evenodd"}));
        defs.append(clip);
        const slices = svg("g", {class: "mark", "clip-path": `url(#${id})`});
        const R2 = MARK_R * 1.6;
        keys.forEach((k, i) => {
            const a0 = -Math.PI / 2 + (i / keys.length) * 2 * Math.PI, a1 = -Math.PI / 2 + ((i + 1) / keys.length) * 2 * Math.PI;
            const large = a1 - a0 > Math.PI ? 1 : 0;
            slices.append(svg("path", {fill: certByKey[k].color,
                d: `M${cx} ${cy}L${cx + R2 * Math.cos(a0)} ${cy + R2 * Math.sin(a0)}A${R2} ${R2} 0 ${large} 1 ${cx + R2 * Math.cos(a1)} ${cy + R2 * Math.sin(a1)}Z`}));
        });
        g.append(slices);
        if (!hollow) g.append(svg("path", {d: outline, fill: "none", stroke: "var(--surface)", "stroke-width": 1.5}));
        return g;
    }
    function swatch(kind, color) {
        const s = svg("svg", {viewBox: "0 0 12 12", "aria-hidden": "true"});
        if (kind === "ring") s.append(svg("circle", {cx: 6, cy: 6, r: 4, fill: "none", stroke: color, "stroke-width": 2}));
        else s.append(svg("path", {d: shapePath(kind, 6, 6, 4.2), fill: color}));
        return s;
    }

    // ------------------------------------------------------------------ number formats
    const fmtNum = (v, d) => M.fmt(v, d);
    function magazines(r) {
        const mags = Math.round((r.shots50 / r.roundsPerMag) * 10) / 10;
        return mags < 0.1 ? "<0.1" : mags.toFixed(1);
    }
    function rpm(r) { return r.reloadTime > 0 ? Math.round(60 / r.reloadTime) + " rpm" : "single shot"; }
    function outcomeWord() { return B.outcome === "dead" ? "dead" : "down"; }
    function pointName(p) { return p.variant ? `${p.name} (${p.variant})` : p.name; }

    // ------------------------------------------------------------------ tooltip
    function tipContent({p, r, stack, strip}) {
        const reloads = r.shots50 ? Math.floor((r.shots50 - 1) / r.roundsPerMag) : 0;
        const lowerTime = r.ttk25 == null ? "not reached" : `${fmtNum(r.ttk25, 2)} s`;
        const upperTime = r.ttk75 == null ? "not reached" : `${fmtNum(r.ttk75, 2)} s`;
        const rows = [
            el("h4", {text: pointName(p)}),
            el("div", {class: "sub", text: [...p.mods].join(", ") + " · " + p.weapon}),
            el("div", {class: "sub ammo", text: "Ammo: " + p.magazineName + (p.muzzleName ? ` (${p.muzzleName})` : "")}),
            el("div", {class: "sub", text: p.ammo}),
            ...(r.shots50 ? [
                row(`Shots to 50% ${outcomeWord()}`, String(r.shots50)),
                row("Magazines", `${magazines(r)} of ${r.roundsPerMag}`),
                row("Time to " + outcomeWord(), fmtNum(r.ttk, 2) + " s"),
            ] : [row(`By ${MAX_SHOTS} shots`, `${fmtNum(r.pByCap * 100, 1)}% ${outcomeWord()}`)]),
            row("25 to 75% time", `${lowerTime} to ${upperTime}`),
            row("Body hit chance", r.pHit == null ? "Not available" : fmtNum(r.pHit * 100, 1) + "%"),
            el("div", {class: "sub", text: `${p.modeLabel} · ${rpm(r)}` +
                (reloads ? ` · ${reloads} reload${reloads > 1 ? "s" : ""} of ${fmtNum(r.magazineReload, 1)} s` : "")}),
        ];
        if (strip) rows.splice(4, 0, el("div", {class: "sub", text: strip === "beyond" ? "Beyond the fitted time range" :
            `Median not ${outcomeWord()} within ${MAX_SHOTS} shots`}));
        if (p.roster) {
            rows.push(el("ul", {}, p.memberships.map((m) => el("li", {text: m.cert === RELIQUARY
                ? `Reliquary: ${m.sheetName}${m.owner ? `, first owned by ${m.owner}` : ""}`
                : `${m.generation} ${m.cert}: ${ACQUISITION[m.acquisition]}`}))));
        } else {
            rows.push(el("div", {class: "sub", text: "Not on any cert or relic list"}));
        }
        if (stack.length > 1) rows.push(el("div", {class: "tip-stack"}, [
            el("div", {text: `${stack.length} weapons at this point`}),
            el("ul", {}, stack.map(({p: member}) => el("li", {text: `${pointName(member)} · ${member.magazineName}`}))),
        ]));
        if (p.classes.length > 1) rows.push(el("div", {class: "sub", text: `Same stats as ${p.classes.length - 1} other class${p.classes.length > 2 ? "es" : ""} (colour variants or copies)`}));
        rows.push(el("button", {type: "button", class: "plain open", text: "Open in single weapon",
            onclick: () => WB.openSingle(p.weapon, p.muzzle, p.magazine)}));
        return rows;
    }
    function row(label, value) {
        return el("div", {class: "row"}, [el("span", {text: label}), el("span", {class: "v", text: value})]);
    }

    // ------------------------------------------------------------------ render
    let root = null;
    let chartLayout;
    const viewChoice = () => B.view === "table" ? "table" : "chart";
    function ensureShell() {
        if (root) return;
        root = $("balance");
        const seg = (name, selected, value, label, change) => [
            el("input", {type: "radio", name: name, id: `bal-${value}`, value: value, checked: selected === value,
                 onchange: () => { change(value); }}),
            el("label", {for: `bal-${value}`, text: label}),
        ];
        const reload = el("input", {type: "number", id: "balReload", min: 0, max: 30, step: 0.1, value: String(B.reload),
            onchange: (e) => { B.reload = Math.max(0, Number(e.target.value) || 0); e.target.value = String(B.reload); WB.save(); schedule(); }});
        const other = el("label", {class: "check"}, [
            el("input", {type: "checkbox", id: "balOther", checked: B.otherMods || undefined,
                onchange: (e) => { B.otherMods = e.target.checked; WB.save(); schedule(); }}),
            "Show other 40k mods",
        ]);
        const axisChanged = () => {
            userView = false;
            hoverId = pinnedId = focusId = null;
            WB.save();
            render();
        };
        const logTime = el("label", {class: "check bal-chart-only"}, [
            el("input", {type: "checkbox", checked: B.logTime,
                onchange: (e) => { B.logTime = e.target.checked; axisChanged(); }}),
            "Log time",
        ]);
        const acquisition = el("div", {class: "seg", role: "group", "aria-labelledby": "balAcquisitionLabel"},
            Object.entries(ACQUISITION).flatMap(([k, label]) => [
                el("input", {type: "checkbox", id: `bal-acquisition-${k}`, checked: B.acquisition[k],
                    onchange: (e) => { B.acquisition[k] = e.target.checked; WB.save(); render(); }}),
                el("label", {for: `bal-acquisition-${k}`, text: label}),
            ]));
        root.replaceChildren(
            el("p", {class: "balance-intro bal-chart-only", text: "Each mark compares median time to the chosen kill outcome with the selected Y measure, counting all shots fired, including misses."}),
            el("div", {class: "balance-controls"}, [
                el("div", {class: "field"}, [el("span", {class: "label", id: "balOutcomeLabel", text: "Counts as a kill"}),
                    el("div", {class: "seg", role: "radiogroup", "aria-labelledby": "balOutcomeLabel"},
                        [["down", "Down or dead"], ["dead", "Dead"]].flatMap(([value, label]) =>
                            seg("balOutcome", B.outcome, value, label, (v) => { B.outcome = v; WB.save(); schedule(); })))]),
                el("div", {class: "field bal-chart-only"}, [el("span", {class: "label", id: "balYAxisLabel", text: "Y axis"}),
                    el("div", {class: "seg", role: "radiogroup", "aria-labelledby": "balYAxisLabel"},
                        Object.entries(Y_LABELS).flatMap(([value, label]) =>
                            seg("balYAxis", yChoice(), value, label, (v) => { B.yAxis = v; axisChanged(); })))]),
                logTime,
                el("div", {class: "field"}, [el("label", {for: "balReload", text: "Reload time (s)"}), reload]),
                el("div", {class: "field"}, [el("span", {class: "label", id: "balAcquisitionLabel", text: "Acquisition"}), acquisition]),
                other,
            ]),
            el("span", {class: "hint", text: "Reload time is used whenever the weapon's config sets a shorter one (most leave it at 0; " +
                "the real reload is the animation, which is not read)."}),
            el("p", {class: "changes", id: "balOverrides", hidden: true}, [
                el("span", {id: "balOverrideClasses"}),
                el("button", {type: "button", class: "reset", text: "reset", "aria-label": "Reset all changed values", onclick: WB.resetChangedValues}),
            ]),
            el("div", {class: "progress", id: "balProgress", role: "status"}),
            el("div", {class: "seg", role: "radiogroup", "aria-label": "Results view"},
                [["chart", "Chart"], ["table", "Table"]].flatMap(([value, label]) =>
                    seg("balView", viewChoice(), value, label, (v) => {
                        B.view = v;
                        hoverId = pinnedId = focusId = highlight = null;
                        WB.save();
                        if (v === "table" && expanded) toggleExpand();
                        else render();
                    }))),
            el("div", {class: "scatter-box bal-chart-only", id: "balChart"}),
            el("p", {class: "hint scatter-note bal-chart-only", id: "balChartNote", hidden: true}),
            el("div", {class: "blegend bal-chart-only", id: "balLegend"}),
            tableView(),
            el("div", {id: "balNotes"}),
        );
    }

    function render() {
        if (state.tab !== "balance") return;
        ensureShell();
        root.dataset.view = viewChoice();
        $("balTable").hidden = viewChoice() !== "table";
        $("balOverrides").hidden = !editedClasses.length;
        $("balOverrideClasses").textContent = `Edited ammo and magazine classes: ${editedClasses.join(", ")}.`;
        const candidates = visibleCandidates();
        const done = candidates.filter((p) => cache.has(currentKey + "#" + p.id)).length;
        $("balProgress").textContent = done < candidates.length
            ? `Working out ${done} of ${candidates.length} weapon and ammunition pairs${pool && pool.length ? "" : " (on the page thread)"}…`
            : `${candidates.length} weapon and ammunition pairs, ${RUNS} simulated bursts each.`;
        if (viewChoice() === "table") renderTable();
        else renderLegend(renderChart());
        renderNotes();
    }

    function chartSize() {
        const box = $("balChart");
        const width = Math.max(300, box.clientWidth || 700);
        const tall = expanded ? Math.max(320, window.innerHeight - 280) : Math.min(560, Math.max(MIN_CHART_H, width * 0.62));
        return {W: width, H: tall};
    }

    function renderChart(gesture = false) {
        if (viewChoice() !== "chart") return [];
        const box = $("balChart");
        const choice = yChoice();
        const results = computedVisible();
        const timed = results.filter(({r}) => r.shots50).map((it) => ({...it, y: yValue(it, choice)}));
        const items = timed.filter((it) => it.y != null);
        const fitted = fullView(items, timed, choice);
        if (!userView || !view) view = fitted;
        const beyond = timed.filter(({r}) => tx(r.ttk) > fitted.x1).sort((a, b) => a.r.ttk - b.r.ttk);
        const capped = results.filter(({r}) => !r.shots50);
        const strips = [
            {key: "beyond", label: ["Beyond"], items: beyond},
            {key: "cap", label: [`Not ${outcomeWord()}`, "within", `${MAX_SHOTS} shots`], items: capped},
        ].filter((strip) => strip.items.length);
        const {W, H} = chartSize();
        const stripW = Math.min(78, Math.floor(W * 0.23));
        const padL = choice === "acquisition" ? 80 : 62;
        const padR = 12 + strips.length * (stripW + 6);
        const padT = strips.length ? 60 : 44, padB = choice === "consistency" ? 58 : 44;
        const plotW = W - padL - padR, plotH = H - padT - padB;
        const sx = (t) => padL + ((tx(t) - view.x0) / (view.x1 - view.x0)) * plotW;
        const sy = (y) => padT + (1 - (y - view.y0) / (view.y1 - view.y0)) * plotH;
        const xTitleText = `Time to 50% ${outcomeWord()} (${B.logTime ? "log(1 + s)" : "s"})`;
        const yTitleText = choice === "magazines" && B.outcome === "dead" ? "Magazines to dead" : Y_LABELS[choice];
        // Keep the SVG itself mounted so redraws preserve pointer capture and its gesture handlers.
        const existingChart = box.firstElementChild;
        const chart = existingChart || svg("svg", {tabindex: 0, role: "application"});
        chart.setAttribute("viewBox", `0 0 ${W} ${H}`);
        chart.setAttribute("width", W);
        chart.setAttribute("height", H);
        chart.setAttribute("aria-label", `Scatter plot. X axis: ${xTitleText}. Y axis: ${yTitleText}.` +
            strips.map(({label}) => ` ${label.join(" ")} strip.`).join("") + " Arrow keys step through the marks.");
        const plot = document.createDocumentFragment();
        const defs = svg("defs");
        const clipId = "bplot";
        const clipRect = svg("clipPath", {id: clipId});
        clipRect.append(svg("rect", {x: padL, y: padT, width: plotW, height: plotH}));
        defs.append(clipRect);
        plot.append(defs);
        const grid = svg("g", {class: "grid"}), axis = svg("g", {class: "axis"});
        if (choice === "acquisition") {
            const band = svg("g", {"clip-path": `url(#${clipId})`});
            for (const i of [0, 2]) band.append(svg("rect", {class: "acquisition-band", x: padL, y: sy(i + 0.5),
                width: plotW, height: sy(i - 0.5) - sy(i + 0.5)}));
            plot.append(band);
        }
        let lastTickX = -Infinity;
        for (const t of B.logTime ? TIME_TICKS : linearTimeTicks(plotW)) {
            const x = sx(t);
            if (x < padL || x > W - padR + 0.001 || x - lastTickX < 34) continue;
            lastTickX = x;
            grid.append(svg("line", {x1: x, x2: x, y1: padT, y2: H - padB}));
            const label = svg("text", {x, y: H - padB + 16, "text-anchor": "middle"});
            label.textContent = String(t);
            axis.append(label);
        }
        const yTicks = choice === "acquisition" ? [0, 1, 2] : choice === "consistency" ? [1, 1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500] :
            [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
        for (const t of yTicks) {
            const y = choice === "acquisition" ? t : Math.log10(t);
            if (y < view.y0 || y > view.y1) continue;
            const reference = choice !== "acquisition" && t === 1;
            grid.append(svg("line", {class: reference ? "scatter-reference" : "", x1: padL, x2: W - padR, y1: sy(y), y2: sy(y)}));
            const label = svg("text", {x: padL - 6, y: sy(y) + 4, "text-anchor": "end"});
            label.textContent = choice === "acquisition" ? ["Default", "Earnable", "Relic"][t] : String(t);
            axis.append(label);
            if (reference) {
                const caption = svg("text", {class: "scatter-caption", x: padL + 8,
                    y: choice === "consistency" ? H - padB + 31 : Math.max(padT + 12, sy(y) - 5)});
                caption.textContent = choice === "consistency" ? "1 = always the same" : "1 magazine";
                axis.append(caption);
            }
        }
        const xTitle = svg("text", {class: "axis-title", x: padL + plotW / 2, y: H - 6, "text-anchor": "middle"});
        xTitle.textContent = xTitleText;
        const yTitle = svg("text", {class: "axis-title", transform: `translate(14 ${padT + plotH / 2}) rotate(-90)`, "text-anchor": "middle"});
        yTitle.textContent = choice === "acquisition" ? yTitleText : `${yTitleText} (log scale)`;
        plot.append(grid, axis, xTitle, yTitle);

        const marks = svg("g", {"clip-path": `url(#${clipId})`, class: highlight ? "dim" : ""});
        const placed = [], stacks = new Map();
        for (const it of items) {
            const x = tx(it.r.ttk);
            if (x > fitted.x1 || x < view.x0 || x > view.x1 || it.y < view.y0 || it.y > view.y1) continue;
            const key = `${it.r.ttk}|${it.y}`;
            if (!stacks.has(key)) stacks.set(key, []);
            stacks.get(key).push(it);
        }
        for (const stack of stacks.values()) {
            stack.sort((a, b) => idHash(a.p.id) - idHash(b.p.id) || a.p.id.localeCompare(b.p.id));
            const cols = Math.ceil(Math.sqrt(stack.length));
            const rows = Math.ceil(stack.length / cols);
            const step = 7;
            const margin = MARK_R + 2;
            const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
            const x = clamp(sx(stack[0].r.ttk) - (cols - 1) * step / 2,
                padL + margin, W - padR - margin - (cols - 1) * step);
            const band = choice === "acquisition";
            const bandOffset = band ? (idHash(stack[0].p.id) / 2 ** 32 - 0.5) * 0.48 : 0;
            const yMin = band ? Math.max(padT, sy(stack[0].y + 0.5)) : padT;
            const yMax = band ? Math.min(H - padB, sy(stack[0].y - 0.5)) : H - padB;
            const dy = rows > 1 ? Math.min(step, Math.max(0, yMax - yMin - 2 * margin) / (rows - 1)) : 0;
            const stackH = (rows - 1) * dy;
            const y = yMax - yMin < 2 * margin ? (yMin + yMax) / 2 :
                clamp(sy(stack[0].y + bandOffset) - stackH / 2, yMin + margin, yMax - margin - stackH);
            stack.forEach((it, i) => placed.push({...it, stack, cx: x + (i % cols) * step, cy: y + Math.floor(i / cols) * dy}));
        }
        // Strip positions are unscaled; the tooltip gives the actual result.
        strips.forEach(({key, label, items: entries}, i) => {
            const left = W - padR + 6 + i * (stripW + 6);
            plot.append(svg("rect", {class: "scatter-strip", x: left, y: padT, width: stripW, height: plotH}));
            label.forEach((text, j) => {
                const caption = svg("text", {class: "scatter-caption", x: left + stripW / 2,
                    y: padT + 13 + 12 * j, "text-anchor": "middle"});
                caption.textContent = text;
                plot.append(caption);
            });
            const cols = Math.floor(stripW / 14);
            const rows = Math.ceil(entries.length / cols);
            const top = padT + label.length * 12 + 16;
            const dy = rows > 1 ? Math.min(16, (H - padB - top - MARK_R - 2) / (rows - 1)) : 0;
            entries.forEach((it, j) => placed.push({...it, strip: key, stack: [],
                cx: left + ((j % cols) + 0.5) * stripW / cols, cy: top + Math.floor(j / cols) * dy}));
        });
        const stripMarks = svg("g", {class: highlight ? "dim" : ""});
        // Other mods underneath, roster on top
        placed.sort((a, b) => Number(a.p.roster) - Number(b.p.roster));
        for (const it of placed) {
            const g = drawMark(it.p, it.cx, it.cy, defs, Boolean(it.strip));
            if (highlight && matchesHighlight(it.p)) g.classList.add("hl");
            (it.strip ? stripMarks : marks).append(g);
        }
        plot.append(marks, stripMarks);
        const active = placed.find((q) => q.p.id === (pinnedId || hoverId || focusId));
        if (active) plot.append(svg("circle", {class: "focus-ring", cx: active.cx, cy: active.cy, r: MARK_R + 4}));

        const tip = el("div", {class: "tip" + (pinnedId ? " pinned" : ""), hidden: !active || undefined, role: pinnedId ? "dialog" : undefined});
        if (active) {
            tip.replaceChildren(...tipContent(active));
            tip.style.maxHeight = `${H - 8}px`;
        }
        const tools = el("div", {class: "scatter-tools"}, [
            el("button", {type: "button", "aria-label": "Zoom in", title: "Zoom in", text: "+", onclick: () => zoomBy(1 / ZOOM_STEP, 0.5, 0.5)}),
            el("button", {type: "button", "aria-label": "Zoom out", title: "Zoom out", text: "−", onclick: () => zoomBy(ZOOM_STEP, 0.5, 0.5)}),
            el("button", {type: "button", text: "Reset", onclick: () => { userView = false; render(); }}),
            el("button", {type: "button", text: expanded ? "Close" : "Expand", "aria-pressed": String(expanded), onclick: toggleExpand}),
        ]);
        if (existingChart) {
            chart.nextElementSibling.replaceWith(tools);
            tools.nextElementSibling.replaceWith(tip);
        } else {
            box.append(chart, tools, tip);
            wireChart(chart);
        }
        if (!gesture) {
            const notes = [];
            if (choice === "consistency") notes.push("Consistency is the 75% shot count divided by the 25% shot count. Closer to 1 means more consistent bursts.");
            if (choice === "acquisition") notes.push("Each weapon is shown in the lowest acquisition tier available under the current filters.");
            const missingY = timed.filter((it) => it.y == null && tx(it.r.ttk) <= fitted.x1).length;
            if (missingY) notes.push(`${missingY} ${missingY === 1 ? "mark has" : "marks have"} no ${choice === "acquisition" ? "listed tier" : "value for this measure"}.`);
            if (beyond.length) notes.push("Time axis fits the fastest 95% of marks; longer times are in Beyond.");
            if (strips.length) notes.push("Strip positions are not on either scale. Select a mark for its result.");
            $("balChartNote").textContent = notes.join(" ");
            $("balChartNote").hidden = !notes.length;
        }
        if (!placed.length && !items.length) {
            const empty = svg("text", {x: padL + plotW / 2, y: H / 2, "text-anchor": "middle", class: "axis-title"});
            empty.textContent = queue.length ? "Working out the first weapons…" : results.length
                ? "No marks have a value for this measure." : "No weapon matches the filters.";
            plot.append(empty);
        }
        chartLayout = {placed, padL, padR, padT, padB, W, H};
        chart.replaceChildren(plot);
        if (active) placeTip(tip, chart, active, W);
        return placed;
    }

    // Beside the mark, flipped left or above when it would leave the chart
    function placeTip(tip, chart, active, W) {
        const scale = chart.getBoundingClientRect().width / W;
        const x = active.cx * scale, y = active.cy * scale;
        const boxW = chart.clientWidth || W * scale, boxH = chart.clientHeight;
        const w = tip.offsetWidth, h = tip.offsetHeight;
        const left = x + 14 + w > boxW ? x - 14 - w : x + 14;
        const top = y - 20 + h > boxH ? y - h - 10 : y - 20;
        tip.style.left = Math.max(0, Math.min(boxW - w, left)) + "px";
        tip.style.top = Math.max(0, Math.min(boxH - h, top)) + "px";
    }

    function zoomBy(factor, fx, fy, gesture = false) {
        if (!view) return;
        userView = true;
        const cx = view.x0 + fx * (view.x1 - view.x0), cy = view.y1 - fy * (view.y1 - view.y0);
        view = {x0: cx - (cx - view.x0) * factor, x1: cx + (view.x1 - cx) * factor, y0: cy - (cy - view.y0) * factor, y1: cy + (view.y1 - cy) * factor};
        if (gesture) renderChart(true);
        else render();
    }

    function wireChart(chart) {
        const pointers = new Map();
        let drag = null, moved = false, pinch = null;
        const local = (e) => {
            const {W, H} = chartLayout;
            const rect = chart.getBoundingClientRect();
            return {x: (e.clientX - rect.left) * (W / rect.width), y: (e.clientY - rect.top) * (H / rect.height)};
        };
        const nearest = (pt) => {
            let best = null, bestD = PICK_RADIUS * PICK_RADIUS;
            for (const q of chartLayout.placed) {
                const d = (q.cx - pt.x) ** 2 + (q.cy - pt.y) ** 2;
                if (d < bestD) { bestD = d; best = q; }
            }
            return best;
        };
        const fraction = (pt) => {
            const {padL, padR, padT, padB, W, H} = chartLayout;
            return {fx: Math.max(0, Math.min(1, (pt.x - padL) / (W - padL - padR))), fy: (pt.y - padT) / (H - padT - padB)};
        };
        chart.addEventListener("wheel", (e) => {
            e.preventDefault();
            const {fx, fy} = fraction(local(e));
            zoomBy(e.deltaY > 0 ? ZOOM_STEP : 1 / ZOOM_STEP, fx, fy);
        }, {passive: false});
        chart.addEventListener("pointerdown", (e) => {
            chart.setPointerCapture(e.pointerId);
            pointers.set(e.pointerId, local(e));
            moved = false;
            if (pointers.size === 1) drag = {start: local(e), view: Object.assign({}, view)};
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinch = {dist: Math.hypot(a.x - b.x, a.y - b.y), view: Object.assign({}, view), mid: {x: (a.x + b.x) / 2, y: (a.y + b.y) / 2}};
                drag = null;
                chart.classList.remove("panning");
            }
        });
        chart.addEventListener("pointermove", (e) => {
            const pt = local(e);
            const tracked = pointers.has(e.pointerId);
            if (tracked) pointers.set(e.pointerId, pt);
            if (tracked && pinch && pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                const factor = pinch.dist / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
                const {fx, fy} = fraction(pinch.mid);
                view = Object.assign({}, pinch.view);
                moved = true;
                zoomBy(factor, fx, fy, true);
                return;
            }
            if (tracked && drag) {
                const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y;
                if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
                if (moved) {
                    userView = true;
                    chart.classList.add("panning");
                    const {padL, padR, padT, padB, W, H} = chartLayout;
                    const kx = (drag.view.x1 - drag.view.x0) / (W - padL - padR), ky = (drag.view.y1 - drag.view.y0) / (H - padT - padB);
                    view = {x0: drag.view.x0 - dx * kx, x1: drag.view.x1 - dx * kx, y0: drag.view.y0 + dy * ky, y1: drag.view.y1 + dy * ky};
                    renderChart(true);
                }
                return;
            }
            if (e.pointerType === "mouse" && !pinnedId) {
                const hit = nearest(pt);
                const id = hit ? hit.p.id : null;
                if (id !== hoverId) { hoverId = id; renderChart(); }
            }
        });
        const end = (e) => {
            if (!pointers.has(e.pointerId)) return;
            const wasTap = pointers.size === 1 && !moved && !pinch;
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinch = null;
            if (!pointers.size) {
                drag = null;
                chart.classList.remove("panning");
            }
            if (wasTap && e.type === "pointerup") {
                const hit = nearest(local(e));
                pinnedId = hit && hit.p.id !== pinnedId ? hit.p.id : null;
                hoverId = null;
                renderChart();
            }
        };
        chart.addEventListener("pointerup", end);
        chart.addEventListener("pointercancel", end);
        chart.addEventListener("lostpointercapture", end);
        chart.addEventListener("pointerleave", () => { if (hoverId && !pinnedId) { hoverId = null; renderChart(); } });
        chart.addEventListener("keydown", (e) => {
            const order = chartLayout.placed.slice().sort((a, b) => a.cx - b.cx || a.cy - b.cy);
            if (!order.length) return;
            const i = order.findIndex((q) => q.p.id === (pinnedId || focusId));
            if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const right = e.key === "ArrowRight";
                const next = i < 0 ? order[right ? 0 : order.length - 1] : order[(i + (right ? 1 : order.length - 1)) % order.length];
                focusId = next.p.id; pinnedId = hoverId = null;
                renderChart(); $("balChart").querySelector("svg").focus();
            } else if (e.key === "Enter" && i >= 0) {
                WB.openSingle(order[i].p.weapon, order[i].p.muzzle, order[i].p.magazine);
            } else if (e.key === "Escape") {
                pinnedId = null; focusId = null; renderChart();
            } else if (e.key === "+" || e.key === "=") {
                zoomBy(1 / ZOOM_STEP, 0.5, 0.5);
            } else if (e.key === "-") {
                zoomBy(ZOOM_STEP, 0.5, 0.5);
            }
        });
    }

    function toggleExpand() {
        const panel = $("balance");
        expanded = !expanded;
        if (expanded && panel.requestFullscreen && !document.fullscreenElement) {
            panel.requestFullscreen().catch(() => panel.classList.add("expanded"));
        } else if (!expanded && document.fullscreenElement) {
            document.exitFullscreen();
        }
        panel.classList.toggle("expanded", expanded && !panel.requestFullscreen);
        render();
    }
    document.addEventListener("fullscreenchange", () => {
        if (!document.fullscreenElement && expanded) { expanded = false; $("balance").classList.remove("expanded"); }
        render();
    });
    window.addEventListener("resize", () => { if (state.tab === "balance") render(); });

    // ------------------------------------------------------------------ legend
    function matchesHighlight(p) {
        if (!highlight) return false;
        return p.roster ? visibleCertKeys(p).includes(highlight) : modKey(p.mod) === highlight;
    }
    function legendItem(key, label, kind, color, count) {
        const item = el("button", {type: "button", class: "blegend-item", "aria-pressed": String(!B.hidden[key]),
            title: "Click to show or hide; double-click to show only this",
            onclick: () => { B.hidden[key] = !B.hidden[key]; if (!B.hidden[key]) delete B.hidden[key]; WB.save(); render(); },
            ondblclick: () => { isolate(key); },
            onpointerenter: () => { highlight = key; renderChart(); },
            onpointerleave: () => { highlight = null; renderChart(); },
            onfocus: () => { highlight = key; renderChart(); },
            onblur: () => { highlight = null; renderChart(); },
        }, [swatch(kind, color), label, el("span", {class: "count", text: String(count)})]);
        return item;
    }
    function isolate(key) {
        const keys = legendKeys();
        B.hidden = Object.fromEntries(keys.filter((k) => k !== key).map((k) => [k, true]));
        WB.save(); render();
    }
    function legendKeys() {
        const keys = certs.map((c) => c.key);
        if (B.otherMods) keys.push(...topMods.slice(0, SLOTS).map((m) => `mod:${m}`), OTHER_MODS_KEY);
        return keys;
    }
    function renderLegend(placed) {
        const counts = {};
        for (const {p} of placed) {
            if (p.roster) for (const k of visibleCertKeys(p)) counts[k] = (counts[k] || 0) + 1;
            else counts[modKey(p.mod)] = (counts[modKey(p.mod)] || 0) + 1;
        }
        const groups = [];
        for (const gen of [...GENERATIONS, RELIQUARY]) {
            const items = certs.filter((c) => c.gen === gen).map((c) => legendItem(c.key, c.name, SHAPES[gen], c.color, counts[c.key] || 0));
            groups.push(el("div", {class: "blegend-group"}, [el("h3", {text: gen === RELIQUARY ? "Reliquary (named relics)" : gen}),
                el("div", {class: "blegend-items"}, items)]));
        }
        if (B.otherMods) {
            const items = topMods.slice(0, SLOTS).map((m) => legendItem(`mod:${m}`, m, "ring", modColor[m], counts[`mod:${m}`] || 0));
            if (topMods.length > SLOTS) items.push(legendItem(OTHER_MODS_KEY, `${topMods.length - SLOTS} more mods`, "ring", "var(--ink-3)", counts[OTHER_MODS_KEY] || 0));
            groups.push(el("div", {class: "blegend-group"}, [el("h3", {text: "Other 40k mods (not on a list)"}), el("div", {class: "blegend-items"}, items)]));
        }
        groups.push(el("div", {class: "toolbar"}, [
            el("button", {type: "button", class: "plain", text: "Show all", onclick: () => { B.hidden = {}; WB.save(); render(); }}),
            el("span", {class: "hint", text: "Shape: circle Firstborn, diamond Primaris, triangle Reliquary. Split marks: a weapon on several certs. Double-click (or double-tap) an entry to show only it."}),
        ]));
        $("balLegend").replaceChildren(...groups);
    }

    // ------------------------------------------------------------------ notes and table
    function renderNotes() {
        const never = [], failed = [];
        for (const p of POINTS) {
            if (!pointVisible(p)) continue;
            const r = resultOf(p);
            if (!r) continue;
            if (r.error) failed.push(`${pointName(p)} (${r.error})`);
            else if (!r.shots50) never.push(`${pointName(p)} · ${p.magazineName}`);
        }
        const notes = [];
        if (never.length) notes.push(el("details", {}, [el("summary", {text: `${never.length} not ${outcomeWord()} within ${MAX_SHOTS} shots`}),
            el("p", {class: "never", text: never.sort().join("; ")})]));
        if (failed.length) notes.push(el("details", {}, [el("summary", {text: `${failed.length} could not be simulated`}),
            el("p", {class: "never", text: failed.join("; ")})]));
        if (R.unmatched.length) {
            const names = [...new Set(R.unmatched.map((u) => `${u.sheetName} (${u.cert === RELIQUARY ? RELIQUARY : u.generation + " " + u.cert}, ${u.acquisition})`))];
            notes.push(el("details", {}, [el("summary", {text: `${names.length} sheet entries not matched to a simulated weapon`}),
                el("p", {class: "never", text: names.join("; ") + ". Map them in tools/damage_sim/roster_overrides.json."})]));
        }
        $("balNotes").replaceChildren(...notes);
    }

    const TABLE_LABELS = {name: "Weapon", variant: "Variant", class: "Class", magazine: "Magazine", ammo: "Ammo",
        certs: "Certs", acquisition: "Acquisition", shots50: "Shots (50%)", shots25: "Shots (25%)", shots75: "Shots (75%)",
        spread: "Spread", pHit: "Hit chance", ttk: "Time (50%, s)", ttk25: "Time (25%, s)", ttk75: "Time (75%, s)",
        magazinesToDown: "Magazines to down", modeLabel: "Fire mode", rpm: "RPM"};
    const numericColumn = (key) => /^(shots|ttk)|^(spread|pHit|magazinesToDown|rpm)$/.test(key);
    let tableSort = "ttk", tableDescending = false, tableRows = [];

    function tableView() {
        const head = el("tr", {}, BALANCE_COLUMNS.map((key) =>
            el("th", {id: `balColumn-${key}`, scope: "col", class: numericColumn(key) ? "n" : undefined},
                el("button", {type: "button", text: TABLE_LABELS[key], onclick: () => {
                    tableDescending = tableSort === key && !tableDescending;
                    tableSort = key;
                    $("balTableScroll").scrollTop = 0;
                    renderTable();
                }}, el("span", {class: "sort-arrow", "aria-hidden": "true"})))));
        return el("div", {class: "balance-table", id: "balTable", hidden: true}, [
            el("div", {class: "toolbar"}, [
                el("input", {type: "search", id: "balFilter", "aria-label": "Filter by name, class or cert",
                    placeholder: "Filter by name, class or cert", oninput: () => {
                        $("balTableScroll").scrollTop = 0;
                        renderTable();
                    }}),
                el("button", {type: "button", class: "plain", id: "balCsv", text: "Download CSV", disabled: true, onclick: downloadTable}),
                el("button", {type: "button", class: "plain", id: "balClearLegend", text: "Clear chart legend filters",
                    onclick: () => { B.hidden = {}; WB.save(); render(); }}),
            ]),
            el("p", {class: "hint", id: "balTableCount", role: "status"}),
            el("div", {class: "table-scroll", id: "balTableScroll", tabindex: 0, role: "region", "aria-label": "Weapon balance results"},
                el("table", {"aria-label": "Weapon balance results"}, [el("thead", {}, head), el("tbody", {id: "balTableRows"})])),
        ]);
    }

    function renderTable() {
        const query = $("balFilter").value.trim().toLowerCase();
        const results = computedVisible();
        tableRows = results.map(({p, r}) => balanceRow(p, r)).filter((row) =>
            [row.name, row.variant, row.class, row.certs.replaceAll(":", " ")].some((value) => value.toLowerCase().includes(query)));
        tableRows.sort((a, b) => {
            const x = a[tableSort], y = b[tableSort];
            const missing = (v) => v == null || v === "";
            if (missing(x) || missing(y)) return Number(missing(x)) - Number(missing(y));
            const cmp = numericColumn(tableSort) ? x - y : x.localeCompare(y);
            return tableDescending ? -cmp : cmp;
        });
        for (const key of BALANCE_COLUMNS) {
            const header = $(`balColumn-${key}`);
            if (key === tableSort) header.setAttribute("aria-sort", tableDescending ? "descending" : "ascending");
            else header.removeAttribute("aria-sort");
        }
        const rows = tableRows.map((row) => el("tr", {}, BALANCE_COLUMNS.map((key) => {
            const value = row[key];
            return el("td", {class: numericColumn(key) ? "n" : undefined,
                text: value == null ? "" : key === "pHit" ? `${fmtNum(100 * value, 1)}%` : fmtNum(value, 3)});
        })));
        $("balTableRows").replaceChildren(...rows);
        $("balTableCount").textContent = rows.length ? `${rows.length} of ${results.length} computed pairs`
            : results.length ? "No pairs match the text filter." : "No computed pairs to show for the current filters.";
        $("balCsv").disabled = !rows.length;
        $("balClearLegend").hidden = !legendKeys().some((key) => B.hidden[key]);
    }

    function downloadTable() {
        const url = URL.createObjectURL(new Blob([balanceCsv(tableRows)], {type: "text/csv;charset=utf-8"}));
        const link = el("a", {href: url, download: "weapon-balance.csv", hidden: true});
        root.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    WB.balance = {update: schedule};
    if (state.tab === "balance") schedule();
})();
