# The web page

Open `index.html` from disk after `python3 build_page.py`, or visit the public site at
<https://black-templars-team.github.io/BACED/>. The page keeps your inputs in the browser's local storage.

## Inputs (left column, in task order)

| Input | Notes |
|---|---|
| Target | Player or AI: changes damage threshold, death chance, unconsciousness and fatal injury rules (summary under the switch). AI target opens a Unit picker: browse Units or Groups (like Eden categories), filter by side/faction/category/group, with cascading dropdowns; the loadout (uniform, vest, helmet, backpack) is read-only and comes from the unit's config only. Scripted loadouts are not seen. |
| Weapon | filter by name, class or mod; the full name, mod and class show under the list. |
| Muzzle, fire mode | fire mode sets the rate (`reloadTime`) and weapon dispersion. |
| Ammunition | the magazine; its round count sets the burst length. |
| Range | metres; changes velocity (suit off) and the size of the shot cloud. |
| Magazines fired | burst length in whole magazines (up to 600 shots). |
| Shooter aim error | mrad, added to weapon dispersion. 0 is a perfect rest, 2 to 5 a standing rifleman. |
| Aim point | click the marine figure (arrow keys nudge), or pick a hitpoint; "Blast only" models splash without a direct hit. A distance field appears to set how far the burst is from the target, with a hint explaining the falloff. Blue dots landed, grey dots missed, the red ring is the aim point. |
| Loadout | uniform, vest (pauldrons), helmet, backpack. Backpacks carry no armor in the engine or ACE. |
| Black Carapace | suit on or off for players; always on for listed AI; disabled when `HOV_HUD_ONLY` is set. |
| Iron Halo | shield tier, when the suit is on. |
| Wound types | BACED 40k (default) or Original ACE, which uses wounds and ammo damage types without BACED's medical and ammo compat addons. The choice is saved and shared by both tabs. Disabled when the export lacks original wound data. |

The CLI equivalent is `--wounds baced|ace` on `run`, `sweep` and `balance`.

## Results (right column)

1. **Headline**: the shot at which half of the simulated bursts have the target down, and the shot where half
   are dead (or why he is never killed). Any value you changed is listed under it, with "reset all".
2. **Chart**: two running chances over shot number. A point at shot 12 and 70% means 70% of the simulated
    bursts had the target down (or dead) by shot 12. It is not a progress bar. Faint vertical lines labelled
    "mag 2", "mag 3" mark magazine changes; the blue line is the inspected shot (click the chart, or use arrow keys and Enter, to move it).
    "Smooth lines" draws a monotone curve instead of steps. With the suit on, bars under the chart show the hit
    zone's plate. "Table view" lists every shot. A "Compare ACE armor penetration" checkbox reruns the burst
    with the setting flipped and overlays both curves on the chart.
3. **Example burst, medical menu**: one simulated burst (the one closest to the median) replayed to the
   inspected shot, drawn like ACE's medical menu: same body images, colour scale, fracture overlay and injury
   list wording. Click a body part (or use arrow keys) to see its list. It is one example, not an average.
4. **One shot on an unhurt target**: hit rate, which wounds one shot causes and how often, and the chances of
   being down, dead, fractured or getting a pneumothorax from one shot.
5. **Why, step by step**: the damage chain for the inspected shot of the example burst. Every value used is
   editable in place; the whole page re-runs on change and the change appears under the headline.
   `ENGINE ASSUMPTION` marks steps where Arma's engine maths is closed source.
6. **Data and settings**: provenance, the switch between server settings and mod defaults, the list of mods
   with their own damage scripts, and a box to paste another `cba_settings.sqf` export on top.

## Weapon balancing tab

Compare the cert and relic roster against the target set in the left column
(player loadout or AI unit, stance, range, aim point, aim error, Black Carapace, Iron Halo and wound types; all shared with the
Single weapon tab). The weapon, muzzle, fire mode, ammunition and magazine fields are hidden on this tab.
The aim figure keeps the aim point ring but hides the Single weapon shot cloud.

