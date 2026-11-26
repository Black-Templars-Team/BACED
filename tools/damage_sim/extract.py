"""Build the damage simulator's data file from the game and mod PBOs.

Merges every addon config the way the engine does (CfgPatches requiredAddons
order, later addons patch earlier classes), resolves inheritance, and writes
the values the damage model needs to data/game_data.json.

Usage:
    python3 extract.py [--preset NAME.preset2] [--baced DIR | --no-baced] [--out data/game_data.json]
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import xml.etree.ElementTree as ET

import armaconfig as ac
import cbasettings as cs

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".cache")
REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "../.."))
DEFAULT_BACED = os.path.join(REPO_ROOT, ".hemttout", "build", "addons")
BACED_STRINGTABLE = os.path.join(REPO_ROOT, "addons", "medical", "stringtable.xml")

# Override with the ARMA_STEAMAPPS environment variable on another machine
STEAM = os.environ.get("ARMA_STEAMAPPS", "/mnt/Games/SteamLibrary/steamapps")
ARMA = f"{STEAM}/common/Arma 3"
WORKSHOP = f"{STEAM}/workshop/content/107410"
PRESETS = f"{STEAM}/compatdata/107410/pfx/drive_c/users/steamuser/AppData/Local/Arma 3 Launcher/Presets"
DEFAULT_PRESET = "BT_7_31_2026.preset2"
# Platform folders loaded without -mod (Contact is opt-in, so it is left out)
VANILLA_DIRS = ["Addons", "Argo", "Curator", "Enoch", "Expansion", "Heli", "Jets",
                "Kart", "Mark", "Orange", "Tacops", "Tank", "AoW"]
KEEP_TOP = {"cfgpatches", "cfgammo", "cfgmagazines", "cfgweapons", "cfgvehicles",
            "cfggroups", "cfgfactionclasses", "cfgeditorcategories", "cfgeditorsubcategories",
            "ace_medical_injuries", "cfgmagazinewells"}
SCRIPT_PATTERNS = {
    "HandleDamage EH": re.compile(r"HandleDamage", re.I),
    "HitPart EH": re.compile(r"[\"']HitPart[\"']", re.I),
    "ACE medical function override": re.compile(r"ace_medical(?:_damage|_engine)?_fnc_\w+\s*=", re.I),
    "ACE woundReceived event": re.compile(r"ace_medical_woundReceived", re.I),
    "ACE damage settings": re.compile(r"ace_medical_(?:alternateArmorPenetration|playerDamageThreshold|AIDamageThreshold|deathChance|fatalDamageSource)", re.I),
}


SETTING_PREFIXES = re.compile(r"^(ace_medical|kat_breathing|kat_circulation|HOV_|SLA_)", re.I)
# ACE setting defaults use macros from this shared header, which other PBOs only #include
GLOBAL_DEFINES = {}


def load_global_defines():
    pbo = os.path.join(WORKSHOP, "463939057", "addons", "ace_medical_engine.pbo")
    if not os.path.exists(pbo):
        return
    for entry in ac.read_pbo_index(pbo)[0]:
        if entry["name"].lower().endswith("script_macros_medical.hpp"):
            GLOBAL_DEFINES.update(cs.parse_defines(ac.read_pbo_file(pbo, entry).decode("utf-8", "replace")))


# Black Carapace Overhaul: tier order of its armor switch statements, read from its script
BCO = {}


def parse_bco_tiers(text):
    body = text[text.index("HOV_fnc_setArmorValues = {"):]
    body = body[:body.index("HOV_fnc_updateArmorValues = {")] if "HOV_fnc_updateArmorValues = {" in body else body
    return {
        "uniformTiers": re.findall(r"case \(uniform _unit in (\w+?)_ARMOR\)", body),
        "helmetTiers": re.findall(r"case \(headgear _unit in (\w+?)_helmets\)", body),
        "fallbackPlate": 5000,
        "hitGuardSeconds": float((re.search(r"HOV_HITPART_RUNNING_TIMEOUT\s*=\s*([\d.]+)", text) or [0, 0.1])[1]),
        # selection name lists HOV_fnc_calcDamage uses to pick the armor zone
        "zoneSelections": {zone: [x.lower() for x in re.findall(r'"([^"]+)"', m.group(1))]
                           for zone, m in ((z, re.search(r"HOV_" + z + r"\s*=\s*\[(.*?)\];", text, re.S))
                                           for z in ("head", "body", "leftArm", "rightArm", "leftLeg", "rightLeg")) if m},
    }


# ---------------------------------------------------------------- merged tree

class Node:
    __slots__ = ("name", "base", "props", "src", "kids", "parent", "touched")

    def __init__(self, name, parent=None):
        self.name = name
        self.base = None
        self.props = {}   # lower name -> value
        self.src = {}     # lower name -> mod label that set it last
        self.kids = {}    # lower name -> Node
        self.parent = parent
        self.touched = []  # mod labels that defined/patched this class

    def child(self, name):
        return self.kids.get(name.lower())


def merge(dst, cls, label):
    if cls.base is not None or not dst.touched:
        dst.base = cls.base
    if not dst.touched or dst.touched[-1] != label:
        dst.touched.append(label)
    for name in cls.deletes:
        dst.kids.pop(name.lower(), None)
    # `class X;` is only a forward reference (usually to an inherited class), so it adds nothing
    for key, value in cls.entries.items():
        low = key.lower()
        if isinstance(value, ac.ConfigClass):
            node = dst.kids.get(low)
            if node is None:
                node = Node(key, dst)
                dst.kids[low] = node
            merge(node, value, label)
        else:
            if isinstance(value, ac.ArrayAppend):
                prev = dst.props.get(low)
                value = ("__append__", list(value), prev)
            dst.props[low] = value
            dst.src[low] = label


def find_member(scope, name, skip=None, depth=0):
    """Find class `name` visible from `scope`: own members, then inherited ones."""
    if scope is None or depth > 64:
        return None
    node = scope.kids.get(name.lower())
    if node is not None and node is not skip:
        return node
    base = resolve_base(scope)
    return find_member(base, name, skip, depth + 1)


def resolve_base(node):
    """Base class: searched in the enclosing class (with inheritance), then outward."""
    if not node.base or node.parent is None:
        return None
    scope = node.parent
    while scope is not None:
        found = find_member(scope, node.base, skip=node)
        if found is not None:
            return found
        scope = scope.parent
    return None


def lookup(node, prop, default=None, with_src=False):
    seen = 0
    while node is not None and seen < 128:
        low = prop.lower()
        if low in node.props:
            value = node.props[low]
            if isinstance(value, tuple) and value and value[0] == "__append__":
                inherited = lookup(resolve_base(node), prop, [], False)
                value = list(inherited or []) + value[1]
            return (value, node.src.get(low)) if with_src else value
        node = resolve_base(node)
        seen += 1
    return (default, None) if with_src else default


def subclass(node, name):
    """Nested class lookup that follows inheritance (config >> path semantics)."""
    seen = 0
    while node is not None and seen < 128:
        kid = node.kids.get(name.lower())
        if kid is not None:
            return kid
        node = resolve_base(node)
        seen += 1
    return None


def lineage(node):
    out = []
    while node is not None and len(out) < 64:
        out.append(node.name)
        node = resolve_base(node)
    return out


def class_names(node):
    """All nested class names visible through inheritance, own first."""
    names = {}
    seen = 0
    while node is not None and seen < 64:
        for low, kid in node.kids.items():
            names.setdefault(low, kid.name)
        node = resolve_base(node)
        seen += 1
    return list(names.values())


# ---------------------------------------------------------------- loading

def preset_mods(preset_path):
    text = open(preset_path, encoding="utf-8-sig").read()
    ids = re.findall(r"steam:(\d+)", text)
    mods = []
    for mod_id in ids:
        folder = os.path.join(WORKSHOP, mod_id)
        name = mod_id
        for info in ("meta.cpp", "mod.cpp"):
            path = os.path.join(folder, info)
            found = os.path.exists(path) and re.search(r'name\s*=\s*"([^"]*)"', open(path, errors="replace").read())
            if found:
                name = found.group(1)
                break
        mods.append({"id": mod_id, "name": name, "folder": folder})
    return mods


def pbos_in(folder):
    out = []
    for sub in ("addons", "Addons", "ADDONS"):
        out += glob.glob(os.path.join(folder, sub, "*.pbo"))
    return sorted(set(out), key=str.lower)


def scan_scripts(pbo, entries, label, findings, settings):
    prefix = os.path.splitext(os.path.basename(pbo))[0].lower()
    texts = []
    for entry in entries:
        name = entry["name"].lower()
        if not name.endswith((".sqf", ".fsm", ".hpp", ".cpp", ".inc")) or entry["orig"] > 2_000_000:
            continue
        try:
            text = ac.read_pbo_file(pbo, entry).decode("utf-8", "replace")
        except Exception:
            continue
        texts.append(text)
        if name.endswith("scripts\\functions.sqf") and "HOV_fnc_setArmorValues" in text:
            BCO.update(parse_bco_tiers(text))
        for kind, pattern in SCRIPT_PATTERNS.items():
            if pattern.search(text):
                findings.append({"mod": label, "pbo": os.path.basename(pbo),
                                 "file": entry["name"], "kind": kind})
    defines = {}
    for text in texts:
        defines.update(cs.parse_defines(text))
    defines.update(GLOBAL_DEFINES)
    for text in texts:
        if "CBA_fnc_addSetting" not in text:
            continue
        for name, info in cs.parse_settings(text, prefix, defines).items():
            if SETTING_PREFIXES.match(name):
                info["mod"] = label
                settings[name] = info


def load_addons(mods, log, baced_pbos=()):
    sources = [("Arma 3", os.path.join(ARMA, "Dta", "bin.pbo"), True)]
    for d in VANILLA_DIRS:
        for pbo in pbos_in(os.path.join(ARMA, d)) if d != "Addons" else sorted(glob.glob(os.path.join(ARMA, "Addons", "*.pbo")), key=str.lower):
            sources.append(("Arma 3", pbo, True))
    for mod in mods:
        for pbo in pbos_in(mod["folder"]):
            sources.append((mod["name"], pbo, False))
    sources.extend(("BACED", pbo, False) for pbo in baced_pbos)

    addons = []
    skipped = []
    scripts = []
    settings = {}
    for label, pbo, vanilla in sources:
        try:
            entries, props = ac.read_pbo_index(pbo)
            by_name = {e["name"].lower(): e for e in entries}
            if not vanilla:
                scan_scripts(pbo, entries, label, scripts, settings)
        except Exception as err:  # encrypted, obfuscated or corrupt PBOs
            skipped.append({"mod": label, "pbo": os.path.basename(pbo), "reason": str(err)[:120]})
            continue
        # The engine loads a config from every folder of a PBO, not only its root
        folders = {}
        for name, entry in by_name.items():
            folder, _, base = name.replace("/", "\\").rpartition("\\")
            if base in ("config.bin", "config.cpp"):
                folders.setdefault(folder, {})[base] = entry
        for folder in sorted(folders):
            found = folders[folder]
            where = os.path.basename(pbo) + ("\\" + folder if folder else "")
            try:
                if "config.bin" in found:
                    root = ac.parse_rapified(ac.read_pbo_file(pbo, found["config.bin"]), KEEP_TOP)
                elif folder == "":
                    root = ac.parse_text(preprocess_text_config(pbo), KEEP_TOP)
                else:
                    skipped.append({"mod": label, "pbo": where, "reason": "nested unbinarized config.cpp"})
                    continue
            except Exception as err:
                skipped.append({"mod": label, "pbo": where, "reason": str(err)[:120]})
                continue
            add_addon(addons, label, pbo, where, root)
    log(f"parsed {len(addons)} addon configs, skipped {len(skipped)}")
    return filter_missing(addons, skipped), skipped, scripts, settings


def add_addon(addons, label, pbo, where, root):
    patches = root.get("CfgPatches")
    names = [c.name for c in patches.classes()] if patches else []
    required = set()
    skip_missing = False
    if patches:
        for c in patches.classes():
            skip_missing |= bool(c.get("skipWhenMissingDependencies", 0))
            for r in c.get("requiredAddons", []) or []:
                if isinstance(r, str):
                    required.add(r.lower())
    addons.append({"label": label, "pbo": pbo, "where": where, "root": root, "skipMissing": skip_missing,
                    "patches": [n.lower() for n in names], "patchNames": names, "required": required})


def filter_missing(addons, skipped):
    available = {p for a in addons for p in a["patches"]}
    kept = []
    for addon in addons:
        missing = addon["required"] - available
        if missing and addon["skipMissing"]:
            skipped.append({"mod": addon["label"], "pbo": addon["where"],
                            "reason": "skipWhenMissingDependencies: " + ", ".join(sorted(missing)),
                            "patches": addon["patchNames"]})
            continue
        kept.append(addon)
    return kept


def preprocess_text_config(pbo):
    """Unpack a PBO with a text config.cpp and let hemtt preprocess it (cached by mtime)."""
    key = re.sub(r"[^\w.-]", "_", os.path.relpath(pbo, STEAM))
    stamp = str(int(os.path.getmtime(pbo)))
    cached = os.path.join(CACHE, f"{key}.{stamp}.cpp")
    if os.path.exists(cached):
        return open(cached, encoding="utf-8", errors="replace").read()
    with tempfile.TemporaryDirectory(dir=CACHE) as tmp:
        # hemtt's own unpacker panics on some PBOs, so only the text files are written out here
        unpacked = os.path.join(tmp, "pbo")
        for entry in ac.read_pbo_index(pbo)[0]:
            rel = entry["name"].replace("\\", "/").lstrip("/")
            if ".." in rel.split("/") or not rel.lower().endswith((".cpp", ".hpp", ".h", ".inc", ".ext", ".sqf")):
                continue
            path = os.path.join(unpacked, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as f:
                f.write(ac.read_pbo_file(pbo, entry))
        out = os.path.join(tmp, "out.cpp")
        result = subprocess.run(["hemtt", "utils", "config", "convert", "config.cpp", out, "-f", "cpp"],
                                cwd=unpacked, capture_output=True, text=True)
        if not os.path.exists(out):
            tail = (result.stdout + result.stderr).strip().splitlines()[-3:]
            raise RuntimeError("hemtt could not preprocess config.cpp: " + " | ".join(tail))
        text = open(out, encoding="utf-8", errors="replace").read()
    with open(cached, "w", encoding="utf-8") as f:
        f.write(text)
    return text


def load_order(addons):
    """Stable topological order on requiredAddons, like the engine's CfgPatches sort."""
    provider = {}
    for i, addon in enumerate(addons):
        for name in addon["patches"]:
            provider.setdefault(name, i)
    order = []
    state = [0] * len(addons)  # 0 new, 1 visiting, 2 done

    def visit(i):
        if state[i]:
            return
        state[i] = 1
        for req in sorted(addons[i]["required"]):
            j = provider.get(req)
            if j is not None and j != i and state[j] == 0:
                visit(j)
        state[i] = 2
        order.append(i)

    sys.setrecursionlimit(20000)
    for i in range(len(addons)):
        visit(i)
    return [addons[i] for i in order]


