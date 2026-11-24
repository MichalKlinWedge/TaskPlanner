package expo.modules.taskalarm

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray

class TaskAlarmModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("TaskAlarm")

    /** JSON `{ scheduled, ringing, actions }`. */
    Function("state") { Alarms.state(context) }

    /** JSON — lista `AlarmEntry`; ten sam `id` zastępuje poprzedni. */
    Function("schedule") { entries: String ->
      val list = JSONArray(entries)
      for (i in 0 until list.length()) Alarms.schedule(context, AlarmEntry(list.getJSONObject(i)))
    }

    Function("cancel") { ids: List<String> -> ids.forEach { Alarms.cancel(context, it) } }

    Function("dismiss") { ids: List<String> -> ids.forEach { Alarms.dismiss(context, it) } }

    Function("ackAction") { key: String -> AlarmStore.ackAction(context, key) }

    Function("canFullScreen") { Alarms.canFullScreen(context) }

    Function("openFullScreenSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        context.startActivity(
          Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }
    }
  }
}
