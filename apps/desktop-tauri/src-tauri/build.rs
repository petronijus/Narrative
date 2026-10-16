fn main() {
    // The app's own commands get permissions (`allow-info`, `allow-sign-in`)
    // that capabilities/main.json grants to the server's pages.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["info", "sign_in"])),
    )
    .expect("tauri build");
}