| Element | Meaning |
|---|---|
| Mark | one weapon and ammunition pair. Copies with identical stats merge; distinct classes with the same display name get variant labels. |
| X axis | seconds from the first shot until half of the simulated bursts reach the chosen outcome, using the fastest player fire mode and counting reloads. Linear from 0 by default; **Log time** uses `log10(1 + seconds)` so first-shot outcomes can still appear at zero. |
| Y picker: Consistency (default) | shots fired to reach 75% divided by shots fired to reach 25%, on a log scale. Misses count. `1 = always the same` means the 25% and 75% thresholds occur on the same shot; higher values mean more spread. |
| Y picker: Magazines to down | median shots fired divided by magazine capacity, on a log scale with a reference line at one magazine. |
| Y picker: Acquisition tier | Default, Earnable and Relic bands; offsets within a band separate marks and do not encode performance. |
| Colour | the cert. A weapon on several certs is split into equal slices, one per cert. |
| Shape | circle Firstborn, diamond Primaris, triangle Reliquary |
| Hollow ring | a weapon from another 40k mod that is on no list ("Show other 40k mods"); colour per mod, the 7 largest mods get their own colour |
| Counts as a kill | "Down or dead" (unconscious or worse) or "Dead". Players on the BT server settings are hardly ever killed outright, so "Dead" is mostly for AI targets. |
| Reload time | used whenever the weapon config's `magazineReloadTime` is shorter (most are 0: the engine takes the reload animation's length, which is not extracted) |
| Acquisition | filter by Default (free), Earnable (3 Ceramite) and Relic (3 Gold) |

The initial time axis fits to the 95th percentile instead of stretching to the slowest result. Longer times
appear as hollow marks in **Beyond**; their tooltips still show the actual time. The far-right
**Not down within 600 shots** strip (or **Not dead** for the death outcome) holds pairs that did not reach
50% by the shot cap. Strip positions are not times.

Hover or tap a mark for the weapon, variant, class, magazine, ammo, shots fired, median time, 25% to 75%
time range, body-hit chance, fire mode, rate and certs. Marks at the same coordinates are offset slightly;
their tooltips list the weapons sharing that point. **Open in single weapon** loads the pair on the other
tab. Scroll or pinch to zoom, drag to pan, or select **Expand** to fill the screen. Legend counts reflect
the plotted marks. Click an entry to show or hide it, double-click to isolate it, or hover to highlight it.

Use **Chart | Table** to switch views. The table starts sorted by median time; select a column heading to
sort by it, or filter by weapon name, class or cert. **Download CSV** exports the filtered rows in their
current order, with the same columns as `node sim.js balance --csv`. Unreached percentiles stay blank.
Pairs that did not reach 50% and unmatched sheet entries are listed in the notes under either view.

Ammo and magazine edits made in **Why, step by step** apply by class. An edited ammo class affects every
weapon that uses that round; an edited magazine affects every weapon that uses that magazine. The balance
tab lists the edited classes and provides a **reset** link to clear the edits.

The weapon lists come from the BT sheets through `rosters.py`. To map a sheet name the build cannot match, add it
to `roster_overrides.json`.

## Republishing to GitHub Pages

Follow the [README build and publish commands](../README.md#publish-to-github-pages) to refresh the snapshot
of the mod preset and BT server settings. Run `python3 publish_pages.py` to preview the files and sizes in
the gitignored `site/` directory. Add `--push` to publish that build to `origin/gh-pages` from a temporary
Git worktree. In GitHub's **Settings > Pages**, select **Deploy from a branch**, then `gh-pages` and `/(root)`.

The public site uses the hit-volume outline for aiming. The local `data/body_geometry.js` stays gitignored
and keeps the rendered picture. The publisher writes a separate copy without the picture, or omits the
file if it is missing locally. In that case the page uses the simple hitpoint picker.

## Design notes

`.deslop/` holds the design decisions taken with the user (layout, colours, what leads the page, vetoes). Read
`taste.md` before changing the layout. Colours are tokens at the top of `page.html` with separate light and dark
values; the two chart line colours were checked for colour-blind separation in both themes.
