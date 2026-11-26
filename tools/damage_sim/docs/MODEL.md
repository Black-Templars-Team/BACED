# The damage model

`damage_model.js` follows one projectile from the muzzle to ACE's medical state. Each stage is a port of mod
code (ACE3, Black Carapace Overhaul, KAT), or, where Arma's engine is closed source, an **engine assumption**
with a scale setting that can be calibrated. ACE references are to the `master` branch of this repository; the
installed ACE medical functions were compared with it and are identical apart from line endings.

Confidence: **exact** = ported from source; **assumed** = engine behaviour not public; **approx** = simplified on
purpose.

## 1. Weapon, ammunition and flight

| Step | Rule | Confidence |
|---|---|---|
| Muzzle velocity | weapon `initSpeed` > 0 replaces the magazine's; < 0 multiplies it; 0 uses the magazine's | exact (config rule) |
| Submunitions | when the fired ammo has `submunitionAmmo`, the submunition hits; pellet count from `submunitionConeType[1]`, cone from `submunitionConeAngle` | exact (config) |
| Velocity at range | `v = v0 * exp(airFriction * d)` from `dv/dt = airFriction * v²`; no gravity; rockets and missiles keep launch speed | approx |
| Range limit | the round expires when flight time exceeds `timeToLive` | exact |
| Fire rate | the chosen fire mode's `reloadTime` between shots; bursts are whole magazines (`count`), capped at 600 shots | exact (config) |

## 2. Where the round lands (with `body_geometry.js`)

| Step | Rule | Confidence |
|---|---|---|
| Dispersion | uniform over a disk of radius `mode.dispersion × range`, plus Gaussian aim error σ = `spreadMrad / 1000 × range` | assumed |
| Pose | target faces the shooter in the model's reference pose (arms out), not an animation | approx |
| Hit test | engine path visits ordered entry faces along the shot line (inferred from consistent polygon winding); Black Carapace uses only the first face | approx (no animation) |
| Hitpoints reached | each impact independently tests config hitpoint spheres scaled by `engine_hitpointRadiusScale` (1.25): forward shot line (`engine_hitpointTest = "ray"`) or impact point (`"impact"`), with optional linear falloff (`engine_hitpointFalloff`, off by default) | calibrated approximation |
| No hitpoint reached | structural damage only, which ACE turns into no wound | assumed |

Without geometry, the chosen hitpoint takes a single direct impact.

## 3a. Suit off or HUD-only: engine and ACE HandleDamage

| Step | Rule | Source | Confidence |
|---|---|---|---|
| Penetration | `engine_torsoStops = true` stops the round at a spine, pelvis or neck entry. Otherwise, subtract distance × loss: `engine_penLossLimb` (172 m/s per m) for limbs, 785 for torso when stopping is disabled. Stop at nonpositive speed. | WB Mk 4 A-pose hit counts and rifle-pose surface medians | calibrated approximation |
| Engine hitpoint damage | `hit × min(1, (v / (engine_speedCapRatio × typicalSpeed))^engine_speedExponent) × engine_damageScale / engineArmor`; defaults 0.89, 0.5 and 0.91, respectively. `engineArmor = unit armor × hitpoint armor + raw vest armor + raw helmet armor`; dropped below `minimalHit` | WB Mk 4 torso cycles, BI protection docs | calibrated speed curve |
| Explosive rounds | Splash uses `indirectHit × explosionShielding / engineArmor` on each supported hitpoint. A direct round keeps the larger of direct and splash deltas per hitpoint in its final cycle. | WB Mk 4 A-pose WOUND counts | grouping is a model approximation |
| ACE armor | uniform: `unit armor × max(1, hitpoint armor)`; vest/helmet item above `step × 6` (step 4, or 2 for headgear): `log10(armor / passThrough^k) × 10`, k = 0.6 for vests, 1 otherwise; total at least 1 | `medical_engine fnc_getItemArmor`, `fnc_getHitpointArmor` | exact |
| Real damage | `engine damage × ACE armor`; body part = the one with the highest real damage (head = max of face, neck, head; torso = max of pelvis, abdomen, diaphragm, chest; HitBody excluded); ties by priority | `medical_engine fnc_handleDamage` | exact |
| Minimum | no wound event when the top engine damage ≤ 0.001 | same | exact |

The engine uses raw item armor while ACE log-scales it. With very high item armor, ACE's real damage, and
therefore its impact speed estimate in step 4, ends up far below what the engine used.

## 3b. Suit on: Black Carapace Overhaul armor mode

Active for players whose suit has booted and for AI wearing a listed uniform, unless `HOV_HUD_ONLY` is true. In
armor mode the unit has `allowDamage false`, so steps 3a never run for real projectiles.

