package expo.modules.taskalarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Chwila alarmu, koniec dzwonienia i przyciski powiadomienia. */
class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(Alarms.EXTRA_ID) ?: return
    when (intent.action) {
      Alarms.FIRE -> Alarms.fire(context, id)
      Alarms.SILENCE -> Alarms.silence(context, id)
      Alarms.COMPLETE -> Alarms.complete(context, id)
      Alarms.SNOOZE -> Alarms.snooze(context, id)
      Alarms.DISMISS -> Alarms.dismiss(context, id)
    }
  }
}

/** Restart telefonu i aktualizacja aplikacji kasują alarmy systemowe. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED -> Alarms.restore(context, rebooted = true)
      Intent.ACTION_MY_PACKAGE_REPLACED -> Alarms.restore(context, rebooted = true)
      "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" -> Alarms.restore(context, rebooted = false)
    }
  }
}
