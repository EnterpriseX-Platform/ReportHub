package io.reporthub.reportstudio.service.etl;

import java.util.Map;

/**
 * What a step did.
 *
 * @param ok       whether the chain may continue past this step
 * @param message  one line for the round history, in the user's language
 * @param rowsRead rows the step read, when that means anything
 * @param affected rows the step wrote, when that means anything
 * @param output   published for later steps to read via {@code {{name.field}}}
 */
public record StepResult(boolean ok, String message, Integer rowsRead, Integer affected,
                         Map<String, Object> output) {

    public static StepResult ok(String message, Integer rowsRead, Integer affected, Map<String, Object> output) {
        return new StepResult(true, message, rowsRead, affected, output);
    }

    public static StepResult failed(String message) {
        return new StepResult(false, message, null, null, Map.of());
    }
}
