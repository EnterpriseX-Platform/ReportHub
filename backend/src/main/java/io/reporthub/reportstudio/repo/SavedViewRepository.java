package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.SavedView;

import java.util.List;

public interface SavedViewRepository extends JpaRepository<SavedView, Long> {
    List<SavedView> findByKindOrderByCreatedAtDesc(String kind);
    java.util.Optional<SavedView> findByShareToken(String shareToken);
}
