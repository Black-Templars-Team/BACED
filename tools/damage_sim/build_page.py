"""Turn data/game_data.json into the page's data file and a local index.html.

    python3 build_page.py

Writes:
    data/page_data.js   window.GAME_DATA = {...}, trimmed to what the page uses
    data/roster.js      window.ROSTER = {...}, the cert and relic weapon lists (rosters.py)
    index.html          page.html wrapped in a document skeleton, for opening from disk
Also writes roster.js beside the selected game_data.json for the CLI if it is not in data/.
page.html itself is the artifact source (the artifact host adds its own skeleton).
"""
import argparse
import base64
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import armaconfig as ac

import cbasettings as cs
import rosters

HERE = os.path.dirname(os.path.abspath(__file__))
SETTING_PREFIXES = ("ace_medical_", "kat_breathing_", "kat_circulation_", "hov_", "sla_")
SETTING_SKIP = ("ace_medical_gui_", "ace_medical_treatment_", "ace_medical_feedback_", "ace_medical_blood_",
                "ace_medical_ai_", "_overlay", "_texture", "hov_hud_armor", "hov_terminator_indomitus_armor_")


def game_data_path():
    if data_dir := os.environ.get("DAMAGE_SIM_DATA_DIR"):
        return Path(data_dir).resolve() / "game_data.json"
    local = Path(HERE) / "data" / "game_data.json"
    if local.is_file():
        return local
    root = Path(HERE).parents[1]
    git_link = root / ".git"
    if not git_link.is_file():
        return local
    prefix, _, worktree_git = git_link.read_text().strip().partition(": ")
    if prefix != "gitdir":
        return local
    git_dir = (root / worktree_git).resolve()
    common_file = git_dir / "commondir"
    if not common_file.is_file():
        return local
    common_dir = (git_dir / common_file.read_text().strip()).resolve()
    shared = common_dir.parent / "tools" / "damage_sim"
    game_data = shared / "data" / local.name
    if not game_data.is_file():
        return local

    # Seed missing optional inputs for the page in this worktree.
    inputs = [Path("data/body_geometry.js")]
    inputs.extend(p.relative_to(shared) for p in (shared / ".cache/sheets").glob("*.csv"))
    for relative in inputs:
        source, dest = shared / relative, Path(HERE) / relative
        if source.is_file() and not dest.exists():
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, dest)
    return game_data


def trim(data):
    # Only weapons that fire something the model knows
    ammo = data["ammo"]
    for a in ammo.values():
        a.pop("lineage", None)
    data["weapons"] = {k: w for k, w in data["weapons"].items()
                       if any(data["magazines"].get(m, {}).get("ammo") in ammo for mz in w["muzzles"] for m in mz["magazines"])}
    keep = {}
    for key, value in data["settings"].items():
        low = key.lower()
        if low.startswith(SETTING_PREFIXES) and not any(s in low for s in SETTING_SKIP):
            keep[key] = value
    data["settings"] = keep
    # Keep the Eden catalog and its loadouts, including model paths for stance rules.
    gear = data["gear"]
    ai_units = gear.get("aiUnits", {})
    for table, slot in (("vests", "vest"), ("helmets", "helmet")):
        worn = {unit[slot] for unit in ai_units.values()}
        gear[table] = {k: v for k, v in gear[table].items() if v["protection"] or k in worn}
    used_units = {u["unitClass"] for u in gear["uniforms"].values()}
    gear["units"] = {k: v for k, v in gear["units"].items() if k in used_units}
    for unit in gear["units"].values():
        for hp in unit["hitpoints"].values():
            hp.pop("depends", None)
    data.pop("damageScripts", None)
    # Most units share an identical HitPoints table: store each table once, rehydrated by the loader
    sets, index = [], {}
    for unit in gear["units"].values():
        key = json.dumps(unit["hitpoints"], sort_keys=True)
        if key not in index:
            index[key] = len(sets)
            sets.append(unit["hitpoints"])
        unit["hitpoints"] = index[key]
    gear["hitpointSets"] = sets
    for table in ("vests", "helmets", "backpacks"):
        for item in gear[table].values():
            item.pop("patchedBy", None)
            for entry in item.get("protection", {}).values():
                if entry.get("explosionShielding") == 1:
                    entry.pop("explosionShielding")
    return rounded(data)


def rounded(value):
    if isinstance(value, float):
        return float(f"{value:.6g}")
    if isinstance(value, list):
        return [rounded(v) for v in value]
    if isinstance(value, dict):
        return {k: rounded(v) for k, v in value.items()}
    return value


ACE_GUI_PBO = os.path.join(os.environ.get("ARMA_STEAMAPPS", "/mnt/Games/SteamLibrary/steamapps"),
                           "workshop/content/107410/463939057/addons/ace_medical_gui.pbo")


def ace_body_images(out_path):
    """ACE medical menu body layers (white masks the menu tints), as data URIs."""
    images = {}
    with tempfile.TemporaryDirectory() as tmp:
        for entry in ac.read_pbo_index(ACE_GUI_PBO)[0]:
            name = entry["name"].replace("\\", "/")
            if "body_image/" not in name.lower() or not name.lower().endswith(".paa"):
                continue
            base = os.path.splitext(os.path.basename(name))[0].lower()
            paa = os.path.join(tmp, base + ".paa")
            png = os.path.join(tmp, base + ".png")
            with open(paa, "wb") as f:
                f.write(ac.read_pbo_file(ACE_GUI_PBO, entry))
            subprocess.run(["hemtt", "utils", "paa", "convert", paa, png], capture_output=True, timeout=60)
            if os.path.exists(png):
                images[base] = "data:image/png;base64," + base64.b64encode(open(png, "rb").read()).decode()
    with open(out_path, "w") as f:
        f.write("window.ACE_BODY_IMAGES = " + json.dumps(images) + ";\n")
    print(f"ACE body images: {len(images)}")


