package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.Session;
import org.hibernate.SessionFactory;
import org.hibernate.annotations.Filter;
import org.hibernate.cfg.Configuration;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The tenant/project scope against a real Hibernate session (H2): the filter limits queries,
 * new rows are stamped with the active scope, and a by-id load of another scope's row fails.
 */
class TenantScopeFilterTest {

    @Entity(name = "ScopedThing")
    @Table(name = "scoped_thing")
    @Filter(name = TenantScoped.FILTER)
    public static class Thing extends TenantScoped {
        @Id @GeneratedValue Long id;
        String name;
        public Thing() {}
        Thing(String name) { this.name = name; }
    }

    static SessionFactory sf;
    static final TenantContext.Scope A = new TenantContext.Scope("acme", "sales");
    static final TenantContext.Scope A2 = new TenantContext.Scope("acme", "finance");
    static final TenantContext.Scope B = new TenantContext.Scope("globex", "sales");

    @BeforeAll
    static void boot() {
        sf = new Configuration()
                .addAnnotatedClass(Tenant.class)
                .addAnnotatedClass(Thing.class)
                .setProperty("hibernate.connection.url", "jdbc:h2:mem:scope;DB_CLOSE_DELAY=-1")
                .setProperty("hibernate.connection.username", "sa")
                .setProperty("hibernate.hbm2ddl.auto", "create-drop")
                .buildSessionFactory();
        TenantContext.runAs(A, () -> save(new Thing("a1"), new Thing("a2")));
        TenantContext.runAs(A2, () -> save(new Thing("a-fin")));
        TenantContext.runAs(B, () -> save(new Thing("b1")));
        save(new Thing("legacy")); // no scope → default/default
    }

    @AfterAll
    static void close() { sf.close(); }

    @AfterEach
    void clear() { TenantContext.clear(); }

    private static void save(Thing... things) {
        try (Session s = sf.openSession()) {
            s.beginTransaction();
            for (Thing t : things) s.persist(t);
            s.getTransaction().commit();
        }
    }

    private static List<String> namesInScope() {
        try (Session s = sf.openSession()) {
            TenantAwareTransactionManager.apply(s);
            return s.createQuery("select t.name from ScopedThing t order by t.name", String.class).list();
        }
    }

    @Test
    void queriesOnlySeeTheActiveTenantAndProject() {
        assertThat(TenantContext.callAs(A, TenantScopeFilterTest::namesInScope)).containsExactly("a1", "a2");
        assertThat(TenantContext.callAs(A2, TenantScopeFilterTest::namesInScope)).containsExactly("a-fin");
        assertThat(TenantContext.callAs(B, TenantScopeFilterTest::namesInScope)).containsExactly("b1");
    }

    @Test
    void noScopeMeansSystemViewOfEverything() {
        assertThat(namesInScope()).containsExactlyInAnyOrder("a1", "a2", "a-fin", "b1", "legacy");
    }

    @Test
    void rowsWithoutScopeLandInTheDefaultTenant() {
        assertThat(TenantContext.callAs(TenantContext.of(null, null), TenantScopeFilterTest::namesInScope))
                .containsExactly("legacy");
    }

    @Test
    void newRowsAreStampedWithTheActiveScope() {
        Thing t = new Thing("stamped");
        TenantContext.runAs(B, () -> save(t));
        assertThat(t.getTenantId()).isEqualTo("globex");
        assertThat(t.getProjectId()).isEqualTo("sales");
    }

    @Test
    void loadingAnotherScopesRowByIdIsRejected() {
        Long bId;
        try (Session s = sf.openSession()) {
            bId = s.createQuery("select t.id from ScopedThing t where t.name = 'b1'", Long.class).getSingleResult();
        }
        assertThatThrownBy(() -> TenantContext.runAs(A, () -> {
            try (Session s = sf.openSession()) {
                TenantAwareTransactionManager.apply(s);
                s.find(Thing.class, bId);
            }
        })).isInstanceOf(OutOfScopeException.class);
    }

    @Test
    void contextIsRestoredAfterCallAs() {
        TenantContext.set(A);
        TenantContext.runAs(B, () -> assertThat(TenantContext.current()).contains(B));
        assertThat(TenantContext.current()).contains(A);
    }
}
