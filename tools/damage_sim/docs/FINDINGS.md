# Findings for the BT preset and server

What the extracted data and the ported scripts say about a Space Marine taking fire, as of the
2026-11-25 extraction (`BT_7_31_2026` preset, 187 mods) and the BT server's `cba_settings.sqf` export.
Numbers are from the tool; reproduce them with the commands shown.

## Server settings decide most of the outcome

| Setting | Server value | Effect |
|---|---|---|
| `HOV_HUD_ONLY` | `true` | Black Carapace is cosmetic only: no plates, no Iron Halo, no `allowDamage false`. Every hit goes through the engine and ACE. |
| `ace_medical_alternateArmorPenetration` | `false` | ACE's armor penetration handler is off: wound damage is the engine's hitpoint damage. |
| `kat_breathing_enable` | `false` | KAT's pneumothorax and chest injury rolls never fire. |
| `ace_medical_playerDamageThreshold` | `4` | players tolerate four times the default trauma before going unconscious. |
| `ace_medical_deathChance` | `0` | a fatal wound never raises FatalInjury on a player. With `fatalInjuriesPlayer = 2` (never), **players cannot be killed by wounds**, only by bleeding out in cardiac arrest. |
| `ace_medical_AIDamageThreshold` | `6` | AI tolerate more trauma than players. |
| `ace_medical_statemachine_AIUnconsciousness` | `false` | **an AI dies at the point a player would go unconscious**. |
| `ace_medical_statemachine_fatalInjuriesAI` | `0` (always) | AI fatal injuries kill outright. |
| `ace_medical_painCoefficient` / `bleedingCoefficient` | `0.2` / `0.5` | pain and blood loss are much lower than ACE defaults. |

## Config values are not what the mods ship

- **Vanguard TIOW Addon** overrides the TIOW Mk 7 pauldrons from `armor = 1500` to `100` on the chest,
  diaphragm and neck (and `50` on arms, abdomen, pelvis), and patches las-bolt `hit`, `caliber` and `typicalSpeed`.
  The page shows the mod that set every value.
- The Black Templars' Mk 7 uniform's unit (`TIOW_Tactical_BT_1`) has `armor = 40`; hitpoint multipliers are
  1 for chest/arms/legs and 6 for pelvis. Engine armor on the chest is 40 + 100 = **140**.
- **ACE log-scales item armor** above 24 (vests): the 100 pauldron counts as **26**, so ACE's chest armor is
  **66** while the engine's is **140**. When armor penetration is on, ACE then estimates impact speed at
  `66 / 140 ≈ 0.47` of the real speed, cutting penetration roughly in half. Raising the pauldrons back to 1500
  makes the gap worse (engine 1540, ACE ~78), so heavier armor can produce *fewer* wounds per hit than expected.

## First in-game battery: WB Mk 4

`tests/fixtures/battery-wb-mk4.rpt` records `CTR_Bolt_Round` (`hit = 80`, `typicalSpeed = 720`) against the
Word Bearers Mk 4 tactical legionary with matching uniform, pauldrons, and helmet, in HUD-only mode.

- Rounds that landed typically logged 2–4 positive-speed impacts, up to 8. The zero-speed head records
  are artifacts. The previous hit's surface predicted median speed loss: 172 m/s per metre for meat
  (0.93 speed retained per hit) and 785 for meatbones (0.65 retained).
- Torso `delta × engineArmor / hit` was about 0.90 at 500–1100 m/s, 0.76 at 300–500 m/s, and 0.43 below
  300 m/s.
- An impact often damaged several hitpoints. The struck point was not the most damaged in 83 of 244
  cycles. The fixture alone does not identify a best sphere test; it needs the matching geometry and config.
- The hand analysis found about 1.6–2.3 WOUND events and 2.5–2.8 total ACE input damage per round,
  with little change at 400–1000 m/s initial speed. Use `sim.js calibrate` to separate hit-only averages
  from averages that include misses.
- All 15 head-aimed shots missed. The model has no `neck` or `spine1` aim selection, and leg aims reached
  upper legs/pelvis. All nine blast shots logged no HandleDamage, so they cannot fit blast falloff.

## Second in-game battery: WB Mk 4 in unarmed A-pose

`tests/fixtures/battery-wb-mk4-apose.rpt` repeats the same ammo/target pair with the pose locked.

- The struck torso ratio was about 0.93 at 500–1000 m/s and 0.67 at 400 m/s; run 1 gave about 0.43
  below 300 m/s.
- 130 of 144 non-blast rounds made exactly one hit. The rifle pose put forearms in front of the torso,
  allowing limb-to-torso follow-up impacts (meat loss about 172 m/s per metre). The arms-out simulator
  now stops at torso hits by default.
- Blast peak HandleDamage deltas were 1.81 at 0.005 m, 1.14 at 0.26 m, 0.07 at 0.50 m, and near zero
  at and beyond 0.75 m. The fitted endpoint is 1.7 times the 0.3 m `indirectHitRange` (0.51 m).
- The hand analysis found about 1.6–1.9 total ACE damage and 1.0–1.3 WOUND events per round across speeds.

## Third in-game battery: WB Mk 4 with runtime aim points

