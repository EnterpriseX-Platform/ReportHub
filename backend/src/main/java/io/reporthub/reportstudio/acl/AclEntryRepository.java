package io.reporthub.reportstudio.acl;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface AclEntryRepository extends JpaRepository<AclEntry, Long> {
    List<AclEntry> findByObjectTypeAndObjectIdOrderById(String objectType, String objectId);
    List<AclEntry> findByObjectType(String objectType);
    void deleteByObjectTypeAndObjectId(String objectType, String objectId);
}
