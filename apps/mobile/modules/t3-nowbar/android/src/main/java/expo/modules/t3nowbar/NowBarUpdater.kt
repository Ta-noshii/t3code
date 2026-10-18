package expo.modules.t3nowbar

import android.app.ActivityManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.io.File
import java.net.URI
import java.security.MessageDigest
import org.json.JSONObject

/**
 * Background self-updates from the fork's GitHub releases. A job checks
 * update.json every six hours on an unmetered network, downloads and verifies
 * the APK, and installs it through a PackageInstaller session. With
 * UPDATE_PACKAGES_WITHOUT_USER_ACTION, Android 12 and later let an app update
 * itself without the confirmation screen. Installing kills the app, so the job
 * waits while the app is on screen and tries again 15 minutes later. When
 * Android still wants a tap, a notification asks for it.
 */
object NowBarUpdater {
  const val RELEASE_ROOT = "https://github.com/Ta-noshii/t3code-nowbar/releases/"
  const val PERIODIC_JOB = 7301
  private const val SOON_JOB = 7302
  private const val CHANNEL = "nowbar-updates"
  private const val NOTIFICATION = 7303
  private const val TAG = "T3NowBarUpdater"
  const val ACTION_STATUS = "expo.modules.t3nowbar.UPDATE_STATUS"

  data class Release(val version: String, val versionCode: Long, val url: String, val sha256: String)

  fun enabled(context: Context): Boolean {
    val prefs = NowBarService.prefs(context)
    return prefs.getBoolean("updates", true) && prefs.getBoolean("backgroundUpdates", true)
  }

  /** Keeps the periodic job in line with the preferences. Cheap to call often. */
  fun schedule(context: Context) {
    val scheduler = context.getSystemService(JobScheduler::class.java)
    if (!enabled(context)) {
      scheduler.cancel(PERIODIC_JOB)
      scheduler.cancel(SOON_JOB)
      return
    }
    if (scheduler.getPendingJob(PERIODIC_JOB) != null) return
    scheduler.schedule(job(context, PERIODIC_JOB).setPeriodic(6 * 60 * 60 * 1000L).setPersisted(true).build())
  }

  /** Runs the update job as soon as the network allows. */
  fun runSoon(context: Context) {
    if (!enabled(context)) return
    context.getSystemService(JobScheduler::class.java).schedule(job(context, SOON_JOB).build())
  }

