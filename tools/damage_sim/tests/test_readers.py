"""Tests for the PBO/config readers and the CBA settings parser.

    python3 -m unittest discover -s tools/damage_sim/tests

Tests that need the game files skip themselves when ARMA_STEAMAPPS does not point at them.
"""
import os
import sys
import unittest

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


class CbaSettings(unittest.TestCase):
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
