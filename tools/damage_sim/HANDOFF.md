# Handoff: Astartes Wound Bench

Status as of 2026-11-26. Start with [README.md](README.md), then [docs/MODEL.md](docs/MODEL.md).

## State

- Everything lives in `tools/damage_sim/`. Nothing is committed yet: the folder is untracked on the `fork-fixes`
  branch. Per the repository's CLAUDE.md, `baced` is the working branch, so move it there when committing.
  `data/`, `.cache/` and `index.html` are gitignored and generated.
- The page is published as a private artifact: <https://claude.ai/artifact/9r9emG12zsQFfjxST29NzU>
  (version 3). Republishing is described in [docs/PAGE.md](docs/PAGE.md).
- Inputs on this machine: Steam library `/mnt/Games/SteamLibrary/steamapps` (override with `ARMA_STEAMAPPS`),
  launcher preset `BT_7_31_2026.preset2`, server settings export `~/Downloads/message.txt`.

## Verified

| Check | How |
|---|---|
| Installed ACE medical code matches `master` | the 11 functions used were extracted from `ace_medical*.pbo` and diffed against `master`: identical apart from CRLF line endings |
| Config parsing | `tests/test_readers.py`; the binary parser checked against ACE's injuries config; text configs via hemtt |
| BACED wounds and ammo compatibility | `hemtt build`, `extract.py` and `build_page.py` loaded 31 BACED addons with the BT preset. Reader tests cover dependency skips and English names; model tests verify all five damage types, the TIOW bolt ammo patch and a suit-off CTR chest hit using `bolt`. |
| Model behaviour | `tests/model.test.js`: ACE armor, Black Carapace, shot ray-cast, all three calibration fixtures and the 100 m WB Mk 4 regression |
| Page | loaded in a headless browser with no errors; editing an inline value re-runs the page and lists the change; reviewed once by an independent agent from screenshots only, and its four accepted points were fixed |
| Weapon balancing roster and model | `tests/test_rosters.py` uses saved sheet copies. `tests/model.test.js` covers shot percentiles and hit chance, class and mode labels, class-keyed overrides, and the shared rows used by `sim.js balance`. The full data-dependent run has not been reverified in this worktree |
| Weapon balancing browser baseline | Before the redesign, headless checks at 1360 px and 390 px (light and dark) covered workers and the `file://` fallback, hover and tap tooltips, zoom, Expand, "Open in single weapon", and the other-mods toggle. See open work for redesign checks |
| Black Carapace and KAT logic | ported from the installed mod scripts (paths in docs/MODEL.md), not from documentation |

The balancing redesign browser checks below are still open.

The pooled torso fit for `CTR_Bolt_Round` against the WB Mk 4 sets the default scale/cap/exponent to
0.91/0.89/0.5. The third run (`tests/fixtures/battery-wb-mk4-aim.rpt`) used runtime aim points and hit
`spine3` on all 15 chest-aimed shots. The head shots still missed: the `head` selection position is below
and in front of the head hit volume, whose top is at model z = 2.27.

