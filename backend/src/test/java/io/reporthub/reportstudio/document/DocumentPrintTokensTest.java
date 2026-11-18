package io.reporthub.reportstudio.document;

import com.fasterxml.jackson.databind.ObjectMapper;
import io.reporthub.reportstudio.iam.RhPrincipal;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.*;

class DocumentPrintTokensTest {

    private final DocumentPrintTokens tokens = new DocumentPrintTokens(new ObjectMapper(), "secret-1", 600);
    private final RhPrincipal ann = new RhPrincipal("ann", "Ann", "local", "t1", false,
            Set.of("ANALYST"), Set.of(), Map.of("departmentCode", "D1"), null);

    private long future() { return Instant.now().getEpochSecond() + 60; }

    @Test
    void roundTripCarriesScopeAndPrincipal() {
        String t = tokens.mint(new DocumentPrintTokens.Claims(7, "t1", "pA", ann, future()));
        DocumentPrintTokens.Claims c = tokens.verify(t, 7);
        assertEquals("t1", c.scope().tenantId());
        assertEquals("pA", c.scope().projectId());
        assertEquals("ann", c.u().username());
        assertEquals("D1", c.u().attribute("departmentCode"));
    }

    @Test
    void rejectsOtherDocumentTamperingWrongKeyAndExpiry() {
        String t = tokens.mint(new DocumentPrintTokens.Claims(7, "t1", "pA", ann, future()));
        assertThrows(SecurityException.class, () -> tokens.verify(t, 8));
        String forged = tokens.mint(new DocumentPrintTokens.Claims(7, "t2", "pA", null, future()));
        String spliced = forged.substring(0, forged.indexOf('.')) + t.substring(t.indexOf('.'));
        assertThrows(SecurityException.class, () -> tokens.verify(spliced, 7));
        DocumentPrintTokens other = new DocumentPrintTokens(new ObjectMapper(), "secret-2", 600);
        assertThrows(SecurityException.class, () -> other.verify(t, 7));
        String old = tokens.mint(new DocumentPrintTokens.Claims(7, "t1", "pA", ann, Instant.now().getEpochSecond() - 1));
        assertThrows(SecurityException.class, () -> tokens.verify(old, 7));
        assertThrows(SecurityException.class, () -> tokens.verify(null, 7));
        assertThrows(SecurityException.class, () -> tokens.verify("garbage", 7));
    }
}
