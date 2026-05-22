use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    process::{Child, Command},
    sync::{watch, Mutex, RwLock},
    time::{sleep, timeout, Duration},
};
use uuid::Uuid;

use crate::{
    db::Database,
    geometry::distance_m,
    models::{
        AlertPayload, AlertRecord, AppConfig, AppSnapshot, AircraftLiveState, BatterySummary,
        ConnectionHealth, ConnectionStatus, DEFAULT_AIRCRAFT_ID, LEGACY_ALERT_PORT,
        LEGACY_TELEMETRY_PORT, LegacyAlertPacket, LegacySystemStatusPacket,
        LegacyTelemetryPacket, LegacyTelemetryPacketType, MapAlertSector, MissionSession,
        OfflineRegionCatalog, OfflineRegionManifest, ReplayFrame, ReviewTelemetryFrame,
        RuntimeEvent, RuntimeMode, SCHEMA_VERSION, SessionVideoClip, SystemStatusPayload,
        SystemStatusRecord, TelemetryPayload, TrackPointRecord, VideoPreviewState,
        VideoPreviewStatus, WireEnvelope,
    },
    offline_maps,
    server::{
        spawn_legacy_alert_listener, spawn_legacy_telemetry_listener, spawn_offline_asset_server,
        spawn_websocket_server,
    },
};

const LEGACY_SOURCE_LABEL: &str = "legacy-live";
const WEBSOCKET_SOURCE_LABEL: &str = "websocket-live";
const MAX_RECENT_MESSAGE_IDS: usize = 256;
const MAX_WARNINGS: usize = 12;
const MAX_SESSION_HISTORY: usize = 200;
const MAX_RAW_TELEMETRY_PACKETS: usize = 160;
const LIVE_VIDEO_RTP_PORT: u16 = 5600;
const VIDEO_STALE_AFTER_SECS: i64 = 3;
const COMPAT_HF_STALE_SECS: i64 = 2;
const COMPAT_MF_STALE_SECS: i64 = 4;
const COMPAT_LF_STALE_SECS: i64 = 8;
const VIDEO_PREVIEW_PATH: &str = "/live.mjpg";
const VLC_HTTP_PROBE_INTERVAL_MS: u64 = 300;
const VLC_HTTP_PROBE_TIMEOUT_MS: u64 = 2200;
const VLC_SHUTDOWN_TIMEOUT_SECS: u64 = 8;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Clone, Default)]
struct CompatibilityTelemetryState {
    lat: Option<f64>,
    lon: Option<f64>,
    alt_m: Option<f64>,
    vspeed_ms: Option<f64>,
    ground_speed_ms: Option<f64>,
    heading_deg: Option<f64>,
    pitch_deg: Option<f64>,
    roll_deg: Option<f64>,
    armed: Option<bool>,
    flight_mode: Option<u32>,
    throttle_pct: Option<f64>,
    nav_pitch_deg: Option<f64>,
    nav_roll_deg: Option<f64>,
    alt_demanded_m: Option<f64>,
    vib_x: Option<f64>,
    vib_y: Option<f64>,
    vib_z: Option<f64>,
    battery_v: Option<f64>,
    battery_a: Option<f64>,
    battery_pct: Option<f64>,
    battery_mah: Option<f64>,
    cpu_temp_c: Option<f64>,
    cpu_pct: Option<f64>,
    cpu_mhz: Option<f64>,
    npu_temp_c: Option<f64>,
    vision_active: Option<bool>,
    extras: HashMap<String, Value>,
    has_split_packets: bool,
    last_hf_at: Option<DateTime<Utc>>,
    last_mf_at: Option<DateTime<Utc>>,
    last_lf_at: Option<DateTime<Utc>>,
    last_oc_at: Option<DateTime<Utc>>,
}

impl CompatibilityTelemetryState {
    fn clear(&mut self) {
        *self = Self::default();
    }

    fn apply_packet(&mut self, packet: &LegacyTelemetryPacket, received_at: DateTime<Utc>) {
        if packet.packet_type.is_some() {
            self.has_split_packets = true;
        }

        match packet.packet_type.unwrap_or(LegacyTelemetryPacketType::Unknown) {
            LegacyTelemetryPacketType::HighFrequency => self.last_hf_at = Some(received_at),
            LegacyTelemetryPacketType::MediumFrequency => self.last_mf_at = Some(received_at),
            LegacyTelemetryPacketType::LowFrequency => self.last_lf_at = Some(received_at),
            LegacyTelemetryPacketType::OnChange => self.last_oc_at = Some(received_at),
            LegacyTelemetryPacketType::Unknown => {}
        }

        update_if_some(&mut self.lat, packet.lat);
        update_if_some(&mut self.lon, packet.lon);
        update_if_some(&mut self.alt_m, packet.alt_m);
        update_if_some(&mut self.vspeed_ms, packet.vspeed_ms);
        update_if_some(&mut self.ground_speed_ms, packet.ground_speed_ms);
        update_if_some(&mut self.heading_deg, packet.heading_deg);
        update_if_some(&mut self.pitch_deg, packet.pitch_deg);
        update_if_some(&mut self.roll_deg, packet.roll_deg);
        update_if_some(&mut self.armed, packet.armed);
        update_if_some(&mut self.flight_mode, packet.flight_mode);
        update_if_some(&mut self.throttle_pct, packet.throttle_pct);
        update_if_some(&mut self.nav_pitch_deg, packet.nav_pitch_deg);
        update_if_some(&mut self.nav_roll_deg, packet.nav_roll_deg);
        update_if_some(&mut self.alt_demanded_m, packet.alt_demanded_m);
        update_if_some(&mut self.vib_x, packet.vib_x);
        update_if_some(&mut self.vib_y, packet.vib_y);
        update_if_some(&mut self.vib_z, packet.vib_z);
        update_if_some(&mut self.battery_v, packet.battery_v);
        update_if_some(&mut self.battery_a, packet.battery_a);
        update_if_some(&mut self.battery_pct, packet.battery_pct);
        update_if_some(&mut self.battery_mah, packet.battery_mah);
        update_if_some(&mut self.cpu_temp_c, packet.cpu_temp_c);
        update_if_some(&mut self.cpu_pct, packet.cpu_pct);
        update_if_some(&mut self.cpu_mhz, packet.cpu_mhz);
        update_if_some(&mut self.npu_temp_c, packet.npu_temp_c);
        update_if_some(&mut self.vision_active, packet.vision_active);

        for (key, value) in &packet.extras {
            self.extras.insert(key.clone(), value.clone());
        }
    }

    fn has_any_state(&self) -> bool {
        self.lat.is_some()
            || self.lon.is_some()
            || self.alt_m.is_some()
            || self.ground_speed_ms.is_some()
            || self.heading_deg.is_some()
            || self.armed.is_some()
            || self.flight_mode.is_some()
            || self.battery_v.is_some()
            || self.battery_pct.is_some()
            || self.battery_a.is_some()
            || self.battery_mah.is_some()
            || self.cpu_temp_c.is_some()
            || self.cpu_pct.is_some()
            || self.cpu_mhz.is_some()
            || self.npu_temp_c.is_some()
            || self.vision_active.is_some()
    }

    fn resolved_armed(&self) -> bool {
        self.armed.unwrap_or(!self.has_split_packets)
    }

    fn last_packet_at(&self) -> Option<DateTime<Utc>> {
        [
            self.last_hf_at.clone(),
            self.last_mf_at.clone(),
            self.last_lf_at.clone(),
            self.last_oc_at.clone(),
        ]
        .into_iter()
        .flatten()
        .max()
    }

    fn tier_is_current(
        &self,
        last_seen: Option<DateTime<Utc>>,
        window_seconds: i64,
        now: &DateTime<Utc>,
    ) -> bool {
        last_seen
            .map(|timestamp| now.signed_duration_since(timestamp).num_seconds() <= window_seconds)
            .unwrap_or(false)
    }

    fn build_connection_note(&self, now: &DateTime<Utc>) -> String {
        if !self.has_any_state() {
            return "Telemetry packet received; awaiting aircraft state".into();
        }

        let mut missing = Vec::new();
        if self.has_split_packets {
            if !self.tier_is_current(self.last_hf_at.clone(), COMPAT_HF_STALE_SECS, now) {
                missing.push("high-rate");
            }
            if !self.tier_is_current(self.last_mf_at.clone(), COMPAT_MF_STALE_SECS, now) {
                missing.push("medium-rate");
            }
            if !self.tier_is_current(self.last_lf_at.clone(), COMPAT_LF_STALE_SECS, now) {
                missing.push("low-rate");
            }
        }

        if missing.is_empty() {
            "Receiving split compatibility telemetry".into()
        } else {
            format!(
                "Receiving split compatibility telemetry; awaiting {} packets",
                missing.join(", ")
            )
        }
    }

