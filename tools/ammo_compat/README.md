# Ammo compatibility addons

Each generated `addons/compat_<slug>/` addon patches one 40k mod's ammo to use
BACED's `bolt`, `plasma`, `melta`, `laser`, or `volkite` damage types, or ACE's
`burn` for flamers. `skipWhenMissingDependencies = 1` lets Arma skip each patch
when its target mod or another required addon is absent.

The `after` list controls ordering when a later mod re-declares an ammo class
with a new parent or `ACE_damageType`. The later mod's compat addon requires
the earlier compat addon so it can reapply the patch in the right order.

`ammo_map.json` was built from the BT preset's configs using the damage sim's
`extract.py` reader. To regenerate the addons, run from the repo root:

```sh
python3 tools/ammo_compat/generate.py
```

The generator replaces only the addon directories named by the map. Do not
edit the generated files by hand.
