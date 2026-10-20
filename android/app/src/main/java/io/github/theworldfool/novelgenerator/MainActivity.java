package io.github.theworldfool.novelgenerator;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public final class MainActivity extends Activity {
    private static final int PICK_FILE = 100, SAVE_FILE = 101;
    private WebView web;
    private String baseUrl;
    private String pendingExport;
    private ValueCallback<Uri[]> fileCallback;
    private boolean exiting;

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        if (saved != null) pendingExport = saved.getString("pendingExport");
        TextView loading = new TextView(this);
        loading.setText("叙事工坊\n正在打开手机里的书桌…");
        loading.setTextSize(20);
        loading.setGravity(android.view.Gravity.CENTER);
        loading.setTextColor(Color.rgb(49, 85, 64));
        setContentView(loading);
        WorkbenchApplication application = (WorkbenchApplication) getApplication();
        application.runtime.whenComplete((base, failure) -> runOnUiThread(() -> {
            if (isFinishing() || isDestroyed()) return;
            if (failure != null) {
                loading.setText("书桌暂时无法启动\n请检查剩余存储空间，并关闭后重新打开应用。\n已有作品保留在手机中。");
                return;
            }
            baseUrl = base;
            openWorkbench(application.sessionToken);
        }));
    }

    private boolean localUrl(String value) {
        if (baseUrl == null || value == null) return false;
        Uri uri = Uri.parse(value), base = Uri.parse(baseUrl);
        return "http".equals(uri.getScheme()) && "127.0.0.1".equals(uri.getHost())
            && uri.getPort() == base.getPort() && uri.getUserInfo() == null;
    }

    private boolean exportUrl(String value) {
        if (!localUrl(value)) return false;
        String path = Uri.parse(value).getPath();
        return path != null && path.matches("/api/projects/[a-zA-Z0-9_-]+/(export|backup)");
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void openWorkbench(String token) {
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(246, 244, 239));
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true); // Only URIs explicitly chosen in the system picker.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setUserAgentString(settings.getUserAgentString() + " NovelGeneratorAndroid/0.2.3");
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, false);
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (exportUrl(url)) { chooseExport(url); return true; }
                // The WebView only displays the bundled application, never arbitrary sites.
                return !localUrl(url);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!localUrl(request.getUrl().toString())) {
                    return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null,
                        new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                boolean images = false;
                for (String type : params.getAcceptTypes()) if (type.startsWith("image/")) images = true;
                intent.setType(images ? "image/*" : "*/*");
                if (images) intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/png", "image/jpeg", "image/webp"});
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                try { startActivityForResult(intent, PICK_FILE); }
                catch (ActivityNotFoundException error) {
                    fileCallback.onReceiveValue(null); fileCallback = null;
                    message("没有可用的文件选择器。");
                }
                return true;
            }
            @Override public boolean onJsAlert(WebView view, String url, String text, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(text)
                    .setPositiveButton("知道了", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel()).show();
                return true;
            }
            @Override public boolean onJsConfirm(WebView view, String url, String text, JsResult result) {
                new AlertDialog.Builder(MainActivity.this).setMessage(text)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel()).show();
                return true;
            }
        });
        web.setDownloadListener((url, ua, disposition, mime, size) -> chooseExport(url));
        // Android 15 enforces edge-to-edge: keep editor and keyboard clear of system bars.
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        setContentView(web);
        cookies.setCookie(baseUrl, "novel_session=" + token + "; Path=/; HttpOnly; SameSite=Strict", ok -> {
            if (Boolean.TRUE.equals(ok) && !isDestroyed()) web.loadUrl(baseUrl + "/");
            else message("无法建立本地会话，请重新打开应用。");
        });
    }

    private void chooseExport(String url) {
        if (!exportUrl(url) || pendingExport != null) return;
        pendingExport = url;
        boolean backup = Uri.parse(url).getPath().endsWith("/backup");
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(backup ? "application/json" : "text/markdown");
        intent.putExtra(Intent.EXTRA_TITLE, backup ? "novel-backup.json" : "novel.md");
        try { startActivityForResult(intent, SAVE_FILE); }
        catch (ActivityNotFoundException error) { pendingExport = null; message("没有可用的文件保存器。"); }
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code == PICK_FILE && fileCallback != null) {
            Uri uri = result == RESULT_OK && data != null ? data.getData() : null;
            fileCallback.onReceiveValue(uri == null ? null : new Uri[]{uri});
            fileCallback = null;
        } else if (code == SAVE_FILE) {
            String source = pendingExport;
            pendingExport = null;
            Uri target = result == RESULT_OK && data != null ? data.getData() : null;
            if (target == null) return;
            if (!exportUrl(source)) { message("应用已重启，请重新导出。"); return; }
            String cookie = "novel_session=" + ((WorkbenchApplication) getApplication()).sessionToken;
            new Thread(() -> {
                HttpURLConnection connection = null;
                try {
                    connection = (HttpURLConnection) new URL(source).openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setConnectTimeout(10000);
                    connection.setReadTimeout(30000);
                    connection.setRequestProperty("Cookie", cookie);
                    if (connection.getResponseCode() != 200) throw new IllegalStateException("Export failed");
                    try (InputStream input = connection.getInputStream();
                         OutputStream output = getContentResolver().openOutputStream(target, "wt")) {
                        if (output == null) throw new IllegalStateException("No output stream");
                        byte[] buffer = new byte[16384];
                        int count;
                        while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                    }
                    runOnUiThread(() -> message("作品已导出到你选择的位置。"));
                } catch (Exception error) {
                    runOnUiThread(() -> message("导出未完成，请检查存储空间并重试。原作品仍在应用中。"));
                } finally {
                    if (connection != null) connection.disconnect();
                }
            }, "novel-export").start();
        }
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("pendingExport", pendingExport);
    }

    @Override protected void onPause() {
        if (web != null) web.evaluateJavascript("window.mobileFlush && window.mobileFlush()", null);
        super.onPause();
    }

    @Override public void onBackPressed() {
        if (web == null) { super.onBackPressed(); return; }
        if (exiting) return;
        web.evaluateJavascript("window.mobileBack ? window.mobileBack() : 'exit'", result -> {
            if ("\"exit\"".equals(result)) {
                exiting = true;
                moveTaskToBack(true);
                exiting = false;
            }
        });
    }

    @Override protected void onDestroy() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (web != null) { web.stopLoading(); web.destroy(); web = null; }
        super.onDestroy();
    }

    private void message(String text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
}
