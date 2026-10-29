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

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

use claude_code_cn_lib::MAIN_WINDOW_LABEL;

/// Handshake prefix printed by the bridge once it is listening.
const READY_PREFIX: &str = "CCCN_READY ";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(90);

/**
 * The port the bridge listens on.
 *
 * Stable rather than OS-assigned so the phone URL survives a restart. Matches the fallback the web
 * client already assumes when no shell injected a URL.
 */
const BRIDGE_PORT: &str = "43130";

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

/// Restart the whole application (menu bar → 重启).
///
/// `restart` runs the normal exit path first, and that path kills the bridge child — which is why
/// this must go through the shell rather than through the bridge: a child process cannot re-exec the
/// parent, and a second bridge left running behind a new one would hold the same port range and the
/// same session list.
#[tauri::command]
fn shell_restart(app: tauri::AppHandle) {
    app.restart();
}

/// Exit the application (menu bar → 退出).
///
/// 0 rather than a failure code: the user asked for this, so it is a normal outcome, and a non-zero
/// exit is what Windows reports as a crash in the event log.
#[tauri::command]
fn shell_quit(app: tauri::AppHandle) {
    app.exit(0);
}

/// Open the webview's developer tools (menu bar → 开发者工具).
///
/// Requires the `devtools` feature on the tauri crate — in a release build the API is compiled out
/// without it, and the menu entry would fail with a confusing "command not found".
#[tauri::command]
fn shell_devtools(window: tauri::WebviewWindow) -> Result<(), String> {
    window.open_devtools();
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Startup diagnostics
// ---------------------------------------------------------------------------------------------

/// Where a GUI-subsystem process can leave a trace.
///
/// A release build is a WINDOWS subsystem binary (`windows_subsystem = "windows"` above), so it has
/// no console: everything the shell writes — including a panic message — goes to a null handle. The
/// user is then left with a double-click that closes in a split second and no way to find out why.
/// A file under `%LOCALAPPDATA%` plus a message box is the only channel that reaches the person who
/// double-clicked.
fn shell_log_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("TEMP").map(PathBuf::from))?;
    Some(base.join("ChinaClaude").join("logs").join("shell.log"))
}

/// Append one timestamped line to `shell.log`. Best effort: diagnostics must never be the reason a
/// startup fails, so every IO error here is dropped.
fn append_shell_log(message: &str) {
    let Some(path) = shell_log_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| format!("{}.{:03}", elapsed.as_secs(), elapsed.subsec_millis()))
        .unwrap_or_else(|_| "?".to_string());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/// Raise a blocking message box.
///
/// `MessageBoxW` is declared here instead of pulling in the `windows`/`windows-sys` crate: `user32`
/// is linked into every Windows process anyway, and the shell stays dependency-free.
///
/// Called from a panic hook, so it must not panic itself (no unwraps, no allocation of anything
/// that can fail).
#[cfg(windows)]
fn alert(message: &str) {
    use std::os::windows::ffi::OsStrExt;

    const MB_OK: u32 = 0x0000_0000;
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }

    let wide = |text: &str| -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let body = wide(message);
    let caption = wide("ChinaClaude 启动失败");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        );
    }
}

#[cfg(not(windows))]
fn alert(message: &str) {
    eprintln!("{message}");
}

/// Report a fatal startup problem the way the user can see it, then exit.
///
/// This replaces the bare `.expect(...)` that used to sit on `Builder::build`: a panic in a
/// console-less process is invisible, which is what made a missing sidecar look like "the icon does
/// nothing".
fn fail_startup(error: &str) -> ! {
    append_shell_log(&format!("startup failed: {error}"));
    let log = shell_log_path()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "(unavailable)".to_string());
    alert(&format!(
        "ChinaClaude 无法启动。\n\n{error}\n\n诊断日志：{log}"
    ));
    std::process::exit(1)
}

/// Turn an unexpected panic into something the user can read and report.
///
/// Installed before the Tauri builder runs so it also covers failures inside `setup`.
fn install_panic_hook() {
    let fallback = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let payload = info.payload();
        let message = payload
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic payload".to_string());
        let location = info
            .location()
            .map(|at| format!("{}:{}:{}", at.file(), at.line(), at.column()))
            .unwrap_or_default();
        append_shell_log(&format!("panic at {location}: {message}"));
        alert(&format!(
            "ChinaClaude 遇到内部错误，已退出。\n\n{message}\n({location})"
        ));
        fallback(info);
    }));
}

// ---------------------------------------------------------------------------------------------
// Sidecar resolution
// ---------------------------------------------------------------------------------------------

/// Does `dir` hold a bridge entry, i.e. is it a sidecar directory at all?
fn has_bridge(dir: &Path) -> bool {
    dir.join("bridge").join("cli.mjs").is_file()
}

