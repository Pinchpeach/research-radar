package io.github.pinchpeach.researchradar;

import android.graphics.Bitmap;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
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

/**
 * The library sign-in screen (LibraryWebPlugin): a bar with a close button and the address, over
 * a WebView left to navigate as a browser does (redirects, form posts and sign-in pages included),
 * in the app's own cookie store.
 */
public class LibraryWebActivity extends AppCompatActivity {

    static final String URL = "url", CLOSE = "close";
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
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                address.setText(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                address.setText(url);
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

    @Override
    protected void onDestroy() {
        CookieManager.getInstance().flush();
        if (current == this) current = null;
        if (LibraryWebPlugin.current != null) LibraryWebPlugin.current.closed();
        web.destroy();
        super.onDestroy();
    }
}
