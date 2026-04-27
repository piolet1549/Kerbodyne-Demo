mod db;
mod geometry;
mod models;
mod offline_maps;
mod runtime;
mod server;

use std::{io, sync::Arc};

use models::{AppConfig, AppSnapshot, OfflineRegionCatalog, OfflineRegionManifest};
use runtime::AppRuntime;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
async fn bootstrap_app(state: State<'_, Arc<AppRuntime>>) -> Result<AppSnapshot, String> {
    Ok(state.snapshot().await)
}

#[tauri::command]
async fn update_config(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    config: AppConfig,
) -> Result<AppConfig, String> {
    state.apply_config(&app, config).await
}

#[tauri::command]
async fn list_offline_regions(
    state: State<'_, Arc<AppRuntime>>,
) -> Result<OfflineRegionCatalog, String> {
    state.list_offline_regions().await
}

#[tauri::command]
async fn select_offline_region(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    region_id: Option<String>,
) -> Result<AppConfig, String> {
    state.select_offline_region(&app, region_id).await
}

#[tauri::command]
async fn validate_offline_region(
    state: State<'_, Arc<AppRuntime>>,
    region_id: String,
) -> Result<OfflineRegionManifest, String> {
    state.validate_offline_region(region_id).await
}

#[tauri::command]
async fn start_live_ingest(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
) -> Result<(), String> {
    state.start_live_ingest(&app).await
}

#[tauri::command]
async fn complete_active_stream(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    save: bool,
    name: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    state
        .complete_active_stream(&app, save, name, description)
        .await
}

#[tauri::command]
async fn focus_session(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    session_id: String,
) -> Result<(), String> {
    state.focus_session(&app, session_id).await
}

#[tauri::command]
async fn clear_focused_session(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
) -> Result<(), String> {
    state.clear_focused_session(&app).await
}

#[tauri::command]
async fn update_session_details(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    session_id: String,
    name: String,
    description: Option<String>,
) -> Result<(), String> {
    state
        .update_session_details(&app, session_id, name, description)
        .await
}

#[tauri::command]
async fn delete_session(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    session_id: String,
) -> Result<(), String> {
    state.delete_session(&app, session_id).await
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let runtime = AppRuntime::initialize(app.handle())
                .map_err(|message| io::Error::new(io::ErrorKind::Other, message))?;
            runtime.start_background_tasks(app.handle().clone());
            app.manage(runtime);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap_app,
            update_config,
            list_offline_regions,
            select_offline_region,
            validate_offline_region,
            start_live_ingest,
            complete_active_stream,
            focus_session,
            clear_focused_session,
            update_session_details,
            delete_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running Kerbodyne Ground Station");
}
