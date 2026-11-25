# BACED - instructions for Claude

BACED is a patch mod loaded alongside ACE3 (and CBA A3). It ships only `baced_*` addons (prefix `z\baced`) and changes ACE3 by overriding individual ACE functions or config entries, never by shipping copies of ACE addons.

- `baced` is the working branch and the PR target. `master` is an untouched mirror of upstream ACE3: never commit to it; read ACE source from it with `git show master:<path>`.
- Build/lint: `hemtt check` and `hemtt build` must pass before committing.

## Writing code

All SQF and config written here must follow **both** rule sets below:
1. The ACE3 Coding Guidelines (source: https://ace3.acemod.org/wiki/development/coding-guidelines), adapted for BACED.
2. Bohemia Interactive's Code Optimisation rules (source: https://community.bistudio.com/wiki/Code_Optimisation).

When the two conflict, readability and the ACE3 guideline win, unless the code is a hot path (per-frame handler, frequent event, large loop); then optimise and leave a comment saying why (ACE3 7.1).

When editing an **override** of an ACE function (`addons/<addon>/ace_<component>/functions/`), keep the diff against ACE's original minimal and in ACE's style, so `tools/ace_override.py check` diffs stay readable when ACE changes the function.

## BACED specifics

- Override an ACE function: `python3 tools/ace_override.py add <component> <function>`; never hand-copy files or whole ACE addons. Remove with `remove`, check drift after syncing `master` with `check`.
- Override files compile with ACE's macros: `GVAR`, `FUNC`, `EFUNC`, `QPATHTOF` there refer to **ACE** (`ace_<component>_...`). Don't rewrite them to BACED names.
- BACED's own code (outside `ace_*` folders) uses BACED's macros: `GVAR(x)` -> `baced_<component>_x`, `FUNC(x)` -> `baced_<component>_fnc_x`. Reach ACE with `ACEGVAR(module,var)` / `ACEFUNC(module,func)` (and the `Q` variants), not hard-coded strings.
- Config changes to ACE classes go in the BACED addon's config (that addon's `requiredAddons` must include the ACE addon being patched).
- Stringtable keys for BACED: `STR_BACED_<component>_<name>`.
- BACED has no call-stack tracing: `CALLSTACK`, `CALLSTACK_NAMED`, `SETVAR`-family and ACE's performance counters exist only inside override files (ACE's macros).

## ACE3 Coding Guidelines (adapted to BACED)

### Naming
- Globals: `<prefix>_<component>_<name>` via the `GVAR` family; never a `fnc_` prefix on non-code values.
- Functions: `<prefix>_<component>_fnc_<name>` via `PREP`.
- Private variables: descriptive names (`_velocity`, not `_v`).

### Files and config
- `.sqf` for scripts, `.hpp` for headers; one function per file in `functions\fnc_<name>.sqf`, registered with `PREP(name)` in `XEH_PREP.hpp`.
- Split config into one `.hpp` per top-level config class (e.g. `CfgVehicles.hpp`), included from `config.cpp`.
- All user-facing text goes in `stringtable.xml` (no empty language values); use `LSTRING`/`LLSTRING`/`CSTRING` and the `E` variants.
- Code inside config strings is wrapped in `QUOTE()`. Use `QQGVAR`/`QQEFUNC` for double quotes inside `QUOTE`.
- Never use `FUNC`/`EFUNC` inside `QUOTE` to get a function **name** (call tracing may change their expansion); use `DFUNC`/`DEFUNC`/`QFUNC`/`QEFUNC`. Calling `FUNC` inside `QUOTE` to execute it is fine.
- Use `LINKFUNC(x)` when passing a function as an event handler, so it picks up recompiles.
- Paths via `PATHTOF`/`QPATHTOF`/`PATHTOEF`/`QPATHTOEF`, never literal `\z\...` strings.

