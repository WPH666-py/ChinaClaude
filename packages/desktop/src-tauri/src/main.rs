//! Tauri shell for the Claude Code CN desktop client.
//!
//! Responsibilities, and deliberately nothing else:
//!   1. own the lifetime of the Node bridge child process (the "sidecar")
//!   2. learn the bridge port from its `CCCN_READY {...}` handshake
//!   3. inject that URL into the webview before the app boots
//!   4. kill the child when the app exits
//!
//! All UI traffic goes straight from the webview to `127.0.0.1:<port>`, so the shell never
//! proxies or parses it. That is the whole reason this design can drop Electron's custom
//! protocol and its framed IPC pipe transport.

// Build the release binary as a WINDOWS (GUI) subsystem program.
//
// WITHOUT THIS THE APP SHIPS ITS OWN BLACK CONSOLE WINDOW. Rust's default for a `bin` target is the
// console subsystem, so Windows allocates a console for the process at launch — and because this is
// a GUI program that never writes to it, what the user sees is an empty black window titled with
// the exe path, sitting next to the app for its whole lifetime. Verified in the PE header:
// subsystem 3 (CONSOLE) before, 2 (WINDOWS) after.
//
// Kept off in debug builds on purpose: `tauri dev` then still prints bridge/handshake errors to the
// terminal, which is where a developer wants them.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use claude_code_cn_lib::MAIN_WINDOW_LABEL;

/// Handshake prefix printed by the bridge once it is listening.
const READY_PREFIX: &str = "CCCN_READY ";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);

/// Windows `CREATE_NO_WINDOW`.
///
/// This shell is a GUI-subsystem process, and the sidecar is `node.exe` — a CONSOLE-subsystem
/// program. Spawning a console program from a GUI process makes Windows allocate a brand new
/// console, so a black command-prompt box appears next to the app and stays for the whole session.
/// The child still gets working stdin/stdout/stderr pipes; it just gets no visible console.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Logical window size. Tauri sizes windows in PHYSICAL pixels, so on a high-DPI display
/// these values must be scaled by the monitor scale factor or the webview ends up with a
/// viewport of only `size / scale` CSS pixels — at 200% scaling a 1280px window renders a
/// 640px-wide layout, which clips any centred content.
const WINDOW_WIDTH: f64 = 1280.0;
const WINDOW_HEIGHT: f64 = 840.0;
const WINDOW_MIN_WIDTH: f64 = 900.0;
const WINDOW_MIN_HEIGHT: f64 = 600.0;

/// Owns the bridge child so it cannot outlive the app.
struct BridgeProcess(Mutex<Option<Child>>);

impl Drop for BridgeProcess {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.0.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

/// Resolved bridge coordinates, shared with the frontend on request.
#[derive(Clone, serde::Serialize)]
struct BridgeInfo {
    url: String,
    /// True when we attached to a bridge that was already running (development mode).
    external: bool,
}

#[tauri::command]
fn bridge_info(info: tauri::State<'_, BridgeInfo>) -> BridgeInfo {
    info.inner().clone()
}

/// Resolve the staged runtime directory.
///
/// One directory serves both cases: `src-tauri/resources/sidecar` is the dev-time location
/// and is also what `bundle.resources` copies to `<install>/resources/sidecar`.
fn sidecar_dir(app: &tauri::App) -> Result<PathBuf, String> {
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("sidecar");
        if bundled.join("bridge").join("cli.mjs").is_file() {
            return Ok(bundled);
        }
    }
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let local = manifest.join("resources").join("sidecar");
    if local.join("bridge").join("cli.mjs").is_file() {
        return Ok(local);
    }
    Err(format!(
        "no sidecar runtime; run `node packages/desktop/scripts/prepare-sidecar.mjs` (looked in {} and the resource dir)",
        local.display()
    ))
}

