use std::{
    collections::VecDeque,
    fs,
    path::PathBuf,
    sync::Arc,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    net::{TcpListener, UdpSocket},
    sync::{Mutex, RwLock},
    time::{sleep, Duration},
};
use uuid::Uuid;

use crate::{
    db::Database,
    geometry::distance_m,
    models::{
        AlertPayload, AlertRecord, AppConfig, AppSnapshot, AircraftLiveState, BatterySummary,
        ConnectionHealth, ConnectionStatus, DEFAULT_AIRCRAFT_ID, LEGACY_ALERT_PORT,
        LEGACY_TELEMETRY_PORT, LegacyAlertPacket, LegacySystemStatusPacket,
        LegacyTelemetryPacket, MapAlertSector, MissionSession, OfflineRegionCatalog,
        OfflineRegionManifest, ReplayFrame, ReviewTelemetryFrame, RuntimeEvent,
        RuntimeMode, SCHEMA_VERSION, SystemStatusPayload, SystemStatusRecord,
        TelemetryPayload, WireEnvelope,
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
    track: RwLock<Vec<(f64, f64)>>,
    session_has_armed_telemetry: RwLock<bool>,
    review_frames: RwLock<Vec<ReviewTelemetryFrame>>,
    raw_telemetry_packets: RwLock<Vec<String>>,
    warnings: RwLock<Vec<String>>,
    recent_message_ids: Mutex<VecDeque<String>>,
    current_session_id: RwLock<Option<String>>,
    current_session_source: RwLock<Option<String>>,
    focused_session_id: RwLock<Option<String>>,
    active_tasks: Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>,
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

        let database = Database::open(&data_dir.join("kerbodyne.db"))?;
        let mut config = database.load_config()?.unwrap_or_default();
        offline_maps::normalize_config(&mut config, &data_dir)?;
        database.save_config(&config)?;
        database.close_active_sessions(&Utc::now().to_rfc3339())?;
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
            raw_telemetry_packets: RwLock::new(Vec::new()),
            warnings: RwLock::new(Vec::new()),
            recent_message_ids: Mutex::new(VecDeque::new()),
            current_session_id: RwLock::new(None),
            current_session_source: RwLock::new(None),
            focused_session_id: RwLock::new(focused_session_id),
            active_tasks: Mutex::new(Vec::new()),
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
                if runtime.refresh_connection_health().await {
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
        self.begin_session(DEFAULT_AIRCRAFT_ID, LEGACY_SOURCE_LABEL)
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

    pub async fn complete_active_stream(
        &self,
        app: &AppHandle,
        save: bool,
        name: Option<String>,
        description: Option<String>,
    ) -> Result<(), String> {
        let had_connection = self.connection.read().await.last_packet_at.is_some();
        let has_armed_telemetry = *self.session_has_armed_telemetry.read().await;
        let should_save = save && had_connection && has_armed_telemetry;
        let session_id = self
            .current_session_id
            .read()
            .await
            .clone()
            .ok_or_else(|| "No active flight to stop.".to_string())?;

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

        self.end_current_session().await?;
        *self.session_has_armed_telemetry.write().await = false;
        self.raw_telemetry_packets.write().await.clear();

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
            *self.live_state.write().await = None;
        }

        if should_save {
            self.load_session_data(Some(session_id)).await?;
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
        let review_frames = match session_id.as_deref() {
            Some(id) => review_frames_from_replay(self.db.load_replay_events(id)?),
            None => Vec::new(),
        };

        *self.focused_session_id.write().await = session_id;
        *self.alerts.write().await = alerts;
        *self.system_statuses.write().await = system_statuses;
        *self.track.write().await = track;
        *self.review_frames.write().await = review_frames;
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

        self.end_current_session().await?;
        *self.live_state.write().await = None;
        *self.focused_session_id.write().await = None;
        self.track.write().await.clear();
        self.alerts.write().await.clear();
        self.system_statuses.write().await.clear();
        *self.session_has_armed_telemetry.write().await = false;
        self.review_frames.write().await.clear();
        self.raw_telemetry_packets.write().await.clear();
        *self.mode.write().await = RuntimeMode::Idle;
        let port = self.config.read().await.listen_port;
        *self.connection.write().await = ConnectionHealth::disconnected(port);
        self.emit_snapshot(app).await?;
        Ok(())
    }

    async fn refresh_connection_health(&self) -> bool {
        let stale_after_seconds = self.config.read().await.stale_after_seconds;
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

        let armed = packet.armed.unwrap_or(true);
        let has_any_state = packet.alt_m.is_some()
            || packet.ground_speed_ms.is_some()
            || packet.heading_deg.is_some()
            || packet.battery_v.is_some()
            || packet.battery_remaining_pct.is_some()
            || packet.lat.is_some()
            || packet.lon.is_some();

        if !has_any_state {
            self.update_connection_activity(
                ConnectionStatus::ReceivingTelemetry,
                "Telemetry packet received; awaiting aircraft state".into(),
                Some(Utc::now().to_rfc3339()),
            )
            .await;
            self.emit_snapshot(app).await?;
            return Ok(());
        }

        let now = Utc::now().to_rfc3339();
        let message_id = format!("legacy-telemetry-{}", Uuid::new_v4());
        let mut extras = packet.extras;
        extras.insert("legacy_armed".into(), Value::Bool(armed));
        let payload = TelemetryPayload {
            lat: if armed { packet.lat } else { None },
            lon: if armed { packet.lon } else { None },
            alt_msl_m: packet.alt_m,
            groundspeed_mps: packet.ground_speed_ms,
            heading_deg: packet.heading_deg,
            flight_time_s: None,
            armed,
            battery: Some(BatterySummary {
                percent: packet.battery_remaining_pct,
                voltage_v: packet.battery_v,
            }),
            link: None,
            extras,
        };

        let canonical_raw_json = serde_json::to_string(&json!({
            "schema_version": SCHEMA_VERSION,
            "message_id": message_id,
            "aircraft_id": DEFAULT_AIRCRAFT_ID,
            "sent_at": now,
            "type": "telemetry",
            "payload": payload
        }))
        .map_err(|error| error.to_string())?;

        self.ingest_json(app, &canonical_raw_json, source).await
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

        self.update_runtime_status(source, &sent_at).await;
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

        self.update_runtime_status(source, &sent_at).await;
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

        self.update_runtime_status(source, &sent_at).await;
        self.record_event(&session_id, canonical_raw_json, &sent_at, false)
            .await?;

        if is_error_status(&record.status) {
            self.push_warning(
                app,
                format!("Aircraft reported {}: {}", record.status, record.message),
            )
            .await;
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

    async fn update_connection_activity(
        &self,
        status: ConnectionStatus,
        note: String,
        last_packet_at: Option<String>,
    ) {
        let mut connection = self.connection.write().await;
        connection.status = status;
        connection.last_packet_at = last_packet_at;
        connection.note = Some(note);
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
        let image_paths = self.db.delete_session(session_id)?;
        for image_path in image_paths {
            let _ = fs::remove_file(&image_path);
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
            .map(|(last_lat, last_lon)| distance_m(*last_lat, *last_lon, lat, lon) >= 12.0)
            .unwrap_or(true);

        if should_store {
            track.push((lat, lon));
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

fn sanitize_extension(extension: &str) -> &str {
    match extension {
        "jpg" | "jpeg" => "jpg",
        "png" => "png",
        _ => "bin",
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
