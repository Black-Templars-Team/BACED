# Architecture

```
Steam: Arma 3 + workshop mods + launcher preset          exported cba_settings.sqf
        │                                                          │
        ▼                                                          │
extract.py ── armaconfig.py (PBO, rapify, text)                    │
        │     cbasettings.py (CBA setting defaults)                │
        │     hemtt (preprocess unbinarized config.cpp)            │
        ▼                                                          ▼
data/game_data.json ──────────────► build_page.py ◄────────────────┘
        │                                │   hemtt (ACE .paa -> .png)
        │                                ▼
        │          data/page_data.js, data/server_settings.json,
        │          data/ace_body_images.js, index.html
        │                                │
        ▼                                ▼
     sim.js ──► damage_model.js ◄── app.js + page.html ◄── data/body_geometry.js (optional, supplied separately)
```

Everything under `data/` is generated, except `data/body_geometry.js`, which is supplied separately (see
below). None of `data/` is committed.

## extract.py

1. **Mod list.** Reads the launcher preset (`BT_7_31_2026.preset2` by default, `--preset` to change),
   resolving each workshop id to its name through `meta.cpp` or `mod.cpp`.
2. **Sources.** `Dta/bin.pbo`, every PBO in the platform folders loaded without `-mod`
   (`Addons`, `Argo`, `Curator`, `Enoch`, `Expansion`, `Heli`, `Jets`, `Kart`, `Mark`, `Orange`, `Tacops`,
   `Tank`, `AoW`; Contact is opt-in and left out), then every mod's PBOs in preset order.