/// Start the bridge and wait for its handshake line.
fn spawn_bridge(dir: &PathBuf) -> Result<(Child, String), String> {
    let node = dir.join("node.exe");
    let entry = dir.join("bridge").join("cli.mjs");

    if !node.is_file() {
        return Err(format!("bundled node runtime missing at {}", node.display()));
    }
    if !entry.is_file() {
        return Err(format!("bridge entry missing at {}", entry.display()));
    }

    // Bound to a local: the chained builder yields a `&mut Command` borrowed from a temporary,
    // and `creation_flags` below needs it to outlive that statement.
    let mut command = Command::new(&node);
    command
        .arg(&entry)
        .arg("--port")
        .arg("0")
        .current_dir(dir)
        // The packaged runtime must not be treated as a sidecar by the bridge itself, and the
        // bridge must not have to GUESS where its own resources live: a development checkout
        // resolves `..` differently from an installed layout, which made the bundled-component
        // inventory report everything as missing.
        .env("CCCN_PACKAGED", "1")
        .env("CCCN_SIDECAR_DIR", dir)
        // The bridge answers "is there a newer release than this?" — so it has to be told what
        // "this" is. Taken from the crate version, which is the same number the installer carries,
        // rather than duplicated as a literal that could drift.
        .env("CCCN_APP_VERSION", claude_code_cn_lib::VERSION)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Without this the console-subsystem runtime gets a visible console window of its own.
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn bridge: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "bridge stdout was not captured".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(text) => {
                    if let Some(rest) = text.strip_prefix(READY_PREFIX) {
                        let _ = tx.send(Ok(rest.to_string()));
                        return;
                    }
                }
                Err(error) => {
                    let _ = tx.send(Err(format!("reading bridge stdout failed: {error}")));
                    return;
                }
            }
        }
        let _ = tx.send(Err("bridge exited before reporting ready".to_string()));
    });

    match rx.recv_timeout(HANDSHAKE_TIMEOUT) {
        Ok(Ok(payload)) => {
            let parsed: serde_json::Value = serde_json::from_str(&payload)
                .map_err(|error| format!("bridge handshake was not JSON: {error}"))?;
            let url = parsed
                .get("url")
                .and_then(|value| value.as_str())
                .ok_or_else(|| "bridge handshake carried no url".to_string())?
                .to_string();
            Ok((child, url))
        }
        Ok(Err(error)) => {
            let _ = child.kill();
            Err(error)
        }
        Err(_) => {
            let _ = child.kill();
            Err("timed out waiting for the bridge to report ready".to_string())
        }
    }
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bridge_info])
        .setup(|app| {
            // Development escape hatch: attach to a bridge the developer already started
            // (for example to keep one session alive across reloads).
            let external = std::env::var("CCCN_BRIDGE_URL").ok();

            let (child, url) = match external {
                Some(url) => (None, url),
                None => {
                    let dir = sidecar_dir(app)?;
                    let (child, url) = spawn_bridge(&dir)?;
                    (Some(child), url)
                }
            };

            app.manage(BridgeProcess(Mutex::new(child)));
            app.manage(BridgeInfo {
                url: url.clone(),
                external: std::env::var("CCCN_BRIDGE_URL").is_ok(),
            });

            // Inject before any page script runs, so the Vue app can read it at module scope.
            let script = format!(
                "window.__CCCN_BRIDGE_URL__ = {};",
                serde_json::to_string(&url).unwrap_or_else(|_| "\"\"".to_string())
            );

            // The window is created here rather than in tauri.conf.json because the bridge
            // URL must be injected before the page loads. Declaring it in BOTH places makes
            // the label collide and setup panics ("a webview with label `main` already
            // exists"), so `app.windows` is intentionally absent from the config.
            let window = WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, WebviewUrl::default())
                .title("ChinaClaude")
                .inner_size(WINDOW_WIDTH, WINDOW_HEIGHT)
                .min_inner_size(WINDOW_MIN_WIDTH, WINDOW_MIN_HEIGHT)
                .center()
                .resizable(true)
                .background_color(tauri::window::Color(21, 21, 23, 255))
                .initialization_script(&script)
                .build()?;

            // Convert the logical target to physical pixels for this monitor, then clamp to
            // the work area so the window never opens larger than the screen.
            if let Ok(scale) = window.scale_factor() {
                if scale > 0.0 {
                    let mut width = WINDOW_WIDTH * scale;
                    let mut height = WINDOW_HEIGHT * scale;
                    if let Ok(Some(monitor)) = window.current_monitor() {
                        let area = monitor.work_area();
                        width = width.min(area.size.width as f64);
                        height = height.min(area.size.height as f64);
                    }
                    let _ = window.set_size(tauri::PhysicalSize::new(
                        width.round() as u32,
                        height.round() as u32,
                    ));
                    let _ = window.center();
                }
            }

            window.show()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Tauri application")
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } = event {
                // Dropping the state kills the bridge; do it explicitly so the child never
                // survives the window on a forced exit path.
                if let Some(state) = app_handle.try_state::<BridgeProcess>() {
                    if let Ok(mut guard) = state.0.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
