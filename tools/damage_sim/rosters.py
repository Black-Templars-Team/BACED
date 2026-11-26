"""Black Templars weapon rosters: which cert can field which weapon, read from the unit's Google Sheets.

    python3 rosters.py [--refresh]      # print the parsed roster and the names that did not resolve

Used by build_page.py to write data/roster.js for the page's Weapon balancing tab. The sheets are public CSV
exports. A copy is kept in .cache/sheets/ and reused when there is no network.
"""
import argparse
import csv
import io
import json
import os
import re
import unicodedata
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, ".cache", "sheets")
OVERRIDES = os.path.join(HERE, "roster_overrides.json")

EXPORT_URL = "https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid={gid}"
SHEETS = {
    "defaults": ("1jZHtDttvXq9LLIb20xDjfEu3eFQuzwI9M6-yBYuHc60", 298965545),
    "unlocks_firstborn": ("1K58pM-9zrl8ujiRDA9VxaOoS96bJLdrTElgLa1kSuVk", 376529080),
    "unlocks_primaris": ("1K58pM-9zrl8ujiRDA9VxaOoS96bJLdrTElgLa1kSuVk", 868858984),
    "reliquary": ("1cJsPanXFuLfSi_yyPV6Y3Ufdo_MD3GF0sHP-YrSzDJQ", 0),
}

CERTS = {
    "Firstborn": ["Tactical", "Devastator", "Assault"],
    "Primaris": ["Intercessor", "Heavy Intercessor", "Jump Pack Intercessor", "Reiver", "Infiltrator",
                 "Eliminator", "Bladeguard"],
}
RELIQUARY = "Reliquary"

# Defaults sheet layout: Neophyte equipment in fixed columns, then (Gear Slot, Certs, Equipment) triples
NEOPHYTE_COLUMNS = {2: "Firstborn", 4: "Primaris"}
FIRST_TRIPLE = 6
GENERATION_ROW = 3
WEAPON_SLOT = "weapon:"
ANY_WEAPON = "anything"

# Unlock sheets: earnable ("Basic Weapons - 3 Ceramite") and relic ("Relic Weapons - 3 Gold") columns
UNLOCK_COLUMNS = {7: "earnable", 13: "relic"}
ITEM_HEADER = "item name"


def fetch_sheets(cache_dir=CACHE, refresh=False, log=print):
    """Return {sheet name: csv text}, downloading what is missing (or everything with refresh)."""
    os.makedirs(cache_dir, exist_ok=True)
    texts = {}
    for name, (sheet_id, gid) in SHEETS.items():
        path = os.path.join(cache_dir, name + ".csv")
        if refresh or not os.path.exists(path):
            try:
                with urllib.request.urlopen(EXPORT_URL.format(id=sheet_id, gid=gid), timeout=30) as response:
                    data = response.read().decode("utf-8")
                with open(path, "w", encoding="utf-8") as f:
                    f.write(data)
            except OSError as err:
                if not os.path.exists(path):
                    raise
                log(f"warning: could not download sheet {name} ({err}); using the cached copy")
        with open(path, encoding="utf-8") as f:
            texts[name] = f.read()
    return texts


def rows_of(text):
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]


def cell(rows, r, c):
    return rows[r][c] if r < len(rows) and c < len(rows[r]) else ""


def items_in(value):
    return [item.strip() for item in value.split("\n") if item.strip() and item.strip() != "-"]


def cert_name(label):
    label = re.sub(r"\s*-\s*see note\s*$", "", label, flags=re.I).strip()
    return re.sub(r"\s+marine$", "", label, flags=re.I).strip()


def entry(name, generation, cert, acquisition, **extra):
    return dict({"sheetName": name, "generation": generation, "cert": cert, "acquisition": acquisition}, **extra)


