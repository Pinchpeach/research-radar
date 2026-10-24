package io.github.pinchpeach.researchradar;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Signing in to the university library (frontend/web/mobile.js): a plain web view in a screen of
 * its own (LibraryWebActivity). It shares the app's cookie store, so the PDFs the app downloads
 * afterwards carry the sign-in. The page tells where the view has got to ("navigated") and points
 * it on (navigate) or closes it (close); "closed" says it is gone.
 */
@CapacitorPlugin(name = "LibraryWeb")
public class LibraryWebPlugin extends Plugin {

    static LibraryWebPlugin current;

    @Override
    public void load() {
        current = this;
    }

    @PluginMethod
    public void open(PluginCall call) {
        String url = call.getString("url");
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
            call.reject("an http(s) address is needed");
            return;
        }
        Intent intent = new Intent(getContext(), LibraryWebActivity.class);
        intent.putExtra(LibraryWebActivity.URL, url);
        intent.putExtra(LibraryWebActivity.CLOSE, call.getString("closeText", "Close"));
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void navigate(PluginCall call) {
        String url = call.getString("url");
        LibraryWebActivity screen = LibraryWebActivity.current;
        if (screen != null && url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            screen.runOnUiThread(() -> screen.load(url));
        }
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        LibraryWebActivity screen = LibraryWebActivity.current;
        if (screen != null) screen.runOnUiThread(screen::finish);
        call.resolve();
    }

    void navigated(String url) {
        JSObject data = new JSObject();
        data.put("url", url);
        notifyListeners("navigated", data);
    }

    void closed() {
        notifyListeners("closed", new JSObject());
    }
}
