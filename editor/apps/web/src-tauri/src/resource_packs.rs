use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ENTRY: u64 = 64 * 1024 * 1024;
const MAX_ENTRIES: usize = 65_000;
const MAX_MOUNTS: usize = 64;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackSource {
    pub id: String,
    path: String,
    name: String,
    directory: bool,
}

struct Selection {
    source: PackSource,
    path: PathBuf,
    watcher: Option<RecommendedWatcher>,
}

#[derive(Default)]
pub struct PackSources(
    Mutex<HashMap<String, Selection>>,
    Mutex<HashMap<String, StoredPackPath>>,
);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StoredPackPath {
    path: PathBuf,
    directory: bool,
}

pub fn approved_path(app: &tauri::AppHandle, id: &str) -> Result<StoredPackPath, String> {
    app.state::<PackSources>()
        .1
        .lock()
        .map_err(error)?
        .get(id)
        .cloned()
        .ok_or_else(|| "PACK_SOURCE_UNAPPROVED".into())
}

pub fn restore(app: &tauri::AppHandle, saved: &StoredPackPath) -> Result<PackSource, String> {
    if !saved.path.is_absolute() || saved.path.as_os_str().len() > 4096 {
        return Err("PACK_PATH_INVALID".into());
    }
    register_path(app, saved.path.clone(), saved.directory, false)
}

fn error(value: impl std::fmt::Display) -> String {
    format!("PACK_READ_FAILED: {value}")
}

fn register(app: &tauri::AppHandle, path: PathBuf) -> Result<PackSource, String> {
    let path = path.canonicalize().map_err(error)?;
    let metadata = fs::metadata(&path).map_err(error)?;
    let directory = metadata.is_dir();
    if !directory
        && (!metadata.is_file()
            || !matches!(
                path.extension()
                    .and_then(|s| s.to_str())
                    .map(str::to_ascii_lowercase)
                    .as_deref(),
                Some("zip" | "jar")
            ))
    {
        return Err("PACK_PATH_INVALID".into());
    }
    register_path(app, path, directory, true)
}

fn register_path(
    app: &tauri::AppHandle,
    path: PathBuf,
    directory: bool,
    deduplicate: bool,
) -> Result<PackSource, String> {
    let state = app.state::<PackSources>();
    let mut sources = state.0.lock().map_err(error)?;
    if let Some(existing) = sources
        .values()
        .find(|source| deduplicate && source.path == path)
    {
        return Ok(existing.source.clone());
    }
    if sources.len() >= MAX_MOUNTS {
        return Err("PACK_MOUNT_LIMIT".into());
    }
    let source = PackSource {
        id: format!("local-{}", NEXT_ID.fetch_add(1, Ordering::Relaxed)),
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned(),
        directory,
    };
    // Approval survives releasing live readers so queued preference writes can finish safely.
    // Only a picker/drop or a previously saved local record can grant a path.
    let mut approved = state.1.lock().map_err(error)?;
    if approved.len() >= 4096 {
        return Err("PACK_MOUNT_LIMIT".into());
    }
    approved.insert(
        source.id.clone(),
        StoredPackPath {
            path: path.clone(),
            directory,
        },
    );
    sources.insert(
        source.id.clone(),
        Selection {
            source: source.clone(),
            path,
            watcher: None,
        },
    );
    Ok(source)
}

// Only OS picker/drop selections enter this registry. Subsequent IPC accepts opaque handles,
// never arbitrary filesystem paths, and never writes to the selected source.
#[tauri::command]
pub async fn pick_resource_packs(
    app: tauri::AppHandle,
    directory: bool,
) -> Result<Vec<PackSource>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app.dialog().file();
        if let Some(window) = app.get_webview_window("main") {
            dialog = dialog.set_parent(&window);
        }
        let paths = if directory {
            dialog.blocking_pick_folders()
        } else {
            dialog
                .add_filter("Minecraft resource pack", &["zip", "jar"])
                .blocking_pick_files()
        };
        Ok(paths
            .unwrap_or_default()
            .into_iter()
            .take(MAX_MOUNTS)
            .filter_map(|path| {
                match path
                    .into_path()
                    .map_err(error)
                    .and_then(|path| register(&app, path))
                {
                    Ok(source) => Some(source),
                    Err(message) => {
                        let _ = app.emit_to("main", "resource-pack-drop-error", message);
                        None
                    }
                }
            })
            .collect())
    })
    .await
    .map_err(error)?
}

