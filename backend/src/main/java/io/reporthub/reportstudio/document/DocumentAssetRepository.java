package io.reporthub.reportstudio.document;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface DocumentAssetRepository extends JpaRepository<DocumentAsset, Long> {
    List<DocumentAsset> findByDocumentIdOrderByCreatedAtDesc(Long documentId);
    java.util.Optional<DocumentAsset> findFirstByObjectKeyStartingWith(String prefix);
}
