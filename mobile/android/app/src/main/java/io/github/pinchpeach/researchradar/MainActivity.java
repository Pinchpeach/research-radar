package io.github.pinchpeach.researchradar;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        AiaTrust.install(); // servers that leave out a certificate of their chain, as Chrome connects to them
        registerPlugin(LibraryWebPlugin.class); // the library sign-in window (LibraryWebActivity)
        super.onCreate(savedInstanceState);
    }
}
