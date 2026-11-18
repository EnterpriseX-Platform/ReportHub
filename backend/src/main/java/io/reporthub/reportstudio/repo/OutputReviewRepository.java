package io.reporthub.reportstudio.repo;

import org.springframework.data.jpa.repository.JpaRepository;
import io.reporthub.reportstudio.domain.OutputReview;

import java.util.Collection;
import java.util.List;

public interface OutputReviewRepository extends JpaRepository<OutputReview, String> {
    List<OutputReview> findByObjectKeyIn(Collection<String> objectKeys);
}
