use serde::Deserialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

const MAX_CATALOG_ARCHIVE: usize = 4 * 1024 * 1024;
const MAX_LOCAL_YAML: usize = 2 * 1024 * 1024;
static SAVE_DIALOG_OPEN: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportKind {
    Catalog,
    Config,
    Access,
}

impl ExportKind {
    fn settings(self) -> (&'static str, &'static str, &'static str, usize) {
        match self {
            Self::Catalog => (
                "itemerness-catalog.zip",
                "ZIP archive",
                "zip",
                MAX_CATALOG_ARCHIVE,
            ),
            Self::Config => ("config.yml", "YAML configuration", "yml", MAX_LOCAL_YAML),
            Self::Access => ("access.yml", "YAML configuration", "yml", MAX_LOCAL_YAML),
        }
    }
}

struct SaveDialogGuard;
impl Drop for SaveDialogGuard {
    fn drop(&mut self) {
        SAVE_DIALOG_OPEN.store(false, Ordering::Release);
    }
}

fn save_selected_export(
    kind: ExportKind,
    bytes: &[u8],
    pick: impl FnOnce() -> Result<Option<PathBuf>, String>,
    write: impl FnOnce(PathBuf, &[u8]) -> Result<(), String>,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > kind.settings().3 {
        return Err("EXPORT_SIZE_INVALID".into());
    }
    let Some(path) = pick()? else {
        return Ok(false);
    };
    write(path, bytes)?;
    Ok(true)
}

// The caller supplies only a known export kind and bounded bytes, never a destination path.
#[tauri::command]
pub async fn save_editor_export(
    app: tauri::AppHandle,
    kind: ExportKind,
    bytes: Vec<u8>,
) -> Result<bool, String> {
    if bytes.is_empty() || bytes.len() > kind.settings().3 {
        return Err("EXPORT_SIZE_INVALID".into());
    }
    if SAVE_DIALOG_OPEN
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("EXPORT_SAVE_FAILED".into());
    }
    let guard = SaveDialogGuard;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let (name, filter, extension, _) = kind.settings();
        save_selected_export(
            kind,
            &bytes,
            || {
                let mut dialog = app
                    .dialog()
                    .file()
                    .set_file_name(name)
                    .add_filter(filter, &[extension]);
                if let Some(window) = app.get_webview_window("main") {
                    dialog = dialog.set_parent(&window);
                }
                dialog
                    .blocking_save_file()
                    .map(|path| path.into_path().map_err(|_| "EXPORT_SAVE_FAILED".into()))
                    .transpose()
            },
            |path, bytes| std::fs::write(path, bytes).map_err(|_| "EXPORT_SAVE_FAILED".into()),
        )
    })
    .await
    .map_err(|_| "EXPORT_SAVE_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_kinds_have_fixed_names_filters_and_budgets() {
        for (value, name, extension, limit) in [
            (
                "catalog",
                "itemerness-catalog.zip",
                "zip",
                MAX_CATALOG_ARCHIVE,
            ),
            ("config", "config.yml", "yml", MAX_LOCAL_YAML),
            ("access", "access.yml", "yml", MAX_LOCAL_YAML),
        ] {
            let kind: ExportKind = serde_json::from_str(&format!("\"{value}\"")).unwrap();
            assert_eq!(
                (kind.settings().0, kind.settings().2, kind.settings().3),
                (name, extension, limit)
            );
            for length in [0, limit + 1] {
                let result = save_selected_export(
                    kind,
                    &vec![0; length],
                    || panic!("invalid exports must not open a dialog"),
                    |_, _| panic!("invalid exports must not write"),
                );
                assert_eq!(result, Err("EXPORT_SIZE_INVALID".into()));
            }
            assert_eq!(
                save_selected_export(
                    kind,
                    &vec![0; limit],
                    || Ok(None),
                    |_, _| panic!("cancel must not write")
                ),
                Ok(false)
            );
        }
        for value in ["arbitrary", "../config.yml", "/tmp/file", "CONFIG"] {
            assert!(serde_json::from_str::<ExportKind>(&format!("\"{value}\"")).is_err());
        }
    }

    #[test]
    fn writes_only_the_picker_destination_and_reports_cancel_or_write_failure() {
        let selected = PathBuf::from("chosen-by-native-dialog.yml");
        assert_eq!(
            save_selected_export(
                ExportKind::Config,
                b"enabled: true\n",
                || Ok(Some(selected.clone())),
                |path, bytes| {
                    assert_eq!(path, selected);
                    assert_eq!(bytes, b"enabled: true\n");
                    Ok(())
                }
            ),
            Ok(true)
        );
        assert_eq!(
            save_selected_export(
                ExportKind::Access,
                b"{}",
                || Ok(None),
                |_, _| panic!("cancel must not write")
            ),
            Ok(false)
        );
        assert_eq!(
            save_selected_export(
                ExportKind::Catalog,
                b"zip",
                || Ok(Some(selected)),
                |_, _| Err("EXPORT_SAVE_FAILED".into())
            ),
            Err("EXPORT_SAVE_FAILED".into())
        );
    }
}
