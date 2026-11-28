package expo.modules.quickcapture

import android.content.Context
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class QuickCaptureModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("QuickCapture")

    /** JSON — lista `{ key, text, at }` czekających na zapis. */
    Function("pending") { QuickCaptureStore.all(context) }

    Function("ack") { key: String -> QuickCaptureStore.ack(context, key) }
  }
}
