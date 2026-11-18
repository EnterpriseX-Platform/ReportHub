package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import io.reporthub.reportstudio.domain.ReportUnitFile;

import java.util.List;
import java.util.Optional;

public interface ReportUnitFileRepository extends JpaRepository<ReportUnitFile, Long> {
    /** All files for a unit (all versions, active + inactive) ordered for display. */
    List<ReportUnitFile> findByUnitIdOrderByRoleAscUploadedAtDesc(Long unitId);
    /** Active-only files for a unit — used by the render worker. */
    List<ReportUnitFile> findByUnitIdAndActiveTrueOrderByRoleAscUploadedAtAsc(Long unitId);
    Optional<ReportUnitFile> findFirstByUnitIdAndRole(Long unitId, String role);
    void deleteByUnitIdAndRole(Long unitId, String role);
    /** Remove a same-named file of a role so a re-upload replaces it, while OTHER files of that role stay. */
    void deleteByUnitIdAndRoleAndFileName(Long unitId, String role, String fileName);
    List<ReportUnitFile> findByRoleAndFileName(String role, String fileName);
    /** Deactivate all current active files for a role (call before inserting a new active version). */
    @Modifying
    @Query("UPDATE ReportUnitFile f SET f.active = false WHERE f.unitId = :unitId AND f.role = :role")
    void deactivateByUnitIdAndRole(Long unitId, String role);
}