### Function files
- First line: `#include "..\script_component.hpp"` (override files may start with the BACED override comment line written by the tool, then the include). Other includes/defines below it, then code.
- Header before any code:
  ```sqf
  /*
   * Author: [Name]
   * [Description]
   *
   * Arguments:
   * 0: Unit <OBJECT>
   * 1: Optional value <NUMBER> (default: 0)
   *
   * Return Value:
   * Description <BOOL>
   *
   * Example:
   * [player, 1] call baced_medical_fnc_example
   *
   * Public: No
   */
  ```
  Types UPPERCASE in `<>`, one of: `OBJECT NUMBER STRING BOOL ARRAY CONTROL DISPLAY CONFIG CODE ANY SIDE GROUP HASHMAP NAMESPACE LOCATION STRUCTUREDTEXT NIL`; `<A or B>` for multiple, `<ARRAY of TYPEs>` for typed arrays, `(default: x)` for optional args, `None` when there are no arguments/return value.
- Max 250 lines of code per function (excluding header and includes).

### Global variables
- Declare every global with a default in the component's `XEH_preInit.sqf` (except dynamically generated ones and BI/CBA/ACE globals).
- Don't pass data between functions through globals; use arguments.
- No constant globals or repeated constant privates: use `#define` (in `script_component.hpp` if shared).
- No magic numbers: name them with `#define` at the top of the file or in `script_component.hpp`.

### Style
- 4-space indents, no tabs, no trailing whitespace, LF line endings (see `.editorconfig`).
- Opening brace on the same line as the statement; closing brace on its own line at the statement's indentation; `} else {` on one line. Same for config classes (`class A: B {`).
- Comments: `//` inline, `/* */` for blocks. Comment *why* or complex sections, not what the obvious code does. Delete commented-out code.
- Minimal parentheses, but always wrap conditions: `if (_x) then`, `if (!_x) then`, or `if !(_a && {_b}) then`.
- Spaces after commas in arrays: `[0, 0, 0]`, `params ["_unit", "_vehicle"]`.

### Code standards
- Get arguments with `params`/`param` (type-check them in public functions); `PARAM_x` and `BIS_fnc_param` are not allowed.
- Every private variable is declared with `private` at initialization (or `private [...]`/`params`); declare at the smallest feasible scope and only when it can get a meaningful value (`private _x = [a, b] select _cond;` rather than init-then-overwrite).
- `getVariable` always with a default (`_obj getVariable ["name", 0]`), or check the result with `isNil` and exit; never a default assigned after a `nil` check.
- Test returned error information; no unreachable code; return a meaningful value or `nil`.
- `for` loops: init and increment expressions touch only the single loop variable; prefer `for "_i" from a to b step c do {}` over the `for [{},{},{}]` form.
- Code used more than once goes in its own function (unless < 5 lines and only in a per-frame handler).
- Use CBA/ACE logging and debug macros (`TRACE_n`, `INFO`, `WARNING`, `ERROR`) where useful.

### Design and performance
- Stay unscheduled; avoid `spawn` and `execVM`. No `waitUntil` (use `CBA_fnc_waitUntilAndExecute`); no infinite `while {true}` loops (`while` only for an unknown finite number of steps). Use `CBA_fnc_addPerFrameHandler`/`CBA_fnc_waitAndExecute` for timed work.
- Event-driven: use CBA events (`CBA_fnc_addEventHandler`, `CBA_fnc_localEvent`/`globalEvent`/`targetEvent`) and CBA player events.
- Arrays: `pushBack` for one element, `append` for several (`set` only for a computed index); empty check with `_array isEqualTo []`.
- `createVehicle` array syntax; spawn at `[0, 0, 0]` then `setPos*` (except `#` objects such as `#lightsource`).

## Bohemia Interactive Code Optimisation rules

**Not filled in yet.** The page is behind a Cloudflare check that blocks automated access, so its content could not be read. Until it's added here, apply the ACE3 performance rules above and ask the user before relying on anything else from the page. To fill this in, paste or save the page's text and have Claude summarise it into this section.
