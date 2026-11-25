package expo.modules.taskalarm

import android.app.ActivityManager
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Alarmy przypomnień: planowanie w AlarmManager, dzwonienie (powiadomienie z pełnoekranową intencją i dźwiękiem
 * alarmu w pętli), „Czekaj” i „Zakończ”. Wszystko poza zapisem ukończenia działa bez JS.
 */
object Alarms {
  const val FIRE = "expo.modules.taskalarm.FIRE"
  const val SILENCE = "expo.modules.taskalarm.SILENCE"
  const val COMPLETE = "expo.modules.taskalarm.COMPLETE"
  const val SNOOZE = "expo.modules.taskalarm.SNOOZE"
  const val DISMISS = "expo.modules.taskalarm.DISMISS"
  const val SHOW = "expo.modules.taskalarm.SHOW"
  const val EDIT = "expo.modules.taskalarm.EDIT"
  const val EXTRA_ID = "id"

  // Dźwięku kanału nie da się zmienić po utworzeniu — zmiana = nowy identyfikator.
  private const val RING_CHANNEL = "task-alarm"
  private const val QUIET_CHANNEL = "task-alarm-quiet"
  private const val NOTIFICATION_ID = 7401
  private const val SNOOZE_PREFIX = "s_"

  /** Tyle dzwoni bez odpowiedzi; potem zostaje ciche powiadomienie z tymi samymi przyciskami. */
  private const val RING_MS = 2 * 60_000L

  /** Otwarta plansza odświeża się po każdej zmianie listy dzwoniących. */
  val listeners = CopyOnWriteArraySet<() -> Unit>()
  private val main = Handler(Looper.getMainLooper())
  private fun changed() {
    main.post { listeners.forEach { it() } }
  }

