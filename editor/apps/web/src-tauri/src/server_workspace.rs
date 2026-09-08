use crate::resource_packs::{self, PackSource, StoredPackPath};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::Manager;

#[derive(Default)]
pub struct WorkspaceStorage(Mutex<()>);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSettings {
    remember: bool,
    #[serde(default, skip_serializing)]
    alias: String,
    vanilla_version: Option<String>,
    preview: PreviewSettings,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PreviewSettings {
    selected_item_id: Option<String>,
    viewer_locale: String,
    compare_locales: bool,
    annotations: bool,
    gui_scale: f64,
    zoom_mode: String,
}

impl WorkspaceSettings {
    fn validate(&self) -> Result<(), String> {
        if self.alias.chars().count() > 80
            || self.preview.viewer_locale.len() > 128
            || self
                .preview
                .selected_item_id
                .as_ref()
                .is_some_and(|id| id.len() > 256)
            || !self.preview.gui_scale.is_finite()
            || !(0.01..=32.0).contains(&self.preview.gui_scale)
            || !matches!(self.preview.zoom_mode.as_str(), "manual" | "fit")
            || self
                .vanilla_version
                .as_ref()
                .is_some_and(|v| !matches!(v.as_str(), "1.21.11" | "26.1.1" | "26.1.2" | "26.2"))
        {
            return Err("WORKSPACE_INVALID".into());
        }
        Ok(())
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SavedMount {
    source: StoredPackPath,
    auto_reload: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    schema: u32,
    settings: WorkspaceSettings,
    mounts: Vec<SavedMount>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MountRequest {
    id: String,
    auto_reload: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredMount {
    source: PackSource,
    auto_reload: bool,
}
#[derive(Serialize)]
pub struct RestoredWorkspace {
    settings: WorkspaceSettings,
    mounts: Vec<RestoredMount>,
}

fn profile_path(root: &Path, server_id: &str) -> Result<PathBuf, String> {
    let id = uuid::Uuid::parse_str(server_id).map_err(|_| "WORKSPACE_ID_INVALID")?;
    if id.to_string() != server_id {
        return Err("WORKSPACE_ID_INVALID".into());
    }
    Ok(root.join(format!("{id}.json")))
}
fn directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|path| path.join("server-workspaces-v1"))
        .map_err(|_| "WORKSPACE_STORAGE_UNAVAILABLE".into())
}
fn read_record(path: &Path) -> Result<Option<Record>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("WORKSPACE_READ_FAILED".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 512 * 1024 {
        return Err("WORKSPACE_INVALID".into());
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|_| "WORKSPACE_READ_FAILED")?
        .take(512 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "WORKSPACE_READ_FAILED")?;
    if bytes.len() > 512 * 1024 {
        return Err("WORKSPACE_INVALID".into());
    }
    let record: Record = serde_json::from_slice(&bytes).map_err(|_| "WORKSPACE_INVALID")?;
    if record.schema != 1 || record.mounts.len() > 64 {
        return Err("WORKSPACE_INVALID".into());
    }
    record.settings.validate()?;
    Ok(Some(record))
}
fn write_record(path: &Path, record: &Record) -> Result<(), String> {
    let root = path.parent().ok_or("WORKSPACE_WRITE_FAILED")?;
    fs::create_dir_all(root).map_err(|_| "WORKSPACE_WRITE_FAILED")?;
    let bytes = serde_json::to_vec(record).map_err(|_| "WORKSPACE_INVALID")?;
    if bytes.len() > 512 * 1024 {
        return Err("WORKSPACE_INVALID".into());
    }
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|_| "WORKSPACE_WRITE_FAILED")?;
    file.write_all(&bytes)
        .map_err(|_| "WORKSPACE_WRITE_FAILED")?;
    file.as_file()
        .sync_all()
        .map_err(|_| "WORKSPACE_WRITE_FAILED")?;
    file.persist(path).map_err(|_| "WORKSPACE_WRITE_FAILED")?;
    Ok(())
}

#[tauri::command]
pub async fn load_server_workspace(
    app: tauri::AppHandle,
    server_id: String,
) -> Result<Option<RestoredWorkspace>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceStorage>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "WORKSPACE_STORAGE_UNAVAILABLE")?;
        let path = profile_path(&directory(&app)?, &server_id)?;
        let Some(record) = read_record(&path)? else {
            return Ok(None);
        };
        let mut mounts: Vec<RestoredMount> = Vec::new();
        if record.settings.remember {
            for mount in record.mounts {
                match resource_packs::restore(&app, &mount.source) {
                    Ok(source) => mounts.push(RestoredMount {
                        source,
                        auto_reload: mount.auto_reload,
                    }),
                    Err(error) => {
                        for mount in mounts {
                            let _ =
                                resource_packs::release_resource_pack(app.clone(), mount.source.id);
                        }
                        return Err(error);
                    }
                }
            }
        }
        Ok(Some(RestoredWorkspace {
            settings: record.settings,
            mounts,
        }))
    })
    .await
    .map_err(|_| "WORKSPACE_READ_FAILED")?
}

#[tauri::command]
pub async fn save_server_workspace(
    app: tauri::AppHandle,
    server_id: String,
    settings: WorkspaceSettings,
    mounts: Vec<MountRequest>,
) -> Result<(), String> {
    settings.validate()?;
    if mounts.len() > 64 {
        return Err("WORKSPACE_INVALID".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<WorkspaceStorage>();
        let _guard = state
            .0
            .lock()
            .map_err(|_| "WORKSPACE_STORAGE_UNAVAILABLE")?;
        let path = profile_path(&directory(&app)?, &server_id)?;
        let mounts = if settings.remember {
            mounts
                .iter()
                .map(|mount| {
                    Ok(SavedMount {
                        source: resource_packs::approved_path(&app, &mount.id)?,
                        auto_reload: mount.auto_reload,
                    })
                })
                .collect::<Result<Vec<_>, String>>()?
        } else {
            Vec::new()
        };
        write_record(
            &path,
            &Record {
                schema: 1,
                settings,
                mounts,
            },
        )
    })
    .await
    .map_err(|_| "WORKSPACE_WRITE_FAILED")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        serde_json::from_value(serde_json::json!({ "schema": 1, "settings": {
            "remember": true, "alias": "Test", "vanillaVersion": "26.1.2", "preview": {
                "selectedItemId": null, "viewerLocale": "en_us", "compareLocales": false, "annotations": false, "guiScale": 3.0, "zoomMode": "fit"
            }
        }, "mounts": [] })).unwrap()
    }
    #[test]
    fn identities_cannot_escape_local_storage() {
        let root = Path::new("profiles");
        assert!(profile_path(root, "../../settings").is_err());
        assert!(profile_path(root, "folia-25565").is_err());
        assert!(profile_path(root, "d94af8ea-843a-4c1c-8bd8-24c8a1e5bb62").is_ok());
    }
    #[test]
    fn atomic_records_round_trip_without_arbitrary_payloads() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("profile.json");
        assert!(read_record(&path).unwrap().is_none());
        write_record(&path, &record()).unwrap();
        assert!(read_record(&path).unwrap().unwrap().settings.remember);
        assert!(!fs::read_to_string(&path).unwrap().contains("\"alias\""));
        let mut value = serde_json::to_value(record()).unwrap();
        value["settings"]["document"] = serde_json::json!({});
        fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(read_record(&path).is_err());
        fs::write(&path, b"broken").unwrap();
        assert!(read_record(&path).is_err());
    }
}
