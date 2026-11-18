package io.reporthub.reportstudio.render;

import java.util.ArrayList;
import java.util.List;

/**
 * Generic in-memory tabular payload used as the common denominator for every
 * exporter. The renderer first resolves a {@code TabularData} (either from a SQL
 * result set or from the bundled sample dataset) and then hands it to the
 * format-specific writers (PDF / XLSX / CSV).
 *
 * <p>Never holds {@code null} cells: missing values are normalised to empty strings.</p>
 */
public final class TabularData {

    private final List<String> columns = new ArrayList<>();
    private final List<List<String>> rows = new ArrayList<>();

    public TabularData(List<String> columns) {
        if (columns != null) {
            for (String c : columns) {
                this.columns.add(c == null ? "" : c);
            }
        }
    }

    public void addRow(List<String> cells) {
        List<String> normalised = new ArrayList<>(columns.size());
        for (int i = 0; i < columns.size(); i++) {
            String v = (cells != null && i < cells.size()) ? cells.get(i) : null;
            normalised.add(v == null ? "" : v);
        }
        rows.add(normalised);
    }

    public List<String> columns() {
        return columns;
    }

    public List<List<String>> rows() {
        return rows;
    }

    public int columnCount() {
        return columns.size();
    }

    public boolean isEmpty() {
        return rows.isEmpty();
    }
}
