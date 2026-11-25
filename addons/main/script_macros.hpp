#include "\x\cba\addons\main\script_macros_common.hpp"
#include "\x\cba\addons\xeh\script_xeh.hpp"

// Default versioning level
#define DEFAULT_VERSIONING_LEVEL 2

// Same as ACE3: functions live in <component>\functions\fnc_<name>.sqf
#ifdef DISABLE_COMPILE_CACHE
    #undef PREP
    #define PREP(fncName) DFUNC(fncName) = compile preprocessFileLineNumbers QPATHTOF(functions\DOUBLES(fnc,fncName).sqf)
#else
    #undef PREP
    #define PREP(fncName) [QPATHTOF(functions\DOUBLES(fnc,fncName).sqf), QFUNC(fncName)] call CBA_fnc_compileFunction
#endif

// Shorthands for ACE3 variables and functions, e.g. ACEGVAR(medical,const_stableVitals) -> ace_medical_const_stableVitals
#define ACEGVAR(module,var)  TRIPLES(ace,module,var)
#define QACEGVAR(module,var) QUOTE(ACEGVAR(module,var))
#define ACEFUNC(module,func) TRIPLES(DOUBLES(ace,module),fnc,func)
#define QACEFUNC(module,func) QUOTE(ACEFUNC(module,func))

// Replaces an ACE3 component's XEH entry so BACED's overrides for that component are compiled
// before ACE's own script runs. CBA_fnc_compileFunction then picks up the BACED version from
// the cache instead of ACE's file. See tools/ace_override.py.
//   comp:  ACE component, e.g. medical_treatment
//   event: ACE's XEH script name, XEH_preStart or XEH_preInit
#define ACE_XEH_HOOK(comp,event) \
    class DOUBLES(ace,comp) { \
        init = QUOTE(call compileScript [ARR_1('\MAINPREFIX\PREFIX\addons\COMPONENT\DOUBLES(ace,comp)\XEH_overrides.sqf')]; call compileScript ['\z\ace\addons\comp\event.sqf']); \
    }
