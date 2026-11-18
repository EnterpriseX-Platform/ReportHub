package io.reporthub.reportstudio.round2;

import io.reporthub.reportstudio.acl.AclService;
import io.reporthub.reportstudio.domain.RepoTable;
import io.reporthub.reportstudio.iam.CurrentPrincipal;
import io.reporthub.reportstudio.iam.RhPrincipal;
import io.reporthub.reportstudio.repo.RepoTableRepository;
import io.reporthub.reportstudio.web.BadRequestException;
import io.reporthub.reportstudio.web.RepositoryController;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

import java.lang.reflect.Method;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** Behaviour regression tests (permissions, validation). */
class E2eRound2BehaviourTest {

    static final RhPrincipal USER = new RhPrincipal("u", "u", "local", "default", false, Set.of(), Set.of(), Map.of(), null);

    // ---- 6. table reads check the datasource ACL
    @Test
    void tableReadsCheckDatasourceAcl() throws Exception {
        RepoTableRepository registry = mock(RepoTableRepository.class);
        RepoTable t = new RepoTable();
        t.setTableName("SALES");
        t.setDatasourceId("ds1");
        t.setActive(true);
        when(registry.findForPhysicalTable(any(), anyString())).thenReturn(List.of(t));
        RepositoryController c = new RepositoryController(null, registry, null, null, null, null);
        AclService acl = mock(AclService.class);
        java.lang.reflect.Field f = RepositoryController.class.getDeclaredField("acl");
        f.setAccessible(true);
        f.set(c, acl);
        Method m = RepositoryController.class.getDeclaredMethod("assertReadable", String.class, String.class, String.class);
        m.setAccessible(true);

        when(acl.allowed("DATASOURCE", "ds1", "view")).thenReturn(false);
        CurrentPrincipal.runAs(USER, () -> assertThatThrownBy(() -> E2eRound2SecurityTest.invoke2(c, m, "ds1", null, "SALES"))
                .isInstanceOf(ResponseStatusException.class).hasMessageContaining("datasource"));
        when(acl.allowed("DATASOURCE", "ds1", "view")).thenReturn(true);
        CurrentPrincipal.runAs(USER, () -> assertThatCode(() -> E2eRound2SecurityTest.invoke2(c, m, "ds1", null, "SALES")).doesNotThrowAnyException());
        CurrentPrincipal.runAs(USER, () -> assertThatThrownBy(() -> E2eRound2SecurityTest.invoke2(c, m, "ds1", "pg_catalog", "pg_authid"))
                .isInstanceOf(ResponseStatusException.class));
    }

    // ---- 9. scheduled pipeline runs use the declared defaults
    @Test
    void scheduledRunsGetDefaults() throws Exception {
        var p = new io.reporthub.reportstudio.domain.WarehousePipeline();
        p.setParamsJson("[{\"name\":\"STAGE\",\"default\":\"4.4\"}]");
        Method m = io.reporthub.reportstudio.service.WarehouseService.class.getDeclaredMethod("scheduledParams",
                io.reporthub.reportstudio.domain.WarehousePipeline.class);
        m.setAccessible(true);
        assertThat((Map<Object, Object>) m.invoke(null, p)).containsEntry("STAGE", "4.4");
    }

    // ---- 10. a check deleted while running does not come back
    @Test
    void deletedCheckIsNotResurrected() throws Exception {
        var repo = mock(io.reporthub.reportstudio.repo.DataCheckRepository.class);
        var runs = mock(io.reporthub.reportstudio.repo.DataCheckRunRepository.class);
        var svc = new io.reporthub.reportstudio.service.DataCheckService(repo, runs, null, null);
        var check = new io.reporthub.reportstudio.domain.DataCheck();
        check.setId(7L);
        check.setLastStatus("pass");
        check.setLastCount(0);
        var run = new io.reporthub.reportstudio.domain.DataCheckRun();
        Method m = svc.getClass().getDeclaredMethod("persistRunResult",
                io.reporthub.reportstudio.domain.DataCheck.class, io.reporthub.reportstudio.domain.DataCheckRun.class);
        m.setAccessible(true);

        when(repo.saveRunResult(any(), any(), any(), any())).thenReturn(0);
        m.invoke(svc, check, run);
        verify(repo, never()).save(any());
        verify(runs).delete(run);
        verify(runs, never()).save(any());

        var repo2 = mock(io.reporthub.reportstudio.repo.DataCheckRepository.class);
        var runs2 = mock(io.reporthub.reportstudio.repo.DataCheckRunRepository.class);
        var svc2 = new io.reporthub.reportstudio.service.DataCheckService(repo2, runs2, null, null);
        when(repo2.saveRunResult(any(), any(), any(), any())).thenReturn(1);
        m.invoke(svc2, check, run);
        verify(repo2, never()).save(any());
        verify(runs2).save(run);
        svc.getClass();   // pools are daemon-less executors; nothing submitted here
    }

    // ---- 12. request validation
    @Test
    void reportListAndJobFiltersValidated() throws Exception {
        assertThat(io.reporthub.reportstudio.service.ReportService.checkStatusFilter("Active")).isEqualTo("active");
        assertThatThrownBy(() -> io.reporthub.reportstudio.service.ReportService.checkStatusFilter("bogus"))
                .isInstanceOf(BadRequestException.class);
        Method sort = io.reporthub.reportstudio.web.ReportController.class.getDeclaredMethod("parseSort", String.class);
        sort.setAccessible(true);
        assertThatThrownBy(() -> invokeStatic(sort, "name,sideways")).isInstanceOf(BadRequestException.class);
        assertThatThrownBy(() -> invokeStatic(sort, "name,asc,x")).isInstanceOf(BadRequestException.class);
        assertThatCode(() -> invokeStatic(sort, "name,ASC")).doesNotThrowAnyException();

        var queue = new io.reporthub.reportstudio.service.QueueService(mock(io.reporthub.reportstudio.repo.JobRepository.class), null);
        assertThatThrownBy(() -> queue.list("bogus", null, 10)).isInstanceOf(BadRequestException.class);
    }

    @Test
    void reportFormatsAndOwnerValidated() throws Throwable {
        Class<?> rs = io.reporthub.reportstudio.service.ReportService.class;
        Method f = rs.getDeclaredMethod("validFormats", List.class);
        f.setAccessible(true);
        assertThat((List<Object>) invokeStatic(f, List.of("pdf", "XLSX", "pdf"))).containsExactly("PDF", "XLSX");
        assertThatThrownBy(() -> invokeStatic(f, List.of("PDF", "EXE"))).isInstanceOf(BadRequestException.class);
        Method o = rs.getDeclaredMethod("requireOwnerUnit", String.class);
        o.setAccessible(true);
        assertThatThrownBy(() -> invokeStatic(o, " ")).isInstanceOf(BadRequestException.class);
        assertThat(invokeStatic(o, " Finance ")).isEqualTo("Finance");
    }

    static Object invokeStatic(Method m, Object... args) throws Throwable {
        try { return m.invoke(null, args); } catch (java.lang.reflect.InvocationTargetException e) { throw e.getCause(); }
    }
}
