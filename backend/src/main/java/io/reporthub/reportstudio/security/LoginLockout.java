package io.reporthub.reportstudio.security;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Simple brute-force guard for local sign-in: after {@link #MAX_FAILURES} failures for the same
 * user + client IP within {@link #WINDOW_MINUTES} minutes, further attempts are refused until the
 * window has passed. In-memory per instance.
 */
@org.springframework.stereotype.Component
public class LoginLockout {

    public static final int MAX_FAILURES = 5;
    public static final int WINDOW_MINUTES = 15;
    private static final long WINDOW_MS = WINDOW_MINUTES * 60_000L;

    private final Map<String, Deque<Long>> failures = new ConcurrentHashMap<>();
    private final java.util.function.LongSupplier clock;

    @org.springframework.beans.factory.annotation.Autowired
    public LoginLockout() { this(System::currentTimeMillis); }

    LoginLockout(java.util.function.LongSupplier clock) { this.clock = clock; }

    public boolean isLocked(String key) {
        Deque<Long> d = failures.get(key);
        if (d == null) return false;
        synchronized (d) {
            prune(d);
            return d.size() >= MAX_FAILURES;
        }
    }

    public void failed(String key) {
        Deque<Long> d = failures.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (d) {
            prune(d);
            d.addLast(clock.getAsLong());
        }
        if (failures.size() > 10_000) failures.entrySet().removeIf(e -> { synchronized (e.getValue()) { prune(e.getValue()); return e.getValue().isEmpty(); } });
    }

    public void succeeded(String key) {
        failures.remove(key);
    }

    /** Lift every lockout of {@code username} (all client IPs) - used by an admin password reset. */
    public void clear(String username) {
        if (username == null) return;
        String prefix = username.toLowerCase(java.util.Locale.ROOT) + "|";
        failures.keySet().removeIf(k -> k.startsWith(prefix));
    }

    private void prune(Deque<Long> d) {
        long cutoff = clock.getAsLong() - WINDOW_MS;
        while (!d.isEmpty() && d.peekFirst() < cutoff) d.pollFirst();
    }
}
