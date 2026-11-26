#include "script_component.hpp"

class CfgPatches {
    class ADDON {
        name = COMPONENT_NAME;
        units[] = {};
        weapons[] = {};
        requiredVersion = REQUIRED_VERSION;
        // Every ACE medical component is listed so BACED's config loads after all of them
        // and can patch any of their classes, including their XEH entries.
        requiredAddons[] = {
            "baced_main",
            "ace_medical",
            "ace_medical_ai",
            "ace_medical_blood",
            "ace_medical_damage",
            "ace_medical_engine",
            "ace_medical_feedback",
            "ace_medical_gui",
            "ace_medical_statemachine",
            "ace_medical_status",
            "ace_medical_treatment",
            "ace_medical_vitals"
        };
        skipWhenMissingDependencies = 1;
        author = "BACED Team";
        url = "https://github.com/Black-Templars-Team/BACED";
        VERSION_CONFIG;
    };
};

#include "CfgEventHandlers.hpp"
#include "ACE_Medical_Injuries.hpp"
#include "ACE_Medical_Treatment.hpp"
