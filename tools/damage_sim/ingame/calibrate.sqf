/*
    BWB calibration for damage_model.js. Paste the entire file into the Arma 3
    debug console in single-player with CBA, ACE Medical and the target/ammo mods
    loaded, choose Local Exec, then resume the mission. Use a clear, flat range.
    Battery runs on its own; don't fire while it runs. For manual logging, point
    at a target before opening the console, then fire one round at a time so
    callbacks can be attributed to the current shot. With no man under the
    cursor, manual watches nearby men and RUN describes the nearest one.
    To stop and write DONE in manual mode, run [] call BWB_fnc_finish in the console.

    This is a standalone debug-console script, not part of any addon. It is exempt
    from one-function-per-file, PREP, XEH_preInit global defaults and the rule against
    sharing data between functions through globals. Its BWB_* globals hold the
    session state and are replaced on re-execution.

    In the newest Arma3_*.rpt under %LOCALAPPDATA%\Arma 3\, send the BWB| lines.
    Each message is BWB|TYPE|[SQF array payload]; speed is m/s, distance is m.
    RUN       [productVersion, ACE, CBA, settings, mode, ammo, class, uniform, vest, headgear, backpack]
    SELECTIONS [class, present selections, missing selections]
    AIM       [name, model position]
    POSE      [id, animation state, unit position]
    SHOT      [id, direct/blast/range, aim name/distance, speed, model position]
              Blast distance is measured at explosion (-1 if not observed).
              Range distance is nominal; field 6 is the name of the aim point.
    BLASTPOS  [id, horizontal distance, explosion ASL]
    FIRED     [id, ammo, speed, shooter ASL, frame, tick time]
    HITPART   [id, selections, model impact, speed, velocity, shooter distance, radius, surface, direct, ammo, frame]
    HD        [id, selection, hit point, index, damage, previous, delta, projectile, direct, context, frame]
    WOUND     [id, all damages, ammo, frame]
    STATE     [id, open wounds as pairs, body part damage, pain, fractures, cardiac arrest, unconscious, alive]
    DONE      [counts as [record type, count] pairs]
*/

private _mode = "battery"; // "battery" or "manual"
private _targetClass = "30k_Steve_Tactical_Legionary_MK_4_WB";
private _ammoClass = "CTR_Bolt_Round";
private _speeds = [400, 600, 720, 850, 1000];
private _reps = 3;
private _selections = [
    "head", "neck", "spine3", "spine2", "spine1", "pelvis", "leftarm", "rightarm",
    "leftupleg", "rightupleg", "leftleg", "rightleg"
];
// Aim points: [name, selection, optional model position]. Positions are read with selectionPosition once
// the A-pose has settled, because fixed model-space points from the rifle pose miss in the A-pose. The head
// selection sits off the head's hit volume, so the head uses a fixed point instead: the centre of the head
// hits in the crouch probe on the Mk 4 (standing, the bounding box cuts the head off above model z 1.9).
private _aimSelections = [
    ["head", "head", [0.10, 0.51, 1.38]],
    ["chest", "spine3"],
    ["diaphragm", "spine2"],
    ["pelvis", "pelvis"],
    ["upper left leg", "leftupleg"],
    ["lower left leg", "leftleg"],
    ["left forearm", "leftforearm"],
    ["right forearm", "rightforearm"]
];
// Aim names to fire at (empty = all) and the battery phases to run ("direct", "blast", "range", "probe").
// "probe" fires one 1000 m/s round at each point of a grid around the head selection (model x and z
// offsets, y = 0), logged as direct shots aimed at "head probe <pose>", to map where the head can be hit.
private _aimOnly = ["head"];
private _phases = ["direct", "range"];
private _probeX = [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4];
private _probeZ = [-0.3, -0.25, -0.2, -0.15, -0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35];
// Target poses, run in order as separate sections: "rifle" (standing with rifle), "crouch" (kneeling with
// rifle) or "apose" (standing unarmed; use it alone, as it removes the weapon). The Mk 4's bounding box
// doesn't reach the head in the A-pose (an engine bug), so the head can't be hit there; the rifle pose's
// slight hunch and the crouch bring it inside. Aim points for "direct"/"range" are read in the first pose.
private _poses = ["crouch"];
private _blastDistances = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
private _rangeDistances = [25, 100, 300];
private _magazineInitSpeed = 1000; // CTR_Bolt_Round magazine, m/s
private _spawnDistance = 20;
private _shotDelay = 1.5;

