// Bolt wounds bandage like velocity wounds. The burns get no entries, like ACE's ThermalBurn,
// so they use each bandage's defaults.
#define BOLT_WOUND_BANDAGING \
    class VelocityWound; \
    class VelocityWoundMinor; \
    class VelocityWoundMedium; \
    class VelocityWoundLarge; \
    class BoltWound: VelocityWound {}; \
    class BoltWoundMinor: VelocityWoundMinor {}; \
    class BoltWoundMedium: VelocityWoundMedium {}; \
    class BoltWoundLarge: VelocityWoundLarge {}

class ace_medical_treatment {
    class Bandaging {
        class FieldDressing {
            BOLT_WOUND_BANDAGING;
        };
        class PackingBandage: FieldDressing {
            BOLT_WOUND_BANDAGING;
        };
        class ElasticBandage: FieldDressing {
            BOLT_WOUND_BANDAGING;
        };
        class QuikClot: FieldDressing {
            BOLT_WOUND_BANDAGING;
        };
    };
};
