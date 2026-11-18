package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.RepoFolder;

import java.util.List;

public interface RepoFolderRepository extends JpaRepository<RepoFolder, Integer> {

    List<RepoFolder> findAllByOrderBySortOrderAscIdAsc();

    List<RepoFolder> findByMenuKeyOrderBySortOrderAscIdAsc(String menuKey);

    List<RepoFolder> findByParentId(Integer parentId);
}
