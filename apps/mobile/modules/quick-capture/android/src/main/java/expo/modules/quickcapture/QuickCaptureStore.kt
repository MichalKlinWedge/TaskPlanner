package expo.modules.quickcapture

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Kolejka wpisów z okna szybkiego dodawania (SharedPreferences `quick_capture`): `{ key, text, at }`. Wpis znika
 * dopiero, gdy JS zapisze zadanie do lokalnej bazy (`ack`) — nie zginie, gdy proces zniknie przed zapisem.
 */
object QuickCaptureStore {
  private const val ENTRIES = "entries"

  private fun prefs(context: Context): SharedPreferences = context.applicationContext.getSharedPreferences("quick_capture", Context.MODE_PRIVATE)

  private fun read(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(ENTRIES, "[]"))
    } catch (e: Exception) {
      JSONArray()
    }

  // commit(): okno i proces mogą zaraz zniknąć.
  private fun write(context: Context, list: JSONArray) {
    prefs(context).edit().putString(ENTRIES, list.toString()).commit()
  }

  @Synchronized
  fun add(context: Context, text: String) {
    val list = read(context)
    list.put(JSONObject().put("key", UUID.randomUUID().toString()).put("text", text).put("at", System.currentTimeMillis()))
    write(context, list)
  }

  @Synchronized
  fun all(context: Context): String = read(context).toString()

  @Synchronized
  fun ack(context: Context, key: String) {
    val list = read(context)
    val rest = JSONArray()
    for (i in 0 until list.length()) list.optJSONObject(i)?.takeIf { it.optString("key") != key }?.let { rest.put(it) }
    write(context, rest)
  }
}
