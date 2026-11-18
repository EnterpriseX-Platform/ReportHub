package io.reporthub.reportstudio.tenancy;

import org.hibernate.Session;
import org.springframework.orm.jpa.EntityManagerHolder;
import org.springframework.orm.jpa.JpaTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import jakarta.persistence.EntityManager;
import jakarta.persistence.EntityManagerFactory;

/**
 * JPA transaction manager that switches the {@code tenantScope} Hibernate filter on for every
 * new transaction while a {@link TenantContext} is active. Spring Data repository methods are
 * transactional, so every derived query, JPQL query and Specification is filtered without the
 * services having to remember it.
 */
public class TenantAwareTransactionManager extends JpaTransactionManager {

    public TenantAwareTransactionManager(EntityManagerFactory emf) {
        super(emf);
    }

    @Override
    protected void doBegin(Object transaction, TransactionDefinition definition) {
        super.doBegin(transaction, definition);
        EntityManagerHolder holder = (EntityManagerHolder)
                TransactionSynchronizationManager.getResource(obtainEntityManagerFactory());
        if (holder != null) apply(holder.getEntityManager());
    }

    /** Enable or disable the filter on {@code em} according to the current context. */
    public static void apply(EntityManager em) {
        Session session = em.unwrap(Session.class);
        TenantContext.current().ifPresentOrElse(
                s -> session.enableFilter(TenantScoped.FILTER)
                        .setParameter("tenantId", s.tenantId())
                        .setParameter("projectId", s.projectId()),
                () -> session.disableFilter(TenantScoped.FILTER));
    }
}
