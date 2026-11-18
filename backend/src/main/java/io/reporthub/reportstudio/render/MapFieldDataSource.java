package io.reporthub.reportstudio.render;

import net.sf.jasperreports.engine.JRDataSource;
import net.sf.jasperreports.engine.JRException;
import net.sf.jasperreports.engine.JRField;

import java.util.Iterator;
import java.util.List;
import java.util.Map;

/**
 * Minimal {@link JRDataSource} backed by a list of {@code Map<String,?>} rows, keyed by field name
 * ({@code c0..cN}). Used by the programmatic generic-SQL PDF path where rows have dynamic column
 * counts and therefore cannot be expressed as JavaBeans for {@code JRBeanCollectionDataSource}.
 */
final class MapFieldDataSource implements JRDataSource {

    private final Iterator<? extends Map<String, ?>> it;
    private Map<String, ?> current;

    MapFieldDataSource(List<? extends Map<String, ?>> rows) {
        this.it = rows.iterator();
    }

    @Override
    public boolean next() throws JRException {
        if (it.hasNext()) {
            current = it.next();
            return true;
        }
        return false;
    }

    @Override
    public Object getFieldValue(JRField field) throws JRException {
        if (current == null || field == null) {
            return null;
        }
        return current.get(field.getName());
    }
}
