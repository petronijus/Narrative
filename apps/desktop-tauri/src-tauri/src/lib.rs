//! Narrative desktop app — the Tauri prototype beside the Electron shell
//! (apps/desktop, ADR 0015). It answers one question: can Narrative's shell
//! be a Tauri app (the system webview: WebKit on macOS and Linux, WebView2 on
//! Windows) instead of Electron (a bundled Chromium)? See README.md.
//!
//! What it does, the way the Electron shell does it:
//!   - one window that loads the editor from a Narrative server (the shell
//!     carries no editor of its own);
//!   - `window.narrativeDesktop`, bridge version 1 (packages/shared/src/desktop.ts),
//!     with `info()` and `signIn()` working and the rest inert;
//!   - the system-browser sign-in: a PKCE verifier and a state nonce, the
//!     server's `/auth/start?client=desktop…` in the browser, the ticket back
//!     through `<scheme>://auth/complete`, and the redeem — posted here, with
//!     no `Origin` and the `X-Narrative-Desktop` header the server requires
//!     (routes/desktopAuth.ts `isDesktopRedeemSource`), its session cookie
//!     put into the webview's cookie store;
//!   - navigation kept on the server; any other web link opens in the browser.
//!
//! Not here (the Electron shell's, if this is taken further): the native menu,
//! opened .pptx files, presentation placement, signed self-updates, packaging.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::webview::Cookie;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

/// The server's OAuth state cookie lives 10 minutes (apps/server/src/routes/auth.ts).
const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
/// One page cannot open unlimited browser tabs.
const START_COOLDOWN: Duration = Duration::from_secs(5);
/// The bridge the editor feature-detects (DESKTOP_BRIDGE_VERSION).
const BRIDGE: &str = include_str!("bridge.js");

/// Which server the window loads, and where its API answers.
#[derive(Clone, Debug)]
struct Server {
    origin: Url,
    api: Url,
    /// The custom scheme the server hands the ticket to: production only the release build's.
    scheme: &'static str,
}

impl Server {
    /// `--server=dev|prod|<https origin>`, else `NARRATIVE_SERVER`, else the
    /// build's own: a release build the production server, a debug build the
    /// local dev stack.
    fn from_args() -> Server {
        let default = if cfg!(debug_assertions) { "dev" } else { "prod" };
        let arg = std::env::args()
            .find_map(|a| a.strip_prefix("--server=").map(str::to_owned))
            .or_else(|| std::env::var("NARRATIVE_SERVER").ok())
            .unwrap_or_else(|| default.to_owned());
        match arg.as_str() {
            "dev" => Server {
                origin: Url::parse("http://localhost:5173").unwrap(),
                // The dev stack serves the API on its own port (apps/desktop/servers.json).
                api: Url::parse("http://localhost:3001").unwrap(),
                scheme: "narrative-dev",
            },
            "prod" => Server::hosted("https://narrative.bastla.com"),
            other => Server::hosted(other),
        }
    }

    /// A deployed server: the API under `/api` (the Caddy layout).
    fn hosted(origin: &str) -> Server {
        let origin = Url::parse(origin).expect("--server: an https origin");
        assert_eq!(origin.scheme(), "https", "--server: only https servers");
        let api = origin.join("/api").unwrap();
        Server { origin, api, scheme: "narrative" }
    }

    fn api_path(&self, path: &str) -> String {
        format!("{}{}", self.api.as_str().trim_end_matches('/'), path)
    }

    /// Whether the window may navigate to `url`: the server (or, in dev, its API).
    fn owns(&self, url: &Url) -> bool {
        url.origin() == self.origin.origin() || url.origin() == self.api.origin()
    }
}

/// A sign-in this shell started and is waiting to hear back from.
struct Pending {
    verifier: String,
    state: String,
    started: Instant,
}

#[derive(Default)]
struct SignIn {
    pending: Mutex<Option<Pending>>,
    last_start: Mutex<Option<Instant>>,
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes) // 43 characters, the server's verifier and state shape
}