| Step | Rule | Source (HOV scripts) |
|---|---|---|
| Tier | first uniform list (`<TIER>_ARMOR`) containing the uniform, in the order of `HOV_fnc_setArmorValues`; plates `<TIER>_BODY/ARMS_R/ARMS_L/LEGS_R/LEGS_L_ARMOR`; head plate from the helmet list; listed-but-untiered gear gets 5000 | `HOV_fnc_setArmorValues` |
| Damage | `round(config hit)`; speed and range do not matter | `HOV_hitPartCode` |
| Same-frame guard | a second HitPart while the first is still processing is dropped, so only one pellet of a shotgun counts, and an explosive round's splash is dropped after its direct hit | `HOV_hitPartCode` |
| Iron Halo | shield absorbs `(damage − shieldThreshold)`; overflow goes to the plate | `HOV_hitPartCode`, `HOV_fnc_restDamageShield` |
| Plate | absorbs `damage − threshold`; when that exceeds the plate, the plate breaks and `rest = damage − plate − threshold` goes on; a broken plate passes the full damage | `HOV_fnc_calcDamage` |
| Head without a listed helmet | `rest = min(damage, 20)` while the head plate is up | `HOV_fnc_calcDamage` |
| Blast hit | `round(indirectHit) × explosive` against all six plates, no distance falloff | `HOV_fnc_calcDamage` |
| Rest to ACE | rest ≤ 80: `addDamageToUnit(rest / 25 × modifier, part, "bullet")`; rest > 80: six 50% rolls of `rest / 75 × modifier` as `"explosion"` to a random head, torso or arm | `HOV_fnc_restDamage` |
| Scripted damage | `HOV_BC_fnc_armorWoundHandler` soaks non-projectile damage into the plates at `HOV_MELEE_ARMOR_SCALE` | `HOV_BC_ACEMedical` |

Note: a plate that breaks exactly sends `rest = 0`, and ACE still makes one minor wound from a zero-damage
`addDamageToUnit`.

### Direct hit vs blast

An explosive round (`explosive > 0`, `indirectHit > 0`) that hits directly runs a HandleDamage cycle at
each positive-speed entry with the suit off, folding full-strength splash into the final cycle.
With Black Carapace on, only the first direct hit counts because HOV's
same-frame guard drops the splash after processing the direct hit.

"Blast only" = the round bursts next to the target without hitting it (near miss / ground hit): only
`indirectHit` applies, scaled by the falloff **ENGINE ASSUMPTION**
`engine_blastFalloffEnd` (full within `indirectHitRange`, linear to 0 at
`indirectHitRange × engine_blastFalloffEnd`, default 1.7 from run 2). Black Carapace uses the configured
`indirectHit` without falloff but nothing past the outer radius. Bolter rounds have a small
`indirectHitRange` (e.g. 0.3 m), so their splash reaches only ~0.51 m.

The ACE armor penetration comparison (`--compare-armor-pen`) reruns the burst with the setting flipped.
With Black Carapace armor mode it has no effect because rest damage goes through `addDamageToUnit`, where
the real/engine ratio is 1 and the handler skips.

## 4. ACE wound handlers

`ace_medical_woundReceived` runs the damage type's handlers in reverse config order. With the BT preset, bullets
run **KAT pulmoHit → ACE armor penetration → Black Carapace → ACE base**.

