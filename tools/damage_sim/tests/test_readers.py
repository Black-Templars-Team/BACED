"""Tests for the PBO/config readers and the CBA settings parser.

    python3 -m unittest discover -s tools/damage_sim/tests

Tests that need the game files skip themselves when ARMA_STEAMAPPS does not point at them.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import armaconfig as ac  # noqa: E402
import cbasettings as cs  # noqa: E402
import build_page  # noqa: E402
import extract  # noqa: E402

STEAM = os.environ.get("ARMA_STEAMAPPS", "/mnt/Games/SteamLibrary/steamapps")
ACE = os.path.join(STEAM, "workshop/content/107410/463939057/addons")


class TextConfig(unittest.TestCase):
    def test_unit_model_is_inherited_and_kept_in_page_data(self):
        model = r"\TIOW_SM\Marine\model\mk7_uniform.p3d"
        root = extract.Node("")
        extract.merge(root, ac.parse_text(rf'''
            class CfgVehicles {{
                class MarineBase {{model = "{model}"; isMan = 1;}};
                class Marine: MarineBase {{scope = 2; uniformClass = "Suit";}};
            }};
            class CfgWeapons {{
                class Suit {{scope = 2; class ItemInfo {{type = 801; uniformClass = "Marine";}};}};
            }};
        '''), "fixture")
        gear = extract.export_gear(root.child("CfgWeapons"), root.child("CfgVehicles"), extract.export_ai_units(root))
        self.assertEqual(gear["units"]["Marine"]["model"], model)
        self.assertEqual(gear["aiUnits"]["Marine"]["model"], model)
        trimmed = build_page.trim({"gear": gear, "weapons": {}, "ammo": {}, "settings": {}})
        for table in ("units", "aiUnits"):
            self.assertEqual(trimmed["gear"][table]["Marine"]["model"], model)

    def test_classes_values_arrays(self):
        root = ac.parse_text('''
            class CfgAmmo {
                class BulletBase;
                class Foo: BulletBase { hit = 12.5; caliber = 2; name = "a ""q"" b"; arr[] = {1, {2, 3}, "x"}; };
                class Foo2: Foo { arr[] += {4}; };
                delete Old;
            };''')
        ammo = root.get("cfgammo")
        self.assertEqual(ammo.externs, ["BulletBase"])
        self.assertEqual(ammo.deletes, ["Old"])
        foo = ammo.get("FOO")
        self.assertEqual(foo.base, "BulletBase")
        self.assertEqual(foo.get("hit"), 12.5)
        self.assertEqual(foo.get("name"), 'a "q" b')
        self.assertEqual(foo.get("arr"), [1, [2, 3], "x"])
        self.assertIsInstance(ammo.get("Foo2").get("arr"), ac.ArrayAppend)

    def test_keep_top(self):
        root = ac.parse_text("class A { x = 1; }; class B { y = 2; };", keep_top={"b"})
        self.assertIsNone(root.get("A"))
        self.assertEqual(root.get("B").get("y"), 2)

    def test_array_append_keeps_own_value(self):
        root = extract.Node("")
        extract.merge(root, ac.parse_text('''
            class Base { magazines[] = {"Inherited"}; };
            class Weapon: Base { magazines[] = {"Original"}; };
        '''), "original")
        extract.merge(root, ac.parse_text('class Weapon { magazines[] += {"Extra"}; };'), "patch")
        self.assertEqual(extract.lookup(root.child("Weapon"), "magazines"), ["Original", "Extra"])

    def test_successive_array_appends_keep_earlier_additions(self):
        root = extract.Node("")
        extract.merge(root, ac.parse_text('class Weapon { magazines[] = {"Original"}; };'), "original")
        extract.merge(root, ac.parse_text('class Weapon { magazines[] += {"First"}; };'), "first")
        extract.merge(root, ac.parse_text('class Weapon { magazines[] += {"Second"}; };'), "second")
        self.assertEqual(extract.lookup(root.child("Weapon"), "magazines"), ["Original", "First", "Second"])

    def test_array_append_uses_inherited_value_without_own_value(self):
        root = extract.Node("")
        extract.merge(root, ac.parse_text('''
            class Base { magazines[] = {"Inherited"}; };
            class Weapon: Base {};
        '''), "original")
        extract.merge(root, ac.parse_text('class Weapon { magazines[] += {"Extra"}; };'), "patch")
        self.assertEqual(extract.lookup(root.child("Weapon"), "magazines"), ["Inherited", "Extra"])


class BacedAddons(unittest.TestCase):
    def test_original_ammo_types_record_only_differences(self):
        original = extract.Node("")
        merged = extract.Node("")
        config = ac.parse_text('''
            class CfgAmmo {
                class BulletBase {ACE_damageType = "bullet";};
                class Patched: BulletBase {hit = 10;};
                class Unchanged: BulletBase {hit = 10;};
                class Untyped {hit = 10;};
                class RemovedType: BulletBase {hit = 10;};
            };
        ''')
        for root in (original, merged):
            extract.merge(root, config, "fixture")
        extract.merge(merged, ac.parse_text('''
            class CfgAmmo {
                class Patched {ACE_damageType = "bolt";};
                class Untyped {ACE_damageType = "las";};
                class RemovedType: UntypedBase {};
                class UntypedBase {hit = 10;};
                class NewAmmo {ACE_damageType = "bolt";};
            };
        '''), "BACED")
        names = ("Patched", "Unchanged", "Untyped", "RemovedType", "NewAmmo")
        ammo = {name: extract.export_ammo(merged.child("CfgAmmo").child(name)) for name in names}
        extract.add_original_ammo_types(ammo, original.child("CfgAmmo"))

        self.assertEqual({name: row["ACE_damageTypeOriginal"] for name, row in ammo.items()
                          if "ACE_damageTypeOriginal" in row},
                         {"Patched": "bullet", "Untyped": None, "RemovedType": "bullet", "NewAmmo": None})
        self.assertEqual(ammo["Patched"]["ACE_damageType"], "bolt")
        self.assertNotIn("ACE_damageType", ammo["RemovedType"])

    def test_wound_names_use_english_in_size_order_for_exported_classes(self):
        xml = '''<Project><Package>
            <Key ID="STR_ACE_Medical_Damage_BoltWound_Large"><English>Mass-Reactive Wound</English></Key>
            <Key ID="STR_ACE_Medical_Damage_BoltWound_Minor"><English>Minor Bolt Puncture</English></Key>
            <Key ID="STR_ACE_Medical_Damage_BoltWound_Medium"><English>Bolt Wound</English></Key>
            <Key ID="STR_ACE_Medical_Damage_LasBurn_Minor"><English>Minor Las Weal</English></Key>
            <Key ID="STR_ACE_Medical_Damage_Contusion"><English>Contusion</English></Key>
        </Package></Project>'''
        wounds = {"BoltWound": {}, "Contusion": {}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "stringtable.xml"
            self.assertEqual(extract.read_wound_names(path, wounds), {})
            path.write_text(xml, encoding="utf-8")
            self.assertEqual(extract.read_wound_names(path, wounds), {
                "BoltWound": ["Minor Bolt Puncture", "Bolt Wound", "Mass-Reactive Wound"],
            })

    def test_compat_keeps_baced_source_only_with_required_addons(self):
        addons = []
        for label, patch in (("ACE", "class ace_medical_damage {};"), ("40k", "class CTR_Weapons {};"),
                             ("BACED", '''class baced_compat_CTR {
                                 skipWhenMissingDependencies = 1;
                                 requiredAddons[] = {"ace_medical_damage", "CTR_Weapons"};
                             };''')):
            pbo = label + ".pbo"
            extract.add_addon(addons, label, pbo, pbo, ac.parse_text(f"class CfgPatches {{ {patch} }};"))
        skipped = []
        self.assertEqual(extract.filter_missing(addons, skipped)[-1]["label"], "BACED")
        self.assertEqual(skipped, [])
        self.assertEqual(extract.filter_missing([addons[0], addons[2]], skipped), addons[:1])
        self.assertEqual(skipped, [{"mod": "BACED", "pbo": "BACED.pbo", "patches": ["baced_compat_CTR"],
                                    "reason": "skipWhenMissingDependencies: ctr_weapons"}])

    def test_compat_skips_addons_that_require_a_skipped_addon(self):
        addons = []
        for label, patch in (
            ("A", 'class A { skipWhenMissingDependencies = 1; requiredAddons[] = {"Missing"}; };'),
            ("B", 'class B { skipWhenMissingDependencies = 1; requiredAddons[] = {"A"}; };'),
            ("C", "class C {};"),
        ):
            pbo = label + ".pbo"
            extract.add_addon(addons, label, pbo, pbo, ac.parse_text(f"class CfgPatches {{ {patch} }};"))

        skipped = []
        self.assertEqual(extract.filter_missing(addons, skipped), addons[2:])
        self.assertCountEqual([entry["mod"] for entry in skipped], ["A", "B"])


class CbaSettings(unittest.TestCase):
    def test_numeric_defines_ignore_dotted_version(self):
        self.assertEqual(cs.parse_defines('''
            #define VERSION 1.0.1
            #define COUNT 4
            #define RATE -.5
        '''), {"COUNT": 4, "RATE": -0.5})

    def test_export_file(self):
        parsed = cs.parse_cba_settings_file('''
            force force ace_medical_playerDamageThreshold = 4;
            force HOV_HUD_ONLY = true;
            ace_medical_gui_damageColor_0 = [1,1,1,1];
            force HOV_MK7_ARMOR = "A,B";''')
        self.assertEqual(parsed["ace_medical_playerDamageThreshold"], 4)
        self.assertIs(parsed["HOV_HUD_ONLY"], True)
        self.assertEqual(parsed["ace_medical_gui_damageColor_0"], [1, 1, 1, 1])
        self.assertEqual(parsed["HOV_MK7_ARMOR"], "A,B")

    def test_add_setting_calls(self):
        text = '''
            [QGVAR(enable), "CHECKBOX", ["a", "b"], "cat", [true], true] call CBA_fnc_addSetting;
            ["HOV_MK7_BODY_ARMOR", "SLIDER", "Body", ["c", "d"], [10, 5000, 600, 0], true] call CBA_fnc_addSetting;
            [QEGVAR(medical,deathChance), "SLIDER", "x", "c", [0, 1, LIMIT, 2]] call CBA_fnc_addSetting;'''
        found = cs.parse_settings(text, prefix="kat_breathing", defines={"LIMIT": 1})
        self.assertIs(found["kat_breathing_enable"]["default"], True)
        self.assertEqual(found["HOV_MK7_BODY_ARMOR"]["default"], 600)
        self.assertEqual(found["kat_medical_deathChance"]["default"], 1)


@unittest.skipUnless(os.path.exists(os.path.join(ACE, "ace_medical_damage.pbo")), "ACE workshop files not found")
class AcePbo(unittest.TestCase):
    def test_injuries_config(self):
        data, binary = ac.find_config(os.path.join(ACE, "ace_medical_damage.pbo"))
        self.assertTrue(binary)
        root = ac.parse_rapified(data, {"ace_medical_injuries", "cfgammo"})
        bullet = root.get("ACE_Medical_Injuries").get("damageTypes").get("bullet")
        self.assertEqual(bullet.get("thresholds"), [[20, 10], [4.5, 2], [3, 1], [0, 1]])
        self.assertEqual(root.get("CfgAmmo").get("BulletBase").get("ACE_damageType"), "bullet")


if __name__ == "__main__":
    unittest.main()
