package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import io.reporthub.reportstudio.domain.Fact;

import java.util.List;

public interface FactRepository extends JpaRepository<Fact, Long> {

    @Query("SELECT DISTINCT b.fiscalYear FROM Fact b ORDER BY b.fiscalYear")
    List<String> distinctFiscalYears();

    @Query("SELECT DISTINCT b.region FROM Fact b ORDER BY b.region")
    List<String> distinctRegions();

    @Query("SELECT DISTINCT b.category FROM Fact b ORDER BY b.category")
    List<String> distinctCategories();

    @Query("SELECT DISTINCT b.channel FROM Fact b ORDER BY b.channel")
    List<String> distinctChannels();
}
