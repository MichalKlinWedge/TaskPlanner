package expo.modules.taskalarm

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/** Wpis alarmu z JS (`AlarmEntry` w core) — trzymany jako JSON, żeby nowe pola przechodziły bez zmian tutaj. */
class AlarmEntry(val json: JSONObject) {
  val id: String get() = json.getString("id")
  val taskId: String get() = json.optString("taskId")
  val at: Long get() = json.getLong("at")
  val title: String get() = json.optString("title")
  val description: String get() = json.optString("description")
  val habit: Boolean get() = json.optBoolean("habit")
  val snoozed: Boolean get() = json.optBoolean("snoozed")
  val snoozeMin: Int get() = json.optInt("snoozeMin", 15).coerceIn(1, 24 * 60)

  /** Wiersz pod tytułem; po „Czekaj” bez względnego czasu, który już minął. */
  val line: String get() = json.optString(if (snoozed) "snoozedBody" else "body")

  /** Już nie dzwoni (minął czas dzwonienia albo wyciszony) — czeka na decyzję. */
  var quiet: Boolean
    get() = json.optBoolean("quiet")
    set(value) {
      json.put("quiet", value)
    }

  fun copy() = AlarmEntry(JSONObject(json.toString()))
}

/**
 * Stan alarmów w SharedPreferences — działa bez JS i przeżywa restart telefonu: zaplanowane, dzwoniące (albo
 * czekające na decyzję) i kolejka „Zakończ”, którą zapisuje do bazy dopiero JS.
 */
object AlarmStore {
  private const val SCHEDULED = "scheduled"
  private const val RINGING = "ringing"
  private const val ACTIONS = "actions"

  private fun prefs(context: Context): SharedPreferences = context.applicationContext.getSharedPreferences("task_alarms", Context.MODE_PRIVATE)

  private fun read(context: Context, key: String): LinkedHashMap<String, AlarmEntry> {
    val out = LinkedHashMap<String, AlarmEntry>()
    try {
      val list = JSONArray(prefs(context).getString(key, "[]"))
      for (i in 0 until list.length()) AlarmEntry(list.getJSONObject(i)).let { out[it.id] = it }
    } catch (e: Exception) {
      // Uszkodzony zapis: pusto; przeplanowanie z JS wypełni go od nowa.
    }
    return out
  }

  // commit(): odbiornik i proces mogą zaraz zniknąć.
  private fun write(context: Context, key: String, entries: Collection<AlarmEntry>) {
    prefs(context).edit().putString(key, JSONArray(entries.map { it.json }).toString()).commit()
  }

  @Synchronized
  fun scheduled(context: Context): List<AlarmEntry> = read(context, SCHEDULED).values.toList()

  @Synchronized
  fun ringing(context: Context): List<AlarmEntry> = read(context, RINGING).values.toList()

  @Synchronized
  fun ringing(context: Context, id: String): AlarmEntry? = read(context, RINGING)[id]

  @Synchronized
  fun putScheduled(context: Context, entry: AlarmEntry) {
    val all = read(context, SCHEDULED)
    all[entry.id] = entry
    write(context, SCHEDULED, all.values)
  }

  /** Usuwa zaplanowany, jeśli `accept` (sprawdzane pod tą samą blokadą). */
  @Synchronized
  fun takeScheduled(context: Context, id: String, accept: (AlarmEntry) -> Boolean = { true }): AlarmEntry? {
    val all = read(context, SCHEDULED)
    val entry = all[id] ?: return null
    if (!accept(entry)) return null
    all.remove(id)
    write(context, SCHEDULED, all.values)
    return entry
  }

  @Synchronized
  fun putRinging(context: Context, entry: AlarmEntry) {
    val all = read(context, RINGING)
    all[entry.id] = entry
    write(context, RINGING, all.values)
  }

  @Synchronized
  fun takeRinging(context: Context, id: String): AlarmEntry? {
    val all = read(context, RINGING)
    val entry = all.remove(id) ?: return null
    write(context, RINGING, all.values)
    return entry
  }

  @Synchronized
  fun actions(context: Context): JSONArray =
    try {
      JSONArray(prefs(context).getString(ACTIONS, "[]"))
    } catch (e: Exception) {
      JSONArray()
    }

  @Synchronized
  fun addAction(context: Context, entry: AlarmEntry) {
    val now = System.currentTimeMillis()
    val action = JSONObject()
      .put("key", "${entry.id}:$now")
      .put("taskId", entry.taskId)
      .put("occurrenceDate", entry.json.opt("occurrenceDate") ?: JSONObject.NULL)
      .put("habit", entry.habit)
      .put("at", now)
    prefs(context).edit().putString(ACTIONS, actions(context).put(action).toString()).commit()
  }

  @Synchronized
  fun ackAction(context: Context, key: String) {
    val rest = JSONArray()
    val all = actions(context)
    for (i in 0 until all.length()) all.getJSONObject(i).let { if (it.optString("key") != key) rest.put(it) }
    prefs(context).edit().putString(ACTIONS, rest.toString()).commit()
  }
}
