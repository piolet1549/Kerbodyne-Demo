mod db;
mod geometry;
mod models;
mod offline_maps;
mod runtime;
mod server;

use std::{
    io,
    sync::{atomic::{AtomicBool, Ordering}, Arc},
};

use models::{AppConfig, AppSnapshot, OfflineRegionCatalog, OfflineRegionManifest};
use runtime::AppRuntime;
#[cfg(windows)]
use sysinfo::System;
use tauri::{AppHandle, Manager, RunEvent, State, WindowEvent};

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

#[tauri::command]
async fn export_session_telemetry(
    app: AppHandle,
    state: State<'_, Arc<AppRuntime>>,
    session_id: String,
) -> Result<String, String> {
    state.export_session_telemetry(&app, session_id).await
}

#[cfg(windows)]
fn terminate_stale_ground_station_processes() {
    let Ok(current_exe) = std::env::current_exe() else {
        return;
    };
    let current_pid = std::process::id();
    let current_name = current_exe
        .file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_else(|| "kerbodyne-ground-station.exe".to_string());

    let mut system = System::new_all();
    system.refresh_all();

    let current_exe_path = current_exe.to_string_lossy().to_ascii_lowercase();

    for _ in 0..10 {
        let mut killed_any = false;
        system.refresh_all();

        for (pid, process) in system.processes() {
            if pid.as_u32() == current_pid {
                continue;
            }

            let process_name = process.name().to_ascii_lowercase();
            let process_exe = process
                .exe()
                .map(|path| path.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            let same_executable = !process_exe.is_empty() && process_exe == current_exe_path;
            let matching_name = process_name == current_name;

            if !(same_executable || matching_name) {
                continue;
            }

            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.as_u32().to_string(), "/F", "/T"])
                .status();
            killed_any = true;
        }

        if !killed_any {
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(300));
    }
}

#[cfg(not(windows))]
fn terminate_stale_ground_station_processes() {}

static EXITING: AtomicBool = AtomicBool::new(false);

pub fn run() {
    terminate_stale_ground_station_processes();
    std::thread::sleep(std::time::Duration::from_millis(800));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if EXITING.swap(true, Ordering::SeqCst) {
                    return;
                }
                if let Some(runtime) = window.app_handle().try_state::<Arc<AppRuntime>>() {
                    tauri::async_runtime::block_on(runtime.shutdown(window.app_handle()));
                }
                window.app_handle().cleanup_before_exit();
                std::process::exit(0);
            }
        })
        .setup(|app| {
            let runtime = AppRuntime::initialize(app.handle())
                .map_err(|message| io::Error::new(io::ErrorKind::Other, message))?;
            runtime.start_background_tasks(app.handle().clone());
            app.manage(runtime);
            #[cfg(windows)]
            {
                std::thread::spawn(|| {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    terminate_stale_ground_station_processes();
                });
            }
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
            delete_session,
            export_session_telemetry
        ])
        .build(tauri::generate_context!())
        .expect("error while building Kerbodyne Ground Station");

    app.run(|app, event| match event {
        RunEvent::ExitRequested { .. } => {
            if EXITING.swap(true, Ordering::SeqCst) {
                return;
            }
            if let Some(runtime) = app.try_state::<Arc<AppRuntime>>() {
                tauri::async_runtime::block_on(runtime.shutdown(app));
            }
        }
        RunEvent::Exit => {
            app.cleanup_before_exit();
        }
        _ => {}
    });
}
