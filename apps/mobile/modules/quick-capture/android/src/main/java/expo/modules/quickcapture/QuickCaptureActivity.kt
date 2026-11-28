package expo.modules.quickcapture

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Bundle
import android.speech.RecognizerIntent
import android.text.InputFilter
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import java.util.Locale
import kotlin.math.max

/**
 * Szybkie dodawanie bez otwierania aplikacji (widżet „Szybkie dodawanie”): pole tekstowe nad ekranem głównym albo
 * od razu systemowe rozpoznawanie mowy (`taskplanner-capture://voice`). Tekst trafia do kolejki (`QuickCaptureStore`),
 * a zadanie do Inbox zapisuje JS w tle (`QuickCaptureWorker` → `TaskQuickCapture`) — tą samą gramatyką co w aplikacji.
 */
class QuickCaptureActivity : Activity() {
  private var field: EditText? = null
  /** Z mikrofonu widżetu: bez okna, rozpoznany tekst od razu do Inbox. */
  private var voiceOnly = false

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    WindowCompat.setDecorFitsSystemWindows(window, false)
    window.setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
    if (savedInstanceState == null) handle(intent) else render()
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handle(intent)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val text = field?.text?.toString().orEmpty()
    render()
    field?.setText(text)
    field?.setSelection(text.length)
  }

  private fun handle(intent: Intent) {
    voiceOnly = intent.data?.host == "voice"
    render()
    if (voiceOnly) listen()
  }

  // ── Mowa ──────────────────────────────────────────────────────────────────────────────────

  private fun listen() {
    val speech = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
      .putExtra(RecognizerIntent.EXTRA_PROMPT, "Powiedz zadanie")
      .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
    try {
      @Suppress("DEPRECATION")
      startActivityForResult(speech, SPEECH)
    } catch (e: ActivityNotFoundException) {
      Toast.makeText(this, "Brak rozpoznawania mowy w telefonie — wpisz zadanie", Toast.LENGTH_LONG).show()
      voiceOnly = false
      render()
    }
  }

  @Deprecated("Activity bez AndroidX — wynik rozpoznawania mowy")
  override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
    @Suppress("DEPRECATION")
    super.onActivityResult(requestCode, resultCode, data)
    if (requestCode != SPEECH) return
    val heard = if (resultCode == RESULT_OK) data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()?.trim().orEmpty() else ""
    if (voiceOnly) {
      if (heard.isNotEmpty()) save(heard) else close()
      return
    }
    val input = field ?: return
    if (heard.isNotEmpty()) {
      val before = input.text.toString().trimEnd()
      val text = if (before.isEmpty()) heard else "$before $heard"
      input.setText(text)
      input.setSelection(text.length)
    }
    showKeyboard(input)
  }

  // ── Zapis ─────────────────────────────────────────────────────────────────────────────────

  private fun save(raw: String) {
    val text = raw.trim()
    if (text.isEmpty()) return
    QuickCaptureStore.add(this, text)
    QuickCaptureWorker.enqueue(this)
    Toast.makeText(this, "Dodano do Inbox: $text", Toast.LENGTH_SHORT).show()
    close()
  }

  private fun close() {
    field?.let { WindowCompat.getInsetsController(window, it).hide(WindowInsetsCompat.Type.ime()) }
    finishAndRemoveTask()
  }

  // ── Widok ─────────────────────────────────────────────────────────────────────────────────

  private fun dp(value: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

  private fun pill(label: String, description: String, background: Int, color: Int, onClick: () -> Unit) = TextView(this).apply {
    text = label
    contentDescription = description
    setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
    setTextColor(color)
    typeface = Typeface.DEFAULT_BOLD
    gravity = Gravity.CENTER
    minWidth = dp(48)
    minHeight = dp(48)
    setPadding(dp(14), 0, dp(14), 0)
    val shape = GradientDrawable().apply {
      cornerRadius = dp(24).toFloat()
      setColor(background)
    }
    this.background = RippleDrawable(ColorStateList.valueOf(0x33888888), shape, null)
    isClickable = true
    isFocusable = true
    setOnClickListener { onClick() }
  }

  private fun showKeyboard(input: EditText) {
    input.requestFocus()
    input.post { WindowCompat.getInsetsController(window, input).show(WindowInsetsCompat.Type.ime()) }
  }

  private fun render() {
    if (voiceOnly) {
      // Tylko systemowe okno mowy; pod spodem nic.
      field = null
      setContentView(View(this))
      return
    }
    val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    val card = Color.parseColor(if (dark) "#18181B" else "#FFFFFF")
    val fg = Color.parseColor(if (dark) "#FAFAFA" else "#18181B")
    val muted = Color.parseColor(if (dark) "#A1A1AA" else "#71717A")
    val soft = Color.parseColor(if (dark) "#27272A" else "#F4F4F5")
    val accent = Color.parseColor("#4F46E5")

    val root = FrameLayout(this).apply {
      setBackgroundColor(0x66000000)
      setOnClickListener { close() }
    }
    val sheet = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply {
        val r = dp(24).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(card)
      }
      isClickable = true
    }
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      sheet.setPadding(max(dp(16), bars.left), dp(16), max(dp(16), bars.right), max(ime.bottom, bars.bottom) + dp(16))
      insets
    }

    sheet.addView(TextView(this).apply {
      text = "Nowe zadanie → Inbox"
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setTextColor(muted)
      setPadding(dp(4), 0, 0, dp(10))
    })

    val input = EditText(this).apply {
      hint = "np. Zadzwonić do Jana jutro o 10"
      setHintTextColor(muted)
      setTextColor(fg)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
      imeOptions = EditorInfo.IME_ACTION_DONE or EditorInfo.IME_FLAG_NO_EXTRACT_UI
      setImeActionLabel("Dodaj", EditorInfo.IME_ACTION_DONE)
      filters = arrayOf(InputFilter.LengthFilter(500))
      isSingleLine = true
      minHeight = dp(48)
      setPadding(dp(16), 0, dp(16), 0)
      background = GradientDrawable().apply {
        cornerRadius = dp(24).toFloat()
        setColor(soft)
      }
      setOnEditorActionListener { view, action, _ ->
        if (action == EditorInfo.IME_ACTION_DONE) save(view.text.toString())
        true
      }
    }
    field = input

    val row = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
    }
    row.addView(input, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
    row.addView(pill("🎤", "Podyktuj zadanie", soft, fg) { listen() }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(8) })
    row.addView(pill("Dodaj", "Dodaj zadanie", accent, Color.WHITE) { save(input.text.toString()) }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply { marginStart = dp(8) })
    sheet.addView(row, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))

    root.addView(sheet, FrameLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT, Gravity.BOTTOM))
    setContentView(root)
    showKeyboard(input)
  }

  private companion object {
    const val SPEECH = 1
  }
}
