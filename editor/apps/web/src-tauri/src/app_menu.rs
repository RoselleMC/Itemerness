use serde::Deserialize;
#[cfg(target_os = "macos")]
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "macos")]
use tauri::menu::{CheckMenuItem, Menu, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{App, AppHandle, Emitter, Manager};

#[derive(Deserialize)]
pub struct MenuUpdate {
    id: String,
    label: String,
    items: Vec<ItemUpdate>,
}
#[derive(Deserialize)]
pub struct ItemUpdate {
    id: String,
    label: String,
    enabled: bool,
    checked: Option<bool>,
}

#[derive(Default)]
pub struct EditorMenuState {
    pub guard_ready: AtomicBool,
    pub exit_allowed: AtomicBool,
    exit_pending: AtomicBool,
    #[cfg(target_os = "macos")]
    items: HashMap<String, MenuItemKind<tauri::Wry>>,
    #[cfg(target_os = "macos")]
    groups: HashMap<String, Submenu<tauri::Wry>>,
}

#[cfg(target_os = "macos")]
fn insert_commands(
    app: &App,
    submenu: &Submenu<tauri::Wry>,
    state: &mut EditorMenuState,
    commands: &[(&str, Option<&str>, bool)],
) -> tauri::Result<()> {
    for (index, (id, shortcut, check)) in commands.iter().enumerate() {
        if id.is_empty() {
            submenu.insert(&PredefinedMenuItem::separator(app)?, index)?;
            continue;
        }
        let item = if *check {
            MenuItemKind::Check(CheckMenuItem::with_id(
                app, *id, *id, false, false, *shortcut,
            )?)
        } else {
            MenuItemKind::MenuItem(MenuItem::with_id(app, *id, *id, false, *shortcut)?)
        };
        submenu.insert(&item, index)?;
        state.items.insert((*id).into(), item);
    }
    Ok(())
}

pub fn install(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    let state = EditorMenuState::default();
    #[cfg(target_os = "macos")]
    let state = {
        let mut state = state;
        let menu = Menu::default(app.handle())?;
        for item in menu.items()? {
            if let Some(submenu) = item.as_submenu() {
                let name = submenu.text()?;
                match name.as_str() {
                    "File" => {
                        insert_commands(
                            app,
                            submenu,
                            &mut state,
                            &[
                                ("new-item", Some("CmdOrCtrl+N"), false),
                                ("save-document", Some("CmdOrCtrl+S"), false),
                                ("auto-save", None, true),
                                ("", None, false),
                                ("connection", Some("CmdOrCtrl+Shift+K"), false),
                                ("disconnect", None, false),
                                ("", None, false),
                            ],
                        )?;
                        state.groups.insert("file".into(), submenu.clone());
                    }
                    "Edit" => {
                        // WebView responder undo alone cannot undo non-text document changes.
                        for item in submenu.items()?.into_iter().take(2) {
                            submenu.remove(&item)?;
                        }
                        insert_commands(
                            app,
                            submenu,
                            &mut state,
                            &[
                                ("undo", Some("CmdOrCtrl+Z"), false),
                                ("redo", Some("CmdOrCtrl+Shift+Z"), false),
                            ],
                        )?;
                        for (id, item) in ["cut", "copy", "paste", "select-all"]
                            .iter()
                            .zip(submenu.items()?.into_iter().skip(3))
                        {
                            state.items.insert((*id).into(), item);
                        }
                        state.groups.insert("edit".into(), submenu.clone());
                    }
                    "View" => {
                        insert_commands(
                            app,
                            submenu,
                            &mut state,
                            &[
                                ("mode-items", None, true),
                                ("mode-themes", None, true),
                                ("mode-layouts", None, true),
                                ("mode-data", None, true),
                                ("mode-formats", None, true),
                                ("mode-facts", None, true),
                                ("", None, false),
                                ("assets", None, false),
                                ("translations", None, false),
                                ("toggle-navigation", Some("CmdOrCtrl+B"), true),
                                ("", None, false),
                                ("zoom-in", Some("CmdOrCtrl+="), false),
                                ("zoom-out", Some("CmdOrCtrl+-"), false),
                                ("zoom-reset", Some("CmdOrCtrl+0"), false),
                                ("zoom-fit", None, false),
                                ("", None, false),
                                ("compare", None, true),
                                ("geometry", None, true),
                                ("", None, false),
                            ],
                        )?;
                        state.groups.insert("view".into(), submenu.clone());
                    }
                    "Help" => {
                        let metadata = tauri::menu::AboutMetadata {
                            name: Some("Itemerness Editor".into()),
                            version: Some(app.package_info().version.to_string()),
                            ..Default::default()
                        };
                        let about = PredefinedMenuItem::about(app, None, Some(metadata))?;
                        submenu.append(&about)?;
                        state
                            .items
                            .insert("about".into(), MenuItemKind::Predefined(about));
                        state.groups.insert("help".into(), submenu.clone());
                    }
                    "Window" => {
                        submenu.append(&PredefinedMenuItem::bring_all_to_front(app, None)?)?;
                    }
                    _ => {
                        let settings = MenuItem::with_id(
                            app,
                            "settings",
                            "Settings...",
                            true,
                            Some("CmdOrCtrl+,"),
                        )?;
                        submenu.insert(&settings, 2)?;
                        submenu.insert(&PredefinedMenuItem::separator(app)?, 3)?;
                        submenu.insert(&PredefinedMenuItem::show_all(app, None)?, 8)?;
                        state
                            .items
                            .insert("settings".into(), MenuItemKind::MenuItem(settings));
                    }
                }
            }
        }
        app.set_menu(menu)?;
        state
    };
    app.manage(state);
    Ok(())
}

#[tauri::command]
pub fn update_editor_menu(app: AppHandle, groups: Vec<MenuUpdate>) -> Result<(), String> {
    if groups.len() > 8
        || groups.iter().any(|group| {
            group.label.len() > 256
                || group.items.len() > 64
                || group
                    .items
                    .iter()
                    .any(|item| item.id.len() > 80 || item.label.len() > 512)
        })
    {
        return Err("Invalid application menu state".into());
    }
    let state = app.state::<EditorMenuState>();
    state.guard_ready.store(true, Ordering::Release);
    #[cfg(target_os = "macos")]
    for group in groups {
        if let Some(menu) = state.groups.get(&group.id) {
            menu.set_text(group.label)
                .map_err(|error| error.to_string())?;
        }
        for update in group.items {
            let result = match state.items.get(&update.id) {
                Some(MenuItemKind::MenuItem(item)) => item
                    .set_text(update.label)
                    .and_then(|_| item.set_enabled(update.enabled)),
                Some(MenuItemKind::Check(item)) => item
                    .set_text(update.label)
                    .and_then(|_| item.set_enabled(update.enabled))
                    .and_then(|_| item.set_checked(update.checked.unwrap_or(false))),
                Some(MenuItemKind::Predefined(item)) => item.set_text(update.label),
                _ => Ok(()),
            };
            result.map_err(|error| error.to_string())?;
        }
    }
    #[cfg(not(target_os = "macos"))]
    for group in groups {
        let _ = group.id;
        for item in group.items {
            let _ = (item.enabled, item.checked);
        }
    }
    Ok(())
}

pub fn dispatch(app: &AppHandle, id: &str) {
    #[cfg(target_os = "macos")]
    if app
        .state::<EditorMenuState>()
        .items
        .get(id)
        .is_some_and(|item| matches!(item, MenuItemKind::MenuItem(_) | MenuItemKind::Check(_)))
    {
        let result = if id == "save-document" {
            app.emit_to("main", "editor-save", ())
        } else {
            app.emit_to("main", "editor-menu", id)
        };
        if let Err(error) = result {
            eprintln!("Could not dispatch editor command: {error}");
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, id);
}

#[tauri::command]
pub fn confirm_editor_exit(app: AppHandle) {
    app.state::<EditorMenuState>()
        .exit_allowed
        .store(true, Ordering::Release);
    app.exit(0);
}

#[tauri::command]
pub fn cancel_editor_exit(app: AppHandle) {
    app.state::<EditorMenuState>()
        .exit_pending
        .store(false, Ordering::Release);
}

fn should_guard_exit(ready: bool, allowed: bool, has_window: bool) -> bool {
    ready && !allowed && has_window
}

pub fn request_editor_exit(app: &AppHandle) -> bool {
    let state = app.state::<EditorMenuState>();
    if !should_guard_exit(
        state.guard_ready.load(Ordering::Acquire),
        state.exit_allowed.load(Ordering::Acquire),
        app.get_webview_window("main").is_some(),
    ) {
        return false;
    }
    if !state.exit_pending.swap(true, Ordering::AcqRel) {
        if let Err(error) = app.emit_to("main", "editor-exit-requested", ()) {
            state.exit_pending.store(false, Ordering::Release);
            eprintln!("Could not dispatch exit confirmation: {error}");
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_initialized_unconfirmed_windows_require_exit_review() {
        for ready in [false, true] {
            for allowed in [false, true] {
                for has_window in [false, true] {
                    assert_eq!(
                        should_guard_exit(ready, allowed, has_window),
                        ready && !allowed && has_window
                    );
                }
            }
        }
    }

    #[test]
    fn repeated_quit_requests_are_coalesced_until_cancelled_or_confirmed() {
        let state = EditorMenuState::default();
        state.guard_ready.store(true, Ordering::Release);
        assert!(!state.exit_pending.swap(true, Ordering::AcqRel));
        assert!(state.exit_pending.swap(true, Ordering::AcqRel));
        assert!(!state.exit_allowed.load(Ordering::Acquire));
        state.exit_pending.store(false, Ordering::Release);
        assert!(!state.exit_pending.swap(true, Ordering::AcqRel));
        state.exit_allowed.store(true, Ordering::Release);
        assert!(!should_guard_exit(
            state.guard_ready.load(Ordering::Acquire),
            state.exit_allowed.load(Ordering::Acquire),
            true
        ));
    }
}
