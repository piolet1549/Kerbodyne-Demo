use std::{
    collections::{BTreeMap, BTreeSet, HashMap, VecDeque},
    fs,
    net::{Ipv4Addr, SocketAddrV4},
    path::{Path, PathBuf},
    sync::{Arc, Mutex as StdMutex},
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream, UdpSocket},
    process::{Child, Command},
    sync::{broadcast, watch, Mutex, RwLock},
    time::{sleep, timeout, Duration, Instant},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};
use uuid::Uuid;

use crate::{
    db::{Database, TelemetryWrite},
    geometry::distance_m,
    models::{
        AircraftLiveState, AlertPayload, AlertRecord, AppConfig, AppSnapshot, BatterySummary,
        ConnectionHealth, ConnectionStatus, LegacyAlertPacket, LegacySystemStatusPacket,
        LegacyTelemetryPacket, LegacyTelemetryPacketType, LiveTelemetryUpdate, MapAlertSector,
        MissionSession, OfflineRegionCatalog, OfflineRegionManifest, ReplayFrame,
        ReviewTelemetryFrame, RuntimeEvent, RuntimeMode, SessionVideoClip, SystemStatusPayload,
        SystemStatusRecord, TelemetryIngestDiagnostics, TelemetryPayload, TrackPointRecord,
        VideoFrontendPerformance, VideoPreviewState, VideoPreviewStatus, WireEnvelope,
        DEFAULT_AIRCRAFT_ID, SCHEMA_VERSION,
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
const MAX_FAILED_TELEMETRY_WRITES: usize = 8_192;
const LIVE_VIDEO_RTP_PORT: u16 = 5600;
const AIRSIDE_VISION_COMMAND_HOST: &str = "192.168.1.11";
const AIRSIDE_VISION_COMMAND_PORT: u16 = 45105;
const AIRSIDE_VISION_COMMAND_TIMEOUT_SECS: u64 = 5;
const VIDEO_STALE_AFTER_SECS: i64 = 3;
const COMPAT_HF_STALE_SECS: i64 = 2;
const COMPAT_MF_STALE_SECS: i64 = 4;
const COMPAT_LF_STALE_SECS: i64 = 8;
const VIDEO_PREVIEW_PATH: &str = "/live.mjpg";
const APP_VIDEO_PREVIEW_FRAME_PATH: &str = "/__preview__/live.jpg";
const DIRECT_VIDEO_WS_PATH: &str = "/live.h264";
const DIRECT_VIDEO_CHANNEL_CAPACITY: usize = 12;
const DIRECT_VIDEO_STATS_INTERVAL_MS: u64 = 250;
const DIRECT_VIDEO_RECEIVE_BUFFER_BYTES: usize = 4 * 1024 * 1024;
const RTP_REORDER_MAX_DELAY_MS: u64 = 12;
const RTP_REORDER_MAX_PACKETS: usize = 32;
const RTP_LOSS_REORDER_GRACE_MS: u64 = 500;
const RTP_LOSS_WINDOW_SECS: u64 = 5;
const VIDEO_RATE_WINDOW_MS: u64 = 1_000;
const VIDEO_PERFORMANCE_REPORT_STALE_MS: u64 = 750;
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
    battery_wh: Option<f64>,
    time_boot_ms: Option<u64>,
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

        match packet
            .packet_type
            .unwrap_or(LegacyTelemetryPacketType::Unknown)
        {
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
        update_if_some(
            &mut self.battery_wh,
            packet
                .battery_wh
                .or_else(|| packet.energy_consumed.map(hectojoules_to_watt_hours)),
        );
        update_if_some(&mut self.time_boot_ms, packet.time_boot_ms);
        update_if_some(&mut self.cpu_temp_c, packet.cpu_temp_c);
        update_if_some(&mut self.cpu_pct, packet.cpu_pct);
        update_if_some(&mut self.cpu_mhz, packet.cpu_mhz);
        update_if_some(&mut self.npu_temp_c, packet.npu_temp_c);
        update_if_some(&mut self.vision_active, packet.vision_active);

        if let Some(sequence) = packet.sequence {
            self.extras.insert("sequence".into(), json!(sequence));
        }
        if let Some(generated_at) = packet.generated_at.as_ref() {
            self.extras
                .insert("generated_at".into(), generated_at.clone());
        }

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
            || self.battery_wh.is_some()
            || self.time_boot_ms.is_some()
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
        insert_optional_number(
            &mut extras,
            "flight_mode",
            self.flight_mode.map(|value| value as f64),
        );
        insert_optional_number(&mut extras, "throttle_pct", self.throttle_pct);
        insert_optional_number(&mut extras, "nav_pitch_deg", self.nav_pitch_deg);
        insert_optional_number(&mut extras, "nav_roll_deg", self.nav_roll_deg);
        insert_optional_number(&mut extras, "alt_demanded_m", self.alt_demanded_m);
        insert_optional_number(&mut extras, "vib_x", self.vib_x);
        insert_optional_number(&mut extras, "vib_y", self.vib_y);
        insert_optional_number(&mut extras, "vib_z", self.vib_z);
        insert_optional_number(&mut extras, "battery_a", self.battery_a);
        insert_optional_number(&mut extras, "battery_mah", self.battery_mah);
        insert_optional_number(&mut extras, "battery_wh", self.battery_wh);
        insert_optional_number(
            &mut extras,
            "time_boot_ms",
            self.time_boot_ms.map(|value| value as f64),
        );
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

#[derive(Clone, Default)]
struct DirectVideoStats {
    started_at: Option<DateTime<Utc>>,
    last_packet_at: Option<DateTime<Utc>>,
    last_packet_source: Option<String>,
    packet_count: u64,
    access_unit_count: u64,
    waiting_for_keyframe: bool,
    rtp_packets_lost_total: u64,
    rtp_loss_percent_5s: f64,
    rx_bitrate_mbps_1s: f64,
    encoded_fps_1s: f64,
    bridge_dropped_frames_total: u64,
}

struct DirectVideoReceiverStats {
    packet_count: u64,
    access_unit_count: u64,
    last_packet_at: Option<DateTime<Utc>>,
    last_packet_source: Option<String>,
    waiting_for_keyframe: bool,
    rtp_packets_lost_total: u64,
    rtp_loss_percent_5s: f64,
    rx_bitrate_mbps_1s: f64,
    encoded_fps_1s: f64,
}

#[derive(Default)]
struct VideoRuntimeState {
    preview_monitor_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    direct_ingest_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    direct_ws_handle: Option<tauri::async_runtime::JoinHandle<()>>,
    direct_shutdown: Option<broadcast::Sender<()>>,
    preview_child: Option<Child>,
    recording: Option<RecordingRunState>,
    last_preview_frame_at: Option<DateTime<Utc>>,
    direct_stats: DirectVideoStats,
    direct_ws_port: Option<u16>,
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

pub struct LegacyTelemetryProcessResult {
    pub packet_type: LegacyTelemetryPacketType,
    pub persistence_write: Option<TelemetryWrite>,
    pub track_point: Option<TrackPointRecord>,
    pub raw_packet: String,
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
            Self::CompatibilityTelemetry => "Receiving compatibility telemetry",
            Self::CompatibilityAlert => "Receiving compatibility TCP packets",
        }
    }
}

pub struct AppRuntime {
    data_dir: PathBuf,
    media_dir: PathBuf,
    db: Arc<Database>,
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
    frontend_video_performance: RwLock<VideoFrontendPerformance>,
    frontend_video_performance_reported_at: RwLock<Option<Instant>>,
    raw_telemetry_packets: RwLock<Vec<String>>,
    telemetry_ingest: StdMutex<TelemetryIngestDiagnostics>,
    failed_telemetry_writes: StdMutex<Vec<TelemetryWrite>>,
    warnings: RwLock<Vec<String>>,
    recent_message_ids: Mutex<VecDeque<String>>,
    current_session_id: RwLock<Option<String>>,
    current_session_source: RwLock<Option<String>>,
    focused_session_id: RwLock<Option<String>>,
    compatibility_telemetry: RwLock<CompatibilityTelemetryState>,
    background_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    active_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    legacy_listener_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
    legacy_listener_init_lock: Mutex<()>,
    legacy_listener_shutdown: Mutex<Option<broadcast::Sender<()>>>,
    legacy_ingest_enabled: RwLock<bool>,
    legacy_udp_listener_ready: RwLock<bool>,
    legacy_tcp_listener_ready: RwLock<bool>,
    shutdown_signal: broadcast::Sender<()>,
    preview_frame_sender: watch::Sender<Option<Vec<u8>>>,
    latest_preview_frame: RwLock<Option<Vec<u8>>>,
    video_runtime: Mutex<VideoRuntimeState>,
    video_dir: PathBuf,
    vlc_path: RwLock<Option<PathBuf>>,
}

impl AppRuntime {
    async fn legacy_ports(&self) -> (u16, u16) {
        let config = self.config.read().await;
        (config.legacy_telemetry_port, config.legacy_alert_port)
    }

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
        let (shutdown_signal, _) = broadcast::channel(8);

        let database = Arc::new(Database::open(&data_dir.join("kerbodyne.db"))?);
        let mut config = database.load_config()?.unwrap_or_default();
        offline_maps::normalize_config(&mut config, &data_dir)?;
        database.save_config(&config)?;
        database.close_active_sessions(&Utc::now().to_rfc3339())?;
        database.delete_empty_sessions()?;
        database.delete_non_flight_sessions()?;
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
            frontend_video_performance: RwLock::new(VideoFrontendPerformance::default()),
            frontend_video_performance_reported_at: RwLock::new(None),
            raw_telemetry_packets: RwLock::new(Vec::new()),
            telemetry_ingest: StdMutex::new(TelemetryIngestDiagnostics::default()),
            failed_telemetry_writes: StdMutex::new(Vec::new()),
            warnings: RwLock::new(Vec::new()),
            recent_message_ids: Mutex::new(VecDeque::new()),
            current_session_id: RwLock::new(None),
            current_session_source: RwLock::new(None),
            focused_session_id: RwLock::new(focused_session_id),
            compatibility_telemetry: RwLock::new(CompatibilityTelemetryState::default()),
            background_tasks: Mutex::new(Vec::new()),
            active_tasks: Mutex::new(Vec::new()),
            legacy_listener_tasks: Mutex::new(Vec::new()),
            legacy_listener_init_lock: Mutex::new(()),
            legacy_listener_shutdown: Mutex::new(None),
            legacy_ingest_enabled: RwLock::new(false),
            legacy_udp_listener_ready: RwLock::new(false),
            legacy_tcp_listener_ready: RwLock::new(false),
            shutdown_signal,
            preview_frame_sender,
            latest_preview_frame: RwLock::new(None),
            video_runtime: Mutex::new(VideoRuntimeState::default()),
            video_dir,
            vlc_path: RwLock::new(None),
        }))
    }

    pub fn start_background_tasks(self: &Arc<Self>, app: AppHandle) {
        match spawn_offline_asset_server(self.clone(), self.shutdown_signal.subscribe()) {
            Ok((asset_origin, asset_server_handle)) => {
                *self.asset_server_origin.blocking_write() = asset_origin;
                self.background_tasks
                    .blocking_lock()
                    .push(asset_server_handle);
            }
            Err(error) => {
                eprintln!("Kerbodyne offline asset server failed to start: {error}");
            }
        }

        let port = self.config.blocking_read().listen_port;
        let websocket_handle = spawn_websocket_server(
            self.clone(),
            app.clone(),
            port,
            self.shutdown_signal.subscribe(),
        );
        self.background_tasks.blocking_lock().push(websocket_handle);

        let runtime = self.clone();
        let mut shutdown_receiver = self.shutdown_signal.subscribe();
        let periodic_handle = tauri::async_runtime::spawn(async move {
            let mut last_diagnostics_log = Instant::now();
            let mut last_logged_packet_count = 0;
            loop {
                tokio::select! {
                    _ = shutdown_receiver.recv() => break,
                    _ = sleep(Duration::from_secs(2)) => {
                        let connection_changed = runtime.refresh_connection_health().await;
                        let video_changed = runtime.refresh_video_health(&app).await;
                        if connection_changed || video_changed {
                            let _ = runtime.emit_snapshot(&app).await;
                        }
                        if last_diagnostics_log.elapsed() >= Duration::from_secs(10) {
                            let diagnostics = runtime.telemetry_ingest_snapshot();
                            if diagnostics.received_packets != last_logged_packet_count {
                                eprintln!(
                                    "Kerbodyne telemetry ingest: received={} processed={} queue={}/{} delay={}ms max_delay={}ms persistence_queue={}/{} batch={} in {}ms coalesced={} dropped={} parse_errors={} persistence_errors={}",
                                    diagnostics.received_packets,
                                    diagnostics.processed_packets,
                                    diagnostics.queue_depth,
                                    diagnostics.queue_high_water,
                                    diagnostics.processing_delay_ms,
                                    diagnostics.max_processing_delay_ms,
                                    diagnostics.persistence_queue_depth,
                                    diagnostics.persistence_queue_high_water,
                                    diagnostics.last_batch_size,
                                    diagnostics.last_batch_write_ms,
                                    diagnostics.coalesced_packets,
                                    diagnostics.dropped_packets,
                                    diagnostics.parse_errors,
                                    diagnostics.persistence_errors,
                                );
                                last_logged_packet_count = diagnostics.received_packets;
                            }
                            last_diagnostics_log = Instant::now();
                        }
                    }
                }
            }
        });
        self.background_tasks.blocking_lock().push(periodic_handle);
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
            telemetry_ingest: self.telemetry_ingest_snapshot(),
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
        self.prepare_for_new_manual_stream(app).await?;
        self.reset_telemetry_ingest_diagnostics();
        self.ensure_legacy_listener_tasks(app).await?;
        let session_id = self
            .begin_session(DEFAULT_AIRCRAFT_ID, LEGACY_SOURCE_LABEL)
            .await?;
        *self.legacy_ingest_enabled.write().await = true;
        let (legacy_telemetry_port, legacy_alert_port) = self.legacy_ports().await;
        {
            *self.mode.write().await = RuntimeMode::Live;
            *self.connection.write().await = ConnectionHealth {
                status: ConnectionStatus::Listening,
                port: legacy_telemetry_port,
                last_packet_at: None,
                note: Some(format!(
                    "Listening for airside downlink on UDP {} and TCP {}",
                    legacy_telemetry_port, legacy_alert_port
                )),
            };
        }
        self.emit_snapshot(app).await?;

        if let Err(error) = self.start_video_subsystem(app, &session_id).await {
            self.push_warning(app, error).await;
        }

        self.emit_snapshot(app).await?;
        Ok(())
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

    pub async fn delete_session(&self, app: &AppHandle, session_id: String) -> Result<(), String> {
        if self.current_session_id.read().await.as_deref() == Some(session_id.as_str()) {
            return Err("Stop the active flight before deleting it.".into());
        }

        self.delete_session_internal(&session_id).await?;

        let next_focus = {
            let focused = self.focused_session_id.read().await.clone();
            if focused.as_deref() == Some(session_id.as_str()) {
                self.sessions
                    .read()
                    .await
                    .first()
                    .map(|session| session.id.clone())
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
        let mut telemetry_rows = Vec::new();
        let mut extra_columns = BTreeSet::new();

        for frame in replay_events {
            let Ok(envelope) =
                serde_json::from_str::<WireEnvelope<TelemetryPayload>>(&frame.envelope_json)
            else {
                continue;
            };
            if envelope.envelope_type != "telemetry" {
                continue;
            }
            for key in envelope.payload.extras.keys() {
                extra_columns.insert(key.clone());
            }
            telemetry_rows.push((frame.envelope_json, envelope));
        }

        let mut header = vec![
            "recorded_at".to_string(),
            "message_id".to_string(),
            "aircraft_id".to_string(),
            "armed".to_string(),
            "lat".to_string(),
            "lon".to_string(),
            "alt_msl_m".to_string(),
            "groundspeed_mps".to_string(),
            "heading_deg".to_string(),
            "flight_time_s".to_string(),
            "battery_voltage_v".to_string(),
            "battery_percent".to_string(),
            "link_quality_percent".to_string(),
            "link_latency_ms".to_string(),
        ];
        header.extend(extra_columns.iter().cloned());
        header.push("extras_json".to_string());
        header.push("raw_json".to_string());

        let mut rows = String::new();
        write_csv_row(&mut rows, &header);

        for (raw_json, envelope) in telemetry_rows {
            let extras_json = serde_json::to_string(&envelope.payload.extras)
                .map_err(|error| error.to_string())?;
            let mut fields = vec![
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
                csv_option_f64(
                    envelope
                        .payload
                        .link
                        .as_ref()
                        .and_then(|link| link.quality_percent),
                ),
                csv_option_f64(
                    envelope
                        .payload
                        .link
                        .as_ref()
                        .and_then(|link| link.latency_ms),
                ),
            ];
            for key in &extra_columns {
                fields.push(csv_json_value(envelope.payload.extras.get(key)));
            }
            fields.push(extras_json);
            fields.push(raw_json);
            write_csv_row(&mut rows, &fields);
        }

        fs::write(&path, rows).map_err(|error| error.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }

    fn telemetry_ingest_snapshot(&self) -> TelemetryIngestDiagnostics {
        self.telemetry_ingest
            .lock()
            .map(|diagnostics| diagnostics.clone())
            .unwrap_or_default()
    }

    pub fn reset_telemetry_ingest_diagnostics(&self) {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            *diagnostics = TelemetryIngestDiagnostics::default();
        }
        if let Ok(mut failed_writes) = self.failed_telemetry_writes.lock() {
            failed_writes.clear();
        }
    }

    pub fn record_telemetry_received(
        &self,
        packet_type: LegacyTelemetryPacketType,
        received_at: DateTime<Utc>,
        queue_depth: usize,
        queue_high_water: usize,
        coalesced: u64,
        dropped: u64,
    ) {
        let Ok(mut diagnostics) = self.telemetry_ingest.lock() else {
            return;
        };
        let timestamp = received_at.to_rfc3339();
        diagnostics.received_packets = diagnostics.received_packets.saturating_add(1);
        diagnostics.queue_depth = queue_depth;
        diagnostics.queue_high_water = diagnostics.queue_high_water.max(queue_high_water);
        diagnostics.coalesced_packets = diagnostics.coalesced_packets.saturating_add(coalesced);
        diagnostics.dropped_packets = diagnostics.dropped_packets.saturating_add(dropped);
        diagnostics.last_packet_type = Some(legacy_packet_type_label(packet_type).into());
        diagnostics.last_received_at = Some(timestamp.clone());
        match packet_type {
            LegacyTelemetryPacketType::HighFrequency => {
                diagnostics.last_hf_received_at = Some(timestamp)
            }
            LegacyTelemetryPacketType::MediumFrequency => {
                diagnostics.last_mf_received_at = Some(timestamp)
            }
            LegacyTelemetryPacketType::LowFrequency => {
                diagnostics.last_lf_received_at = Some(timestamp)
            }
            LegacyTelemetryPacketType::OnChange => {
                diagnostics.last_oc_received_at = Some(timestamp)
            }
            LegacyTelemetryPacketType::Unknown => {}
        }
    }

    pub fn record_telemetry_processed(
        &self,
        packet_type: LegacyTelemetryPacketType,
        processed_at: DateTime<Utc>,
        processing_delay: Duration,
        queue_depth: usize,
        sequence: Option<u64>,
        generated_at: Option<String>,
    ) {
        let Ok(mut diagnostics) = self.telemetry_ingest.lock() else {
            return;
        };
        let delay_ms = processing_delay.as_millis().min(u64::MAX as u128) as u64;
        diagnostics.processed_packets = diagnostics.processed_packets.saturating_add(1);
        diagnostics.processing_delay_ms = delay_ms;
        diagnostics.max_processing_delay_ms = diagnostics.max_processing_delay_ms.max(delay_ms);
        diagnostics.queue_depth = queue_depth;
        diagnostics.last_packet_type = Some(legacy_packet_type_label(packet_type).into());
        diagnostics.last_processed_at = Some(processed_at.to_rfc3339());
        if sequence.is_some() {
            diagnostics.last_sequence = sequence;
        }
        if generated_at.is_some() {
            diagnostics.last_generated_at = generated_at;
        }
    }

    pub fn record_telemetry_parse_error(&self, queue_depth: usize) {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            diagnostics.parse_errors = diagnostics.parse_errors.saturating_add(1);
            diagnostics.queue_depth = queue_depth;
        }
    }

    pub fn record_persistence_queue_depth(&self, queue_depth: usize) {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            diagnostics.persistence_queue_depth = queue_depth;
            diagnostics.persistence_queue_high_water =
                diagnostics.persistence_queue_high_water.max(queue_depth);
        }
    }

    pub fn record_persistence_drop(&self, count: u64) {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            diagnostics.dropped_packets = diagnostics.dropped_packets.saturating_add(count);
        }
    }

    fn queue_failed_telemetry_writes(&self, writes: Vec<TelemetryWrite>) -> usize {
        let Ok(mut failed_writes) = self.failed_telemetry_writes.lock() else {
            return writes.len();
        };
        let available = MAX_FAILED_TELEMETRY_WRITES.saturating_sub(failed_writes.len());
        let accepted = available.min(writes.len());
        let dropped = writes.len() - accepted;
        failed_writes.extend(writes.into_iter().take(accepted));
        dropped
    }

    fn record_persistence_result(&self, batch_size: usize, elapsed: Duration, success: bool) {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            diagnostics.last_batch_size = batch_size;
            diagnostics.last_batch_write_ms = elapsed.as_millis().min(u64::MAX as u128) as u64;
            if !success {
                diagnostics.persistence_errors = diagnostics.persistence_errors.saturating_add(1);
            }
        }
    }

    pub async fn persist_telemetry_batch(&self, app: &AppHandle, writes: Vec<TelemetryWrite>) {
        if writes.is_empty() {
            return;
        }
        let has_failed_writes = self
            .failed_telemetry_writes
            .lock()
            .map(|failed_writes| !failed_writes.is_empty())
            .unwrap_or(false);
        if has_failed_writes {
            let dropped = self.queue_failed_telemetry_writes(writes);
            if dropped > 0 {
                self.record_persistence_drop(dropped as u64);
            }
            return;
        }

        let started = Instant::now();
        let batch_size = writes.len();
        let mut last_error = None;
        for attempt in 0..3 {
            let database = self.db.clone();
            let attempt_writes = writes.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                database.insert_telemetry_batch(&attempt_writes)
            })
            .await;

            match result {
                Ok(Ok(event_counts)) => {
                    {
                        let mut sessions = self.sessions.write().await;
                        for (session_id, count) in event_counts {
                            if let Some(session) =
                                sessions.iter_mut().find(|entry| entry.id == session_id)
                            {
                                session.event_count = session.event_count.saturating_add(count);
                            }
                        }
                    }
                    self.record_persistence_result(batch_size, started.elapsed(), true);
                    return;
                }
                Ok(Err(error)) => last_error = Some(error),
                Err(error) => last_error = Some(error.to_string()),
            }

            sleep(Duration::from_millis(100 * (attempt + 1) as u64)).await;
        }

        self.record_persistence_result(batch_size, started.elapsed(), false);
        let dropped = self.queue_failed_telemetry_writes(writes);
        if dropped > 0 {
            self.record_persistence_drop(dropped as u64);
        }
        self.push_warning(
            app,
            format!(
                "Telemetry recording batch failed and will be retried when the flight ends: {}",
                last_error.unwrap_or_else(|| "unknown database error".into())
            ),
        )
        .await;
    }

    async fn flush_failed_telemetry_writes(&self) -> Result<(), String> {
        let writes = self
            .failed_telemetry_writes
            .lock()
            .map_err(|_| "telemetry persistence mutex poisoned".to_string())?
            .drain(..)
            .collect::<Vec<_>>();
        if writes.is_empty() {
            return Ok(());
        }

        let database = self.db.clone();
        let retry_writes = writes.clone();
        match tauri::async_runtime::spawn_blocking(move || {
            database.insert_telemetry_batch(&retry_writes)
        })
        .await
        {
            Ok(Ok(event_counts)) => {
                let mut sessions = self.sessions.write().await;
                for (session_id, count) in event_counts {
                    if let Some(session) = sessions.iter_mut().find(|entry| entry.id == session_id)
                    {
                        session.event_count = session.event_count.saturating_add(count);
                    }
                }
                Ok(())
            }
            Ok(Err(error)) => {
                let dropped = self.queue_failed_telemetry_writes(writes);
                self.record_persistence_drop(dropped as u64);
                Err(format!("Unable to finalize telemetry recording: {error}"))
            }
            Err(error) => {
                let dropped = self.queue_failed_telemetry_writes(writes);
                self.record_persistence_drop(dropped as u64);
                Err(format!("Unable to finalize telemetry recording: {error}"))
            }
        }
    }

    pub async fn emit_live_telemetry_update(
        &self,
        app: &AppHandle,
        track_points: Vec<TrackPointRecord>,
        raw_packets: Vec<String>,
    ) -> Result<(), String> {
        if let Ok(mut diagnostics) = self.telemetry_ingest.lock() {
            diagnostics.frontend_updates = diagnostics.frontend_updates.saturating_add(1);
        }
        let update = LiveTelemetryUpdate {
            connection: self.connection.read().await.clone(),
            live_state: self.live_state.read().await.clone(),
            active_session_has_armed_telemetry: *self.session_has_armed_telemetry.read().await,
            track_points,
            raw_telemetry_packets: raw_packets,
            telemetry_ingest: self.telemetry_ingest_snapshot(),
        };
        app.emit(
            "kerbodyne://runtime",
            RuntimeEvent::LiveTelemetry { update },
        )
        .map_err(|error| error.to_string())
    }

    pub async fn export_session_detections(
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
        let alerts = self.db.load_alerts_for_session(&session_id)?;
        if alerts.is_empty() {
            return Err("This flight does not contain any detections.".into());
        }

        let downloads_dir = app
            .path()
            .download_dir()
            .map_err(|error| error.to_string())?;
        fs::create_dir_all(&downloads_dir).map_err(|error| error.to_string())?;
        let timestamp = Local::now().format("%Y%m%d-%H%M%S");
        let folder_name = format!(
            "{}-detections-{}",
            sanitize_file_component(&session.name),
            timestamp
        );
        let export_dir = downloads_dir.join(folder_name);
        fs::create_dir_all(&export_dir).map_err(|error| error.to_string())?;

        let manifest_path = export_dir.join("detections.csv");
        let mut rows = String::new();
        write_csv_row(
            &mut rows,
            &[
                "detection_index".to_string(),
                "image_file".to_string(),
                "class_label".to_string(),
                "confidence".to_string(),
                "detected_at".to_string(),
                "alt_msl_m".to_string(),
                "center_lat".to_string(),
                "center_lon".to_string(),
                "heading_deg".to_string(),
            ],
        );

        for (index, alert) in alerts.iter().enumerate() {
            let detection_index = index + 1;
            let mut image_file = String::new();
            if let Some(image_path) = alert.image_path.as_deref() {
                let source_path = Path::new(image_path);
                if source_path.exists() {
                    let extension = source_path
                        .extension()
                        .and_then(|value| value.to_str())
                        .unwrap_or_else(|| alert.image_format.as_deref().unwrap_or("bin"));
                    let normalized_extension = extension.to_ascii_lowercase();
                    let file_name = format!(
                        "detection-{detection_index:03}-{}-{}.{}",
                        sanitize_file_component(&alert.class_label),
                        sanitize_file_component(&alert.id),
                        sanitize_extension(&normalized_extension)
                    );
                    let destination = export_dir.join(&file_name);
                    fs::copy(source_path, &destination).map_err(|error| {
                        format!(
                            "Unable to copy detection image {}: {error}",
                            source_path.display()
                        )
                    })?;
                    image_file = file_name;
                }
            }

            write_csv_row(
                &mut rows,
                &[
                    detection_index.to_string(),
                    image_file,
                    alert.class_label.clone(),
                    alert.confidence.to_string(),
                    normalize_timestamp(&alert.detected_at),
                    csv_option_f64(alert.alt_msl_m),
                    alert.sector.center_lat.to_string(),
                    alert.sector.center_lon.to_string(),
                    alert.sector.bearing_deg.to_string(),
                ],
            );
        }

        fs::write(&manifest_path, rows).map_err(|error| error.to_string())?;
        Ok(export_dir.to_string_lossy().to_string())
    }

    pub async fn set_vision_pipeline_enabled(&self, enabled: bool) -> Result<String, String> {
        let command = if enabled {
            "start_vision"
        } else {
            "stop_vision"
        };
        let payload = serde_json::to_vec(&json!({ "command": command }))
            .map_err(|error| error.to_string())?;
        let address = (AIRSIDE_VISION_COMMAND_HOST, AIRSIDE_VISION_COMMAND_PORT);
        let mut stream = timeout(
            Duration::from_secs(AIRSIDE_VISION_COMMAND_TIMEOUT_SECS),
            TcpStream::connect(address),
        )
        .await
        .map_err(|_| {
            format!(
                "Timed out connecting to vision command listener at {}:{}.",
                AIRSIDE_VISION_COMMAND_HOST, AIRSIDE_VISION_COMMAND_PORT
            )
        })?
        .map_err(|error| {
            format!(
                "Unable to connect to vision command listener at {}:{}: {error}",
                AIRSIDE_VISION_COMMAND_HOST, AIRSIDE_VISION_COMMAND_PORT
            )
        })?;

        timeout(
            Duration::from_secs(AIRSIDE_VISION_COMMAND_TIMEOUT_SECS),
            stream.write_all(&payload),
        )
        .await
        .map_err(|_| "Timed out sending vision command.".to_string())?
        .map_err(|error| format!("Unable to send vision command: {error}"))?;

        let mut response = vec![0_u8; 1024];
        let bytes_read = timeout(
            Duration::from_secs(AIRSIDE_VISION_COMMAND_TIMEOUT_SECS),
            stream.read(&mut response),
        )
        .await
        .map_err(|_| "Timed out waiting for vision command response.".to_string())?
        .map_err(|error| format!("Unable to read vision command response: {error}"))?;

        if bytes_read == 0 {
            return Ok("Vision command sent.".into());
        }

        let response_text = String::from_utf8(response[..bytes_read].to_vec())
            .map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_str(&response_text)
            .map_err(|error| format!("Vision command listener returned invalid JSON: {error}"))?;
        let status = value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Vision command acknowledged.")
            .to_string();

        if status.eq_ignore_ascii_case("error") {
            Err(message)
        } else {
            Ok(message)
        }
    }

    pub async fn complete_active_stream(
        &self,
        app: &AppHandle,
        save: bool,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<(), String> {
        self.stop_legacy_listener_tasks().await?;
        *self.legacy_ingest_enabled.write().await = false;
        self.flush_failed_telemetry_writes().await?;
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
                if let Some(session) = sessions.iter_mut().find(|session| session.id == session_id)
                {
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
        self.stop_legacy_listener_tasks().await?;
        *self.legacy_ingest_enabled.write().await = false;
        self.flush_failed_telemetry_writes().await?;
        {
            let mut active_tasks = self.active_tasks.lock().await;
            for handle in active_tasks.drain(..) {
                handle.abort();
            }
        }
        let _ = self.stop_video_subsystem(app).await;

        self.end_current_session().await?;
        self.db.delete_empty_sessions()?;
        self.db.delete_non_flight_sessions()?;
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

    async fn ensure_legacy_listener_tasks(&self, app: &AppHandle) -> Result<(), String> {
        let _guard = self.legacy_listener_init_lock.lock().await;
        let needs_udp_listener = !*self.legacy_udp_listener_ready.read().await;
        let needs_tcp_listener = !*self.legacy_tcp_listener_ready.read().await;

        if !needs_udp_listener && !needs_tcp_listener {
            return Ok(());
        }

        self.reclaim_legacy_ports().await?;

        let runtime = app.state::<Arc<AppRuntime>>().inner().clone();
        let (legacy_telemetry_port, legacy_alert_port) = self.legacy_ports().await;
        let shutdown_signal = {
            let mut shutdown = self.legacy_listener_shutdown.lock().await;
            if let Some(existing) = shutdown.as_ref() {
                existing.clone()
            } else {
                let (sender, _) = broadcast::channel(4);
                *shutdown = Some(sender.clone());
                sender
            }
        };

        if needs_udp_listener {
            let udp_socket = bind_legacy_udp_listener(legacy_telemetry_port).await?;
            let telemetry_handles = spawn_legacy_telemetry_listener(
                runtime.clone(),
                app.clone(),
                udp_socket,
                shutdown_signal.subscribe(),
            );
            self.legacy_listener_tasks
                .lock()
                .await
                .extend(telemetry_handles);
            *self.legacy_udp_listener_ready.write().await = true;
        }

        if needs_tcp_listener {
            let tcp_listener =
                bind_legacy_alert_listener(("0.0.0.0", legacy_alert_port), legacy_alert_port)
                    .await?;
            let alert_handle = spawn_legacy_alert_listener(
                runtime,
                app.clone(),
                tcp_listener,
                shutdown_signal.subscribe(),
            );
            self.legacy_listener_tasks.lock().await.push(alert_handle);
            *self.legacy_tcp_listener_ready.write().await = true;
        }

        Ok(())
    }

    async fn reclaim_legacy_ports(&self) -> Result<(), String> {
        let (legacy_telemetry_port, legacy_alert_port) = self.legacy_ports().await;

        for _ in 0..12 {
            let udp_owner = detect_port_owner("udp", legacy_telemetry_port);
            let tcp_owner = detect_port_owner("tcp", legacy_alert_port);

            let mut killed_any = false;
            for pid in [udp_owner, tcp_owner].into_iter().flatten() {
                if pid == std::process::id() {
                    continue;
                }

                if terminate_process_by_pid(pid) {
                    killed_any = true;
                }
            }

            let udp_still_owned = detect_port_owner("udp", legacy_telemetry_port).is_some();
            let tcp_still_owned = detect_port_owner("tcp", legacy_alert_port).is_some();

            if !udp_still_owned && !tcp_still_owned {
                return Ok(());
            }

            if !killed_any {
                sleep(Duration::from_millis(300)).await;
            } else {
                sleep(Duration::from_millis(500)).await;
            }
        }

        let udp_owner = describe_port_owner(detect_port_owner("udp", legacy_telemetry_port));
        let tcp_owner = describe_port_owner(detect_port_owner("tcp", legacy_alert_port));
        Err(format!(
            "Unable to clear legacy flight ports before starting a flight. UDP {} owner: {}. TCP {} owner: {}.",
            legacy_telemetry_port, udp_owner, legacy_alert_port, tcp_owner
        ))
    }

    async fn stop_legacy_listener_tasks(&self) -> Result<(), String> {
        if let Some(shutdown_signal) = self.legacy_listener_shutdown.lock().await.take() {
            let _ = shutdown_signal.send(());
        }

        let mut legacy_listener_tasks = self.legacy_listener_tasks.lock().await;
        let mut timed_out = false;
        for handle in legacy_listener_tasks.drain(..) {
            let mut handle = handle;
            if timeout(Duration::from_secs(10), &mut handle).await.is_err() {
                handle.abort();
                timed_out = true;
            }
        }

        *self.legacy_udp_listener_ready.write().await = false;
        *self.legacy_tcp_listener_ready.write().await = false;
        if timed_out {
            Err("Telemetry pipeline did not finish flushing within 10 seconds.".into())
        } else {
            Ok(())
        }
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
        let diagnostics = self.telemetry_ingest_snapshot();
        let last_packet_at = diagnostics
            .last_received_at
            .as_deref()
            .and_then(|timestamp| parse_timestamp(timestamp).ok())
            .or_else(|| state.last_packet_at());
        let Some(last_packet_at) = last_packet_at else {
            return false;
        };

        let next_status = if (now - last_packet_at).num_seconds() > stale_after_seconds as i64 {
            ConnectionStatus::Stale
        } else {
            ConnectionStatus::ReceivingTelemetry
        };
        let next_note = if next_status == ConnectionStatus::Stale {
            "Telemetry link is stale".to_string()
        } else if diagnostics.queue_depth >= 5 || diagnostics.processing_delay_ms >= 250 {
            format!(
                "Receiving telemetry; processing backlog {} packets ({} ms delay)",
                diagnostics.queue_depth, diagnostics.processing_delay_ms
            )
        } else {
            build_ingress_connection_note(&state, &diagnostics, &now)
        };
        let next_last_packet_at = Some(last_packet_at.to_rfc3339());

        let port = self.legacy_ports().await.0;
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
        let (
            preview_running,
            direct_running,
            last_preview_frame_at,
            recording_active,
            direct_stats,
        ) = {
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

            let direct_running =
                runtime.direct_ingest_handle.is_some() && runtime.direct_ws_handle.is_some();

            (
                runtime.preview_child.is_some() || direct_running,
                direct_running,
                runtime.last_preview_frame_at,
                runtime.recording.is_some(),
                runtime.direct_stats.clone(),
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
        let (next_status, next_message) = if !preview_running {
            if preview.preview_url.is_some() {
                (
                    VideoPreviewStatus::Error,
                    video_status_message(&VideoPreviewStatus::Error).to_string(),
                )
            } else {
                (
                    VideoPreviewStatus::Idle,
                    video_status_message(&VideoPreviewStatus::Idle).to_string(),
                )
            }
        } else if let Some(last_frame) = last_preview_frame_at {
            if (Utc::now() - last_frame).num_seconds() > VIDEO_STALE_AFTER_SECS {
                (
                    VideoPreviewStatus::Stale,
                    video_status_message(&VideoPreviewStatus::Stale).to_string(),
                )
            } else if recording_active {
                (
                    VideoPreviewStatus::Recording,
                    video_status_message(&VideoPreviewStatus::Recording).to_string(),
                )
            } else {
                (
                    VideoPreviewStatus::Live,
                    video_status_message(&VideoPreviewStatus::Live).to_string(),
                )
            }
        } else if direct_running && direct_stats.last_packet_at.is_some() {
            let packet_age_seconds = direct_stats
                .last_packet_at
                .map(|last_packet| (Utc::now() - last_packet).num_seconds())
                .unwrap_or_default();
            if packet_age_seconds > VIDEO_STALE_AFTER_SECS {
                (
                    VideoPreviewStatus::Stale,
                    format!(
                        "Video packets stopped after {} RTP packets",
                        direct_stats.packet_count
                    ),
                )
            } else {
                (
                    VideoPreviewStatus::WaitingForKeyframe,
                    direct_video_waiting_message(&direct_stats),
                )
            }
        } else {
            (
                VideoPreviewStatus::WaitingForStream,
                video_status_message(&VideoPreviewStatus::WaitingForStream).to_string(),
            )
        };

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
        let (
            monitor_handle,
            direct_ingest_handle,
            direct_ws_handle,
            direct_shutdown,
            mut preview_child,
            sdp_path,
        ) = {
            let mut runtime = self.video_runtime.lock().await;
            (
                runtime.preview_monitor_handle.take(),
                runtime.direct_ingest_handle.take(),
                runtime.direct_ws_handle.take(),
                runtime.direct_shutdown.take(),
                runtime.preview_child.take(),
                runtime.sdp_path.take(),
            )
        };

        if let Some(shutdown) = direct_shutdown {
            let _ = shutdown.send(());
        }

        if let Some(handle) = monitor_handle {
            handle.abort();
        }

        if let Some(handle) = direct_ingest_handle {
            handle.abort();
        }

        if let Some(handle) = direct_ws_handle {
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
        runtime.direct_ws_port = None;
        runtime.preview_http_port = None;
        runtime.last_preview_frame_at = None;
        runtime.direct_stats = DirectVideoStats::default();
        runtime.log_path = None;
    }

    async fn launch_direct_preview_bridge(&self, app: &AppHandle) -> Result<(), String> {
        self.stop_preview_process().await;

        let udp_socket = create_live_video_udp_socket(LIVE_VIDEO_RTP_PORT).map_err(|error| {
            let owner_note = detect_external_udp_port_owner(LIVE_VIDEO_RTP_PORT)
                .map(|pid| format!(" Port owner: {}.", describe_port_owner(Some(pid))))
                .unwrap_or_default();
            format!(
                "Unable to bind live video RTP receiver on UDP {}: {error}{owner_note}",
                LIVE_VIDEO_RTP_PORT,
            )
        })?;
        let ws_listener = TcpListener::bind(("127.0.0.1", 0))
            .await
            .map_err(|error| format!("Unable to bind live video bridge WebSocket: {error}"))?;
        let ws_port = ws_listener
            .local_addr()
            .map_err(|error| error.to_string())?
            .port();

        let (video_sender, _) = broadcast::channel(DIRECT_VIDEO_CHANNEL_CAPACITY);
        let (direct_shutdown, _) = broadcast::channel(4);
        let ingest_shutdown = direct_shutdown.subscribe();
        let ws_shutdown = direct_shutdown.subscribe();
        let runtime_for_ingest = app.state::<Arc<AppRuntime>>().inner().clone();
        let runtime_for_ws = runtime_for_ingest.clone();
        let app_for_ingest = app.clone();
        let video_sender_for_ingest = video_sender.clone();

        let direct_ingest_handle = tauri::async_runtime::spawn(async move {
            receive_direct_rtp_video(
                runtime_for_ingest,
                &app_for_ingest,
                udp_socket,
                video_sender_for_ingest,
                ingest_shutdown,
            )
            .await;
        });
        let direct_ws_handle = tauri::async_runtime::spawn(async move {
            serve_direct_video_websocket(runtime_for_ws, ws_listener, video_sender, ws_shutdown)
                .await;
        });

        {
            *self.video_preview.write().await = VideoPreviewState {
                status: VideoPreviewStatus::WaitingForStream,
                preview_url: Some(format!("ws://127.0.0.1:{ws_port}{DIRECT_VIDEO_WS_PATH}")),
                recording_active: false,
                current_clip_id: None,
                message: Some(
                    video_status_message(&VideoPreviewStatus::WaitingForStream).to_string(),
                ),
            };
        }
        *self.latest_preview_frame.write().await = None;
        *self.frontend_video_performance.write().await = VideoFrontendPerformance::default();
        *self.frontend_video_performance_reported_at.write().await = None;
        let _ = self.preview_frame_sender.send(None);

        let mut runtime = self.video_runtime.lock().await;
        runtime.direct_ingest_handle = Some(direct_ingest_handle);
        runtime.direct_ws_handle = Some(direct_ws_handle);
        runtime.direct_shutdown = Some(direct_shutdown);
        runtime.direct_ws_port = Some(ws_port);
        runtime.last_preview_frame_at = None;
        runtime.direct_stats = DirectVideoStats {
            started_at: Some(Utc::now()),
            waiting_for_keyframe: true,
            ..DirectVideoStats::default()
        };

        Ok(())
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
                runtime
                    .recording
                    .as_ref()
                    .map(|recording| recording.clip_id.clone()),
            )
        };

        let preview_url = preview_frame_url(&self.asset_server_origin.read().await);

        {
            *self.video_preview.write().await = VideoPreviewState {
                status: VideoPreviewStatus::WaitingForStream,
                preview_url,
                recording_active,
                current_clip_id,
                message: Some(
                    video_status_message(&VideoPreviewStatus::WaitingForStream).to_string(),
                ),
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

        match self.launch_direct_preview_bridge(app).await {
            Ok(()) => {
                self.emit_snapshot(app).await?;
                return Ok(());
            }
            Err(direct_error) => {
                if detect_external_udp_port_owner(LIVE_VIDEO_RTP_PORT).is_some() {
                    return Err(direct_error);
                }
                self.push_warning(
                    app,
                    format!(
                        "Direct video bridge unavailable ({direct_error}); falling back to VLC preview."
                    ),
                )
                .await;
            }
        }

        let vlc_executable = resolve_vlc_executable(app).ok_or_else(|| {
            "Live video runtime unavailable: vlc.exe not found in bundled resources or PATH."
                .to_string()
        })?;
        *self.vlc_path.write().await = Some(vlc_executable.clone());
        self.launch_preview_process(app, &vlc_executable, None)
            .await?;

        self.emit_snapshot(app).await?;
        Ok(())
    }

    pub async fn shutdown(&self, app: &AppHandle) {
        *self.legacy_ingest_enabled.write().await = false;
        let _ = self.shutdown_signal.send(());
        {
            let mut active_tasks = self.active_tasks.lock().await;
            for handle in active_tasks.drain(..) {
                handle.abort();
            }
        }
        let _ = self.stop_legacy_listener_tasks().await;
        let _ = self.flush_failed_telemetry_writes().await;
        {
            let mut background_tasks = self.background_tasks.lock().await;
            for handle in background_tasks.drain(..) {
                let mut handle = handle;
                if timeout(Duration::from_secs(2), &mut handle).await.is_err() {
                    handle.abort();
                }
            }
        }
        let _ = self.stop_video_subsystem(app).await;
        let _ = self.end_current_session().await;
        let _ = self.db.delete_empty_sessions();
        let _ = self.db.delete_non_flight_sessions();
    }

    async fn stop_video_subsystem(&self, app: &AppHandle) -> Result<(), String> {
        let _ = self.stop_video_recording_internal(app, false).await;
        self.stop_preview_process().await;

        *self.video_preview.write().await = VideoPreviewState::default();
        *self.frontend_video_performance.write().await = VideoFrontendPerformance::default();
        *self.frontend_video_performance_reported_at.write().await = None;
        *self.latest_preview_frame.write().await = None;
        let _ = self.preview_frame_sender.send(None);
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
            if self.focused_session_id.read().await.as_deref()
                == Some(recording.session_id.as_str())
            {
                *self.review_video_clips.write().await = self
                    .db
                    .load_video_clips_for_session(&recording.session_id)?;
            }
        }

        if restart_preview {
            let vlc_executable = self
                .vlc_path
                .read()
                .await
                .clone()
                .or_else(|| resolve_vlc_executable(app))
                .ok_or_else(|| {
                    "Live video runtime unavailable while restarting preview.".to_string()
                })?;
            self.launch_preview_process(app, &vlc_executable, None)
                .await?;
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

    async fn update_direct_video_stats(&self, stats: DirectVideoReceiverStats) {
        let mut runtime = self.video_runtime.lock().await;
        runtime.direct_stats.packet_count = stats.packet_count;
        runtime.direct_stats.access_unit_count = stats.access_unit_count;
        runtime.direct_stats.last_packet_at = stats.last_packet_at;
        runtime.direct_stats.last_packet_source = stats.last_packet_source;
        runtime.direct_stats.waiting_for_keyframe = stats.waiting_for_keyframe;
        runtime.direct_stats.rtp_packets_lost_total = stats.rtp_packets_lost_total;
        runtime.direct_stats.rtp_loss_percent_5s = stats.rtp_loss_percent_5s;
        runtime.direct_stats.rx_bitrate_mbps_1s = stats.rx_bitrate_mbps_1s;
        runtime.direct_stats.encoded_fps_1s = stats.encoded_fps_1s;
    }

    async fn record_video_bridge_drop(&self, count: u64) {
        let mut runtime = self.video_runtime.lock().await;
        runtime.direct_stats.bridge_dropped_frames_total = runtime
            .direct_stats
            .bridge_dropped_frames_total
            .saturating_add(count);
    }

    pub async fn report_video_performance(&self, mut performance: VideoFrontendPerformance) {
        if self.current_session_id.read().await.is_none() {
            return;
        }
        if !performance.rendered_fps_1s.is_finite() || performance.rendered_fps_1s < 0.0 {
            performance.rendered_fps_1s = 0.0;
        }
        *self.frontend_video_performance.write().await = performance;
        *self.frontend_video_performance_reported_at.write().await = Some(Instant::now());
    }

    async fn append_video_performance_extras(&self, extras: &mut HashMap<String, Value>) {
        let status = self.video_preview.read().await.status.clone();
        let direct_stats = self.video_runtime.lock().await.direct_stats.clone();
        let mut frontend = self.frontend_video_performance.read().await.clone();
        if let Some(reported_at) = *self.frontend_video_performance_reported_at.read().await {
            let report_age_ms = reported_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
            if let Some(frame_age_ms) = frontend.last_rendered_frame_age_ms.as_mut() {
                *frame_age_ms = frame_age_ms.saturating_add(report_age_ms);
            }
            if report_age_ms > VIDEO_PERFORMANCE_REPORT_STALE_MS {
                frontend.rendered_fps_1s = 0.0;
                frontend.stall_active = frontend.last_rendered_frame_age_ms.is_some();
            }
        }

        extras.insert(
            "video_status".into(),
            Value::String(video_preview_status_label(&status).into()),
        );
        extras.insert(
            "video_waiting_for_keyframe".into(),
            Value::Bool(direct_stats.waiting_for_keyframe),
        );
        extras.insert(
            "video_rtp_packets_lost_total".into(),
            json!(direct_stats.rtp_packets_lost_total),
        );
        extras.insert(
            "video_rtp_loss_percent_5s".into(),
            json!(direct_stats.rtp_loss_percent_5s),
        );
        extras.insert(
            "video_rx_bitrate_mbps_1s".into(),
            json!(direct_stats.rx_bitrate_mbps_1s),
        );
        extras.insert(
            "video_encoded_fps_1s".into(),
            json!(direct_stats.encoded_fps_1s),
        );
        extras.insert(
            "video_bridge_dropped_frames_total".into(),
            json!(direct_stats.bridge_dropped_frames_total),
        );
        extras.insert(
            "video_rendered_fps_1s".into(),
            json!(frontend.rendered_fps_1s),
        );
        extras.insert(
            "video_decoder_dropped_frames_total".into(),
            json!(frontend.decoder_dropped_frames_total),
        );
        extras.insert(
            "video_last_rendered_frame_age_ms".into(),
            frontend
                .last_rendered_frame_age_ms
                .map(|age| json!(age))
                .unwrap_or(Value::Null),
        );
        extras.insert(
            "video_stall_active".into(),
            Value::Bool(frontend.stall_active),
        );
    }

    async fn publish_preview_frame(&self, app: &AppHandle, frame: Vec<u8>) {
        *self.latest_preview_frame.write().await = Some(frame.clone());
        let _ = self.preview_frame_sender.send(Some(frame));
        self.register_preview_activity(app).await;
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
                self.ingest_telemetry(app, envelope, raw_json, source)
                    .await?;
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

    pub async fn ingest_legacy_telemetry_received(
        &self,
        app: &AppHandle,
        raw_json: &str,
        source: IngestSource,
        received_at: DateTime<Utc>,
        received_instant: Instant,
        queue_depth: usize,
    ) -> Result<Option<LegacyTelemetryProcessResult>, String> {
        if !*self.legacy_ingest_enabled.read().await {
            return Ok(None);
        }

        let packet: LegacyTelemetryPacket =
            serde_json::from_str(raw_json).map_err(|error| error.to_string())?;
        let raw_packet = self.push_raw_telemetry_packet(raw_json).await;
        let packet_type = packet
            .packet_type
            .unwrap_or(LegacyTelemetryPacketType::Unknown);
        let sequence = packet.sequence;
        let generated_at = packet.generated_at.as_ref().map(|value| match value {
            Value::String(value) => value.clone(),
            other => other.to_string(),
        });
        let state = {
            let mut compatibility = self.compatibility_telemetry.write().await;
            compatibility.apply_packet(&packet, received_at);
            compatibility.clone()
        };

        let has_any_state = state.has_any_state();

        if !has_any_state {
            self.record_telemetry_processed(
                packet_type,
                Utc::now(),
                received_instant.elapsed(),
                queue_depth,
                sequence,
                generated_at,
            );
            let _ = self
                .refresh_compatibility_connection_health(
                    self.config.read().await.stale_after_seconds,
                )
                .await;
            return Ok(Some(LegacyTelemetryProcessResult {
                packet_type,
                persistence_write: None,
                track_point: None,
                raw_packet,
            }));
        }

        let mut payload = state.to_payload(Some(packet_type));
        self.append_video_performance_extras(&mut payload.extras)
            .await;
        let envelope = WireEnvelope {
            schema_version: SCHEMA_VERSION.into(),
            message_id: format!("legacy-telemetry-{}", Uuid::new_v4()),
            aircraft_id: DEFAULT_AIRCRAFT_ID.into(),
            sent_at: received_at.to_rfc3339(),
            envelope_type: "telemetry".into(),
            payload,
            extras: HashMap::new(),
        };
        let canonical_raw_json =
            serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
        let (persistence_write, track_point) = self
            .apply_telemetry_state(&envelope, &canonical_raw_json, source)
            .await?;
        self.record_telemetry_processed(
            packet_type,
            Utc::now(),
            received_instant.elapsed(),
            queue_depth,
            sequence,
            generated_at,
        );
        let _ = self
            .refresh_compatibility_connection_health(self.config.read().await.stale_after_seconds)
            .await;
        let _ = app;
        Ok(Some(LegacyTelemetryProcessResult {
            packet_type,
            persistence_write,
            track_point,
            raw_packet,
        }))
    }

    pub async fn ingest_legacy_alert(
        &self,
        app: &AppHandle,
        raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        if !*self.legacy_ingest_enabled.read().await {
            return Ok(());
        }

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
        extras.insert("legacy_status".into(), Value::String(packet.status.clone()));
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
        mut envelope: WireEnvelope<TelemetryPayload>,
        _canonical_raw_json: &str,
        source: IngestSource,
    ) -> Result<(), String> {
        self.append_video_performance_extras(&mut envelope.payload.extras)
            .await;
        let enriched_raw_json =
            serde_json::to_string(&envelope).map_err(|error| error.to_string())?;
        let (persistence_write, _) = self
            .apply_telemetry_state(&envelope, &enriched_raw_json, source)
            .await?;
        if let Some(write) = persistence_write {
            self.record_event(
                &write.session_id,
                &write.envelope_json,
                &write.sent_at,
                false,
            )
            .await?;
            if let Some(point) = write.track_point {
                self.db.insert_track_point(
                    &write.session_id,
                    &point.recorded_at,
                    point.lat,
                    point.lon,
                    point.alt_msl_m.unwrap_or_default(),
                    point.heading_deg,
                    point.groundspeed_mps,
                )?;
            }
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn apply_telemetry_state(
        &self,
        envelope: &WireEnvelope<TelemetryPayload>,
        canonical_raw_json: &str,
        source: IngestSource,
    ) -> Result<(Option<TelemetryWrite>, Option<TrackPointRecord>), String> {
        let session_id = self
            .ensure_session(&envelope.aircraft_id, &source.source_label())
            .await?;
        if !matches!(source, IngestSource::CompatibilityTelemetry) {
            let _ = self.push_raw_telemetry_packet(canonical_raw_json).await;
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

        if !matches!(source, IngestSource::CompatibilityTelemetry) {
            self.update_runtime_status(source, &sent_at).await;
        }
        let track_point = if let (Some(lat), Some(lon), Some(alt_msl_m)) =
            (lat, lon, envelope.payload.alt_msl_m)
        {
            self.maybe_append_track_point(
                &sent_at,
                lat,
                lon,
                alt_msl_m,
                envelope.payload.heading_deg,
                envelope.payload.groundspeed_mps,
            )
            .await
        } else {
            None
        };

        let persistence_write = envelope.payload.armed.then(|| TelemetryWrite {
            session_id,
            sent_at,
            envelope_json: canonical_raw_json.to_string(),
            track_point: track_point.clone(),
        });
        Ok((persistence_write, track_point))
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
                .refresh_compatibility_connection_health(
                    self.config.read().await.stale_after_seconds,
                )
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
        let sent_at = normalize_timestamp(&envelope.sent_at);
        let session_id = self.current_session_id.read().await.clone();

        let record = SystemStatusRecord {
            id: envelope.message_id.clone(),
            session_id: session_id.clone().unwrap_or_default(),
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
        let status_is_error = is_error_status(&record.status);

        if let Some(session_id) = session_id {
            let record = SystemStatusRecord {
                session_id: session_id.clone(),
                ..record
            };
            self.db.insert_system_status(&record, canonical_raw_json)?;
            {
                let mut system_statuses = self.system_statuses.write().await;
                system_statuses.insert(0, record.clone());
                system_statuses.truncate(40);
            }
            self.record_event(&session_id, canonical_raw_json, &sent_at, false)
                .await?;
        }

        if matches!(source, IngestSource::CompatibilityAlert)
            && self.current_session_source.read().await.as_deref() == Some(LEGACY_SOURCE_LABEL)
        {
            let _ = self
                .refresh_compatibility_connection_health(
                    self.config.read().await.stale_after_seconds,
                )
                .await;
        } else {
            self.update_runtime_status(source, &sent_at).await;
        }

        if status_is_error {
            self.emit_snapshot(app).await?;
            return Ok(());
        }

        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn update_runtime_status(&self, source: IngestSource, sent_at: &str) {
        let config = self.config.read().await.clone();
        let (port, note) = match source {
            IngestSource::CompatibilityTelemetry => (
                config.legacy_telemetry_port,
                format!("{} on UDP {}", source.note(), config.legacy_telemetry_port),
            ),
            IngestSource::CompatibilityAlert => (
                config.legacy_alert_port,
                format!("{} on TCP {}", source.note(), config.legacy_alert_port),
            ),
            _ => (config.listen_port, source.note().to_string()),
        };
        *self.mode.write().await = source.mode();
        *self.connection.write().await = ConnectionHealth {
            status: source.connection_status(),
            port,
            last_packet_at: Some(sent_at.to_string()),
            note: Some(note),
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
                .increment_session_counts(session_id, 1, u32::from(is_alert))?;
        }

        Ok(())
    }

    async fn maybe_append_track_point(
        &self,
        recorded_at: &str,
        lat: f64,
        lon: f64,
        alt_msl_m: f64,
        heading_deg: Option<f64>,
        groundspeed_mps: Option<f64>,
    ) -> Option<TrackPointRecord> {
        let mut track = self.track.write().await;
        let should_store = track
            .last()
            .map(|last_point| {
                let distance = distance_m(last_point.lat, last_point.lon, lat, lon);
                let elapsed_s = parse_timestamp(recorded_at)
                    .ok()
                    .zip(parse_timestamp(&last_point.recorded_at).ok())
                    .map(|(current, previous)| {
                        (current - previous).num_milliseconds().max(0) as f64 / 1000.0
                    })
                    .unwrap_or(0.0);
                distance >= 1.5 || elapsed_s >= 1.0
            })
            .unwrap_or(true);

        if should_store {
            let point = TrackPointRecord {
                lat,
                lon,
                recorded_at: recorded_at.to_string(),
                alt_msl_m: Some(alt_msl_m),
                heading_deg,
                groundspeed_mps,
            };
            track.push(point.clone());
            return Some(point);
        }

        None
    }

    async fn push_raw_telemetry_packet(&self, packet: &str) -> String {
        let formatted = format!("[{}] {}", Local::now().format("%H:%M:%S"), packet.trim());
        let mut packets = self.raw_telemetry_packets.write().await;
        packets.push(formatted.clone());
        if packets.len() > MAX_RAW_TELEMETRY_PACKETS {
            let drain_count = packets.len() - MAX_RAW_TELEMETRY_PACKETS;
            packets.drain(0..drain_count);
        }
        formatted
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

    pub async fn mark_legacy_udp_listener_down(&self) {
        *self.legacy_udp_listener_ready.write().await = false;
    }

    pub async fn mark_legacy_tcp_listener_down(&self) {
        *self.legacy_tcp_listener_ready.write().await = false;
    }
}

async fn bind_legacy_udp_listener(port: u16) -> Result<UdpSocket, String> {
    for attempt in 0..20 {
        match create_legacy_udp_socket(port) {
            Ok(socket) => return Ok(socket),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && attempt < 19 => {
                sleep(Duration::from_millis(250)).await;
            }
            Err(error) => {
                let owner = if error.kind() == std::io::ErrorKind::AddrInUse {
                    format!(
                        " Port owner: {}.",
                        describe_port_owner(detect_port_owner("udp", port))
                    )
                } else {
                    String::new()
                };
                return Err(format!(
                    "Unable to bind UDP telemetry listener on port {}: {}.{}",
                    port, error, owner
                ));
            }
        }
    }

    Err(format!(
        "Unable to bind UDP telemetry listener on port {} after multiple attempts. Port owner: {}.",
        port,
        describe_port_owner(detect_port_owner("udp", port))
    ))
}

async fn bind_legacy_alert_listener(
    address: (&str, u16),
    port: u16,
) -> Result<TcpListener, String> {
    for attempt in 0..20 {
        match TcpListener::bind(address).await {
            Ok(listener) => return Ok(listener),
            Err(error) if error.kind() == std::io::ErrorKind::AddrInUse && attempt < 19 => {
                sleep(Duration::from_millis(250)).await;
            }
            Err(error) => {
                let owner = if error.kind() == std::io::ErrorKind::AddrInUse {
                    format!(
                        " Port owner: {}.",
                        describe_port_owner(detect_port_owner("tcp", port))
                    )
                } else {
                    String::new()
                };
                return Err(format!(
                    "Unable to bind TCP alert listener on port {}: {}.{}",
                    port, error, owner
                ));
            }
        }
    }

    Err(format!(
        "Unable to bind TCP alert listener on port {} after multiple attempts. Port owner: {}.",
        port,
        describe_port_owner(detect_port_owner("tcp", port))
    ))
}

fn update_if_some<T>(target: &mut Option<T>, value: Option<T>) {
    if let Some(value) = value {
        *target = Some(value);
    }
}

fn create_legacy_udp_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    // Large enough for short scheduler stalls without retaining minutes of stale telemetry.
    let _ = socket.set_recv_buffer_size(1024 * 1024);
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    if let Ok(buffer_size) = socket.recv_buffer_size() {
        eprintln!(
            "Kerbodyne telemetry UDP listener bound on port {port} with {buffer_size} byte receive buffer"
        );
    }
    socket.set_nonblocking(true)?;
    let socket: std::net::UdpSocket = socket.into();
    UdpSocket::from_std(socket)
}

fn create_live_video_udp_socket(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    let _ = socket.set_recv_buffer_size(DIRECT_VIDEO_RECEIVE_BUFFER_BYTES);
    socket.bind(&SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port).into())?;
    if let Ok(buffer_size) = socket.recv_buffer_size() {
        eprintln!(
            "Kerbodyne video RTP listener bound on port {port} with {buffer_size} byte receive buffer"
        );
    }
    socket.set_nonblocking(true)?;
    let socket: std::net::UdpSocket = socket.into();
    UdpSocket::from_std(socket)
}

fn legacy_packet_type_label(packet_type: LegacyTelemetryPacketType) -> &'static str {
    match packet_type {
        LegacyTelemetryPacketType::HighFrequency => "hf",
        LegacyTelemetryPacketType::MediumFrequency => "mf",
        LegacyTelemetryPacketType::LowFrequency => "lf",
        LegacyTelemetryPacketType::OnChange => "oc",
        LegacyTelemetryPacketType::Unknown => "unknown",
    }
}

fn build_ingress_connection_note(
    state: &CompatibilityTelemetryState,
    diagnostics: &TelemetryIngestDiagnostics,
    now: &DateTime<Utc>,
) -> String {
    if !state.has_any_state() {
        return "Telemetry packet received; awaiting aircraft state".into();
    }
    if !state.has_split_packets {
        return "Receiving compatibility telemetry".into();
    }

    let tier_timestamp = |value: Option<&str>| value.and_then(|value| parse_timestamp(value).ok());
    let mut missing = Vec::new();
    if !state.tier_is_current(
        tier_timestamp(diagnostics.last_hf_received_at.as_deref()),
        COMPAT_HF_STALE_SECS,
        now,
    ) {
        missing.push("high-rate");
    }
    if !state.tier_is_current(
        tier_timestamp(diagnostics.last_mf_received_at.as_deref()),
        COMPAT_MF_STALE_SECS,
        now,
    ) {
        missing.push("medium-rate");
    }
    if !state.tier_is_current(
        tier_timestamp(diagnostics.last_lf_received_at.as_deref()),
        COMPAT_LF_STALE_SECS,
        now,
    ) {
        missing.push("low-rate");
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

fn hectojoules_to_watt_hours(value: f64) -> f64 {
    (value * 100.0) / 3600.0
}

fn video_status_message(status: &VideoPreviewStatus) -> &'static str {
    match status {
        VideoPreviewStatus::Idle => "Video idle",
        VideoPreviewStatus::WaitingForStream => "Waiting for video packets on UDP 5600",
        VideoPreviewStatus::WaitingForKeyframe => "Receiving video packets; waiting for keyframe",
        VideoPreviewStatus::Live => "Live video",
        VideoPreviewStatus::Recording => "Recording live video",
        VideoPreviewStatus::Stale => "Video stream stale",
        VideoPreviewStatus::Error => "Video unavailable",
    }
}

fn video_preview_status_label(status: &VideoPreviewStatus) -> &'static str {
    match status {
        VideoPreviewStatus::Idle => "idle",
        VideoPreviewStatus::WaitingForStream => "waiting_for_stream",
        VideoPreviewStatus::WaitingForKeyframe => "waiting_for_keyframe",
        VideoPreviewStatus::Live => "live",
        VideoPreviewStatus::Recording => "recording",
        VideoPreviewStatus::Stale => "stale",
        VideoPreviewStatus::Error => "error",
    }
}

fn direct_video_waiting_message(stats: &DirectVideoStats) -> String {
    let source = stats
        .last_packet_source
        .as_deref()
        .map(|source| format!(" from {source}"))
        .unwrap_or_default();
    let elapsed = stats
        .started_at
        .map(|started_at| (Utc::now() - started_at).num_seconds().max(0))
        .unwrap_or_default();
    if stats.waiting_for_keyframe {
        format!(
            "Receiving RTP{source}; waiting for H.264 keyframe ({}, {}s)",
            stats.packet_count, elapsed
        )
    } else {
        format!(
            "Receiving RTP{source}; waiting for complete H.264 frame ({}, {}s)",
            stats.packet_count, elapsed
        )
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
        candidates.push(
            current_dir
                .join("src-tauri")
                .join("resources")
                .join("vlc")
                .join("vlc.exe"),
        );
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

fn preview_frame_url(asset_origin: &str) -> Option<String> {
    let trimmed = asset_origin.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        None
    } else {
        Some(format!("{trimmed}{APP_VIDEO_PREVIEW_FRAME_PATH}"))
    }
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
    let preview_dst = format!(":{}{}", preview_http_port, VIDEO_PREVIEW_PATH);
    let preview_branch = format!(
        "transcode{{vcodec=MJPG,vb=24000,fps=15,scale=1,acodec=none}}:standard{{access=http{{mime=multipart/x-mixed-replace;boundary=--frame}},mux=mpjpeg,dst={preview_dst}}}"
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
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
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

#[cfg(windows)]
fn detect_external_udp_port_owner(port: u16) -> Option<u32> {
    detect_port_owner("udp", port)
}

#[cfg(not(windows))]
fn detect_external_udp_port_owner(_port: u16) -> Option<u32> {
    None
}

#[cfg(windows)]
fn detect_port_owner(protocol: &str, port: u16) -> Option<u32> {
    let output = std::process::Command::new("netstat")
        .args(["-ano", "-p", protocol])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let needle = format!(":{port}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().find_map(|line| {
        if !line.contains(&needle) {
            return None;
        }

        let columns = line.split_whitespace().collect::<Vec<_>>();
        let pid = columns.last()?.parse::<u32>().ok()?;
        if pid == std::process::id() {
            None
        } else {
            Some(pid)
        }
    })
}

#[cfg(windows)]
fn process_name_for_pid(pid: u32) -> Option<String> {
    let output = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim();
    if line.is_empty() || line.starts_with("INFO:") {
        return None;
    }

    line.trim_matches('"')
        .split("\",\"")
        .next()
        .map(|value| value.to_string())
}

#[cfg(not(windows))]
fn detect_port_owner(_protocol: &str, _port: u16) -> Option<u32> {
    None
}

#[cfg(not(windows))]
fn describe_port_owner(_owner_pid: Option<u32>) -> String {
    "unknown".to_string()
}

#[cfg(windows)]
fn terminate_process_by_pid(pid: u32) -> bool {
    std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/F", "/T"])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(windows))]
fn terminate_process_by_pid(_pid: u32) -> bool {
    false
}

#[cfg(windows)]
fn describe_port_owner(owner_pid: Option<u32>) -> String {
    match owner_pid {
        Some(pid) => {
            let name = process_name_for_pid(pid).unwrap_or_else(|| "unknown".to_string());
            format!("{name} (PID {pid})")
        }
        None => "none".to_string(),
    }
}

async fn monitor_preview_stream(runtime: Arc<AppRuntime>, app: &AppHandle, preview_http_port: u16) {
    let request = preview_stream_request(preview_http_port);
    let mut read_buffer = vec![0_u8; 65_536];
    let mut stream_buffer = Vec::with_capacity(262_144);

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

            stream_buffer.extend_from_slice(&read_buffer[..read]);
            if let Some(frame) = extract_latest_jpeg_frame(&mut stream_buffer) {
                runtime.publish_preview_frame(app, frame).await;
            }

            if stream_buffer.len() > 4_000_000 {
                trim_preview_stream_buffer(&mut stream_buffer);
            } else if buffer_contains_jpeg_frame(&read_buffer[..read]) {
                runtime.register_preview_activity(app).await;
            }
        }

        sleep(Duration::from_millis(VLC_HTTP_PROBE_INTERVAL_MS)).await;
    }
}

async fn serve_direct_video_websocket(
    runtime: Arc<AppRuntime>,
    listener: TcpListener,
    video_sender: broadcast::Sender<Vec<u8>>,
    mut shutdown: broadcast::Receiver<()>,
) {
    loop {
        let (stream, _) = tokio::select! {
            _ = shutdown.recv() => break,
            accept_result = listener.accept() => match accept_result {
                Ok(parts) => parts,
                Err(_) => break,
            }
        };

        let mut video_receiver = video_sender.subscribe();
        let runtime = runtime.clone();
        tauri::async_runtime::spawn(async move {
            let websocket = match accept_async(stream).await {
                Ok(socket) => socket,
                Err(_) => return,
            };
            let (mut writer, mut reader) = websocket.split();

            loop {
                tokio::select! {
                    frame = video_receiver.recv() => {
                        match frame {
                            Ok(frame) => {
                                if writer.send(Message::Binary(frame)).await.is_err() {
                                    break;
                                }
                            }
                            Err(broadcast::error::RecvError::Lagged(skipped)) => {
                                runtime.record_video_bridge_drop(skipped).await;
                                continue;
                            }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                    inbound = reader.next() => {
                        match inbound {
                            Some(Ok(Message::Close(_))) | None => break,
                            Some(Ok(Message::Ping(payload))) => {
                                if writer.send(Message::Pong(payload)).await.is_err() {
                                    break;
                                }
                            }
                            Some(Err(_)) => break,
                            _ => {}
                        }
                    }
                }
            }
        });
    }
}

async fn receive_direct_rtp_video(
    runtime: Arc<AppRuntime>,
    app: &AppHandle,
    socket: UdpSocket,
    video_sender: broadcast::Sender<Vec<u8>>,
    mut shutdown: broadcast::Receiver<()>,
) {
    let mut packet_buffer = vec![0_u8; 65_536];
    let mut depacketizer = RtpH264Depacketizer::default();
    let mut reorder_buffer = RtpReorderBuffer::default();
    let mut loss_tracker = RtpLossTracker::default();
    let mut rate_tracker = VideoRateTracker::default();
    let mut packet_count = 0_u64;
    let mut access_unit_count = 0_u64;
    let mut had_preview_activity = false;
    let mut last_packet_at = None;
    let mut last_packet_source = None;
    let mut stats_interval =
        tokio::time::interval(Duration::from_millis(DIRECT_VIDEO_STATS_INTERVAL_MS));
    stats_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        let receive_result = tokio::select! {
            _ = shutdown.recv() => break,
            _ = stats_interval.tick() => {
                let now = Instant::now();
                let (rtp_packets_lost_total, rtp_loss_percent_5s) =
                    loss_tracker.snapshot(now);
                let (rx_bitrate_mbps_1s, encoded_fps_1s) = rate_tracker.snapshot(now);
                runtime
                    .update_direct_video_stats(DirectVideoReceiverStats {
                        packet_count,
                        access_unit_count,
                        last_packet_at,
                        last_packet_source: last_packet_source.clone(),
                        waiting_for_keyframe: depacketizer.waiting_for_keyframe(),
                        rtp_packets_lost_total,
                        rtp_loss_percent_5s,
                        rx_bitrate_mbps_1s,
                        encoded_fps_1s,
                    })
                    .await;
                if had_preview_activity {
                    runtime.register_preview_activity(app).await;
                    had_preview_activity = false;
                }
                continue;
            }
            recv_result = socket.recv_from(&mut packet_buffer) => match recv_result {
                Ok(parts) => Some(parts),
                Err(error) => {
                    runtime
                        .push_warning(app, format!("Live video RTP receiver failed: {error}"))
                        .await;
                    break;
                }
            }
        };
        let Some((size, source)) = receive_result else {
            continue;
        };

        packet_count = packet_count.saturating_add(1);
        let received_at = Instant::now();
        last_packet_at = Some(Utc::now());
        last_packet_source = Some(source.to_string());
        loss_tracker.observe_packet(&packet_buffer[..size], received_at);
        rate_tracker.observe_packet(received_at, size);
        for packet in reorder_buffer.push(packet_buffer[..size].to_vec(), received_at) {
            let access_units = depacketizer.push_rtp_packet(&packet);
            rate_tracker.observe_access_units(received_at, access_units.len());
            access_unit_count = access_unit_count.saturating_add(access_units.len() as u64);
            for access_unit in access_units {
                let _ = video_sender.send(access_unit);
                had_preview_activity = true;
            }
        }
    }
}

struct BufferedRtpPacket {
    received_at: Instant,
    bytes: Vec<u8>,
}

#[derive(Default)]
struct RtpReorderBuffer {
    ssrc: Option<u32>,
    next_extended_sequence: Option<u64>,
    max_extended_sequence: Option<u64>,
    pending: BTreeMap<u64, BufferedRtpPacket>,
}

impl RtpReorderBuffer {
    fn push(&mut self, packet: Vec<u8>, now: Instant) -> Vec<Vec<u8>> {
        let Some((sequence, ssrc)) = rtp_sequence_and_ssrc(&packet) else {
            return vec![packet];
        };

        if self.ssrc != Some(ssrc) {
            self.reset(ssrc, sequence);
        }

        let max_sequence = self.max_extended_sequence.unwrap_or(sequence as u64);
        let mut extended_sequence = extend_rtp_sequence(max_sequence, sequence);
        let next_sequence = self.next_extended_sequence.unwrap_or(extended_sequence);
        if extended_sequence > next_sequence.saturating_add(8_192) {
            self.reset(ssrc, sequence);
            extended_sequence = sequence as u64;
        } else if extended_sequence < next_sequence {
            return Vec::new();
        }

        self.max_extended_sequence = Some(
            self.max_extended_sequence
                .map(|current| current.max(extended_sequence))
                .unwrap_or(extended_sequence),
        );
        self.next_extended_sequence.get_or_insert(extended_sequence);
        self.pending
            .entry(extended_sequence)
            .or_insert(BufferedRtpPacket {
                received_at: now,
                bytes: packet,
            });
        self.drain_ready(now)
    }

    fn reset(&mut self, ssrc: u32, sequence: u16) {
        self.ssrc = Some(ssrc);
        self.next_extended_sequence = Some(sequence as u64);
        self.max_extended_sequence = Some(sequence as u64);
        self.pending.clear();
    }

    fn drain_ready(&mut self, now: Instant) -> Vec<Vec<u8>> {
        let mut output = Vec::new();
        loop {
            let Some(next_sequence) = self.next_extended_sequence else {
                break;
            };
            if let Some(packet) = self.pending.remove(&next_sequence) {
                output.push(packet.bytes);
                self.next_extended_sequence = Some(next_sequence.saturating_add(1));
                continue;
            }

            let waited_too_long = self
                .pending
                .values()
                .map(|packet| now.duration_since(packet.received_at))
                .max()
                .map(|age| age >= Duration::from_millis(RTP_REORDER_MAX_DELAY_MS))
                .unwrap_or(false);
            if self.pending.len() >= RTP_REORDER_MAX_PACKETS || waited_too_long {
                self.next_extended_sequence = self.pending.first_key_value().map(|(seq, _)| *seq);
                continue;
            }
            break;
        }
        output
    }
}

#[derive(Default)]
struct RtpLossTracker {
    ssrc: Option<u32>,
    max_extended_sequence: Option<u64>,
    pending_missing: BTreeMap<u64, Instant>,
    received_window: VecDeque<Instant>,
    loss_window: VecDeque<(Instant, u64)>,
    lost_total: u64,
    last_packet_at: Option<Instant>,
}

impl RtpLossTracker {
    fn observe_packet(&mut self, packet: &[u8], now: Instant) {
        let Some((sequence, ssrc)) = rtp_sequence_and_ssrc(packet) else {
            return;
        };
        self.finalize_and_prune(now);

        if self.ssrc != Some(ssrc) {
            self.reset_sequence(ssrc, sequence, now);
            return;
        }

        let Some(max_extended_sequence) = self.max_extended_sequence else {
            self.reset_sequence(ssrc, sequence, now);
            return;
        };
        let extended_sequence = extend_rtp_sequence(max_extended_sequence, sequence);
        let stale_restart = self
            .last_packet_at
            .map(|last_packet_at| {
                now.duration_since(last_packet_at)
                    > Duration::from_secs(VIDEO_STALE_AFTER_SECS as u64)
            })
            .unwrap_or(false)
            && extended_sequence.abs_diff(max_extended_sequence) > 1_024;
        if stale_restart || extended_sequence > max_extended_sequence.saturating_add(8_192) {
            self.reset_sequence(ssrc, sequence, now);
            return;
        }

        self.last_packet_at = Some(now);
        if extended_sequence > max_extended_sequence {
            for missing in max_extended_sequence + 1..extended_sequence {
                self.pending_missing.insert(missing, now);
            }
            self.max_extended_sequence = Some(extended_sequence);
            self.received_window.push_back(now);
        } else if self.pending_missing.remove(&extended_sequence).is_some() {
            self.received_window.push_back(now);
        }
    }

    fn reset_sequence(&mut self, ssrc: u32, sequence: u16, now: Instant) {
        self.ssrc = Some(ssrc);
        self.max_extended_sequence = Some(sequence as u64);
        self.pending_missing.clear();
        self.received_window.clear();
        self.loss_window.clear();
        self.last_packet_at = Some(now);
        self.received_window.push_back(now);
    }

    fn snapshot(&mut self, now: Instant) -> (u64, f64) {
        self.finalize_and_prune(now);
        let lost_in_window = self
            .loss_window
            .iter()
            .map(|(_, count)| *count)
            .sum::<u64>();
        let received_in_window = self.received_window.len() as u64;
        let expected_in_window = received_in_window.saturating_add(lost_in_window);
        let loss_percent = if expected_in_window == 0 {
            0.0
        } else {
            lost_in_window as f64 * 100.0 / expected_in_window as f64
        };
        (self.lost_total, loss_percent)
    }

    fn finalize_and_prune(&mut self, now: Instant) {
        let grace = Duration::from_millis(RTP_LOSS_REORDER_GRACE_MS);
        let expired = self
            .pending_missing
            .iter()
            .filter_map(|(sequence, first_missing_at)| {
                (now.duration_since(*first_missing_at) >= grace).then_some(*sequence)
            })
            .collect::<Vec<_>>();
        if !expired.is_empty() {
            let count = expired.len() as u64;
            for sequence in expired {
                self.pending_missing.remove(&sequence);
            }
            self.lost_total = self.lost_total.saturating_add(count);
            self.loss_window.push_back((now, count));
        }

        let rate_window = Duration::from_secs(RTP_LOSS_WINDOW_SECS);
        while self
            .received_window
            .front()
            .map(|received_at| now.duration_since(*received_at) > rate_window)
            .unwrap_or(false)
        {
            self.received_window.pop_front();
        }
        while self
            .loss_window
            .front()
            .map(|(lost_at, _)| now.duration_since(*lost_at) > rate_window)
            .unwrap_or(false)
        {
            self.loss_window.pop_front();
        }
    }
}

fn rtp_sequence_and_ssrc(packet: &[u8]) -> Option<(u16, u32)> {
    if packet.len() < 12 || packet[0] >> 6 != 2 {
        return None;
    }
    Some((
        u16::from_be_bytes([packet[2], packet[3]]),
        u32::from_be_bytes([packet[8], packet[9], packet[10], packet[11]]),
    ))
}

fn extend_rtp_sequence(max_extended_sequence: u64, sequence: u16) -> u64 {
    let cycle = max_extended_sequence & !0xffff;
    let mut candidate = cycle | sequence as u64;
    if candidate.saturating_add(32_768) < max_extended_sequence {
        candidate = candidate.saturating_add(65_536);
    } else if candidate > max_extended_sequence.saturating_add(32_768) && candidate >= 65_536 {
        candidate -= 65_536;
    }
    candidate
}

#[derive(Default)]
struct VideoRateTracker {
    byte_window: VecDeque<(Instant, usize)>,
    access_unit_window: VecDeque<Instant>,
}

impl VideoRateTracker {
    fn observe_packet(&mut self, now: Instant, bytes: usize) {
        self.byte_window.push_back((now, bytes));
        self.prune(now);
    }

    fn observe_access_units(&mut self, now: Instant, count: usize) {
        self.access_unit_window
            .extend(std::iter::repeat_n(now, count));
        self.prune(now);
    }

    fn snapshot(&mut self, now: Instant) -> (f64, f64) {
        self.prune(now);
        let bytes = self
            .byte_window
            .iter()
            .map(|(_, bytes)| *bytes as u64)
            .sum::<u64>();
        (
            bytes as f64 * 8.0 / 1_000_000.0,
            self.access_unit_window.len() as f64,
        )
    }

    fn prune(&mut self, now: Instant) {
        let window = Duration::from_millis(VIDEO_RATE_WINDOW_MS);
        while self
            .byte_window
            .front()
            .map(|(received_at, _)| now.duration_since(*received_at) > window)
            .unwrap_or(false)
        {
            self.byte_window.pop_front();
        }
        while self
            .access_unit_window
            .front()
            .map(|produced_at| now.duration_since(*produced_at) > window)
            .unwrap_or(false)
        {
            self.access_unit_window.pop_front();
        }
    }
}

struct RtpH264Depacketizer {
    expected_sequence: Option<u16>,
    current_access_unit: PendingAccessUnit,
    fragmented_nal: Option<FragmentedNal>,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    waiting_for_keyframe: bool,
}

impl Default for RtpH264Depacketizer {
    fn default() -> Self {
        Self {
            expected_sequence: None,
            current_access_unit: PendingAccessUnit::default(),
            fragmented_nal: None,
            sps: None,
            pps: None,
            waiting_for_keyframe: true,
        }
    }
}

#[derive(Default)]
struct PendingAccessUnit {
    timestamp: Option<u32>,
    nalus: Vec<Vec<u8>>,
    damaged: bool,
}

struct FragmentedNal {
    timestamp: u32,
    data: Vec<u8>,
    damaged: bool,
}

struct RtpPacket {
    marker: bool,
    sequence: u16,
    timestamp: u32,
    payload: Vec<u8>,
}

impl RtpH264Depacketizer {
    fn waiting_for_keyframe(&self) -> bool {
        self.waiting_for_keyframe
    }

    fn push_rtp_packet(&mut self, packet: &[u8]) -> Vec<Vec<u8>> {
        let Some(packet) = parse_rtp_packet(packet) else {
            return Vec::new();
        };

        if let Some(expected_sequence) = self.expected_sequence {
            if packet.sequence != expected_sequence {
                self.mark_sequence_gap(packet.timestamp);
            }
        }
        self.expected_sequence = Some(packet.sequence.wrapping_add(1));

        self.push_h264_payload(packet.timestamp, packet.marker, &packet.payload)
    }

    fn push_h264_payload(&mut self, timestamp: u32, marker: bool, payload: &[u8]) -> Vec<Vec<u8>> {
        let Some((&nal_header, rest)) = payload.split_first() else {
            return Vec::new();
        };
        let nal_type = nal_header & 0x1f;

        match nal_type {
            1..=23 => self.push_complete_nal(timestamp, marker, payload.to_vec()),
            24 => self.push_stap_a(timestamp, marker, rest),
            28 => self.push_fu_a(timestamp, marker, nal_header, rest),
            _ => {
                self.mark_packet_loss();
                Vec::new()
            }
        }
    }

    fn push_complete_nal(&mut self, timestamp: u32, marker: bool, nal: Vec<u8>) -> Vec<Vec<u8>> {
        let mut output = Vec::new();
        if self.current_access_unit.timestamp.is_some()
            && self.current_access_unit.timestamp != Some(timestamp)
        {
            if let Some(access_unit) = self.finish_access_unit() {
                output.push(access_unit);
            }
        }

        self.cache_parameter_set(&nal);
        self.current_access_unit.timestamp = Some(timestamp);
        self.current_access_unit.nalus.push(nal);

        if marker {
            if let Some(access_unit) = self.finish_access_unit() {
                output.push(access_unit);
            }
        }

        output
    }

    fn push_stap_a(&mut self, timestamp: u32, marker: bool, payload: &[u8]) -> Vec<Vec<u8>> {
        let mut offset = 0;
        let mut nalus = Vec::new();
        while offset + 2 <= payload.len() {
            let size = u16::from_be_bytes([payload[offset], payload[offset + 1]]) as usize;
            offset += 2;
            if size == 0 || offset + size > payload.len() {
                self.mark_packet_loss();
                return Vec::new();
            }
            nalus.push(payload[offset..offset + size].to_vec());
            offset += size;
        }

        let mut output = Vec::new();
        let last_index = nalus.len().saturating_sub(1);
        for (index, nal) in nalus.into_iter().enumerate() {
            output.extend(self.push_complete_nal(timestamp, marker && index == last_index, nal));
        }
        output
    }

    fn push_fu_a(
        &mut self,
        timestamp: u32,
        marker: bool,
        fu_indicator: u8,
        payload: &[u8],
    ) -> Vec<Vec<u8>> {
        let Some((&fu_header, fragment_payload)) = payload.split_first() else {
            self.mark_packet_loss();
            return Vec::new();
        };
        let start = fu_header & 0x80 != 0;
        let end = fu_header & 0x40 != 0;
        let nal_type = fu_header & 0x1f;

        if start {
            let reconstructed_header = (fu_indicator & 0xe0) | nal_type;
            let mut data = Vec::with_capacity(fragment_payload.len() + 1);
            data.push(reconstructed_header);
            data.extend_from_slice(fragment_payload);
            self.fragmented_nal = Some(FragmentedNal {
                timestamp,
                data,
                damaged: false,
            });
            return Vec::new();
        }

        let Some(fragment) = self.fragmented_nal.as_mut() else {
            self.mark_packet_loss();
            return Vec::new();
        };

        if fragment.timestamp != timestamp {
            self.mark_packet_loss();
            return Vec::new();
        }

        fragment.data.extend_from_slice(fragment_payload);
        if !end {
            return Vec::new();
        }

        let Some(fragment) = self.fragmented_nal.take() else {
            self.mark_packet_loss();
            return Vec::new();
        };
        if fragment.damaged {
            self.current_access_unit.damaged = true;
            return Vec::new();
        }

        self.push_complete_nal(timestamp, marker, fragment.data)
    }

    fn finish_access_unit(&mut self) -> Option<Vec<u8>> {
        let access_unit = std::mem::take(&mut self.current_access_unit);
        if access_unit.nalus.is_empty() || access_unit.damaged {
            self.waiting_for_keyframe = true;
            return None;
        }

        let has_idr = access_unit.nalus.iter().any(|nal| nal_type(nal) == Some(5));
        let has_sps = access_unit.nalus.iter().any(|nal| nal_type(nal) == Some(7));
        let has_pps = access_unit.nalus.iter().any(|nal| nal_type(nal) == Some(8));
        let has_config = (has_sps && has_pps) || (self.sps.is_some() && self.pps.is_some());

        if self.waiting_for_keyframe && (!has_idr || !has_config) {
            return None;
        }
        if has_idr && !has_config {
            self.waiting_for_keyframe = true;
            return None;
        }

        let mut output = Vec::new();
        if has_idr {
            if !has_sps {
                if let Some(sps) = &self.sps {
                    append_annex_b_nal(&mut output, sps);
                }
            }
            if !has_pps {
                if let Some(pps) = &self.pps {
                    append_annex_b_nal(&mut output, pps);
                }
            }
            self.waiting_for_keyframe = false;
        }

        for nal in access_unit.nalus {
            append_annex_b_nal(&mut output, &nal);
        }

        Some(output)
    }

    fn mark_sequence_gap(&mut self, next_timestamp: u32) {
        let gap_is_before_next_frame = self
            .current_access_unit
            .timestamp
            .map(|timestamp| timestamp != next_timestamp)
            .unwrap_or(true)
            && self
                .fragmented_nal
                .as_ref()
                .map(|fragment| fragment.timestamp != next_timestamp)
                .unwrap_or(true);

        if gap_is_before_next_frame {
            self.current_access_unit = PendingAccessUnit::default();
            self.fragmented_nal = None;
            self.waiting_for_keyframe = true;
            return;
        }

        self.mark_packet_loss();
    }

    fn cache_parameter_set(&mut self, nal: &[u8]) {
        match nal_type(nal) {
            Some(7) => self.sps = Some(nal.to_vec()),
            Some(8) => self.pps = Some(nal.to_vec()),
            _ => {}
        }
    }

    fn mark_packet_loss(&mut self) {
        self.current_access_unit.damaged = true;
        if let Some(fragment) = self.fragmented_nal.as_mut() {
            fragment.damaged = true;
        }
        self.waiting_for_keyframe = true;
    }
}

fn parse_rtp_packet(packet: &[u8]) -> Option<RtpPacket> {
    if packet.len() < 12 || packet[0] >> 6 != 2 {
        return None;
    }

    let padding = packet[0] & 0x20 != 0;
    let extension = packet[0] & 0x10 != 0;
    let csrc_count = (packet[0] & 0x0f) as usize;
    let marker = packet[1] & 0x80 != 0;
    let sequence = u16::from_be_bytes([packet[2], packet[3]]);
    let timestamp = u32::from_be_bytes([packet[4], packet[5], packet[6], packet[7]]);
    let mut payload_offset = 12 + csrc_count * 4;

    if packet.len() < payload_offset {
        return None;
    }

    if extension {
        if packet.len() < payload_offset + 4 {
            return None;
        }
        let extension_words =
            u16::from_be_bytes([packet[payload_offset + 2], packet[payload_offset + 3]]) as usize;
        payload_offset += 4 + extension_words * 4;
    }

    if packet.len() <= payload_offset {
        return None;
    }

    let payload_end = if padding {
        let padding_len = *packet.last()? as usize;
        if padding_len == 0 || padding_len >= packet.len().saturating_sub(payload_offset) {
            return None;
        }
        packet.len() - padding_len
    } else {
        packet.len()
    };

    if payload_end <= payload_offset {
        return None;
    }

    Some(RtpPacket {
        marker,
        sequence,
        timestamp,
        payload: packet[payload_offset..payload_end].to_vec(),
    })
}

fn nal_type(nal: &[u8]) -> Option<u8> {
    nal.first().map(|header| header & 0x1f)
}

fn append_annex_b_nal(output: &mut Vec<u8>, nal: &[u8]) {
    output.extend_from_slice(&[0, 0, 0, 1]);
    output.extend_from_slice(nal);
}

fn extract_latest_jpeg_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let mut latest_frame = None;
    while let Some(frame) = extract_next_jpeg_frame(buffer) {
        latest_frame = Some(frame);
    }
    latest_frame
}

fn extract_next_jpeg_frame(buffer: &mut Vec<u8>) -> Option<Vec<u8>> {
    let start = buffer
        .windows(2)
        .position(|window| window == [0xFF, 0xD8])?;
    if start > 0 {
        buffer.drain(..start);
    }

    let end_rel = buffer[2..]
        .windows(2)
        .position(|window| window == [0xFF, 0xD9])?;
    let end = end_rel + 4;
    let frame = buffer[..end].to_vec();
    buffer.drain(..end);
    Some(frame)
}

fn trim_preview_stream_buffer(buffer: &mut Vec<u8>) {
    if let Some(start) = buffer.windows(2).rposition(|window| window == [0xFF, 0xD8]) {
        if start > 0 {
            buffer.drain(..start);
        }
    } else {
        buffer.clear();
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

fn csv_json_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(Value::Bool(boolean)) => boolean.to_string(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::String(text)) => text.clone(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn rtp_packet(sequence: u16, timestamp: u32, marker: bool, payload: &[u8]) -> Vec<u8> {
        let mut packet = Vec::with_capacity(12 + payload.len());
        packet.push(0x80);
        packet.push(if marker { 0xe0 } else { 0x60 });
        packet.extend_from_slice(&sequence.to_be_bytes());
        packet.extend_from_slice(&timestamp.to_be_bytes());
        packet.extend_from_slice(&1_u32.to_be_bytes());
        packet.extend_from_slice(payload);
        packet
    }

    #[test]
    fn direct_h264_waits_for_keyframe_before_output() {
        let mut depacketizer = RtpH264Depacketizer::default();
        let non_idr = rtp_packet(1, 100, true, &[0x41, 0x9a, 0x22]);
        assert!(depacketizer.push_rtp_packet(&non_idr).is_empty());
        assert!(depacketizer.waiting_for_keyframe());

        let sps = rtp_packet(2, 200, false, &[0x67, 0x42, 0x00, 0x1f]);
        let pps = rtp_packet(3, 200, false, &[0x68, 0xce, 0x06, 0xe2]);
        let idr = rtp_packet(4, 200, true, &[0x65, 0x88, 0x84]);
        assert!(depacketizer.push_rtp_packet(&sps).is_empty());
        assert!(depacketizer.push_rtp_packet(&pps).is_empty());
        let output = depacketizer.push_rtp_packet(&idr);
        assert_eq!(output.len(), 1);
        assert!(!depacketizer.waiting_for_keyframe());
        assert!(output[0].windows(4).any(|window| window == [0, 0, 0, 1]));
    }

    #[test]
    fn sequence_gap_does_not_poison_keyframe_on_new_timestamp() {
        let mut depacketizer = RtpH264Depacketizer::default();
        let non_idr = rtp_packet(1, 100, true, &[0x41, 0x9a, 0x22]);
        assert!(depacketizer.push_rtp_packet(&non_idr).is_empty());

        let sps = rtp_packet(5, 200, false, &[0x67, 0x42, 0x00, 0x1f]);
        let pps = rtp_packet(6, 200, false, &[0x68, 0xce, 0x06, 0xe2]);
        let idr = rtp_packet(7, 200, true, &[0x65, 0x88, 0x84]);
        assert!(depacketizer.push_rtp_packet(&sps).is_empty());
        assert!(depacketizer.push_rtp_packet(&pps).is_empty());
        let output = depacketizer.push_rtp_packet(&idr);
        assert_eq!(output.len(), 1);
        assert!(!depacketizer.waiting_for_keyframe());
    }

    #[test]
    fn established_stream_waits_for_clean_keyframe_after_packet_loss() {
        let mut depacketizer = RtpH264Depacketizer::default();
        assert!(depacketizer
            .push_rtp_packet(&rtp_packet(1, 100, false, &[0x67, 0x42, 0x00, 0x1f]))
            .is_empty());
        assert!(depacketizer
            .push_rtp_packet(&rtp_packet(2, 100, false, &[0x68, 0xce, 0x06, 0xe2]))
            .is_empty());
        assert_eq!(
            depacketizer
                .push_rtp_packet(&rtp_packet(3, 100, true, &[0x65, 0x88, 0x84]))
                .len(),
            1
        );

        let damaged = depacketizer.push_rtp_packet(&rtp_packet(5, 200, true, &[0x41, 0x9a]));
        assert!(damaged.is_empty());
        assert!(depacketizer.waiting_for_keyframe());

        assert!(depacketizer
            .push_rtp_packet(&rtp_packet(6, 300, true, &[0x41, 0x9a]))
            .is_empty());
        let recovered = depacketizer.push_rtp_packet(&rtp_packet(7, 400, true, &[0x65, 0x88]));
        assert_eq!(recovered.len(), 1);
        assert!(!depacketizer.waiting_for_keyframe());
    }

    #[test]
    fn rtp_reorder_buffer_restores_short_out_of_order_sequence() {
        let start = Instant::now();
        let mut reorder = RtpReorderBuffer::default();
        assert_eq!(
            reorder
                .push(rtp_packet(10, 100, true, &[0x41]), start)
                .len(),
            1
        );
        assert!(reorder
            .push(
                rtp_packet(12, 300, true, &[0x41]),
                start + Duration::from_millis(1)
            )
            .is_empty());
        let restored = reorder.push(
            rtp_packet(11, 200, true, &[0x41]),
            start + Duration::from_millis(2),
        );
        let sequences = restored
            .iter()
            .filter_map(|packet| rtp_sequence_and_ssrc(packet).map(|(sequence, _)| sequence))
            .collect::<Vec<_>>();
        assert_eq!(sequences, vec![11, 12]);
    }

    #[test]
    fn rtp_reorder_buffer_releases_after_bounded_delay() {
        let start = Instant::now();
        let mut reorder = RtpReorderBuffer::default();
        assert_eq!(
            reorder
                .push(rtp_packet(20, 100, true, &[0x41]), start)
                .len(),
            1
        );
        assert!(reorder
            .push(
                rtp_packet(22, 300, true, &[0x41]),
                start + Duration::from_millis(1)
            )
            .is_empty());
        let released = reorder.push(
            rtp_packet(23, 400, true, &[0x41]),
            start + Duration::from_millis(RTP_REORDER_MAX_DELAY_MS + 1),
        );
        let sequences = released
            .iter()
            .filter_map(|packet| rtp_sequence_and_ssrc(packet).map(|(sequence, _)| sequence))
            .collect::<Vec<_>>();
        assert_eq!(sequences, vec![22, 23]);
    }

    #[test]
    fn rtp_loss_tracker_allows_reordering_before_finalizing_loss() {
        let start = Instant::now();
        let mut tracker = RtpLossTracker::default();
        tracker.observe_packet(&rtp_packet(1, 100, true, &[0x41]), start);
        tracker.observe_packet(
            &rtp_packet(4, 400, true, &[0x41]),
            start + Duration::from_millis(10),
        );
        tracker.observe_packet(
            &rtp_packet(2, 200, true, &[0x41]),
            start + Duration::from_millis(100),
        );

        let (lost_before_grace, _) = tracker.snapshot(start + Duration::from_millis(400));
        assert_eq!(lost_before_grace, 0);
        let (lost_after_grace, loss_percent) = tracker.snapshot(start + Duration::from_millis(600));
        assert_eq!(lost_after_grace, 1);
        assert!((loss_percent - 25.0).abs() < 0.001);
    }

    #[test]
    fn rtp_loss_tracker_does_not_count_reordered_or_wrapped_packets() {
        let start = Instant::now();
        let mut reordered = RtpLossTracker::default();
        reordered.observe_packet(&rtp_packet(10, 100, true, &[0x41]), start);
        reordered.observe_packet(
            &rtp_packet(12, 300, true, &[0x41]),
            start + Duration::from_millis(10),
        );
        reordered.observe_packet(
            &rtp_packet(11, 200, true, &[0x41]),
            start + Duration::from_millis(20),
        );
        assert_eq!(reordered.snapshot(start + Duration::from_millis(600)).0, 0);

        let mut wrapped = RtpLossTracker::default();
        for (index, sequence) in [65_534, 65_535, 0, 1].into_iter().enumerate() {
            wrapped.observe_packet(
                &rtp_packet(sequence, index as u32 * 100, true, &[0x41]),
                start + Duration::from_millis(index as u64 * 10),
            );
        }
        assert_eq!(wrapped.snapshot(start + Duration::from_millis(600)).0, 0);
    }

    #[test]
    fn video_rate_tracker_reports_rolling_bitrate_and_encoded_fps() {
        let start = Instant::now();
        let mut tracker = VideoRateTracker::default();
        tracker.observe_packet(start, 125_000);
        tracker.observe_access_units(start, 60);
        let (bitrate, fps) = tracker.snapshot(start);
        assert!((bitrate - 1.0).abs() < 0.001);
        assert_eq!(fps, 60.0);

        let (expired_bitrate, expired_fps) = tracker.snapshot(start + Duration::from_millis(1_001));
        assert_eq!(expired_bitrate, 0.0);
        assert_eq!(expired_fps, 0.0);
    }
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
    format!(
        "Flight {}",
        timestamp.with_timezone(&Local).format("%b %-d, %Y %H:%M")
    )
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
