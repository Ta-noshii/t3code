package expo.modules.t3nowbar

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.Icon
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONArray
import org.json.JSONObject

class NowBarService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var rows = emptyList<JSONObject>()
  private var selectedKey: String? = null
  private var lastHeartbeat = 0L
  private var lastConnectedAt = 0L
  private var foreground = false
  private var pendingNudge = false
  private var wakeLock: PowerManager.WakeLock? = null
  private val watchdog = object : Runnable {
    override fun run() {
      if (rows.isNotEmpty() && rows.all { it.optString("phase") == "offline" } &&
        SystemClock.elapsedRealtime() - lastConnectedAt >= NowBarPolicy.STOP_AFTER_MS) {
        stopSelf()
        return
      }
      // React Native suspends JS timers when its Activity backgrounds. A
      // native event keeps the live snapshot lease renewed without relying
      // on setInterval, while a dead JS runtime still expires below.
      runCatching { T3NowBarModule.heartbeat?.invoke() }
      if (rows.any { !isReady(it) }) when (NowBarPolicy.freshness(SystemClock.elapsedRealtime() - lastHeartbeat)) {
        "expired" -> {
          rows = rows.filter { isReady(it) }
          if (rows.isEmpty()) stopSelf() else {
            if (wakeLock?.isHeld == true) wakeLock?.release()
            wakeLock = null
            render()
          }
        }
        "stale" -> render(stale = true)
      }
      handler.postDelayed(this, 15_000)
    }
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    createChannels(this)
    lastHeartbeat = SystemClock.elapsedRealtime()
    lastConnectedAt = lastHeartbeat
    handler.postDelayed(watchdog, 15_000)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent == null || !prefs(this).getBoolean("enabled", false) ||
      !NotificationManagerCompat.from(this).areNotificationsEnabled()) {
      stopSelf()
      return START_NOT_STICKY
    }
    try {
      val incoming = JSONArray(intent.getStringExtra("rows") ?: "[]")
      val all = (0 until incoming.length()).map { incoming.getJSONObject(it) }
      val activeKeys = all.map { it.getString("key") }.toSet()
      val suppressed = prefs(this).getStringSet("suppressed", emptySet()).orEmpty().intersect(activeKeys)
      prefs(this).edit().putStringSet("suppressed", suppressed).apply()
      val previousAttention = rows.filter { it.optString("phase") == "attention" || isReady(it) }.map { attentionIdentity(it) }.toSet()
      rows = all.filterNot { it.getString("key") in suppressed }
      if (rows.any { it.optString("phase") != "offline" }) lastConnectedAt = SystemClock.elapsedRealtime()
      rows.firstOrNull { (it.optString("phase") == "attention" || isReady(it)) && attentionIdentity(it) !in previousAttention }
        ?.let { selectedKey = it.getString("key") }
      NowBarAlerts.consume(this, rows)?.let { selectedKey = it.getString("key"); pendingNudge = true }
      lastHeartbeat = SystemClock.elapsedRealtime()
      if (rows.isEmpty()) {
        stopSelf()
      } else {
        render()
        if (rows.all { isReady(it) }) {
          if (wakeLock?.isHeld == true) wakeLock?.release()
          wakeLock = null
        } else if (wakeLock?.isHeld != true) {
          wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:nowbar")
            .apply { acquire(2 * 60 * 60 * 1000L) }
        }
      }
    } catch (_: Exception) {
      stopSelf()
    }
    // A killed process has no authenticated live connection. Do not revive stale data.
    return START_NOT_STICKY
  }

  fun action(action: String) {
    if (action == "dismiss") {
      val key = selectedKey ?: return
      val suppressed = prefs(this).getStringSet("suppressed", emptySet()).orEmpty() + key
      prefs(this).edit().putStringSet("suppressed", suppressed).apply()
      rows = rows.filterNot { it.optString("key") == key }
      if (rows.isEmpty()) stopSelf() else render()
    } else if (action == "unpin") {
      prefs(this).edit().putStringSet("suppressed", rows.map { it.getString("key") }.toSet()).apply()
      stopSelf()
    } else if (action == "refresh") {
      render()
    } else if (action == "next" && rows.isNotEmpty()) {
      val index = rows.indexOfFirst { it.optString("key") == selectedKey }.coerceAtLeast(0)
      selectedKey = rows[(index + 1) % rows.size].getString("key")
      render()
    }
  }

  private fun render(stale: Boolean = false) {
    if (rows.isEmpty()) return
    if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) {
      stopSelf()
      return
    }
    val row = rows.firstOrNull { it.optString("key") == selectedKey } ?: rows.first()
    selectedKey = row.getString("key")
    val ready = isReady(row)
    val phase = if (stale && !ready) "offline" else row.getString("phase")
    val displayPhase = if (phase == "attention" || phase == "working") row.optString("kind").ifEmpty { phase } else phase
    val privateMode = prefs(this).getBoolean("private", false)
    val title = if (privateMode) "T3 Code · Agent work" else row.getString("title")
    val status = when {
      (stale && !ready) || phase == "offline" -> "Connection paused · Open T3 to reconnect"
      privateMode && ready -> "Unread agent result · Open to review"
      privateMode -> if (phase == "attention") "Your agent needs you" else "Agent work in progress"
      else -> row.getString("status")
    }
    val project = if (privateMode) "Private session" else row.optString("project", "T3 Code")
    val color = Color.parseColor(when (displayPhase) {
      "approval", "input" -> "#F4B860"
      "plan" -> "#67D9F5"
      "stopped" -> "#B7A8C9"
      "completed" -> "#40DDB5"
      "error" -> "#FB7185"
      "attention" -> "#F4B860"
      "offline" -> "#94A3B8"
      "monitoring" -> "#40DDB5"
      else -> "#A78BFA"
    })
    val total = if (phase == "offline" || privateMode || ready) 0 else row.optInt("total")
    val completed = row.optInt("completed").coerceIn(0, total.coerceAtLeast(0))
    val chip = NowBarPolicy.chip(displayPhase, rows.size, completed, total)
    val artwork = NowBarBrand.bitmap(this, row.optString("provider"), row.optString("model"))
    val started = row.optLong("startedAt")
    val summary = NowBarPolicy.summary(displayPhase, started, System.currentTimeMillis(), completed, total, rows.size)
    val open = openIntent(this, row.getString("url"))
    val unpin = actionIntent(if (ready) "dismiss" else "unpin")
    val detail = if (rows.size > 1) "$status · ${rows.indexOf(row) + 1}/${rows.size} agents" else status
    val nudge = pendingNudge && !stale
    pendingNudge = false
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.nowbar_pulse)
      .setLargeIcon(artwork)
      .setContentTitle(title)
      .setContentText(summary)
      .setSubText(project)
      .setColor(color)
      .setOngoing(true)
      .setOnlyAlertOnce(!nudge)
      .setSilent(!nudge)
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setContentIntent(open)
      .setDeleteIntent(unpin)
      .setRequestPromotedOngoing(true)
      .setShortCriticalText(chip)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
      .addAction(0, if (phase == "attention" || ready) "Review result" else "Open thread", open)
    if (rows.size > 1) builder.addAction(0, "Next agent", actionIntent("next"))
    builder.addAction(0, if (ready) "Dismiss result" else "Unpin", unpin)
    if (started > 0 && phase != "offline" && phase != "attention" && !ready) {
      builder.setWhen(started).setUsesChronometer(true).setShowWhen(true)
    } else builder.setShowWhen(false)
    if (total > 0) {
      builder.setStyle(NotificationCompat.ProgressStyle()
        .setProgress(if (total > 100) NowBarPolicy.progress(completed, total) ?: 0 else completed)
        .setProgressSegments(List(total.coerceAtMost(100)) { NotificationCompat.ProgressStyle.Segment(1).setColor(color) })
        .setStyledByProgress(true))
    } else {
      builder.setStyle(NotificationCompat.BigTextStyle().bigText("$summary\n$detail"))
    }
    // Keep Android's contentView standard. Samsung renders its own RemoteViews slot.
    if (Build.MANUFACTURER.equals("samsung", ignoreCase = true)) {
      val icon = Icon.createWithResource(this, R.drawable.nowbar_pulse)
      val emblem = Icon.createWithBitmap(artwork)
      builder.addExtras(Bundle().apply {
        val prefix = "android.ongoingActivityNoti."
        putInt(prefix + "style", 1)
        putCharSequence(prefix + "primaryInfo", title)
        putCharSequence(prefix + "secondaryInfo", summary)
        putCharSequence(prefix + "nowbarPrimaryInfo", title)
        putCharSequence(prefix + "nowbarSecondaryInfo", summary)
        putString(prefix + "chipExpandedText", chip)
        putInt(prefix + "chipBgColor", color)
        putParcelable(prefix + "chipIcon", icon)
        putParcelable(prefix + "nowbarIcon", emblem)
        putParcelable(prefix + "firstIcon", emblem)
        putInt(prefix + "actionBgColor", color)
        if (total > 0) {
          putInt(prefix + "progress", NowBarPolicy.progress(completed, total) ?: 0)
          putInt(prefix + "progressMax", 100)
          putInt(prefix + "progressSegments.progressColor", color)
          putParcelableArray(prefix + "progressSegments", Array(total.coerceAtMost(20)) { index ->
            Bundle().apply {
              putInt(prefix + "progressSegments.segmentColor", color)
              putFloat(prefix + "progressSegments.segmentStart", index.toFloat() / total.coerceAtMost(20))
            }
          })
        }
      })
    }
    NowBarComponents.attach(builder, this, title, displayPhase, color, completed, total, rows.size,
      Build.MANUFACTURER.equals("samsung", true) && prefs(this).getBoolean("custom", true),
      row.optString("provider"), if (privateMode) "" else row.optString("model"), detail,
      expandedPreview = prefs(this).getBoolean("expanded", false),
      modelLabel = if (privateMode) "" else row.optString("modelLabel", row.optString("model")),
      secondaryInfo = NowBarPolicy.contextSummary(project, displayPhase, started, System.currentTimeMillis()))
    val publicVersion = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.nowbar_pulse).setContentTitle("T3 Code Now Bar")
      .setContentText(if (ready) "Unread agent result" else if (phase == "attention") "Your agent needs you" else "Agent work in progress")
      .setOngoing(true).build()
    builder.setPublicVersion(publicVersion)
    val notification = builder.build()
    if (!foreground) {
      startForeground(LIVE_ID, notification)
      foreground = true
    } else getSystemService(NotificationManager::class.java).notify(LIVE_ID, notification)
  }

  private fun actionIntent(action: String): PendingIntent = PendingIntent.getBroadcast(
    this, action.hashCode(), Intent(this, NowBarActionReceiver::class.java).setAction(action),
    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
  )

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    if (wakeLock?.isHeld == true) wakeLock?.release()
    wakeLock = null
    instance = null
    stopForeground(STOP_FOREGROUND_REMOVE)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  companion object {
    private fun isReady(row: JSONObject) = row.optString("phase") in listOf("completed", "error", "stopped")
    private fun attentionIdentity(row: JSONObject) = "${row.optString("key")}:${row.optString("phase")}:${row.optString("kind")}"
    const val CHANNEL = "nowbar-live-v2"
    const val RESULTS = "nowbar-results-v2"
    const val LIVE_ID = 76326
    @Volatile var instance: NowBarService? = null
      private set

    private var lastRemoteRows: Pair<String, Long>? = null

    fun refreshRemoteCard(context: Context) {
      val cached = lastRemoteRows ?: return
      val manager = context.getSystemService(NotificationManager::class.java)
      // A preference change must not resurrect an expired or dismissed card.
      if (manager.activeNotifications.none { it.id == LIVE_ID }) return
      receiveRemoteRows(context, cached.first, cached.second)
    }

    private fun createChannels(context: Context) {
      val manager = context.getSystemService(NotificationManager::class.java)
      for ((id, name, oldId) in listOf(Triple(CHANNEL, "Live agent work", "nowbar-live-v1"),
        Triple(RESULTS, "Agent results", "nowbar-results-v1"))) {
        if (manager.getNotificationChannel(id) != null) continue
        val old = manager.getNotificationChannel(oldId)
        // New defaults enable supported nudges, but never undo a user's channel choice.
        val chosenImportance = old != null && (old.importance == NotificationManager.IMPORTANCE_NONE ||
          (Build.VERSION.SDK_INT >= 29 && old.hasUserSetImportance()))
        val chosenSound = old != null && Build.VERSION.SDK_INT >= 30 && old.hasUserSetSound()
        manager.createNotificationChannel(NotificationChannel(id, name,
          if (chosenImportance) old!!.importance else NotificationManager.IMPORTANCE_HIGH).apply {
          enableVibration(true)
          if (old != null && (chosenImportance || chosenSound)) {
            setSound(old.sound, old.audioAttributes)
            vibrationPattern = old.vibrationPattern
            enableVibration(old.shouldVibrate())
          }
        })
      }
    }

    fun prefs(context: Context) = context.getSharedPreferences("t3-nowbar", Context.MODE_PRIVATE)

    /** FCM can post a native card without starting a foreground service or JS. */
    fun receiveRemoteRows(context: Context, json: String, updatedAt: Long) {
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      val prefs = prefs(context)
      if (!prefs.getBoolean("push", false) || instance != null || updatedAt < prefs.getLong("lastPushAt", 0)) return
      val manager = context.getSystemService(NotificationManager::class.java)
      createChannels(context)
      val incoming = runCatching { JSONArray(json) }.getOrNull() ?: return
      lastRemoteRows = json to updatedAt
      val reads = JSONObject(prefs.getString("readTurns", "{}") ?: "{}")
      val suppressed = prefs.getStringSet("suppressed", emptySet()).orEmpty()
      val rows = (0 until incoming.length()).map { incoming.getJSONObject(it) }.filter { row ->
        val key = row.optString("key")
        val identity = runCatching { JSONArray(key) }.getOrNull()
        val alreadyRead = isReady(row) && identity != null && identity.length() == 3 &&
          reads.optString(JSONArray().put(identity.getString(0)).put(identity.getString(1)).toString()) == identity.getString(2)
        key !in suppressed && !alreadyRead
      }
      prefs.edit().putLong("lastPushAt", updatedAt).apply()
      if (rows.isEmpty()) { manager.cancel(LIVE_ID); return }
      val nudgeRow = NowBarAlerts.consume(context, rows)
      val row = nudgeRow ?: rows.first()
      val key = row.getString("key")
      val phase = row.getString("phase")
      val ready = isReady(row)
      val nudge = nudgeRow != null
      if (nudge && !prefs.getBoolean("pushLive", true)) {
        val alertRow = nudgeRow!!
        manager.notify(alertRow.getString("key").hashCode(), NotificationCompat.Builder(context, RESULTS)
          .setSmallIcon(R.drawable.nowbar_pulse)
          .setContentTitle(if (prefs.getBoolean("private", false)) "T3 Code" else alertRow.getString("title"))
          .setContentText(if (alertRow.optString("phase") == "attention") "Your agent needs you" else "Result ready to review")
          .setContentIntent(openIntent(context, alertRow.getString("url")))
          .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setAutoCancel(true).build())
      }
      prefs.edit().putString("remoteRowKey", key).putString("remoteRowPhase", phase).putString("remoteRowKind", row.optString("kind")).apply()
      if (!prefs.getBoolean("pushLive", true)) { manager.cancel(LIVE_ID); return }
      val display = if (phase == "attention" || phase == "working") row.optString("kind").ifEmpty { phase } else phase
      val color = Color.parseColor(when (display) {
        "approval", "input", "attention" -> "#F4B860"
        "plan" -> "#67D9F5"
        "completed", "monitoring" -> "#40DDB5"
        "error" -> "#FB7185"
        "offline", "stopped" -> "#94A3B8"
        else -> "#A78BFA"
      })
      val privateMode = prefs.getBoolean("private", false)
      val total = if (privateMode || ready) 0 else row.optInt("total").coerceAtLeast(0)
      val completed = row.optInt("completed").coerceIn(0, total)
      val title = if (privateMode) "T3 Code · Agent work" else row.getString("title")
      val summary = NowBarPolicy.summary(display, row.optLong("startedAt"), System.currentTimeMillis(), completed, total, rows.size)
      val artwork = NowBarBrand.bitmap(context, row.optString("provider"), row.optString("model"))
      val open = openIntent(context, row.getString("url"))
      val dismiss = PendingIntent.getBroadcast(context, key.hashCode(), Intent(context, NowBarActionReceiver::class.java).setAction("remote-dismiss").putExtra("key", key), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
      val builder = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(R.drawable.nowbar_pulse)
        .setLargeIcon(artwork).setContentTitle(title).setContentText(summary)
        .setStyle(NotificationCompat.BigTextStyle().bigText(if (privateMode) summary else "$summary\n${row.getString("status")}"))
        .setColor(color).setOngoing(true).setOnlyAlertOnce(!nudge).setSilent(!nudge)
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setRequestPromotedOngoing(true)
        .setShortCriticalText(NowBarPolicy.chip(display, rows.size, completed, total))
        .setContentIntent(open).setDeleteIntent(dismiss)
        .addAction(0, if (ready || phase == "attention") "Review" else "Open thread", open)
        .addAction(0, "Dismiss", dismiss)
      // Match the foreground card: a pushed step count draws the same segmented bar.
      if (total > 0) builder.setStyle(NotificationCompat.ProgressStyle()
        .setProgress(if (total > 100) NowBarPolicy.progress(completed, total) ?: 0 else completed)
        .setProgressSegments(List(total.coerceAtMost(100)) { NotificationCompat.ProgressStyle.Segment(1).setColor(color) })
        .setStyledByProgress(true))
      if (!ready) builder.setTimeoutAfter(NowBarPolicy.STOP_AFTER_MS)
      if (!ready && phase != "attention" && row.optLong("startedAt") > 0)
        builder.setWhen(row.optLong("startedAt")).setUsesChronometer(true)
      if (Build.MANUFACTURER.equals("samsung", true)) builder.addExtras(Bundle().apply {
        val prefix = "android.ongoingActivityNoti."
        putInt(prefix + "style", 1)
        putString(prefix + "nowbarPrimaryInfo", title)
        putString(prefix + "nowbarSecondaryInfo", summary)
        putParcelable(prefix + "nowbarIcon", Icon.createWithBitmap(artwork))
        putInt(prefix + "chipBgColor", color)
        putString(prefix + "chipExpandedText", NowBarPolicy.chip(display, rows.size, completed, total))
      })
      NowBarComponents.attach(builder, context, title, display, color, completed, total, rows.size,
        Build.MANUFACTURER.equals("samsung", true) && prefs.getBoolean("custom", true),
        row.optString("provider"), if (privateMode) "" else row.optString("model"), if (privateMode) summary else row.getString("status"),
        expandedPreview = prefs.getBoolean("expanded", false),
        modelLabel = if (privateMode) "" else row.optString("modelLabel", row.optString("model")),
        secondaryInfo = NowBarPolicy.contextSummary(if (privateMode) "Private session" else row.optString("project", "T3 Code"),
          display, row.optLong("startedAt"), System.currentTimeMillis()))
      manager.notify(LIVE_ID, builder.build())
    }

    fun openIntent(context: Context, url: String): PendingIntent {
      require(url.startsWith("t3code-nowbar://threads/"))
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)!!
        .setAction(Intent.ACTION_VIEW).setData(Uri.parse(url))
        .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(context, url.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun result(context: Context, json: String) {
      if (!prefs(context).getBoolean("enabled", false) || !prefs(context).getBoolean("results", true)) return
      if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
      val row = JSONObject(json)
      if (row.getString("key") in prefs(context).getStringSet("suppressed", emptySet()).orEmpty()) return
      val privateMode = prefs(context).getBoolean("private", false)
      val notification = NotificationCompat.Builder(context, RESULTS)
        .setSmallIcon(R.drawable.nowbar_pulse)
        .setContentTitle(if (privateMode) "T3 Code" else row.getString("title"))
        .setContentText(row.getString("status"))
        .setColor(Color.parseColor(if (row.optString("phase") == "error") "#FB7185" else "#40DDB5"))
        .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
        .setContentIntent(openIntent(context, row.getString("url")))
        .setAutoCancel(true).setTimeoutAfter(120_000).build()
      context.getSystemService(NotificationManager::class.java).notify(row.getString("key").hashCode(), notification)
    }
  }
}

class NowBarActionReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == "debug-clear") { NowBarDebug.clear(context); return }
    if (intent.action == "debug-next") { NowBarDebug.next(context); return }
    if (intent.action == "remote-dismiss") {
      val key = intent.getStringExtra("key") ?: return
      val prefs = NowBarService.prefs(context)
      prefs.edit().putStringSet("suppressed", prefs.getStringSet("suppressed", emptySet()).orEmpty() + key).apply()
      if (prefs.getString("remoteRowKey", null) == key) context.getSystemService(NotificationManager::class.java).cancel(NowBarService.LIVE_ID)
      return
    }
    NowBarService.instance?.action(intent.action ?: return)
  }
}