# ---------------------------------------------------------------- export

def num(node, prop, default=0.0):
    value = lookup(node, prop, default)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return default
    return value if isinstance(value, (int, float)) else default


def mod_of(node):
    return node.touched[0] if node.touched else None


def export_ammo(node):
    keys_num = ["hit", "indirectHit", "indirectHitRange", "caliber", "typicalSpeed",
                "airFriction", "explosive", "deflecting", "submunitionConeAngle",
                "timeToLive", "ACE_caliber", "ACE_bulletMass", "triggerTime", "coefGravity",
                "dangerRadiusHit", "simulationStep"]
    out = {"mod": mod_of(node), "patchedBy": node.touched[1:]}
    for key in keys_num:
        value, src = lookup(node, key, None, with_src=True)
        if isinstance(value, (int, float)):
            out[key] = value
            if src and src != out["mod"]:
                out.setdefault("valueSource", {})[key] = src
    for key in ("simulation", "ACE_damageType", "submunitionAmmo", "warheadName"):
        value = lookup(node, key, None)
        if value is not None:
            out[key] = value
    sub = lookup(node, "submunitionConeType", None)
    if isinstance(sub, list):
        out["submunitionConeType"] = sub
    out["lineage"] = lineage(node)[:8]
    return out


def magazines_of(weapon_like, wells):
    mags = list(lookup(weapon_like, "magazines", []) or [])
    for well in lookup(weapon_like, "magazineWell", []) or []:
        if isinstance(well, str):
            mags += wells.get(well.lower(), [])
    seen = []
    for m in mags:
        if isinstance(m, str) and m.lower() not in [s.lower() for s in seen]:
            seen.append(m)
    return seen