    fn to_payload(&self, packet_type: Option<LegacyTelemetryPacketType>) -> TelemetryPayload {
        let armed = self.resolved_armed();
        let mut extras = self.extras.clone();

        if let Some(packet_type) = packet_type {
            let packet_type_label = match packet_type {
                LegacyTelemetryPacketType::HighFrequency => "hf",
                LegacyTelemetryPacketType::MediumFrequency => "mf",
                LegacyTelemetryPacketType::LowFrequency => "lf",
                LegacyTelemetryPacketType::OnChange => "oc",
                LegacyTelemetryPacketType::Unknown => "unknown",
            };
            extras.insert(
                "legacy_packet_type".into(),
                Value::String(packet_type_label.to_string()),
            );
        }

        insert_optional_number(&mut extras, "vspeed_ms", self.vspeed_ms);
        insert_optional_number(&mut extras, "pitch_deg", self.pitch_deg);
        insert_optional_number(&mut extras, "roll_deg", self.roll_deg);
        insert_optional_number(&mut extras, "flight_mode", self.flight_mode.map(|value| value as f64));
        insert_optional_number(&mut extras, "throttle_pct", self.throttle_pct);
        insert_optional_number(&mut extras, "nav_pitch_deg", self.nav_pitch_deg);
        insert_optional_number(&mut extras, "nav_roll_deg", self.nav_roll_deg);
        insert_optional_number(&mut extras, "alt_demanded_m", self.alt_demanded_m);
        insert_optional_number(&mut extras, "vib_x", self.vib_x);
        insert_optional_number(&mut extras, "vib_y", self.vib_y);
        insert_optional_number(&mut extras, "vib_z", self.vib_z);
        insert_optional_number(&mut extras, "battery_a", self.battery_a);
        insert_optional_number(&mut extras, "battery_mah", self.battery_mah);
        insert_optional_number(&mut extras, "cpu_temp_c", self.cpu_temp_c);
        insert_optional_number(&mut extras, "cpu_pct", self.cpu_pct);
        insert_optional_number(&mut extras, "cpu_mhz", self.cpu_mhz);
        insert_optional_number(&mut extras, "npu_temp_c", self.npu_temp_c);
        insert_optional_bool(&mut extras, "vision_active", self.vision_active);
        extras.insert("legacy_armed".into(), Value::Bool(armed));

        TelemetryPayload {
            lat: if armed { self.lat } else { None },
            lon: if armed { self.lon } else { None },
            alt_msl_m: self.alt_m,
            groundspeed_mps: self.ground_speed_ms,
            heading_deg: self.heading_deg,
            flight_time_s: None,
            armed,
            battery: Some(BatterySummary {
                percent: self.battery_pct,
                voltage_v: self.battery_v,
            }),
            link: None,
            extras,
        }
    }
}

struct RecordingRunState {
    clip_id: String,
    session_id: String,
    started_at: String,
    mp4_path: PathBuf,
}

#[derive(Default)]
struct VideoRuntimeState {
    preview_monitor_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    preview_child: Option<Child>,
    recording: Option<RecordingRunState>,
    last_preview_frame_at: Option<DateTime<Utc>>,
    preview_http_port: Option<u16>,
    sdp_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub enum IngestSource {
    WebSocket,
    CompatibilityTelemetry,
    CompatibilityAlert,
}

impl IngestSource {
    fn mode(&self) -> RuntimeMode {
        RuntimeMode::Live
    }

    fn connection_status(&self) -> ConnectionStatus {
        match self {
            Self::WebSocket => ConnectionStatus::Live,
            Self::CompatibilityTelemetry => ConnectionStatus::ReceivingTelemetry,
            Self::CompatibilityAlert => ConnectionStatus::ReceivingAlert,
        }
    }

    fn source_label(&self) -> String {
        match self {
            Self::WebSocket => WEBSOCKET_SOURCE_LABEL.into(),
            Self::CompatibilityTelemetry | Self::CompatibilityAlert => LEGACY_SOURCE_LABEL.into(),
        }
    }

    fn note(&self) -> &'static str {
        match self {
            Self::WebSocket => "Receiving canonical live telemetry",
            Self::CompatibilityTelemetry => "Receiving compatibility telemetry on UDP 5001",
            Self::CompatibilityAlert => "Receiving compatibility TCP packets on port 5000",
        }
    }
}

pub struct AppRuntime {
    data_dir: PathBuf,
    media_dir: PathBuf,
    db: Database,
    config: RwLock<AppConfig>,
    asset_server_origin: RwLock<String>,
    mode: RwLock<RuntimeMode>,
    connection: RwLock<ConnectionHealth>,
    live_state: RwLock<Option<AircraftLiveState>>,
    alerts: RwLock<Vec<AlertRecord>>,
    system_statuses: RwLock<Vec<SystemStatusRecord>>,
    sessions: RwLock<Vec<MissionSession>>,
    track: RwLock<Vec<TrackPointRecord>>,
    session_has_armed_telemetry: RwLock<bool>,
    review_frames: RwLock<Vec<ReviewTelemetryFrame>>,
    review_video_clips: RwLock<Vec<SessionVideoClip>>,
    video_preview: RwLock<VideoPreviewState>,
    raw_telemetry_packets: RwLock<Vec<String>>,
    warnings: RwLock<Vec<String>>,
    recent_message_ids: Mutex<VecDeque<String>>,
    current_session_id: RwLock<Option<String>>,
    current_session_source: RwLock<Option<String>>,
    focused_session_id: RwLock<Option<String>>,
    compatibility_telemetry: RwLock<CompatibilityTelemetryState>,
    active_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    preview_frame_sender: watch::Sender<Option<Vec<u8>>>,
    latest_preview_frame: RwLock<Option<Vec<u8>>>,
    video_runtime: Mutex<VideoRuntimeState>,
    video_dir: PathBuf,
    vlc_path: RwLock<Option<PathBuf>>,
}

impl AppRuntime {
    pub fn initialize(app: &AppHandle) -> Result<Arc<Self>, String> {
        let data_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let media_dir = data_dir.join("alerts");
        fs::create_dir_all(&media_dir).map_err(|error| error.to_string())?;
        let video_dir = data_dir.join("recordings");
        fs::create_dir_all(&video_dir).map_err(|error| error.to_string())?;
        let (preview_frame_sender, _) = watch::channel(None);

        let database = Database::open(&data_dir.join("kerbodyne.db"))?;
        let mut config = database.load_config()?.unwrap_or_default();
        offline_maps::normalize_config(&mut config, &data_dir)?;
        database.save_config(&config)?;
        database.close_active_sessions(&Utc::now().to_rfc3339())?;
        database.delete_empty_sessions()?;
        let sessions = database.load_sessions(MAX_SESSION_HISTORY)?;
        let focused_session_id = None;
        let alerts = Vec::new();
        let system_statuses = Vec::new();
        let track = Vec::new();

        Ok(Arc::new(Self {
            data_dir,
            media_dir,
            db: database,
            connection: RwLock::new(ConnectionHealth::disconnected(config.listen_port)),
            config: RwLock::new(config),
            asset_server_origin: RwLock::new(String::new()),
            mode: RwLock::new(RuntimeMode::Idle),
            live_state: RwLock::new(None),
            alerts: RwLock::new(alerts),
            system_statuses: RwLock::new(system_statuses),
            sessions: RwLock::new(sessions),
            track: RwLock::new(track),
            session_has_armed_telemetry: RwLock::new(false),
            review_frames: RwLock::new(Vec::new()),
            review_video_clips: RwLock::new(Vec::new()),
            video_preview: RwLock::new(VideoPreviewState::default()),
            raw_telemetry_packets: RwLock::new(Vec::new()),
            warnings: RwLock::new(Vec::new()),
            recent_message_ids: Mutex::new(VecDeque::new()),
            current_session_id: RwLock::new(None),
            current_session_source: RwLock::new(None),
            focused_session_id: RwLock::new(focused_session_id),
            compatibility_telemetry: RwLock::new(CompatibilityTelemetryState::default()),
            active_tasks: Mutex::new(Vec::new()),
            preview_frame_sender,
            latest_preview_frame: RwLock::new(None),
            video_runtime: Mutex::new(VideoRuntimeState::default()),
            video_dir,
            vlc_path: RwLock::new(None),
        }))
    }

