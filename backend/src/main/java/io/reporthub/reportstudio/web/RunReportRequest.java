package io.reporthub.reportstudio.web;

import java.util.Map;

/**
 * Body for {@code POST /reports/{code}/run}.
 *
 * @param format   requested output format (PDF / XLSX / CSV); defaults to the report's first
 *                 declared format when omitted
 * @param params   optional report parameters passed straight through to the renderer
 * @param priority queue priority hint (high / normal / low); defaults to {@code normal}
 */
public record RunReportRequest(
        String format,
        Map<String, Object> params,
        String priority
) {
}
