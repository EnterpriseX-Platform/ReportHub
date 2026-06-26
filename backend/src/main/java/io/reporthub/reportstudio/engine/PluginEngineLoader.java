package io.reporthub.reportstudio.engine;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import io.reporthub.reportstudio.storage.ObjectStorageService;
import io.reporthub.reportstudio.storage.StoredObjectMeta;

import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.ServiceLoader;

/**
 * Loads third-party {@link ReportEngine} implementations dropped in as JARs (discovered via
 * {@link ServiceLoader}). The JARs live in object storage under {@code plugins/} so they survive
 * restarts and are shared by every replica; on load they are materialised to a local temp dir and
 * opened with a {@link URLClassLoader} whose parent is the app classloader (so the plugin's
 * {@code ReportEngine}/SDK types resolve to ours).
 *
 * <p>Security: a plugin JAR is arbitrary code that runs in-process — uploading one is an ADMIN-only
 * action (see SecurityConfig {@code POST /engines/**}) and can be disabled with {@code app.plugins.enabled=false}.
 */
@Service
public class PluginEngineLoader {

    private static final Logger log = LoggerFactory.getLogger(PluginEngineLoader.class);
    public static final String PREFIX = "plugins/";

    private final ObjectStorageService storage;
    private final boolean enabled;
    private final Path workDir;
    /** The classloader backing the currently-loaded plugin engines; closed when a newer one replaces it. */
    private volatile URLClassLoader active;

    public PluginEngineLoader(ObjectStorageService storage,
                              @Value("${app.plugins.enabled:true}") boolean enabled) {
        this.storage = storage;
        this.enabled = enabled;
        this.workDir = Path.of(System.getProperty("java.io.tmpdir", "/tmp"), "rs-plugins");
    }

    public boolean isEnabled() {
        return enabled;
    }

    /** Materialise plugin JARs from object storage and instantiate every ReportEngine they expose. */
    public List<ReportEngine> load() {
        if (!enabled) return List.of();
        List<URL> urls = new ArrayList<>();
        try {
            Files.createDirectories(workDir);
            for (StoredObjectMeta m : storage.list(PREFIX)) {
                String name = stripPrefix(m.objectKey());
                if (name.isBlank() || !name.toLowerCase().endsWith(".jar")) continue;
                Path local = workDir.resolve(sanitize(name));
                Files.write(local, storage.get(m.objectKey()));
                urls.add(local.toUri().toURL());
            }
        } catch (Exception e) {
            log.error("Failed to stage plugin JARs: {}", e.toString());
            return List.of();
        }
        if (urls.isEmpty()) {
            swap(null); // no plugins left — release any classloader from a previous load
            return List.of();
        }

        List<ReportEngine> out = new ArrayList<>();
        URLClassLoader cl = new URLClassLoader(urls.toArray(new URL[0]), getClass().getClassLoader());
        Iterator<ReportEngine> it = ServiceLoader.load(ReportEngine.class, cl).iterator();
        while (it.hasNext()) {
            try {
                out.add(it.next());
            } catch (Throwable t) {
                log.error("A plugin ReportEngine failed to instantiate (skipped): {}", t.toString());
            }
        }
        // Publish the new classloader and close the previous one (its engines are no longer registered).
        swap(cl);
        return out;
    }

    /** Install {@code next} as the active classloader and close the one it replaces (releases JAR handles). */
    private synchronized void swap(URLClassLoader next) {
        URLClassLoader prev = this.active;
        this.active = next;
        if (prev != null && prev != next) {
            try {
                prev.close();
            } catch (Exception e) {
                log.warn("Failed to close previous plugin classloader: {}", e.toString());
            }
        }
    }

    /** Persist an uploaded JAR to object storage (survives restarts, shared across replicas). */
    public String store(String fileName, byte[] jar) {
        String name = sanitize(fileName);
        if (!name.toLowerCase().endsWith(".jar")) {
            throw new IllegalArgumentException("Only .jar files are accepted");
        }
        if (jar == null || jar.length == 0) {
            throw new IllegalArgumentException("File is empty");
        }
        storage.put(PREFIX + name, jar, "application/java-archive");
        return name;
    }

    /** Names of installed plugin JARs. */
    public List<String> listJars() {
        List<String> out = new ArrayList<>();
        for (StoredObjectMeta m : storage.list(PREFIX)) {
            String name = stripPrefix(m.objectKey());
            if (!name.isBlank() && name.toLowerCase().endsWith(".jar")) out.add(name);
        }
        return out;
    }

    private static String stripPrefix(String key) {
        return key.startsWith(PREFIX) ? key.substring(PREFIX.length()) : key;
    }

    private static String sanitize(String fileName) {
        String n = fileName.replace('\\', '/');
        if (n.contains("/")) n = n.substring(n.lastIndexOf('/') + 1);
        n = n.replaceAll("[^\\p{L}\\p{N}._-]", "_").trim();
        if (n.isBlank() || n.equals(".") || n.equals("..")) {
            throw new IllegalArgumentException("Invalid jar name");
        }
        return n;
    }
}
