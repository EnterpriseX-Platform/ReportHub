package io.reporthub.reportstudio.engine.builtin;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import io.reporthub.reportstudio.engine.EngineRegistry;
import io.reporthub.reportstudio.engine.EngineResolver;
import io.reporthub.reportstudio.engine.PluginEngineLoader;
import io.reporthub.reportstudio.engine.ReportEngine;
import io.reporthub.reportstudio.render.JobCancelRegistry;
import io.reporthub.reportstudio.repo.DatasourceRepository;
import io.reporthub.reportstudio.repo.EngineInstanceRepository;
import io.reporthub.reportstudio.repo.JobRepository;
import io.reporthub.reportstudio.repo.ReportRepository;
import io.reporthub.reportstudio.repo.ReportUnitFileRepository;
import io.reporthub.reportstudio.repo.ReportUnitRepository;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * BookEngine is a {@code ReportEngine} bean that {@link EngineRegistry} needs while being constructed,
 * yet it must call the registry/resolver back to render child reports - a dependency cycle,
 * solved by injecting {@code ObjectProvider}. This test proves the context still boots;
 * if someone switches to direct injection it fails here instead of at application startup.
 */
class BookEngineWiringTest {

    @Configuration
    static class Ctx {
        @Bean PluginEngineLoader pluginEngineLoader() {
            PluginEngineLoader l = mock(PluginEngineLoader.class);
            when(l.isEnabled()).thenReturn(false);
            return l;
        }
        @Bean ObjectMapper objectMapper() { return new ObjectMapper(); }
        @Bean EngineInstanceRepository engineInstances() { return mock(EngineInstanceRepository.class); }
        @Bean DatasourceRepository datasources() { return mock(DatasourceRepository.class); }
        @Bean ReportRepository reports() { return mock(ReportRepository.class); }
        @Bean ReportUnitRepository units() { return mock(ReportUnitRepository.class); }
        @Bean ReportUnitFileRepository unitFiles() { return mock(ReportUnitFileRepository.class); }
        @Bean JobRepository jobs() { return mock(JobRepository.class); }
        @Bean JobCancelRegistry cancelRegistry() { return new JobCancelRegistry(); }

        @Bean EngineRegistry engineRegistry(List<ReportEngine> engines, PluginEngineLoader loader) {
            return new EngineRegistry(engines, loader);
        }
        @Bean EngineResolver engineResolver(EngineRegistry r, EngineInstanceRepository i,
                                            ObjectMapper m, DatasourceRepository d) {
            return new EngineResolver(r, i, m, d);
        }
        @Bean BookProgress bookProgress(JobRepository jobs) { return new BookProgress(jobs); }
        @Bean BookEngine bookEngine(org.springframework.beans.factory.ObjectProvider<EngineRegistry> reg,
                                    org.springframework.beans.factory.ObjectProvider<EngineResolver> res,
                                    ReportRepository reports, ReportUnitRepository units,
                                    ReportUnitFileRepository files, DatasourceRepository ds,
                                    BookProgress progress, JobCancelRegistry cancel, ObjectMapper mapper) {
            return new BookEngine(reg, res, reports, units, files, ds, progress, cancel, mapper);
        }
    }

    @Test
    void contextBootsAndRegistryKnowsBookKind() {
        try (var ctx = new AnnotationConfigApplicationContext(Ctx.class)) {
            EngineRegistry registry = ctx.getBean(EngineRegistry.class);

            assertThat(registry.has(BookEngine.KIND)).isTrue();
            assertThat(registry.isBuiltin(BookEngine.KIND)).isTrue();
            assertThat(registry.engineForKind(BookEngine.KIND)).get()
                    .isInstanceOf(BookEngine.class);
            // built-in engines need no installed EngineInstance - otherwise the resolver throws "not installed/enabled"
            assertThat(ctx.getBean(BookEngine.class).requiresInstance()).isFalse();
        }
    }
}