fn s256(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Constant-time equality, so a wrong state reveals nothing by its timing.
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A same-origin path the server will send the person back to (its own `isSafeReturnTo`).
fn safe_return_to(value: &str) -> bool {
    value.starts_with('/')
        && !value.starts_with("//")
        && value.len() < 500
        && !value.chars().any(|c| c.is_control() || c == '\\')
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopInfo {
    app_version: String,
    platform: &'static str,
    role: &'static str,
}

#[tauri::command]
fn info(app: AppHandle) -> DesktopInfo {
    DesktopInfo {
        app_version: app.package_info().version.to_string(),
        platform: match std::env::consts::OS {
            "macos" => "darwin",
            "windows" => "win32",
            _ => "linux",
        },
        role: "main",
    }
}

/// Start the sign-in in the system browser; 'refused' right after another start.
#[tauri::command]
fn sign_in(app: AppHandle, return_to: String) -> Result<&'static str, String> {
    if !safe_return_to(&return_to) {
        return Err("returnTo: a path on the server".into());
    }
    let state = app.state::<SignIn>();
    let now = Instant::now();
    {
        let mut last = state.last_start.lock().unwrap();
        if last.is_some_and(|t| now.duration_since(t) < START_COOLDOWN) {
            return Ok("refused");
        }
        *last = Some(now);
    }
    let server = app.state::<Server>();
    let verifier = random_token();
    let nonce = random_token();
    let mut url = Url::parse(&server.api_path("/auth/start")).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client", "desktop")
        .append_pair("scheme", server.scheme)
        .append_pair("code_challenge", &s256(&verifier))
        .append_pair("code_challenge_method", "S256")
        .append_pair("desktop_state", &nonce)
        .append_pair("returnTo", &return_to);
    // A new start replaces a pending one.
    *state.pending.lock().unwrap() = Some(Pending { verifier, state: nonce, started: now });
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|e| e.to_string())?;
    Ok("opened")
}

/// `<scheme>://auth/complete?ticket=…&state=…` — taken only for this shell's own pending sign-in.
fn complete(app: &AppHandle, link: &Url) {
    let server = app.state::<Server>().inner().clone();
    if link.scheme() != server.scheme || link.host_str() != Some("auth") || link.path() != "/complete" {
        eprintln!("[sign-in] ignored a link that is not a sign-in answer");
        return;
    }
    let query = |key: &str| link.query_pairs().find(|(k, _)| k == key).map(|(_, v)| v.into_owned());
    let (Some(ticket), Some(state)) = (query("ticket"), query("state")) else {
        return;
    };
    // The verifier and state are used once, whatever the outcome.
    let Some(pending) = app.state::<SignIn>().pending.lock().unwrap().take() else {
        eprintln!("[sign-in] ignored an answer to no pending sign-in");
        return;
    };
    if pending.started.elapsed() > PENDING_TTL || !same(&pending.state, &state) {
        eprintln!("[sign-in] ignored an answer to another sign-in");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let target = match redeem(&app, &server, &ticket, &pending.verifier).await {
            Ok(target) => target,
            Err(reason) => {
                eprintln!("[sign-in] redeem failed: {reason}");
                server.origin.join("/auth/error?reason=desktop_sign_in_failed").unwrap()
            }
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.navigate(target);
            let _ = window.set_focus();
        }
    });
}

/// POST the ticket and verifier to the server; put its session cookie into the
/// webview. Returns where the server sends the person next.
async fn redeem(app: &AppHandle, server: &Server, ticket: &str, verifier: &str) -> Result<Url, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .post(server.api_path("/auth/desktop/redeem"))
        // The shell's own request: no Origin, and the header no form can send.
        .header("X-Narrative-Desktop", "1")
        .form(&[("ticket", ticket), ("verifier", verifier)])
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_redirection() {
        return Err(format!("status {}", response.status()));
    }
    let location = response
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .ok_or("no Location")?;
    let target = server.origin.join(location).map_err(|e| e.to_string())?;
    if !server.owns(&target) {
        return Err("redirect off the server".into());
    }
    let window = app.get_webview_window("main").ok_or("no window")?;
    let mut stored = 0;
    for value in response.headers().get_all(reqwest::header::SET_COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        let Ok(mut cookie) = Cookie::parse(text.to_owned()) else { continue };
        // A host-only cookie of the API's host (in dev `localhost`, which the
        // editor's origin shares: cookies are per host, not per port).
        if cookie.domain().is_none() {
            cookie.set_domain(server.api.host_str().unwrap_or_default().to_owned());
        }
        if cookie.path().is_none() {
            cookie.set_path("/");
        }
        window.set_cookie(cookie).map_err(|e| e.to_string())?;
        stored += 1;
    }
    if stored == 0 {
        return Err("no session cookie".into());
    }
    Ok(target)
}