if (!isNil "BWB_fnc_cleanup") then {[] call BWB_fnc_cleanup};
if (isMultiplayer || {isNull player}) exitWith {hint "BWB: use Local Exec in single-player."};
if !(_mode in ["battery", "manual"]) exitWith {hint "BWB: choose battery or manual."};
if (isNil "CBA_fnc_addEventHandler" || {isNil "CBA_fnc_execNextFrame"} ||
    {isNil "CBA_fnc_waitAndExecute"} || {isNil "ace_medical_treatment_fnc_fullHealLocal"}) exitWith {
    hint "BWB: CBA and ACE Medical are required.";
};

private _targetConfig = configFile >> "CfgVehicles" >> _targetClass;
private _ammoConfig = configFile >> "CfgAmmo" >> _ammoClass;
if (_mode == "battery" && {!(isClass _targetConfig) || {!(isClass _ammoConfig)}}) exitWith {
    hint "BWB: target or ammo class not found; check loaded mods.";
};

BWB_generation = (missionNamespace getVariable ["BWB_generation", 0]) + 1;
BWB_active = true;
BWB_mode = _mode;
BWB_shooter = player;
BWB_shotId = 0;
BWB_targets = [];
BWB_unitHandlers = [];
BWB_firedHandler = -1;
BWB_woundHandler = -1;
BWB_target = objNull;
BWB_group = grpNull;
BWB_projectile = objNull;
BWB_pendingBlast = [];
BWB_recordTypes = ["RUN", "SELECTIONS", "AIM", "POSE", "SHOT", "BLASTPOS", "FIRED", "HITPART", "HD", "WOUND", "STATE"];
BWB_counts = createHashMap;

BWB_fnc_unwatch = {
    {
        _x params ["_unit", "_event", "_handlerId"];
        if (!isNull _unit) then {_unit removeEventHandler [_event, _handlerId]};
    } forEach BWB_unitHandlers;
    BWB_unitHandlers = [];
    BWB_targets = [];
};

BWB_fnc_cleanup = {
    // Queued CBA callbacks check active/generation before touching session state.
    BWB_active = false;
    [] call BWB_fnc_unwatch;
    if (BWB_firedHandler >= 0 && {!isNull BWB_shooter}) then {
        BWB_shooter removeEventHandler ["Fired", BWB_firedHandler];
    };
    if (BWB_woundHandler >= 0) then {
        ["ace_medical_woundReceived", BWB_woundHandler] call CBA_fnc_removeEventHandler;
    };
    BWB_firedHandler = -1;
    BWB_woundHandler = -1;
    if (!isNull BWB_projectile) then {deleteVehicle BWB_projectile};
    if (!isNull BWB_target) then {deleteVehicle BWB_target};
    if (!isNull BWB_group) then {deleteGroup BWB_group};
    BWB_projectile = objNull;
    BWB_target = objNull;
    BWB_group = grpNull;
};

BWB_fnc_logValue = {
    params ["_value"];
    // Mod settings and wound data can be nested. Never serialize engine handles.
    if (_value isEqualType createHashMap) then {_value = toArray _value};
    if (_value isEqualType []) exitWith {
        _value apply {if (isNil "_x") then {"<nil>"} else {[_x] call BWB_fnc_logValue}}
    };
    if (_value isEqualTypeAny [0, "", false]) exitWith {_value};
    format ["<%1>", typeName _value]
};

BWB_fnc_log = {
    params ["_type", "_fields"];
    diag_log text format ["BWB|%1|%2", _type, str ([_fields] call BWB_fnc_logValue)];
    BWB_counts set [_type, (BWB_counts getOrDefault [_type, 0]) + 1];
};

BWB_fnc_finish = {
    if (!BWB_active) exitWith {};
    private _counts = BWB_recordTypes apply {[_x, BWB_counts getOrDefault [_x, 0]]};
    ["DONE", [_counts]] call BWB_fnc_log;
    [] call BWB_fnc_cleanup;
    hint "BWB calibration done";
};

