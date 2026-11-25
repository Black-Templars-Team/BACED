// Included by each ace_<component> override folder, after that ACE component's own script_component.hpp.
// Overridden functions are therefore compiled with ACE's PREFIX and COMPONENT, so code copied from ACE3
// keeps working unchanged (GVAR, FUNC, QPATHTOF etc. still point at ACE's variables and files).
//
// OVERRIDE_PATH must be defined by the including file, e.g. \z\baced\addons\medical\ace_medical_treatment

// Registers BACED's copy of an ACE function under ACE's function name, e.g. ace_medical_treatment_fnc_canBandage
#define OVERRIDE(fncName) [QUOTE(OVERRIDE_PATH\functions\DOUBLES(fnc,fncName).sqf), QFUNC(fncName)] call CBA_fnc_compileFunction
