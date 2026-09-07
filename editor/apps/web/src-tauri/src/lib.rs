use reqwest::{redirect::Policy, Client, Method, Url};
use serde::Serialize;
use std::time::Duration;
use tauri::{Emitter, Manager};
mod app_menu;

#[cfg(target_os = "macos")]
mod mac_chrome;

const MAX_JSON: usize = 2 * 1024 * 1024;

fn client(timeout: u64) -> Result<Client, String> {
    Client::builder()
        .redirect(Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|_| "NETWORK_UNAVAILABLE".into())
}

fn endpoint(base: &str) -> Result<String, String> {
    let url = Url::parse(base).map_err(|_| "INVALID_API_URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || base.contains(['%', '\\'])
        || base.split('/').any(|part| part == "." || part == "..")
    {
        return Err("INVALID_API_URL".into());
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

async fn bounded_body(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("RESPONSE_TOO_LARGE".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "NETWORK_UNAVAILABLE")? {
        if bytes.len() + chunk.len() > limit {
            return Err("RESPONSE_TOO_LARGE".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: String,
}

// Narrow transport only: no listening socket, sidecar, compiler, database, shell, or filesystem RPC.
#[tauri::command]
async fn plugin_request(
    base_url: String,
    token: String,
    path: String,
    method: String,
    body: Option<String>,
    protocol: Option<String>,
) -> Result<ApiResponse, String> {
    let base = endpoint(&base_url)?;
    if !token.is_empty()
        && (!(32..=256).contains(&token.len())
            || !token
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"_~+/.=-".contains(&c)))
    {
        return Err("INVALID_TOKEN".into());
    }
    let allowed = matches!(
        (method.as_str(), path.as_str()),
        ("GET", "/api/handshake" | "/api/v2/document")
            | ("PUT", "/api/v2/document")
            | ("POST", "/api/v2/preview")
    );
    if !allowed || body.as_ref().is_some_and(|value| value.len() > MAX_JSON) {
        return Err("INVALID_REQUEST".into());
    }
    if path != "/api/handshake" && protocol.as_deref() != Some("2.0") {
        return Err("PROTOCOL_INCOMPATIBLE".into());
    }
    let mut request = client(15)?.request(
        Method::from_bytes(method.as_bytes()).map_err(|_| "INVALID_REQUEST")?,
        base + &path,
    );
    if !token.is_empty() {
        request = request.bearer_auth(token);
    }
    if let Some(protocol) = protocol {
        request = request.header("X-Itemerness-Protocol", protocol);
    }
    if let Some(body) = body {
        request = request
            .header("Content-Type", "application/json")
            .body(body);
    }
    let response = request.send().await.map_err(|_| "NETWORK_UNAVAILABLE")?;
    if response.status().is_redirection() {
        return Err("REDIRECT_FORBIDDEN".into());
    }
    let status = response.status().as_u16();
    let bytes = bounded_body(response, MAX_JSON + 1024).await?;
    let body = String::from_utf8(bytes).map_err(|_| "INVALID_API_RESPONSE")?;
    Ok(ApiResponse { status, body })
}

fn allowed_asset(url: &str) -> bool {
    let manifest: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../../tools/font-metrics/26.1.2.sources.json"
    ))
    .expect("bundled asset manifest");
    if ["client", "assetIndex"]
        .iter()
        .any(|key| manifest[key]["url"].as_str() == Some(url))
    {
        return true;
    }
    manifest["assetResources"]
        .as_object()
        .expect("assetResources")
        .values()
        .any(|value| {
            let hash = value.as_str().expect("asset hash");
            url == format!(
                "https://resources.download.minecraft.net/{}/{}",
                &hash[..2],
                hash
            )
        })
}

#[tauri::command]
async fn download_asset(url: String) -> Result<tauri::ipc::Response, String> {
    if !allowed_asset(&url) {
        return Err("ASSET_URL_FORBIDDEN".into());
    }
    let response = client(120)?
        .get(url)
        .send()
        .await
        .map_err(|_| "NETWORK_UNAVAILABLE")?;
    if !response.status().is_success() {
        return Err("ASSET_DOWNLOAD_FAILED".into());
    }
    Ok(tauri::ipc::Response::new(
        bounded_body(response, 128 * 1024 * 1024).await?,
    ))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|_app| {
            app_menu::install(_app)?;
            #[cfg(target_os = "macos")]
            {
                let window = _app
                    .get_webview_window("main")
                    .ok_or("Main window is unavailable")?;
                mac_chrome::apply(&window)?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id().as_ref() == "save-document" {
                if let Err(error) = app.emit_to("main", "editor-save", ()) {
                    eprintln!("Could not dispatch Save: {error}");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            plugin_request,
            download_asset,
            app_menu::update_editor_menu,
            app_menu::confirm_editor_exit
        ])
        .build(tauri::generate_context!())
        .expect("could not run Itemerness Editor")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app
                    .state::<app_menu::EditorMenuState>()
                    .guard_ready
                    .load(std::sync::atomic::Ordering::Acquire)
                    && !app
                        .state::<app_menu::EditorMenuState>()
                        .exit_allowed
                        .load(std::sync::atomic::Ordering::Acquire)
                    && app.get_webview_window("main").is_some()
                {
                    api.prevent_exit();
                    if let Err(error) = app.emit_to("main", "editor-exit-requested", ()) {
                        eprintln!("Could not dispatch exit confirmation: {error}");
                    }
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    fn http_fixture(
        status: &str,
        body: &str,
        extra: &str,
    ) -> (String, std::thread::JoinHandle<String>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
            body.len()
        );
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, handle)
    }

    #[tokio::test]
    async fn native_transport_sends_bearer_auth_and_does_not_follow_redirects() {
        let (url, request) = http_fixture("200 OK", "{}", "Content-Type: application/json\r\n");
        let result = plugin_request(
            url,
            "a".repeat(48),
            "/api/handshake".into(),
            "GET".into(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.status, 200);
        assert_eq!(result.body, "{}");
        let sent = request.join().unwrap().to_lowercase();
        assert!(sent.starts_with("get /api/handshake http/1.1"));
        assert!(sent.contains(&format!("authorization: bearer {}", "a".repeat(48))));
        let (url, request) =
            http_fixture("302 Found", "", "Location: http://127.0.0.1:1/secret\r\n");
        let result = plugin_request(
            url,
            "a".repeat(48),
            "/api/handshake".into(),
            "GET".into(),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(error) if error == "REDIRECT_FORBIDDEN"));
        request.join().unwrap();
    }

    #[test]
    fn endpoints_allow_direct_http_and_https_without_credentials_or_traversal() {
        for url in [
            "http://localhost:18087/",
            "http://127.0.0.1:18087",
            "http://[::1]:18087",
            "http://192.168.1.10:18087",
            "http://10.0.0.25:18087",
            "http://[2001:db8::1]:18087",
            "http://server.example.com:18087/items/",
            "https://example.com/items/",
        ] {
            assert!(endpoint(url).is_ok(), "{url}");
        }
        for url in [
            "https://user@example.com",
            "http://user:secret@192.168.1.10:18087",
            "https://example.com?token=x",
            "http://192.168.1.10:18087/#fragment",
            "file:///tmp/api",
            "https://example.com/../admin",
            "https://example.com/%2e",
        ] {
            assert!(endpoint(url).is_err(), "{url}");
        }
    }

    #[tokio::test]
    async fn empty_token_omits_authorization_in_native_requests() {
        let (url, request) = http_fixture("200 OK", "{}", "Content-Type: application/json\r\n");
        let result = plugin_request(
            url,
            String::new(),
            "/api/handshake".into(),
            "GET".into(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.status, 200);
        assert!(!request
            .join()
            .unwrap()
            .to_lowercase()
            .contains("authorization:"));
    }

    #[test]
    fn asset_transport_is_pinned_not_a_general_proxy() {
        assert!(allowed_asset("https://piston-data.mojang.com/v1/objects/4e618f09a0c649dde3fdf829df443ce0b8831e65/client.jar"));
        assert!(!allowed_asset("https://piston-data.mojang.com/other.jar"));
        assert!(!allowed_asset("http://127.0.0.1:18087/api/handshake"));
    }
}
