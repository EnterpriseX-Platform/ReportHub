package io.reporthub.reportstudio.util;

import java.nio.charset.StandardCharsets;
import java.math.BigInteger;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicLong;

/**
 * cuid2 — opaque id generator following the paralleldrive/cuid2 reference spec.
 *
 * <p>Pure JDK, no external dependency — the algorithm is short and adding a library
 * just for it is not worth the extra build risk.
 *
 * <p>Formula: {@code one random letter + base36(sha3-512(time + salt + counter + fingerprint)) truncated to length-1}
 * <ul>
 *   <li><b>Time</b> keeps ids unique across time, but is hidden by the hash so order cannot be guessed</li>
 *   <li><b>Fingerprint</b> is bound to the pod, so several pods generating at once do not collide</li>
 *   <li><b>Counter</b> prevents collisions within one pod in the same millisecond</li>
 *   <li>The first hash character is dropped per the spec, because its distribution is biased</li>
 * </ul>
 */
public final class Cuid2 {

    /** Standard cuid2 length — long enough for a negligible collision chance, and fits job.id varchar(32). */
    public static final int DEFAULT_LENGTH = 24;

    private static final SecureRandom RANDOM = new SecureRandom();
    private static final AtomicLong COUNTER = new AtomicLong(RANDOM.nextInt(2057));
    private static final String FINGERPRINT = fingerprint();

    private Cuid2() {
    }

    public static String createId() {
        return createId(DEFAULT_LENGTH);
    }

    public static String createId(int length) {
        // The first character must be a letter, not a digit, so the id is usable as an identifier/file name anywhere
        char first = (char) ('a' + RANDOM.nextInt(26));
        String time = Long.toString(System.currentTimeMillis(), 36);
        String count = Long.toString(COUNTER.incrementAndGet(), 36);
        String salt = entropy(length);
        String hashed = hash(time + salt + count + FINGERPRINT);
        // Drop the first hash character per the spec, then append up to the full length
        return first + hashed.substring(1, length);
    }

    private static String entropy(int length) {
        StringBuilder sb = new StringBuilder();
        while (sb.length() < length) {
            sb.append(Long.toString(RANDOM.nextInt(36), 36));
        }
        return sb.substring(0, length);
    }

    private static String hash(String input) {
        MessageDigest md;
        try {
            md = MessageDigest.getInstance("SHA3-512");
        } catch (NoSuchAlgorithmException e) {
            // SHA3-512 exists since JDK 9 — if it is missing the runtime is broken; do not continue silently
            throw new IllegalStateException("SHA3-512 not available", e);
        }
        byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
        // signum 1 = positive, so BigInteger does not treat the top bit as a sign and emit a leading minus in base36
        return new BigInteger(1, digest).toString(36);
    }

    /** Fingerprint of this process — pod name + pid + random value, so each pod generates a distinct stream. */
    private static String fingerprint() {
        String host = System.getenv("HOSTNAME");
        long pid = ProcessHandle.current().pid();
        return hash((host == null ? "" : host) + pid + RANDOM.nextLong());
    }
}
