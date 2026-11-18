package io.reporthub.reportstudio.engine;

import java.util.List;

/**
 * A code-declared description of a registered engine, surfaced on {@code GET /engines} so the
 * frontend can render the Engines page and the engine-driven config forms from one source of truth.
 *
 * @param kind             engine kind ({@code jasper}, {@code sql}, {@code api}, {@code component}, …)
 * @param label            human label
 * @param requiresInstance whether it needs an enabled EngineInstance (remote) to run
 * @param builtin          ready to use out of the box (no install) — i.e. {@code !requiresInstance}
 * @param instanceProps    install-time fields (rendered by the Engines-page install modal)
 * @param reportProps      per-report fields (rendered by the register wizard / unit config form)
 */
public record EngineDescriptor(
        String kind,
        String label,
        boolean requiresInstance,
        boolean builtin,
        List<EngineProp> instanceProps,
        List<EngineProp> reportProps
) {}