/// WebKitGTK's DMA-BUF renderer takes the window down at start on NVIDIA's
/// driver under Wayland ("Error 71 (Protocol error) dispatching to Wayland
/// display", seen on the RTX 5090 desktop, 2026-10-16). Turn it off there —
/// before GTK starts — unless the person set it themselves.
fn work_around_nvidia_wayland() {
    #[cfg(target_os = "linux")]
    {
        const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
        let nvidia = std::path::Path::new("/proc/driver/nvidia").exists();
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some();
        if nvidia && wayland && std::env::var_os(VAR).is_none() {
            std::env::set_var(VAR, "1");
            eprintln!("[shell] NVIDIA on Wayland: {VAR}=1");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    work_around_nvidia_wayland();
    let server = Server::from_args();
    eprintln!("[shell] server {} (api {}, scheme {})", server.origin, server.api, server.scheme);

    tauri::Builder::default()
        // First: a second launch (the OS opening a deep link) hands its URL to
        // this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(server.clone())
        .manage(SignIn::default())
        .invoke_handler(tauri::generate_handler![info, sign_in])
        .setup(move |app| {
            // Linux and a Windows dev build register the schemes at runtime;
            // macOS takes them from the bundle's Info.plist.
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            app.deep_link().register_all()?;

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    complete(&handle, &url);
                }
            });

            let nav_server = server.clone();
            let opener = app.handle().clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(server.origin.clone()))
                .title("Narrative")
                .inner_size(1440.0, 900.0)
                .min_inner_size(960.0, 600.0)
                .initialization_script(BRIDGE)
                .on_navigation(move |url| {
                    if nav_server.owns(url) || url.scheme() == "about" {
                        return true;
                    }
                    // Web links leave the app for the system browser; nothing else opens.
                    if matches!(url.scheme(), "http" | "https" | "mailto") {
                        let _ = opener.opener().open_url(url.as_str(), None::<&str>);
                    }
                    false
                })
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Narrative desktop app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn challenge_is_the_s256_of_the_verifier() {
        // The server's own s256 (apps/server/src/auth/pkce.ts, Node's
        // createHash('sha256')…digest('base64url')) gives this for the input.
        assert_eq!(
            s256("dBjftJeZ4CVP-mB92K1uhbF1ZRcR6ITpmF6DPlbtqNw"),
            "eMw1QvkTbEbxEQMcLWxXUbUec-xELv8qcbV0B35Cl9E"
        );
        let v = random_token();
        assert_eq!(v.len(), 43);
        assert_ne!(v, random_token());
    }

    #[test]
    fn return_to_stays_on_the_server() {
        assert!(safe_return_to("/deck/abc"));
        assert!(!safe_return_to("//evil.example"));
        assert!(!safe_return_to("https://evil.example"));
        assert!(!safe_return_to("/a\\b"));
    }

    #[test]
    fn states_compare_whole() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "ab"));
    }

    #[test]
    fn dev_keeps_the_editor_and_its_api() {
        let s = Server {
            origin: Url::parse("http://localhost:5173").unwrap(),
            api: Url::parse("http://localhost:3001").unwrap(),
            scheme: "narrative-dev",
        };
        assert!(s.owns(&Url::parse("http://localhost:5173/deck/x").unwrap()));
        assert!(s.owns(&Url::parse("http://localhost:3001/auth/start").unwrap()));
        assert!(!s.owns(&Url::parse("https://example.com/").unwrap()));
        assert_eq!(s.api_path("/auth/desktop/redeem"), "http://localhost:3001/auth/desktop/redeem");
        let p = Server::hosted("https://narrative.example");
        assert_eq!(p.api_path("/auth/start"), "https://narrative.example/api/auth/start");
    }
}
