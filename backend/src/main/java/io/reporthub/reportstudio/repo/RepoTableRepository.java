package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.RepoTable;

import java.util.List;

public interface RepoTableRepository extends JpaRepository<RepoTable, Integer> {

    List<RepoTable> findByActiveTrueOrderBySortOrderAscIdAsc();

    /** Registry entries pointing at one physical table (row filters of all of them apply). */
    default List<RepoTable> findForPhysicalTable(String schema, String table) {
        // Two queries instead of "(:schema is null or ...)": an untyped null bind makes PostgreSQL fail
        // with "could not determine data type of parameter" (500 on non-admin reads without a schema).
        return schema == null || schema.isBlank() ? findForTableAnySchema(table) : findForTableInSchema(schema, table);
    }

    @org.springframework.data.jpa.repository.Query("select t from RepoTable t where upper(t.tableName) = upper(:table)")
    List<RepoTable> findForTableAnySchema(@org.springframework.data.repository.query.Param("table") String table);

    @org.springframework.data.jpa.repository.Query("select t from RepoTable t where upper(t.tableName) = upper(:table) "
            + "and (t.schemaName is null or upper(t.schemaName) = upper(:schema))")
    List<RepoTable> findForTableInSchema(@org.springframework.data.repository.query.Param("schema") String schema,
                                         @org.springframework.data.repository.query.Param("table") String table);

    List<RepoTable> findByMenuKeyAndActiveTrueOrderBySortOrderAscIdAsc(String menuKey);

    java.util.List<io.reporthub.reportstudio.domain.RepoTable> findByFolderId(Integer folderId);
}