  private fun job(context: Context, id: Int) =
    JobInfo.Builder(id, ComponentName(context, NowBarUpdateJob::class.java))
      .setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED)
      .setBackoffCriteria(15 * 60 * 1000L, JobInfo.BACKOFF_POLICY_LINEAR)

  /** One pass of the job. Returns true to retry later because the app was on screen. */
  fun run(context: Context): Boolean {
    if (!enabled(context)) return false
    val release = latest(context) ?: return false
    val apk = download(context, release.url, release.sha256, release.versionCode, null)
    if (onScreen()) return true
    if (!context.packageManager.canRequestPackageInstalls()) {
      // The app's update dialog asks for "Install unknown apps" next time it opens.
      notify(context, "T3 Code ${release.version} is ready", "Open T3 Code to install it.",
        context.packageManager.getLaunchIntentForPackage(context.packageName))
      return false
    }
    install(context, apk, release.version)
    return false
  }

  fun latest(context: Context): Release? {
    val connection = URI("${RELEASE_ROOT}latest/download/update.json").toURL().openConnection()
      .apply { connectTimeout = 20_000; readTimeout = 20_000 }
    val json = JSONObject(connection.getInputStream().use { it.readBytes().decodeToString() })
    val release = Release(json.getString("version"), json.getLong("versionCode"), json.getString("url"), json.getString("sha256"))
    require(release.versionCode > 0 && release.url.startsWith("${RELEASE_ROOT}download/") &&
      release.url.endsWith(".apk") && Regex("[a-fA-F0-9]{64}").matches(release.sha256)) { "Invalid update manifest" }
    val installed = context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode
    return release.takeIf { it.versionCode > installed }
  }

  /**
   * Downloads the APK into the cache, or reuses an earlier download with the
   * same checksum, and checks it is a newer build of this app.
   */
  @Synchronized
  fun download(context: Context, url: String, sha256: String, versionCode: Long,
    progress: ((phase: String, downloaded: Long, total: Long) -> Unit)?): File {
    require(url.startsWith("${RELEASE_ROOT}download/"))
    require(Regex("[a-fA-F0-9]{64}").matches(sha256))
    val destination = File(context.cacheDir, "nowbar-updates/update.apk")
    destination.parentFile!!.mkdirs()
    val cached = destination.isFile && sha256Of(destination).equals(sha256, true)
    if (!cached) {
      val connection = URI(url).toURL().openConnection().apply { connectTimeout = 20_000; readTimeout = 60_000 }
      val total = connection.contentLengthLong.coerceAtLeast(0)
      var lastSent = 0L
      progress?.invoke("downloading", 0, total)
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
              progress?.invoke("downloading", size, total)
            }
          }
          progress?.invoke("downloading", size, total)
        }
      }
    }
    progress?.invoke("verifying", 0, 0)
    if (!cached && !sha256Of(destination).equals(sha256, true)) {
      destination.delete()
      throw IllegalStateException("Update checksum did not match")
    }
    val archive = requireNotNull(context.packageManager.getPackageArchiveInfo(destination.path, 0))
    val installed = context.packageManager.getPackageInfo(context.packageName, 0)
    require(archive.packageName == context.packageName && archive.longVersionCode == versionCode &&
      archive.longVersionCode > installed.longVersionCode) {
      "Update does not match this app or is not newer"
    }
    return destination
  }

  private fun sha256Of(file: File): String {
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

  /** The Now Bar service alone ranks as a foreground service, not as on screen. */
  private fun onScreen(): Boolean {
    val info = ActivityManager.RunningAppProcessInfo()
    ActivityManager.getMyMemoryState(info)
    return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
  }

  private fun install(context: Context, apk: File, version: String) {
    val installer = context.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
      setAppPackageName(context.packageName)
      if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val id = installer.createSession(params)
    installer.openSession(id).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("base.apk", 0, apk.length()).use { output ->
          input.copyTo(output)
          session.fsync(output)
        }
      }
      NowBarService.prefs(context).edit().putString("installingVersion", version).apply()
      val status = Intent(context, NowBarUpdateReceiver::class.java).setAction(ACTION_STATUS).putExtra("version", version)
      // The installer fills in the result extras, so the intent has to stay mutable.
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
      session.commit(PendingIntent.getBroadcast(context, id, status, flags).intentSender)
    }
    Log.i(TAG, "Committed install session $id for $version")
  }

  fun notify(context: Context, title: String, text: String, target: Intent?, silent: Boolean = false) {
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val manager = context.getSystemService(NotificationManager::class.java)
    if (manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "App updates", NotificationManager.IMPORTANCE_DEFAULT))
    }
    val builder = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.nowbar_pulse)
      .setContentTitle(title).setContentText(text).setAutoCancel(true).setSilent(silent)
    if (target != null) {
      builder.setContentIntent(PendingIntent.getActivity(context, NOTIFICATION,
        target.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    manager.notify(NOTIFICATION, builder.build())
  }
}

class NowBarUpdateJob : JobService() {
  override fun onStartJob(params: JobParameters): Boolean {
    Thread {
      val retry = try {
        NowBarUpdater.run(applicationContext)
      } catch (error: Exception) {
        Log.w("T3NowBarUpdater", "Background update failed", error)
        false
      }
      jobFinished(params, retry)
    }.start()
    return true
  }

  override fun onStopJob(params: JobParameters) = true
}

class NowBarUpdateReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      NowBarUpdater.ACTION_STATUS -> {
        val version = intent.getStringExtra("version") ?: "An update"
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
          PackageInstaller.STATUS_PENDING_USER_ACTION -> {
            @Suppress("DEPRECATION")
            val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
              else intent.getParcelableExtra(Intent.EXTRA_INTENT)
            NowBarUpdater.notify(context, "T3 Code $version is ready", "Tap to install it.", confirm)
          }
          PackageInstaller.STATUS_SUCCESS -> Unit
          else -> {
            NowBarService.prefs(context).edit().remove("installingVersion").apply()
            Log.w("T3NowBarUpdater", "Install failed ($status): ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
          }
        }
      }
      Intent.ACTION_MY_PACKAGE_REPLACED -> {
        NowBarUpdater.schedule(context)
        File(context.cacheDir, "nowbar-updates/update.apk").delete()
        val prefs = NowBarService.prefs(context)
        val version = prefs.getString("installingVersion", null) ?: return
        prefs.edit().remove("installingVersion").apply()
        NowBarUpdater.notify(context, "T3 Code updated to $version", "Open it to reconnect.",
          context.packageManager.getLaunchIntentForPackage(context.packageName), silent = true)
      }
    }
  }
}