def parse_defaults(text):
    """Free weapons per cert. Neophyte weapons count for every cert of their generation."""
    rows = rows_of(text)
    out = []
    for column, generation in NEOPHYTE_COLUMNS.items():
        for r, row in enumerate(rows):
            if cell(rows, r, 1).lower() == WEAPON_SLOT:
                for name in items_in(cell(rows, r, column)):
                    out += [entry(name, generation, cert, "default") for cert in CERTS[generation]]
    width = max(len(row) for row in rows)
    for start in range(FIRST_TRIPLE, width - 2, 4):
        generation = cell(rows, GENERATION_ROW, start)
        if generation not in CERTS:
            continue
        slot, cert = "", ""
        for r in range(GENERATION_ROW + 1, len(rows)):
            if cell(rows, r, start):
                slot, cert = cell(rows, r, start).lower(), ""
            if cell(rows, r, start + 1):
                cert = cert_name(cell(rows, r, start + 1))
            if slot != WEAPON_SLOT or not cert:
                continue
            for name in items_in(cell(rows, r, start + 2)):
                if name.lower() != ANY_WEAPON:
                    out.append(entry(name, generation, cert, "default"))
    return dedupe(out)


def parse_unlocks(text, generation):
    """Earnable and relic weapons per cert, from one generation's unlock sheet."""
    rows = rows_of(text)
    out = []
    for column, acquisition in UNLOCK_COLUMNS.items():
        cert = ""
        for r in range(len(rows)):
            value = cell(rows, r, column)
            if not value or value == "-" or value.lower() == ITEM_HEADER:
                continue
            if cell(rows, r + 1, column).lower() == ITEM_HEADER:
                cert = cert_name(value)
            elif cert:
                out.append(entry(value, generation, cert, acquisition))
    return dedupe(out)


def parse_reliquary(text):
    """Named relics: ranged weapons only. They are personal, so they form their own group."""
    rows = rows_of(text)
    header = next(r for r, row in enumerate(rows) if "Name of Item" in row)
    cols = {name: i for i, name in enumerate(rows[header]) if name}
    out = []
    for row in rows[header + 1:]:
        get = lambda key: row[cols[key]].strip() if cols[key] < len(row) else ""  # noqa: E731
        slot = get("Item Slot").lower()
        if get("Name of Item") and "weapon" in slot and "melee" not in slot:
            out.append(entry(get("Name of Item"), None, RELIQUARY, "relic",
                             owner=get("Original Owner"), description=get("Description")))
    return out


def dedupe(entries):
    seen, out = set(), []
    for e in entries:
        key = (e["sheetName"], e["generation"], e["cert"], e["acquisition"])
        if key not in seen:
            seen.add(key)
            out.append(e)
    return out


def parse_all(texts):
    return (parse_defaults(texts["defaults"]) + parse_unlocks(texts["unlocks_firstborn"], "Firstborn")
            + parse_unlocks(texts["unlocks_primaris"], "Primaris") + parse_reliquary(texts["reliquary"]))


# Name resolution: each level strips more decoration from both the sheet name and the displayName
def _level0(name):
    plain = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]", "", plain.lower())


def _level1(name):
    return _level0(re.sub(r"\[[^\]]*\]", " ", name))


def _level2(name):
    name = re.sub(r"\[[^\]]*\]|\([^)]*\)|\*", " ", name)
    return _level0(re.sub(r"\b(the|pattern)\b", " ", name, flags=re.I))


LEVELS = (_level0, _level1, _level2)