def export(root, log):
    cfg_ammo = root.child("CfgAmmo")
    cfg_mags = root.child("CfgMagazines")
    cfg_weapons = root.child("CfgWeapons")
    cfg_vehicles = root.child("CfgVehicles")
    cfg_wells = root.child("CfgMagazineWells")

    wells = {}
    if cfg_wells:
        for low, well in cfg_wells.kids.items():
            mags = []
            for key in well.props:
                value = lookup(well, key, [])
                if isinstance(value, list):
                    mags += [m for m in value if isinstance(m, str)]
            wells[low] = mags

    weapons = {}
    used_mags = set()
    for low, w in cfg_weapons.kids.items():
        if num(w, "scope") < 2:
            continue
        wtype = num(w, "type")
        if int(wtype) not in (1, 2, 4, 5):
            continue
        muzzles = []
        for muzzle in lookup(w, "muzzles", ["this"]) or ["this"]:
            node = w if muzzle.lower() == "this" else subclass(w, muzzle)
            if node is None:
                continue
            mags = magazines_of(node, wells)
            if not mags:
                continue
            used_mags.update(m.lower() for m in mags)
            modes = []
            for mode in lookup(node, "modes", ["this"]) or ["this"]:
                mode_node = node if not isinstance(mode, str) or mode.lower() == "this" else subclass(node, mode)
                if mode_node is not None:
                    modes.append({"name": mode, "reloadTime": num(mode_node, "reloadTime"),
                                  "burst": num(mode_node, "burst", 1), "dispersion": num(mode_node, "dispersion"),
                                  "showToPlayer": num(mode_node, "showToPlayer", 1)})
            muzzles.append({"name": muzzle, "displayName": lookup(node, "displayName", "") or muzzle,
                            "initSpeed": num(node, "initSpeed"), "magazineReloadTime": num(node, "magazineReloadTime"),
                            "magazines": mags, "modes": modes})
        if not muzzles:
            continue
        weapons[w.name] = {"displayName": lookup(w, "displayName", w.name), "type": int(wtype),
                           "mod": mod_of(w), "patchedBy": w.touched[1:], "muzzles": muzzles}

    magazines = {}
    used_ammo = set()
    for low in used_mags:
        m = cfg_mags.child(low) if cfg_mags else None
        if m is None:
            continue
        ammo = lookup(m, "ammo", "")
        if not ammo:
            continue
        magazines[m.name] = {"displayName": lookup(m, "displayName", m.name), "ammo": ammo,
                             "initSpeed": num(m, "initSpeed"), "count": num(m, "count"),
                             "mod": mod_of(m)}
        used_ammo.add(ammo.lower())

    ammo_out = {}
    pending = list(used_ammo)
    while pending:
        low = pending.pop()
        a = cfg_ammo.child(low)
        if a is None or a.name in ammo_out:
            continue
        ammo_out[a.name] = export_ammo(a)
        sub = ammo_out[a.name].get("submunitionAmmo")
        names = [sub] if isinstance(sub, str) else [x for x in (sub or []) if isinstance(x, str)]
        for name in names:
            if name and name.lower() not in ammo_out:
                pending.append(name.lower())

    ai_units = export_ai_units(root)
    gear = export_gear(cfg_weapons, cfg_vehicles, ai_units)
    groups = export_groups(root.child("CfgGroups"), ai_units)
    ace = export_ace(root.child("ACE_Medical_Injuries"))
    log(f"weapons {len(weapons)}, magazines {len(magazines)}, ammo {len(ammo_out)}, "
        f"uniforms {len(gear['uniforms'])}, vests {len(gear['vests'])}, helmets {len(gear['helmets'])}, "
        f"aiUnits {len(ai_units)}, groups {len(groups)}")
    return weapons, magazines, ammo_out, gear, groups, ace


