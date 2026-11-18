package io.reporthub.reportstudio.dto;

/**
 * A report as a picker entry: just the code and its Thai name. Kept separate from
 * {@link ReportSummaryDto} because this is a published contract for other apps
 * ({@code [{"code":"...","name":"..."}]}) — adding registry fields here would change it.
 */
public record ReportCodeNameDto(String code, String name) {}
