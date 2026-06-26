package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.DatasetDef;

import java.util.List;

public interface DatasetDefRepository extends JpaRepository<DatasetDef, Long> {
    List<DatasetDef> findAllByOrderByCreatedAtDesc();
}