private _settings = [];
{
    if (!isNil _x) then {
        _settings pushBack [_x, missionNamespace getVariable [_x, []]];
    };
} forEach [
    "ace_medical_playerDamageThreshold", "ace_medical_AIDamageThreshold",
    "ace_medical_alternateArmorPenetration", "ace_medical_fatalDamageSource",
    "ace_medical_deathChance", "ace_medical_painUnconsciousChance", "ace_medical_painCoefficient",
    "ace_medical_useLimbDamage", "ace_medical_statemachine_fatalInjuriesAI",
    "ace_medical_statemachine_AIUnconsciousness", "HOV_HUD_ONLY", "kat_breathing_enable"
];

private _logRun = {
    params ["_unit"];
    private _patches = configFile >> "CfgPatches";
    ["RUN", [
        productVersion, getText (_patches >> "ace_main" >> "versionStr"),
        getText (_patches >> "cba_main" >> "versionStr"), _settings,
        _mode, _ammoClass, typeOf _unit, uniform _unit, vest _unit, headgear _unit, backpack _unit
    ]] call BWB_fnc_log;
};

private _logSelections = {
    params ["_unit"];
    private _modelSelections = (selectionNames _unit) apply {toLower _x};
    private _present = _selections select {_x in _modelSelections};
    private _missing = _selections - _present;
    ["SELECTIONS", [typeOf _unit, _present, _missing]] call BWB_fnc_log;
    _present
};

BWB_fnc_watch = {
    params ["_unit"];
    BWB_targets pushBack _unit;
    private _hitPartId = _unit addEventHandler ["HitPart", {
        {
            _x params ["_target", "_shooter", "_bullet", "_impactASL", "_velocity", "_hitSelections",
                "_ammoInfo", "_direction", "_radius", "_surface", "_direct"];
            private _ammo = _ammoInfo param [4, "", [""]];
            if (_ammo == "" && {!isNull _bullet}) then {_ammo = typeOf _bullet};
            private _distance = if (isNull _shooter) then {-1} else {(getPosASL _shooter) vectorDistance _impactASL};
            ["HITPART", [BWB_shotId, _hitSelections, _target worldToModel (ASLToAGL _impactASL),
                vectorMagnitude _velocity, _velocity, _distance, _radius, _surface, _direct, _ammo,
                diag_frameNo]] call BWB_fnc_log;
        } forEach _this;
    }];
    BWB_unitHandlers pushBack [_unit, "HitPart", _hitPartId];

    // Add after ACE's unit initialization; an observer must not override its result.
    private _damageId = _unit addEventHandler ["HandleDamage", {
        params ["_target", "_selection", "_damage", "_source", "_projectile", "_hitIndex",
            "_instigator", "_hitPoint", ["_directHit", false], ["_context", -1]];
        private _previous = if (_hitIndex < 0) then {damage _target} else {_target getHitIndex _hitIndex};
        ["HD", [BWB_shotId, _selection, _hitPoint, _hitIndex, _damage, _previous,
            _damage - _previous, _projectile, _directHit, _context, diag_frameNo]] call BWB_fnc_log;
        nil
    }];
    BWB_unitHandlers pushBack [_unit, "HandleDamage", _damageId];
};

private _manualTargets = [];
if (_mode == "manual") then {
    private _underCursor = cursorTarget;
    _manualTargets = if (_underCursor isKindOf "Man" && {_underCursor != player}) then {
        [_underCursor]
    } else {
        (nearestObjects [player, ["CAManBase"], 1000]) - [player]
    };
};
if (_mode == "manual" && {_manualTargets isEqualTo []}) exitWith {
    [] call BWB_fnc_cleanup;
    hint "BWB: no manual targets found.";
};

BWB_firedHandler = player addEventHandler ["Fired", {
    params ["_shooter", "_weapon", "_muzzle", "_fireMode", "_ammo", "_magazine", "_projectile"];
    if (BWB_mode == "manual") then {BWB_shotId = BWB_shotId + 1};
    ["FIRED", [BWB_shotId, _ammo, vectorMagnitude (velocity _projectile), getPosASL _shooter,
        diag_frameNo, diag_tickTime]] call BWB_fnc_log;
}];