  private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)
  private fun alarmManager(context: Context) = context.getSystemService(AlarmManager::class.java)

  // ── Planowanie ────────────────────────────────────────────────────────────────────────────

  /** Intencje różnią się adresem (`data`) — ta sama akcja i id zastępuje poprzednią. */
  private fun uri(id: String): Uri = Uri.fromParts("taskalarm", id, null)

  private fun broadcast(context: Context, action: String, id: String): PendingIntent =
    PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, AlarmReceiver::class.java).setAction(action).setData(uri(id)).putExtra(EXTRA_ID, id),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

  fun activityIntent(context: Context, action: String, id: String): Intent =
    Intent(context, AlarmActivity::class.java).setAction(action).setData(uri(id)).putExtra(EXTRA_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  private fun activity(context: Context, action: String, id: String): PendingIntent =
    PendingIntent.getActivity(context, 0, activityIntent(context, action, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

  fun canScheduleExact(context: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager(context).canScheduleExactAlarms()

  private fun arm(context: Context, entry: AlarmEntry) {
    val fire = broadcast(context, FIRE, entry.id)
    val alarms = alarmManager(context)
    if (canScheduleExact(context)) {
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)
      val show = open?.let { PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE) }
      // setAlarmClock: dokładnie co do sekundy, także w głębokim Doze (jak budzik).
      alarms.setAlarmClock(AlarmManager.AlarmClockInfo(entry.at, show), fire)
    } else {
      alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, entry.at, fire)
    }
  }

  fun schedule(context: Context, entry: AlarmEntry) {
    AlarmStore.putScheduled(context, entry)
    arm(context, entry)
  }

  /** Odwołanie zaplanowanego; alarm, który zdążył zadzwonić, nie jest już zaplanowany i zostaje. */
  fun cancel(context: Context, id: String) {
    if (AlarmStore.takeScheduled(context, id) != null) alarmManager(context).cancel(broadcast(context, FIRE, id))
  }

  /** Po restarcie telefonu / aktualizacji: alarmy od nowa, a te, które minęły w międzyczasie — cicho. */
  fun restore(context: Context, rebooted: Boolean) {
    val now = System.currentTimeMillis()
    for (entry in AlarmStore.scheduled(context)) {
      if (entry.at > now) arm(context, entry)
      else if (AlarmStore.takeScheduled(context, entry.id) != null) quietly(context, entry)
    }
    // Restart zamyka powiadomienia, a czekające na decyzję nie mogą zniknąć bez śladu.
    if (rebooted) AlarmStore.ringing(context).forEach { quietly(context, it) }
  }

  // ── Dzwonienie ────────────────────────────────────────────────────────────────────────────

  fun fire(context: Context, id: String) {
    // Przeplanowany na później albo odwołany, zanim ta chwila dotarła.
    val entry = AlarmStore.takeScheduled(context, id) { it.at <= System.currentTimeMillis() + 5_000 } ?: return
    entry.quiet = false
    AlarmStore.putRinging(context, entry)
    notify(context, entry)
    val silence = broadcast(context, SILENCE, id)
    val until = System.currentTimeMillis() + RING_MS
    if (canScheduleExact(context)) alarmManager(context).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, silence)
    else alarmManager(context).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, silence)
    // Przy używanej innej aplikacji Android pokaże plakietkę z przyciskami; nad własną aplikacją plansza otwiera się od razu.
    val process = ActivityManager.RunningAppProcessInfo().also { ActivityManager.getMyMemoryState(it) }
    if (process.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND) {
      try {
        context.startActivity(activityIntent(context, SHOW, id))
      } catch (e: Exception) {
        // Zostaje powiadomienie.
      }
    }
    changed()
  }

  private fun quietly(context: Context, entry: AlarmEntry) {
    entry.quiet = true
    AlarmStore.putRinging(context, entry)
    notify(context, entry)
    changed()
  }

  /** Koniec dzwonienia bez decyzji (limit czasu, klawisz głośności, „Edytuj” na zablokowanym ekranie). */
  fun silence(context: Context, id: String) {
    val entry = AlarmStore.ringing(context, id) ?: return
    alarmManager(context).cancel(broadcast(context, SILENCE, id))
    if (!entry.quiet) quietly(context, entry)
  }

  private fun close(context: Context, id: String): AlarmEntry? {
    val entry = AlarmStore.takeRinging(context, id) ?: return null
    alarmManager(context).cancel(broadcast(context, SILENCE, id))
    manager(context).cancel(id, NOTIFICATION_ID)
    changed()
    return entry
  }

  fun dismiss(context: Context, id: String) {
    close(context, id)
  }

  /** „Czekaj”: ten sam alarm za `snoozeMin` — stały identyfikator, więc powtórzone kliknięcie go nie dubluje. */
  fun snooze(context: Context, id: String) {
    val entry = close(context, id)?.copy() ?: return
    entry.json
      .put("id", if (id.startsWith(SNOOZE_PREFIX)) id else SNOOZE_PREFIX + id)
      .put("at", System.currentTimeMillis() + entry.snoozeMin * 60_000L)
      .put("snoozed", true)
      .put("quiet", false)
    schedule(context, entry)
  }

  /** „Zakończ”: do kolejki (nie zginie, gdy JS nie ruszy), potem JS w tle zapisuje ukończenie. */
  fun complete(context: Context, id: String) {
    val entry = close(context, id) ?: return
    if (entry.taskId.isEmpty()) return
    AlarmStore.addAction(context, entry)
    val work = OneTimeWorkRequest.Builder(AlarmActionWorker::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    WorkManager.getInstance(context).enqueueUniqueWork("task-alarm-actions", ExistingWorkPolicy.APPEND_OR_REPLACE, work.build())
  }

  // ── Powiadomienie ─────────────────────────────────────────────────────────────────────────

  private fun ensureChannels(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val ring = NotificationChannel(RING_CHANNEL, "Alarmy zadań", NotificationManager.IMPORTANCE_HIGH)
    ring.description = "Przypomnienia w trybie alarmu na cały ekran"
    ring.setSound(
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
      AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
    )
    ring.enableVibration(true)
    ring.vibrationPattern = longArrayOf(0, 600, 400, 600, 1000)
    ring.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    val quiet = NotificationChannel(QUIET_CHANNEL, "Alarmy bez odpowiedzi", NotificationManager.IMPORTANCE_LOW)
    quiet.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
    manager(context).createNotificationChannels(listOf(ring, quiet))
  }

  private fun notify(context: Context, entry: AlarmEntry) {
    ensureChannels(context)
    val id = entry.id
    val text = listOf(entry.line, entry.description).filter { it.isNotBlank() }.joinToString("\n")
    val show = activity(context, SHOW, id)
    val builder = NotificationCompat.Builder(context, if (entry.quiet) QUIET_CHANNEL else RING_CHANNEL)
      .setSmallIcon(R.drawable.task_alarm_icon)
      .setContentTitle(entry.title)
      .setContentText(entry.line)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(if (entry.quiet) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setWhen(entry.at)
      .setShowWhen(true)
      .setOngoing(true)
      .setAutoCancel(false)
      .setContentIntent(show)
      .setDeleteIntent(broadcast(context, DISMISS, id))
      .addAction(0, "Zakończ", broadcast(context, COMPLETE, id))
      .addAction(0, "Edytuj", activity(context, EDIT, id))
      .addAction(0, "Czekaj ${entry.snoozeMin} min", broadcast(context, SNOOZE, id))
    if (!entry.quiet) builder.setFullScreenIntent(show, true)
    val notification = builder.build()
    // Dźwięk i wibracja w pętli, dopóki powiadomienie dzwoni.
    if (!entry.quiet) notification.flags = notification.flags or Notification.FLAG_INSISTENT
    try {
      manager(context).notify(id, NOTIFICATION_ID, notification)
    } catch (e: SecurityException) {
      // Bez zgody na powiadomienia nie ma czego pokazać (ustawienia mówią o tym wprost).
    }
  }

  fun canFullScreen(context: Context) = Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || manager(context).canUseFullScreenIntent()

  fun state(context: Context): String = JSONObject()
    .put("scheduled", org.json.JSONArray(AlarmStore.scheduled(context).map { it.json }))
    .put("ringing", org.json.JSONArray(AlarmStore.ringing(context).map { it.json }))
    .put("actions", AlarmStore.actions(context))
    .toString()
}
