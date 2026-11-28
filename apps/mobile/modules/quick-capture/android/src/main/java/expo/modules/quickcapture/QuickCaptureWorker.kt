package expo.modules.quickcapture

import android.content.Context
import android.os.Build
import androidx.concurrent.futures.CallbackToFutureAdapter
import androidx.work.ExistingWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.OneTimeWorkRequest
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.jstasks.HeadlessJsTaskEventListener
import com.google.common.util.concurrent.ListenableFuture

/**
 * Uruchamia JS bez ekranu (zadanie `TaskQuickCapture`), które zapisuje kolejkę do Inbox i wysyła ją na serwer.
 * Niezapisane zostają w kolejce do następnego startu aplikacji. Wzór: `AlarmActionWorker` (moduł task-alarm).
 */
class QuickCaptureWorker(context: Context, params: WorkerParameters) : ListenableWorker(context, params), HeadlessJsTaskEventListener {
  private var taskId = -1
  private var completer: CallbackToFutureAdapter.Completer<Result>? = null

  private val reactHost: ReactHost?
    get() = (applicationContext as? ReactApplication)?.reactHost

  override fun startWork(): ListenableFuture<Result> =
    CallbackToFutureAdapter.getFuture { c ->
      completer = c
      val host = reactHost
      val current = host?.currentReactContext
      when {
        host == null -> c.set(Result.failure())
        current != null -> start(current)
        else -> {
          host.addReactInstanceEventListener(
            object : ReactInstanceEventListener {
              override fun onReactContextInitialized(context: ReactContext) {
                start(context)
                host.removeReactInstanceEventListener(this)
              }
            },
          )
          host.start()
        }
      }
      "quick-capture"
    }

  private fun start(context: ReactContext) {
    UiThreadUtil.runOnUiThread {
      val headless = HeadlessJsTaskContext.getInstance(context)
      headless.addTaskEventListener(this)
      taskId = headless.startTask(HeadlessJsTaskConfig("TaskQuickCapture", Arguments.createMap(), 60_000, true))
    }
  }

  private fun cleanUp() {
    reactHost?.currentReactContext?.let { HeadlessJsTaskContext.getInstance(it).removeTaskEventListener(this) }
  }

  override fun onStopped() {
    super.onStopped()
    cleanUp()
  }

  override fun onHeadlessJsTaskStart(taskId: Int) = Unit

  override fun onHeadlessJsTaskFinish(taskId: Int) {
    if (taskId != this.taskId) return
    completer?.set(Result.success())
    cleanUp()
  }

  companion object {
    fun enqueue(context: Context) {
      val work = OneTimeWorkRequest.Builder(QuickCaptureWorker::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) work.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
      WorkManager.getInstance(context).enqueueUniqueWork("quick-capture", ExistingWorkPolicy.APPEND_OR_REPLACE, work.build())
    }
  }
}