def protection(item_info):
    hpi = subclass(item_info, "HitpointsProtectionInfo")
    out = {}
    if hpi is None:
        return out
    for name in class_names(hpi):
        part = subclass(hpi, name)
        hitpoint = lookup(part, "hitpointName", "")
        if not hitpoint:
            continue
        armor, armor_src = lookup(part, "armor", 0, with_src=True)
        out[hitpoint] = {"armor": armor if isinstance(armor, (int, float)) else 0,
                         "passThrough": num(part, "passThrough", 1.0),
                         "explosionShielding": num(part, "explosionShielding", 1.0),
                         "source": armor_src}
    return out


def unit_hitpoints(unit):
    hp_cfg = subclass(unit, "HitPoints")
    out = {}
    if hp_cfg is None:
        return out
    for name in class_names(hp_cfg):
        hp = subclass(hp_cfg, name)
        out[name] = {k: num(hp, k, d) for k, d in (("armor", 1.0), ("passThrough", 1.0),
                     ("explosionShielding", 1.0), ("minimalHit", 0.0), ("radius", 0.0))}
        out[name]["name"] = lookup(hp, "name", "")
        out[name]["depends"] = lookup(hp, "depends", "")
    return out


def uniform_unit(item_info, cfg_vehicles):
    name = lookup(item_info, "uniformClass", "")
    return subclass(cfg_vehicles, name) if name else None


