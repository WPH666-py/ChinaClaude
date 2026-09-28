fn main() {
    // tauri-build only re-runs when tauri.conf.json changes, so editing the .ico alone leaves the
    // PREVIOUS icon embedded in the exe — and the bundled installer picks up the new one, which
    // makes the installer and the app disagree. Watch the icon explicitly.
    println!("cargo:rerun-if-changed=icons/Claudecode-CN.ico");
    tauri_build::build()
}
