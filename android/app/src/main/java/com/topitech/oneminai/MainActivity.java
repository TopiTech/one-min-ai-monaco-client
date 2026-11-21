package com.topitech.oneminai;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetManager;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {

    private static final String TAG = "OneMinAiMainActivity";
    private static final String PREFS_NAME = "nodejs_mobile_prefs";
    private static final String PREF_LAST_UPDATE_TIME = "last_update_time";
    private static final String ASSET_NODE_DIR = "nodejs-project";
    private static final String PRESERVED_DATA_DIR = ".mimocode";
    private static final int BFF_PORT = 38517;
    private static final String BFF_ROOT_URL = "http://127.0.0.1:" + BFF_PORT + "/";
    private static final String BFF_HEALTH_URL = BFF_ROOT_URL + "api/health";
    private static final long HEALTH_TIMEOUT_MS = 30_000L;
    private static final long HEALTH_POLL_INTERVAL_MS = 250L;

    private static final AtomicBoolean nodeStarted = new AtomicBoolean(false);
    private static volatile boolean nodeReady = false;

    static {
        System.loadLibrary("native-lib");
        System.loadLibrary("node");
    }

    public native int startNodeWithArguments(
        String[] arguments,
        String nodeProjectDir,
        String cacheDir,
        String workspaceDir
    );

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        ensureNodeServerAndNavigate();
    }

    private void ensureNodeServerAndNavigate() {
        if (nodeReady) {
            navigateToBff();
            return;
        }

        if (nodeStarted.compareAndSet(false, true)) {
            Thread bootstrapThread = new Thread(
                () -> {
                    try {
                        File nodeProjectDir = new File(getFilesDir(), ASSET_NODE_DIR);
                        File workspaceDir = new File(getFilesDir(), "workspace");
                        if (!workspaceDir.exists() && !workspaceDir.mkdirs()) {
                            throw new IOException("Failed to create workspace dir: " + workspaceDir);
                        }

                        syncNodeProjectAssetsIfNeeded(nodeProjectDir);

                        File serverJs = new File(nodeProjectDir, "server.js");
                        if (!serverJs.exists()) {
                            throw new IOException("Missing server.js in " + nodeProjectDir);
                        }

                        Thread nodeThread = new Thread(
                            () -> {
                                int code = startNodeWithArguments(
                                    new String[] { "node", serverJs.getAbsolutePath() },
                                    nodeProjectDir.getAbsolutePath(),
                                    getCacheDir().getAbsolutePath(),
                                    workspaceDir.getAbsolutePath()
                                );
                                Log.w(TAG, "Node.js exited with code: " + code);
                            },
                            "nodejs-runtime"
                        );
                        nodeThread.start();

                        waitForBffAndNavigate();
                    } catch (Exception e) {
                        Log.e(TAG, "Failed to bootstrap local Node.js BFF", e);
                        nodeStarted.set(false);
                        showStartupError(e.getMessage());
                    }
                },
                "nodejs-bootstrap"
            );
            bootstrapThread.start();
        } else {
            Thread waitThread = new Thread(
                () -> {
                    try {
                        waitForBffAndNavigate();
                    } catch (Exception e) {
                        Log.e(TAG, "Failed waiting for local Node.js BFF", e);
                        showStartupError(e.getMessage());
                    }
                },
                "nodejs-health-wait"
            );
            waitThread.start();
        }
    }

    private void waitForBffAndNavigate() throws InterruptedException, IOException {
        long deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS;
        while (!isDestroyed() && !isFinishing() && System.currentTimeMillis() < deadline) {
            if (isBffHealthy()) {
                nodeReady = true;
                navigateToBff();
                return;
            }
            Thread.sleep(HEALTH_POLL_INTERVAL_MS);
        }
        if (!isDestroyed() && !isFinishing()) {
            throw new IOException("Timed out waiting for local BFF server at " + BFF_HEALTH_URL);
        }
    }

    private boolean isBffHealthy() {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(BFF_HEALTH_URL);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(1000);
            conn.setReadTimeout(1000);
            int status = conn.getResponseCode();
            return status == HttpURLConnection.HTTP_OK;
        } catch (IOException ignored) {
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private void navigateToBff() {
        runOnUiThread(() -> {
            if (isDestroyed() || isFinishing() || getBridge() == null) {
                return;
            }
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.loadUrl(BFF_ROOT_URL);
            }
        });
    }

    private void showStartupError(String errorMessage) {
        final String quoted = JSONObject.quote(errorMessage != null ? errorMessage : "Unknown startup error");
        runOnUiThread(() -> {
            if (isDestroyed() || isFinishing() || getBridge() == null) {
                return;
            }
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                webView.evaluateJavascript(
                    "window.__showStartupError && window.__showStartupError(" + quoted + ");",
                    null
                );
            }
        });
    }

    private void syncNodeProjectAssetsIfNeeded(File nodeProjectDir)
        throws PackageManager.NameNotFoundException, IOException {
        long currentUpdateTime = getApkLastUpdateTime();
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        long savedUpdateTime = prefs.getLong(PREF_LAST_UPDATE_TIME, -1L);
        File serverJs = new File(nodeProjectDir, "server.js");

        if (savedUpdateTime == currentUpdateTime && serverJs.exists()) {
            return;
        }

        if (nodeProjectDir.exists()) {
            deleteDirectoryPreserving(nodeProjectDir, PRESERVED_DATA_DIR);
        }
        if (!nodeProjectDir.exists() && !nodeProjectDir.mkdirs()) {
            throw new IOException("Failed to create Node project directory: " + nodeProjectDir);
        }

        copyAssetFolder(getAssets(), ASSET_NODE_DIR, nodeProjectDir);
        prefs.edit().putLong(PREF_LAST_UPDATE_TIME, currentUpdateTime).apply();
    }

    private long getApkLastUpdateTime() throws PackageManager.NameNotFoundException {
        PackageManager pm = getPackageManager();
        PackageInfo info;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            info = pm.getPackageInfo(getPackageName(), PackageManager.PackageInfoFlags.of(0));
        } else {
            info = pm.getPackageInfo(getPackageName(), 0);
        }
        return info.lastUpdateTime;
    }

    private static void deleteDirectoryPreserving(File dir, String preservedChildName) throws IOException {
        File[] children = dir.listFiles();
        if (children == null) {
            return;
        }
        for (File child : children) {
            if (preservedChildName != null && preservedChildName.equals(child.getName())) {
                continue;
            }
            deleteRecursively(child);
        }
    }

    private static void deleteRecursively(File target) throws IOException {
        if (target.isDirectory()) {
            File[] children = target.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!target.delete()) {
            throw new IOException("Failed to delete old asset path: " + target);
        }
    }

    private static void copyAssetFolder(AssetManager assets, String assetPath, File destDir)
        throws IOException {
        String[] entries = assets.list(assetPath);
        if (entries == null || entries.length == 0) {
            try (InputStream in = assets.open(assetPath)) {
                File parent = destDir.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) {
                    throw new IOException("Failed to create parent directory: " + parent);
                }
                copyStream(in, destDir);
            } catch (IOException notAFile) {
                if (!destDir.exists() && !destDir.mkdirs()) {
                    throw new IOException("Failed to create asset directory: " + destDir, notAFile);
                }
            }
            return;
        }

        if (!destDir.exists() && !destDir.mkdirs()) {
            throw new IOException("Failed to create directory: " + destDir);
        }
        for (String entry : entries) {
            copyAssetFolder(assets, assetPath + "/" + entry, new File(destDir, entry));
        }
    }

    private static void copyStream(InputStream in, File destFile) throws IOException {
        byte[] buffer = new byte[16 * 1024];
        try (OutputStream out = new FileOutputStream(destFile)) {
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
        }
    }
}