def linked_items(unit):
    return [item for item in lookup(unit, "linkedItems", []) or [] if isinstance(item, str)]


def export_ai_units(root):
    cfg_vehicles = root.child("CfgVehicles")
    cfg_weapons = root.child("CfgWeapons")
    factions = root.child("CfgFactionClasses")
    categories = root.child("CfgEditorCategories")
    subcategories = root.child("CfgEditorSubcategories")

    def label(table, name, default):
        return lookup(subclass(table, name), "displayName", default) or default

    ai_units = {}
    for name in class_names(cfg_vehicles):
        unit = subclass(cfg_vehicles, name)
        if num(unit, "scope") != 2 or num(unit, "isBackpack"):
            continue
        if num(unit, "isMan") != 1 and lookup(unit, "simulation") != "soldier":
            continue
        uniform = subclass(cfg_weapons, lookup(unit, "uniformClass", "") or "")
        info = subclass(uniform, "ItemInfo")
        if int(num(info, "type")) != 801 or uniform_unit(info, cfg_vehicles) is None:
            continue

        worn = {}
        for item in linked_items(unit):
            weapon = subclass(cfg_weapons, item)
            item_type = int(num(subclass(weapon, "ItemInfo"), "type"))
            if item_type in (701, 605):
                worn.setdefault(item_type, weapon.name)
        faction = lookup(unit, "faction", "") or ""
        ai_units[name] = {
            "displayName": lookup(unit, "displayName", name), "side": int(num(unit, "side")),
            "faction": faction, "factionName": label(factions, faction, faction),
            "category": label(categories, lookup(unit, "editorCategory", "") or "", ""),
            "subcategory": label(subcategories, lookup(unit, "editorSubcategory", "") or "", "Other"),
            "uniform": uniform.name, "vest": worn.get(701, ""), "helmet": worn.get(605, ""),
            "backpack": lookup(unit, "backpack", "") or "", "mod": mod_of(unit),
            "model": lookup(unit, "model", "") or "",
        }
    return ai_units


