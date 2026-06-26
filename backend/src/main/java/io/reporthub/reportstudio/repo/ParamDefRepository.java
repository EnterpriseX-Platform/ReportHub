package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.ParamDef;

import java.util.List;
import java.util.Optional;

public interface ParamDefRepository extends JpaRepository<ParamDef, Long> {
    Optional<ParamDef> findByName(String name);
    boolean existsByName(String name);
    List<ParamDef> findAllByOrderBySortOrderAsc();
    List<ParamDef> findByNameInOrderBySortOrderAsc(List<String> names);
}
