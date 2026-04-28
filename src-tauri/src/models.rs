use std::collections::{BTreeMap, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SCHEMA_VERSION: &str = "kerbodyne.beta.v1";
pub const DEFAULT_AIRCRAFT_ID: &str = "prototype-001";
pub const LEGACY_TELEMETRY_PORT: u16 = 5001;
pub const LEGACY_ALERT_PORT: u16 = 5000;

fn default_armed() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AppConfig {
    pub listen_port: u16,
    pub aircraft_label: String,
    pub map_style_url: Option<String>,
    pub map_tile_template: Option<String>,
    pub offline_maps_root: Option<String>,
    #[serde(alias = "active_region_id")]
    pub selected_region_id: Option<String>,
    pub enabled_region_ids: Vec<String>,
    pub region_name_overrides: BTreeMap<String, String>,
    pub default_map_mode: MapMode,
    pub default_fov_deg: f64,
    pub default_range_m: f64,
    pub stale_after_seconds: u64,
    pub class_display_names: BTreeMap<String, String>,
    pub aircraft_icon: AircraftIconConfig,
    pub track_display: TrackDisplayConfig,
    pub flight_alerts: FlightAlertConfig,
}

impl Default for AppConfig {
    fn default() -> Self {
        let mut class_display_names = BTreeMap::new();
        class_display_names.insert("fire".into(), "Fire".into());
        class_display_names.insert("smoke".into(), "Smoke".into());

        Self {
            listen_port: 8765,
            aircraft_label: "Kerbodyne Beta Vehicle".into(),
            map_style_url: None,
            map_tile_template: None,
            offline_maps_root: None,
            selected_region_id: None,
            enabled_region_ids: Vec::new(),
            region_name_overrides: BTreeMap::new(),
            default_map_mode: MapMode::Satellite,
            default_fov_deg: 38.0,
            default_range_m: 250.0,
            stale_after_seconds: 10,
            class_display_names,
            aircraft_icon: AircraftIconConfig::default(),
            track_display: TrackDisplayConfig::default(),
            flight_alerts: FlightAlertConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MapMode {
    StreetDark,
    Satellite,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AircraftIconShape {
    Compass,
    Delta,
    Dart,
    Kite,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AircraftIconConfig {
    pub size_px: u16,
    pub color_hex: String,
    pub shape: AircraftIconShape,
}

impl Default for AircraftIconConfig {
    fn default() -> Self {
        Self {
            size_px: 38,
            color_hex: "#f7f7f7".into(),
            shape: AircraftIconShape::Compass,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TrackLineStyle {
    Solid,
    Dashed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackDisplayConfig {
    pub enabled: bool,
    pub color_hex: String,
    pub width_px: f64,
    pub style: TrackLineStyle,
}

impl Default for TrackDisplayConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            color_hex: "#f0f0f0".into(),
            width_px: 2.8,
            style: TrackLineStyle::Solid,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlightAlertConfig {
    pub high_speed_warning_mps: f64,
    pub low_speed_warning_mps: f64,
    pub high_altitude_warning_m: f64,
    pub low_battery_warning_percent: f64,
}

impl Default for FlightAlertConfig {
    fn default() -> Self {
        Self {
            high_speed_warning_mps: 35.0,
            low_speed_warning_mps: 9.0,
            high_altitude_warning_m: 120.0,
            low_battery_warning_percent: 20.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineRegionManifest {
    pub id: String,
    pub name: String,
    pub bounds: [f64; 4],
    pub center: [f64; 2],
    pub street_pmtiles: String,
    pub street_source_type: Option<String>,
    pub street_image: Option<String>,
    pub satellite_pmtiles: String,
    pub satellite_image: Option<String>,
    pub imagery_attribution: Option<String>,
    pub imagery_capture_date: Option<String>,
    pub street_style_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineRegionCatalog {
    pub asset_origin: String,
    pub regions: Vec<OfflineRegionManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BatterySummary {
    pub percent: Option<f64>,
    pub voltage_v: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LinkSummary {
    pub quality_percent: Option<f64>,
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelemetryPayload {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_msl_m: Option<f64>,
    pub groundspeed_mps: Option<f64>,
    pub heading_deg: Option<f64>,
    pub flight_time_s: Option<f64>,
    #[serde(default = "default_armed")]
    pub armed: bool,
    #[serde(default)]
    pub battery: Option<BatterySummary>,
    #[serde(default)]
    pub link: Option<LinkSummary>,
    #[serde(default)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertPayload {
    pub class_label: String,
    pub confidence: f64,
    pub detected_at: String,
    pub lat: f64,
    pub lon: f64,
    pub alt_msl_m: Option<f64>,
    pub bearing_deg: Option<f64>,
    pub fov_deg: Option<f64>,
    pub range_m: Option<f64>,
    pub model_name: Option<String>,
    pub image_format: Option<String>,
    pub image_base64: Option<String>,
    #[serde(default)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireEnvelope<T> {
    pub schema_version: String,
    pub message_id: String,
    pub aircraft_id: String,
    pub sent_at: String,
    #[serde(rename = "type")]
    pub envelope_type: String,
    pub payload: T,
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AircraftLiveState {
    pub aircraft_id: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_msl_m: Option<f64>,
    pub groundspeed_mps: Option<f64>,
    pub heading_deg: Option<f64>,
    pub flight_time_s: Option<f64>,
    #[serde(default = "default_armed")]
    pub armed: bool,
    pub battery: Option<BatterySummary>,
    pub link: Option<LinkSummary>,
    pub last_update_at: String,
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapAlertSector {
    pub center_lat: f64,
    pub center_lon: f64,
    pub bearing_deg: f64,
    pub fov_deg: f64,
    pub range_m: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AlertRecord {
    pub id: String,
    pub session_id: String,
    pub aircraft_id: String,
    pub class_label: String,
    pub confidence: f64,
    pub detected_at: String,
    pub alt_msl_m: Option<f64>,
    pub image_path: Option<String>,
    pub image_format: Option<String>,
    pub sector: MapAlertSector,
    pub model_name: Option<String>,
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatusPayload {
    pub status: String,
    pub message: String,
    pub reported_at: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_msl_m: Option<f64>,
    pub heading_deg: Option<f64>,
    #[serde(default)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemStatusRecord {
    pub id: String,
    pub session_id: String,
    pub aircraft_id: String,
    pub status: String,
    pub message: String,
    pub reported_at: String,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_msl_m: Option<f64>,
    pub heading_deg: Option<f64>,
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissionSession {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub aircraft_id: String,
    pub source: String,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub is_active: bool,
    pub event_count: u32,
    pub alert_count: u32,
    #[serde(default)]
    pub storage_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Disconnected,
    Listening,
    Live,
    ReceivingTelemetry,
    ReceivingAlert,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionHealth {
    pub status: ConnectionStatus,
    pub port: u16,
    pub last_packet_at: Option<String>,
    pub note: Option<String>,
}

impl ConnectionHealth {
    pub fn disconnected(port: u16) -> Self {
        Self {
            status: ConnectionStatus::Disconnected,
            port,
            last_packet_at: None,
            note: Some("Awaiting telemetry".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeMode {
    Idle,
    Live,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSnapshot {
    pub config: AppConfig,
    pub mode: RuntimeMode,
    pub connection: ConnectionHealth,
    pub active_session_id: Option<String>,
    pub active_session_has_armed_telemetry: bool,
    pub focused_session_id: Option<String>,
    pub live_state: Option<AircraftLiveState>,
    pub alerts: Vec<AlertRecord>,
    pub system_statuses: Vec<SystemStatusRecord>,
    pub sessions: Vec<MissionSession>,
    pub track: Vec<(f64, f64)>,
    pub review_frames: Vec<ReviewTelemetryFrame>,
    pub raw_telemetry_packets: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RuntimeEvent {
    Snapshot { snapshot: AppSnapshot },
    Warning { message: String },
}

#[derive(Debug, Clone)]
pub struct ReplayFrame {
    pub envelope_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewTelemetryFrame {
    pub message_id: String,
    pub recorded_at: String,
    pub live_state: AircraftLiveState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyTelemetryPacket {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_m: Option<f64>,
    pub ground_speed_ms: Option<f64>,
    pub heading_deg: Option<f64>,
    pub battery_v: Option<f64>,
    pub battery_remaining_pct: Option<f64>,
    pub armed: Option<bool>,
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct LegacyAlertTelemetrySnapshot {
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub alt_m: Option<f64>,
    pub ground_speed_ms: Option<f64>,
    pub heading_deg: Option<f64>,
    pub battery_v: Option<f64>,
    pub battery_remaining_pct: Option<f64>,
    pub armed: Option<bool>,
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyAlertPacket {
    #[serde(default)]
    pub packet_type: Option<String>,
    pub timestamp: String,
    pub detection_type: String,
    pub confidence: f64,
    #[serde(default)]
    pub telemetry: LegacyAlertTelemetrySnapshot,
    pub image_data: String,
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacySystemStatusPacket {
    #[serde(default)]
    pub packet_type: Option<String>,
    pub timestamp: String,
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub telemetry: LegacyAlertTelemetrySnapshot,
    #[serde(flatten)]
    pub extras: HashMap<String, Value>,
}

#[cfg(test)]
mod tests {
    use super::{
        LegacyAlertPacket, LegacySystemStatusPacket, LegacyTelemetryPacket, TelemetryPayload,
        WireEnvelope, SCHEMA_VERSION,
    };

    #[test]
    fn telemetry_envelope_roundtrips() {
        let raw = r#"{
            "schema_version":"kerbodyne.beta.v1",
            "message_id":"abc",
            "aircraft_id":"prototype-001",
            "sent_at":"2026-04-13T16:00:00Z",
            "type":"telemetry",
            "payload":{
                "lat":38.5,
                "lon":-121.4,
                "alt_msl_m":180.0
            }
        }"#;

        let envelope: WireEnvelope<TelemetryPayload> = serde_json::from_str(raw).unwrap();
        assert_eq!(envelope.schema_version, SCHEMA_VERSION);
        assert_eq!(envelope.envelope_type, "telemetry");
        assert_eq!(envelope.payload.lat, Some(38.5));
        assert!(envelope.payload.armed);
    }

    #[test]
    fn legacy_telemetry_packet_roundtrips() {
        let raw = r#"{
            "lat":38.5,
            "lon":-121.4,
            "alt_m":180.0,
            "ground_speed_ms":15.2,
            "heading_deg":47,
            "battery_v":21.8,
            "battery_remaining_pct":87
        }"#;

        let packet: LegacyTelemetryPacket = serde_json::from_str(raw).unwrap();
        assert_eq!(packet.lat, Some(38.5));
        assert_eq!(packet.alt_m, Some(180.0));
        assert_eq!(packet.battery_remaining_pct, Some(87.0));
    }

    #[test]
    fn legacy_alert_packet_roundtrips() {
        let raw = r#"{
            "packet_type":"detection_alert",
            "timestamp":"2026-04-20 12:00:00",
            "detection_type":"Fire",
            "confidence":0.92,
            "telemetry":{"lat":38.5,"lon":-121.4,"heading_deg":33},
            "image_data":"ZmFrZQ=="
        }"#;

        let packet: LegacyAlertPacket = serde_json::from_str(raw).unwrap();
        assert_eq!(packet.detection_type, "Fire");
        assert_eq!(packet.telemetry.heading_deg, Some(33.0));
    }

    #[test]
    fn legacy_system_status_packet_roundtrips() {
        let raw = r#"{
            "packet_type":"system_status",
            "timestamp":"2026-04-20 12:00:00",
            "status":"STARTUP_SUCCESS",
            "message":"Vision node initialized",
            "telemetry":{"lat":38.5,"lon":-121.4,"heading_deg":33}
        }"#;

        let packet: LegacySystemStatusPacket = serde_json::from_str(raw).unwrap();
        assert_eq!(packet.status, "STARTUP_SUCCESS");
        assert_eq!(packet.telemetry.lon, Some(-121.4));
    }
}
