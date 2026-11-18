package io.reporthub.reportstudio.rowfilter;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;

public interface RowFilterRuleRepository extends JpaRepository<RowFilterRule, Long> {
    List<RowFilterRule> findByObjectTypeAndObjectIdOrderById(String objectType, String objectId);
    List<RowFilterRule> findByObjectTypeAndObjectIdInAndEnabledTrueOrderById(String objectType, Collection<String> objectIds);
    void deleteByObjectTypeAndObjectId(String objectType, String objectId);
}
