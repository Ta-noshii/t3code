package expo.modules.t3nowbar

import android.app.NotificationManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.net.URI
import java.security.MessageDigest
import org.json.JSONObject
import org.json.JSONArray

class T3NowBarModule : Module() {
  private val context get() = requireNotNull(appContext.reactContext)

  companion object {
    @Volatile
    var heartbeat: (() -> Unit)? = null
      private set
  }

  override fun definition() = ModuleDefinition {
    Name("T3NowBar")
    Events("heartbeat", "updateProgress")
    OnCreate { heartbeat = { sendEvent("heartbeat", emptyMap<String, Any>()) } }
    OnDestroy { heartbeat = null }
    Function("debugShow") { json: String, custom: Boolean, nudge: Boolean, expanded: Boolean -> NowBarDebug.show(context, json, custom, nudge, expanded) }
    Function("debugClear") { NowBarDebug.clear(context) }
    Function("debugStatus") { NowBarDebug.status(context) }
    Function("clearRemotePush") {
      if (NowBarService.instance == null) context.getSystemService(NotificationManager::class.java).cancel(NowBarService.LIVE_ID)
      NowBarService.prefs(context).edit().remove("remoteRowKey").remove("remoteRowPhase").remove("remoteRowKind").remove("lastPushAt").apply()
    }
    Function("readState") {
      val prefs = NowBarService.prefs(context)
      if (!prefs.contains("unreadSince")) prefs.edit().putLong("unreadSince", System.currentTimeMillis()).apply()
      mapOf("since" to prefs.getLong("unreadSince", 0), "readTurns" to prefs.getString("readTurns", "{}"))
    }
    Function("markRead") { identity: String, turn: String ->
      val prefs = NowBarService.prefs(context)
      val reads = JSONObject(prefs.getString("readTurns", "{}") ?: "{}")
      reads.put(identity, turn)
      prefs.edit().putString("readTurns", reads.toString()).apply()
      val remoteKey = runCatching { JSONArray(prefs.getString("remoteRowKey", "[]")) }.getOrNull()
      if (remoteKey != null && remoteKey.length() == 3 &&
        JSONArray().put(remoteKey.getString(0)).put(remoteKey.getString(1)).toString() == identity && remoteKey.getString(2) == turn) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (NowBarService.instance == null) manager.cancel(NowBarService.LIVE_ID)
        manager.cancel(remoteKey.toString().hashCode())
      }
    }
    Function("preferences") {
      val prefs = NowBarService.prefs(context)
      mapOf("enabled" to prefs.getBoolean("enabled", false), "private" to prefs.getBoolean("private", false),
        "results" to prefs.getBoolean("results", true), "updates" to prefs.getBoolean("updates", true),
        "push" to prefs.getBoolean("push", false), "pushLive" to prefs.getBoolean("pushLive", true),
        "expanded" to prefs.getBoolean("expanded", false),
        "custom" to prefs.getBoolean("custom", true), "nudges" to prefs.getBoolean("nudges", true))
    }
    Function("setPreferences") { json: String ->
      val values = JSONObject(json)
      val edit = NowBarService.prefs(context).edit()
      listOf("enabled", "private", "results", "updates", "push", "pushLive", "custom", "nudges", "expanded").forEach { key ->
        if (values.has(key)) edit.putBoolean(key, values.getBoolean(key))
      }
      if (values.optBoolean("enabled", false)) edit.remove("suppressed")
      edit.apply()
      if (((values.has("push") && !values.getBoolean("push")) ||
          (values.has("pushLive") && !values.getBoolean("pushLive"))) && NowBarService.instance == null) {
        context.getSystemService(NotificationManager::class.java).cancel(NowBarService.LIVE_ID)
      }
      if (values.has("enabled") && !values.getBoolean("enabled")) {
        context.stopService(Intent(context, NowBarService::class.java))
      } else {
        Handler(Looper.getMainLooper()).post {
          NowBarService.instance?.action("refresh") ?: NowBarService.refreshRemoteCard(context)
        }
      }
    }
    Function("capabilities") {
      val manager = context.getSystemService(NotificationManager::class.java)
      mapOf(
        "samsung" to Build.MANUFACTURER.equals("samsung", true),
        "sdk" to Build.VERSION.SDK_INT,
        "notifications" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "promoted" to (Build.VERSION.SDK_INT >= 36 && manager.canPostPromotedNotifications()),
        "active" to (NowBarService.instance != null),
      )
    }
    Function("openSettings") {
      val action = if (Build.VERSION.SDK_INT >= 36) "android.settings.APP_NOTIFICATION_PROMOTION_SETTINGS" else Settings.ACTION_APP_NOTIFICATION_SETTINGS
      val intent = Intent(action).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try { context.startActivity(intent) } catch (_: Exception) {
        context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
          .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }
    Function("publish") { rows: String ->
      if (!NowBarService.prefs(context).getBoolean("enabled", false) ||
        !NotificationManagerCompat.from(context).areNotificationsEnabled()) {
        context.stopService(Intent(context, NowBarService::class.java))
        false
      } else if (rows == "[]") {
        context.stopService(Intent(context, NowBarService::class.java))
        NowBarService.prefs(context).edit().remove("suppressed").apply()
        true
      } else {
        val incoming = JSONArray(rows)
        val suppressed = NowBarService.prefs(context).getStringSet("suppressed", emptySet()).orEmpty()
        val allSuppressed = (0 until incoming.length()).all { incoming.getJSONObject(it).getString("key") in suppressed }
        val allOffline = (0 until incoming.length()).all { incoming.getJSONObject(it).optString("phase") == "offline" }
        val intent = Intent(context, NowBarService::class.java).putExtra("rows", rows)
        try {
          // Android only permits starting a fresh FGS while foregrounded. An
          // existing user-started monitor may receive updates in background.
          if (allSuppressed || (allOffline && NowBarService.instance == null)) false else {
            if (NowBarService.instance == null) ContextCompat.startForegroundService(context, intent)
            else context.startService(intent)
            true
          }
        } catch (_: IllegalStateException) { false }
      }
    }
    Function("result") { row: String -> NowBarService.result(context, row) }
    Function("canInstallUpdates") { context.packageManager.canRequestPackageInstalls() }
    AsyncFunction("installUpdate") { url: String, sha256: String, versionCode: Int, promise: Promise ->
      val appContext = context
      if (!appContext.packageManager.canRequestPackageInstalls()) {
        appContext.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${appContext.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        promise.resolve("permission")
      } else {
        Thread {
          try {
            require(url.startsWith("https://github.com/Ta-noshii/t3code-nowbar/releases/download/"))
            require(Regex("[a-fA-F0-9]{64}").matches(sha256))
            val destination = File(appContext.cacheDir, "nowbar-updates/update.apk")
            destination.parentFile!!.mkdirs()
            fun progress(phase: String, downloaded: Long, total: Long) =
              sendEvent("updateProgress", mapOf("phase" to phase, "downloaded" to downloaded.toDouble(), "total" to total.toDouble()))
            fun sha256Of(file: File): String {
              val digest = MessageDigest.getInstance("SHA-256")
              file.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) {
                  val count = input.read(buffer)
                  if (count < 0) break
                  digest.update(buffer, 0, count)
                }
              }
              return digest.digest().joinToString("") { "%02x".format(it) }
            }
            // A finished download from an earlier tap is reused, so reopening the installer is instant.
            val cached = destination.isFile && sha256Of(destination).equals(sha256, true)
            if (!cached) {
              val connection = URI(url).toURL().openConnection().apply { connectTimeout = 20_000; readTimeout = 60_000 }
              val total = connection.contentLengthLong.coerceAtLeast(0)
              var lastSent = 0L
              progress("downloading", 0, total)
              connection.getInputStream().use { input ->
                destination.outputStream().use { output ->
                  val buffer = ByteArray(65536)
                  var size = 0L
                  while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    size += count
                    require(size <= 512L * 1024 * 1024) { "Update too large" }
                    output.write(buffer, 0, count)
                    val now = System.currentTimeMillis()
                    if (now - lastSent >= 150) {
                      lastSent = now
                      progress("downloading", size, total)
                    }
                  }
                  progress("downloading", size, total)
                }
              }
            }
            progress("verifying", 0, 0)
            if (!cached && !sha256Of(destination).equals(sha256, true)) {
              destination.delete()
              throw IllegalStateException("Update checksum did not match")
            }
            val archive = requireNotNull(appContext.packageManager.getPackageArchiveInfo(destination.path, 0))
            val installed = appContext.packageManager.getPackageInfo(appContext.packageName, 0)
            require(archive.packageName == appContext.packageName && archive.longVersionCode == versionCode.toLong() && archive.longVersionCode > installed.longVersionCode) {
              "Update does not match this app or is not newer"
            }
            val uri = FileProvider.getUriForFile(appContext, "${appContext.packageName}.nowbarupdates", destination)
            appContext.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
              .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
            promise.resolve("installer")
          } catch (error: Exception) {
            promise.reject("UPDATE_FAILED", error.message, error)
          }
        }.start()
      }
    }
  }
}