/// Resolve the staged sidecar directory, packaged layouts first.
///
/// THE ORDER IS LOAD-BEARING. `tauri.conf.json` lists `resources/sidecar/...` in `bundle.resources`,
/// and the bundler writes those paths verbatim under the resource root — so an installed app keeps
/// its runtime at `<install>/resources/sidecar/...`. Meanwhile Tauri's `resource_dir()` on Windows
/// is the directory holding the exe, NOT a `resources/` subdirectory. Looking only at
/// `<resource_dir>/sidecar` therefore misses every installed build; that is the bug this order
/// fixes. `<resource_dir>/sidecar` stays as the second candidate for a flattened layout and for
/// anyone running the exe out of a hand-assembled folder.
///
/// The checkout fallback is DEBUG-ONLY on purpose. `CARGO_MANIFEST_DIR` is baked in at compile
/// time, so a release binary built on one machine resolves the sidecar inside *that* machine's
/// checkout — which exists for the developer and for nobody else. That is precisely how a release
/// could launch fine here and die silently on someone else's computer.
fn resolve_sidecar(resource_root: Option<&Path>) -> Result<(PathBuf, &'static str), String> {
    let mut tried: Vec<String> = Vec::new();

    if let Some(root) = resource_root {
        let bundled = root.join("resources").join("sidecar");
        if has_bridge(&bundled) {
            return Ok((bundled, "resource_dir/resources/sidecar"));
        }
        tried.push(bundled.display().to_string());

        let flattened = root.join("sidecar");
        if has_bridge(&flattened) {
            return Ok((flattened, "resource_dir/sidecar"));
        }
        tried.push(flattened.display().to_string());
    }

    #[cfg(debug_assertions)]
    {
        let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("sidecar");
        if has_bridge(&checkout) {
            return Ok((checkout, "cargo-manifest-dir/resources/sidecar"));
        }
        tried.push(checkout.display().to_string());
    }

    Err(format!(
        "找不到 bridge 运行时（sidecar）。请先执行 `pnpm --dir packages/desktop prepare:sidecar` 再打包。已尝试：{}",
        tried.join(" ; ")
    ))
}

/// Resolve the staged runtime directory for a running app.
fn sidecar_dir(app: &tauri::App) -> Result<PathBuf, String> {
    let resource_root = app.path().resource_dir().ok();
    resolve_sidecar(resource_root.as_deref()).map(|(dir, _candidate)| dir)
}

/// `--self-check`: resolve the sidecar for the INSTALLED layout and print it as JSON.
///
/// Runs before `tauri::Builder`, so packaging can assert the layout on any machine — a CI runner
/// included — without a webview, a window, or a bridge. Exit code 0 means "the exe next to these
/// resources can find its runtime"; 1 means it would have died at startup.
///
/// The `candidate` field is what makes this a real check: `resource_dir/resources/sidecar` is the
/// installed layout, while anything else (notably the checkout fallback) means the exe is only
/// working because of the machine it was built on.
fn self_check() -> i32 {
    let exe = std::env::current_exe().ok();
    let resource_root = exe.as_ref().and_then(|path| path.parent()).map(Path::to_path_buf);
    let expected = resource_root
        .as_ref()
        .map(|dir| dir.join("resources").join("sidecar"));

    match resolve_sidecar(resource_root.as_deref()) {
        Ok((dir, candidate)) => {
            // Finding the layout is not enough: the app hands `spawn_bridge` the path that Tauri's
            // `resource_dir()` produces, which on Windows is the VERBATIM form (`\\?\C:\...`).
            // A Node resolver that rejects that form still passes the layout check and then dies
            // on the user's machine, so prove the handshake here too — with the same path form.
            let verbatim = verbatim_form(&dir);
            let (bridge_ready, bridge_error) = match spawn_bridge(&verbatim) {
                Ok((mut child, _url)) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    (true, serde_json::Value::Null)
                }
                Err(error) => (false, serde_json::Value::String(error)),
            };

            println!(
                "{}",
                serde_json::json!({
                    "ok": bridge_ready,
                    "candidate": candidate,
                    "sidecar": dir.display().to_string(),
                    "expected": expected.as_ref().map(|path| path.display().to_string()),
                    "node": dir.join("node.exe").is_file(),
                    "bridgeReady": bridge_ready,
                    "bridgeError": bridge_error,
                    "exe": exe.as_ref().map(|path| path.display().to_string()),
                })
            );
            if bridge_ready {
                0
            } else {
                1
            }
        }
        Err(error) => {
            println!("{}", serde_json::json!({ "ok": false, "error": error }));
            1
        }
    }
}

/// The path form that Tauri's `resource_dir()` hands back on Windows: verbatim (`\\?\C:\...`).
fn verbatim_form(dir: &Path) -> PathBuf {
    let text = dir.to_string_lossy();
    if text.starts_with(r"\\?\") {
        return dir.to_path_buf();
    }
    if let Some(rest) = text.strip_prefix(r"\\") {
        return PathBuf::from(format!(r"\\?\UNC\{rest}"));
    }
    PathBuf::from(format!(r"\\?\{text}"))
}