The A-pose run recorded 130 single-hit rounds out of 144 and about 1.6–1.9 ACE damage and 1.0–1.3 WOUND
events per round. Its blast fit gives a falloff endpoint of 1.7 times the 0.3 m indirect radius. The
rifle-pose log supplies the limb loss (172 m/s per metre). See the [battery findings](docs/FINDINGS.md#first-in-game-battery-wb-mk-4).

The follow-up `tests/fixtures/battery-wb-mk4-headprobe.rpt` found only six nonlethal standing grazes
in 112 shots at the ~1.90 m bounding-box ceiling. `tests/fixtures/battery-wb-mk4-headcrouch.rpt`
found 24 lethal clean hits: `HitHead` 0.93, `HitFace` 1.73 and `HitNeck` 0.49 together, with no speed
dependence from 400 to 1000 m/s. The engine path now groups those hitpoints; the unhelmeted face
drives the ACE Head wound. The shared speed curve is unchanged. `target_stance` (`--stance` / page
**Target stance**) defaults to `standing`; `crouched` disables the 1.90 m ceiling for recognized marine
models. Classification uses extracted `CfgVehicles.model` folders (see [MODEL.md](docs/MODEL.md));
re-extract before using an older page or data bundle.

## Open work, in priority order

1. **Verify and republish the balancing redesign.** With the generated data, run the model and roster
   tests, rebuild with `python3 build_page.py`, and smoke-test `sim.js balance` CSV. In the browser, verify
   the Y picker and Log time, both right-edge strips (including Castellan and the launcher-slot outlier),
   table sorting, filtering and CSV, and the effect of editing and resetting an ammo class. Then republish
   the artifact with `balance_points.js` as described in [docs/PAGE.md](docs/PAGE.md#republishing-the-artifact).
2. **Validate a head-specific speed curve.** The crouched battery is flat down to 400 m/s; collect
   slower head impacts before replacing the shared curve.
3. **Improve hitpoint spread across poses.** The shared marine mesh fits at H=1.32 m and s=-1 (66.7%
   exact selection matches overall, 91.3% torso/legs). Ray/no falloff with a 1.25 radius multiplier
   gives 68.0% torso/leg weighted overlap; arms remain at 0%. Collect more poses and ammo/target pairs.
4. **Verify the "no hitpoint reached" effect** (docs/FINDINGS.md): collect shoulder and pauldron-edge shots
   and check `calibrate`'s count and `--json` detail for `HitPart` without named damage or an ACE wound.
5. **Non-marine body figures.** `data/body_geometry.js` is shared by all marines and currently also
   used as a fallback for non-marines. Supply separate geometry for other skeleton families.
6. **Vitals over time.** Heart rate is fixed at 80; cardiac arrest from blood loss and bleed-out timing are not
   simulated past the burst.
7. **Optional page polish.** The design skill's last stage, the finish dose (none, light or medium), was not
   chosen; see `.deslop/`.
8. **Reload length.** Most weapons have `magazineReloadTime = 0`; the engine uses the reload gesture's
   length, which is not extracted. The balancing tab assumes 3 s (editable). Extracting `CfgGestures*` reload
   animations would replace the guess.
9. **Shotgun pellets do no damage.** The BT Astartes Assault Shotgun's submunition ammo has no extracted `hit`,
   so every load lands in "not down within 600 shots". Check how its pellets are configured.
10. **Roster names with no simulated weapon.** `build_page.py` lists them (11 on 2026-11-26: Primaris Heavy
    Bolter and its relic, several `[BTA] ... Relic` items, Wrath of the Righteous, Vox Honorati Mortuus, and
    Himmelswächter, whose ammo is not in the data). Map them in `roster_overrides.json` once the classes exist.
11. **Class names instead of display names.** Vanilla groups and factions have unresolved `$STR_` names, because
    stringtables are not extracted, so the page shows their class names for them.

## Decisions taken with the user

- Page role: one weapon against one marine at a time, leading with the shot that downs him, then why.
- Layout: inputs in a left column in task order, results on the right; tunable values inline next to the step
  that uses them; plain instrument-panel look, light and dark.
- Burst length is whole magazines; impact comes from a shot cloud on the real model, not a picked hitpoint.
- Player and AI targets are separate; page defaults come from the BT server's settings export.
- (2026-11-25) AI target picks a unit by Eden categories or CfgGroups. Its loadout comes from config only, so
  scripted loadouts are not seen.
- (2026-11-25) The chart can overlay the ACE armor penetration setting flipped.
- (2026-11-25) Blast-only impact takes a distance (`--blast-distance`). With the suit off, same-round splash
  is folded into the final direct impact's damage event.
- The result view replicates ACE's medical menu.
- (2026-11-26) Weapon balancing tab: X is median time to down or dead, counting reloads, linear by default
  with an optional log scale. The Y picker defaults to Consistency and also offers Magazines to down and
  Acquisition tier. Target and aim come from the shared left column. Certs are colour coded, a weapon on
  several certs is split between their colours, and Reliquary relics are their own group. Other 40k mods
  (never vanilla Arma) are an optional overlay.
- (2026-11-26) Load locally built BACED PBOs after the preset mods and respect optional compat dependencies.
  Read English wound labels from the medical stringtable and show build provenance in Data and settings.
- Black Carapace is a visible toggle (disabled when the server runs it HUD-only).
- The body figure's source model must not be committed or named anywhere in the repository.

## Pitfalls already hit (do not reintroduce)

- **SQF names are case-insensitive.** Settings are read through a case-insensitive layer
  (`HOV_MK7_HELMETS` is read as `HOV_MK7_helmets`).
- **`class X;` adds nothing.** Treating it as an empty class hid the marines' inherited `HitPoints`.
- **Configs live in every PBO folder**, not only the root (Black Carapace's ACE handler is in a subfolder).
- **hemtt's JSON output loses `+=` and `delete`**; use its `cpp` output. Its PBO unpacker crashes on some files,
  so `armaconfig` unpacks the text files itself.
- **Merging 3,600 server settings must stay linear.** A per-key scan made the page hang on load.
- **The Black Carapace hit guard only drops same-frame hits.** It is cleared as soon as a hit is processed, so
  automatic fire is not throttled.

## Commands

Start in the repository root, the directory containing `.hemtt/project.toml`:

```bash
hemtt build
cd tools/damage_sim
python3 extract.py
python3 build_page.py
python3 -m unittest discover -s tests
node --test tests/model.test.js
node sim.js run --weapon BT_TyrianBolter --distance 100 --trace
node sim.js balance --distance 100 --runs 20 --csv | head -3
```