def export_groups(cfg_groups, ai_units):
    known_units = {name.lower(): name for name in ai_units}
    groups = []
    for side in class_names(cfg_groups):
        side_node = subclass(cfg_groups, side)
        for faction in class_names(side_node):
            faction_node = subclass(side_node, faction)
            for category in class_names(faction_node):
                category_node = subclass(faction_node, category)
                for group in class_names(category_node):
                    group_node = subclass(category_node, group)
                    slots = []
                    for name in class_names(group_node):
                        match = re.fullmatch(r"Unit([0-9]+)", name, re.I)
                        if match:
                            vehicle = lookup(subclass(group_node, name), "vehicle", "") or ""
                            if vehicle.lower() in known_units:
                                slots.append((int(match[1]), known_units[vehicle.lower()]))
                    if slots:
                        groups.append({
                            "side": side, "sideName": lookup(side_node, "name", side) or side,
                            "faction": faction, "factionName": lookup(faction_node, "name", faction) or faction,
                            "category": category, "categoryName": lookup(category_node, "name", category) or category,
                            "group": group, "name": lookup(group_node, "name", group) or group,
                            "units": [unit for _, unit in sorted(slots)],
                        })
    return groups


def export_gear(cfg_weapons, cfg_vehicles, ai_units):
    # Keep hidden wearables linked by eligible units, even if they are not in the Arsenal.
    referenced = {unit["uniform"].lower() for unit in ai_units.values()}
    referenced.update(item.lower() for name in ai_units for item in linked_items(subclass(cfg_vehicles, name)))
    uniforms, vests, helmets, backpacks = {}, {}, {}, {}
    units = {}
    for name in class_names(cfg_weapons):
        w = subclass(cfg_weapons, name)
        if num(w, "scope") < 2 and name.lower() not in referenced:
            continue
        info = subclass(w, "ItemInfo")
        if info is None:
            continue
        item_type = int(num(info, "type"))
        name = lookup(w, "displayName", w.name)
        if item_type == 801:
            unit = uniform_unit(info, cfg_vehicles)
            if unit is None:
                continue
            uclass = unit.name
            if uclass not in units:
                units[uclass] = {"armor": num(unit, "armor", 1), "armorStructural": num(unit, "armorStructural", 1),
                                 "model": lookup(unit, "model", "") or "",
                                 "explosionShielding": num(unit, "explosionShielding", 1),
                                 "mod": mod_of(unit), "patchedBy": unit.touched[1:],
                                 "hitpoints": unit_hitpoints(unit)}
            uniforms[w.name] = {"displayName": name, "unitClass": uclass, "mod": mod_of(w)}
        elif item_type in (701, 605):
            prot = protection(info)
            target = vests if item_type == 701 else helmets
            target[w.name] = {"displayName": name, "mod": mod_of(w), "patchedBy": w.touched[1:],
                              "protection": prot}
    for low, v in cfg_vehicles.kids.items():
        if num(v, "scope") < 2 or not num(v, "isBackpack"):
            continue
        info = subclass(v, "ItemInfo")
        prot = protection(info) if info else {}
        backpacks[v.name] = {"displayName": lookup(v, "displayName", v.name), "mod": mod_of(v),
                             "protection": prot}
    return {"uniforms": uniforms, "units": units, "vests": vests, "helmets": helmets,
             "backpacks": backpacks, "aiUnits": ai_units}


