class ACE_Medical_Injuries {
    class wounds {
        // Mass-reactive shell that burst inside the body after penetrating armour
        class BoltWound {
            bleeding = 0.15;
            pain = 1.0;
            causeLimping = 1;
            causeFracture = 1;
        };
        // Deep burn of boiled flesh from a plasma bolt
        class PlasmaBurn {
            bleeding = 0.02;
            pain = 0.9;
            causeLimping = 1;
        };
        // Crater burned through the body, mostly cauterised by the heat
        class MeltaBurn {
            bleeding = 0.03;
            pain = 1.0;
            causeLimping = 1;
            causeFracture = 1;
        };
        // From a surface las weal up to a cauterised perforation
        class LasBurn {
            bleeding = 0.01;
            pain = 0.6;
            causeLimping = 1;
        };
        // Flash-cooked flesh that bursts open
        class VolkiteBurn {
            bleeding = 0.06;
            pain = 0.9;
            causeLimping = 1;
        };
    };

    // Not inherited from bullet: ACE's parser also inherits wound subclasses (configProperties),
    // which would pull in bullet's Avulsion/Contusion/VelocityWound
    class damageTypes {
        class woundHandlers;

        class bolt {
            thresholds[] = {{20, 10}, {4.5, 3}, {3, 2}, {0, 1}};
            selectionSpecific = 1;
            class woundHandlers: woundHandlers {
                ACEGVAR(medical_damage,armorPenetration) = QACEFUNC(medical_damage,woundsHandlerArmorPenetration);
            };
            // the plate held: big bruise, as ACE's bullet
            class Contusion {
                weighting[] = {{0.35, 0}, {0.35, 1}};
                sizeMultiplier = 3.2;
                painMultiplier = 2.2;
            };
            // armour spall driven into the muscle
            class Laceration {
                weighting[] = {{0.6, 0}, {0.35, 1}, {0.35, 0}};
            };
            class BoltWound {
                weighting[] = {{1.5, 1}, {0.35, 1}, {0.35, 0}};
            };
            // limbs blown off
            class Avulsion {
                weighting[] = {{1.5, 1}, {1, 0}};
            };
        };
        class plasma {
            thresholds[] = {{20, 10}, {4.5, 2}, {3, 1}, {0, 1}};
            selectionSpecific = 1;
            class woundHandlers: woundHandlers {
                ACEGVAR(medical_damage,armorPenetration) = QACEFUNC(medical_damage,woundsHandlerArmorPenetration);
            };
            class PlasmaBurn {
                weighting[] = {{0, 1}};
            };
            // severing
            class Avulsion {
                weighting[] = {{1.5, 1}, {1, 0}};
            };
        };
        class melta {
            thresholds[] = {{20, 10}, {4.5, 2}, {0, 1}};
            selectionSpecific = 1;
            class woundHandlers: woundHandlers {
                ACEGVAR(medical_damage,armorPenetration) = QACEFUNC(medical_damage,woundsHandlerArmorPenetration);
            };
            class MeltaBurn {
                weighting[] = {{0, 1}};
            };
            class Avulsion {
                weighting[] = {{2, 1}, {1.5, 0}};
            };
        };
        class laser {
            thresholds[] = {{20, 10}, {4.5, 2}, {3, 1}, {0, 1}};
            selectionSpecific = 1;
            class woundHandlers: woundHandlers {
                ACEGVAR(medical_damage,armorPenetration) = QACEFUNC(medical_damage,woundsHandlerArmorPenetration);
            };
            class LasBurn {
                weighting[] = {{0, 1}};
            };
        };
        class volkite {
            thresholds[] = {{20, 10}, {4.5, 2}, {3, 1}, {0, 1}};
            selectionSpecific = 1;
            class woundHandlers: woundHandlers {
                ACEGVAR(medical_damage,armorPenetration) = QACEFUNC(medical_damage,woundsHandlerArmorPenetration);
            };
            class VolkiteBurn {
                weighting[] = {{0, 1}};
            };
            class Avulsion {
                weighting[] = {{1.5, 1}, {1, 0}};
            };
        };
    };
};
