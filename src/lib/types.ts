export type RuntimeMode = 'idle' | 'live';
export type MapMode = 'street_dark' | 'satellite';
export type AircraftIconShape = 'compass' | 'delta' | 'dart' | 'kite';
export type TrackLineStyle = 'solid' | 'dashed';

export type ConnectionStatus =
  | 'disconnected'
  | 'listening'
  | 'live'
  | 'receiving_telemetry'
  | 'receiving_alert'
  | 'stale';

export interface BatterySummary {
  percent?: number | null;
  voltage_v?: number | null;
}

export interface LinkSummary {
  quality_percent?: number | null;
  latency_ms?: number | null;
}

export interface AircraftIconConfig {
  size_px: number;
  color_hex: string;
  shape: AircraftIconShape;
}

export interface TrackDisplayConfig {
  enabled: boolean;
  color_hex: string;
  width_px: number;
  style: TrackLineStyle;
}

export interface FlightAlertConfig {
  high_speed_warning_mps: number;
  low_speed_warning_mps: number;
  high_altitude_warning_m: number;
  low_battery_warning_percent: number;
}

export interface HudMetricState {
  tone: 'normal' | 'caution' | 'warning';
  color_hex?: string | null;
  pulse?: boolean;
}

export interface AppConfig {
  listen_port: number;
  aircraft_label: string;
  map_style_url?: string | null;
  map_tile_template?: string | null;
  offline_maps_root?: string | null;
  selected_region_id?: string | null;
  enabled_region_ids: string[];
  region_name_overrides: Record<string, string>;
  default_map_mode: MapMode;
  default_fov_deg: number;
  default_range_m: number;
  stale_after_seconds: number;
  class_display_names: Record<string, string>;
  aircraft_icon: AircraftIconConfig;
  track_display: TrackDisplayConfig;
  flight_alerts: FlightAlertConfig;
}

export interface OfflineRegionManifest {
  id: string;
  name: string;
  bounds: [number, number, number, number];
  center: [number, number];
  street_pmtiles: string;
  street_source_type?: 'vector' | 'raster' | string | null;
  street_image?: string | null;
  satellite_pmtiles: string;
  satellite_image?: string | null;
  imagery_attribution?: string | null;
  imagery_capture_date?: string | null;
  street_style_path?: string | null;
}

export interface OfflineRegionCatalog {
  asset_origin: string;
  regions: OfflineRegionManifest[];
}

export interface AircraftLiveState {
  aircraft_id: string;
  lat?: number | null;
  lon?: number | null;
  alt_msl_m?: number | null;
  groundspeed_mps?: number | null;
  heading_deg?: number | null;
  flight_time_s?: number | null;
  armed: boolean;
  battery?: BatterySummary | null;
  link?: LinkSummary | null;
  last_update_at: string;
  extras: Record<string, unknown>;
}

export interface MapAlertSector {
  center_lat: number;
  center_lon: number;
  bearing_deg: number;
  fov_deg: number;
  range_m: number;
}

export interface AlertRecord {
  id: string;
  session_id: string;
  aircraft_id: string;
  class_label: string;
  confidence: number;
  detected_at: string;
  alt_msl_m?: number | null;
  image_path?: string | null;
  image_format?: string | null;
  sector: MapAlertSector;
  model_name?: string | null;
  extras: Record<string, unknown>;
}

export interface SystemStatusRecord {
  id: string;
  session_id: string;
  aircraft_id: string;
  status: string;
  message: string;
  reported_at: string;
  lat?: number | null;
  lon?: number | null;
  alt_msl_m?: number | null;
  heading_deg?: number | null;
  extras: Record<string, unknown>;
}

export interface MissionSession {
  id: string;
  name: string;
  description?: string | null;
  aircraft_id: string;
  source: string;
  started_at: string;
  ended_at?: string | null;
  is_active: boolean;
  event_count: number;
  alert_count: number;
  storage_bytes: number;
}

export interface ConnectionHealth {
  status: ConnectionStatus;
  port: number;
  last_packet_at?: string | null;
  note?: string | null;
}

export interface ReviewTelemetryFrame {
  message_id: string;
  recorded_at: string;
  live_state: AircraftLiveState;
}

export interface AppSnapshot {
  config: AppConfig;
  mode: RuntimeMode;
  connection: ConnectionHealth;
  active_session_id?: string | null;
  active_session_has_armed_telemetry: boolean;
  focused_session_id?: string | null;
  live_state?: AircraftLiveState | null;
  alerts: AlertRecord[];
  system_statuses: SystemStatusRecord[];
  sessions: MissionSession[];
  track: Array<[number, number]>;
  review_frames: ReviewTelemetryFrame[];
  raw_telemetry_packets: string[];
  warnings: string[];
}

export interface TelemetryPayload {
  lat?: number | null;
  lon?: number | null;
  alt_msl_m?: number | null;
  groundspeed_mps?: number | null;
  heading_deg?: number | null;
  flight_time_s?: number | null;
  armed: boolean;
  battery?: BatterySummary | null;
  link?: LinkSummary | null;
  extras?: Record<string, unknown>;
}

export interface AlertPayload {
  class_label: string;
  confidence: number;
  detected_at: string;
  lat: number;
  lon: number;
  alt_msl_m?: number | null;
  bearing_deg?: number | null;
  fov_deg?: number | null;
  range_m?: number | null;
  model_name?: string | null;
  image_format?: string | null;
  image_base64?: string | null;
  extras?: Record<string, unknown>;
}

export interface Envelope<TPayload> {
  schema_version: string;
  message_id: string;
  aircraft_id: string;
  sent_at: string;
  type: 'telemetry' | 'alert';
  payload: TPayload;
}

export type TelemetryEnvelope = Envelope<TelemetryPayload>;
export type AlertEnvelope = Envelope<AlertPayload>;

export type RuntimeEvent =
  | {
      type: 'snapshot';
      snapshot: AppSnapshot;
    }
  | {
      type: 'warning';
      message: string;
    };
