use sha1::{Digest, Sha1};
use std::io::Write;
use std::path::Path;
use tauri::Manager;

pub fn expected_hash(url: &str) -> Option<String> {
    for source in [
        include_str!("../../../../../tools/font-metrics/1.21.11.sources.json"),
        include_str!("../../../../../tools/font-metrics/26.1.1.sources.json"),
        include_str!("../../../../../tools/font-metrics/26.1.2.sources.json"),
        include_str!("../../../../../tools/font-metrics/26.2.sources.json"),
    ] {
        let manifest: serde_json::Value =
            serde_json::from_str(source).expect("bundled asset manifest");
        for key in ["client", "assetIndex"] {
            if manifest[key]["url"].as_str() == Some(url) {
                return manifest[key]["sha1"].as_str().map(str::to_owned);
            }
        }
        for value in manifest["assetResources"]
            .as_object()
            .expect("asset resources")
            .values()
        {
            let hash = value.as_str().expect("asset hash");
            if url
                == format!(
                    "https://resources.download.minecraft.net/{}/{}",
                    &hash[..2],
                    hash
                )
            {
                return Some(hash.into());
            }
        }
    }
    None
}

fn valid(bytes: &[u8], hash: &str) -> bool {
    format!("{:x}", Sha1::digest(bytes)) == hash
}

fn read_cache(root: &Path, hash: &str) -> Option<Vec<u8>> {
    let path = root.join(hash);
    if std::fs::symlink_metadata(&path)
        .ok()?
        .file_type()
        .is_symlink()
    {
        return None;
    }
    if std::fs::metadata(&path).ok()?.len() > 128 * 1024 * 1024 {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    valid(&bytes, hash).then_some(bytes)
}

pub async fn download(app: tauri::AppHandle, url: String) -> Result<tauri::ipc::Response, String> {
    let hash = expected_hash(&url).ok_or("ASSET_URL_FORBIDDEN")?;
    let directory = app
        .path()
        .app_cache_dir()
        .map_err(|_| "ASSET_CACHE_UNAVAILABLE")?
        .join("minecraft-assets-v1");
    let cache = directory.clone();
    let key = hash.clone();
    if let Some(bytes) = tauri::async_runtime::spawn_blocking(move || read_cache(&cache, &key))
        .await
        .map_err(|_| "ASSET_CACHE_UNAVAILABLE")?
    {
        return Ok(tauri::ipc::Response::new(bytes));
    }
    let response = super::client(120)?
        .get(url)
        .send()
        .await
        .map_err(|_| "NETWORK_UNAVAILABLE")?;
    if !response.status().is_success() {
        return Err("ASSET_DOWNLOAD_FAILED".into());
    }
    let bytes = super::bounded_body(response, 128 * 1024 * 1024).await?;
    if !valid(&bytes, &hash) {
        return Err("ASSET_HASH_MISMATCH".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::create_dir_all(&directory).map_err(|_| "ASSET_CACHE_UNAVAILABLE")?;
        let mut file =
            tempfile::NamedTempFile::new_in(&directory).map_err(|_| "ASSET_CACHE_UNAVAILABLE")?;
        file.write_all(&bytes)
            .map_err(|_| "ASSET_CACHE_UNAVAILABLE")?;
        file.persist(directory.join(hash))
            .map_err(|_| "ASSET_CACHE_UNAVAILABLE")?;
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
    .map_err(|_| "ASSET_CACHE_UNAVAILABLE")?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_pinned_versions_are_allowed_but_arbitrary_urls_are_not() {
        assert!(expected_hash("https://piston-data.mojang.com/v1/objects/2dc72797acbc1b63fc16a11c4ac393605f453754/client.jar").is_some());
        assert!(expected_hash("https://piston-data.mojang.com/other.jar").is_none());
        assert!(expected_hash("http://localhost:18107/api/handshake").is_none());
    }
    #[test]
    fn corrupt_cache_is_not_a_successful_download() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = b"verified asset";
        let hash = format!("{:x}", Sha1::digest(bytes));
        std::fs::write(dir.path().join(&hash), bytes).unwrap();
        assert_eq!(read_cache(dir.path(), &hash).unwrap(), bytes);
        std::fs::write(dir.path().join(&hash), b"corrupt").unwrap();
        assert!(read_cache(dir.path(), &hash).is_none());
    }
}
