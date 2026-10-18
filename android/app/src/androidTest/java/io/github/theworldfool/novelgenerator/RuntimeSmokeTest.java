package io.github.theworldfool.novelgenerator;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.json.JSONObject;
import java.net.HttpURLConnection;
import java.net.URL;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import static org.junit.Assert.*;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;

/** Executes the actual bundled Python/SQLite runtime on an Android device. */
@RunWith(AndroidJUnit4.class)
public class RuntimeSmokeTest {
    private WorkbenchApplication application() {
        return (WorkbenchApplication) InstrumentationRegistry.getInstrumentation().getTargetContext().getApplicationContext();
    }

    private String request(String path, JSONObject body) throws Exception {
        WorkbenchApplication app = application();
        String base = app.runtime.get(60, TimeUnit.SECONDS);
        HttpURLConnection connection = (HttpURLConnection) new URL(base + path).openConnection();
        connection.setRequestProperty("Cookie", "novel_session=" + app.sessionToken);
        connection.setConnectTimeout(10000);
        connection.setReadTimeout(10000);
        if (body != null) {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json");
            connection.setDoOutput(true);
            try (java.io.OutputStream out = connection.getOutputStream()) {
                out.write(body.toString().getBytes(StandardCharsets.UTF_8));
            }
        }
        try {
            assertTrue(connection.getResponseCode() < 300);
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                return output.toString("UTF-8");
            }
        } finally { connection.disconnect(); }
    }

    @Test public void bundledUiAndPythonDatabaseWorkOffline() throws Exception {
        assertTrue(request("/", null).contains("mobile.js"));
        assertTrue(request("/mobile.js", null).contains("mobileFlush"));
        JSONObject created = new JSONObject(request("/api/projects", new JSONObject().put("title", "安卓运行测试"))).getJSONObject("project");
        String id = created.getString("id");
        JSONObject chapter = created.getJSONArray("chapters").getJSONObject(0);
        JSONObject data = new JSONObject().put("id", chapter.getString("id")).put("text", "正文在手机里保存。").put("summary", "本机测试");
        request("/api/projects/" + id + "/mutate", new JSONObject().put("revision", created.getInt("revision")).put("action", "save_chapter").put("data", data));
        assertTrue(request("/api/projects/" + id + "/export", null).contains("正文在手机里保存。"));
        JSONObject backup = new JSONObject(request("/api/projects/" + id + "/backup", null));
        assertEquals("正文在手机里保存。", backup.getJSONObject("project").getJSONArray("chapters").getJSONObject(0).getString("text"));
    }

    @Test public void otherLocalClientsCannotReadTheBooks() throws Exception {
        String base = application().runtime.get(60, TimeUnit.SECONDS);
        HttpURLConnection connection = (HttpURLConnection) new URL(base + "/api/projects").openConnection();
        try { assertEquals(403, connection.getResponseCode()); }
        finally { connection.disconnect(); }
    }

    @Test public void nativeActivityStartsWithTheEmbeddedRuntime() throws Exception {
        application().runtime.get(60, TimeUnit.SECONDS);
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        Intent intent = new Intent(instrumentation.getTargetContext(), MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        Activity activity = instrumentation.startActivitySync(intent);
        instrumentation.waitForIdleSync();
        assertFalse(activity.isFinishing());
        instrumentation.runOnMainSync(activity::finish);
    }
}
