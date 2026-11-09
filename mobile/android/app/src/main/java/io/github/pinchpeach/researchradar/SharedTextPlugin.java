package io.github.pinchpeach.researchradar;

import android.content.Intent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Text shared to the app from another app (Share → Research Radar): a DOI or a paper's link,
 * which the page opens (frontend/web/mobile.js). The text that started the app waits for the
 * page to take it; text shared while it runs comes as a "shared" event.
 */
@CapacitorPlugin(name = "SharedText")
public class SharedTextPlugin extends Plugin {

    private static final int MAX_LENGTH = 2000;
    private String waiting;

    @Override
    public void load() {
        waiting = textOf(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String text = textOf(intent);
        if (text == null) return;
        JSObject data = new JSObject();
        data.put("text", text);
        notifyListeners("shared", data);
    }

    /** The text the app was started with, once; nothing after that. */
    @PluginMethod
    public void take(PluginCall call) {
        JSObject data = new JSObject();
        if (waiting != null) data.put("text", waiting);
        waiting = null;
        call.resolve(data);
    }

    private static String textOf(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction()) || !"text/plain".equals(intent.getType())) return null;
        CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
        if (text == null) return null;
        String value = text.toString().trim();
        return value.isEmpty() ? null : value.substring(0, Math.min(value.length(), MAX_LENGTH));
    }
}
