package com.kalamos.notebook

import android.os.Bundle
import android.view.KeyEvent
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    /** The device's hardware page-turn buttons → page nav. PAGE_DOWN = next, PAGE_UP = previous;
     *  in a notebook, page-down on the last page creates a new one. Unrecognised keys are logged so
     *  we can map them if this device uses different codes. */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            val dir = when (event.keyCode) {
                KeyEvent.KEYCODE_PAGE_DOWN -> "down"
                KeyEvent.KEYCODE_PAGE_UP -> "up"
                else -> null
            }
            if (dir != null) {
                (supportFragmentManager.findFragmentById(R.id.fragmentContainer) as? AppFragment)?.onPageKey(dir)
                return true
            }
            if (event.keyCode != KeyEvent.KEYCODE_BACK)
                android.util.Log.i("PERF", "DIAG keyDown code=${event.keyCode}")  // DIAG: identify page buttons
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        // Pass null so the FragmentManager does NOT auto-restore a prior fragment state; we always
        // start fresh with the single AppFragment (which boots into the library). Work is autosaved.
        super.onCreate(null)
        setContentView(R.layout.activity_main)

        supportFragmentManager.beginTransaction()
            .replace(R.id.fragmentContainer, AppFragment.newInstance())
            .commit()

        // Back is owned by the JS router: editor → library, library → home.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                (supportFragmentManager.findFragmentById(R.id.fragmentContainer) as? AppFragment)
                    ?.handleBack()
            }
        })
    }
}
