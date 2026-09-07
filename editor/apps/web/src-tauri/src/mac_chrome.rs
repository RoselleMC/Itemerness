use objc2::MainThreadMarker;
use objc2_app_kit::{NSToolbar, NSWindow, NSWindowToolbarStyle};

pub fn apply(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let main = MainThreadMarker::new().ok_or("Window chrome requires the main thread")?;
    let pointer = window.ns_window()?;
    if pointer.is_null() {
        return Err("Native window is unavailable".into());
    }
    // AppKit owns traffic-light positions and corner geometry across resize/fullscreen changes.
    // A transparent unified toolbar adopts the larger document-window corners and lowers the
    // traffic lights naturally, matching the 52px header without rewriting private geometry.
    // SAFETY: ns_window() supplies this live window's NSWindow; we borrow it only on the main thread.
    unsafe {
        let native = &*pointer.cast::<NSWindow>();
        let toolbar = NSToolbar::new(main);
        native.setToolbar(Some(&toolbar));
        native.setToolbarStyle(NSWindowToolbarStyle::Unified);
    }
    Ok(())
}
