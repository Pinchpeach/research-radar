package io.github.pinchpeach.researchradar;

import android.net.http.SslCertificate;
import android.net.http.X509TrustManagerExtensions;
import android.os.Bundle;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.cert.CertificateException;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509ExtendedTrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * Servers that leave out the certificate between theirs and the root (library.yonsei.ac.kr does):
 * Chrome downloads it from the address the server's certificate names (its "authority information
 * access") and so connects; Android's web view and HTTP client don't, and fail. This does what
 * Chrome does: fetch the missing certificates, then check the whole chain against the phone's own
 * trusted roots, for the same host. Nothing the phone wouldn't trust gets through.
 */
final class AiaTrust {

    private static final byte[] CA_ISSUERS = {0x06, 0x08, 0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x30, 0x02};
    private static final Map<String, X509Certificate> fetched = new ConcurrentHashMap<>();
    private static X509TrustManager system;
    private static X509TrustManagerExtensions extensions;

    private AiaTrust() {}

    /** The app's HTTP requests (CapacitorHttp's) fill in missing certificates too. */
    static synchronized void install() {
        try {
            init();
            SSLContext context = SSLContext.getInstance("TLS");
            context.init(null, new TrustManager[] {new Manager()}, null);
            HttpsURLConnection.setDefaultSSLSocketFactory(context.getSocketFactory());
        } catch (Exception ignored) {
            // the system's own checks stay in place
        }
    }

    private static synchronized void init() throws Exception {
        if (system != null) return;
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        for (TrustManager manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager) {
                system = (X509TrustManager) manager;
                extensions = new X509TrustManagerExtensions(system);
                return;
            }
        }
        throw new IllegalStateException("no X509TrustManager");
    }

    /** Whether the web view's certificate for host is trusted once its missing certificates are fetched. Not on the main thread. */
    static boolean trusted(SslCertificate certificate, String host) {
        try {
            init();
            Bundle state = SslCertificate.saveState(certificate);
            byte[] der = state == null ? null : state.getByteArray("x509-certificate");
            if (der == null || host == null) return false;
            X509Certificate leaf = (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(der));
            X509Certificate[] chain = complete(new X509Certificate[] {leaf});
            extensions.checkServerTrusted(chain, authType(leaf), host);
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    private static void check(X509Certificate[] chain, String authType, String host) throws CertificateException {
        try {
            extensions.checkServerTrusted(chain, authType, host);
        } catch (CertificateException first) {
            X509Certificate[] completed = complete(chain);
            if (completed.length == chain.length) throw first;
            extensions.checkServerTrusted(completed, authType, host);
        }
    }

    private static String authType(X509Certificate leaf) {
        return "EC".equals(leaf.getPublicKey().getAlgorithm()) ? "ECDHE_ECDSA" : "RSA";
    }

    /** The chain with the certificates its last one names as its issuer's, up to four. */
    static X509Certificate[] complete(X509Certificate[] chain) {
        List<X509Certificate> all = new ArrayList<>(Arrays.asList(chain));
        for (int i = 0; i < 4; i++) {
            X509Certificate last = all.get(all.size() - 1);
            if (last.getSubjectX500Principal().equals(last.getIssuerX500Principal())) break; // a root
            String url = issuerUrl(last);
            X509Certificate issuer = url == null ? null : download(url);
            if (issuer == null || all.contains(issuer)) break;
            all.add(issuer);
        }
        return all.toArray(new X509Certificate[0]);
    }

    /** The caIssuers address in the certificate's authority information access extension. */
    private static String issuerUrl(X509Certificate certificate) {
        byte[] value = certificate.getExtensionValue("1.3.6.1.5.5.7.1.1");
        if (value == null) return null;
        for (int i = 0; i + CA_ISSUERS.length + 2 < value.length; i++) {
            if (!matches(value, i)) continue;
            int at = i + CA_ISSUERS.length;
            if ((value[at] & 0xff) != 0x86) continue; // a URI
            int length = value[at + 1] & 0xff;
            at += 2;
            if (length > 0x80) { // long form
                int bytes = length & 0x7f;
                length = 0;
                for (int b = 0; b < bytes && at < value.length; b++) length = (length << 8) | (value[at++] & 0xff);
            }
            if (length <= 0 || at + length > value.length) return null;
            String url = new String(value, at, length, StandardCharsets.US_ASCII);
            if (url.startsWith("http://") || url.startsWith("https://")) return url;
        }
        return null;
    }

    private static boolean matches(byte[] value, int at) {
        for (int j = 0; j < CA_ISSUERS.length; j++) if (value[at + j] != CA_ISSUERS[j]) return false;
        return true;
    }

    private static X509Certificate download(String url) {
        X509Certificate known = fetched.get(url);
        if (known != null) return known;
        X509Certificate issuer = get(url);
        // plain http is open only to the authorities listed in network_security_config.xml
        if (issuer == null && url.startsWith("http://")) issuer = get("https://" + url.substring(7));
        if (issuer != null) fetched.put(url, issuer);
        return issuer;
    }

    private static X509Certificate get(String url) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(url).openConnection();
            connection.setConnectTimeout(8000);
            connection.setReadTimeout(8000);
            connection.setInstanceFollowRedirects(true);
            if (connection.getResponseCode() != 200) return null;
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            try (InputStream in = connection.getInputStream()) {
                byte[] buffer = new byte[8192];
                for (int n; (n = in.read(buffer)) > 0; ) {
                    body.write(buffer, 0, n);
                    if (body.size() > 65536) return null; // a certificate, not a download
                }
            }
            // DER or PEM; a .p7c bundle gives its first certificate
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(new ByteArrayInputStream(body.toByteArray()));
        } catch (Exception e) {
            return null;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    /** The system's checks, with missing certificates fetched and the chain checked again on failure. */
    private static final class Manager extends X509ExtendedTrustManager {
        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            String host = socket instanceof SSLSocket && ((SSLSocket) socket).getHandshakeSession() != null
                ? ((SSLSocket) socket).getHandshakeSession().getPeerHost() : null;
            if (host == null) throw new CertificateException("no host to check the certificate for");
            check(chain, authType, host);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            String host = engine == null ? null : engine.getPeerHost();
            if (host == null) throw new CertificateException("no host to check the certificate for");
            check(chain, authType, host);
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            system.checkServerTrusted(chain, authType);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) throws CertificateException {
            system.checkClientTrusted(chain, authType);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) throws CertificateException {
            system.checkClientTrusted(chain, authType);
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            system.checkClientTrusted(chain, authType);
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return system.getAcceptedIssuers();
        }
    }
}
