package io.reporthub.reportstudio.security;

import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;

class LoginLockoutTest {
    @Test
    void locksAfterFiveFailuresAndExpires() {
        AtomicLong now = new AtomicLong(1_000_000);
        LoginLockout l = new LoginLockout(now::get);
        for (int i = 0; i < 4; i++) l.failed("u|ip");
        assertThat(l.isLocked("u|ip")).isFalse();
        l.failed("u|ip");
        assertThat(l.isLocked("u|ip")).isTrue();
        assertThat(l.isLocked("u|other")).isFalse();
        now.addAndGet(16 * 60_000L);
        assertThat(l.isLocked("u|ip")).isFalse();
    }
}