BWB_woundHandler = ["ace_medical_woundReceived", {
    params ["_unit", "_allDamages", "_shooter", "_ammo"];
    if !(_unit in BWB_targets) exitWith {};
    private _shotId = BWB_shotId;
    ["WOUND", [_shotId, _allDamages, _ammo, diag_frameNo]] call BWB_fnc_log;
    // ACE's other wound processing must finish before reading the medical state.
    [{
        params ["_unit", "_shotId", "_generation"];
        if (!BWB_active || {_generation != BWB_generation} || {isNull _unit}) exitWith {};
        ["STATE", [_shotId, toArray (_unit getVariable ["ace_medical_openWounds", createHashMap]),
            _unit getVariable ["ace_medical_bodyPartDamage", []],
            _unit getVariable ["ace_medical_pain", 0],
            _unit getVariable ["ace_medical_fractures", []],
            _unit getVariable ["ace_medical_inCardiacArrest", false],
            _unit getVariable ["ACE_isUnconscious", false], alive _unit]] call BWB_fnc_log;
    }, [_unit, _shotId, BWB_generation]] call CBA_fnc_execNextFrame;
}] call CBA_fnc_addEventHandler;

if (_mode == "manual") exitWith {
    [_manualTargets select 0] call _logRun;
    private _loggedClasses = [];
    {
        if ((_loggedClasses pushBackUnique (typeOf _x)) >= 0) then {[_x] call _logSelections};
        [_x] call BWB_fnc_watch;
    } forEach _manualTargets;
    hint format ["BWB logging %1 target(s)", count _manualTargets];
};

private _targetSide = [east, west, resistance, civilian] param [getNumber (_targetConfig >> "side"), side player];
BWB_group = createGroup [_targetSide, false];
BWB_targetClass = _targetClass;
BWB_targetASL = AGLToASL (player getPos [_spawnDistance, getDir player]);
// Pose name -> [locked animation, unitPos].
BWB_poseTable = createHashMapFromArray [
    ["apose", ["AmovPercMstpSnonWnonDnon", "UP"]],
    ["rifle", ["AmovPercMstpSrasWrflDnon", "UP"]],
    ["crouch", ["AmovPknlMstpSrasWrflDnon", "MIDDLE"]]
];
_poses = _poses select {_x in BWB_poseTable};
if (_poses isEqualTo []) then {_poses = ["rifle"]};
BWB_keepWeapon = !(_poses isEqualTo ["apose"]);
BWB_poseName = _poses select 0;
(BWB_poseTable get BWB_poseName) params ["_firstAnim", "_firstUnitPos"];
BWB_standingAnim = _firstAnim;
BWB_unitPos = _firstUnitPos;
BWB_headPos = [];

BWB_fnc_createTarget = {
    private _positionASL = BWB_targetASL;
    private _unit = BWB_group createUnit [BWB_targetClass, ASLToAGL _positionASL, [], 0, "CAN_COLLIDE"];
    if (!isNull _unit) then {
        _unit setPosASL _positionASL;
        _unit setDir (_unit getDir BWB_shooter);
        if (!BWB_keepWeapon) then {removeAllWeapons _unit};
        _unit setUnitPos BWB_unitPos;
        _unit disableAI "ALL";
        _unit switchMove BWB_standingAnim;
        private _animId = _unit addEventHandler ["AnimChanged", {
            params ["_unit", "_anim"];
            if (BWB_active && {alive _unit} && {toLower _anim != toLower BWB_standingAnim}) then {
                _unit switchMove BWB_standingAnim;
            };
        }];
        BWB_unitHandlers pushBack [_unit, "AnimChanged", _animId];
    };
    BWB_target = _unit;
    _unit
};

