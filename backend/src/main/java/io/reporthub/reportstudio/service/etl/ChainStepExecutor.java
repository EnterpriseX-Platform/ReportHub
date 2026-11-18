package io.reporthub.reportstudio.service.etl;

/**
 * One kind of step a chain can run.
 *
 * <p>The registry is Spring's own: every implementation is a bean, {@code EtlChainService} injects
 * them as a list and indexes by {@link #type()}. Adding a step type is adding one class — no edit
 * to the runner, no migration, nothing to register by hand. Modelled on the Integration Platform's
 * node executors, which get this right.
 */
public interface ChainStepExecutor {

    /** Stored in {@code etl_chain_step.kind}; unique across implementations. */
    String type();

    /** Shown in the step picker. */
    String label();

    /**
     * @param config the step's own JSON config, already parsed
     * @throws Exception any failure; the runner records it against the step and applies on_fail
     */
    StepResult run(java.util.Map<String, Object> config, StepContext ctx) throws Exception;
}
