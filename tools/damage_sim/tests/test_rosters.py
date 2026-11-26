"""Tests for the cert and relic roster parser, on saved copies of the BT sheets.

    python3 -m unittest discover -s tools/damage_sim/tests
"""
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import rosters  # noqa: E402

FIXTURES = os.path.join(HERE, "fixtures", "sheets")


def fixture(name):
    with open(os.path.join(FIXTURES, name + ".csv"), encoding="utf-8") as f:
        return f.read()


def names(entries, generation, cert, acquisition):
    return {e["sheetName"] for e in entries
            if e["generation"] == generation and e["cert"] == cert and e["acquisition"] == acquisition}


class Sheets(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.defaults = rosters.parse_defaults(fixture("defaults"))
        cls.firstborn = rosters.parse_unlocks(fixture("unlocks_firstborn"), "Firstborn")
        cls.primaris = rosters.parse_unlocks(fixture("unlocks_primaris"), "Primaris")
        cls.reliquary = rosters.parse_reliquary(fixture("reliquary"))

    def test_cert_label_carries_down_the_weapon_block(self):
        tactical = names(self.defaults, "Firstborn", "Tactical", "default")
        self.assertIn("[Astartes] Meltagun [Moderation Standard]", tactical)
        self.assertIn("Godwyn Bolt Pistol (Secondary)", tactical)
        self.assertNotIn("[Astartes] Mars Pattern Lascannon", tactical)
        self.assertIn("[Astartes] Mars Pattern Lascannon", names(self.defaults, "Firstborn", "Devastator", "default"))

    def test_neophyte_weapons_count_for_every_cert_of_the_generation(self):
        for cert in rosters.CERTS["Firstborn"]:
            self.assertIn("[Astartes] Godwyn Pattern Boltgun (Imperium)",
                          names(self.defaults, "Firstborn", cert, "default"))
        self.assertIn("[CTR] Bolt Carbine", names(self.defaults, "Primaris", "Eliminator", "default"))

    def test_anything_is_not_a_weapon(self):
        self.assertFalse(any(e["sheetName"].lower() == "anything" for e in self.defaults))

    def test_unlock_columns(self):
        self.assertIn("[AoD] Umbra Boltgun", names(self.firstborn, "Firstborn", "Tactical", "earnable"))
        self.assertIn("[Dos] Relic Bolter", names(self.firstborn, "Firstborn", "Tactical", "relic"))
        self.assertIn("[AOD] Lascutter", names(self.firstborn, "Firstborn", "Devastator", "relic"))
        self.assertIn("Shrike Bolt Sniper Rifle [Relic] (BT)", names(self.primaris, "Primaris", "Eliminator", "relic"))
        self.assertIn("Absolver Pistol", names(self.primaris, "Primaris", "Bladeguard", "earnable"))
        self.assertFalse(any(e["sheetName"] in ("-", "Item Name") for e in self.firstborn + self.primaris))

    def test_reliquary_keeps_ranged_weapons_only(self):
        relics = {e["sheetName"]: e for e in self.reliquary}
        self.assertIn("Halbalas Hatred", relics)
        self.assertIn("Tergum Consilium", relics)
        self.assertNotIn("Blade Of The Aquila", relics)
        self.assertNotIn("Faith's Mantle", relics)
        self.assertEqual(relics["Halbalas Hatred"]["owner"], "Tyrian Halbalas")
        self.assertEqual(relics["Halbalas Hatred"]["cert"], rosters.RELIQUARY)


class Resolve(unittest.TestCase):
    WEAPONS = {
        "Primaris_Dos_Bolt_Rifle": {"displayName": "[PP] Bolt Rifle"},
        "Taj_Melta": {"displayName": "Melta Gun (BT)"},
        "AoD_Umbra": {"displayName": "[AoD] Umbra Boltgun"},
        "Steve_Umbra": {"displayName": "[AOD] Umbra Boltgun"},
        "Other_Umbra": {"displayName": "[XYZ] Umbra Boltgun"},
    }

    def test_levels_and_tags(self):
        resolver = rosters.Resolver(self.WEAPONS)
        self.assertEqual(resolver.resolve("PP Bolt Rifle"), ["Primaris_Dos_Bolt_Rifle"])
        self.assertEqual(resolver.resolve("Melta Gun [BT]"), ["Taj_Melta"])
        self.assertEqual(resolver.resolve("[AoD] Umbra Boltgun"), ["AoD_Umbra", "Steve_Umbra"])
        self.assertEqual(resolver.resolve("Missing Gun"), [])

    def test_overrides_win(self):
        resolver = rosters.Resolver(self.WEAPONS, {"PP Bolt Rifle": ["Taj_Melta"], "Missing Gun": None})
        self.assertEqual(resolver.resolve("pp bolt rifle"), ["Taj_Melta"])
        self.assertIsNone(resolver.resolve("Missing Gun"))

    def test_unmatched_entries_are_reported(self):
        entries = [rosters.entry("Missing Gun", "Firstborn", "Tactical", "default"),
                   rosters.entry("PP Bolt Rifle", "Primaris", "Intercessor", "default")]
        roster = rosters.build_roster(entries, self.WEAPONS)
        self.assertEqual([e["sheetName"] for e in roster["unmatched"]], ["Missing Gun"])
        self.assertEqual(roster["classes"]["Primaris_Dos_Bolt_Rifle"][0]["cert"], "Intercessor")


if __name__ == "__main__":
    unittest.main()
