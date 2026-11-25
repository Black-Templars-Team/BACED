class Extended_PreStart_EventHandlers {
    class ADDON {
        init = QUOTE(call COMPILE_SCRIPT(XEH_preStart));
    };
    #define HOOK(comp) ACE_XEH_HOOK(comp,XEH_preStart)
    #include "ace_overrides.hpp"
    #undef HOOK
};

class Extended_PreInit_EventHandlers {
    class ADDON {
        init = QUOTE(call COMPILE_SCRIPT(XEH_preInit));
    };
    #define HOOK(comp) ACE_XEH_HOOK(comp,XEH_preInit)
    #include "ace_overrides.hpp"
    #undef HOOK
};
