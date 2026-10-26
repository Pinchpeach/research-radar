package io.github.pinchpeach.researchradar;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.CookieHandler;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * The library sign-in screen (LibraryWebPlugin): a bar with a close button and the address, over
 * a WebView left to navigate as a browser does (redirects, form posts and sign-in pages included),
 * in the app's own cookie store. A PDF it is sent to (it can't show one) is downloaded with the
 * view's cookies and browser name, to a file in the app's cache, and handed to the page.
 */
public class LibraryWebActivity extends AppCompatActivity {

    static final String URL = "url", CLOSE = "close";
    private static final int MAX_PDF = 100 * 1024 * 1024;
    // the page's PDF: Google Scholar's citation_pdf_url tag, else a PDF shown in a frame (IEEE)
    private static final String FIND_PDF = "(function(){"
        + "var m=document.querySelector('meta[name=\"citation_pdf_url\" i]');"
        + "if(m&&m.content){try{return new URL(m.content,location.href).href}catch(e){}}"
        + "var f=document.querySelectorAll('iframe[src],embed[src]');"
        + "for(var i=0;i<f.length;i++){if(/pdf/i.test(f[i].getAttribute('src')))return f[i].src}"
        + "return null})()";
    static LibraryWebActivity current;

    private WebView web;
    private TextView address;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        current = this;

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setPadding(16, 8, 24, 8);
        Button close = new Button(this);
        String closeText = getIntent().getStringExtra(CLOSE);
        close.setText(closeText != null ? closeText : "Close");
        close.setOnClickListener(view -> finish());
        address = new TextView(this);
        address.setSingleLine(true);
        address.setEllipsize(TextUtils.TruncateAt.END);
        address.setPadding(16, 0, 0, 0);
        bar.addView(close);
        bar.addView(address, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        web = new WebView(this);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setBuiltInZoomControls(true);
        settings.setDisplayZoomControls(false);
        // as Chrome: some schools' sign-in turns away browsers that say they're an app's web view ("; wv")
        settings.setUserAgentString(settings.getUserAgentString().replace("; wv", ""));
        web.setBackgroundColor(Color.WHITE);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        web.setWebChromeClient(new WebChromeClient());
        web.setDownloadListener((url, userAgent, disposition, mimeType, length) -> download(url, userAgent));
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                address.setText(url);
            }

            // a failed page says why in the address bar, instead of leaving a blank screen
            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) address.setText("⚠ " + error.getDescription() + " — " + request.getUrl());
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame()) address.setText("⚠ HTTP " + response.getStatusCode() + " — " + request.getUrl());
            }

            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                String host = Uri.parse(error.getUrl()).getHost();
                boolean onlyUntrusted = error.getPrimaryError() == SslError.SSL_UNTRUSTED
                    && !error.hasError(SslError.SSL_NOTYETVALID) && !error.hasError(SslError.SSL_EXPIRED)
                    && !error.hasError(SslError.SSL_IDMISMATCH) && !error.hasError(SslError.SSL_DATE_INVALID);
                if (!onlyUntrusted) {
                    refuse(handler, error);
                    return;
                }
                // a server that leaves out a certificate of its chain (library.yonsei.ac.kr): fetch
                // it as Chrome does and go on only if the phone then trusts the chain (AiaTrust)
                new Thread(() -> {
                    boolean trusted = AiaTrust.trusted(error.getCertificate(), host);
                    runOnUiThread(() -> {
                        if (trusted) handler.proceed();
                        else refuse(handler, error);
                    });
                }).start();
            }

            private void refuse(SslErrorHandler handler, SslError error) {
                handler.cancel(); // never past a certificate problem: just say so
                address.setText("⚠ certificate error " + error.getPrimaryError() + " — " + error.getUrl());
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                if (!address.getText().toString().startsWith("⚠")) address.setText(url);
                CookieManager.getInstance().flush();
                if (LibraryWebPlugin.current != null) LibraryWebPlugin.current.navigated(url);
            }
        });

        root.addView(bar);
        root.addView(web, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);
        // edge to edge (Android 15+): keep the bar clear of the status bar, the page of the navigation bar
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (web.canGoBack()) web.goBack();
                else finish();
            }
        });

        String url = getIntent().getStringExtra(URL);
        if (url != null) web.loadUrl(url);
    }

    void load(String url) {
        web.loadUrl(url);
    }

    /** The page's PDF link, or null (FIND_PDF; the result comes JSON-encoded). */
    void findPdf(ValueCallback<String> done) {
        web.evaluateJavascript(FIND_PDF, done);
    }

    private void download(String url, String userAgent) {
        address.setText("⬇ " + url);
        String referer = web.getUrl();
        new Thread(() -> {
            File file = new File(getCacheDir(), "library-paper.pdf");
            String error = null;
            try {
                fetch(url, userAgent, referer, file);
            } catch (Exception e) {
                error = e.getMessage() != null ? e.getMessage() : e.toString();
            }
            String failed = error;
            runOnUiThread(() -> {
                if (failed != null) address.setText("⚠ " + failed + " — " + url);
                if (LibraryWebPlugin.current != null) LibraryWebPlugin.current.downloaded(failed == null ? file.getAbsolutePath() : null, url, failed);
            });
        }).start();
    }

    /** Download url as the view would: its cookies (kept up to date on redirects) and browser name. */
    private static void fetch(String url, String userAgent, String referer, File file) throws IOException {
        CookieManager cookies = CookieManager.getInstance();
        // Capacitor's cookie handler already carries the view's cookies on these requests both ways
        boolean handled = CookieHandler.getDefault() != null;
        for (int hop = 0; hop < 8; hop++) {
            if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IOException("not a web address");
            HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
            try {
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(20000);
                connection.setReadTimeout(60000);
                if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
                if (referer != null) connection.setRequestProperty("Referer", referer);
                connection.setRequestProperty("Accept", "application/pdf,*/*");
                String cookie = handled ? null : cookies.getCookie(url);
                if (cookie != null) connection.setRequestProperty("Cookie", cookie);
                int status = connection.getResponseCode();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (!handled && header.getKey() != null && header.getKey().equalsIgnoreCase("Set-Cookie")) {
                        for (String value : header.getValue()) cookies.setCookie(url, value);
                    }
                }
                String location = connection.getHeaderField("Location");
                if (status >= 300 && status < 400 && location != null) {
                    referer = url;
                    url = new URL(new URL(url), location).toString();
                    continue;
                }
                if (status != 200) throw new IOException("HTTP " + status);
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[65536];
                    StringBuilder head = new StringBuilder();
                    long total = 0;
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        if (head.length() < 1024) head.append(new String(buffer, 0, Math.min(n, 1024), StandardCharsets.ISO_8859_1));
                        total += n;
                        if (total > MAX_PDF) throw new IOException("PDF too large");
                        out.write(buffer, 0, n);
                    }
                    // a sign-in or bot-check page instead of the paper
                    if (!head.toString().trim().startsWith("%PDF")) throw new IOException("not a PDF");
                }
                cookies.flush();
                return;
            } finally {
                connection.disconnect();
            }
        }
        throw new IOException("too many redirects");
    }

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        if (current == this) current = null;
        if (LibraryWebPlugin.current != null) LibraryWebPlugin.current.closed();
        web.destroy();
        super.onDestroy();
    }
}
