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
        assertTrue(request("/", null).contains("backup.js"));
        assertTrue(request("/backup.js", null).contains("/api/backups/preview"));
        JSONObject preview = new JSONObject(request("/api/backups/preview", backup)).getJSONObject("preview");
        assertEquals(1, preview.getInt("chapter_count"));
        JSONObject restored = new JSONObject(request("/api/backups/import", backup)).getJSONObject("project");
        assertNotEquals(id, restored.getString("id"));
        assertEquals("正文在手机里保存。", restored.getJSONArray("chapters").getJSONObject(0).getString("text"));
        assertTrue(request("/api/projects/" + id + "/export", null).contains("正文在手机里保存。"));
    }

    @Test public void otherLocalClientsCannotReadTheBooks() throws Exception {
        String base = application().runtime.get(60, TimeUnit.SECONDS);
        HttpURLConnection connection = (HttpURLConnection) new URL(base + "/api/projects").openConnection();
        try { assertEquals(403, connection.getResponseCode()); }
        finally { connection.disconnect(); }
    }

    @Test public void unfinishedInputsPersistBesideTheStory() throws Exception {
        assertTrue(request("/drafts.js", null).contains("workDrafts"));
        assertTrue(request("/proposals.js", null).contains("previewScenePlan"));
        JSONObject book = new JSONObject(request("/api/projects", new JSONObject().put("title", "未完成输入测试"))).getJSONObject("project");
        String path = "/api/projects/" + book.getString("id") + "/drafts";
        String key = "dialog:entity-form:character:new";
        JSONObject value = new JSONObject().put("description", "返回后继续完善的人物小传").put("locked", true);
        JSONObject written = new JSONObject(request(path, new JSONObject().put("action", "write").put("key", key)
                .put("expected_version", 0).put("value", value))).getJSONObject("draft");
        assertEquals(1, written.getInt("version"));
        JSONObject read = new JSONObject(request(path, new JSONObject().put("action", "read").put("key", key))).getJSONObject("draft");
        assertEquals(value.getString("description"), read.getJSONObject("value").getString("description"));
        assertTrue(read.getJSONObject("value").getBoolean("locked"));
        JSONObject reloaded = new JSONObject(request("/api/projects/" + book.getString("id"), null)).getJSONObject("project");
        assertEquals(book.getInt("revision"), reloaded.getInt("revision"));
        assertEquals(1, new JSONObject(request(path, null)).getJSONArray("drafts").length());
        JSONObject removed = new JSONObject(request(path, new JSONObject().put("action", "delete").put("key", key)
                .put("expected_version", 1))).getJSONObject("draft");
        assertTrue(removed.isNull("value"));
        assertEquals(2, removed.getInt("version"));
    }

    @Test public void chapterMemoryCanBeEditedWithoutRewritingProse() throws Exception {
        assertTrue(request("/memory.js", null).contains("previewChapterMemory"));
        assertTrue(request("/revisions.js", null).contains("decorateRevisions"));
        JSONObject book = new JSONObject(request("/api/projects", new JSONObject().put("title", "章节记忆测试"))).getJSONObject("project");
        String path = "/api/projects/" + book.getString("id");
        String chapterId = book.getJSONArray("chapters").getJSONObject(0).getString("id");
        JSONObject saved = new JSONObject(request(path + "/mutate", new JSONObject().put("revision", book.getInt("revision"))
                .put("action", "save_chapter").put("data", new JSONObject().put("id", chapterId)
                        .put("text", "他留在船厂修船。").put("summary", "旧摘要")))).getJSONObject("project");
        JSONObject memory = new JSONObject(request(path + "/memory-preview", new JSONObject().put("revision", saved.getInt("revision"))
                .put("chapter_id", chapterId).put("manual", true))).getJSONObject("memory");
        assertEquals("旧摘要", memory.getString("summary"));
        memory.put("summary", "他仍留在船厂，正在修船。");
        JSONObject updated = new JSONObject(request(path + "/mutate", new JSONObject().put("revision", saved.getInt("revision"))
                .put("action", "apply_memory").put("data", memory))).getJSONObject("project");
        JSONObject chapter = updated.getJSONArray("chapters").getJSONObject(0);
        assertEquals("他留在船厂修船。", chapter.getString("text"));
        assertEquals("他仍留在船厂，正在修船。", chapter.getString("summary"));
        assertNotEquals("approved", chapter.getString("status"));
        assertTrue(chapter.getBoolean("local_edit_review_required"));
    }

    @Test public void chapterTrashSurvivesBackupAndCanRestoreOriginalProse() throws Exception {
        assertTrue(request("/chapters.js", null).contains("decorateChapters"));
        assertTrue(request("/rewrite-notes.js", null).contains("captureRewriteNotes"));
        JSONObject book = new JSONObject(request("/api/projects", new JSONObject().put("title", "章节回收站测试"))).getJSONObject("project");
        String path = "/api/projects/" + book.getString("id");
        JSONObject first = book.getJSONArray("chapters").getJSONObject(0);
        String chapterId = first.getString("id");
        book = new JSONObject(request(path + "/mutate", new JSONObject().put("revision", book.getInt("revision"))
                .put("action", "save_chapter").put("data", new JSONObject().put("id", chapterId)
                        .put("text", "门外的雨停了。").put("summary", "雨停。")))).getJSONObject("project");
        book = new JSONObject(request(path + "/mutate", new JSONObject().put("revision", book.getInt("revision"))
                .put("action", "insert_chapter").put("data", new JSONObject().put("id", chapterId)
                        .put("position", "after").put("title", "下一章")))).getJSONObject("project");
        book = new JSONObject(request(path + "/mutate", new JSONObject().put("revision", book.getInt("revision"))
                .put("action", "delete_chapter").put("data", new JSONObject().put("id", chapterId)
                        .put("confirm_title", first.getString("title"))))).getJSONObject("project");
        assertEquals(1, book.getJSONArray("chapters").length());
        JSONObject trash = book.getJSONArray("chapter_trash").getJSONObject(0);
        assertEquals("门外的雨停了。", trash.getJSONObject("chapter").getString("text"));
        JSONObject backup = new JSONObject(request(path + "/backup", null));
        JSONObject preview = new JSONObject(request("/api/backups/preview", backup)).getJSONObject("preview");
        assertEquals(1, preview.getInt("trashed_chapter_count"));
        JSONObject imported = new JSONObject(request("/api/backups/import", backup)).getJSONObject("project");
        String importedPath = "/api/projects/" + imported.getString("id");
        JSONObject restored = new JSONObject(request(importedPath + "/mutate", new JSONObject().put("revision", imported.getInt("revision"))
                .put("action", "restore_chapter").put("data", new JSONObject().put("trash_id", trash.getString("id"))))).getJSONObject("project");
        assertEquals(2, restored.getJSONArray("chapters").length());
        assertEquals(0, restored.getJSONArray("chapter_trash").length());
        JSONObject original = restored.getJSONArray("chapters").getJSONObject(0);
        assertEquals(chapterId, original.getString("id"));
        assertEquals("门外的雨停了。", original.getString("text"));
        assertNotEquals("approved", original.getString("status"));
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