def main():
    parser = argparse.ArgumentParser()
    settings = parser.add_mutually_exclusive_group()
    settings.add_argument("--server-settings", type=Path,
                          help="exported cba_settings.sqf used by the page and CLI (default: ~/Downloads/message.txt)")
    settings.add_argument("--mod-defaults", action="store_true",
                          help="remove saved server settings and use mod defaults for the page and CLI")
    parser.add_argument("--refresh-sheets", action="store_true",
                        help="download the roster sheets again instead of using .cache/sheets/")
    args = parser.parse_args()
    if args.server_settings is not None and not args.server_settings.is_file():
        parser.error(f"server settings export is not a file: {args.server_settings}")

    source = game_data_path()
    with source.open() as f:
        data = json.load(f)
    os.makedirs(os.path.join(HERE, "data"), exist_ok=True)
    # The CLI reads its saved settings alongside the extracted game data.
    saved = source.with_name("server_settings.json")
    export = args.server_settings or Path.home() / "Downloads/message.txt"
    server = {}
    if args.mod_defaults:
        saved.unlink(missing_ok=True)
        print("server settings: both the page and CLI use mod defaults (--mod-defaults)")
    elif args.server_settings is not None or export.is_file():
        server = cs.parse_cba_settings_file(export.read_text(encoding="utf-8", errors="replace"))
        with saved.open("w") as f:
            json.dump(server, f, indent=1)
        print(f"server settings: {len(server)} values from {export}")
    elif saved.is_file():
        server = json.loads(saved.read_text())
        print(f"server settings: reused {len(server)} saved values from {saved}")
    else:
        print("server settings: no export or saved settings; both the page and CLI use mod defaults")
    full_scripts = data.get("damageScripts", [])
    data = trim(data)
    baced = data.get("baced")
    if baced is None:
        print("BACED addons not loaded: run hemtt build, then extract.py")
    else:
        print(f"BACED addons: {len(baced['loaded'])} loaded (built {baced['built']}), "
              f"{len(baced['skipped'])} skipped because their mod is not in the preset")
    data["serverSettings"] = server
    # Scripts that can touch a marine's damage, summarised per mod for the page footer
    relevant = {}
    for s in full_scripts:
        if s["kind"] in ("HandleDamage EH", "ACE medical function override", "ACE woundReceived event"):
            relevant.setdefault(s["mod"], set()).add(s["kind"])
    data["damageScriptMods"] = {k: sorted(v) for k, v in sorted(relevant.items())}

    # Store the AI field names once rather than repeating them for every unit.
    ai_units = data["gear"].get("aiUnits")
    if ai_units:
        fields = list(next(iter(ai_units.values())))
        data["gear"]["aiUnits"] = [fields, {name: [unit[field] for field in fields]
                                           for name, unit in ai_units.items()}]

    out = os.path.join(HERE, "data", "page_data.js")
    with open(out, "w") as f:
        f.write("window.GAME_DATA = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
        f.write("(function (g) { for (const u of Object.values(g.units)) if (typeof u.hitpoints === \"number\") u.hitpoints = g.hitpointSets[u.hitpoints]; })(window.GAME_DATA.gear);\n")
        if ai_units:
            f.write("(function (g) { const [fields, rows] = g.aiUnits; "
                    "for (const name of Object.keys(rows)) rows[name] = "
                    "Object.fromEntries(fields.map((field, i) => [field, rows[name][i]])); "
                    "g.aiUnits = rows; })(window.GAME_DATA.gear);\n")
    print(f"wrote {out} ({os.path.getsize(out) / 1e6:.1f} MB)")
    roster = rosters.roster_data(data, refresh=args.refresh_sheets)
    for e in roster["unmatched"]:
        print(f"  roster name not matched to a simulated weapon: {e['sheetName']!r} ({e['cert']}, {e['acquisition']})")
    roster_js = "window.ROSTER = " + json.dumps(roster, separators=(",", ":")) + ";\n"
    browser_roster = Path(HERE) / "data" / "roster.js"
    browser_roster.write_text(roster_js, encoding="utf-8")
    if source.parent.resolve() != browser_roster.parent.resolve():
        source.with_name("roster.js").write_text(roster_js, encoding="utf-8")
    if not os.path.exists(os.path.join(HERE, "data", "body_geometry.js")):
        print("note: data/body_geometry.js is missing; the page falls back to the simple body figure")

    ace_body_images(os.path.join(HERE, "data", "ace_body_images.js"))

    # Preserve the template's script order, including balance_points.js before balance.js.
    with open(os.path.join(HERE, "page.html")) as f:
        page = f.read()
    with open(os.path.join(HERE, "index.html"), "w") as f:
        f.write('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                '</head>\n<body>\n' + page + '\n</body>\n</html>\n')
    print("wrote index.html")


if __name__ == "__main__":
    main()
