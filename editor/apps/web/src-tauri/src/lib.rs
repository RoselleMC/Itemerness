use reqwest::{redirect::Policy, Client, Method, Url};
use serde::Serialize;
use std::time::Duration;
use tauri::Manager;
mod app_menu;
mod asset_cache;
mod local_export;
mod resource_packs;
mod server_workspace;

#[cfg(target_os = "macos")]
mod mac_chrome;
#[cfg(target_os = "macos")]
mod mac_exit;

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
        (
            "GET",
            "/api/handshake" | "/api/v2/document" | "/api/v2/catalog"
        ) | ("PUT", "/api/v2/document" | "/api/v2/server")
            | ("POST", "/api/v2/preview" | "/api/v2/catalog/export")
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
    let bytes = bounded_body(response, MAX_JSON).await?;
    let body = String::from_utf8(bytes).map_err(|_| "INVALID_API_RESPONSE")?;
    Ok(ApiResponse { status, body })
}

fn allowed_asset(url: &str) -> bool {
    asset_cache::expected_hash(url).is_some()
}

#[tauri::command]
async fn download_asset(
    app: tauri::AppHandle,
    url: String,
) -> Result<tauri::ipc::Response, String> {
    if !allowed_asset(&url) {
        return Err("ASSET_URL_FORBIDDEN".into());
    }
    asset_cache::download(app, url).await
}

pub fn run() {
    tauri::Builder::default()
        .manage(resource_packs::PackSources::default())
        .manage(server_workspace::WorkspaceStorage::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            app_menu::install(_app)?;
            #[cfg(target_os = "windows")]
            if let Some(window) = _app.get_webview_window("main") {
                if let Some(monitor) = window.current_monitor()? {
                    let size = window.outer_size()?;
                    let work = monitor.work_area().size;
                    // Keep the bottom navigation above the taskbar on smaller desktops.
                    if size.width > work.width || size.height > work.height {
                        window.maximize()?;
                    }
                }
            }
            #[cfg(target_os = "macos")]
            {
                let window = _app
                    .get_webview_window("main")
                    .ok_or("Main window is unavailable")?;
                mac_chrome::apply(&window)?;
                mac_exit::install(_app.handle())?;
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            app_menu::dispatch(app, event.id().as_ref());
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                resource_packs::dropped(webview.app_handle(), paths);
            }
        })
        .invoke_handler(tauri::generate_handler![
            plugin_request,
            download_asset,
            resource_packs::pick_resource_packs,
            resource_packs::read_resource_pack,
            resource_packs::resource_pack_stamp,
            resource_packs::watch_resource_pack,
            resource_packs::release_resource_pack,
            server_workspace::load_server_workspace,
            server_workspace::save_server_workspace,
            local_export::save_editor_export,
            app_menu::update_editor_menu,
            app_menu::confirm_editor_exit,
            app_menu::cancel_editor_exit
        ])
        .build(tauri::generate_context!())
        .expect("could not run Itemerness Editor")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if app_menu::request_editor_exit(app) {
                    api.prevent_exit();
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
            stream
                .set_write_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut request = Vec::new();
            let mut byte = [0];
            while !request.ends_with(b"\r\n\r\n") {
                stream.read_exact(&mut byte).unwrap();
                request.push(byte[0]);
            }
            let _ = stream.write_all(response.as_bytes());
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

    #[tokio::test]
    async fn catalog_transport_allows_only_negotiated_read_and_export_routes() {
        for (method, path) in [
            ("GET", "/api/v2/catalog"),
            ("POST", "/api/v2/catalog/export"),
            ("PUT", "/api/v2/server"),
        ] {
            let (url, request) = http_fixture("200 OK", "{}", "");
            let result = plugin_request(
                url,
                String::new(),
                path.into(),
                method.into(),
                None,
                Some("2.0".into()),
            )
            .await
            .unwrap();
            assert_eq!(result.status, 200);
            let sent = request.join().unwrap().to_lowercase();
            assert!(sent.starts_with(&format!("{} {path} http/1.1", method.to_lowercase())));
            assert!(sent.contains("x-itemerness-protocol: 2.0"));
        }
        for (method, path) in [
            ("PUT", "/api/v2/catalog"),
            ("DELETE", "/api/v2/server"),
            ("GET", "/api/v2/catalog/export"),
            ("POST", "/api/v2/catalog/publish"),
            ("DELETE", "/api/v2/catalog"),
            ("GET", "/api/v2/catalog?file=config.yml"),
        ] {
            let result = plugin_request(
                "http://127.0.0.1:1".into(),
                String::new(),
                path.into(),
                method.into(),
                None,
                Some("2.0".into()),
            )
            .await;
            assert!(matches!(result, Err(error) if error == "INVALID_REQUEST"));
        }
        let result = plugin_request(
            "http://127.0.0.1:1".into(),
            String::new(),
            "/api/v2/catalog".into(),
            "GET".into(),
            None,
            None,
        )
        .await;
        assert!(matches!(result, Err(error) if error == "PROTOCOL_INCOMPATIBLE"));
    }

    #[tokio::test]
    async fn native_catalog_responses_keep_the_common_two_mebibyte_cap() {
        let (url, request) = http_fixture("200 OK", &"x".repeat(MAX_JSON + 1), "");
        let result = plugin_request(
            url,
            String::new(),
            "/api/v2/catalog".into(),
            "GET".into(),
            None,
            Some("2.0".into()),
        )
        .await;
        assert!(matches!(result, Err(error) if error == "RESPONSE_TOO_LARGE"));
        // The client can close as soon as Content-Length exceeds the cap.
        let _ = request.join();
    }
}
