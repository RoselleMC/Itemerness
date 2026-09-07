use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{App, AppHandle, Manager};

#[derive(Default)]
pub struct EditorMenuState {
    pub guard_ready: AtomicBool,
    pub exit_allowed: AtomicBool,
    #[cfg(target_os = "macos")]
    save: Option<tauri::menu::MenuItem<tauri::Wry>>,
}

pub fn install(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let state = EditorMenuState::default();
    #[cfg(target_os = "macos")]
    let state = {
        use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
        let menu = Menu::default(app.handle())?;
        let save = MenuItem::with_id(app, "save-document", "Save", false, Some("CmdOrCtrl+S"))?;
        let mut found = false;
        for item in menu.items()? {
            if let Some(file) = item.as_submenu() {
                if file.text()? == "File" {
                    file.insert(&save, 0)?;
                    file.insert(&PredefinedMenuItem::separator(app)?, 1)?;
                    found = true;
                    break;
                }
            }
        }
        if !found {
            return Err("Default File menu is unavailable".into());
        }
        app.set_menu(menu)?;
        EditorMenuState {
            save: Some(save),
            ..state
        }
    };
    app.manage(state);
    Ok(())
}

#[tauri::command]
pub fn update_editor_menu(app: AppHandle, enabled: bool, save_label: String) -> Result<(), String> {
    let state = app.state::<EditorMenuState>();
    state.guard_ready.store(true, Ordering::Release);
    #[cfg(target_os = "macos")]
    if let Some(save) = &state.save {
        save.set_text(save_label)
            .map_err(|error| error.to_string())?;
        save.set_enabled(enabled)
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (enabled, save_label);
    Ok(())
}

#[tauri::command]
pub fn confirm_editor_exit(app: AppHandle) {
    app.state::<EditorMenuState>()
        .exit_allowed
        .store(true, Ordering::Release);
    app.exit(0);
}