BWB_fnc_batteryStep = {
    params ["_generation", "_queue", "_index", "_ammoClass", "_shotDelay"];
    if (!BWB_active || {_generation != BWB_generation}) exitWith {};
    if !(BWB_pendingBlast isEqualTo []) then {
        BWB_pendingBlast params ["_id", "_speed", "_modelPos"];
        ["SHOT", [_id, "blast", -1, _speed, _modelPos]] call BWB_fnc_log;
        BWB_pendingBlast = [];
    };
    if (_index >= count _queue) exitWith {[] call BWB_fnc_finish};
    if (!isNull BWB_projectile) then {deleteVehicle BWB_projectile};
    BWB_projectile = objNull;

    if (!alive BWB_target) exitWith {
        [] call BWB_fnc_unwatch;
        if (!isNull BWB_target) then {deleteVehicle BWB_target};
        private _replacement = [] call BWB_fnc_createTarget;
        if (isNull _replacement) exitWith {
            [] call BWB_fnc_finish;
            hint "BWB: could not replace the target; results are partial.";
        };
        [BWB_fnc_batteryStep, [_generation, _queue, _index, _ammoClass, _shotDelay]] call CBA_fnc_execNextFrame;
    };

    private _target = BWB_target;
    if !(_target in BWB_targets) then {[_target] call BWB_fnc_watch};
    [_target] call ace_medical_treatment_fnc_fullHealLocal;
    _target setDamage 0;

    // A pose entry starts a new section: switch the locked pose and let it settle before the next shot.
    (_queue select _index) params ["_entryKind", ["_poseName", ""]];
    if (_entryKind == "pose") exitWith {
        (BWB_poseTable get _poseName) params ["_anim", "_unitPos"];
        BWB_poseName = _poseName;
        BWB_standingAnim = _anim;
        BWB_unitPos = _unitPos;
        BWB_headPos = [];
        _target setUnitPos _unitPos;
        _target switchMove _anim;
        diag_log text format ["BWB: section %1 (%2)", _poseName, _anim];
        [BWB_fnc_batteryStep, [_generation, _queue, _index + 1, _ammoClass, _shotDelay], _shotDelay]
            call CBA_fnc_waitAndExecute;
    };

    _target setUnitPos BWB_unitPos;
    _target switchMove BWB_standingAnim;
    [BWB_fnc_batteryFire, [_generation, _queue, _index, _ammoClass, _shotDelay], 0.3]
        call CBA_fnc_waitAndExecute;
};

BWB_fnc_batteryFire = {
    params ["_generation", "_queue", "_index", "_ammoClass", "_shotDelay"];
    if (!BWB_active || {_generation != BWB_generation}) exitWith {};
    private _target = BWB_target;
    if (!alive _target) exitWith {_this call BWB_fnc_batteryStep};

    (_queue select _index) params ["_kind", "_point", "_speed", "_modelPosition", ["_aimName", ""]];
    // Probe points are offsets from the head selection of the current pose, read once per section.
    if (_kind == "probe") then {
        if (BWB_headPos isEqualTo []) then {
            BWB_headPos = _target selectionPosition "head";
            ["AIM", ["head " + BWB_poseName, BWB_headPos]] call BWB_fnc_log;
        };
        _kind = "direct";
        _point = "head probe " + BWB_poseName;
        _modelPosition = BWB_headPos vectorAdd _modelPosition;
    };
    private _isBlast = _kind == "blast";
    private _targetASL = getPosASL _target;
    private _aimASL = if (_isBlast) then {
        private _ground = _target getPos [_point, (getDir _target) + 90];
        _ground set [2, getTerrainHeightASL _ground];
        _modelPosition = _target worldToModelVisual (ASLToAGL _ground);
        _ground
    } else {
        _target modelToWorldVisualWorld _modelPosition
    };
    private _direction = if (_isBlast) then {[0, 0, -1]} else {
        vectorNormalized (_aimASL vectorDiff (eyePos BWB_shooter))
    };
    private _originASL = _aimASL vectorDiff (_direction vectorMultiply (if (_isBlast) then {3} else {5}));

    BWB_shotId = _index + 1;
    ["POSE", [BWB_shotId, animationState _target, unitPos _target]] call BWB_fnc_log;
    if (!_isBlast) then {
        private _shot = [BWB_shotId, _kind, _point, _speed, _modelPosition];
        if (_kind == "range") then {_shot pushBack _aimName};
        ["SHOT", _shot] call BWB_fnc_log;
    };
    private _projectile = createVehicle [_ammoClass, [0, 0, 0], [], 0, "CAN_COLLIDE"];
    if (isNull _projectile) exitWith {
        [] call BWB_fnc_finish;
        hint "BWB: could not create calibration ammo; results are partial.";
    };
    BWB_projectile = _projectile;
    _projectile setPosASL _originASL;
    _projectile setShotParents [BWB_shooter, BWB_shooter];
    if (_isBlast) then {
        // The parser groups records by id, so SHOT can follow the damage callbacks.
        BWB_pendingBlast = [BWB_shotId, _speed, _modelPosition, _targetASL];
        _projectile addEventHandler ["Explode", {
            params ["_projectile", "_posASL"];
            if (!BWB_active || {_projectile != BWB_projectile} || {BWB_pendingBlast isEqualTo []}) exitWith {};
            BWB_pendingBlast params ["_id", "_speed", "_modelPos", "_targetASL"];
            BWB_pendingBlast = [];
            private _distance = _targetASL distance2D _posASL;
            ["SHOT", [_id, "blast", _distance, _speed, _modelPos]] call BWB_fnc_log;
            ["BLASTPOS", [_id, _distance, _posASL]] call BWB_fnc_log;
        }];
    };
    _projectile setVectorDir _direction;
    _projectile setVelocity (_direction vectorMultiply _speed);

    // The final delay also leaves time for the last wound's next-frame snapshot.
    [BWB_fnc_batteryStep, [_generation, _queue, _index + 1, _ammoClass, _shotDelay], _shotDelay]
        call CBA_fnc_waitAndExecute;
};

