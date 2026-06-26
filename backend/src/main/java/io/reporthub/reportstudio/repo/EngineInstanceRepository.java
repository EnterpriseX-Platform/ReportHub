package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import io.reporthub.reportstudio.domain.EngineInstance;

import java.util.List;
import java.util.Optional;

public interface EngineInstanceRepository extends JpaRepository<EngineInstance, Long> {
    List<EngineInstance> findAllByOrderByIdAsc();
    Optional<EngineInstance> findFirstByKindAndEnabledTrue(String kind);

    /** Ids of rows whose auth_token is still legacy plaintext (not yet encrypted) — for one-time migration. */
    @Query(value = "SELECT id FROM engine_instance WHERE auth_token IS NOT NULL AND auth_token <> '' "
            + "AND auth_token NOT LIKE 'enc:v1:%'", nativeQuery = true)
    List<Long> findIdsWithPlaintextToken();

    /** Ids of rows that have any auth_token — for a startup decrypt health check. */
    @Query(value = "SELECT id FROM engine_instance WHERE auth_token IS NOT NULL AND auth_token <> ''", nativeQuery = true)
    List<Long> findIdsWithToken();

    /** Raw column value (native — bypasses the encrypting converter), for migration only. */
    @Query(value = "SELECT auth_token FROM engine_instance WHERE id = :id", nativeQuery = true)
    String rawAuthToken(@Param("id") Long id);

    /** Write a raw column value (native — bypasses the converter), for migration only. */
    @Modifying
    @Query(value = "UPDATE engine_instance SET auth_token = :value WHERE id = :id", nativeQuery = true)
    void updateRawAuthToken(@Param("id") Long id, @Param("value") String value);
}
