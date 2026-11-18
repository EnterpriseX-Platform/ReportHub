package io.reporthub.reportstudio.chart;

import net.sf.jasperreports.engine.JRChart;
import net.sf.jasperreports.engine.JRChartCustomizer;
import org.jfree.chart.JFreeChart;
import org.jfree.chart.plot.PiePlot;

import java.awt.Rectangle;

/**
 * Pie chart: square legend markers and item labels without a surrounding box.
 *
 * <p>Both are JFreeChart plot-level settings that JasperReports does not expose in jrxml
 * ({@code <itemLabel backgroundColor=...>} cannot remove the box). The only way is a customizer,
 * which must be on the renderer's own classpath. Placing it in a plugin jar does not work - plugins
 * are loaded by a different classloader, so Jasper fails with ClassNotFoundException resolving it.
 *
 * <p>Usage - reference it from a template by fully qualified class name:
 * <pre>{@code <chart customizerClass="io.reporthub.reportstudio.chart.PieSquareLegendNoLabelBox">}</pre>
 *
 * <p>Does nothing for non-pie charts - a template referencing it on the wrong chart type gets the
 * original chart, not an error.
 */
public class PieSquareLegendNoLabelBox implements JRChartCustomizer {

    /** Legend marker size - 8x8 points, close to the default circle JFreeChart draws */
    private static final Rectangle LEGEND_SQUARE = new Rectangle(-4, -4, 8, 8);

    @Override
    public void customize(JFreeChart chart, JRChart jrChart) {
        if (chart == null || !(chart.getPlot() instanceof PiePlot)) return;
        PiePlot plot = (PiePlot) chart.getPlot();

        // 1. Square legend markers
        plot.setLegendItemShape(LEGEND_SQUARE);

        // 2. Item labels with no outline, shadow or background
        //    All three must be cleared; clearing only the outline leaves a faint box from shadow + background
        plot.setLabelOutlinePaint(null);
        plot.setLabelShadowPaint(null);
        plot.setLabelBackgroundPaint(null);
    }
}