def export_ace(injuries):
    if injuries is None:
        return None
    wounds = {}
    wcfg = injuries.child("wounds")
    for name in class_names(wcfg):
        w = subclass(wcfg, name)
        wounds[name] = {"bleeding": num(w, "bleeding"), "pain": num(w, "pain"),
                        "causeLimping": num(w, "causeLimping") == 1,
                        "causeFracture": num(w, "causeFracture") == 1}
    dcfg = injuries.child("damageTypes")
    default_thresholds = lookup(dcfg, "thresholds", [])
    default_specific = num(dcfg, "selectionSpecific", 1)
    types = {}
    for name in class_names(dcfg):
        if name.lower() == "woundhandlers":
            continue
        d = subclass(dcfg, name)
        handlers_cfg = subclass(d, "woundHandlers") or subclass(dcfg, "woundHandlers")
        handlers = []
        if handlers_cfg:
            node = handlers_cfg
            chain = []
            while node is not None:
                chain.append(node)
                node = resolve_base(node)
            for n in reversed(chain):
                for key in n.props:
                    handlers.append([key, n.props[key], n.src.get(key)])
        details = {}
        for wname in class_names(d):
            if wname.lower() == "woundhandlers" or wname not in wounds:
                continue
            wc = subclass(d, wname)
            details[wname] = {
                "weighting": lookup(wc, "weighting", [[0, 1]]),
                "damageMultiplier": num(wc, "damageMultiplier", 1),
                "bleedingMultiplier": num(wc, "bleedingMultiplier", 1),
                "sizeMultiplier": num(wc, "sizeMultiplier", 1),
                "painMultiplier": num(wc, "painMultiplier", 1),
                "fractureMultiplier": num(wc, "fractureMultiplier", 1),
            }
        types[name] = {"thresholds": lookup(d, "thresholds", default_thresholds),
                       "selectionSpecific": num(d, "selectionSpecific", default_specific),
                       "woundHandlers": handlers, "wounds": details}
    return {"wounds": wounds, "damageTypes": types}


