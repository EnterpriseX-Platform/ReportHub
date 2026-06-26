package io.reporthub.reportstudio.analytics;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import io.reporthub.reportstudio.domain.Fact;
import io.reporthub.reportstudio.repo.FactRepository;
import io.reporthub.reportstudio.web.BadRequestException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.function.Function;
import java.util.function.ToLongFunction;

/**
 * Server-side pivot over {@code fact}. Groups by one or more row dimensions
 * (with a subtotal row per group level) crossed against a single column dimension,
 * aggregating one measure (SUM). Produces grand total and per-column totals.
 *
 * Output contract:
 * {colKeys:[], rows:[{label,depth,vals:{},rowTotal,isGroup}], colTotals:{}, grand}
 */
@Service
@Transactional(readOnly = true)
public class PivotService {

    private final FactRepository repo;

    public PivotService(FactRepository repo) {
        this.repo = repo;
    }

    public PivotResponse pivot(PivotRequest req) {
        if (req == null || req.rows() == null || req.rows().isEmpty()) {
            throw new BadRequestException("at least one row dimension is required");
        }
        if (req.cols() == null || req.cols().isEmpty()) {
            throw new BadRequestException("exactly one column dimension is required");
        }
        List<String> rowDims = req.rows().stream().map(FactFields::normalizeDimension).toList();
        String colDim = FactFields.normalizeDimension(req.cols().get(0));
        String measure = FactFields.normalizeMeasure(req.measure());

        List<Function<Fact, String>> rowAccessors =
                rowDims.stream().map(FactFields::dimAccessor).toList();
        Function<Fact, String> colAccessor = FactFields.dimAccessor(colDim);
        ToLongFunction<Fact> measureAccessor = FactFields.measureAccessor(measure);

        List<Fact> facts = repo.findAll();

        // Optional dimension filters (year alias accepted): {region: "...", fiscalYear: "2026"}
        if (req.filters() != null) {
            for (var e : req.filters().entrySet()) {
                if (e.getValue() == null || e.getValue().isBlank()) continue;
                final Function<Fact, String> acc;
                try {
                    acc = FactFields.dimAccessor(FactFields.normalizeDimension(e.getKey()));
                } catch (Exception ignored) {
                    continue;                       // not a warehouse dimension — skip
                }
                facts = facts.stream().filter(f -> e.getValue().equals(acc.apply(f))).toList();
            }
        }

        // Ordered, distinct column keys.
        TreeSet<String> colKeySet = new TreeSet<>();
        for (Fact f : facts) colKeySet.add(colAccessor.apply(f));
        List<String> colKeys = new ArrayList<>(colKeySet);

        // Build the nested grouping tree from the row dimensions.
        Node root = new Node(null, -1);
        for (Fact f : facts) {
            Node cur = root;
            cur.add(colAccessor.apply(f), measureAccessor.applyAsLong(f));
            for (int level = 0; level < rowAccessors.size(); level++) {
                String key = rowAccessors.get(level).apply(f);
                cur = cur.child(key, level);
                cur.add(colAccessor.apply(f), measureAccessor.applyAsLong(f));
            }
        }

        // Flatten the tree depth-first into output rows. Internal nodes (depth <
        // last dimension) become group rows; the deepest nodes are leaf rows.
        List<PivotResponse.Row> outRows = new ArrayList<>();
        int leafDepth = rowDims.size() - 1;
        emit(root, colKeys, leafDepth, outRows);

        // Column totals and grand total from the root accumulator.
        Map<String, Long> colTotals = new LinkedHashMap<>();
        long grand = 0;
        for (String ck : colKeys) {
            long v = root.cells.getOrDefault(ck, 0L);
            colTotals.put(ck, v);
            grand += v;
        }

        return new PivotResponse(colKeys, outRows, colTotals, grand);
    }

    private void emit(Node node, List<String> colKeys, int leafDepth, List<PivotResponse.Row> out) {
        for (Node child : node.orderedChildren()) {
            boolean isGroup = child.depth < leafDepth;
            Map<String, Long> vals = new LinkedHashMap<>();
            long rowTotal = 0;
            for (String ck : colKeys) {
                long v = child.cells.getOrDefault(ck, 0L);
                vals.put(ck, v);
                rowTotal += v;
            }
            out.add(new PivotResponse.Row(child.label, child.depth, vals, rowTotal, isGroup));
            if (isGroup) {
                emit(child, colKeys, leafDepth, out);
            }
        }
    }

    /** Aggregation node: accumulates measure sums per column key, with ordered children. */
    private static final class Node {
        final String label;
        final int depth;
        final Map<String, Long> cells = new LinkedHashMap<>();
        final Map<String, Node> children = new LinkedHashMap<>();

        Node(String label, int depth) {
            this.label = label;
            this.depth = depth;
        }

        void add(String colKey, long value) {
            cells.merge(colKey, value, Long::sum);
        }

        Node child(String key, int level) {
            return children.computeIfAbsent(key, k -> new Node(k, level));
        }

        List<Node> orderedChildren() {
            // Stable label ordering keeps output deterministic across calls.
            List<Node> list = new ArrayList<>(children.values());
            list.sort((a, b) -> a.label.compareTo(b.label));
            return list;
        }
    }
}
