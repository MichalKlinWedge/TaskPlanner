package expo.modules.taskalarm

import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextClock
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.max

/**
 * Plansza alarmu nad ekranem blokady: zegar, tytuł, opis i „Zakończ” / „Edytuj” / „Czekaj N min”. Bez JS — widać ją
 * od razu po wybudzeniu telefonu. Kilka alarmów naraz pokazuje po kolei.
 */
class AlarmActivity : Activity() {
  private var currentId: String? = null
  private val onChange: () -> Unit = { render() }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    Alarms.listeners.add(onChange)
    handle(intent)
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handle(intent)
  }

  override fun onDestroy() {
    Alarms.listeners.remove(onChange)
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    render()
  }

  private fun handle(intent: Intent) {
    currentId = intent.getStringExtra(Alarms.EXTRA_ID)
    render()
    if (intent.action == Alarms.EDIT) currentId?.let { edit(it) }
  }

  /** Klawisze głośności tylko wyciszają — plansza zostaje. */
  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_VOLUME_UP || keyCode == KeyEvent.KEYCODE_VOLUME_DOWN) {
      currentId?.let { Alarms.silence(this, it) }
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  private fun edit(id: String) {
    val entry = AlarmStore.ringing(this, id) ?: return
    // Najpierw cisza; alarm znika dopiero po odblokowaniu, żeby anulowany PIN nie zgubił przypomnienia.
    Alarms.silence(this, id)
    val open = {
      Alarms.dismiss(this, id)
      val path = when {
        entry.taskId.isEmpty() -> "/"
        entry.habit -> "habit-form?id=${Uri.encode(entry.taskId)}"
        else -> "task/${Uri.encode(entry.taskId)}"
      }
      startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("taskplanner://$path")).setPackage(packageName).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    val keyguard = getSystemService(KeyguardManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && keyguard.isKeyguardLocked) {
      keyguard.requestDismissKeyguard(
        this,
        object : KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() {
            open()
          }
        },
      )
    } else {
      open()
    }
  }

  // ── Widok ─────────────────────────────────────────────────────────────────────────────────

  private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

  private fun text(value: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
    text = value
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    setTextColor(color)
    if (bold) typeface = Typeface.DEFAULT_BOLD
  }

  private fun button(label: String, background: Int, color: Int, onClick: () -> Unit) = text(label, 19f, color, bold = true).apply {
    gravity = Gravity.CENTER
    minHeight = dp(64)
    setPadding(dp(12), dp(12), dp(12), dp(12))
    val shape = GradientDrawable().apply {
      cornerRadius = dp(16).toFloat()
      setColor(background)
    }
    this.background = RippleDrawable(ColorStateList.valueOf(0x33888888), shape, null)
    isClickable = true
    isFocusable = true
    contentDescription = label
    ViewCompat.setAccessibilityDelegate(
      this,
      object : androidx.core.view.AccessibilityDelegateCompat() {
        override fun onInitializeAccessibilityNodeInfo(host: View, info: androidx.core.view.accessibility.AccessibilityNodeInfoCompat) {
          super.onInitializeAccessibilityNodeInfo(host, info)
          info.className = "android.widget.Button"
        }
      },
    )
    setOnClickListener { onClick() }
  }

  private fun render() {
    if (isFinishing) return
    val ringing = AlarmStore.ringing(this)
    val entry = ringing.find { it.id == currentId } ?: ringing.firstOrNull()
    if (entry == null) {
      finishAndRemoveTask()
      return
    }
    currentId = entry.id
    if (entry.quiet) window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) else window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    val bg = Color.parseColor(if (dark) "#09090B" else "#FAFAFA")
    val fg = Color.parseColor(if (dark) "#FAFAFA" else "#18181B")
    val muted = Color.parseColor(if (dark) "#A1A1AA" else "#52525B")
    val soft = Color.parseColor(if (dark) "#27272A" else "#E4E4E7")

    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setBackgroundColor(bg)
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val side = dp(24)
      view.setPadding(max(side, bars.left), bars.top + dp(24), max(side, bars.right), bars.bottom + dp(20))
      insets
    }

    val clock = TextClock(this).apply {
      format24Hour = "HH:mm"
      format12Hour = "h:mm a"
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 52f)
      setTextColor(fg)
    }
    root.addView(clock, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
    val more = if (ringing.size > 1) " · jeszcze ${ringing.size - 1}" else ""
    root.addView(text((if (entry.quiet) "Przypomnienie bez odpowiedzi" else "Przypomnienie") + more, 15f, muted))

    val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    content.addView(text(entry.title, 30f, fg, bold = true).apply { setPadding(0, dp(24), 0, dp(8)) })
    if (entry.line.isNotBlank()) content.addView(text(entry.line, 17f, muted))
    if (entry.description.isNotBlank()) {
      content.addView(text(entry.description, 18f, fg).apply {
        setPadding(0, dp(20), 0, dp(12))
        setLineSpacing(0f, 1.15f)
      })
    }
    root.addView(ScrollView(this).apply { addView(content) }, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))

    val id = entry.id
    val gap = dp(12)
    root.addView(
      button("Zakończ", Color.parseColor("#4F46E5"), Color.WHITE) { Alarms.complete(this, id) },
      LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = gap },
    )
    val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
    row.addView(button("Edytuj", soft, fg) { edit(id) }, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f).apply { marginEnd = gap })
    row.addView(button("Czekaj ${entry.snoozeMin} min", soft, fg) { Alarms.snooze(this, id) }, LinearLayout.LayoutParams(0, MATCH_PARENT, 1f))
    root.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = gap })

    setContentView(root)
    ViewCompat.requestApplyInsets(root)
  }
}