    pub fn start_background_tasks(self: &Arc<Self>, app: AppHandle) {
        match spawn_offline_asset_server(self.clone()) {
            Ok(asset_origin) => {
                *self.asset_server_origin.blocking_write() = asset_origin;
            }
            Err(error) => {
                eprintln!("Kerbodyne offline asset server failed to start: {error}");
            }
        }

        let port = self.config.blocking_read().listen_port;
        spawn_websocket_server(self.clone(), app.clone(), port);

        let runtime = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                sleep(Duration::from_secs(2)).await;
                let connection_changed = runtime.refresh_connection_health().await;
                let video_changed = runtime.refresh_video_health(&app).await;
                if connection_changed || video_changed {
                    let _ = runtime.emit_snapshot(&app).await;
                }
            }
        });
    }

    pub async fn snapshot(&self) -> AppSnapshot {
        AppSnapshot {
            config: self.config.read().await.clone(),
            mode: self.mode.read().await.clone(),
            connection: self.connection.read().await.clone(),
            active_session_id: self.current_session_id.read().await.clone(),
            active_session_has_armed_telemetry: *self.session_has_armed_telemetry.read().await,
            focused_session_id: self.focused_session_id.read().await.clone(),
            live_state: self.live_state.read().await.clone(),
            alerts: self.alerts.read().await.clone(),
            system_statuses: self.system_statuses.read().await.clone(),
            sessions: self.sessions.read().await.clone(),
            track: self.track.read().await.clone(),
            review_frames: self.review_frames.read().await.clone(),
            review_video_clips: self.review_video_clips.read().await.clone(),
            video_preview: self.video_preview.read().await.clone(),
            raw_telemetry_packets: self.raw_telemetry_packets.read().await.clone(),
            warnings: self.warnings.read().await.clone(),
        }
    }

    pub async fn emit_snapshot(&self, app: &AppHandle) -> Result<(), String> {
        app.emit(
            "kerbodyne://runtime",
            RuntimeEvent::Snapshot {
                snapshot: self.snapshot().await,
            },
        )
        .map_err(|error| error.to_string())
    }

    pub async fn push_warning(&self, app: &AppHandle, message: String) {
        {
            let mut warnings = self.warnings.write().await;
            warnings.insert(0, message.clone());
            warnings.truncate(MAX_WARNINGS);
        }

        let _ = app.emit(
            "kerbodyne://runtime",
            RuntimeEvent::Warning {
                message: message.clone(),
            },
        );
        let _ = self.emit_snapshot(app).await;
    }

    pub async fn apply_config(
        &self,
        app: &AppHandle,
        mut config: AppConfig,
    ) -> Result<AppConfig, String> {
        offline_maps::normalize_config(&mut config, &self.data_dir)?;
        let mut config_warnings = Vec::new();
        let mut valid_enabled_region_ids = Vec::new();

        for region_id in &config.enabled_region_ids {
            match offline_maps::load_region(&config, region_id) {
                Ok(_) => valid_enabled_region_ids.push(region_id.clone()),
                Err(error) => {
                    config_warnings.push(format!(
                        "Disabled unavailable offline region '{region_id}': {error}"
                    ));
                }
            }
        }
        config.enabled_region_ids = valid_enabled_region_ids;

        if let Some(region_id) = config.selected_region_id.clone() {
            if !config
                .enabled_region_ids
                .iter()
                .any(|enabled_region_id| enabled_region_id == &region_id)
            {
                config.selected_region_id = config.enabled_region_ids.first().cloned();
                config_warnings.push(format!(
                    "Cleared unavailable selected region '{region_id}'."
                ));
            }
        } else if !config.enabled_region_ids.is_empty() {
            config.selected_region_id = config.enabled_region_ids.first().cloned();
        }

        let previous_port = self.config.read().await.listen_port;
        self.db.save_config(&config)?;
        {
            let mut current_config = self.config.write().await;
            *current_config = config.clone();
        }
        {
            let mut connection = self.connection.write().await;
            connection.port = config.listen_port;
            if previous_port != config.listen_port {
                connection.note = Some(format!(
                    "WebSocket port updated to {}. Restart the app to rebind it.",
                    config.listen_port
                ));
            }
        }

        if previous_port != config.listen_port {
            self.push_warning(
                app,
                format!(
                    "WebSocket port changed from {previous_port} to {}. Restart the app to apply it.",
                    config.listen_port
                ),
            )
            .await;
        } else {
            self.emit_snapshot(app).await?;
        }

        if !config_warnings.is_empty() {
            self.push_warning(app, config_warnings.join(" ")).await;
        }

        Ok(config)
    }

    pub async fn list_offline_regions(&self) -> Result<OfflineRegionCatalog, String> {
        let config = self.config.read().await.clone();
        Ok(OfflineRegionCatalog {
            asset_origin: self.asset_server_origin.read().await.clone(),
            regions: offline_maps::list_regions(&config)?,
        })
    }

    pub async fn select_offline_region(
        &self,
        app: &AppHandle,
        region_id: Option<String>,
    ) -> Result<AppConfig, String> {
        let mut config = self.config.read().await.clone();
        let normalized_id = region_id
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());

        if let Some(region_id) = normalized_id.as_deref() {
            offline_maps::load_region(&config, region_id)?;
            if !config
                .enabled_region_ids
                .iter()
                .any(|enabled_region_id| enabled_region_id == region_id)
            {
                return Err(format!(
                    "Enable offline region '{region_id}' before selecting it."
                ));
            }
        }

        config.selected_region_id = normalized_id;
        self.db.save_config(&config)?;
        *self.config.write().await = config.clone();
        self.emit_snapshot(app).await?;
        Ok(config)
    }

    pub async fn validate_offline_region(
        &self,
        region_id: String,
    ) -> Result<OfflineRegionManifest, String> {
        let config = self.config.read().await.clone();
        offline_maps::load_region(&config, &region_id)
    }

    pub async fn resolve_offline_asset_path(
        &self,
        request_path: &str,
    ) -> Result<Option<PathBuf>, String> {
        let config = self.config.read().await.clone();
        offline_maps::resolve_asset_path(&config, request_path)
    }

    pub async fn start_live_ingest(&self, app: &AppHandle) -> Result<(), String> {
        let udp_socket = UdpSocket::bind(("0.0.0.0", LEGACY_TELEMETRY_PORT))
            .await
            .map_err(|error| {
                format!(
                    "Unable to bind UDP telemetry listener on port {}: {}",
                    LEGACY_TELEMETRY_PORT, error
                )
            })?;
        let tcp_listener = TcpListener::bind(("0.0.0.0", LEGACY_ALERT_PORT))
            .await
            .map_err(|error| {
                format!(
                    "Unable to bind TCP alert listener on port {}: {}",
                    LEGACY_ALERT_PORT, error
                )
            })?;

        self.prepare_for_new_manual_stream(app).await?;
        let session_id = self
            .begin_session(DEFAULT_AIRCRAFT_ID, LEGACY_SOURCE_LABEL)
            .await?;

        let runtime = app.state::<Arc<AppRuntime>>().inner().clone();
        let telemetry_handle = spawn_legacy_telemetry_listener(runtime.clone(), app.clone(), udp_socket);
        let alert_handle = spawn_legacy_alert_listener(runtime, app.clone(), tcp_listener);

        {
            let mut active_tasks = self.active_tasks.lock().await;
            active_tasks.push(telemetry_handle);
            active_tasks.push(alert_handle);
        }
        {
            *self.mode.write().await = RuntimeMode::Live;
            *self.connection.write().await = ConnectionHealth {
                status: ConnectionStatus::Listening,
                port: LEGACY_TELEMETRY_PORT,
                last_packet_at: None,
                note: Some(format!(
                    "Listening for airside downlink on UDP {} and TCP {}",
                    LEGACY_TELEMETRY_PORT, LEGACY_ALERT_PORT
                )),
            };
        }

        if let Err(error) = self.start_video_subsystem(app, &session_id).await {
            self.push_warning(app, error).await;
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn start_video_recording(&self, app: &AppHandle) -> Result<(), String> {
        let session_id = self
            .current_session_id
            .read()
            .await
            .clone()
            .ok_or_else(|| "No active flight to record.".to_string())?;
        self.start_video_recording_for_session(app, &session_id).await
    }

    pub async fn stop_video_recording(&self, app: &AppHandle) -> Result<(), String> {
        self.stop_video_recording_internal(app, true).await
    }

    pub async fn focus_session(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        if self.current_session_id.read().await.is_some() {
            return Err("Stop the active flight before reviewing saved flights.".into());
        }

        self.load_session_data(Some(session_id)).await?;
        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn clear_focused_session(&self, app: &AppHandle) -> Result<(), String> {
        if self.current_session_id.read().await.is_some() {
            return Err("Stop the active flight before leaving review mode.".into());
        }

        self.load_session_data(None).await?;
        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn update_session_details(
        &self,
        app: &AppHandle,
        session_id: String,
        name: String,
        description: Option<String>,
    ) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Save name cannot be empty.".into());
        }

        let normalized_description = normalize_optional_text(description);
        self.db
            .update_session_details(&session_id, trimmed, normalized_description.as_deref())?;
        {
            let mut sessions = self.sessions.write().await;
            if let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) {
                session.name = trimmed.to_string();
                session.description = normalized_description.clone();
            }
        }
        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn delete_session(
        &self,
        app: &AppHandle,
        session_id: String,
    ) -> Result<(), String> {
        if self.current_session_id.read().await.as_deref() == Some(session_id.as_str()) {
            return Err("Stop the active flight before deleting it.".into());
        }

        self.delete_session_internal(&session_id).await?;

        let next_focus = {
            let focused = self.focused_session_id.read().await.clone();
            if focused.as_deref() == Some(session_id.as_str()) {
                self.sessions.read().await.first().map(|session| session.id.clone())
            } else {
                focused
            }
        };
        self.load_session_data(next_focus).await?;
        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn export_session_telemetry(
        &self,
        app: &AppHandle,
        session_id: String,
    ) -> Result<String, String> {
        let session = self
            .sessions
            .read()
            .await
            .iter()
            .find(|entry| entry.id == session_id)
            .cloned()
            .ok_or_else(|| "Flight not found.".to_string())?;
        let replay_events = self.db.load_replay_events(&session_id)?;
        let downloads_dir = app
            .path()
            .download_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&downloads_dir).map_err(|error| error.to_string())?;
        let timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let file_name = format!(
            "{}-telemetry-{}.csv",
            sanitize_file_component(&session.name),
            timestamp
        );
        let path = downloads_dir.join(file_name);
        let mut rows = String::from(
            "recorded_at,message_id,aircraft_id,armed,lat,lon,alt_msl_m,groundspeed_mps,heading_deg,flight_time_s,battery_voltage_v,battery_percent,extras_json,raw_json\n",
        );

        for frame in replay_events {
            let Ok(envelope) = serde_json::from_str::<WireEnvelope<TelemetryPayload>>(&frame.envelope_json)
            else {
                continue;
            };
            if envelope.envelope_type != "telemetry" {
                continue;
            }
            let extras_json =
                serde_json::to_string(&envelope.payload.extras).map_err(|error| error.to_string())?;
            write_csv_row(
                &mut rows,
                &[
                    normalize_timestamp(&envelope.sent_at),
                    envelope.message_id,
                    envelope.aircraft_id,
                    envelope.payload.armed.to_string(),
                    csv_option_f64(envelope.payload.lat),
                    csv_option_f64(envelope.payload.lon),
                    csv_option_f64(envelope.payload.alt_msl_m),
                    csv_option_f64(envelope.payload.groundspeed_mps),
                    csv_option_f64(envelope.payload.heading_deg),
                    csv_option_f64(envelope.payload.flight_time_s),
                    csv_option_f64(
                        envelope
                            .payload
                            .battery
                            .as_ref()
                            .and_then(|battery| battery.voltage_v),
                    ),
                    csv_option_f64(
                        envelope
                            .payload
                            .battery
                            .as_ref()
                            .and_then(|battery| battery.percent),
                    ),
                    extras_json,
                    frame.envelope_json,
                ],
            );
        }

        fs::write(&path, rows).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }

    pub async fn complete_active_stream(
        &self,
        app: &AppHandle,
        save: bool,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<(), String> {
        let had_connection = self.connection.read().await.last_packet_at.is_some();
        let has_armed_telemetry = *self.session_has_armed_telemetry.read().await;
        let session_id = self
            .current_session_id
            .read()
            .await
            .clone()
            .ok_or_else(|| "No active flight to stop.".to_string())?;
        let has_armed_replay_events = self.db.session_has_armed_replay_events(&session_id)?;
        let should_save = save && had_connection && has_armed_telemetry && has_armed_replay_events;

        if should_save {
            let fallback_name = {
                self.sessions
                    .read()
                    .await
                    .iter()
                    .find(|session| session.id == session_id)
                    .map(|session| session.name.clone())
                    .unwrap_or_else(|| generate_session_name(Utc::now()))
            };
            let normalized_name = normalize_required_name(name, &fallback_name);
            let normalized_description = normalize_optional_text(description);
            self.db.update_session_details(
                &session_id,
                &normalized_name,
                normalized_description.as_deref(),
            )?;
            {
                let mut sessions = self.sessions.write().await;
                if let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) {
                    session.name = normalized_name;
                    session.description = normalized_description;
                }
            }
        }

        {
            let mut active_tasks = self.active_tasks.lock().await;
            for handle in active_tasks.drain(..) {
                handle.abort();
            }
        }

        self.stop_video_subsystem(app).await?;

        self.end_current_session().await?;
        *self.session_has_armed_telemetry.write().await = false;
        self.raw_telemetry_packets.write().await.clear();
        self.compatibility_telemetry.write().await.clear();

        {
            let mut mode = self.mode.write().await;
            *mode = RuntimeMode::Idle;
        }
        {
            let port = self.config.read().await.listen_port;
            let mut connection = self.connection.write().await;
            *connection = ConnectionHealth::disconnected(port);
            connection.note = Some(if should_save {
                "Flight saved".into()
            } else {
                "Flight discarded".into()
            });
        }
        {
            let preview_url = self.video_preview.read().await.preview_url.clone();
            *self.live_state.write().await = None;
            *self.video_preview.write().await = VideoPreviewState {
                preview_url,
                ..VideoPreviewState::default()
            };
        }

        if should_save {
            self.load_session_data(None).await?;
        } else {
            self.delete_session_internal(&session_id).await?;
            self.load_session_data(None).await?;
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn load_session_data(&self, session_id: Option<String>) -> Result<(), String> {
        let alerts = match session_id.as_deref() {
            Some(id) => self.db.load_alerts_for_session(id)?,
            None => Vec::new(),
        };
        let system_statuses = match session_id.as_deref() {
            Some(id) => self.db.load_system_statuses_for_session(id)?,
            None => Vec::new(),
        };
        let track = match session_id.as_deref() {
            Some(id) => self.db.load_track(id)?,
            None => Vec::new(),
        };
        let replay_events = match session_id.as_deref() {
            Some(id) => self.db.load_replay_events(id)?,
            None => Vec::new(),
        };
        let review_frames = review_frames_from_replay(replay_events.clone());
        let review_video_clips = match session_id.as_deref() {
            Some(id) => self.db.load_video_clips_for_session(id)?,
            None => Vec::new(),
        };
        let raw_packets = replay_events
            .into_iter()
            .map(|frame| frame.envelope_json)
            .collect::<Vec<_>>();

        *self.focused_session_id.write().await = session_id;
        *self.alerts.write().await = alerts;
        *self.system_statuses.write().await = system_statuses;
        *self.track.write().await = track;
        *self.review_frames.write().await = review_frames;
        *self.review_video_clips.write().await = review_video_clips;
        *self.raw_telemetry_packets.write().await = raw_packets;
        if self.current_session_id.read().await.is_none() {
            *self.live_state.write().await = None;
        }
        Ok(())
    }

    async fn prepare_for_new_manual_stream(&self, app: &AppHandle) -> Result<(), String> {
        {
            let mut active_tasks = self.active_tasks.lock().await;
            for handle in active_tasks.drain(..) {
                handle.abort();
            }
        }
        let _ = self.stop_video_subsystem(app).await;

        self.end_current_session().await?;
        self.db.delete_empty_sessions()?;
        *self.live_state.write().await = None;
        *self.focused_session_id.write().await = None;
        self.track.write().await.clear();
        self.alerts.write().await.clear();
        self.system_statuses.write().await.clear();
        *self.session_has_armed_telemetry.write().await = false;
        self.compatibility_telemetry.write().await.clear();
        self.review_frames.write().await.clear();
        self.review_video_clips.write().await.clear();
        self.raw_telemetry_packets.write().await.clear();
        *self.mode.write().await = RuntimeMode::Idle;
        let port = self.config.read().await.listen_port;
        *self.connection.write().await = ConnectionHealth::disconnected(port);
        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn refresh_connection_health(&self) -> bool {
        let stale_after_seconds = self.config.read().await.stale_after_seconds;
        if self.current_session_source.read().await.as_deref() == Some(LEGACY_SOURCE_LABEL) {
            return self
                .refresh_compatibility_connection_health(stale_after_seconds)
                .await;
        }

        let mut connection = self.connection.write().await;
        if !matches!(
            connection.status,
            ConnectionStatus::Live
                | ConnectionStatus::ReceivingTelemetry
                | ConnectionStatus::ReceivingAlert
        ) {
            return false;
        }

        let Some(last_packet_at) = connection.last_packet_at.clone() else {
            return false;
        };

        let Ok(last_packet_time) = parse_timestamp(&last_packet_at) else {
            return false;
        };

        if (Utc::now() - last_packet_time).num_seconds() > stale_after_seconds as i64 {
            connection.status = ConnectionStatus::Stale;
            connection.note = Some("Telemetry link is stale".into());
            return true;
        }

        false
    }

    async fn refresh_compatibility_connection_health(&self, stale_after_seconds: u64) -> bool {
        let now = Utc::now();
        let state = self.compatibility_telemetry.read().await.clone();
        let Some(last_packet_at) = state.last_packet_at() else {
            return false;
        };

        let next_status = if (now - last_packet_at).num_seconds() > stale_after_seconds as i64 {
            ConnectionStatus::Stale
        } else {
            ConnectionStatus::ReceivingTelemetry
        };
        let next_note = if next_status == ConnectionStatus::Stale {
            "Telemetry link is stale".to_string()
        } else {
            state.build_connection_note(&now)
        };
        let next_last_packet_at = Some(last_packet_at.to_rfc3339());

        let port = LEGACY_TELEMETRY_PORT;
        let mut connection = self.connection.write().await;
        let changed = connection.status != next_status
            || connection.port != port
            || connection.last_packet_at != next_last_packet_at
            || connection.note.as_deref() != Some(next_note.as_str());

        if changed {
            connection.status = next_status;
            connection.port = port;
            connection.last_packet_at = next_last_packet_at;
            connection.note = Some(next_note);
        }

        changed
    }

    async fn refresh_video_health(&self, app: &AppHandle) -> bool {
        let mut exited_log_path = None;
        let (preview_running, last_preview_frame_at, recording_active) = {
            let mut runtime = self.video_runtime.lock().await;
            if let Some(child) = runtime.preview_child.as_mut() {
                match child.try_wait() {
                    Ok(Some(_status)) => {
                        if let Some(handle) = runtime.preview_monitor_handle.take() {
                            handle.abort();
                        }
                        if let Some(sdp_path) = runtime.sdp_path.take() {
                            let _ = fs::remove_file(sdp_path);
                        }
                        runtime.preview_child = None;
                        runtime.last_preview_frame_at = None;
                        runtime.preview_http_port = None;
                        exited_log_path = runtime.log_path.clone();
                        runtime.log_path = None;
                    }
                    Err(_) => {
                        if let Some(handle) = runtime.preview_monitor_handle.take() {
                            handle.abort();
                        }
                        if let Some(sdp_path) = runtime.sdp_path.take() {
                            let _ = fs::remove_file(sdp_path);
                        }
                        runtime.preview_child = None;
                        runtime.last_preview_frame_at = None;
                        runtime.preview_http_port = None;
                        exited_log_path = runtime.log_path.clone();
                        runtime.log_path = None;
                    }
                    Ok(None) => {}
                }
            }

            (
                runtime.preview_child.is_some(),
                runtime.last_preview_frame_at,
                runtime.recording.is_some(),
            )
        };

        if let Some(log_path) = exited_log_path {
            let diagnostics = read_log_tail(&log_path, 12);
            let warning = diagnostics
                .map(|tail| format!("Live video runtime exited unexpectedly. {tail}"))
                .unwrap_or_else(|| "Live video runtime exited unexpectedly.".to_string());
            self.push_warning(app, warning).await;
        }

        let mut preview = self.video_preview.write().await;
        let next_status = if !preview_running {
            if preview.preview_url.is_some() {
                VideoPreviewStatus::Error
            } else {
                VideoPreviewStatus::Idle
            }
        } else if let Some(last_frame) = last_preview_frame_at {
            if (Utc::now() - last_frame).num_seconds() > VIDEO_STALE_AFTER_SECS {
                VideoPreviewStatus::Stale
            } else if recording_active {
                VideoPreviewStatus::Recording
            } else {
                VideoPreviewStatus::Live
            }
        } else {
            VideoPreviewStatus::WaitingForStream
        };

        let next_message = video_status_message(&next_status).to_string();
        let changed = preview.status != next_status
            || preview.message.as_deref() != Some(next_message.as_str())
            || preview.recording_active != recording_active;

        if changed {
            preview.status = next_status;
            preview.message = Some(next_message);
            preview.recording_active = recording_active;
            if !recording_active {
                preview.current_clip_id = None;
            }
        }

        changed
    }

    pub fn subscribe_preview_frames(&self) -> watch::Receiver<Option<Vec<u8>>> {
        self.preview_frame_sender.subscribe()
    }

    pub async fn latest_preview_frame(&self) -> Option<Vec<u8>> {
        self.latest_preview_frame.read().await.clone()
    }

    async fn stop_preview_process(&self) {
        let (monitor_handle, mut preview_child, sdp_path) = {
            let mut runtime = self.video_runtime.lock().await;
            (
                runtime.preview_monitor_handle.take(),
                runtime.preview_child.take(),
                runtime.sdp_path.take(),
            )
        };

        if let Some(handle) = monitor_handle {
            handle.abort();
        }

        if let Some(mut child) = preview_child.take() {
            if let Some(mut stdin) = child.stdin.take() {
                let _ = stdin.write_all(b"quit\n").await;
                let _ = stdin.flush().await;
            }

            if timeout(Duration::from_secs(VLC_SHUTDOWN_TIMEOUT_SECS), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }

        if let Some(sdp_path) = sdp_path {
            let _ = fs::remove_file(sdp_path);
        }

        let mut runtime = self.video_runtime.lock().await;
        runtime.preview_http_port = None;
        runtime.last_preview_frame_at = None;
        runtime.log_path = None;
    }

    async fn launch_preview_process(
        &self,
        app: &AppHandle,
        vlc_executable: &Path,
        recording_mp4_path: Option<&Path>,
    ) -> Result<(), String> {
        self.stop_preview_process().await;
        let preview_http_port = allocate_loopback_port()?;
        let sdp_path = self
            .video_dir
            .join(format!("live-preview-{}.sdp", preview_http_port));
        write_live_sdp(&sdp_path)?;
        let log_path = self
            .video_dir
            .join(format!("live-preview-{}.log", preview_http_port));
        let preview_child = spawn_vlc_preview_process(
            vlc_executable,
            &sdp_path,
            preview_http_port,
            recording_mp4_path,
            &log_path,
        )?;

        let (recording_active, current_clip_id) = {
            let runtime = self.video_runtime.lock().await;
            (
                runtime.recording.is_some(),
                runtime.recording.as_ref().map(|recording| recording.clip_id.clone()),
            )
        };

        {
            *self.video_preview.write().await = VideoPreviewState {
                status: VideoPreviewStatus::WaitingForStream,
                preview_url: Some(preview_stream_url(preview_http_port)),
                recording_active,
                current_clip_id,
                message: Some(video_status_message(&VideoPreviewStatus::WaitingForStream).to_string()),
            };
        }
        *self.latest_preview_frame.write().await = None;
        let _ = self.preview_frame_sender.send(None);

        let runtime_for_monitor = app.state::<Arc<AppRuntime>>().inner().clone();
        let app_for_monitor = app.clone();
        let preview_monitor_handle = tauri::async_runtime::spawn(async move {
            monitor_preview_stream(runtime_for_monitor, &app_for_monitor, preview_http_port).await;
        });

        let mut runtime = self.video_runtime.lock().await;
        runtime.preview_child = Some(preview_child);
        runtime.preview_monitor_handle = Some(preview_monitor_handle);
        runtime.last_preview_frame_at = None;
        runtime.preview_http_port = Some(preview_http_port);
        runtime.sdp_path = Some(sdp_path);
        runtime.log_path = Some(log_path);

        Ok(())
    }

    async fn start_video_subsystem(
        &self,
        app: &AppHandle,
        _session_id: &str,
    ) -> Result<(), String> {
        self.stop_video_subsystem(app).await?;

        let vlc_executable = resolve_vlc_executable(app).ok_or_else(|| {
            "Live video runtime unavailable: vlc.exe not found in bundled resources or PATH."
                .to_string()
        })?;
        *self.vlc_path.write().await = Some(vlc_executable.clone());
        self.launch_preview_process(app, &vlc_executable, None).await?;

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn stop_video_subsystem(&self, app: &AppHandle) -> Result<(), String> {
        let _ = self.stop_video_recording_internal(app, false).await;
        self.stop_preview_process().await;

        *self.video_preview.write().await = VideoPreviewState::default();
        *self.latest_preview_frame.write().await = None;
        let _ = self.preview_frame_sender.send(None);
        Ok(())
    }

    async fn start_video_recording_for_session(
        &self,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        let vlc_executable = self
            .vlc_path
            .read()
            .await
            .clone()
            .or_else(|| resolve_vlc_executable(app))
            .ok_or_else(|| "Live video runtime unavailable: vlc.exe not found.".to_string())?;

        let mut runtime = self.video_runtime.lock().await;
        if runtime.recording.is_some() {
            return Ok(());
        }

        let session_dir = self.video_dir.join(session_id);
        fs::create_dir_all(&session_dir).map_err(|error| error.to_string())?;
        let clip_id = Uuid::new_v4().to_string();
        let started_at = Utc::now().to_rfc3339();
        let mp4_path = session_dir.join(format!("{clip_id}.mp4"));
        let _ = fs::remove_file(&mp4_path);

        runtime.recording = Some(RecordingRunState {
            clip_id: clip_id.clone(),
            session_id: session_id.to_string(),
            started_at,
            mp4_path,
        });
        drop(runtime);
        let recording_output_path = self
            .video_runtime
            .lock()
            .await
            .recording
            .as_ref()
            .map(|recording| recording.mp4_path.clone())
            .ok_or_else(|| "Recording state was not initialized.".to_string())?;
        self.launch_preview_process(app, &vlc_executable, Some(&recording_output_path))
            .await?;
        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn stop_video_recording_internal(
        &self,
        app: &AppHandle,
        restart_preview: bool,
    ) -> Result<(), String> {
        let recording = {
            let mut runtime = self.video_runtime.lock().await;
            runtime.recording.take()
        };

        let Some(recording) = recording else {
            return Ok(());
        };
        self.stop_preview_process().await;

        let ended_at = Utc::now().to_rfc3339();
        let duration_ms = (parse_timestamp(&ended_at).unwrap_or_else(|_| Utc::now())
            - parse_timestamp(&recording.started_at).unwrap_or_else(|_| Utc::now()))
            .num_milliseconds()
            .max(0) as u64;
        let bytes_written = fs::metadata(&recording.mp4_path)
            .map(|metadata| metadata.len())
            .unwrap_or(0);

        if bytes_written > 0 {
            let clip = SessionVideoClip {
                id: recording.clip_id.clone(),
                session_id: recording.session_id.clone(),
                file_path: recording.mp4_path.to_string_lossy().to_string(),
                started_at: recording.started_at.clone(),
                ended_at: Some(ended_at),
                duration_ms,
                width: 1920,
                height: 1080,
                fps: 60.0,
                codec: "h264".into(),
                bytes: bytes_written,
            };
            self.db.upsert_session_video_clip(&clip)?;
            *self.sessions.write().await = self.db.load_sessions(MAX_SESSION_HISTORY)?;
            if self.focused_session_id.read().await.as_deref() == Some(recording.session_id.as_str()) {
                *self.review_video_clips.write().await =
                    self.db.load_video_clips_for_session(&recording.session_id)?;
            }
        }

        if restart_preview {
            let vlc_executable = self
                .vlc_path
                .read()
                .await
                .clone()
                .or_else(|| resolve_vlc_executable(app))
                .ok_or_else(|| "Live video runtime unavailable while restarting preview.".to_string())?;
            self.launch_preview_process(app, &vlc_executable, None).await?;
        } else {
            let mut preview = self.video_preview.write().await;
            preview.recording_active = false;
            preview.current_clip_id = None;
        }
        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn register_preview_activity(&self, app: &AppHandle) {
        let mut should_emit = false;
        let recording_active = {
            let mut runtime = self.video_runtime.lock().await;
            runtime.last_preview_frame_at = Some(Utc::now());
            runtime.recording.is_some()
        };
        {
            let mut preview = self.video_preview.write().await;
            let next_status = if recording_active {
                VideoPreviewStatus::Recording
            } else {
                VideoPreviewStatus::Live
            };
            if preview.status != next_status {
                preview.status = next_status.clone();
                preview.message = Some(video_status_message(&next_status).into());
                should_emit = true;
            }
        }
        if should_emit {
            let _ = self.emit_snapshot(app).await;
        }
    }

    pub async fn ingest_json(
        &self,
        app: &AppHandle,
        raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let value: Value = serde_json::from_str(raw_json).map_err(|error| error.to_string())?;
        let envelope_type = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "incoming envelope missing type".to_string())?;
        let message_id = value
            .get("message_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "incoming envelope missing message_id".to_string())?;
        let schema_version = value
            .get("schema_version")
            .and_then(Value::as_str)
            .unwrap_or_default();

        if !self.register_message_id(message_id).await {
            return Ok(());
        }

        if schema_version != SCHEMA_VERSION {
            self.push_warning(
                app,
                format!(
                    "Received schema version '{schema_version}'. Expected '{SCHEMA_VERSION}', attempting best-effort ingest."
                ),
            )
            .await;
        }

        match envelope_type {
            "telemetry" => {
                let envelope: WireEnvelope<TelemetryPayload> =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                self.ingest_telemetry(app, envelope, raw_json, source).await?;
            }
            "alert" => {
                let envelope: WireEnvelope<AlertPayload> =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                self.ingest_alert(app, envelope, raw_json, source).await?;
            }
            "system_status" => {
                let envelope: WireEnvelope<SystemStatusPayload> =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                self.ingest_system_status(app, envelope, raw_json, source)
                    .await?;
            }
            other => {
                self.push_warning(app, format!("Ignoring unknown envelope type '{other}'"))
                    .await;
            }
        }

        Ok(())
    }

    pub async fn ingest_legacy_telemetry(
        &self,
        app: &AppHandle,
        raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let packet: LegacyTelemetryPacket =
            serde_json::from_str(raw_json).map_err(|error| error.to_string())?;
        self.push_raw_telemetry_packet(raw_json).await;
        let now = Utc::now();
        let packet_type = packet.packet_type;
        let state = {
            let mut compatibility = self.compatibility_telemetry.write().await;
            compatibility.apply_packet(&packet, now);
            compatibility.clone()
        };

        let has_any_state = state.has_any_state();

        if !has_any_state {
            let _ = self
                .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
                .await;
            self.emit_snapshot(app).await?;
            return Ok(());
        }

        let sent_at = now.to_rfc3339();
        let message_id = format!("legacy-telemetry-{}", Uuid::new_v4());
        let payload = state.to_payload(packet_type);

        let canonical_raw_json = serde_json::to_string(&json!({
            "schema_version": SCHEMA_VERSION,
            "message_id": message_id,
            "aircraft_id": DEFAULT_AIRCRAFT_ID,
            "sent_at": sent_at,
            "type": "telemetry",
            "payload": payload
        }))
        .map_err(|error| error.to_string())?;

        self.ingest_json(app, &canonical_raw_json, source).await?;
        let connection_changed = self
            .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
            .await;
        if connection_changed {
            self.emit_snapshot(app).await?;
        }
        Ok(())
    }

    pub async fn ingest_legacy_alert(
        &self,
        app: &AppHandle,
        raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let value: Value = serde_json::from_str(raw_json).map_err(|error| error.to_string())?;
        let packet_type = value
            .get("packet_type")
            .and_then(Value::as_str)
            .unwrap_or("detection_alert");

        match packet_type {
            "detection_alert" => {
                let packet: LegacyAlertPacket =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                self.ingest_legacy_detection_alert_packet(app, packet, source)
                    .await
            }
            "system_status" => {
                let packet: LegacySystemStatusPacket =
                    serde_json::from_value(value).map_err(|error| error.to_string())?;
                self.ingest_legacy_system_status_packet(app, packet, source)
                    .await
            }
            other => {
                self.push_warning(
                    app,
                    format!("Ignoring unknown legacy TCP packet_type '{other}'"),
                )
                .await;
                Ok(())
            }
        }
    }

    async fn ingest_legacy_detection_alert_packet(
        &self,
        app: &AppHandle,
        packet: LegacyAlertPacket,
        source: IngestSource,
    ) -> Result<(), String> {
        let detected_at = normalize_timestamp(&packet.timestamp);
        let live_state = self.live_state.read().await.clone();
        let lat = packet
            .telemetry
            .lat
            .filter(|_| packet.telemetry.armed.unwrap_or(true))
            .or_else(|| live_state.as_ref().and_then(|state| state.lat))
            .ok_or_else(|| "legacy alert missing latitude".to_string())?;
        let lon = packet
            .telemetry
            .lon
            .filter(|_| packet.telemetry.armed.unwrap_or(true))
            .or_else(|| live_state.as_ref().and_then(|state| state.lon))
            .ok_or_else(|| "legacy alert missing longitude".to_string())?;
        let alt_msl_m = packet
            .telemetry
            .alt_m
            .or_else(|| live_state.as_ref().and_then(|state| state.alt_msl_m));
        let heading_deg = packet
            .telemetry
            .heading_deg
            .or_else(|| live_state.as_ref().and_then(|state| state.heading_deg));

        let mut extras = packet.extras;
        extras.insert(
            "legacy_detection_type".into(),
            Value::String(packet.detection_type.clone()),
        );
        extras.insert(
            "legacy_telemetry".into(),
            serde_json::to_value(&packet.telemetry).map_err(|error| error.to_string())?,
        );

        let payload = AlertPayload {
            class_label: normalize_class_label(&packet.detection_type),
            confidence: packet.confidence,
            detected_at: detected_at.clone(),
            lat,
            lon,
            alt_msl_m,
            bearing_deg: heading_deg,
            fov_deg: None,
            range_m: None,
            model_name: Some("legacy-airside".into()),
            image_format: Some("jpg".into()),
            image_base64: Some(packet.image_data),
            extras,
        };

        let canonical_raw_json = serde_json::to_string(&json!({
            "schema_version": SCHEMA_VERSION,
            "message_id": format!("legacy-alert-{}", Uuid::new_v4()),
            "aircraft_id": DEFAULT_AIRCRAFT_ID,
            "sent_at": detected_at,
            "type": "alert",
            "payload": payload
        }))
        .map_err(|error| error.to_string())?;

        self.ingest_json(app, &canonical_raw_json, source).await
    }

    async fn ingest_legacy_system_status_packet(
        &self,
        app: &AppHandle,
        packet: LegacySystemStatusPacket,
        source: IngestSource,
    ) -> Result<(), String> {
        let reported_at = normalize_timestamp(&packet.timestamp);
        let mut extras = packet.extras;
        extras.insert(
            "legacy_status".into(),
            Value::String(packet.status.clone()),
        );
        extras.insert(
            "legacy_telemetry".into(),
            serde_json::to_value(&packet.telemetry).map_err(|error| error.to_string())?,
        );

        let payload = SystemStatusPayload {
            status: packet.status,
            message: packet.message,
            reported_at: reported_at.clone(),
            lat: if packet.telemetry.armed.unwrap_or(true) {
                packet.telemetry.lat
            } else {
                None
            },
            lon: if packet.telemetry.armed.unwrap_or(true) {
                packet.telemetry.lon
            } else {
                None
            },
            alt_msl_m: packet.telemetry.alt_m,
            heading_deg: packet.telemetry.heading_deg,
            extras,
        };

        let canonical_raw_json = serde_json::to_string(&json!({
            "schema_version": SCHEMA_VERSION,
            "message_id": format!("legacy-system-status-{}", Uuid::new_v4()),
            "aircraft_id": DEFAULT_AIRCRAFT_ID,
            "sent_at": reported_at,
            "type": "system_status",
            "payload": payload
        }))
        .map_err(|error| error.to_string())?;

        self.ingest_json(app, &canonical_raw_json, source).await
    }

    async fn ingest_telemetry(
        &self,
        app: &AppHandle,
        envelope: WireEnvelope<TelemetryPayload>,
        canonical_raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let session_id = self
            .ensure_session(&envelope.aircraft_id, &source.source_label())
            .await?;
        if !matches!(source, IngestSource::CompatibilityTelemetry) {
            self.push_raw_telemetry_packet(canonical_raw_json).await;
        }
        let sent_at = normalize_timestamp(&envelope.sent_at);
        let position_available = envelope.payload.armed;
        let lat = if position_available {
            envelope.payload.lat
        } else {
            None
        };
        let lon = if position_available {
            envelope.payload.lon
        } else {
            None
        };

        let live_state = AircraftLiveState {
            aircraft_id: envelope.aircraft_id.clone(),
            lat,
            lon,
            alt_msl_m: envelope.payload.alt_msl_m,
            groundspeed_mps: envelope.payload.groundspeed_mps,
            heading_deg: envelope.payload.heading_deg,
            flight_time_s: envelope.payload.flight_time_s,
            armed: envelope.payload.armed,
            battery: envelope.payload.battery.clone(),
            link: envelope.payload.link.clone(),
            last_update_at: sent_at.clone(),
            extras: envelope.payload.extras.clone(),
        };

        *self.live_state.write().await = Some(live_state);
        if envelope.payload.armed {
            *self.session_has_armed_telemetry.write().await = true;
        }

        if matches!(source, IngestSource::CompatibilityTelemetry) {
            let _ = self
                .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
                .await;
        } else {
            self.update_runtime_status(source, &sent_at).await;
        }
        if envelope.payload.armed {
            self.record_event(&session_id, canonical_raw_json, &sent_at, false)
                .await?;
        }
        if let (Some(lat), Some(lon), Some(alt_msl_m)) = (lat, lon, envelope.payload.alt_msl_m) {
            self.maybe_store_track_point(
                &session_id,
                &sent_at,
                lat,
                lon,
                alt_msl_m,
                envelope.payload.heading_deg,
                envelope.payload.groundspeed_mps,
            )
            .await?;
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn ingest_alert(
        &self,
        app: &AppHandle,
        envelope: WireEnvelope<AlertPayload>,
        canonical_raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let session_id = self
            .ensure_session(&envelope.aircraft_id, &source.source_label())
            .await?;
        let config = self.config.read().await.clone();
        let sent_at = normalize_timestamp(&envelope.sent_at);
        let fallback_heading = self
            .live_state
            .read()
            .await
            .as_ref()
            .and_then(|state| state.heading_deg);
        let bearing = envelope
            .payload
            .bearing_deg
            .or(fallback_heading)
            .unwrap_or(0.0);
        let fov = envelope.payload.fov_deg.unwrap_or(config.default_fov_deg);
        let range = envelope.payload.range_m.unwrap_or(config.default_range_m);
        let image_path = self.save_alert_image(&envelope.message_id, &envelope.payload)?;

        let alert = AlertRecord {
            id: envelope.message_id.clone(),
            session_id: session_id.clone(),
            aircraft_id: envelope.aircraft_id.clone(),
            class_label: envelope.payload.class_label.clone(),
            confidence: envelope.payload.confidence,
            detected_at: normalize_timestamp(&envelope.payload.detected_at),
            alt_msl_m: envelope.payload.alt_msl_m,
            image_path,
            image_format: envelope.payload.image_format.clone(),
            sector: MapAlertSector {
                center_lat: envelope.payload.lat,
                center_lon: envelope.payload.lon,
                bearing_deg: bearing,
                fov_deg: fov,
                range_m: range,
            },
            model_name: envelope.payload.model_name.clone(),
            extras: envelope.payload.extras.clone(),
        };

        self.db.insert_alert(&alert, canonical_raw_json)?;
        {
            let mut alerts = self.alerts.write().await;
            alerts.insert(0, alert);
            alerts.truncate(50);
        }

        if matches!(source, IngestSource::CompatibilityAlert)
            && self.current_session_source.read().await.as_deref() == Some(LEGACY_SOURCE_LABEL)
        {
            let _ = self
                .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
                .await;
        } else {
            self.update_runtime_status(source, &sent_at).await;
        }
        self.record_event(&session_id, canonical_raw_json, &sent_at, true)
            .await?;
        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn ingest_system_status(
        &self,
        app: &AppHandle,
        envelope: WireEnvelope<SystemStatusPayload>,
        canonical_raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        let session_id = self
            .ensure_session(&envelope.aircraft_id, &source.source_label())
            .await?;
        let sent_at = normalize_timestamp(&envelope.sent_at);

        let record = SystemStatusRecord {
            id: envelope.message_id.clone(),
            session_id: session_id.clone(),
            aircraft_id: envelope.aircraft_id.clone(),
            status: envelope.payload.status.clone(),
            message: envelope.payload.message.clone(),
            reported_at: normalize_timestamp(&envelope.payload.reported_at),
            lat: envelope.payload.lat,
            lon: envelope.payload.lon,
            alt_msl_m: envelope.payload.alt_msl_m,
            heading_deg: envelope.payload.heading_deg,
            extras: envelope.payload.extras.clone(),
        };

        self.db.insert_system_status(&record, canonical_raw_json)?;
        {
            let mut system_statuses = self.system_statuses.write().await;
            system_statuses.insert(0, record.clone());
            system_statuses.truncate(40);
        }

        if matches!(source, IngestSource::CompatibilityAlert)
            && self.current_session_source.read().await.as_deref() == Some(LEGACY_SOURCE_LABEL)
        {
            let _ = self
                .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
                .await;
        } else {
            self.update_runtime_status(source, &sent_at).await;
        }
        self.record_event(&session_id, canonical_raw_json, &sent_at, false)
            .await?;

        if is_error_status(&record.status) {
            self.emit_snapshot(app).await?;
            return Ok(());
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn update_runtime_status(&self, source: IngestSource, sent_at: &str) {
        let port = match source {
            IngestSource::CompatibilityTelemetry => LEGACY_TELEMETRY_PORT,
            IngestSource::CompatibilityAlert => LEGACY_ALERT_PORT,
            _ => self.config.read().await.listen_port,
        };
        *self.mode.write().await = source.mode();
        *self.connection.write().await = ConnectionHealth {
            status: source.connection_status(),
            port,
            last_packet_at: Some(sent_at.to_string()),
            note: Some(source.note().into()),
        };
    }

    async fn begin_session(&self, aircraft_id: &str, source: &str) -> Result<String, String> {
        let now = Utc::now();
        let session = MissionSession {
            id: Uuid::new_v4().to_string(),
            name: generate_session_name(now),
            description: None,
            aircraft_id: aircraft_id.to_string(),
            source: source.to_string(),
            started_at: now.to_rfc3339(),
            ended_at: None,
            is_active: true,
            event_count: 0,
            alert_count: 0,
            storage_bytes: 0,
        };

        self.db.upsert_session(&session)?;
        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(0, session.clone());
            sessions.truncate(MAX_SESSION_HISTORY);
        }
        *self.current_session_id.write().await = Some(session.id.clone());
        *self.current_session_source.write().await = Some(session.source.clone());
        *self.focused_session_id.write().await = Some(session.id.clone());
        *self.session_has_armed_telemetry.write().await = false;

        Ok(session.id)
    }

    async fn ensure_session(&self, aircraft_id: &str, source: &str) -> Result<String, String> {
        let current_id = self.current_session_id.read().await.clone();
        let current_source = self.current_session_source.read().await.clone();

        if let (Some(id), Some(existing_source)) = (current_id, current_source) {
            if existing_source == source {
                return Ok(id);
            }
        }

        self.end_current_session().await?;
        self.begin_session(aircraft_id, source).await
    }

    async fn end_current_session(&self) -> Result<(), String> {
        let session_id = self.current_session_id.write().await.take();
        self.current_session_source.write().await.take();

        if let Some(session_id) = session_id {
            let ended_at = Utc::now().to_rfc3339();
            self.db.end_session(&session_id, &ended_at)?;
            let refreshed_sessions = self.db.load_sessions(MAX_SESSION_HISTORY)?;
            *self.sessions.write().await = refreshed_sessions;
        }

        Ok(())
    }

    async fn delete_session_internal(&self, session_id: &str) -> Result<(), String> {
        let (image_paths, video_paths) = self.db.delete_session(session_id)?;
        for image_path in image_paths {
            let _ = fs::remove_file(&image_path);
        }
        for video_path in video_paths {
            let _ = fs::remove_file(&video_path);
        }

        let mut sessions = self.sessions.write().await;
        sessions.retain(|session| session.id != session_id);
        Ok(())
    }

    async fn record_event(
        &self,
        session_id: &str,
        canonical_raw_json: &str,
        sent_at: &str,
        is_alert: bool,
    ) -> Result<(), String> {
        self.db
            .insert_replay_event(session_id, sent_at, canonical_raw_json)?;

        let mut sessions = self.sessions.write().await;
        if let Some(session) = sessions.iter_mut().find(|session| session.id == session_id) {
            session.event_count += 1;
            if is_alert {
                session.alert_count += 1;
            }
            self.db
                .update_session_counts(session_id, session.event_count, session.alert_count)?;
        }

        Ok(())
    }

    async fn maybe_store_track_point(
        &self,
        session_id: &str,
        recorded_at: &str,
        lat: f64,
        lon: f64,
        alt_msl_m: f64,
        heading_deg: Option<f64>,
        groundspeed_mps: Option<f64>,
    ) -> Result<(), String> {
        let mut track = self.track.write().await;
        let should_store = track
            .last()
            .map(|last_point| {
                let distance = distance_m(last_point.lat, last_point.lon, lat, lon);
                let elapsed_s = parse_timestamp(recorded_at)
                    .ok()
                    .zip(parse_timestamp(&last_point.recorded_at).ok())
                    .map(|(current, previous)| (current - previous).num_milliseconds().max(0) as f64 / 1000.0)
                    .unwrap_or(0.0);
                distance >= 1.5 || elapsed_s >= 1.0
            })
            .unwrap_or(true);

        if should_store {
            track.push(TrackPointRecord {
                lat,
                lon,
                recorded_at: recorded_at.to_string(),
                alt_msl_m: Some(alt_msl_m),
                heading_deg,
                groundspeed_mps,
            });
            self.db.insert_track_point(
                session_id,
                recorded_at,
                lat,
                lon,
                alt_msl_m,
                heading_deg,
                groundspeed_mps,
            )?;
        }

        Ok(())
    }

    async fn push_raw_telemetry_packet(&self, packet: &str) {
        let mut packets = self.raw_telemetry_packets.write().await;
        packets.push(format!(
            "[{}] {}",
            Local::now().format("%H:%M:%S"),
            packet.trim()
        ));
        if packets.len() > MAX_RAW_TELEMETRY_PACKETS {
            let drain_count = packets.len() - MAX_RAW_TELEMETRY_PACKETS;
            packets.drain(0..drain_count);
        }
    }

    async fn register_message_id(&self, message_id: &str) -> bool {
        let mut recent_ids = self.recent_message_ids.lock().await;
        if recent_ids.iter().any(|existing| existing == message_id) {
            return false;
        }

        recent_ids.push_back(message_id.to_string());
        while recent_ids.len() > MAX_RECENT_MESSAGE_IDS {
            recent_ids.pop_front();
        }
        true
    }

    fn save_alert_image(
        &self,
        message_id: &str,
        payload: &AlertPayload,
    ) -> Result<Option<String>, String> {
        let Some(image_base64) = payload.image_base64.as_ref() else {
            return Ok(None);
        };

        let bytes = STANDARD
            .decode(image_base64)
            .map_err(|error| error.to_string())?;
        let extension = payload
            .image_format
            .as_deref()
            .unwrap_or("bin")
            .to_ascii_lowercase();
        let file_name = format!("{message_id}.{}", sanitize_extension(&extension));
        let path = self.media_dir.join(file_name);
        fs::write(&path, bytes).map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    }
}

fn update_if_some<T>(target: &mut Option<T>, value: Option<T>) {
    if let Some(value) = value {
        *target = Some(value);
    }
}

fn insert_optional_number(target: &mut HashMap<String, Value>, key: &str, value: Option<f64>) {
    if let Some(value) = value {
        target.insert(key.to_string(), json!(value));
    }
}

fn insert_optional_bool(target: &mut HashMap<String, Value>, key: &str, value: Option<bool>) {
    if let Some(value) = value {
        target.insert(key.to_string(), Value::Bool(value));
    }
}

fn video_status_message(status: &VideoPreviewStatus) -> &'static str {
    match status {
        VideoPreviewStatus::Idle => "Video idle",
        VideoPreviewStatus::WaitingForStream => "Waiting for video stream",
        VideoPreviewStatus::WaitingForKeyframe => "Waiting for keyframe",
        VideoPreviewStatus::Live => "Live video",
        VideoPreviewStatus::Recording => "Recording live video",
        VideoPreviewStatus::Stale => "Video stream stale",
        VideoPreviewStatus::Error => "Video unavailable",
    }
}

fn resolve_vlc_executable(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("vlc").join("vlc.exe"));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(exe_dir) = current_exe.parent() {
            candidates.push(exe_dir.join("vlc").join("vlc.exe"));
            candidates.push(exe_dir.join("resources").join("vlc").join("vlc.exe"));
            candidates.push(
                exe_dir
                    .join("..")
                    .join("resources")
                    .join("vlc")
                    .join("vlc.exe"),
            );
        }
    }

    if let Ok(current_dir) = std::env::current_dir() {
        candidates.push(current_dir.join("src-tauri").join("resources").join("vlc").join("vlc.exe"));
        candidates.push(current_dir.join("resources").join("vlc").join("vlc.exe"));
    }

    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|path| path.join("vlc.exe"))
            .find(|candidate| candidate.is_file())
    })
}

fn configure_vlc_command(command: &mut Command, vlc_executable: &Path) {
    if let Some(vlc_root) = vlc_executable.parent() {
        let plugin_dir = vlc_root.join("plugins");
        command.current_dir(vlc_root);
        if plugin_dir.is_dir() {
            command.env("VLC_PLUGIN_PATH", plugin_dir);
        }
    }

    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

fn preview_stream_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}{VIDEO_PREVIEW_PATH}")
}

fn write_live_sdp(path: &Path) -> Result<(), String> {
    fs::write(
        path,
        format!(
            "c=IN IP4 0.0.0.0\r\nm=video {LIVE_VIDEO_RTP_PORT} RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\n"
        ),
    )
    .map_err(|error| error.to_string())
}

fn vlc_file_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn vlc_sout_file_path(path: &Path) -> String {
    format!("'{}'", vlc_file_path(path).replace('\'', "\\'"))
}

fn build_vlc_sout(preview_http_port: u16, recording_mp4_path: Option<&Path>) -> String {
    let preview_dst = format!(
        ":{}{}",
        preview_http_port,
        VIDEO_PREVIEW_PATH
    );
    let preview_branch = format!(
        "transcode{{vcodec=MJPG,vb=8000,scale=1,acodec=none}}:standard{{access=http{{mime=multipart/x-mixed-replace;boundary=--frame}},mux=mpjpeg,dst={preview_dst}}}"
    );

    if let Some(path) = recording_mp4_path {
        format!(
            "#duplicate{{dst={preview_branch},dst=standard{{access=file,mux=mp4,dst={}}}}}",
            vlc_sout_file_path(path)
        )
    } else {
        format!("#{preview_branch}")
    }
}

fn spawn_vlc_preview_process(
    vlc_executable: &Path,
    sdp_path: &Path,
    preview_http_port: u16,
    recording_mp4_path: Option<&Path>,
    log_path: &Path,
) -> Result<Child, String> {
    let mut command = Command::new(vlc_executable);
    configure_vlc_command(&mut command, vlc_executable);
    let sout = build_vlc_sout(preview_http_port, recording_mp4_path);
    command
        .arg("-I")
        .arg("dummy")
        .arg("--extraintf")
        .arg("rc")
        .arg("--rc-quiet")
        .arg("--ignore-config")
        .arg("--file-logging")
        .arg("--logmode")
        .arg("text")
        .arg("--logfile")
        .arg(log_path)
        .arg("--no-video-title-show")
        .arg("--no-sout-audio")
        .arg("--network-caching=60")
        .arg("--live-caching=60")
        .arg("--clock-jitter=0")
        .arg("--clock-synchro=0")
        .arg("--drop-late-frames")
        .arg("--skip-frames")
        .arg(sdp_path)
        .arg("--sout")
        .arg(sout)
        .arg("--sout-keep")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())
}

fn allocate_loopback_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| error.to_string())?;
    let port = listener.local_addr().map_err(|error| error.to_string())?.port();
    drop(listener);
    Ok(port)
}

fn preview_stream_request(port: u16) -> Vec<u8> {
    format!(
        "GET {VIDEO_PREVIEW_PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: keep-alive\r\n\r\n"
    )
    .into_bytes()
}

fn buffer_contains_jpeg_frame(buffer: &[u8]) -> bool {
    buffer.windows(2).any(|window| window == [0xFF, 0xD8])
        || buffer
            .windows(b"Content-Type: image/jpeg".len())
            .any(|window| window == b"Content-Type: image/jpeg")
}

fn read_log_tail(path: &Path, line_limit: usize) -> Option<String> {
    let content = fs::read_to_string(path).ok()?;
    let tail = content
        .lines()
        .rev()
        .take(line_limit)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" | ");
    let trimmed = tail.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn monitor_preview_stream(
    runtime: Arc<AppRuntime>,
    app: &AppHandle,
    preview_http_port: u16,
) {
    let request = preview_stream_request(preview_http_port);
    let mut read_buffer = vec![0_u8; 65_536];

    loop {
        let mut stream = match TcpStream::connect(("127.0.0.1", preview_http_port)).await {
            Ok(stream) => stream,
            Err(_) => {
                sleep(Duration::from_millis(VLC_HTTP_PROBE_INTERVAL_MS)).await;
                continue;
            }
        };

        if stream.write_all(&request).await.is_err() || stream.flush().await.is_err() {
            sleep(Duration::from_millis(VLC_HTTP_PROBE_INTERVAL_MS)).await;
            continue;
        }

        loop {
            let read = match timeout(
                Duration::from_millis(VLC_HTTP_PROBE_TIMEOUT_MS),
                stream.read(&mut read_buffer),
            )
            .await
            {
                Ok(Ok(read)) => read,
                _ => break,
            };

            if read == 0 {
                break;
            }

            if buffer_contains_jpeg_frame(&read_buffer[..read]) {
                runtime.register_preview_activity(app).await;
            }
        }

        sleep(Duration::from_millis(VLC_HTTP_PROBE_INTERVAL_MS)).await;
    }
}

fn sanitize_extension(extension: &str) -> &str {
    match extension {
        "jpg" | "jpeg" => "jpg",
        "png" => "png",
        _ => "bin",
    }
}

fn csv_option_f64(value: Option<f64>) -> String {
    value.map(|number| number.to_string()).unwrap_or_default()
}

fn escape_csv_field(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn write_csv_row(target: &mut String, fields: &[String]) {
    let mut first = true;
    for field in fields {
        if !first {
            target.push(',');
        }
        first = false;
        target.push_str(&escape_csv_field(field));
    }
    target.push('\n');
}

fn sanitize_file_component(value: &str) -> String {
    let sanitized: String = value
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            control if control.is_control() => '-',
            other => other,
        })
        .collect();
    let compact = sanitized
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .replace("--", "-");
    let trimmed = compact.trim_matches('-');
    if trimmed.is_empty() {
        "flight".to_string()
    } else {
        trimmed.to_string()
    }
}

fn review_frames_from_replay(frames: Vec<ReplayFrame>) -> Vec<ReviewTelemetryFrame> {
    frames
        .into_iter()
        .filter_map(|frame| {
            let envelope: WireEnvelope<TelemetryPayload> =
                serde_json::from_str(&frame.envelope_json).ok()?;
            if envelope.envelope_type != "telemetry" {
                return None;
            }

            let recorded_at = normalize_timestamp(&envelope.sent_at);
            Some(ReviewTelemetryFrame {
                message_id: envelope.message_id,
                recorded_at: recorded_at.clone(),
                live_state: AircraftLiveState {
                    aircraft_id: envelope.aircraft_id,
                    lat: if envelope.payload.armed {
                        envelope.payload.lat
                    } else {
                        None
                    },
                    lon: if envelope.payload.armed {
                        envelope.payload.lon
                    } else {
                        None
                    },
                    alt_msl_m: envelope.payload.alt_msl_m,
                    groundspeed_mps: envelope.payload.groundspeed_mps,
                    heading_deg: envelope.payload.heading_deg,
                    flight_time_s: envelope.payload.flight_time_s,
                    armed: envelope.payload.armed,
                    battery: envelope.payload.battery,
                    link: envelope.payload.link,
                    last_update_at: recorded_at,
                    extras: envelope.payload.extras,
                },
            })
        })
        .collect()
}

fn normalize_class_label(label: &str) -> String {
    label
        .trim()
        .to_ascii_lowercase()
        .replace(|ch: char| !ch.is_ascii_alphanumeric(), "_")
        .trim_matches('_')
        .to_string()
}

fn is_error_status(status: &str) -> bool {
    let normalized = status.trim().to_ascii_uppercase();
    normalized.contains("ERROR") || normalized.contains("FAIL")
}

fn generate_session_name(timestamp: DateTime<Utc>) -> String {
    format!("Flight {}", timestamp.with_timezone(&Local).format("%b %-d, %Y %H:%M"))
}

fn normalize_required_name(value: Option<String>, fallback: &str) -> String {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(timestamp) = DateTime::parse_from_rfc3339(value) {
        return Ok(timestamp.with_timezone(&Utc));
    }

    if let Ok(naive) = NaiveDateTime::parse_from_str(value, "%Y-%m-%d %H:%M:%S") {
        if let Some(local) = Local
            .from_local_datetime(&naive)
            .single()
            .or_else(|| Local.from_local_datetime(&naive).earliest())
            .or_else(|| Local.from_local_datetime(&naive).latest())
        {
            return Ok(local.with_timezone(&Utc));
        }
    }

    Err(format!("unrecognized timestamp format: {value}"))
}

fn normalize_timestamp(value: &str) -> String {
    parse_timestamp(value)
        .map(|timestamp| timestamp.to_rfc3339())
        .unwrap_or_else(|_| Utc::now().to_rfc3339())
}
