/*
 * Damage model: projectile -> engine hitpoint damage -> ACE wound handlers -> wounds.
 *
 * Ports, line for line where it matters:
 *   ACE3 medical_engine fnc_handleDamage, fnc_getHitpointArmor, fnc_getItemArmor
 *   ACE3 medical_damage fnc_woundReceived, fnc_woundsHandlerArmorPenetration,
 *        fnc_woundsHandlerBase, fnc_interpolatePoints, fnc_determineIfFatal, fnc_handleIncapacitation
 *   ACE3 medical fnc_addDamageToUnit, medical_status fnc_adjustPainLevel
 *   [FOD] Black Carapace Overhaul HOV_hitPartCode, HOV_fnc_calcDamage, HOV_fnc_restDamage(Shield),
 *        HOV_BC_fnc_armorWoundHandler
 *   KAT kat_breathing fnc_woundsHandlerPulmoHit (side effects only)
 *
 * The engine part (how much hitpoint damage the engine hands to HandleDamage) is closed source.
 * Those steps are marked ENGINE ASSUMPTION and can be scaled with settings.engine*.
 *
 * Works in a browser (window.DamageModel) and in Node (require).
 */
(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.DamageModel = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // ------------------------------------------------------------------ constants (ACE source)
    const BODY_PARTS = ["head", "body", "leftarm", "rightarm", "leftleg", "rightleg"];
    const BODY_PART_NAMES = ["Head", "Body", "LeftArm", "RightArm", "LeftLeg", "RightLeg"];
    const PRIORITY = {Head: 6, Body: 5, LeftArm: 4, RightArm: 3, LeftLeg: 2, RightLeg: 1, "#structural": 0};
    const HEAD_HITPOINTS = ["HitFace", "HitNeck", "HitHead"];
    const HEAD_SELECTIONS = ["head", "face", "face_hub", "neck"];
    const GAME_TO_FIGURE = Object.freeze({heightOffset: 1.32, depthSign: -1, matchRate: 242 / 363});

    function gameToFigure([right, forward, up], {heightOffset, depthSign} = GAME_TO_FIGURE) {
        return [-right, up - heightOffset, depthSign * forward];
    }
    const MARINE_MODEL_FOLDERS = [
        "tiow_sm\\marine\\", "ctr_armor\\models\\uniforms\\", "ctr_gravis\\models\\uniforms\\", "tda_armour\\models\\",
    ];

    function isMarineModel(path) {
        const normalized = (path || "").toLowerCase().replace(/\//g, "\\").replace(/^\\+/, "");
        return MARINE_MODEL_FOLDERS.some((folder) => normalized.startsWith(folder));
    }
    const BODY_HITPOINTS = ["HitPelvis", "HitAbdomen", "HitDiaphragm", "HitChest"];
    const LIMB_HITPOINTS = {LeftArm: "HitLeftArm", RightArm: "HitRightArm", LeftLeg: "HitLeftLeg", RightLeg: "HitRightLeg"};
    const LARGE_WOUND_THRESHOLD = 0.5;
    const WORST_DAMAGE = 2;
    const UNSCALED_BASE_ARMOR = 2;
    const DAMAGE_SCALING_FACTOR = 10;
    const ARMOR_PENETRABILITY = 0.015;
    const ARMOR_THICKNESS = [6, 15, 21, 40, 55];
    const TYPE_UNIFORM = 801;
    const TYPE_VEST = 701;
    const TYPE_HEADGEAR = 605;
    const VENTRICLE_STROKE_VOL = 95e-3;
    const DEFAULT_BLOOD_VOLUME = 6.0;
    const BLOOD_CLASS_3 = 4.2;
    const BLOOD_CLASS_4 = 3.6;
    const FATAL_INJURIES_ALWAYS = 0;
    const FATAL_INJURIES_NEVER = 2;
    const MAX_SHOTS = 600;
    const EARLY_RUNS = 12;    // shotsToKill: bursts that all reach the cap end the search early

    // Weibull coefficients derived in ACE medical_engine XEH_preInit
    const WEIBULL = (function () {
        const x1 = 0.5, y1 = 0.1, x2 = 0.8, y2 = 0.9;
        const b1 = -Math.log(1 - y1), b2 = -Math.log(1 - y2);
        const k = Math.log(b1 / b2) / Math.log(x1 / x2);
        return {k: k, l: x1 / Math.pow(b1, 1 / k)};
    })();

    // Black Carapace zone variables, in ACE body part order
    const BCO_ZONES = ["head", "body", "armL", "armR", "legL", "legR"];
    const BCO_EXPLOSION_PARTS = ["Head", "Body", "LeftArm", "RightArm", "LeftArm", "RightArm"];

    // Selectable impact points: hitpoint and the skeleton selection HitPart reports
    const IMPACTS = {
        HitHead: {label: "Head", part: "Head", selection: "head"},
        HitFace: {label: "Face", part: "Head", selection: "face"},
        HitNeck: {label: "Neck", part: "Head", selection: "neck"},
        HitChest: {label: "Chest", part: "Body", selection: "spine3"},
        HitDiaphragm: {label: "Diaphragm", part: "Body", selection: "spine2"},
        HitAbdomen: {label: "Abdomen", part: "Body", selection: "spine1"},
        HitPelvis: {label: "Pelvis", part: "Body", selection: "pelvis"},
        HitLeftArm: {label: "Left arm", part: "LeftArm", selection: "leftforearm"},
        HitRightArm: {label: "Right arm", part: "RightArm", selection: "rightforearm"},
        HitLeftLeg: {label: "Left leg", part: "LeftLeg", selection: "leftleg"},
        HitRightLeg: {label: "Right leg", part: "RightLeg", selection: "rightleg"},
    };

    // ------------------------------------------------------------------ settings
    // Defaults used when the extracted data has no value. Keys match the CBA setting names.
    const FALLBACK_SETTINGS = {
        ace_medical_playerDamageThreshold: 1,
        ace_medical_AIDamageThreshold: 1,
        ace_medical_alternateArmorPenetration: true,
        ace_medical_fatalDamageSource: 2,
        ace_medical_deathChance: 1,
        ace_medical_fractures: 1,
        ace_medical_fractureChance: 0.8,
        ace_medical_limping: 1,
        ace_medical_painUnconsciousThreshold: 0.5,
        ace_medical_painUnconsciousChance: 0.1,
        ace_medical_painCoefficient: 1,
        ace_medical_bleedingCoefficient: 1,
        ace_medical_useLimbDamage: 0,
        ace_medical_limbDamageThreshold: 5,
        ace_medical_statemachine_fatalInjuriesPlayer: FATAL_INJURIES_ALWAYS,
        ace_medical_const_penetrationThreshold: 0.35,
        ace_medical_const_headDamageThreshold: 1,
        ace_medical_const_organDamageThreshold: 0.6,
        ace_medical_const_heartHitChance: 0.05,
        ace_medical_const_limpingDamageThreshold: 0.3,
        ace_medical_const_fractureDamageThreshold: 0.5,
        kat_breathing_enable: true,
        kat_breathing_pneumothoraxDamageThreshold: 0.4,
        kat_breathing_pneumothoraxDamageThreshold_TakenDamage: true,
        kat_breathing_pneumothoraxChance: 5,
        kat_breathing_deepPenetratingInjuryChance: 30,
        kat_circulation_tamponadeChance: 10,
        HOV_HUD_ONLY: false,
        HOV_MELEE_ARMOR_SCALE: 500,
        // Engine assumptions (not game settings)
        engine_damageScale: 0.91,
        engine_speedCapRatio: 0.89,
        engine_speedExponent: 0.5,
        engine_penLossLimb: 172,
        engine_torsoStops: true,
        engine_applyMinimalHit: true,
        engine_hitpointTest: "ray",
        engine_hitpointFalloff: false,
        engine_hitpointRadiusScale: 1.25,
        engine_standingCeiling: 1.90,
        engine_blastFalloffEnd: 1.7,
        ace_medical_statemachine_AIUnconsciousness: true,
        ace_medical_statemachine_fatalInjuriesAI: FATAL_INJURIES_ALWAYS,
    };

    const ENGINE_KEYS = ["engine_damageScale", "engine_speedCapRatio", "engine_speedExponent", "engine_penLossLimb",
        "engine_torsoStops", "engine_applyMinimalHit", "engine_hitpointTest", "engine_hitpointFalloff",
        "engine_hitpointRadiusScale", "engine_standingCeiling", "engine_blastFalloffEnd"];
    const FATAL_INJURY_LABELS = ["Always", "In cardiac arrest only", "Never"];

    // SQF variable names are case-insensitive (`HOV_MK7_HELMETS` is read as `HOV_MK7_helmets`)
    function caseless(values) {
        const store = {};
        for (const key of Object.keys(values)) store[key.toLowerCase()] = values[key];
        return new Proxy(store, {
            get: function (target, key) { return typeof key === "string" ? target[key.toLowerCase()] : undefined; },
            has: function (target, key) { return typeof key === "string" && key.toLowerCase() in target; },
        });
    }

    // Assign `extra` onto `target`, replacing keys that differ only in case (SQF names are case-insensitive)
    function mergeCaseless(target, extra) {
        const index = {};
        for (const k of Object.keys(target)) index[k.toLowerCase()] = k;
        for (const key of Object.keys(extra)) {
            const low = key.toLowerCase();
            if (index[low] !== undefined && index[low] !== key) delete target[index[low]];
            target[key] = extra[key];
            index[low] = key;
        }
        return target;
    }

    const defaultsCache = new WeakMap();
    function settingDefaults(data) {
        const cached = data && defaultsCache.get(data);
        if (cached) return Object.assign({}, cached);
        const out = computeDefaults(data);
        if (data) defaultsCache.set(data, out);
        return Object.assign({}, out);
    }

    function computeDefaults(data) {
        const out = Object.assign({}, FALLBACK_SETTINGS);
        const extracted = (data && data.settings) || {};
        for (const key of Object.keys(extracted)) {
            const value = extracted[key].default;
            if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
                out[key] = value;
            }
        }
        // the extracted LIST default is a value; FATAL_INJURIES_* is a macro, keep our numeric fallback
        // Server values (an exported cba_settings.sqf) sit on top of the mod defaults
        mergeCaseless(out, (data && data.serverSettings) || {});
        for (const key of ["ace_medical_statemachine_fatalInjuriesPlayer", "ace_medical_statemachine_fatalInjuriesAI"]) {
            if (typeof out[key] !== "number") out[key] = FATAL_INJURIES_ALWAYS;
        }
        return out;
    }

    // ------------------------------------------------------------------ helpers
    function makeRng(seed) {
        let a = (seed >>> 0) || 0x9e3779b9;
        const next = function () {
            a = (a + 0x6d2b79f5) >>> 0;
            let t = a;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        return {
            random: function (max) { return next() * (max === undefined ? 1 : max); },
            // SQF `random [min, mid, max]`: Gaussian-like, approximated with a symmetric triangular distribution
            gauss: function (min, mid, max) {
                const u = next(), v = next();
                const t = (u + v) / 2;
                return t < 0.5 ? min + (mid - min) * (t * 2) : mid + (max - mid) * ((t - 0.5) * 2);
            },
            pick: function (list) { return list[Math.floor(next() * list.length)]; },
        };
    }

    function linearConversion(min, max, value, newMin, newMax, clip) {
        let result = newMin + ((value - min) / (max - min)) * (newMax - newMin);
        if (clip) {
            const lo = Math.min(newMin, newMax), hi = Math.max(newMin, newMax);
            result = Math.min(hi, Math.max(lo, result));
        }
        return result;
    }

    // fnc_interpolatePoints
    function interpolatePoints(input, points, rng, randomRound) {
        if (!points || points.length === 0) return 0;
        if (points.length === 1) return points[0][1];
        const lower = points.findIndex(function (p) { return p[0] < input; });
        if (lower === 0) return points[0][1];
        if (lower === -1) return points[points.length - 1][1];
        const upper = points[lower - 1];
        const low = points[lower];
        let output = linearConversion(low[0], upper[0], input, low[1], upper[1], true);
        if (randomRound) output = Math.ceil(output - rng.random(1));
        return output;
    }

    function sqfLog10(x) { return Math.log(x) / Math.LN10; }

    // ------------------------------------------------------------------ loadout and armor
    function resolveLoadout(data, loadout) {
        const gear = data.gear;
        const uniform = gear.uniforms[loadout.uniform] || null;
        const unit = uniform ? gear.units[uniform.unitClass] : null;
        return {
            uniformClass: loadout.uniform,
            uniform: uniform,
            unit: unit,
            vestClass: loadout.vest || "",
            vest: loadout.vest ? gear.vests[loadout.vest] || null : null,
            helmetClass: loadout.helmet || "",
            helmet: loadout.helmet ? gear.helmets[loadout.helmet] || null : null,
            backpackClass: loadout.backpack || "",
            backpack: loadout.backpack ? gear.backpacks[loadout.backpack] || null : null,
        };
    }

    // fnc_getItemArmor for one item and hitpoint
    function aceItemArmor(kind, item, unit, hitpoint) {
        if (kind === TYPE_UNIFORM) {
            if (!unit) return {armor: 0};
            const hp = unit.hitpoints[hitpoint];
            return {armor: unit.armor * Math.max(1, hp ? hp.armor : 0)};
        }
        const entry = item && item.protection ? item.protection[hitpoint] : null;
        if (!entry) return {armor: 0};
        let armor = entry.armor;
        const passThrough = Math.min(1, Math.max(0.1, entry.passThrough));
        const step = kind === TYPE_HEADGEAR ? 2 : 4;
        let scaled = false;
        if (armor > step * 6) {
            const effect = kind === TYPE_VEST ? 0.6 : 1;
            armor = sqfLog10(armor / Math.pow(passThrough, effect)) * 10;
            scaled = true;
        }
        return {armor: armor, raw: entry.armor, passThrough: entry.passThrough, scaled: scaled};
    }

    function hitpointArmor(gear, hitpoint) {
        const uniform = aceItemArmor(TYPE_UNIFORM, gear.uniform, gear.unit, hitpoint);
        const vest = aceItemArmor(TYPE_VEST, gear.vest, gear.unit, hitpoint);
        const helmet = aceItemArmor(TYPE_HEADGEAR, gear.helmet, gear.unit, hitpoint);
        const ace = Math.max(1, uniform.armor + vest.armor + helmet.armor);
        // ENGINE ASSUMPTION: the engine adds the raw item armor to unit armor x hitpoint armor
        const engine = Math.max(1, uniform.armor + (vest.raw !== undefined ? vest.raw : vest.armor) +
            (helmet.raw !== undefined ? helmet.raw : helmet.armor));
        return {ace: ace, engine: engine, uniform: uniform, vest: vest, helmet: helmet};
    }

    // ------------------------------------------------------------------ ballistics
    function muzzleVelocity(magazine, muzzle) {
        const magSpeed = magazine.initSpeed || 0;
        const wSpeed = muzzle ? muzzle.initSpeed || 0 : 0;
        if (wSpeed > 0) return {v0: wSpeed, rule: "weapon initSpeed overrides magazine"};
        if (wSpeed < 0) return {v0: magSpeed * -wSpeed, rule: "magazine initSpeed x |weapon initSpeed|"};
        return {v0: magSpeed, rule: "magazine initSpeed"};
    }

    // dv/dt = airFriction * v^2  ->  v(x) = v0 * e^(airFriction * x)   (airFriction is negative)
    function ballistics(ammo, v0, distance) {
        const sim = ammo.simulation || "";
        const powered = sim === "shotRocket" || sim === "shotMissile";
        const friction = powered ? 0 : (ammo.airFriction || 0);
        const v = friction ? v0 * Math.exp(friction * distance) : v0;
        const time = friction ? (Math.exp(-friction * distance) - 1) / (-friction * v0) : distance / Math.max(v0, 1);
        const ttl = ammo.timeToLive || 0;
        return {
            v: v, time: time, friction: friction, powered: powered,
            outOfRange: ttl > 0 && time > ttl,
        };
    }

    // ------------------------------------------------------------------ unit state
    function newUnit(settings, isPlayer) {
        return {
            isPlayer: isPlayer,
            openWounds: {},                 // bodyPart -> [[classComplex, amountOf, bleeding, damage]]
            bodyPartDamage: [0, 0, 0, 0, 0, 0],
            fractures: [0, 0, 0, 0, 0, 0],
            pain: 0,
            // ACE medical state machine: Default/Injured -> Unconscious -> CardiacArrest -> Dead
            state: "ok",
            unconscious: false,
            cardiac: false,
            fatal: false,
            time: 0,
            deathBlockedUntil: -1,
            effects: {pneumothorax: 0, deepPenetratingInjury: 0, tamponade: 0},
            bco: null,
            hovApplyingRestDamage: false,
            damageThreshold: isPlayer ? settings.ace_medical_playerDamageThreshold : settings.ace_medical_AIDamageThreshold,
        };
    }

    function setState(unit, state) {
        unit.state = state;
        unit.unconscious = state !== "ok";
        unit.cardiac = state === "cardiac";
        unit.fatal = state === "dead";
    }

    // CriticalInjury event (Statemachine.hpp: Default/Injured -> Unconscious; AI without unconsciousness dies)
    function raiseCritical(ctx, why) {
        const unit = ctx.unit;
        if (unit.state !== "ok") return;
        if (!unit.isPlayer && !ctx.settings.ace_medical_statemachine_AIUnconsciousness) {
            setState(unit, "dead");
            ctx.note("state", "CriticalInjury -> Unconscious -> Dead (AI unconsciousness is off) (" + why + ")");
            return;
        }
        setState(unit, "unconscious");
        ctx.note("state", "CriticalInjury -> Unconscious (" + why + ")");
    }

    // FatalInjury event: FatalInjury state's SecondChance/Death, or CardiacArrest's Execution transition
    function raiseFatal(ctx, why) {
        const unit = ctx.unit;
        const s = ctx.settings;
        const setting = unit.isPlayer ? s.ace_medical_statemachine_fatalInjuriesPlayer : s.ace_medical_statemachine_fatalInjuriesAI;
        if (unit.state === "dead") return;
        if (unit.state === "cardiac") {
            if (setting !== FATAL_INJURIES_NEVER && unit.time >= unit.deathBlockedUntil) {
                setState(unit, "dead");
                ctx.note("state", "FatalInjury in cardiac arrest -> Dead (" + why + ")");
            } else {
                ctx.note("state", "FatalInjury in cardiac arrest ignored (" + (setting === FATAL_INJURIES_NEVER ? "fatal injuries: never" : "death blocked for 1 s after entering") + ")");
            }
            return;
        }
        if (setting !== FATAL_INJURIES_ALWAYS) {
            const aiDies = !unit.isPlayer && !s.ace_medical_statemachine_AIUnconsciousness;
            setState(unit, aiDies ? "dead" : "cardiac");
            unit.deathBlockedUntil = unit.time + 1;
            ctx.note("state", "FatalInjury -> second chance -> Cardiac arrest" + (aiDies ? " -> Dead (AI unconsciousness is off)" : "") + " (" + why + ")");
        } else {
            setState(unit, "dead");
            ctx.note("state", "FatalInjury -> Dead (" + why + ")");
        }
    }

    // ------------------------------------------------------------------ ACE wound handlers
    function damageTypeOf(data, ammoName) {
        const types = data.ace.damageTypes;
        if (types[ammoName]) return ammoName;
        const ammo = data.ammo[ammoName];
        const declared = ammo && ammo.ACE_damageType;
        if (!declared) return "unknown";
        return types[declared] ? declared : "unknown";
    }

    // fnc_woundsHandlerArmorPenetration
    function handlerArmorPenetration(ctx, args) {
        const s = ctx.settings;
        if (!s.ace_medical_alternateArmorPenetration) return args;
        const ammo = ctx.data.ammo[args.ammo];
        const hit = ammo ? ammo.hit || 0 : 0;
        if (hit <= 0) {
            ctx.note("armorPen", "skipped: no CfgAmmo hit for \"" + args.ammo + "\"");
            return args;
        }
        const penFactor = (ammo.caliber || 0) * ARMOR_PENETRABILITY;
        const typicalSpeed = ammo.typicalSpeed || 0;
        const top = args.allDamages[0];
        const engineDamage = top[0], bodyPart = top[1], realDamage = top[2];
        const step = bodyPart === "Body" ? 4 : 2;
        const armor = realDamage / engineDamage - UNSCALED_BASE_ARMOR;
        if (armor <= step) {
            ctx.note("armorPen", "skipped: armor " + fmt(armor) + " <= step " + step + " (treated as unarmored)");
            return args;
        }
        const level = Math.min(4, Math.max(0, Math.round((armor - step * 2) / step)));
        const thickness = ARMOR_THICKNESS[level];
        const impactSpeed = (realDamage / hit) * Math.max(typicalSpeed, 1);
        const penDepth = penFactor * impactSpeed;
        const finalDamage = (hit * Math.min(penDepth / thickness, 1)) / DAMAGE_SCALING_FACTOR;
        ctx.note("armorPen", "armor " + fmt(armor) + " -> level " + level + " (RHA " + thickness + "); " +
            "ACE impact speed " + fmt(impactSpeed) + " m/s; pen " + fmt(penFactor, 4) + " x " + fmt(impactSpeed) +
            " = " + fmt(penDepth) + "; damage = " + hit + " x min(" + fmt(penDepth / thickness, 3) + ", 1) / 10 = " + fmt(finalDamage, 3), {
            armor: armor, level: level, thickness: thickness, impactSpeed: impactSpeed, penDepth: penDepth,
            finalDamage: finalDamage, penRatio: penDepth / thickness,
        });
        top[0] = finalDamage;
        return args;
    }

    // kat_breathing fnc_woundsHandlerPulmoHit: rolls side effects, never changes wounds
    function handlerKatPulmo(ctx, args) {
        const s = ctx.settings;
        const top = args.allDamages[0];
        if (!(s.kat_breathing_enable && top[1] === "Body")) return args;
        const engineDamage = top[0];
        if (engineDamage < s.kat_breathing_pneumothoraxDamageThreshold) return args;
        let increase = 0;
        if (s.kat_breathing_pneumothoraxDamageThreshold_TakenDamage) {
            increase = linearConversion(s.kat_breathing_pneumothoraxDamageThreshold, 3, engineDamage, 0, 30, true);
        }
        const unit = ctx.unit;
        if (Math.floor(ctx.rng.random(100)) < s.kat_breathing_pneumothoraxChance + increase) {
            unit.effects.pneumothorax += 1;
            ctx.note("kat", "pneumothorax rolled (chance " + fmt(s.kat_breathing_pneumothoraxChance + increase) + "%)");
            return args;
        }
        if (Math.floor(ctx.rng.random(100)) >= s.kat_breathing_deepPenetratingInjuryChance) return args;
        unit.effects.deepPenetratingInjury += 1;
        if (Math.floor(ctx.rng.random(100)) < s.kat_circulation_tamponadeChance) unit.effects.tamponade += 1;
        return args;
    }

    // HOV_BC_fnc_armorWoundHandler: soaks non-projectile damage into Black Carapace plates
    function handlerHov(ctx, args) {
        const unit = ctx.unit;
        if (!unit.bco || !unit.bco.active) return args;
        if (ctx.settings.HOV_HUD_ONLY) return args;
        if (unit.hovApplyingRestDamage) return args;
        const scale = ctx.settings.HOV_MELEE_ARMOR_SCALE;
        if (scale <= 0) return {unit: args.unit, allDamages: [], typeOfDamage: args.typeOfDamage, ammo: args.ammo};
        const threshold = unit.bco.threshold;
        const remaining = [];
        for (const entry of args.allDamages) {
            const zone = BCO_ZONES[BODY_PART_NAMES.indexOf(entry[1])] || "body";
            const plate = unit.bco.plates[zone];
            const effective = Math.max(0, entry[0] - threshold / scale);
            if (effective <= 0) continue;
            if (effective > plate / scale) {
                unit.bco.plates[zone] = 0;
                remaining.push([effective - plate / scale, entry[1], entry[2]]);
            } else {
                unit.bco.plates[zone] = Math.max(0, plate - effective * scale);
            }
        }
        ctx.note("hov", "Black Carapace soaked scripted damage into plates");
        return {unit: args.unit, allDamages: remaining, typeOfDamage: args.typeOfDamage, ammo: args.ammo};
    }

    // fnc_determineIfFatal
    function determineIfFatal(ctx, part, bodyPartDamage, woundDamage) {
        const s = ctx.settings;
        if (part > 1 && s.ace_medical_useLimbDamage === 0) return {fatal: false, chance: 0};
        if (s.ace_medical_fatalDamageSource === 0 || s.ace_medical_fatalDamageSource === 2) {
            if (part === 0 && woundDamage >= s.ace_medical_const_headDamageThreshold) return {fatal: true, chance: 1, reason: "lethal headshot"};
            if (part === 1 && woundDamage >= s.ace_medical_const_organDamageThreshold) {
                if (ctx.rng.random(1) < s.ace_medical_const_heartHitChance) return {fatal: true, chance: s.ace_medical_const_heartHitChance, reason: "heart shot"};
            }
        }
        if (s.ace_medical_fatalDamageSource === 1 || s.ace_medical_fatalDamageSource === 2) {
            const threshold = ctx.unit.damageThreshold;
            let vital = Math.max(0, bodyPartDamage[0] - 1.25 * threshold) + Math.max(0, bodyPartDamage[1] - 1.5 * threshold);
            const useLimbs = [false, !ctx.unit.isPlayer, true][s.ace_medical_useLimbDamage];
            if (useLimbs) {
                const limb = s.ace_medical_limbDamageThreshold * threshold;
                for (let i = 2; i < 6; i++) vital += Math.max(0, bodyPartDamage[i] - limb);
            }
            const chance = 1 - Math.exp(-Math.pow(vital / WEIBULL.l, WEIBULL.k));
            if (chance > ctx.rng.random(1)) return {fatal: true, chance: chance, reason: "lethal trauma"};
            return {fatal: false, chance: chance};
        }
        return {fatal: false, chance: 0};
    }

    // fnc_handleIncapacitation
    function handleIncapacitation(ctx) {
        const unit = ctx.unit;
        const s = ctx.settings;
        let bodyDamage = unit.bodyPartDamage[1];
        for (const w of unit.openWounds.body || []) {
            if (w[3] < s.ace_medical_const_penetrationThreshold) bodyDamage -= w[1] * w[3];
        }
        const threshold = unit.damageThreshold;
        const headCrit = unit.bodyPartDamage[0] > threshold / 2;
        const bodyCrit = bodyDamage > threshold;
        const painCrit = unit.pain >= s.ace_medical_painUnconsciousThreshold && ctx.rng.random(1) < s.ace_medical_painUnconsciousChance;
        if (headCrit || bodyCrit || painCrit) {
            raiseCritical(ctx, [headCrit && "head damage > threshold/2", bodyCrit && "penetrating body damage > threshold",
                painCrit && "pain roll"].filter(Boolean).join(", "));
        }
    }

    // fnc_woundsHandlerBase
    function handlerBase(ctx, args) {
        const data = ctx.data;
        const s = ctx.settings;
        const unit = ctx.unit;
        let typeOfDamage = args.typeOfDamage;
        if (!data.ace.damageTypes[typeOfDamage]) typeOfDamage = "unknown";
        const details = data.ace.damageTypes[typeOfDamage];
        const woundNames = Object.keys(details.wounds);
        const woundIndex = Object.keys(data.ace.wounds);

        let painLevel = 0;
        let critical = false;
        let created = false;

        for (const entry of args.allDamages) {
            const damage = entry[0];
            const bodyPart = String(entry[1]).toLowerCase();
            if (bodyPart === "#structural") continue;
            const partIndex = BODY_PARTS.indexOf(bodyPart);
            if (partIndex < 0) continue;

            const nWounds = interpolatePoints(damage, details.thresholds, ctx.rng, true);
            if (nWounds < 1) {
                // ACE `continue`s here, which also skips the selectionSpecific break: the next part gets a chance
                ctx.note("base", BODY_PART_NAMES[partIndex] + ": damage " + fmt(damage, 3) + " created zero wounds");
                continue;
            }
            const dmgPerWound = damage / nWounds;
            const weighted = woundNames.map(function (name) {
                return {name: name, weight: interpolatePoints(dmgPerWound, details.wounds[name].weighting, ctx.rng, false)};
            });
            const totalWeight = weighted.reduce(function (sum, w) { return sum + Math.max(0, w.weight); }, 0);
            ctx.note("base", BODY_PART_NAMES[partIndex] + ": damage " + fmt(damage, 3) + " -> " + nWounds +
                " wound(s), " + fmt(dmgPerWound, 3) + " each; weights " + weighted.filter(function (w) { return w.weight > 0; })
                .map(function (w) { return w.name + " " + fmt(w.weight, 2); }).join(", "), {weights: weighted, nWounds: nWounds, dmgPerWound: dmgPerWound});

            for (let i = 0; i < nWounds; i++) {
                if (totalWeight <= 0) break;
                let roll = ctx.rng.random(totalWeight);
                let chosen = weighted[weighted.length - 1];
                for (const w of weighted) {
                    if (w.weight <= 0) continue;
                    if (roll < w.weight) { chosen = w; break; }
                    roll -= w.weight;
                }
                const mods = details.wounds[chosen.name];
                const wound = data.ace.wounds[chosen.name];
                const classId = woundIndex.indexOf(chosen.name);

                const woundDamage = dmgPerWound * mods.damageMultiplier * ctx.rng.gauss(0.9, 1, 1.1);
                unit.bodyPartDamage[partIndex] += woundDamage;

                const woundSize = linearConversion(0.1, WORST_DAMAGE, woundDamage * mods.sizeMultiplier,
                    Math.pow(LARGE_WOUND_THRESHOLD, 3), 1, true);
                const pain = woundSize * mods.painMultiplier * wound.pain;
                painLevel += pain;
                const bleeding = woundSize * mods.bleedingMultiplier * wound.bleeding;
                const category = Math.min(2, Math.max(0, 2 - Math.floor(Math.log(woundSize) / Math.log(LARGE_WOUND_THRESHOLD))));
                const classComplex = 10 * classId + category;

                if (bodyPart === "head" || (bodyPart === "body" && woundDamage > s.ace_medical_const_penetrationThreshold)) critical = true;

                const fatal = determineIfFatal(ctx, partIndex, unit.bodyPartDamage, woundDamage);
                if (fatal.fatal) {
                    // ACE only rolls deathChance for players; AI always raise FatalInjury
                    if (!unit.isPlayer || ctx.rng.random(1) < s.ace_medical_deathChance) raiseFatal(ctx, fatal.reason);
                    else ctx.note("state", "fatal " + fatal.reason + " ignored: player death chance roll failed");
                }

                let effect = "";
                if (wound.causeFracture && s.ace_medical_fractures > 0 && partIndex > 1 &&
                    woundDamage > s.ace_medical_const_fractureDamageThreshold &&
                    ctx.rng.random(1) < mods.fractureMultiplier * s.ace_medical_fractureChance) {
                    unit.fractures[partIndex] = 1;
                    effect = "fracture";
                } else if (wound.causeLimping && s.ace_medical_limping > 0 && partIndex > 3 &&
                    woundDamage > s.ace_medical_const_limpingDamageThreshold) {
                    effect = "limping";
                }

                const record = {part: BODY_PART_NAMES[partIndex], type: chosen.name, category: category,
                    damage: woundDamage, size: woundSize, bleeding: bleeding, pain: pain, effect: effect};
                ctx.wounds.push(record);

                // merge into an existing wound of the same class where ACE would
                const list = unit.openWounds[bodyPart] || (unit.openWounds[bodyPart] = []);
                const pen = s.ace_medical_const_penetrationThreshold;
                const limp = s.ace_medical_const_limpingDamageThreshold;
                const existing = list.find(function (w) {
                    return w[0] === classComplex &&
                        (bodyPart !== "body" || (woundDamage < pen) === (w[3] < pen)) &&
                        (partIndex > 3 || !wound.causeLimping || (woundDamage <= limp) === (w[3] <= limp));
                });
                if (existing) {
                    const n = existing[1] + 1;
                    existing[2] = (existing[1] * existing[2] + bleeding) / n;
                    existing[3] = (existing[1] * existing[3] + woundDamage) / n;
                    existing[1] = n;
                } else {
                    list.push([classComplex, 1, bleeding, woundDamage]);
                }
                created = true;
            }
            if (details.selectionSpecific > 0) break;
        }

        if (created) {
            // ace_medical_injured -> medical_status fnc_adjustPainLevel
            unit.pain = Math.min(1, Math.max(0, Math.max(unit.pain, painLevel * s.ace_medical_painCoefficient)));
            if (critical || painLevel > s.ace_medical_painUnconsciousThreshold) handleIncapacitation(ctx);
        }
        return null;
    }

    const HANDLERS = {
        ace_medical_damage_woundshandlerbase: handlerBase,
        ace_medical_damage_armorpenetration: handlerArmorPenetration,
        hov_bc_armor_wh: handlerHov,
        kat_breathing_pulmohit: handlerKatPulmo,
    };

    // fnc_woundReceived: run the damage type's handler chain (config order reversed)
    function woundReceived(ctx, allDamages, ammo) {
        // Match the battery's WOUND payload, before ACE's handlers transform it into injuries.
        ctx.woundEvents++;
        for (const [damage] of allDamages) ctx.aceDamage += damage;
        const typeOfDamage = damageTypeOf(ctx.data, ammo);
        const details = ctx.data.ace.damageTypes[typeOfDamage];
        const chain = (details.woundHandlers || []).slice().reverse();
        ctx.note("event", "woundReceived: ammo \"" + ammo + "\" -> damage type \"" + typeOfDamage + "\"; handlers " +
            chain.map(function (h) { return h[0]; }).join(" -> "));
        let args = {allDamages: allDamages.map(function (e) { return e.slice(); }), typeOfDamage: typeOfDamage, ammo: ammo};
        for (const handler of chain) {
            const fn = HANDLERS[handler[0].toLowerCase()];
            if (!fn) {
                ctx.unknownHandlers[handler[0]] = handler[2] || "?";
                continue;
            }
            const result = fn(ctx, args);
            if (result === null || result.allDamages.length === 0) break;
            args = result;
        }
    }

    // fnc_addDamageToUnit
    function addDamageToUnit(ctx, damage, bodyPart, typeOfDamage) {
        ctx.note("event", "addDamageToUnit(" + fmt(damage, 3) + ", " + bodyPart + ", \"" + typeOfDamage + "\")");
        woundReceived(ctx, [[damage, bodyPart, damage]], typeOfDamage);
    }

    // ------------------------------------------------------------------ vanilla path: engine + ACE HandleDamage
    function engineHitpointDamage(ctx, shot, hitpoint, amount, explosive) {
        const s = ctx.settings;
        const gear = ctx.gear;
        const hp = gear.unit.hitpoints[hitpoint];
        if (!hp) return null;
        const armor = hitpointArmor(gear, hitpoint);
        const shielding = explosive ? Math.max(hp.explosionShielding || 1, 1e-3) : 1;
        // ENGINE ASSUMPTION: damage = hit / armor (direct) or indirectHit x explosionShielding / armor (blast)
        let damage = (amount * (explosive ? shielding : 1) / armor.engine) * s.engine_damageScale;
        const blocked = s.engine_applyMinimalHit && damage < (hp.minimalHit || 0);
        if (blocked) damage = 0;
        return {hitpoint: hitpoint, newDamage: damage, realDamage: damage * armor.ace, armor: armor, minimalHitBlocked: blocked};
    }

    function aceAllDamages(perHitpoint) {
        const get = function (name) {
            const e = perHitpoint[name];
            return e ? [e.realDamage, e.newDamage] : [0, 0];
        };
        const maxOf = function (names) {
            const list = names.map(get);
            list.sort(function (a, b) { return b[0] - a[0] || b[1] - a[1]; });
            return list[0];
        };
        const parts = [
            ["Head", maxOf(HEAD_HITPOINTS)], ["Body", maxOf(BODY_HITPOINTS)],
            ["LeftArm", get(LIMB_HITPOINTS.LeftArm)], ["RightArm", get(LIMB_HITPOINTS.RightArm)],
            ["LeftLeg", get(LIMB_HITPOINTS.LeftLeg)], ["RightLeg", get(LIMB_HITPOINTS.RightLeg)],
        ];
        parts.sort(function (a, b) {
            return b[1][0] - a[1][0] || PRIORITY[b[0]] - PRIORITY[a[0]] || b[1][1] - a[1][1];
        });
        return parts.map(function (p) { return [p[1][1], p[0], p[1][0]]; });
    }

    function vanillaHit(ctx, shot, impacts) {
        const ammo = shot.ammo;
        const s = ctx.settings;
        const capSpeed = s.engine_speedCapRatio * ammo.typicalSpeed;
        const isBlast = shot.impact === "Blast";
        const indirect = ammo.indirectHit || 0;
        const falloff = isBlast ? shot.blastFalloff : 1;
        const splash = {};
        if (indirect > 0 && falloff > 0 && (isBlast || (ammo.explosive || 0) > 0)) {
            for (const name of Object.keys(ctx.gear.unit.hitpoints)) {
                if (IMPACTS[name]) splash[name] = engineHitpointDamage(ctx, shot, name, indirect * falloff, true);
            }
        }
        for (const impact of impacts) {
            if (isBlast || !(ammo.hit > 0)) break;
            const speedFactor = capSpeed > 0 ? Math.min(1, Math.pow(impact.v / capSpeed, s.engine_speedExponent)) : 1;
            const hitEff = ammo.hit * speedFactor;
            let reached = impact.hitpoints || [[shot.impact, 1]];
            if (isDirectHead(impact.selection, shot.impact)) {
                reached = reached.filter(([name]) => !HEAD_HITPOINTS.includes(name))
                    .concat(HEAD_HITPOINTS.map((name) => [name, 1]));
            }
            const per = {};
            let first = null;
            for (const [name, factor] of reached) {
                const one = engineHitpointDamage(ctx, shot, name, hitEff * factor, false);
                if (!one) continue;
                per[name] = one;
                if (!first || one.realDamage > first.realDamage) first = one;
            }
            const withSplash = impact === impacts.at(-1) && Object.keys(splash).length > 0;
            if (withSplash) {
                // Model the burst on contact in the final impact cycle, keeping the largest delta per hitpoint.
                for (const [name, entry] of Object.entries(splash)) {
                    if (!per[name] || per[name].newDamage < entry.newDamage) per[name] = entry;
                }
                ctx.note("engine", "blast (same round): folded into the final impact's hitpoint deltas");
            }
            if (!first && !withSplash) {
                ctx.note("engine", "direct: the round passes no hitpoint sphere: structural damage only, which ACE turns into no wound");
                ctx.note("handleDamage", "direct: structural damage only: no wound event");
            } else if (first) {
                ctx.note("engine", "direct at " + fmt(impact.v) + " m/s: hit " + fmt(ammo.hit) + " x speed factor " + fmt(speedFactor, 3) +
                    " = " + fmt(hitEff, 2) + "; " + Object.keys(per).join(", ") + "; engine armor on " + first.hitpoint + " " +
                    fmt(first.armor.engine) + " -> HandleDamage " + fmt(first.newDamage, 4) +
                    (first.minimalHitBlocked ? " (below minimalHit, ignored)" : ""),
                    {hitEff: hitEff, speedFactor: speedFactor, v: impact.v, entry: first, hitpoints: per});
            }
            if (first || withSplash) engineDamageEvent(ctx, shot, "direct", per);
        }
        if (isBlast && falloff === 0) {
            ctx.note("engine", "blast: out of range; blast does not reach the target");
        } else if (isBlast && Object.keys(splash).length) {
            ctx.note("engine", "blast: indirectHit " + fmt(indirect) + " x falloff " + fmt(falloff, 2) +
                " applied to every hitpoint x explosionShielding / armor");
            engineDamageEvent(ctx, shot, "blast", splash);
        } else if (!isBlast && !(ammo.hit > 0) && Object.keys(splash).length) {
            engineDamageEvent(ctx, shot, "blast (same round)", splash);
        }
    }

    function engineDamageEvent(ctx, shot, kind, per) {
        const allDamages = aceAllDamages(per);
        const top = allDamages[0];
        const realArmor = top[0] > 0 ? top[2] / top[0] : 0;
        ctx.note("handleDamage", kind + ": ACE picks " + top[1] + " (real damage " + fmt(top[2], 3) + " = engine " +
            fmt(top[0], 4) + " x ACE armor " + fmt(realArmor, 1) + ")", {allDamages: allDamages});
        if (top[0] <= 1e-3) {
            ctx.note("handleDamage", kind + ": below 1e-3: no wound event");
            return;
        }
        woundReceived(ctx, allDamages, shot.ammoName);
    }

    // ------------------------------------------------------------------ Black Carapace path
    function bcoTierValues(data, settings, gear) {
        const bco = data.bco;
        if (!bco) return null;
        const list = function (prefix, suffix) {
            const raw = settings[prefix + suffix];
            return typeof raw === "string" ? raw.split(",").map(function (x) { return x.trim(); }).filter(Boolean) : [];
        };
        const allUniforms = [], allHelmets = [];
        for (const t of bco.uniformTiers) allUniforms.push.apply(allUniforms, list(t, "_ARMOR"));
        for (const t of bco.helmetTiers) allHelmets.push.apply(allHelmets, list(t, "_helmets"));
        const hasUniform = allUniforms.indexOf(gear.uniformClass) >= 0;
        const hasHelmet = allHelmets.indexOf(gear.helmetClass) >= 0;
        const num = function (key, fallback) { return typeof settings[key] === "number" ? settings[key] : fallback; };
        let tier = null;
        for (const t of bco.uniformTiers) {
            if (list(t, "_ARMOR").indexOf(gear.uniformClass) >= 0) { tier = t; break; }
        }
        let helmetTier = null;
        for (const t of bco.helmetTiers) {
            if (list(t, "_helmets").indexOf(gear.helmetClass) >= 0) { helmetTier = t; break; }
        }
        const fb = bco.fallbackPlate;
        const plates = tier ? {
            body: num(tier + "_BODY_ARMOR", fb), armR: num(tier + "_ARMS_R_ARMOR", fb), armL: num(tier + "_ARMS_L_ARMOR", fb),
            legR: num(tier + "_LEGS_R_ARMOR", fb), legL: num(tier + "_LEGS_L_ARMOR", fb),
        } : {body: fb, armR: fb, armL: fb, legR: fb, legL: fb};
        plates.head = helmetTier ? num(helmetTier + "_HEAD_ARMOR", fb) : fb;
        return {
            hasUniform: hasUniform, hasHelmet: hasHelmet, tier: tier, helmetTier: helmetTier, plates: plates,
            threshold: tier ? Math.round(num(tier + "_DAMAGE_THRESHOLD", 0)) : 0,
            modifier: tier ? Math.round(num(tier + "_DAMAGE_MODIFIER", 1) * 100) / 100 : 1,
        };
    }

    function haloValues(settings, tier) {
        if (!tier || tier === "none") return {shield: 0, threshold: 0};
        const T = tier.toUpperCase();
        if (tier === "refractor") return {shield: settings.HOV_REFRACTOR_FIELD_VALUE || 500, threshold: Math.round(settings.HOV_REFRACTOR_FIELD_THRESHOLD || 0)};
        return {shield: settings["HOV_IRON_HALO_VALUE_" + T] || 500, threshold: Math.round(settings["HOV_IRON_HALO_THRESHOLD_" + T] || 0)};
    }

    function zoneOf(impact) {
        return BCO_ZONES[BODY_PART_NAMES.indexOf(IMPACTS[impact].part)];
    }

    // HOV_fnc_restDamage (ACE branch)
    function hovRestDamage(ctx, part, rest) {
        const unit = ctx.unit;
        unit.hovApplyingRestDamage = true;
        const mod = unit.bco.modifier;
        if (rest > 80) {
            ctx.note("bco", "rest " + fmt(rest) + " > 80: six 50% rolls of " + fmt(rest / 75 * mod, 3) + " \"explosion\" damage to random parts");
            for (let i = 0; i < 6; i++) {
                if (ctx.rng.random(1) < 0.5) addDamageToUnit(ctx, (rest / 75) * mod, ctx.rng.pick(BCO_EXPLOSION_PARTS), "explosion");
            }
        } else {
            ctx.note("bco", "rest " + fmt(rest) + " -> " + fmt(rest, 2) + " / 25 x modifier " + mod + " = " + fmt(rest / 25 * mod, 3) + " \"bullet\" damage to " + part);
            addDamageToUnit(ctx, (rest / 25) * mod, part, "bullet");
        }
        unit.hovApplyingRestDamage = false;
    }

    // HOV_fnc_calcDamage, direct branch
    function hovCalcDamage(ctx, impact, damage) {
        const unit = ctx.unit;
        const bco = unit.bco;
        const zone = zoneOf(impact);
        const part = IMPACTS[impact].part;
        if (ctx.magLocked) damage *= ctx.settings.HOV_MGL_DamageReduction || 1;
        const plate = bco.plates[zone];
        if (zone === "head" && !bco.hasHelmet && plate > 0) {
            ctx.note("bco", "head hit without a Black Carapace helmet: rest = min(" + damage + ", 20)");
            hovRestDamage(ctx, part, Math.min(damage, 20));
            return;
        }
        if (plate > 0) {
            const plateDamage = Math.max(0, damage - bco.threshold);
            if (plateDamage > plate) {
                bco.plates[zone] = 0;
                const rest = Math.max(0, damage - plate - bco.threshold);
                ctx.note("bco", zone + " plate " + fmt(plate) + " breaks under " + damage + "; rest " + fmt(rest));
                hovRestDamage(ctx, part, rest);
            } else {
                bco.plates[zone] = Math.max(0, plate - plateDamage);
                ctx.note("bco", zone + " plate absorbs " + fmt(plateDamage) + " (" + fmt(plate) + " -> " + fmt(bco.plates[zone]) + "); no wound");
            }
        } else {
            ctx.note("bco", zone + " plate already broken: full " + damage + " goes through");
            hovRestDamage(ctx, part, damage);
        }
    }

    // HOV_fnc_calcDamage, indirect explosive branch: wears every zone at once
    function hovBlast(ctx, indirectHit, explosive) {
        const bco = ctx.unit.bco;
        const indirect = Math.round(indirectHit);
        const parts = {head: "Head", body: "Body", armR: "RightArm", armL: "LeftArm", legR: "RightLeg", legL: "LeftLeg"};
        for (const zone of ["head", "body", "armR", "armL", "legR", "legL"]) {
            const plate = bco.plates[zone];
            const zoneDamage = Math.round(Math.max(0, indirect * explosive - bco.threshold));
            if (zoneDamage > plate) {
                bco.plates[zone] = 0;
                hovRestDamage(ctx, parts[zone], Math.max(0, indirect * explosive - plate - bco.threshold));
            } else {
                bco.plates[zone] = Math.max(0, plate - zoneDamage);
            }
        }
        ctx.note("bco", "blast: round(" + fmt(indirectHit) + ") x explosive " + fmt(explosive, 2) + " = " + fmt(indirect * explosive) + " against every plate");
    }

    // HOV_hitPartCode
    function bcoHit(ctx, shot) {
        const ammo = shot.ammo;
        const bco = ctx.unit.bco;
        const isBlast = shot.impact === "Blast";
        if (isBlast && shot.blastFalloff === 0) {
            ctx.note("bco", "blast: out of range; blast does not reach the target");
            return;
        }
        const damage = Math.round(ammo.hit || 0);
        if (!isBlast) ctx.note("bco", "HitPart: damage = round(config hit " + fmt(ammo.hit) + ") = " + damage + " (speed and distance are not used)");
        if (!isBlast && ammo.indirectHit > 0) ctx.note("bco", "blast (same round): dropped by the same-frame guard");
        const blastDamage = isBlast && (ammo.explosive || 0) > 0 ? Math.round((ammo.indirectHit || 0) * ammo.explosive) : 0;
        const shieldInput = isBlast ? blastDamage : damage;
        if (bco.shield > 0) {
            const damageShield = Math.max(0, shieldInput - bco.shieldThreshold);
            const rest = damageShield - bco.shield;
            if (rest < 0) {
                ctx.note("bco", "Iron Halo absorbs " + fmt(damageShield) + " (" + fmt(bco.shield) + " -> " + fmt(bco.shield - damageShield) + ")");
                bco.shield -= damageShield;
                return;
            }
            bco.shield = 0;
            ctx.note("bco", "Iron Halo collapses; " + fmt(rest) + " passes on");
            if (isBlast && blastDamage > 0) {
                hovBlast(ctx, (ammo.indirectHit || 0) * (rest / blastDamage), ammo.explosive);
            } else {
                // HOV_fnc_restDamageShield
                const zone = zoneOf(shot.impact);
                const plate = bco.plates[zone];
                const armorDamage = Math.max(0, rest - bco.threshold);
                if (plate > 0) {
                    if (armorDamage > plate) {
                        bco.plates[zone] = 0;
                        hovRestDamage(ctx, IMPACTS[shot.impact].part, armorDamage - plate);
                    } else {
                        bco.plates[zone] = Math.max(0, plate - armorDamage);
                    }
                } else {
                    hovRestDamage(ctx, IMPACTS[shot.impact].part, rest);
                }
            }
            return;
        }
        if (isBlast) {
            if ((ammo.explosive || 0) > 0) hovBlast(ctx, ammo.indirectHit || 0, ammo.explosive);
            else ctx.note("bco", "ammo has explosive = 0: Black Carapace ignores the blast");
            return;
        }
        hovCalcDamage(ctx, shot.impact, damage);
    }

    // ------------------------------------------------------------------ scenario
    function resolveAIUnit(data, unitClass) {
        if (unitClass === undefined || unitClass === null) return null;
        const units = data.gear.aiUnits || {};
        if (!Object.prototype.hasOwnProperty.call(units, unitClass)) throw new Error("unknown AI unit " + unitClass);
        return units[unitClass];
    }

    // ENGINE ASSUMPTION: full blast within the config radius, then linear falloff to the outer radius.
    function blastFalloff(distance, radius, endMultiplier) {
        if (distance <= radius) return 1;
        const end = radius * endMultiplier;
        if (radius <= 0 || distance >= end) return 0;
        return linearConversion(radius, end, distance, 1, 0, true);
    }

    function prepare(data, scenario) {
        const merged = settingDefaults(data);
        const overrides = scenario.settings || {};
        mergeCaseless(merged, overrides);
        const settings = caseless(merged);
        const weapon = data.weapons[scenario.weapon];
        if (!weapon) throw new Error("unknown weapon " + scenario.weapon);
        const muzzle = weapon.muzzles.find(function (m) { return m.name === scenario.muzzle; }) || weapon.muzzles[0];
        const magName = scenario.magazine || muzzle.magazines[0];
        const magazine = data.magazines[magName];
        if (!magazine) throw new Error("unknown magazine " + magName);
        const firedAmmoName = magazine.ammo;
        const firedAmmo = data.ammo[firedAmmoName];
        if (!firedAmmo) throw new Error("ammo " + firedAmmoName + " not in data");
        // Submunition ammo (pellets, bomblets): the submunition is what actually hits
        let ammoName = firedAmmoName;
        let pellets = 1;
        let pelletCone = 0;
        const sub = firedAmmo.submunitionAmmo;
        const subName = typeof sub === "string" ? sub : (Array.isArray(sub) ? sub[0] : "");
        if (subName && data.ammo[subName]) {
            ammoName = subName;
            const cone = firedAmmo.submunitionConeType;
            if (Array.isArray(cone) && typeof cone[1] === "number") pellets = cone[1];
            pelletCone = (firedAmmo.submunitionConeAngle || 0) * Math.PI / 180;
        }
        const ammo = data.ammo[ammoName];
        const aiUnit = resolveAIUnit(data, scenario.unit);
        const loadout = aiUnit || scenario.loadout || {};
        const gear = resolveLoadout(data, loadout);
        if (!gear.unit) throw new Error("uniform " + loadout.uniform + " has no unit class");
        const isPlayer = !aiUnit && scenario.target !== "ai";
        const speed = muzzleVelocity(magazine, muzzle);
        const distance = scenario.distance || 0;
        const flight = ballistics(firedAmmo.simulation === "shotSubmunitions" ? ammo : firedAmmo, speed.v0, distance);
        const bco = bcoTierValues(data, settings, gear);
        // Players run armor mode once the suit is booted; AI wearing a listed suit get it automatically
        const wantBco = isPlayer ? (scenario.mode === "bco" || (scenario.mode === "auto" && bco && bco.hasUniform)) : scenario.mode !== "vanilla";
        const halo = haloValues(settings, scenario.ironHalo);
        const ob = scenario.overrides && scenario.overrides.bco;
        if (ob && bco) {
            if (ob.plates) bco.plates = Object.assign({}, bco.plates, ob.plates);
            if (ob.threshold !== undefined) bco.threshold = ob.threshold;
            if (ob.modifier !== undefined) bco.modifier = ob.modifier;
        }
        if (ob && ob.shield !== undefined) halo.shield = ob.shield;
        if (ob && ob.shieldThreshold !== undefined) halo.threshold = ob.shieldThreshold;
        const modes = (muzzle.modes || []).filter(function (m) { return m.showToPlayer !== 0; });
        const fireMode = modes.find(function (m) { return m.name === scenario.fireMode; }) || modes[0] || (muzzle.modes || [])[0] || null;
        const impact = scenario.impact || "HitChest";
        const targetStance = scenario.target_stance ?? "standing";
        if (targetStance !== "standing" && targetStance !== "crouched") {
            throw new Error("target stance must be standing or crouched");
        }
        const headCeiling = targetStance === "standing" && isMarineModel(aiUnit?.model || gear.unit.model)
            ? settings.engine_standingCeiling : null;
        const blastDistance = Math.max(0, scenario.blastDistance || 0);
        const geometry = impact === "Blast" ? null : (scenario.geometry || null);
        const roundsPerMag = Math.max(1, Math.round(magazine.count || 1));
        const magazines = Math.max(1, Math.round(scenario.magazines || 1));
        return {
            data: data, settings: settings, weapon: weapon, muzzle: muzzle, magazineName: magName, magazine: magazine,
            ammoName: ammoName, ammo: ammo, firedAmmoName: firedAmmoName,
            pellets: scenario.pellets === undefined ? pellets : scenario.pellets, pelletsInCone: pellets, pelletCone: pelletCone,
            gear: gear, speed: speed, flight: flight, distance: distance, bco: bco, isPlayer: isPlayer,
            useBco: Boolean(wantBco && bco && bco.hasUniform && !settings.HOV_HUD_ONLY), halo: halo,
            fireMode: fireMode, reloadTime: fireMode ? fireMode.reloadTime : 0,
            dispersion: scenario.dispersion !== undefined ? scenario.dispersion : (fireMode ? fireMode.dispersion || 0 : 0),
            spreadMrad: scenario.spreadMrad || 0,
            impact: impact, geometry: geometry, aim: scenario.aim || (geometry ? hitpointCentre(geometry, gear, impact) : null),
            targetStance: targetStance, headCeiling: headCeiling,
            roundsPerMag: roundsPerMag, magazines: magazines, shots: Math.min(MAX_SHOTS, roundsPerMag * magazines),
            unit: aiUnit ? {class: scenario.unit, displayName: aiUnit.displayName, factionName: aiUnit.factionName,
                subcategory: aiUnit.subcategory} : undefined,
            blastDistance: blastDistance,
            blastFalloff: impact === "Blast" ? blastFalloff(blastDistance, ammo.indirectHitRange || 0, settings.engine_blastFalloffEnd) : 1,
            damageType: damageTypeOf(data, ammoName),
        };
    }

    function freshUnit(prep) {
        const unit = newUnit(prep.settings, prep.isPlayer);
        unit.bloodVolume = DEFAULT_BLOOD_VOLUME;
        if (prep.useBco) {
            unit.bco = {
                active: true, hasHelmet: prep.bco.hasHelmet, plates: Object.assign({}, prep.bco.plates),
                threshold: prep.bco.threshold, modifier: prep.bco.modifier,
                shield: prep.halo.shield, shieldThreshold: prep.halo.threshold,
            };
        }
        return unit;
    }

    // ------------------------------------------------------------------ shot placement
    const ZONE_IMPACT = {head: "HitHead", body: "HitChest", leftArm: "HitLeftArm", rightArm: "HitRightArm", leftLeg: "HitLeftLeg", rightLeg: "HitRightLeg"};

    function isDirectHead(selection, impact) {
        return selection === undefined ? HEAD_HITPOINTS.includes(impact) : HEAD_SELECTIONS.includes(selection);
    }

    function ceilingMessage(prep, selection) {
        return "miss: " + prep.targetStance + " head ceiling (~" + prep.headCeiling.toFixed(2) +
            " m) blocked " + selection;
    }

    function hitpointCentre(geometry, gear, impact) {
        const hp = gear.unit.hitpoints[impact];
        const pts = hp && geometry.hitpoints[String(hp.name).toLowerCase()];
        if (!pts || !pts.length) return {x: 0, y: 0.4};
        let x = 0, y = 0;
        for (const p of pts) { x += p[0]; y += p[1]; }
        const centre = {x: x / pts.length, y: y / pts.length};
        // The Mk 7 head marker can sit outside the fire mesh. Aim at the projected
        // head faces in that case, using the same reference pose for either stance.
        if (impact !== "HitHead" || raycast(geometry, centre.x, centre.y)) return centre;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < geometry.fireFaces.length; i++) {
            if ((geometry.fireSelections[i] || "").toLowerCase() !== "head") continue;
            for (const [x, y] of geometry.fireFaces[i]) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
            }
        }
        return minX === Infinity ? centre : {x: (minX + maxX) / 2, y: (minY + maxY) / 2};
    }

    // Shooter at -z looking along +z. The nearest face enters the mesh, so its winding
    // distinguishes entries from exits even if the export flips all face normals.
    function raycast(geometry, x, y, crossings) {
        let best = null;
        const faces = geometry.fireFaces;
        for (let f = 0; f < faces.length; f++) {
            const poly = faces[f];
            let crossing = null;
            for (let k = 1; k + 1 < poly.length; k++) {
                const a = poly[0], b = poly[k], c = poly[k + 1];
                const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
                if (Math.abs(den) < 1e-12) continue;
                const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / den;
                const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / den;
                const l3 = 1 - l1 - l2;
                if (l1 < 0 || l2 < 0 || l3 < 0) continue;
                const z = l1 * a[2] + l2 * b[2] + l3 * c[2];
                if (!best || z < best.z) best = {z: z, face: f};
                if (crossings && (!crossing || z < crossing.z)) crossing = {z: z, face: f, front: den < 0};
            }
            if (crossing) crossings.push(crossing);
        }
        return best;
    }

    function gaussian(rng) {
        const u = Math.max(1e-12, rng.random(1)), v = rng.random(1);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    /*
     * Where one projectile lands. ASSUMPTIONS: weapon dispersion spreads shots uniformly over a disk of
     * radius dispersion x range; shooter error is Gaussian (spreadMrad); the target faces the shooter in
     * the model's reference pose; a hitpoint takes the hit when its sphere (config radius) touches the shot
     * line inside the body.
     */
    function sampleShot(prep, rng, cone) {
        const g = prep.geometry;
        if (!g) return {impact: prep.impact, hitpoints: null, hit: true};
        const radius = (prep.dispersion + (cone || 0)) * prep.distance;
        const r = radius * Math.sqrt(rng.random(1));
        const ang = rng.random(2 * Math.PI);
        const sigma = (prep.spreadMrad / 1000) * prep.distance;
        const x = prep.aim.x + r * Math.cos(ang) + sigma * gaussian(rng);
        const y = prep.aim.y + r * Math.sin(ang) + sigma * gaussian(rng);
        const crossings = prep.useBco ? null : [];
        // All intersections of this horizontal ray have the same y. No hitpoint
        // spheres are clipped: a lower fire-geometry entry can still reach the head.
        if (prep.headCeiling !== null && y > gameToFigure([0, 0, prep.headCeiling])[1]) {
            const blocked = raycast(g, x, y);
            return {x: x, y: y, hit: false, blockedSelection: blocked ? (g.fireSelections[blocked.face] || "face") : undefined};
        }
        const ray = raycast(g, x, y, crossings);
        if (!ray) return {x: x, y: y, hit: false};
        const selection = (g.fireSelections[ray.face] || "").toLowerCase();
        const {reached, nearest} = testHitpoints(g, prep.gear, [x, y, ray.z],
             prep.settings.engine_hitpointTest, prep.settings.engine_hitpointFalloff, prep.settings.engine_hitpointRadiusScale);
        let zone = "body";
        const zs = (prep.data.bco && prep.data.bco.zoneSelections) || {};
        for (const z of Object.keys(zs)) if (zs[z].indexOf(selection) >= 0) { zone = z; break; }
        const sample = {x: x, y: y, z: ray.z, hit: true, selection: selection, hitpoints: reached,
            impact: ZONE_IMPACT[zone], nearest: nearest ? nearest.key : null};
        if (crossings) {
            const front = crossings.find((c) => c.face === ray.face).front;
            sample.entries = crossings.filter((c) => c.front === front).sort((a, b) => a.z - b.z);
        }
        return sample;
    }

    function directImpacts(prep, sample) {
        let v = prep.flight.v;
        if (!(v > 0)) return [];
        const impacts = [{z: sample.z, selection: sample.selection, v: v, hitpoints: sample.hitpoints}];
        for (const entry of sample.entries || []) {
            const prev = impacts[impacts.length - 1];
            const distance = entry.z - prev.z;
            if (distance <= 1e-6) continue; // adjoining or coincident faces at the same entry
            const torso = /^(spine|pelvis|neck)/.test(prev.selection);
            if (torso && prep.settings.engine_torsoStops) break;
            const g = prep.geometry;
            const selection = (g.fireSelections[entry.face] || "").toLowerCase();
            const loss = torso ? 785 : prep.settings.engine_penLossLimb;
            v -= distance * Math.max(0, loss);
            if (!(v > 0)) break;
            const {reached} = testHitpoints(g, prep.gear, [sample.x, sample.y, entry.z],
                 prep.settings.engine_hitpointTest, prep.settings.engine_hitpointFalloff, prep.settings.engine_hitpointRadiusScale);
            impacts.push({z: entry.z, selection: selection, v: v, hitpoints: reached});
        }
        return impacts;
    }

    function testHitpoints(geometry, gear, [x, y, z], test, falloff, radiusScale = 1) {
        const reached = [];
        let nearest = null;
        for (const key of Object.keys(IMPACTS)) {
            const hp = gear.unit.hitpoints[key];
            const pts = hp && geometry.hitpoints[String(hp.name).toLowerCase()];
            if (!pts) continue;
            const radius = hp.radius * radiusScale;
            let dist = Infinity;
            for (const p of pts) {
                const dd = test === "impact"
                    ? Math.hypot(p[0] - x, p[1] - y, p[2] - z)
                    : (p[2] >= z - radius ? Math.hypot(p[0] - x, p[1] - y) : Infinity);
                if (dd < dist) dist = dd;
            }
            if (!nearest || dist / Math.max(radius, 1e-3) < nearest.rel) nearest = {key: key, rel: dist / Math.max(radius, 1e-3)};
            if (dist <= radius) reached.push([key, falloff && radius > 0 ? Math.max(0, 1 - dist / radius) : 1]);
        }
        return {reached: reached, nearest: nearest};
    }

    function fireOne(data, prep, unit, rng, trace) {
        const ctx = {
            data: data, settings: prep.settings, gear: prep.gear, unit: unit, rng: rng, wounds: [],
            unknownHandlers: {}, trace: trace ? [] : null, magLocked: false, shots: [], woundEvents: 0, aceDamage: 0,
            note: function (stage, text, detail) {
                if (this.trace) this.trace.push({stage: stage, text: text, detail: detail || null});
            },
        };
        // Simultaneous projectiles: each is its own HandleDamage cycle, but Black Carapace's
        // HOV_hitPartCode_Running guard drops every HitPart after the first in the same frame
        const count = Math.max(1, Math.round(prep.pellets));
        let processedBco = false;
        for (let i = 0; i < count; i++) {
            const sample = sampleShot(prep, rng, count > 1 ? prep.pelletCone / 2 : 0);
            if (!prep.geometry && prep.headCeiling !== null && HEAD_HITPOINTS.includes(sample.impact)) {
                sample.hit = false;
                sample.blockedSelection = sample.impact;
            }
            ctx.shots.push(sample);
            if (count > 1) ctx.note("event", "projectile " + (i + 1) + " of " + count);
            if (prep.flight.outOfRange) {
                sample.hit = false;
                ctx.note("ballistics", "the round expires (timeToLive) before reaching the target");
                continue;
            }
            if (!sample.hit) {
                ctx.note("geometry", sample.blockedSelection ? ceilingMessage(prep, sample.blockedSelection)
                    : "miss: the round passes beside the body");
                continue;
            }
            if (sample.selection !== undefined) {
                ctx.note("geometry", "lands on " + (sample.selection || "?") + "; hitpoint spheres reached: " +
                    (sample.hitpoints.length ? sample.hitpoints.map(function (h) { return h[0] + (h[1] < 1 ? " x" + fmt(h[1], 2) : ""); }).join(", ") : "none"), sample);
            }
            const shot = {ammo: prep.ammo, ammoName: prep.ammoName, v: prep.flight.v, impact: sample.impact,
                hitpoints: sample.hitpoints, blastFalloff: prep.blastFalloff};
            if (prep.useBco) {
                if (processedBco) {
                    ctx.note("bco", "another projectile in the same frame: Black Carapace ignores it");
                    continue;
                }
                processedBco = true;
                bcoHit(ctx, shot);
            } else {
                const impacts = shot.impact === "Blast" ? [] : directImpacts(prep, sample);
                for (const impact of impacts.slice(1)) {
                    ctx.note("geometry", "continues into " + (impact.selection || "?") + " at " + fmt(impact.v) + " m/s", impact);
                }
                vanillaHit(ctx, shot, impacts);
            }
        }
        return ctx;
    }

    function bleedingRate(unit) {
        let total = 0;
        for (const part of Object.keys(unit.openWounds)) {
            for (const w of unit.openWounds[part]) total += w[1] * w[2];
        }
        return total;
    }

    function bleedTimes(bleeding, settings) {
        // blood loss (L/s) = bleeding x cardiac output x bleedingCoefficient, at a resting 80 bpm
        const lossPerSecond = bleeding * (VENTRICLE_STROKE_VOL * 80 / 60) * settings.ace_medical_bleedingCoefficient;
        if (lossPerSecond <= 0) return {lossPerSecond: 0, toClass3: Infinity, toClass4: Infinity};
        return {
            lossPerSecond: lossPerSecond,
            toClass3: (DEFAULT_BLOOD_VOLUME - BLOOD_CLASS_3) / lossPerSecond,
            toClass4: (DEFAULT_BLOOD_VOLUME - BLOOD_CLASS_4) / lossPerSecond,
        };
    }

    function woundLabel(w, data) {
        return data?.ace?.woundNames?.[w.type]?.[w.category] ||
            ["Minor", "Medium", "Large"][w.category] + " " + w.type;
    }

    /*
     * Simulate `samples` independent single hits on a fresh unit, plus a burst of `burst` hits
     * in a row on the same unit (for Black Carapace plate depletion and wound stacking).
     */
    /*
     * Copy-on-write patch of the data for one scenario, so tunables never touch the extracted data.
     * overrides: {ammo: {hit, caliber, typicalSpeed, airFriction, indirectHit, explosive},
     *             magazine: {initSpeed}, ammoByClass: {class: {...}}, magazineByClass: {class: {...}},
     *             unit: {armor}, unitHitpoint: {armor},
     *             vest: {armor, passThrough}, helmet: {armor, passThrough}   (impact hitpoint only),
     *             bco: {plates: {head, body, armL, armR, legL, legR}, threshold, modifier, shield, shieldThreshold}}
     */
    // Override maps are either {HitChest: {...}, ...} or one {...} for the scenario's impact hitpoint
    function byHitpoint(value, impact) {
        if (!value) return {};
        const keys = Object.keys(value);
        if (keys.length && keys.every(function (k) { return /^Hit/.test(k); })) return value;
        const out = {};
        out[impact] = value;
        return out;
    }

    function applyOverrides(data, scenario) {
        const o = scenario.overrides;
        if (!o) return data;
        const out = Object.assign({}, data);
        const weapon = data.weapons[scenario.weapon];
        const muzzle = weapon && (weapon.muzzles.find(function (m) { return m.name === scenario.muzzle; }) || weapon.muzzles[0]);
        const magName = scenario.magazine || (muzzle && muzzle.magazines[0]);
        const mag = data.magazines[magName];
        if (mag) {
            const classPatch = (map, name) => map && Object.hasOwn(map, name) ? map[name] : undefined;
            const magPatch = classPatch(o.magazineByClass, magName);
            if (o.magazine || magPatch) {
                out.magazines = Object.assign({}, data.magazines);
                out.magazines[magName] = Object.assign({}, mag, o.magazine, magPatch);
            }
            const ammoName = out.magazines[magName].ammo;
            const fired = data.ammo[ammoName];
            const sub = fired && fired.submunitionAmmo;
            const subName = typeof sub === "string" ? sub : (Array.isArray(sub) ? sub[0] : "");
            const ammoPatch = classPatch(o.ammoByClass, ammoName);
            const subPatch = classPatch(o.ammoByClass, subName);
            if (o.ammo || ammoPatch || subPatch) {
                out.ammo = Object.assign({}, data.ammo);
                if (fired && (o.ammo || ammoPatch)) out.ammo[ammoName] = Object.assign({}, fired, o.ammo, ammoPatch);
                // Keep carrier edits flowing to the submunition, unless that class has its own edit.
                if (subName && data.ammo[subName]) {
                    out.ammo[subName] = Object.assign({}, data.ammo[subName], o.ammo, ammoPatch, subPatch);
                }
            }
        }
        const impact = scenario.impact || "HitChest";
        if (o.unit || o.unitHitpoint || o.vest || o.helmet) {
            const lo = resolveAIUnit(data, scenario.unit) || scenario.loadout || {};
            out.gear = Object.assign({}, data.gear);
            const uniform = data.gear.uniforms[lo.uniform];
            if (uniform && (o.unit || o.unitHitpoint)) {
                out.gear.units = Object.assign({}, data.gear.units);
                const unit = Object.assign({}, data.gear.units[uniform.unitClass], o.unit || {});
                const perHp = byHitpoint(o.unitHitpoint, impact);
                if (Object.keys(perHp).length) {
                    unit.hitpoints = Object.assign({}, unit.hitpoints);
                    for (const hp of Object.keys(perHp)) {
                        if (unit.hitpoints[hp]) unit.hitpoints[hp] = Object.assign({}, unit.hitpoints[hp], perHp[hp]);
                    }
                }
                out.gear.units[uniform.unitClass] = unit;
            }
            for (const kind of ["vest", "helmet"]) {
                const table = kind === "vest" ? "vests" : "helmets";
                const item = data.gear[table][lo[kind]];
                if (!o[kind] || !item) continue;
                out.gear[table] = Object.assign({}, data.gear[table]);
                const protection = Object.assign({}, item.protection);
                const perHp = byHitpoint(o[kind], impact);
                for (const hp of Object.keys(perHp)) {
                    protection[hp] = Object.assign({armor: 0, passThrough: 1, explosionShielding: 1}, protection[hp], perHp[hp]);
                }
                out.gear[table][lo[kind]] = Object.assign({}, item, {protection: protection});
            }
        }
        return out;
    }

    function simulate(rawData, scenario) {
        const data = applyOverrides(rawData, scenario);
        const prep = prepare(data, scenario);
        const samples = scenario.samples || 2000;
        const rng = makeRng(scenario.seed || 1);

        const burst = runBurst(data, prep, scenario);
        const rep = burst.representative;

        // Trace one shot of the representative run
        // Default for both the trace and the medical menu: the shot that downs him, else the last shot
        const traceShot = Math.max(1, Math.min(prep.shots, scenario.traceHit || rep.downShot || prep.shots));
        const traceUnit = freshUnit(prep);
        const traceRng = makeRng(rep.seed);
        for (let i = 1; i < traceShot; i++) { traceUnit.time = (i - 1) * prep.reloadTime; fireOne(data, prep, traceUnit, traceRng, false); }
        traceUnit.time = (traceShot - 1) * prep.reloadTime;
        const plateBefore = traceUnit.bco ? Object.assign({}, traceUnit.bco.plates, {shield: traceUnit.bco.shield}) : null;
        const traceCtx = fireOne(data, prep, traceUnit, traceRng, true);

        // Single shot on a fresh target, from the same shot cloud
        const woundCounts = {}, woundTotals = {}, hitZones = {};
        let anyWound = 0, unconscious = 0, fatal = 0, cardiac = 0, fracture = 0, pneumo = 0, deep = 0, hits = 0;
        let painSum = 0, bleedSum = 0, damageSum = 0, countSum = 0, woundEvents = 0, aceDamage = 0;
        const unknownHandlers = {};
        for (let i = 0; i < samples; i++) {
            const unit = freshUnit(prep);
            const ctx = fireOne(data, prep, unit, rng, false);
            woundEvents += ctx.woundEvents;
            aceDamage += ctx.aceDamage;
            Object.assign(unknownHandlers, ctx.unknownHandlers);
            const landed = ctx.shots.filter(function (sh) { return sh.hit; });
            if (landed.length) hits++;
            for (const sh of landed) {
                const label = sh.nearest ? IMPACTS[sh.nearest].label : (sh.impact && IMPACTS[sh.impact] ? IMPACTS[sh.impact].label : "?");
                hitZones[label] = (hitZones[label] || 0) + 1 / ctx.shots.length;
            }
            const n = ctx.wounds.length;
            countSum += n;
            if (n > 0) anyWound++;
            const seen = {};
            for (const w of ctx.wounds) {
                const key = w.part + "|" + woundLabel(w, data);
                woundTotals[key] = (woundTotals[key] || 0) + 1;
                if (!seen[key]) { seen[key] = true; woundCounts[key] = (woundCounts[key] || 0) + 1; }
                damageSum += w.damage;
            }
            if (unit.state !== "ok") unconscious++;
            if (unit.state === "cardiac") cardiac++;
            if (unit.state === "dead") fatal++;
            if (unit.fractures.some(Boolean)) fracture++;
            if (unit.effects.pneumothorax) pneumo++;
            if (unit.effects.deepPenetratingInjury) deep++;
            painSum += unit.pain;
            bleedSum += bleedingRate(unit);
        }
        const woundTable = Object.keys(woundCounts).map(function (key) {
            const parts = key.split("|");
            return {part: parts[0], wound: parts[1], chance: woundCounts[key] / samples, perHit: woundTotals[key] / samples};
        }).sort(function (a, b) { return b.chance - a.chance; });
        const meanBleed = bleedSum / samples;
        const viewImpact = IMPACTS[prep.impact] ? prep.impact : "HitChest";

        const result = {
            scenario: {
                weapon: prep.weapon.displayName, weaponClass: scenario.weapon, muzzle: prep.muzzle.name,
                magazine: prep.magazine.displayName, magazineClass: prep.magazineName, ammo: prep.ammoName,
                distance: prep.distance, impact: prep.impact, firedAmmo: prep.firedAmmoName,
                pellets: prep.pellets, pelletsInCone: prep.pelletsInCone, isPlayer: prep.isPlayer,
                impactLabel: prep.impact === "Blast" ? "Blast (indirect)" : IMPACTS[viewImpact].label,
                path: prep.useBco ? "bco" : "vanilla", damageType: prep.damageType,
                fireMode: prep.fireMode ? prep.fireMode.name : "", reloadTime: prep.reloadTime, dispersion: prep.dispersion,
                spreadMrad: prep.spreadMrad, roundsPerMag: prep.roundsPerMag, magazines: prep.magazines, shots: prep.shots,
                aim: prep.aim, geometry: Boolean(prep.geometry), unit: prep.unit, target_stance: prep.targetStance,
            },
            ammo: prep.ammo,
            blast: {
                indirectHit: prep.ammo.indirectHit || 0, indirectHitRange: prep.ammo.indirectHitRange || 0,
                explosive: prep.ammo.explosive || 0, distance: prep.blastDistance, falloff: prep.blastFalloff,
                directIncludesBlast: !prep.useBco && prep.impact !== "Blast" && prep.ammo.explosive > 0 && prep.ammo.indirectHit > 0,
            },
            ballistics: {v0: prep.speed.v0, v0Rule: prep.speed.rule, v: prep.flight.v, time: prep.flight.time,
                friction: prep.flight.friction, powered: prep.flight.powered, outOfRange: prep.flight.outOfRange,
                speedRatio: prep.ammo.typicalSpeed > 0 ? prep.flight.v / prep.ammo.typicalSpeed : 1},
            armor: prep.impact === "Blast" ? null : hitpointArmor(prep.gear, viewImpact),
            bco: prep.useBco ? {tier: prep.bco.tier, helmetTier: prep.bco.helmetTier, plates: prep.bco.plates,
                threshold: prep.bco.threshold, modifier: prep.bco.modifier, hasHelmet: prep.bco.hasHelmet,
                shield: prep.halo.shield, hitGuard: data.bco.hitGuardSeconds, reloadTime: prep.reloadTime} : null,
            bcoAvailable: Boolean(prep.bco && prep.bco.hasUniform),
            bcoBlockedBySetting: Boolean(prep.bco && prep.bco.hasUniform && prep.settings.HOV_HUD_ONLY),
            trace: traceCtx.trace, traceHit: traceShot, firstWoundHit: rep.firstWoundShot, tracePlatesBefore: plateBefore,
            traceUnit: {pain: traceUnit.pain, state: traceUnit.state, unconscious: traceUnit.unconscious, fatal: traceUnit.fatal,
                bodyPartDamage: traceUnit.bodyPartDamage.slice(), bleeding: bleedingRate(traceUnit)},
            traceWounds: traceCtx.wounds,
            traceShots: traceCtx.shots,
            stats: {
                samples: samples,
                pHit: hits / samples,
                hitZones: hitZones,
                pWound: anyWound / samples,
                meanWounds: countSum / samples,
                meanWoundEvents: woundEvents / samples,
                meanAceDamage: aceDamage / samples,
                pUnconscious: unconscious / samples,
                pCardiac: cardiac / samples,
                pFatal: fatal / samples,
                pFracture: fracture / samples,
                pPneumothorax: pneumo / samples,
                pDeepPenetrating: deep / samples,
                meanPain: painSum / samples,
                meanBleeding: meanBleed,
                bleed: bleedTimes(meanBleed, prep.settings),
                meanWoundDamage: countSum ? damageSum / countSum : 0,
            },
            woundTable: woundTable,
            burst: burst,
            view: viewState(data, prep, rep, scenario.viewShot),
            unknownHandlers: unknownHandlers,
            backpackIgnored: Boolean(prep.gear.backpackClass),
        };
        if (scenario.compareArmorPen) {
            const armorPen = !prep.settings.ace_medical_alternateArmorPenetration;
            const settings = caseless(Object.assign({}, prep.settings, {ace_medical_alternateArmorPenetration: armorPen}));
            const curves = runBurst(data, Object.assign({}, prep, {settings: settings}), scenario, true);
            const firstMedian = function (curve) {
                const i = curve.findIndex(function (p) { return p >= 0.5; });
                return i < 0 ? null : i + 1;
            };
            result.compare = Object.assign({armorPen: armorPen}, curves, {
                downShot: firstMedian(curves.pUnconsciousBy), deadShot: firstMedian(curves.pFatalBy),
            });
        }
        return result;
    }

    function snapshot(unit) {
        return {
            state: unit.state, pain: unit.pain, bodyPartDamage: unit.bodyPartDamage.slice(), fractures: unit.fractures.slice(),
            openWounds: JSON.parse(JSON.stringify(unit.openWounds)), bloodVolume: unit.bloodVolume, time: unit.time,
            bleeding: bleedingRate(unit), damageThreshold: unit.damageThreshold, isPlayer: unit.isPlayer,
            plates: unit.bco ? Object.assign({}, unit.bco.plates, {shield: unit.bco.shield}) : null,
        };
    }

    // The representative run replayed up to a shot, for the medical menu view
    function viewState(data, prep, rep, viewShot) {
        const target = Math.max(1, Math.min(prep.shots, viewShot || rep.downShot || prep.shots));
        const unit = freshUnit(prep);
        const rng = makeRng(rep.seed);
        for (let i = 0; i < target; i++) runShot(data, prep, unit, rng, i);
        const out = snapshot(unit);
        out.shot = target;
        return out;
    }

    // One shot of a burst: time, blood lost since the previous shot, then the hit
    // reloadGap: extra seconds before this shot (a magazine change); timeOffset: reload time spent so far
    function runShot(data, prep, unit, rng, index, reloadGap = 0, timeOffset = 0) {
        const dt = (index > 0 ? prep.reloadTime : 0) + reloadGap;
        unit.time = index * prep.reloadTime + timeOffset;
        if (dt > 0) unit.bloodVolume = Math.max(0, unit.bloodVolume - bloodLossPerSecond(unit, prep.settings) * dt);
        return fireOne(data, prep, unit, rng, false);
    }

    function bloodLossPerSecond(unit, settings) {
        const ratio = unit.bloodVolume / DEFAULT_BLOOD_VOLUME;
        const entering = Math.min(1, Math.max(0, (ratio - 0.5) / 0.5));
        const cardiacOutput = unit.state === "cardiac" || unit.state === "dead" ? 0 : entering * VENTRICLE_STROKE_VOL * 80 / 60;
        return bleedingRate(unit) * Math.max(cardiacOutput, 0.05) * settings.ace_medical_bleedingCoefficient;
    }

    function runBurst(data, prep, scenario, curvesOnly) {
        const shots = prep.shots;
        const runs = Math.max(30, Math.min(400, Math.round((scenario.samples || 2000) * 20 / shots)));
        const firstDown = new Array(shots + 1).fill(0);
        const firstDead = new Array(shots + 1).fill(0);
        const woundCurve = curvesOnly ? null : new Array(shots).fill(0);
        const hitCurve = curvesOnly ? null : new Array(shots).fill(0);
        const cloud = [];
        const runInfo = [];
        for (let r = 0; r < runs; r++) {
            const seed = (scenario.seed || 1) * 7919 + r * 104729;
            const runRng = makeRng(seed);
            const unit = freshUnit(prep);
            let down = -1, dead = -1, firstWound = -1;
            const plates = [];
            for (let h = 0; h < shots; h++) {
                const ctx = runShot(data, prep, unit, runRng, h);
                if (unit.state !== "ok" && down < 0) down = h;
                if (unit.state === "dead" && dead < 0) dead = h;
                if (curvesOnly) continue;
                woundCurve[h] += ctx.wounds.length;
                if (ctx.shots.some(function (sh) { return sh.hit; })) hitCurve[h]++;
                if (ctx.wounds.length && firstWound < 0) firstWound = h;
                if (r < 3) plates.push(unit.bco ? Object.assign({}, unit.bco.plates, {shield: unit.bco.shield}) : null);
                if (cloud.length < 1500 && h < prep.roundsPerMag) {
                    for (const sh of ctx.shots) if (sh.x !== undefined) cloud.push([sh.x, sh.y, sh.hit ? 1 : 0]);
                }
            }
            firstDown[down < 0 ? shots : down]++;
            firstDead[dead < 0 ? shots : dead]++;
            if (!curvesOnly) runInfo.push({seed: seed, down: down, dead: dead, firstWound: firstWound, plates: plates});
        }
        const cumulative = function (arr) {
            let acc = 0;
            return arr.slice(0, shots).map(function (n) { acc += n; return acc / runs; });
        };
        const curves = {pUnconsciousBy: cumulative(firstDown), pFatalBy: cumulative(firstDead)};
        if (curvesOnly) return curves;
        // Representative run: the one whose "down" shot is closest to the median
        const downs = runInfo.map(function (x) { return x.down < 0 ? shots : x.down; }).sort(function (a, b) { return a - b; });
        const median = downs[Math.floor(downs.length / 2)];
        let rep = runInfo[0];
        for (const x of runInfo.slice(0, 60)) {
            if (Math.abs((x.down < 0 ? shots : x.down) - median) < Math.abs((rep.down < 0 ? shots : rep.down) - median)) rep = x;
        }
        if (!rep.plates.length) {
            const unit = freshUnit(prep);
            const rr = makeRng(rep.seed);
            for (let h = 0; h < shots; h++) {
                runShot(data, prep, unit, rr, h);
                rep.plates.push(unit.bco ? Object.assign({}, unit.bco.plates, {shield: unit.bco.shield}) : null);
            }
        }
        return {
            hits: shots, shots: shots, runs: runs, interval: prep.reloadTime, roundsPerMag: prep.roundsPerMag,
            pUnconsciousBy: curves.pUnconsciousBy, pFatalBy: curves.pFatalBy,
            pHitPerShot: hitCurve.map(function (n) { return n / runs; }),
            meanWoundsPerHit: woundCurve.map(function (n) { return n / runs; }), plates: rep.plates, cloud: cloud,
            representative: {seed: rep.seed, downShot: rep.down < 0 ? 0 : rep.down + 1, deadShot: rep.dead < 0 ? 0 : rep.dead + 1,
                firstWoundShot: rep.firstWound < 0 ? 0 : rep.firstWound + 1},
        };
    }

    // The fastest mode a player can select (shortest interval, then the tighter one)
    function fastestMode(muzzle) {
        const all = muzzle.modes || [];
        const player = all.filter(function (m) { return m.showToPlayer !== 0; });
        return (player.length ? player : all).slice().sort(function (a, b) {
            return (a.reloadTime - b.reloadTime) || ((a.dispersion || 0) - (b.dispersion || 0));
        })[0] || null;
    }

    // Seconds from the first shot to shot n, with a reload at every magazine change
    function timeToShot(n, reloadTime, roundsPerMag, magazineReload) {
        return (n - 1) * reloadTime + Math.floor((n - 1) / roundsPerMag) * magazineReload;
    }

    /**
     * Weapon balancing: shots until half the simulated bursts leave the target dead (scenario.outcome "dead")
     * or down, unconscious or worse ("down"), fired in the weapon's
     * fastest player mode, with magazine reloads (and the bleeding during them) between magazines.
     * The reload is the config's magazineReloadTime or scenario.assumedReload, whichever is longer: the
     * engine takes the reload gesture's length when it is longer, and gestures are not extracted.
     */
    function shotsToKill(rawData, scenario) {
        const data = applyOverrides(rawData, scenario);
        const weapon = data.weapons[scenario.weapon];
        if (!weapon) throw new Error("unknown weapon " + scenario.weapon);
        const muzzle = weapon.muzzles.find(function (m) { return m.name === scenario.muzzle; }) || weapon.muzzles[0];
        const mode = fastestMode(muzzle);
        const prep = prepare(data, Object.assign({}, scenario, {muzzle: muzzle.name, fireMode: mode ? mode.name : undefined}));
        const magazineReload = Math.max(muzzle.magazineReloadTime || 0, scenario.assumedReload || 0);
        const runs = scenario.runs || 120;
        const cap = scenario.maxShots || MAX_SHOTS;
        const outcome = scenario.outcome === "dead" ? "dead" : "down";
        const stopWhen = outcome === "dead" ? function (u) { return u.state === "dead"; } : function (u) { return u.state !== "ok"; };
        const deadAt = new Array(cap + 1).fill(0);
        let done = 0, capped = 0, fired = 0, hits = 0;
        for (let r = 0; r < runs; r++) {
            // Once over half the bursts hit the cap the median is beyond it; a clean first run of
            // EARLY_RUNS capped bursts is taken as the same answer, since capped bursts are the slowest
            if (capped > runs / 2 || (capped === EARLY_RUNS && done === EARLY_RUNS)) break;
            const rng = makeRng((scenario.seed || 1) * 7919 + r * 104729);
            const unit = freshUnit(prep);
            let shot = 0;
            while (shot < cap && !(stopWhen(unit))) {
                const reloading = shot > 0 && shot % prep.roundsPerMag === 0;
                const reloadsSoFar = Math.floor(shot / prep.roundsPerMag);
                const ctx = runShot(data, prep, unit, rng, shot, reloading ? magazineReload : 0, reloadsSoFar * magazineReload);
                if (ctx.shots.some(function (sh) { return sh.hit; })) hits++;
                fired++;
                shot++;
            }
            deadAt[stopWhen(unit) ? shot : 0]++;
            done++;
            if (!stopWhen(unit)) capped++;
        }
        let dead = 0, shots25 = null, shots50 = null, shots75 = null;
        for (let n = 1; n <= cap; n++) {
            dead += deadAt[n];
            if (shots25 === null && dead >= runs / 4) shots25 = n;
            if (shots50 === null && dead >= runs / 2) shots50 = n;
            if (shots75 === null && dead >= runs * 3 / 4) shots75 = n;
        }
        return {
            weapon: scenario.weapon, weaponName: weapon.displayName, muzzle: muzzle.name, magazine: prep.magazineName,
            magazineName: prep.magazine.displayName, ammo: prep.firedAmmoName,
            fireMode: mode ? mode.name : "", reloadTime: prep.reloadTime, roundsPerMag: prep.roundsPerMag,
            magazineReload: magazineReload, runs: done, maxShots: cap, outcome: outcome, pByCap: dead / done,
            shots50: shots50,
            ttk: shots50 === null ? null : timeToShot(shots50, prep.reloadTime, prep.roundsPerMag, magazineReload),
            shots25: shots25, shots75: shots75,
            ttk25: shots25 === null ? null : timeToShot(shots25, prep.reloadTime, prep.roundsPerMag, magazineReload),
            ttk75: shots75 === null ? null : timeToShot(shots75, prep.reloadTime, prep.roundsPerMag, magazineReload),
            spread: shots25 === null || shots75 === null ? null : shots75 / shots25,
            pHit: fired ? hits / fired : 0,
        };
    }

    function fmt(value, digits) {
        if (value === Infinity) return "inf";
        if (typeof value !== "number" || isNaN(value)) return String(value);
        const d = digits === undefined ? 1 : digits;
        return Number(value.toFixed(d)).toString();
    }

    return {
        simulate: simulate,
        shotsToKill: shotsToKill,
        fastestMode: fastestMode,
        timeToShot: timeToShot,
        applyOverrides: applyOverrides,
        prepare: prepare,
        settingDefaults: settingDefaults,
        hitpointArmor: hitpointArmor,
        resolveLoadout: resolveLoadout,
        damageTypeOf: damageTypeOf,
        IMPACTS: IMPACTS,
        GAME_TO_FIGURE: GAME_TO_FIGURE,
        gameToFigure: gameToFigure,
        sampleShot: sampleShot,
        testHitpoints: testHitpoints,
        blastFalloff: blastFalloff,
        raycast: raycast,
        ENGINE_KEYS: ENGINE_KEYS,
        FATAL_INJURY_LABELS: FATAL_INJURY_LABELS,
        WEIBULL: WEIBULL,
        fmt: fmt,
        woundLabel: woundLabel,
    };
});