3. **Configs.** The engine loads a config from every folder of a PBO, so each folder's `config.bin` (or a
    root `config.cpp`) becomes one addon. Binary configs go through `armaconfig.parse_rapified`; text configs are
    unpacked by `armaconfig` (hemtt's own unpacker crashes on some PBOs) and preprocessed by
    `hemtt utils config convert -f cpp`, then parsed by `armaconfig.parse_text`. hemtt's JSON output is not used
    because it loses `+=` and `delete`. Only the top-level classes the model needs are parsed
    (`KEEP_TOP` in `extract.py`: `CfgPatches`, `CfgAmmo`, `CfgMagazines`, `CfgWeapons`, `CfgVehicles`,
    `CfgGroups`, `CfgFactionClasses`, `CfgEditorCategories`, `CfgEditorSubcategories`,
    `ACE_Medical_Injuries`, `CfgMagazineWells`).
4. **Skips.** Addons with `skipWhenMissingDependencies` whose `requiredAddons` are not all present are
   dropped, as the engine does. Unreadable PBOs (obfuscated, broken includes) are listed in `skippedPbos`.
5. **Load order.** A stable depth-first topological sort on `CfgPatches.requiredAddons`, ties broken by
   discovery order (platform first, then preset order).
6. **Merge rules** (`merge()`):
   - a later addon's class patches the existing class: values and arrays replace, `+=` appends to the
     inherited value at lookup time, `delete X` removes a child class;
   - a redefinition that names a base class changes the base; one without a base keeps it;
   - `class X;` is only a forward reference and adds nothing (creating an empty class here once hid the
     marines' inherited `HitPoints`);
   - base classes resolve in the enclosing class and its inheritance first, then outward.
   Every value remembers which mod set it last (`valueSource`, `source`, `patchedBy`).
7. **Scripts and settings.** Every `.sqf/.hpp/.cpp/.inc` in mod PBOs is scanned for damage hooks
   (`HandleDamage`, `HitPart`, ACE medical overrides, `woundReceived`) and for `CBA_fnc_addSetting` calls,
   whose defaults are kept for `ace_medical*`, `kat_breathing*`, `kat_circulation*`, `HOV_*` and `SLA_*`.
   The Black Carapace tier order is read from its `HOV_fnc_setArmorValues` switch, so it follows mod updates.

## data/game_data.json

| Key | Content |
|---|---|
| `generated`, `preset`, `mods` | provenance |
| `weapons` | `class -> {displayName, type, mod, patchedBy, muzzles: [{name, displayName, initSpeed, magazineReloadTime, magazines[], modes: [{name, reloadTime, burst, dispersion, showToPlayer}]}]}`, scope 2 weapons of type 1, 2, 4 and 5 |
| `magazines` | `class -> {displayName, ammo, initSpeed, count, mod}` |
| `ammo` | `class -> {hit, indirectHit, indirectHitRange, caliber, typicalSpeed, airFriction, explosive, simulation, ACE_damageType, submunitionAmmo, ..., mod, patchedBy, valueSource}` |
| `gear.uniforms` | `class -> {displayName, unitClass, mod}` |
| `gear.units` | `unitClass -> {model, armor, armorStructural, explosionShielding, hitpoints: {HitChest: {armor, passThrough, explosionShielding, minimalHit, radius, name}}}` |
| `gear.vests`, `gear.helmets`, `gear.backpacks` | `class -> {displayName, mod, protection: {HitChest: {armor, passThrough, explosionShielding, source}}}` |
| `gear.aiUnits` | `unitClass -> {displayName, side, faction, factionName, category, subcategory, uniform, vest, helmet, backpack, mod, model}`; compacted in `page_data.js` to `[fields, {name: [vals...]}, ...]` with rehydration script |
| `groups` | list of {side, sideName, faction, factionName, category, categoryName, group, name, units: [unitClass...]}; from `CfgGroups` |
| `ace` | `wounds` (bleeding, pain, limping, fracture per wound class, in config order) and `damageTypes` (thresholds, selectionSpecific, wound weightings and multipliers, `woundHandlers` in config order with the mod that added each) |
| `settings` | CBA setting definitions: `name -> {type, default, min, max, values, mod}` |
| `bco` | Black Carapace: `uniformTiers`, `helmetTiers`, `zoneSelections` (selection name -> armor zone), `fallbackPlate`, `hitGuardSeconds` |
| `skippedPbos`, `damageScripts` | what could not be read, and which mod scripts touch damage |

## build_page.py outputs

- `data/page_data.js`: `window.GAME_DATA`, the JSON above trimmed for the browser (weapons with known ammo,
  protective gear only, relevant settings). Unit hitpoint tables are deduplicated into `gear.hitpointSets` and
  rehydrated by a line at the end of the file. It also carries `serverSettings` and `damageScriptMods`.
- `data/server_settings.json`: the parsed server export (`--server-settings`, default `~/Downloads/message.txt`).
  The model applies it on top of mod defaults (`settingDefaults`); `sim.js --mod-defaults` and the page's
  "Mod defaults" switch ignore it.
- `data/ace_body_images.js`: `window.ACE_BODY_IMAGES`, ACE's medical menu body layers
  (`background`, `head`, `torso`, `arm_left`, ..., `*_b` bones, `*_s` selection outlines, `*_t` tourniquets)
  as PNG data URIs, converted from `ace_medical_gui.pbo`.
- `data/roster.js`: `window.ROSTER = {classes: {cls: [{sheetName, generation, cert, acquisition, owner?}]},
  unmatched: [...], otherMods: [cls...], certs: {Firstborn: [...], Primaris: [...], Reliquary: [...]}}`, written by
  `rosters.py` from four public Google Sheets: the default weapons per cert and rank (Neophyte weapons count for
  every cert of their generation), the Firstborn and Primaris unlock sheets (earnable "3 Ceramite" and relic
  "3 Gold" columns), and the Reliquary (ranged weapons only). Sheet names are matched to weapon display names,
  first exactly, then without `[tag]`s, then also without `(...)` and colour suffixes, preferring classes with
  the sheet's mod tag; `roster_overrides.json` wins over all of that. `otherMods` lists player weapons from 40k
  mods (a deny list in `rosters.py` drops vanilla Arma, CUP, frameworks and terrains) that are on no list. The
  sheets are cached in `.cache/sheets/`; `--refresh-sheets` downloads them again.
- `index.html`: `page.html` inside a document skeleton. `page.html` itself is the artifact source; the artifact
  host adds its own skeleton.

## data/body_geometry.js (supplied separately)

`window.BODY_GEOMETRY`, describing the target model seen from the front (shooter at -z looking along +z,
model metres, the marine's right on screen left):

| Key | Content |
|---|---|
| `image` | PNG data URI of the front view |
| `width`, `height`, `scale`, `minx`, `maxy` | pixel mapping: `px = (x - minx) * scale`, `py = (maxy - y) * scale` |
| `fireFaces` | fire geometry polygons, each a list of `[x, y, z]` |
| `fireSelections` | bone selection of each fire face (`spine3`, `leftforearm`, ...), what `HitPart` reports |
| `hitpoints` | hitpoint selection name (`spine3`, `hand_l`, `face_hub`, ...) -> list of `[x, y, z]` sphere centres |

It is not produced by these scripts and must not be committed. Without it, the page falls back to a simple
body diagram and the model hits the chosen hitpoint directly (`sim.js --no-geometry` does the same).
The current file describes the Mk 7 marine, and every uniform uses it.

## The model and its front ends

`damage_model.js` is UMD: `require()` in Node, `window.DamageModel` in the browser. Its public API:

| Function | Purpose |
|---|---|
| `simulate(data, scenario)` | everything the page shows: single-shot statistics, burst curves, a representative burst, a trace, the medical-menu state; returns `{scenario, ammo, blast: {indirectHit, indirectHitRange, explosive, distance, falloff, directIncludesBlast}, ballistics, armor, bco, trace, stats, woundTable, burst, view, compare: {armorPen, pUnconsciousBy, pFatalBy, downShot, deadShot}, ...}` |
| `prepare(data, scenario)` | resolves weapon, ammo, loadout, settings, fire mode and Black Carapace tier, without simulating |
| `settingDefaults(data)` | fallback constants < extracted mod defaults < `data.serverSettings` |
| `applyOverrides(data, scenario)` | copy-on-write patch of ammo, magazine, unit, hitpoint, vest, helmet and Black Carapace values. `ammoByClass` and `magazineByClass` scope edits to a config class rather than the selected pair |
| `shotsToKill(data, scenario)` | fires bursts in the fastest player mode until the chosen outcome (down or dead), up to `maxShots` (600). Returns the 25%, 50% and 75% shot and time thresholds (`null` if unreached), `spread` (`shots75 / shots25` when both exist), and `pHit` (fraction of simulated shots that hit the body), plus fire mode, timing and cap data. Each reload costs `max(magazineReloadTime, scenario.assumedReload)` seconds, during which the target keeps bleeding. The model defaults to 120 bursts and may stop early on capped outcomes |
| `fastestMode(muzzle)`, `timeToShot(n, reloadTime, roundsPerMag, magazineReload)` | the mode and time formula `shotsToKill` uses |
| `hitpointArmor`, `resolveLoadout`, `damageTypeOf`, `sampleShot`, `raycast` | building blocks, used by tests and the page |

A `scenario` holds: `weapon, muzzle, magazine, fireMode, distance, magazines, spreadMrad, dispersion, target
("player"|"ai"), impact (hitpoint or "Blast"), blastDistance (metres from burst for blast-only), unit (AI
unit class, when targeting AI), aim {x, y}, geometry, loadout {uniform, vest, helmet, backpack}, mode
("auto"|"bco"|"vanilla"), ironHalo, compareArmorPen (flip ACE armor penetration and compare), settings,
overrides, samples, seed, traceHit, viewShot.

`app.js` keeps its state in `localStorage` (key `astartes-wound-bench-v2`) and calls `simulate` on every change
(debounced). On load it migrates saved ammo and magazine edits to class-keyed overrides so both tabs can use
them. On the Weapon balancing tab it calls `balance.js` instead, which runs `shotsToKill` for every
weapon and ammunition pair in a pool of Web Workers (blob workers that load `damage_model.js`,
`data/page_data.js` and `data/body_geometry.js` by URL). Where workers are refused (a page opened from
`file://`, or a host's content policy) it falls back to short slices on the page thread. Results are cached
per scenario, so switching back to an earlier scenario is instant. `state.balance` stores the view, Y picker
and log-time choice along with the other balance controls.

`balance_points.js` is UMD: `require()` in Node, `window.BalancePoints` in the browser. It builds the cert
list and simulation points from game data and the roster, merging equivalent points and assigning variant
and fire mode labels. It also owns the mod colour ranking, common row schema and CSV formatter. Load it
before `balance.js` in the page and in the generated `index.html`.

`sim.js` loads `data/game_data.json`, `data/server_settings.json` and `data/body_geometry.js`. The
`sim.js balance` command also loads the generated `data/roster.js`, reuses the `run` scenario parser and
uses `balance_points.js` for the same points and output columns as the browser table.

## Extending

- **New wound handler** from another mod: it shows up in `ace.damageTypes.*.woundHandlers`, and the model passes
  unknown handlers through unchanged and lists them on the page. Port it into `HANDLERS` in `damage_model.js`.
- **New damage script** (a mod's `HandleDamage`/`HitPart` that matters for marines): it appears in
  `damageScripts` and the page footer. Model it like the Black Carapace path (`bcoHit`).
- **Another body model**: provide a `body_geometry.js` in the format above.
- **More config values**: add the class to `KEEP_TOP` or the property to `export_ammo` / `export_gear` in
  `extract.py`, then rerun both Python steps.
