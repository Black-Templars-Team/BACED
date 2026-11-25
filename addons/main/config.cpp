#include "script_component.hpp"

class CfgPatches {
    class ADDON {
        name = COMPONENT_NAME;
        units[] = {};
        weapons[] = {};
        requiredVersion = REQUIRED_VERSION;
        requiredAddons[] = {"cba_main", "ace_main"};
        author = "BACED Team";
        url = "https://github.com/Black-Templars-Team/BACED";
        VERSION_CONFIG;
    };
};

class CfgMods {
    class PREFIX {
        dir = "@baced";
        name = "BACED";
        picture = "A3\Ui_f\data\Logos\arma3_expansion_alpha_ca";
        hidePicture = "true";
        hideName = "true";
        actionName = "GitHub";
        action = "https://github.com/Black-Templars-Team/BACED";
        description = "Issue Tracker: https://github.com/Black-Templars-Team/BACED/issues";
    };
};
