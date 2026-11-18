package io.reporthub.reportstudio.document;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.domain.DatasetDef;
import io.reporthub.reportstudio.repo.DatasetDefRepository;
import io.reporthub.reportstudio.service.DatasetService;
import io.reporthub.reportstudio.web.BadRequestException;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Resolves the data a document is bound to. A table block may carry
 * {@code "source": {"datasetId": 12, "params": {"region": "{{region}}"}}}: the dataset's SQL runs
 * against its ReportHub datasource, with every {@code $P{name}} placeholder bound as a JDBC
 * parameter (never spliced into the SQL). Binding values may reference document parameters as
 * {@code {{name}}}, which take the run value, else the parameter's default.
 *
 * <p>Bound tables go through the same access path as dataset queries: the caller needs
 * {@code run} on the dataset (level 2) and the dataset's row filters for the caller (level 3)
 * wrap the query. "The caller" is the signed-in user, or, on the exporter's print page, the user
 * the print token was minted for.
 */
@Service
public class DocumentDataService {

    public static final int MAX_ROWS = 5000;
    private static final Pattern P_SQL = Pattern.compile("\\$P!?\\{([A-Za-z0-9_.]+)\\}");
    private static final Pattern P_TPL = Pattern.compile("\\{\\{\\s*([A-Za-z0-9_.]+)\\s*\\}\\}");

    public record BlockData(List<String> columns, List<List<Object>> rows, String error) {}

    private final ObjectMapper json;
    private final DatasetDefRepository datasets;
    private final DatasetService datasetService;

    /** Level-2/3 enforcement; optional so the service can be built without them in unit tests. */
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.acl.AclService acl;
    @org.springframework.beans.factory.annotation.Autowired(required = false)
    private io.reporthub.reportstudio.rowfilter.RowFilterService rowFilters;

    public DocumentDataService(ObjectMapper json, DatasetDefRepository datasets, DatasetService datasetService) {
        this.json = json;
        this.datasets = datasets;
        this.datasetService = datasetService;
    }

    /** Effective parameter values: declared defaults overlaid by the supplied run values. */
    public Map<String, String> effectiveParams(JsonNode content, Map<String, ?> supplied) {
        Map<String, String> out = new LinkedHashMap<>();
        for (JsonNode p : content.path("params")) {
            String name = p.path("name").asText("");
            if (!name.isBlank()) out.put(name, p.path("defaultValue").asText(""));
        }
        if (supplied != null) supplied.forEach((k, v) -> out.put(k, v == null ? "" : String.valueOf(v)));
        return out;
    }

    /** Runs every bound table block; one failing source is reported on that block, not the whole document. */
    public Map<String, BlockData> resolve(String contentJson, Map<String, ?> supplied) {
        return resolve(contentJson, supplied, true);
    }

    /** Message shown in a rendered document when a bound table's data cannot be loaded. */
    public static final String GENERIC_DATA_ERROR = "Data could not be loaded";

    /**
     * @param detailedErrors true for the editor API (the author needs the cause); false for the
     *                       print page / PDF, which shows only {@link #GENERIC_DATA_ERROR} - details go to the log
     */
    public Map<String, BlockData> resolve(String contentJson, Map<String, ?> supplied, boolean detailedErrors) {
        JsonNode content;
        try {
            content = json.readTree(contentJson);
        } catch (Exception e) {
            throw new BadRequestException("Document content is not valid JSON");
        }
        Map<String, String> params = effectiveParams(content, supplied);
        Map<String, BlockData> out = new LinkedHashMap<>();
        List<JsonNode> blocks = new ArrayList<>();
        for (JsonNode s : content.path("sections")) collect(s.path("blocks"), blocks);
        for (JsonNode b : blocks) {
            JsonNode src = b.path("source");
            if (!src.has("datasetId") || src.path("datasetId").isNull()) continue;
            String id = b.path("id").asText();
            try {
                out.put(id, run(src, params));
            } catch (Exception e) {
                org.slf4j.LoggerFactory.getLogger(DocumentDataService.class)
                        .warn("Document block {} data failed: {}", id, e.toString());
                out.put(id, new BlockData(List.of(), List.of(),
                        detailedErrors ? e.getMessage() : GENERIC_DATA_ERROR));
            }
        }
        return out;
    }

    private static void collect(JsonNode blocks, List<JsonNode> into) {
        for (JsonNode b : blocks) {
            into.add(b);
            if (b.has("columns") && b.path("columns").isArray()) {
                for (JsonNode col : b.path("columns")) collect(col.path("blocks"), into);
            }
        }
    }

    private BlockData run(JsonNode src, Map<String, String> docParams) {
        long datasetId = src.path("datasetId").asLong();
        DatasetDef d = datasets.findById(datasetId)
                .orElseThrow(() -> new BadRequestException("Dataset " + datasetId + " not found"));
        if (acl != null && !acl.allowed(io.reporthub.reportstudio.rowfilter.RowFilterService.DATASET, String.valueOf(datasetId), "run")) {
            throw new BadRequestException("No run access to dataset " + datasetId);
        }
        Map<String, String> bind = new HashMap<>(docParams);
        src.path("params").fields().forEachRemaining(e -> bind.put(e.getKey(), fill(e.getValue().asText(""), docParams)));
        List<Object> binds = new ArrayList<>();
        Matcher m = P_SQL.matcher(d.getSqlText());
        StringBuilder sql = new StringBuilder();
        while (m.find()) {
            m.appendReplacement(sql, "?");
            binds.add(bind.getOrDefault(m.group(1), ""));
        }
        m.appendTail(sql);
        String q = sql.toString();
        if (rowFilters != null) {
            // filter binds sit in the outer WHERE, i.e. after the dataset's own placeholders
            List<Object> rf = new ArrayList<>();
            q = rowFilters.wrapJdbc(io.reporthub.reportstudio.rowfilter.RowFilterService.DATASET,
                    String.valueOf(datasetId), q, rf).sql();
            binds.addAll(rf);
        }
        DatasetService.TableResult r = datasetService.lookup(d.getDatasourceId(), q, binds, MAX_ROWS);
        return new BlockData(r.columns(), r.rows(), null);
    }

    /** Replace {{name}} with the parameter value (unknown names become empty). */
    public static String fill(String tpl, Map<String, String> params) {
        if (tpl == null) return "";
        Matcher m = P_TPL.matcher(tpl);
        StringBuilder sb = new StringBuilder();
        while (m.find()) m.appendReplacement(sb, Matcher.quoteReplacement(params.getOrDefault(m.group(1), "")));
        m.appendTail(sb);
        return sb.toString();
    }
}
