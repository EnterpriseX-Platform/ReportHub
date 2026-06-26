package io.reporthub.reportstudio.engine.remote;

import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;
import java.net.http.HttpClient;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Duration;

/**
 * Builds an {@link HttpClient} that, when {@code insecure} is set, trusts any TLS certificate.
 *
 * <p>Needed for internal back-ends presenting a self-signed certificate the JVM does not trust
 * (e.g. UAT's {@code uat.example}, whose cert is its own issuer → {@code PKIX path building
 * failed}). Hostname verification is left intact — the self-signed cert's CN already matches the
 * host, so only the trust-chain check needs relaxing. Toggle via {@code app.engine.remote.insecure-tls};
 * leave OFF in production.
 */
final class InsecureTls {

    private InsecureTls() {}

    static HttpClient client(boolean insecure, Duration connectTimeout) {
        HttpClient.Builder b = HttpClient.newBuilder().connectTimeout(connectTimeout);
        if (insecure) {
            try {
                SSLContext ctx = SSLContext.getInstance("TLS");
                ctx.init(null, new TrustManager[]{ new X509TrustManager() {
                    public void checkClientTrusted(X509Certificate[] chain, String authType) {}
                    public void checkServerTrusted(X509Certificate[] chain, String authType) {}
                    public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
                }}, new SecureRandom());
                b.sslContext(ctx);
            } catch (Exception e) {
                throw new IllegalStateException("failed to init insecure-TLS HttpClient: " + e.getMessage(), e);
            }
        }
        return b.build();
    }
}