class Resolver:
    def __init__(self, weapons, overrides=None):
        self.weapons = weapons
        self.overrides = {_level0(k): v for k, v in (overrides or {}).items()}
        self.index = []
        for level in LEVELS:
            table = {}
            for cls, w in weapons.items():
                key = level(w.get("displayName") or cls)
                if key:
                    table.setdefault(key, []).append(cls)
            self.index.append(table)

    def resolve(self, name):
        """Weapon classes for a sheet name: [] when nothing matches, None when the overrides ignore it."""
        key = _level0(name)
        if key in self.overrides:
            value = self.overrides[key]
            return None if value is None else [c for c in value if c in self.weapons]
        for level, table in zip(LEVELS, self.index):
            found = table.get(level(name))
            if found:
                return sorted(self.same_tag(name, found))
        return []

    def same_tag(self, name, found):
        """Among several matches, keep those carrying the sheet name's mod tag ([AoD], [CTR], ...)."""
        tag = re.match(r"\s*\[([^\]]+)\]", name)
        if not tag or len(found) < 2:
            return found
        tag = tag.group(1).lower()
        tagged = [cls for cls in found if f"[{tag}]" in (self.weapons[cls].get("displayName") or "").lower()]
        return tagged or found


def load_overrides(path=OVERRIDES):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        return {k: v for k, v in json.load(f).items() if not k.startswith("_")}


def build_roster(entries, weapons, overrides=None):
    """{classes: {cls: [entry...]}, unmatched: [entry...]} for the page."""
    resolver = Resolver(weapons, overrides)
    classes, unmatched = {}, []
    for e in entries:
        found = resolver.resolve(e["sheetName"])
        if found is None:
            continue
        if not found:
            unmatched.append(e)
        for cls in found:
            classes.setdefault(cls, []).append(e)
    return {"classes": classes, "unmatched": unmatched}


# Mods whose weapons are not Warhammer 40k content (vanilla Arma, frameworks, terrains, other settings)
NON_40K_MODS = re.compile(
    r"^(arma 3|cba_a3|ace|cup\b|legion studios|task force arrowhead|webknight flashlights|kat\b|lambs|"
    r"gruppe adler|zeus enhanced|3den|ctab|dui\b|ambient modules|weather plus|advanced developer tools|"
    r"enhanced (gps|map)|maptools|fire support plus|sci-fi support plus|drongos)", re.I)


def other_mod_weapons(weapons, magazines, ammo, roster_classes):
    """Player weapons from 40k mods that are not on any cert or relic list."""
    def does_damage(mag):
        a = ammo.get(magazines.get(mag, {}).get("ammo"), {})
        return (a.get("hit") or 0) > 0 or (a.get("indirectHit") or 0) > 0

    return sorted(cls for cls, w in weapons.items()
                  if cls not in roster_classes and w.get("type") in (1, 2, 4)
                  and not NON_40K_MODS.match(w.get("mod") or "")
                  and any(does_damage(m) for mz in w["muzzles"] for m in mz["magazines"]))


def roster_data(data, refresh=False, log=print):
    """Everything data/roster.js holds, from the trimmed page data."""
    entries = parse_all(fetch_sheets(refresh=refresh, log=log))
    roster = build_roster(entries, data["weapons"], load_overrides())
    roster["otherMods"] = other_mod_weapons(data["weapons"], data["magazines"], data["ammo"], roster["classes"])
    roster["certs"] = dict(CERTS, **{RELIQUARY: [RELIQUARY]})
    log(f"roster: {len(entries)} sheet entries -> {len(roster['classes'])} weapon classes, "
        f"{len(roster['unmatched'])} unmatched, {len(roster['otherMods'])} other-mod weapons")
    return roster


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--refresh", action="store_true", help="download the sheets again")
    args = parser.parse_args()
    with open(os.path.join(HERE, "data", "game_data.json")) as f:
        data = json.load(f)
    roster = roster_data(data, refresh=args.refresh)
    for e in roster["unmatched"]:
        print(f"  unmatched: {e['sheetName']!r} ({e['generation'] or ''} {e['cert']}, {e['acquisition']})")
    counts = {}
    for cls in roster["otherMods"]:
        mod = data["weapons"][cls]["mod"]
        counts[mod] = counts.get(mod, 0) + 1
    for mod, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  other mod: {n:4d}  {mod}")


if __name__ == "__main__":
    main()
