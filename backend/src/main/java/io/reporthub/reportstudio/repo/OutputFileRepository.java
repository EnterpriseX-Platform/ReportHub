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

    /**
     * Outputs visible to a non-admin caller: every report-run output (these carry a
     * {@code jobId} and are shared across the signed-in team) plus the caller's own
     * analytics/saved-view exports ({@code jobId} is null, scoped to their creator).
     */
    @Query("select o from OutputFile o "
            + "where o.jobId is not null or o.createdBy = :createdBy "
            + "order by o.createdAt desc")
    List<OutputFile> findVisibleTo(@Param("createdBy") String createdBy);
}