| Handler | Rule | Source | Confidence |
|---|---|---|---|
| Damage type | `ACE_damageType` of the ammo (inherited); unknown or missing types become `"unknown"`; Black Carapace's `"explosion"` is unknown | `medical_damage fnc_getTypeOfDamage` | exact |
| KAT pulmoHit | torso, engine damage ≥ threshold: pneumothorax at `chance + linear(threshold..3 → 0..30)` %, else deep penetrating injury, then tamponade; never changes wounds | `kat_breathing fnc_woundsHandlerPulmoHit` | exact |
| Armor penetration (when `ace_medical_alternateArmorPenetration`) | `armor = real / engine − 2`; skip when ≤ step (4 torso, 2 elsewhere); level = `round((armor − 2·step) / step)` capped 0..4 → RHA 6/15/21/40/55; `impactSpeed = real / hit × typicalSpeed`; `pen = caliber × 0.015 × impactSpeed`; damage = `hit × min(pen / RHA, 1) / 10` | `fnc_woundsHandlerArmorPenetration` | exact |
| Base | wound count from `thresholds` (random rounding); per wound: type by weighted random on `weighting`, damage × multiplier × ~U(0.9..1.1), size = `linear(0.1..2 → 0.125..1)`, pain and bleeding = size × multiplier × class value, Minor/Medium/Large from size; merging into existing wounds | `fnc_woundsHandlerBase`, `fnc_interpolatePoints` | exact (SQF's Gaussian `random [a,b,c]` approximated by a triangle) |
| Fractures, limping | limbs, damage > 0.5 (fracture, roll `fractureChance × multiplier`) or legs > 0.3 (limping) | `fnc_woundsHandlerBase` | exact |
| Fatal check | per wound: head ≥ 1 (vital shots), torso ≥ 0.6 with a 5% heart roll, or Weibull on summed trauma above 1.25×/1.5× threshold | `fnc_determineIfFatal` | exact |
| Pain | `pain = max(pain, sum of wound pain × painCoefficient)`, capped at 1 | `medical_status fnc_adjustPainLevel` | exact |

## 5. ACE state machine

| Event | Player | AI | Source |
|---|---|---|---|
| Damage threshold | `playerDamageThreshold` | `AIDamageThreshold` | `GET_DAMAGE_THRESHOLD` |
| CriticalInjury (head damage > threshold/2, penetrating torso damage > threshold, or pain roll) | Unconscious | Unconscious, or Dead when `AIUnconsciousness` is off | `fnc_handleIncapacitation`, `Statemachine.hpp` |
| Fatal wound | raised only on a `deathChance` roll | always raised | `fnc_woundsHandlerBase` |
| FatalInjury | Dead when `fatalInjuriesPlayer` = Always; otherwise second chance → cardiac arrest (death blocked for 1 s) | same with `fatalInjuriesAI` | `fnc_conditionSecondChance`, `fnc_transitionSecondChance` |
| FatalInjury in cardiac arrest | Dead unless the setting is Never | same | `fnc_conditionExecutionDeath` |
| Limb trauma in the fatal sum | `useLimbDamage` = 2 | `useLimbDamage` ≥ 1 | `fnc_determineIfFatal` |

"Down" on the page means any state other than conscious (unconscious, cardiac arrest or dead).

## 6. Bleeding and the medical menu

- Blood loss per second between shots: `Σ(bleeding × amount) × cardiac output × bleedingCoefficient`, cardiac
  output `0.095 × 80 / 60` scaled by `linear(blood 50..100% → 0..1)`, minimum 0.05 (`medical_status
  fnc_getBloodLoss`, `fnc_getCardiacOutput`). Heart rate is held at 80; vitals feedback is not simulated (approx).
- The medical menu replica follows `medical_gui fnc_updateBodyImage` and `fnc_updateInjuryList`: a part with
  bleeding takes the blood-loss colour (`loss / 0.5` over 10 steps), otherwise the damage colour (damage over the
  part's threshold, `/ 0.8` over 10 steps); fractured limbs draw the bone layer red; the list shows bleeding rate
  (`showBleeding`), blood-loss class, IV, pain (only while awake), the part name, "Fractured", and
  `"Nx <wound name>"` with ACE's English names. Colours come from the `ace_medical_gui_*Color_*` settings.

## 7. Statistics

`simulate` runs:

- **single shots** on an unhurt target (`samples`, default 2000): hit rate, wound table, chances of each outcome,
  and per-round ACE event count (`meanWoundEvents`) and summed event input damage (`meanAceDamage`, before the wound handlers);
- **bursts** of the whole magazine count, `runs = clamp(samples × 20 / shots, 30, 400)`; the curves are
  cumulative: `pUnconsciousBy[i]` is the share of bursts already down by shot `i + 1`;
- a **representative burst**: the one whose down shot is closest to the median (from the first 60 runs).
  The trace and the medical menu replay it to the inspected shot (default: its down shot, else the last shot).

Seeds make every result reproducible (`seed`, default 1).

## Settings the model reads

ACE: `playerDamageThreshold`, `AIDamageThreshold`, `alternateArmorPenetration`, `fatalDamageSource`,
`deathChance`, `fractures`, `fractureChance`, `limping`, `painUnconsciousThreshold`, `painUnconsciousChance`,
`painCoefficient`, `bleedingCoefficient`, `useLimbDamage`, `limbDamageThreshold`,
`statemachine_fatalInjuriesPlayer`, `statemachine_fatalInjuriesAI`, `statemachine_AIUnconsciousness`,
`gui_showBleeding`, `gui_showBloodlossEntry`, `gui_*Color_*`, and the `const_*` thresholds (defaults from
`script_macros_medical.hpp`).
KAT: `kat_breathing_enable`, `pneumothoraxChance`, `pneumothoraxDamageThreshold(_TakenDamage)`,
`deepPenetratingInjuryChance`, `kat_circulation_tamponadeChance`.
Black Carapace: `HOV_HUD_ONLY`, `HOV_MELEE_ARMOR_SCALE`, the per-tier `_ARMOR`, `_helmets`, plate, threshold and
modifier settings, Iron Halo value and threshold.
Engine assumptions (not game settings): `engine_damageScale`, `engine_speedCapRatio`, `engine_speedExponent`,
`engine_penLossLimb`, `engine_torsoStops`, `engine_applyMinimalHit`,
`engine_hitpointTest`, `engine_hitpointFalloff`, `engine_hitpointRadiusScale`, `engine_standingCeiling`,
`engine_blastFalloffEnd`.

The defaults come from three `CTR_Bolt_Round` runs against `30k_Steve_Tactical_Legionary_MK_4_WB`:
`tests/fixtures/battery-wb-mk4.rpt` (rifle pose), `tests/fixtures/battery-wb-mk4-apose.rpt` (unarmed A-pose,
like the arms-out body figure), and `tests/fixtures/battery-wb-mk4-aim.rpt` (runtime aim points). The fitter
pools mapped torso cycles from the latest run in each RPT, fitting 50 m/s bin medians and downweighting
bins with more scatter. The pooled fit gives scale 0.91, cap ratio 0.89 and exponent 0.5.

In run 2, 130 of 144 direct/range rounds recorded one hit, and the speed-group averages were about
1.6–1.9 ACE event damage and 1.0–1.3 WOUND events per round. Blast peak deltas were 1.81 at 0.005 m,
1.14 at 0.26 m, 0.07 at 0.50 m, and near zero from 0.75 m (0.3 m indirect radius).
In run 3, all 15 chest-aimed shots hit `spine3`. The head shots still missed: the `head` selection position
is below and in front of the head hit volume, whose top is at model z = 2.27.

### Shared marine geometry and spread

Marines share the Mk 7 fire mesh and hitpoint layout; their visual LODs differ. RPT positions are game
model metres `[right, forward, up]`, with feet at zero. The p3d figure mirrors right, uses its second
axis for height with a mid-body origin, and its third axis for depth. `GAME_TO_FIGURE` maps points to
`[-right, up - 1.32, -forward]`. The two A-pose fixtures select this transform by exact nearest-face
selection agreement on the 1.00-1.60 m grid (0.01 m steps, both depth signs): 242/363 overall (66.7%),
242/265 torso/legs (91.3%), 0/98 arms. Animated forearms sit closer to the torso than the reference pose.

The best unscaled torso/leg fit was ray/no falloff at 55.3% damage-weighted overlap. A radius search
from 0.50 to 3.00 in 0.05 steps improved it to 68.0% at 1.25, still with no exact hitpoint sets.
Arm cycles are reported separately and do not drive the spread fit.

### Head impacts and target stance

On the engine path (suit off or HUD-only), a named impact on `HitHead`, `HitFace`, or `HitNeck`
without geometry, or a head/face/neck selection hit with geometry, applies the full direct amount to
all three hitpoints, each using its own armor. This is one damage cycle; ACE takes the head maximum.

In `tests/fixtures/battery-wb-mk4-headcrouch.rpt`, clean `CTR_Bolt_Round` hits gave simultaneous
`HitHead` 0.93, `HitFace` 1.73 and `HitNeck` 0.49 (about `0.865 × hit / engine armor`, with armor
75, 40 and 140 respectively). The unhelmeted face drove the Head wound, and all 24 clean hits were
lethal. The head showed no speed dependence from 400 to 1000 m/s, unlike the torso. The simulator
still uses the shared torso-calibrated speed curve for both.

In `tests/fixtures/battery-wb-mk4-headprobe.rpt`, the standing WB Mk 4 grid (A-pose and rifle pose)
registered only six nonlethal bottom-edge grazes in 112 shots. The bounding box of
`tiow_sm\marine\model\mk4_uniform.p3d` ends at the pauldrons, about 1.90 m above the model origin.
The same ceiling applies to marine body models under `tiow_sm\marine\` (including TIOW Mk 7 and WB Mk 4),
`ctr_armor\models\uniforms\` (CTR power armor), `ctr_gravis\models\uniforms\` (Gravis), and
`tda_armour\models\` (Terminator). Folder matching ignores case, slash direction and leading slashes.
Standing rays pass over faces above `engine_standingCeiling` (1.90 game model m, or 0.58 figure m).
The ceiling does not clip hitpoint spheres; lower hits can still spread to the head. Without geometry,
direct head/face/neck impacts miss while standing. `target_stance: "crouched"` removes the ceiling.
Both stances use the same Mk 7 reference figure; stance does
not change the figure's pose. If the `HitHead` aim marker misses the mesh, the simulator aims at
the center of the projected head faces instead. Set stance with `--stance` or the page's
**Target stance** control.

## Not modelled

- Other mods' damage scripts listed in the page footer (mostly vehicles, AI melee and creatures).
- Vitals over time (heart rate, blood pressure, cardiac arrest from blood loss), treatment, and bleed-out timing
  beyond the blood volume between shots.
- Hit animations and poses; projectile penetration through cover; ricochets (`deflecting`).
- Every uniform uses the one body figure in `body_geometry.js`.
