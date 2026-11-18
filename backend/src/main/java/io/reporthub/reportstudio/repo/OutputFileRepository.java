package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import io.reporthub.reportstudio.domain.OutputFile;

import java.util.List;
import java.util.Optional;

public interface OutputFileRepository extends JpaRepository<OutputFile, Long> {

    List<OutputFile> findAllByOrderByCreatedAtDesc();

    List<OutputFile> findByReportCode(String reportCode);

    Optional<OutputFile> findByObjectKey(String objectKey);

    /** Used when someone opens a share link — token has a unique index, so no scan is needed. */
    Optional<OutputFile> findByShareToken(String shareToken);

    /** Outputs produced by a run, newest first — backs the download-by-jobId convenience endpoint. */
    List<OutputFile> findByJobIdOrderByCreatedAtDesc(String jobId);

    /**
     * Outputs visible to a non-admin caller: only files they produced (report runs they requested
     * and their own exports). Report outputs can carry row-filtered data, so they never cross users;
     * other people reach a file through its share link.
     */
    @Query("select o from OutputFile o "
            + "where o.createdBy = :createdBy "
            + "order by o.createdAt desc")
    List<OutputFile> findVisibleTo(@Param("createdBy") String createdBy);

    /**
     * Per-report-code totals — file count, total size and latest file time.
     *
     * <p>The Output Files screen uses this to draw its folder sidebar instead of fetching every file row
     * and counting client-side; this returns at most one row per report that has outputs.
     *
     * <p>{@code createdBy} null = caller is an admin and sees every file.
     */
    @Query("select o.reportCode, count(o), coalesce(sum(o.sizeBytes), 0), max(o.createdAt) "
            + "from OutputFile o "
            + "where (:createdBy is null or o.createdBy = :createdBy) "
            + "group by o.reportCode")
    List<Object[]> summarise(@Param("createdBy") String createdBy);

    /**
     * One page of the file list, newest first — filtered by report code (one or a whole category) and search text.
     *
     * <p>{@code codes} null = no report restriction · {@code needle} null = no search.
     * The search matches both the object key and the report code (report display names are not in this
     * table; the screen maps them).
     */
    @Query("select o from OutputFile o "
            + "where (:createdBy is null or o.createdBy = :createdBy) "
            + "and (:#{#codes == null} = true or o.reportCode in :codes) "
            + "and (:needle is null or lower(o.objectKey) like :needle or lower(o.reportCode) like :needle) "
            + "order by o.createdAt desc")
    List<OutputFile> page(@Param("createdBy") String createdBy,
                          @Param("codes") List<String> codes,
                          @Param("needle") String needle,
                          org.springframework.data.domain.Pageable pageable);

    @Query("select count(o) from OutputFile o "
            + "where (:createdBy is null or o.createdBy = :createdBy) "
            + "and (:#{#codes == null} = true or o.reportCode in :codes) "
            + "and (:needle is null or lower(o.objectKey) like :needle or lower(o.reportCode) like :needle)")
    long countPage(@Param("createdBy") String createdBy,
                   @Param("codes") List<String> codes,
                   @Param("needle") String needle);
}
