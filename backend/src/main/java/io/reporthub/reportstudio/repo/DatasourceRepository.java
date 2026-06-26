package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.Datasource;

import java.util.List;

public interface DatasourceRepository extends JpaRepository<Datasource, String> {
    List<Datasource> findAllByOrderByNameAsc();
}