def read_wound_names(path, wounds):
    try:
        table = ET.parse(path)
    except FileNotFoundError:
        return {}
    english = {key.get("ID", "").lower(): key.findtext("English", "").strip()
               for key in table.iter("Key")}
    names = {}
    for cls in wounds:
        labels = [english.get(f"str_ace_medical_damage_{cls.lower()}_{size}") or None
                  for size in ("minor", "medium", "large")]
        if any(labels):
            names[cls] = labels
    return names


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--preset", default=DEFAULT_PRESET)
    baced_opts = parser.add_mutually_exclusive_group()
    baced_opts.add_argument("--baced", metavar="DIR", default=DEFAULT_BACED, help="directory of built BACED PBOs")
    baced_opts.add_argument("--no-baced", action="store_true", help="omit BACED's built addons")
    parser.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "data", "game_data.json"))
    args = parser.parse_args()
    started = time.time()
    log = lambda msg: print(f"[{time.time() - started:6.1f}s] {msg}", file=sys.stderr)

    os.makedirs(CACHE, exist_ok=True)
    preset = args.preset if os.path.isabs(args.preset) else os.path.join(PRESETS, args.preset)
    mods = preset_mods(preset)
    log(f"preset {os.path.basename(preset)}: {len(mods)} mods")
    baced_dir = os.path.abspath(args.baced)
    baced_pbos = [] if args.no_baced else sorted(
        (pbo for pbo in glob.glob(os.path.join(glob.escape(baced_dir), "*.pbo")) if os.path.isfile(pbo)),
        key=str.lower)
    if not args.no_baced and not baced_pbos:
        log(f"warning: no BACED PBOs in {baced_dir}; run hemtt build at the repo root")
    load_global_defines()
    addons, skipped, scripts, settings = load_addons(mods, log, baced_pbos)
    baced = None
    if baced_pbos:
        baced = {
            "dir": baced_dir,
            "pbos": [os.path.basename(pbo) for pbo in baced_pbos],
            "loaded": [name for a in addons if a["label"] == "BACED" for name in a["patchNames"]],
            "skipped": [name for a in skipped if a["mod"] == "BACED" for name in a.get("patches", [])],
            "built": time.strftime("%Y-%m-%d %H:%M", time.localtime(max(map(os.path.getmtime, baced_pbos)))),
        }
    log(f"{len(settings)} CBA settings found")
    ordered = load_order(addons)

    root = Node("")
    for addon in ordered:
        addon["root"].entries.pop("CfgPatches", None)
        merge(root, addon["root"], addon["label"])
        addon["root"] = None
    log("merged")

    weapons, magazines, ammo, gear, groups, ace = export(root, log)
    if ace is not None:
        ace["woundNames"] = read_wound_names(BACED_STRINGTABLE, ace["wounds"])
    data = {
        "generated": time.strftime("%Y-%m-%d %H:%M"),
        "preset": os.path.basename(preset),
        "mods": [m["name"] for m in mods],
        "baced": baced,
        "weapons": weapons, "magazines": magazines, "ammo": ammo,
        "gear": gear, "groups": groups, "ace": ace,
        "skippedPbos": skipped, "damageScripts": scripts, "settings": settings,
        "bco": BCO or None,
    }
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(data, f, separators=(",", ":"))
    log(f"wrote {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
