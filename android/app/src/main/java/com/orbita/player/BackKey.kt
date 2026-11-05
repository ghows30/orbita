package com.orbita.player

import android.app.Activity
import android.os.Build
import android.os.SystemClock
import android.window.OnBackInvokedDispatcher
import java.util.WeakHashMap

/**
 * Tasto Indietro coerente su tutte le versioni:
 * - fino ad Android 15 (Fire OS incluso) arriva come KeyEvent in dispatchKeyEvent;
 * - da Android 16 con targetSdk 36 il sistema usa OnBackInvokedCallback e, senza callback, chiude l'Activity.
 * Registriamo entrambe le strade; [fire] scarta il doppione se arrivano tutte e due.
 */
object BackKey {
    private val last = WeakHashMap<Activity, Long>()

    fun register(a: Activity, handler: () -> Unit) {
        if (Build.VERSION.SDK_INT >= 33) {
            a.onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { fire(a, handler) }
        }
    }

    fun fire(a: Activity, handler: () -> Unit) {
        val now = SystemClock.uptimeMillis()
        if (now - (last[a] ?: 0L) < 250) return
        last[a] = now
        handler()
    }
}
