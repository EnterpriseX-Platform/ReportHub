package io.reporthub.reportstudio.tenancy;

import jakarta.persistence.EntityManagerFactory;
import org.springframework.beans.factory.config.BeanPostProcessor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Primary;
import org.springframework.orm.jpa.AbstractEntityManagerFactoryBean;
import org.springframework.transaction.PlatformTransactionManager;

@Configuration
public class TenancyConfig {

    /** Replaces Boot's default JpaTransactionManager (it backs off when one is defined). */
    @Bean
    @Primary
    public PlatformTransactionManager transactionManager(EntityManagerFactory emf) {
        return new TenantAwareTransactionManager(emf);
    }

    /**
     * Also scope EntityManagers created outside a transaction: derived query methods called
     * straight from a controller run on a fresh non-transactional EntityManager, which the
     * transaction manager never sees.
     */
    @Bean
    public static BeanPostProcessor tenantScopeEntityManagerInitializer() {
        return new BeanPostProcessor() {
            @Override
            public Object postProcessBeforeInitialization(Object bean, String beanName) {
                if (bean instanceof AbstractEntityManagerFactoryBean emfb) {
                    emfb.setEntityManagerInitializer(TenantAwareTransactionManager::apply);
                }
                return bean;
            }
        };
    }
}