`tests/fixtures/battery-wb-mk4-aim.rpt` records 15 of 15 chest-aimed shots hitting `spine3`. Head shots
still missed: the `head` selection position is below and in front of the head hit volume, whose top is at
model z = 2.27.

The torso fit pooled across all three runs sets the defaults to scale 0.91, cap ratio 0.89 (about 641 m/s
for this ammo), and exponent 0.5.

The shared Mk 7 fire mesh matches 242/363 exact selections across the A-pose and runtime-aim logs at
`[-game_x, game_z - 1.32, -game_y]`: 91.3% torso/legs and 0% arms. The overall 66.7% misses the 70%
target because the animated arms are closer to the torso. Torso/leg damage-weighted overlap for ray,
ray with falloff, impact and impact with falloff was 55.3%, 19.0%, 8.5% and 1.1% at the config radii.
At the fitted radius multiplier of 1.25, the scores are 68.0%, 30.7%, 45.1% and 6.8%, respectively;
the sim uses ray/no falloff. Arm overlap is 0% at the fitted scale.

## WB Mk 4 head probes

- `tests/fixtures/battery-wb-mk4-headprobe.rpt`: in 112 standing shots across A-pose and rifle pose,
  only six bottom-edge grazes registered and none were lethal. The body bounding box stops at the
  pauldrons (~1.90 m), below most of the standing head.
- `tests/fixtures/battery-wb-mk4-headcrouch.rpt`: below that ceiling, all 24 clean crouched
  `CTR_Bolt_Round` head hits killed. From 400 to 1000 m/s the same cycle delivered about 0.93 to
  `HitHead`, 1.73 to `HitFace`, and 0.49 to `HitNeck` (`0.865 × hit / armor`, with armor 75, 40,
  and 140). ACE's Head maximum came from `HitFace`, which the helmet does not cover. Unlike torso
  damage, the head values did not vary with speed.
- The engine path groups the three hitpoints for direct head hits. The 1.90 m standing ceiling now
  applies to every recognized marine model. Torso hits at 1.85-1.90 m can still spread up to 0.46 to
  `HitHead` in game; the simulator leaves head spheres active for lower hits. Choose `crouched`
  on the page or with `--stance crouched` to remove the ceiling rule. The speed curve is unchanged.

## Earlier example: Halbalas Hatred bolter (`BT_TyrianBolter`, standard magazine, hit 80)

Pre-calibration results. Page defaults: full auto, 100 m, aim at the chest, 2 mrad aim error, player target, server settings.

- 80% of shots land on the body; a hit makes about two wounds (medium bruise, medium velocity wound or avulsion).
- **Down at shot 9** in half of the simulated bursts; never killed (player death chance 0).
- Pauldron chest armor 100 → 400: down at shot **13**.
- AI target: **dead at about shot 8**, the same shot that would knock a player unconscious.

```bash
node sim.js run --weapon BT_TyrianBolter --distance 100 --fire-mode FullAuto --spread 2
node sim.js run --weapon BT_TyrianBolter --distance 100 --fire-mode FullAuto --spread 2 --ai
```

## If Black Carapace were active (mod defaults)

- Damage is the ammo's config `hit`, rounded. **Range and velocity do not matter.**
- Mk 7 plates: head 400, torso 600, arms and legs 300, threshold 0, modifier 1 (the server sets 1 and 0.15
  for Mk 7, unused while HUD-only).
- The bolter's 80 per hit is absorbed by the torso plate for **7 hits**; hit 8 breaks it and sends
  `(80 − 40) / 25 = 1.6` "bullet" damage into ACE, which is enough to knock the marine out.
- Only one HitPart per frame is processed: a shotgun counts one pellet, and an explosive bolt's splash is
  dropped after its direct hit.
- A plate that breaks with exactly zero overflow still produces one minor wound (ACE's `addDamageToUnit` does
  not filter zero damage).

```bash
node sim.js run --weapon BT_TyrianBolter --distance 100 --mode bco --mod-defaults --trace
```

## Shots that miss every hitpoint

With the body figure, a shot can strike the fire geometry without touching any hitpoint sphere. The engine
then applies only structural damage, which ACE never turns into wounds. Example: a Krieg lasgun at 300 m with
3 mrad aim error lands 17% of shots on the body but wounds on only 10%. This depends on the hit-sphere
assumption (`engine_hitpointTest`), so treat it as a lead to verify in game.

## Mods with their own damage scripts

The extractor lists 22 mods with `HandleDamage`/`HitPart` code. Black Carapace, KAT and ACE are modelled.
Reviewed and not affecting wounds from ordinary small arms:

- **JCaleb's Bolter Expansion**: its projectile `HitPart` handlers push or ragdoll targets (Quake, Gatebreaker)
  and damage vehicle engines (Haywire); no medical effect.
- **JCaleb's Grav Weapon System**: its `HandleDamage` handler multiplies the *returned* damage of
  `JC_GravSystem_Crush_Base` rounds by a mass-based strength. ACE builds wounds from the incoming `_damage`
  parameter of its own handler, not from other handlers' return values, so the crush multiplier never reaches
  ACE wounds; it only changes engine damage if the Grav handler happens to be the last one added. Worth checking
  if grav crush is meant to hurt infantry more under ACE.

The rest act on vehicles, creatures or AI melee. They were classified by where their scripts hook, not read
line by line.