pub fn dropped(app: &tauri::AppHandle, paths: &[PathBuf]) {
    for path in paths.iter().take(MAX_MOUNTS) {
        match register(app, path.clone()) {
            Ok(source) => {
                let _ = app.emit_to("main", "resource-pack-dropped", source);
            }
            Err(message) => {
                let _ = app.emit_to("main", "resource-pack-drop-error", message);
            }
        }
    }
}

fn selected_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    app.state::<PackSources>()
        .0
        .lock()
        .map_err(error)?
        .get(id)
        .map(|selection| selection.path.clone())
        .ok_or_else(|| "PACK_SOURCE_RELEASED".into())
}

fn checked_metadata(path: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(path).map_err(error)?;
    if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
        return Err("PACK_SYMLINK_UNSUPPORTED".into());
    }
    Ok(metadata)
}

fn directory_files(root: &Path) -> Result<BTreeMap<String, PathBuf>, String> {
    let mut files = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut entries = 0;
    let mut bytes = 0;
    while let Some((directory, depth)) = pending.pop() {
        if depth > 32 {
            return Err("PACK_DEPTH_LIMIT".into());
        }
        checked_metadata(&directory)?;
        for entry in fs::read_dir(directory).map_err(error)? {
            let entry = entry.map_err(error)?;
            entries += 1;
            if entries > MAX_ENTRIES {
                return Err("PACK_ENTRY_LIMIT".into());
            }
            let path = entry.path();
            let meta = checked_metadata(&path)?;
            if meta.is_dir() {
                pending.push((path, depth + 1));
                continue;
            }
            bytes += meta.len();
            if meta.len() > MAX_ENTRY || bytes > MAX_BYTES {
                return Err("PACK_SIZE_LIMIT".into());
            }
            let name = path
                .strip_prefix(root)
                .map_err(error)?
                .to_str()
                .ok_or("PACK_PATH_INVALID")?
                .replace('\\', "/");
            files.insert(name, path);
        }
    }
    if !files.contains_key("pack.mcmeta") {
        return Err("PACK_METADATA_MISSING".into());
    }
    Ok(files)
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let meta = checked_metadata(path)?;
    if !meta.is_file() || meta.len() > limit {
        return Err("PACK_SIZE_LIMIT".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(error)?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(error)?;
    if bytes.len() as u64 > limit {
        return Err("PACK_SIZE_LIMIT".into());
    }
    Ok(bytes)
}

fn snapshot(path: &Path) -> Result<Vec<u8>, String> {
    if !checked_metadata(path)?.is_dir() {
        return read_bounded(path, MAX_BYTES);
    }
    let files = directory_files(path)?;
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let mut total = 0;
    for (name, path) in files {
        let bytes = read_bounded(&path, MAX_ENTRY)?;
        total += bytes.len() as u64;
        if total > MAX_BYTES {
            return Err("PACK_SIZE_LIMIT".into());
        }
        zip.start_file(name, options).map_err(error)?;
        zip.write_all(&bytes).map_err(error)?;
    }
    let bytes = zip.finish().map_err(error)?.into_inner();
    if bytes.len() as u64 > MAX_BYTES {
        return Err("PACK_SIZE_LIMIT".into());
    }
    Ok(bytes)
}

fn stamp(path: &Path) -> Result<String, String> {
    let files = if checked_metadata(path)?.is_dir() {
        directory_files(path)?
    } else {
        BTreeMap::from([(String::new(), path.to_path_buf())])
    };
    let mut hash = Sha1::new();
    for (name, file) in files {
        let meta = checked_metadata(&file)?;
        hash.update(name.as_bytes());
        hash.update([0]);
        hash.update(meta.len().to_le_bytes());
        hash.update(
            meta.modified()
                .map_err(error)?
                .duration_since(UNIX_EPOCH)
                .map_err(error)?
                .as_nanos()
                .to_le_bytes(),
        );
    }
    Ok(format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub async fn read_resource_pack(
    app: tauri::AppHandle,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let path = selected_path(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || snapshot(&path).map(tauri::ipc::Response::new))
        .await
        .map_err(error)?
}

#[tauri::command]
pub async fn resource_pack_stamp(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let path = selected_path(&app, &id)?;
    tauri::async_runtime::spawn_blocking(move || stamp(&path))
        .await
        .map_err(error)?
}

#[tauri::command]
pub fn watch_resource_pack(app: tauri::AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let state = app.state::<PackSources>();
    let mut sources = state.0.lock().map_err(error)?;
    let selection = sources.get_mut(&id).ok_or("PACK_SOURCE_RELEASED")?;
    selection.watcher = None;
    if !enabled {
        return Ok(());
    }
    let target = selection.path.clone();
    let handle = app.clone();
    let mut watcher = notify::recommended_watcher(move |result: notify::Result<notify::Event>| {
        let changed = match result {
            Ok(event) => {
                !matches!(event.kind, EventKind::Access(_))
                    && event.paths.iter().any(|path| path.starts_with(&target))
            }
            Err(_) => true,
        };
        if changed {
            let _ = handle.emit_to("main", "resource-pack-changed", &id);
        }
    })
    .map_err(error)?;
    if let Some(parent) = selection.path.parent() {
        watcher
            .watch(parent, RecursiveMode::NonRecursive)
            .map_err(error)?;
    }
    if selection.source.directory && selection.path.is_dir() {
        watcher
            .watch(&selection.path, RecursiveMode::Recursive)
            .map_err(error)?;
    }
    selection.watcher = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn release_resource_pack(app: tauri::AppHandle, id: String) -> Result<(), String> {
    app.state::<PackSources>()
        .0
        .lock()
        .map_err(error)?
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_snapshot_and_stamp_follow_changes_without_writing_sources() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("pack.mcmeta"),
            b"{\"pack\":{\"pack_format\":84}}",
        )
        .unwrap();
        fs::create_dir_all(dir.path().join("assets/example")).unwrap();
        fs::write(dir.path().join("assets/example/a.txt"), b"one").unwrap();
        let first = stamp(dir.path()).unwrap();
        let bytes = snapshot(dir.path()).unwrap();
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut text = String::new();
        archive
            .by_name("assets/example/a.txt")
            .unwrap()
            .read_to_string(&mut text)
            .unwrap();
        assert_eq!(text, "one");
        fs::write(dir.path().join("assets/example/a.txt"), b"two changed").unwrap();
        assert_ne!(first, stamp(dir.path()).unwrap());
        fs::remove_file(dir.path().join("assets/example/a.txt")).unwrap();
        assert_eq!(directory_files(dir.path()).unwrap().len(), 1);
    }
    #[test]
    fn missing_metadata_and_oversized_files_fail_before_archive_allocation() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            directory_files(dir.path()).unwrap_err(),
            "PACK_METADATA_MISSING"
        );
        fs::write(dir.path().join("pack.mcmeta"), b"{}").unwrap();
        File::create(dir.path().join("large.bin"))
            .unwrap()
            .set_len(MAX_ENTRY + 1)
            .unwrap();
        assert_eq!(snapshot(dir.path()).unwrap_err(), "PACK_SIZE_LIMIT");
    }
    #[cfg(unix)]
    #[test]
    fn directory_symlinks_cannot_escape_or_loop() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("pack.mcmeta"), b"{}").unwrap();
        std::os::unix::fs::symlink(dir.path(), dir.path().join("loop")).unwrap();
        assert_eq!(
            snapshot(dir.path()).unwrap_err(),
            "PACK_SYMLINK_UNSUPPORTED"
        );
    }
}
