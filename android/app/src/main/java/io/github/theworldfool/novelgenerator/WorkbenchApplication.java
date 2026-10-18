package io.github.theworldfool.novelgenerator;

import android.app.Application;
import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.concurrent.CompletableFuture;

public final class WorkbenchApplication extends Application {
    final CompletableFuture<String> runtime = new CompletableFuture<>();
    String sessionToken;

    @Override public void onCreate() {
        super.onCreate();
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder token = new StringBuilder();
        for (byte b : bytes) token.append(String.format("%02x", b & 0xff));
        sessionToken = token.toString();
        new Thread(() -> {
            try {
                File web = new File(getFilesDir(), "runtime/web");
                if (!web.isDirectory() && !web.mkdirs()) throw new IllegalStateException("Cannot create assets directory");
                for (String name : getAssets().list("web")) {
                    try (InputStream in = getAssets().open("web/" + name);
                         FileOutputStream out = new FileOutputStream(new File(web, name))) {
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
                    }
                }
                if (!Python.isStarted()) Python.start(new AndroidPlatform(this));
                String base = Python.getInstance().getModule("android_runtime")
                    .callAttr("start", getFilesDir().getAbsolutePath(), web.getAbsolutePath(), sessionToken).toString();
                runtime.complete(base);
            } catch (Exception error) {
                runtime.completeExceptionally(error);
            }
        }, "novel-startup").start();
    }
}
