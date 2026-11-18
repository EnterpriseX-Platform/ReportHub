package io.reporthub.reportstudio.analytics;

import io.reporthub.reportstudio.domain.Fact;
import io.reporthub.reportstudio.web.BadRequestException;

import java.util.List;
import java.util.function.Function;
import java.util.function.ToLongFunction;

/**
 * Single source of truth for the fact dimensions and measures shared by
 * {@link PivotService} and {@link AdhocService}. Keeps field naming consistent and
 * validates client-supplied field keys up-front.
 */
final class FactFields {

    static final List<String> DIMENSIONS = List.of("region", "category", "channel", "fiscalYear");
    static final List<String> MEASURES = List.of("target", "sales", "profit");

    private FactFields() {}

    /** Normalises "year" -> "fiscalYear" and rejects unknown keys. */
    static String normalizeDimension(String key) {
        if (key == null) throw new BadRequestException("dimension is required");
        String k = key.trim();
        if (k.equalsIgnoreCase("year") || k.equalsIgnoreCase("fiscal_year")) k = "fiscalYear";
        for (String d : DIMENSIONS) {
            if (d.equalsIgnoreCase(k)) return d;
        }
        throw new BadRequestException("unknown dimension: " + key);
    }

    static String normalizeMeasure(String key) {
        if (key == null) throw new BadRequestException("measure is required");
        String k = key.trim();
        for (String m : MEASURES) {
            if (m.equalsIgnoreCase(k)) return m;
        }
        throw new BadRequestException("unknown measure: " + key);
    }

    static boolean isDimension(String key) {
        if (key == null) return false;
        String k = key.trim();
        if (k.equalsIgnoreCase("year") || k.equalsIgnoreCase("fiscal_year")) return true;
        return DIMENSIONS.stream().anyMatch(d -> d.equalsIgnoreCase(k));
    }

    static boolean isMeasure(String key) {
        if (key == null) return false;
        return MEASURES.stream().anyMatch(m -> m.equalsIgnoreCase(key.trim()));
    }

    /** Accessor for a normalised dimension key. */
    static Function<Fact, String> dimAccessor(String normalizedDim) {
        return switch (normalizedDim) {
            case "region" -> Fact::getRegion;
            case "category" -> Fact::getCategory;
            case "channel" -> Fact::getChannel;
            case "fiscalYear" -> Fact::getFiscalYear;
            default -> throw new BadRequestException("unknown dimension: " + normalizedDim);
        };
    }

    /** Accessor for a normalised measure key. */
    static ToLongFunction<Fact> measureAccessor(String normalizedMeasure) {
        return switch (normalizedMeasure) {
            case "target" -> Fact::getTarget;
            case "sales" -> Fact::getSales;
            case "profit" -> Fact::getProfit;
            default -> throw new BadRequestException("unknown measure: " + normalizedMeasure);
        };
    }
}
