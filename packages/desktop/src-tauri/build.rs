fn main() {
    // tauri-build only re-runs when tauri.conf.json changes, so editing the .ico alone leaves the
    // PREVIOUS icon embedded in the exe — and the bundled installer picks up the new one, which
    // makes the installer and the app disagree. Watch the icon explicitly.
    println!("cargo:rerun-if-changed=icons/Claudecode-CN.ico");
    // Same trap, different asset: the webview's HTML/JS/CSS are embedded via `generate_context!`,
    // which is only re-expanded when this crate recompiles. Rebuilding `web/dist` alone therefore
    // leaves the PREVIOUS UI baked into the exe, so a rebuilt installer ships stale frontend code.
    // Watching the dist directory forces the crate to rebuild and re-embed the current UI.
    println!("cargo:rerun-if-changed=../../web/dist");
    tauri_build::build()
}