private _target = [] call BWB_fnc_createTarget;
if (isNull _target) exitWith {
    [] call BWB_fnc_cleanup;
    hint "BWB: could not create the target.";
};
[_target] call _logRun;
[_target] call _logSelections;
private _airFriction = getNumber (_ammoConfig >> "airFriction");

// Allow the target's standing pose to settle before probing its fire geometry.
[{
    params ["_generation", "_aimSelections", "_speeds", "_reps", "_blastDistances", "_rangeDistances",
        "_magazineInitSpeed", "_airFriction", "_ammoClass", "_shotDelay", "_aimOnly", "_phases",
        "_probeX", "_probeZ", "_poses"];
    if (!BWB_active || {_generation != BWB_generation}) exitWith {};
    private _target = BWB_target;
    private _aimPoints = [];
    {
        _x params ["_name", "_selection", ["_fixedPos", []]];
        if (_aimOnly isNotEqualTo [] && {!(_name in _aimOnly)}) then {continue};
        // selectionPosition returns [0, 0, 0] for a selection the model doesn't have.
        private _pos = [_target selectionPosition _selection, _fixedPos] select (_fixedPos isNotEqualTo []);
        if !(_pos isEqualTo [0, 0, 0]) then {
            _aimPoints pushBack [_name, _pos];
        } else {
            diag_log text format ["BWB: no position for selection %1; skipping %2 shots.", _selection, _name];
        };
    } forEach _aimSelections;

    {["AIM", _x] call BWB_fnc_log} forEach _aimPoints;
    private _queue = [];
    {
        _queue pushBack ["pose", _x];
        if ("direct" in _phases) then {
            {
                _x params ["_name", "_pos"];
                {
                    for "_rep" from 1 to _reps do {_queue pushBack ["direct", _name, _x, _pos]};
                } forEach _speeds;
            } forEach _aimPoints;
        };
        if ("blast" in _phases) then {
            {_queue pushBack ["blast", _x, 300, []]} forEach _blastDistances;
        };
        if ("probe" in _phases) then {
            {
                private _z = _x;
                {_queue pushBack ["probe", "", 1000, [_x, 0, _z]]} forEach _probeX;
            } forEach _probeZ;
        };
        if ("range" in _phases) then {
            {
                private _distance = _x;
                private _speed = _magazineInitSpeed * exp (_airFriction * _distance);
                {
                    _x params ["_name", "_pos"];
                    for "_rep" from 1 to _reps do {_queue pushBack ["range", _distance, _speed, _pos, _name]};
                } forEach _aimPoints;
            } forEach _rangeDistances;
        };
    } forEach _poses;

    hint format ["BWB battery: %1 shots", count _queue];
    [_generation, _queue, 0, _ammoClass, _shotDelay] call BWB_fnc_batteryStep;
}, [BWB_generation, _aimSelections, _speeds, _reps, _blastDistances, _rangeDistances,
    _magazineInitSpeed, _airFriction, _ammoClass, _shotDelay, _aimOnly, _phases, _probeX, _probeZ, _poses], _shotDelay]
    call CBA_fnc_waitAndExecute;
