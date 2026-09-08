use objc2::encode::Encode;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{sel, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::ffi::CString;
use std::sync::OnceLock;

static EDITOR_APP: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C-unwind" fn application_should_terminate(
    _delegate: &AnyObject,
    _selector: Sel,
    _sender: &NSApplication,
) -> NSApplicationTerminateReply {
    if EDITOR_APP
        .get()
        .is_some_and(crate::app_menu::request_editor_exit)
    {
        NSApplicationTerminateReply::TerminateCancel
    } else {
        NSApplicationTerminateReply::TerminateNow
    }
}

pub fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let main = MainThreadMarker::new().ok_or("Application exit guard requires the main thread")?;
    let application = NSApplication::sharedApplication(main);
    let delegate = application
        .delegate()
        .ok_or("Application delegate is unavailable")?;
    let selector = sel!(applicationShouldTerminate:);
    let object: &AnyObject = (*delegate).as_ref();
    let class = object.class();
    if class.instance_method(selector).is_some() {
        return Err("Application delegate already defines a termination policy".into());
    }
    EDITOR_APP
        .set(app.clone())
        .map_err(|_| "Application exit guard is already installed")?;
    let encoding = CString::new(format!("{}@:@", NSApplicationTerminateReply::ENCODING))?;
    // Tao's delegate does not implement this public AppKit callback. Add only the missing method,
    // retaining its existing delegate and lifecycle methods instead of replacing an implementation.
    // SAFETY: the function ABI and encoding match applicationShouldTerminate: exactly. Class and
    // selector live for this process, and registration happens on the main thread before user input.
    let added = unsafe {
        let implementation: Imp = std::mem::transmute(
            application_should_terminate
                as extern "C-unwind" fn(
                    &AnyObject,
                    Sel,
                    &NSApplication,
                ) -> NSApplicationTerminateReply,
        );
        objc2::ffi::class_addMethod(
            (class as *const AnyClass).cast_mut(),
            selector,
            implementation,
            encoding.as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err("Could not install application termination policy".into());
    }
    Ok(())
}
