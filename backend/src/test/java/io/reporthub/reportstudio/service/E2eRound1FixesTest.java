package io.reporthub.reportstudio.service;

import io.reporthub.reportstudio.web.BadRequestException;
import org.junit.jupiter.api.Test;

import java.sql.Types;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class E2eRound1FixesTest {

    private static final RepositoryService.TableMeta META = new RepositoryService.TableMeta("s", "t", List.of(
            new RepositoryService.ColumnInfo("ID", "int4", Types.INTEGER, false, true),
            new RepositoryService.ColumnInfo("NAME", "varchar", Types.VARCHAR, true, false)), List.of("ID"));
    private static final RepositoryService.TableMeta NOKEY = new RepositoryService.TableMeta("s", "t", List.of(
            new RepositoryService.ColumnInfo("A", "int4", Types.INTEGER, false, false),
            new RepositoryService.ColumnInfo("B", "varchar", Types.VARCHAR, true, false)), List.of());

    @Test
    void stableOrderAndValidatedSort() {
        assertThat(RepositoryService.orderBy(META, null)).isEqualTo(" ORDER BY \"ID\"");
        assertThat(RepositoryService.orderBy(NOKEY, "")).isEqualTo(" ORDER BY \"A\"");
        assertThat(RepositoryService.orderBy(META, "name,desc")).isEqualTo(" ORDER BY \"NAME\" DESC, \"ID\"");
        assertThat(RepositoryService.orderBy(META, "-id")).isEqualTo(" ORDER BY \"ID\" DESC");
        assertThatThrownBy(() -> RepositoryService.orderBy(META, "bogus")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> RepositoryService.orderBy(META, "name,sideways")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void unicodeExportLabels() {
        assertThat(RepositoryService.safeLabel("Jahresübersicht 年度")).isEqualTo("Jahresübersicht 年度");
        assertThat(RepositoryService.safeLabel("a\"b")).isEqualTo("ab");
        assertThat(RepositoryService.safeLabel("  ")).isNull();
    }

    @Test
    void categoryIds() {
        assertThat(CatalogService.categoryId(null, "Finance Reports")).isEqualTo("finance-reports");
        assertThat(CatalogService.categoryId(null, "A very long category name here")).hasSizeLessThanOrEqualTo(16);
        assertThat(CatalogService.categoryId(null, "報告書")).startsWith("cat-");
        assertThatThrownBy(() -> CatalogService.categoryId("bad id!", "x")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void engineNamesNormalised() {
        assertThat(CatalogService.normalizeEngine("postgresql")).isEqualTo("POSTGRES");
        assertThat(CatalogService.normalizeEngine("PostgreSQL 15")).isEqualTo("POSTGRES");
        assertThat(CatalogService.normalizeEngine("Oracle 19c")).isEqualTo("ORACLE");
        assertThat(CatalogService.normalizeEngine("REST-SOAP")).isEqualTo("REST");
    }

    @Test
    void pipelineDefaultsFillMissingValues() {
        Map<String, String> m = WarehouseService.withDefaults(
                "[{\"name\":\"STAGE\",\"default\":\"4.4\"},{\"name\":\"X\",\"default\":\"1\"}]", Map.of("X", "2"));
        assertThat(m).containsEntry("STAGE", "4.4").containsEntry("X", "2");
        assertThat(WarehouseService.withDefaults(null, null)).isEmpty();
    }

    @Test
    void numericColumnsAreDimensionsOnlyWhenConfigured() {
        assertThat(DatasetService.kindOf("col_a", Types.INTEGER)).isEqualTo("measure");
        assertThat(DatasetService.kindOf("col_a", Types.INTEGER, java.util.Set.of("COL_A"))).isEqualTo("dim");
        assertThat(DatasetService.kindOf("amount", Types.NUMERIC)).isEqualTo("measure");
        assertThat(DatasetService.kindOf("name", Types.VARCHAR)).isEqualTo("dim");
    }

    @Test
    void reportStatusAndPriorityValidated() {
        assertThat(ReportService.validStatus("Active")).isEqualTo("active");
        assertThatThrownBy(() -> ReportService.validStatus("bogus")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> ReportService.validPriority("urgent")).isInstanceOf(BadRequestException.class);
    }

    @Test
    void sqlParamsNeedRegisteredDatasource() {
        assertThatThrownBy(() -> ParameterService.requireExternalDatasource(null)).isInstanceOf(BadRequestException.class);
        ParameterService.requireExternalDatasource("ext");
    }
}