/// Strip the Windows verbatim prefix (`\\?\`) so the path can be handed to Node.
fn plain_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        if let Some(unc) = rest.strip_prefix("UNC\\") {
            return PathBuf::from(format!(r"\\{unc}"));
        }
        return PathBuf::from(rest.to_string());
    }
    path.to_path_buf()
}

/// Start the bridge and wait for its handshake line.
fn spawn_bridge(dir: &PathBuf) -> Result<(Child, String), String> {
    // Why: Tauri's `resource_dir()` returns a VERBATIM path (`\\?\C:\...`) on Windows. Win32
    // accepts that, but Node's module resolver does not: it reduces the drive component to `C:`
    // and dies with `Error: EISDIR: illegal operation on a directory, lstat 'C:'` before any of
    // the bridge runs. No handshake, no window — and only on machines where the app runs from a
    // resource dir (an installed copy), never from a development checkout.
    let root = plain_path(dir);
    let node = root.join("node.exe");
    let entry = root.join("bridge").join("cli.mjs");

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
        // A FIXED PORT, not `--port 0`. Phone access hands the user a URL they will bookmark, and a
        // port that changes every launch would make that bookmark work only until the next restart.
        // The bridge falls back to an OS-assigned port if this one is taken, so a busy port degrades
        // to a working app rather than a failed launch (see `onListenError` in cli.mjs).
        .arg("--port")
        .arg(BRIDGE_PORT)
        .current_dir(&root)
        // The packaged runtime must not be treated as a sidecar by the bridge itself, and the
        // bridge must not have to GUESS where its own resources live: a development checkout
        // resolves `..` differently from an installed layout, which made the bundled-component
        // inventory report everything as missing.
        .env("CCCN_PACKAGED", "1")
        .env("CCCN_SIDECAR_DIR", &root)
        // The bridge answers "is there a newer release than this?" — so it has to be told what
        // "this" is. Taken from the crate version, which is the same number the installer carries,
        // rather than duplicated as a literal that could drift.
        .env("CCCN_APP_VERSION", claude_code_cn_lib::VERSION)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Without this the console-subsystem runtime gets a visible console window of its own.
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    append_shell_log(&format!(
        "[spawn] node={} entry={} cwd={}",
        node.display(),
        entry.display(),
        root.display()
    ));
    // Log what actually reaches the process, not just the argument we were handed — and keep the
    // verbatim input visible, because "it started from `\\?\…` and still worked" is exactly the
    // fact a future reader needs to confirm `plain_path` did its job.
    if dir != &root {
        append_shell_log(&format!("[spawn] normalized from {}", dir.display()));
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn bridge: {error}"))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "bridge stdout was not captured".to_string())?;

    // Why: without this, a bridge that dies on start-up shows up as "bridge exited before
    // reporting ready" and nothing else — an installed copy failing on another machine would
    // report nothing actionable. Keep the tail of its own stderr and put it in the dialog.
    let tail: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    if let Some(stderr) = child.stderr.take() {
        let sink = Arc::clone(&tail);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                append_shell_log(&format!("[bridge-stderr] {line}"));
                let mut guard = sink.lock().unwrap_or_else(|error| error.into_inner());
                guard.push(line);
                if guard.len() > 20 {
                    guard.remove(0);
                }
            }
        });
    }

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
            Err(with_stderr_tail(error, &tail))
        }
        Err(_) => {
            let _ = child.kill();
            Err(with_stderr_tail(
                "timed out waiting for the bridge to report ready".to_string(),
                &tail,
            ))
        }
    }
}

/// Attach whatever the bridge wrote to stderr before it died, so the failure names itself.
fn with_stderr_tail(error: String, tail: &Arc<Mutex<Vec<String>>>) -> String {
    // The reader thread may still be draining the pipe as the process exits; give it a moment.
    let deadline = std::time::Instant::now() + Duration::from_millis(400);
    loop {
        let has_lines = tail
            .lock()
            .map(|guard| !guard.is_empty())
            .unwrap_or(true);
        if has_lines || std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    let lines = tail
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_default();
    if lines.is_empty() {
        return error;
    }
    format!("{error}\n\nbridge 输出：\n{}", lines.join("\n"))
}

fn main() {
    // Packaging self-check first: it must work on a machine with no webview, no bridge and no
    // window, because that is exactly the machine (a CI runner) that has to prove the layout.
    if std::env::args().skip(1).any(|arg| arg == "--self-check") {
        std::process::exit(self_check());
    }

    install_panic_hook();

    let app = match tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            bridge_info,
            shell_restart,
            shell_quit,
            shell_devtools
        ])
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
    {
        Ok(app) => app,
        // `?` inside `setup` (missing sidecar, bridge that never reports ready, window that fails
        // to build) lands here. Reporting it is the whole point: the old `.expect(...)` panicked
        // into a console the release build does not have, so the app vanished without a trace.
        Err(error) => fail_startup(&format!("外壳初始化失败：{error}")),
    };

    app.run(|app_handle, event| {
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
