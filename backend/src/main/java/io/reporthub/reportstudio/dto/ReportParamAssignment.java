package io.reporthub.reportstudio.dto;

/**
 * One row of the per-report parameter assignment (PUT /reports/{code}/parameters).
 * {@code requiredOverride}: null = inherit/not enforced, true = required for this report, false = optional.
 */
public record ReportParamAssignment(String name, Boolean requiredOverride) {}
