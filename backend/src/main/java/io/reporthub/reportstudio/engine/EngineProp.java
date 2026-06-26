package io.reporthub.reportstudio.engine;

import java.util.List;

/**
 * One declared configuration field of an engine — the unit that makes configuration engine-driven.
 * An engine returns its {@code instanceProps()} (install-time) and {@code reportProps()} (per-report)
 * as lists of these; the frontend renders one generic form per list, so picking an engine determines
 * exactly how it is configured.
 *
 * @param key         field key — for {@code UNIT_CONFIG_JSON} this is the JSON key (e.g. {@code sql});
 *                    for {@code INSTANCE_COLUMN} it maps to an EngineInstance column
 * @param label       human label shown in the form
 * @param type        control hint: text | textarea | sql | password | url | select | number | bool
 * @param required    whether the field must be filled
 * @param placeholder example/hint text
 * @param help        longer help text (nullable)
 * @param options     allowed values for {@code select} (empty otherwise)
 * @param storedIn    where the value persists: INSTANCE_COLUMN | INSTANCE_PROPS | UNIT_CONFIG_JSON
 */
public record EngineProp(
        String key,
        String label,
        String type,
        boolean required,
        String placeholder,
        String help,
        List<String> options,
        String storedIn
) {
    public static final String UNIT_CONFIG_JSON = "UNIT_CONFIG_JSON";
    public static final String INSTANCE_COLUMN = "INSTANCE_COLUMN";
    public static final String INSTANCE_PROPS = "INSTANCE_PROPS";

    /** A per-report field stored in the render unit's configJson under {@code key}. */
    public static EngineProp report(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), UNIT_CONFIG_JSON);
    }

    /** An install-time field stored in an EngineInstance column. */
    public static EngineProp instanceColumn(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), INSTANCE_COLUMN);
    }

    /** An install-time field stored in the EngineInstance props bag (carried via {@code note} as JSON). */
    public static EngineProp instanceProp(String key, String label, String type, boolean required, String placeholder) {
        return new EngineProp(key, label, type, required, placeholder, null, List.of(), INSTANCE_PROPS);
    }
}
