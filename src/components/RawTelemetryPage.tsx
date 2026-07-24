import { useMemo } from 'react';
import type { AircraftLiveState, ConnectionHealth } from '../lib/types';

interface RawTelemetryPageProps {
  liveState?: AircraftLiveState | null;
  connection: ConnectionHealth;
  rawPackets: string[];
  onExit: () => void;
}

type FieldCategory =
  | 'flight'
  | 'navigation'
  | 'attitude'
  | 'power'
  | 'aircraft'
  | 'compute'
  | 'video'
  | 'link'
  | 'additional';

interface FieldSpec {
  key: string;
  label: string;
  category: FieldCategory;
  unit?: string;
}

interface FieldMetadata {
  receivedAt?: string;
  source?: string;
}

interface DashboardField extends FieldSpec, FieldMetadata {
  value: unknown;
}

const FIELD_SPECS: FieldSpec[] = [
  { key: 'recorded_at', label: 'Recorded at', category: 'flight' },
  { key: 'message_id', label: 'Message ID', category: 'flight' },
  { key: 'aircraft_id', label: 'Aircraft ID', category: 'flight' },
  { key: 'armed', label: 'Armed', category: 'flight' },
  { key: 'legacy_armed', label: 'Legacy armed state', category: 'flight' },
  { key: 'flight_mode', label: 'Flight mode', category: 'flight' },
  { key: 'flight_time_s', label: 'Flight time', category: 'flight', unit: 's' },
  { key: 'time_boot_ms', label: 'Autopilot boot time', category: 'flight', unit: 'ms' },

  { key: 'lat', label: 'Latitude', category: 'navigation', unit: 'deg' },
  { key: 'lon', label: 'Longitude', category: 'navigation', unit: 'deg' },
  { key: 'alt_msl_m', label: 'Altitude MSL', category: 'navigation', unit: 'm' },
  { key: 'alt_demanded_m', label: 'Target altitude MSL', category: 'navigation', unit: 'm' },
  { key: 'groundspeed_mps', label: 'Ground speed', category: 'navigation', unit: 'm/s' },
  { key: 'vspeed_ms', label: 'Vertical speed', category: 'navigation', unit: 'm/s' },
  { key: 'heading_deg', label: 'Heading', category: 'navigation', unit: 'deg' },

  { key: 'pitch_deg', label: 'Pitch', category: 'attitude', unit: 'deg' },
  { key: 'roll_deg', label: 'Roll', category: 'attitude', unit: 'deg' },
  { key: 'nav_pitch_deg', label: 'Navigation pitch', category: 'attitude', unit: 'deg' },
  { key: 'nav_roll_deg', label: 'Navigation roll', category: 'attitude', unit: 'deg' },
  { key: 'throttle_pct', label: 'Throttle', category: 'attitude', unit: '%' },

  { key: 'battery_voltage_v', label: 'Battery voltage', category: 'power', unit: 'V' },
  { key: 'battery_percent', label: 'Battery remaining', category: 'power', unit: '%' },
  { key: 'battery_a', label: 'Battery current', category: 'power', unit: 'A' },
  { key: 'battery_mah', label: 'Battery used', category: 'power', unit: 'mAh' },
  { key: 'battery_wh', label: 'Energy consumed', category: 'power', unit: 'Wh' },
  { key: 'efficiency_wh_per_km', label: 'Live efficiency', category: 'power', unit: 'Wh/km' },
  {
    key: 'average_efficiency_wh_per_km',
    label: 'Average efficiency',
    category: 'power',
    unit: 'Wh/km'
  },

  { key: 'vib_x', label: 'Vibration X', category: 'aircraft' },
  { key: 'vib_y', label: 'Vibration Y', category: 'aircraft' },
  { key: 'vib_z', label: 'Vibration Z', category: 'aircraft' },

  { key: 'cpu_temp_c', label: 'CPU temperature', category: 'compute', unit: 'C' },
  { key: 'cpu_pct', label: 'CPU load', category: 'compute', unit: '%' },
  { key: 'cpu_mhz', label: 'CPU clock', category: 'compute', unit: 'MHz' },
  { key: 'npu_temp_c', label: 'NPU temperature', category: 'compute', unit: 'C' },
  { key: 'vision_active', label: 'Vision pipeline', category: 'compute' },

  { key: 'video_status', label: 'Video status', category: 'video' },
  { key: 'video_waiting_for_keyframe', label: 'Waiting for keyframe', category: 'video' },
  {
    key: 'video_rtp_packets_lost_total',
    label: 'RTP packets lost',
    category: 'video',
    unit: 'packets'
  },
  {
    key: 'video_rtp_loss_percent_5s',
    label: 'RTP loss (5 s)',
    category: 'video',
    unit: '%'
  },
  {
    key: 'video_rx_bitrate_mbps_1s',
    label: 'Receive bitrate',
    category: 'video',
    unit: 'Mbps'
  },
  { key: 'video_encoded_fps_1s', label: 'Encoded frame rate', category: 'video', unit: 'fps' },
  {
    key: 'video_rendered_fps_1s',
    label: 'Rendered frame rate',
    category: 'video',
    unit: 'fps'
  },
  {
    key: 'video_bridge_dropped_frames_total',
    label: 'Bridge frames dropped',
    category: 'video',
    unit: 'frames'
  },
  {
    key: 'video_decoder_dropped_frames_total',
    label: 'Decoder frames dropped',
    category: 'video',
    unit: 'frames'
  },
  {
    key: 'video_last_rendered_frame_age_ms',
    label: 'Last rendered frame age',
    category: 'video',
    unit: 'ms'
  },
  { key: 'video_stall_active', label: 'Video stall active', category: 'video' },

  { key: 'link_quality_percent', label: 'Link quality', category: 'link', unit: '%' },
  { key: 'link_latency_ms', label: 'Link latency', category: 'link', unit: 'ms' },
  { key: 'legacy_packet_type', label: 'Latest packet tier', category: 'link' },
  { key: 'sequence', label: 'Packet sequence', category: 'link' },
  { key: 'generated_at', label: 'Generated at', category: 'link' }
];

const CATEGORY_DETAILS: Array<{
  id: FieldCategory;
  title: string;
  description: string;
}> = [
  { id: 'flight', title: 'Flight and identity', description: 'Session and vehicle state' },
  { id: 'navigation', title: 'Position and navigation', description: 'Location and movement' },
  { id: 'attitude', title: 'Attitude and control', description: 'Orientation and guidance' },
  { id: 'power', title: 'Battery and energy', description: 'Electrical state and efficiency' },
  { id: 'aircraft', title: 'Aircraft health', description: 'Airframe measurements' },
  { id: 'compute', title: 'Compute and vision', description: 'Pi, NPU, and pipeline state' },
  { id: 'video', title: 'Live video', description: 'RTP, decoder, and render performance' },
  { id: 'link', title: 'Link and packet', description: 'Transport and packet metadata' },
  { id: 'additional', title: 'Additional logged fields', description: 'Unmapped telemetry columns' }
];

const FIELD_ALIASES: Record<string, string> = {
  alt_m: 'alt_msl_m',
  ground_speed_ms: 'groundspeed_mps',
  battery_v: 'battery_voltage_v',
  battery_pct: 'battery_percent',
  battery_remaining_pct: 'battery_percent'
};

function formatFieldLabel(key: string) {
  return key
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function formatFieldValue(value: unknown, unit?: string): string {
  if (value == null || value === '') return '--';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '--';
    const formatted = value.toLocaleString(undefined, {
      maximumFractionDigits: 6,
      useGrouping: false
    });
    return unit ? `${formatted}${unit === '%' ? unit : ` ${unit}`}` : formatted;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseRawPacket(rawPacket: string) {
  const jsonStart = rawPacket.indexOf('{');
  if (jsonStart === -1) return null;

  try {
    return {
      packet: JSON.parse(rawPacket.slice(jsonStart)) as Record<string, unknown>,
      receivedAt: rawPacket.match(/^\[([^\]]+)\]/)?.[1]
    };
  } catch {
    return null;
  }
}

function collectPacketMetadata(rawPackets: string[]) {
  const metadata = new Map<string, FieldMetadata>();
  const envelopeValues = new Map<string, unknown>();

  rawPackets.forEach((rawPacket) => {
    const parsed = parseRawPacket(rawPacket);
    if (!parsed) return;

    const { packet, receivedAt } = parsed;
    const packetType = packet.packet_type ?? packet.type;
    const source =
      typeof packetType === 'string' && packetType.length > 0 ? packetType.toUpperCase() : 'UDP';
    const canonicalPayload =
      packet.type === 'telemetry' &&
      packet.payload &&
      typeof packet.payload === 'object' &&
      !Array.isArray(packet.payload)
        ? (packet.payload as Record<string, unknown>)
        : null;
    const canonicalExtras =
      canonicalPayload?.extras &&
      typeof canonicalPayload.extras === 'object' &&
      !Array.isArray(canonicalPayload.extras)
        ? (canonicalPayload.extras as Record<string, unknown>)
        : null;

    const packetFields = canonicalPayload ?? packet;
    Object.keys(packetFields).forEach((rawKey) => {
      if (rawKey === 'extras') return;
      const key = FIELD_ALIASES[rawKey] ?? rawKey;
      metadata.set(key, { receivedAt, source });
    });
    Object.keys(canonicalExtras ?? {}).forEach((key) => {
      metadata.set(key, { receivedAt, source });
    });

    if (packet.message_id != null) {
      metadata.set('message_id', { receivedAt, source });
      envelopeValues.set('message_id', packet.message_id);
    }
    if (packet.sent_at != null) {
      metadata.set('recorded_at', { receivedAt, source });
      envelopeValues.set('recorded_at', packet.sent_at);
    }
  });

  return { metadata, envelopeValues };
}

function inferCategory(key: string): FieldCategory {
  if (key.startsWith('video_')) return 'video';
  if (
    key.startsWith('battery_') ||
    key.includes('efficiency') ||
    key.startsWith('energy_')
  ) {
    return 'power';
  }
  if (
    key.startsWith('cpu_') ||
    key.startsWith('npu_') ||
    key.startsWith('vision_')
  ) {
    return 'compute';
  }
  if (key.startsWith('vib_')) return 'aircraft';
  if (
    key.includes('packet') ||
    key.includes('sequence') ||
    key.includes('generated') ||
    key.startsWith('link_')
  ) {
    return 'link';
  }
  return 'additional';
}

function buildDashboardFields(
  liveState: AircraftLiveState | null | undefined,
  rawPackets: string[]
) {
  const { metadata, envelopeValues } = collectPacketMetadata(rawPackets);
  const values = new Map<string, unknown>(envelopeValues);

  if (liveState) {
    values.set('recorded_at', liveState.last_update_at);
    values.set('aircraft_id', liveState.aircraft_id);
    values.set('armed', liveState.armed);
    values.set('lat', liveState.lat);
    values.set('lon', liveState.lon);
    values.set('alt_msl_m', liveState.alt_msl_m);
    values.set('groundspeed_mps', liveState.groundspeed_mps);
    values.set('heading_deg', liveState.heading_deg);
    values.set('flight_time_s', liveState.flight_time_s);
    values.set('battery_voltage_v', liveState.battery?.voltage_v);
    values.set('battery_percent', liveState.battery?.percent);
    values.set('link_quality_percent', liveState.link?.quality_percent);
    values.set('link_latency_ms', liveState.link?.latency_ms);
    Object.entries(liveState.extras).forEach(([key, value]) => values.set(key, value));
  }

  const knownKeys = new Set(FIELD_SPECS.map((field) => field.key));
  const fields: DashboardField[] = FIELD_SPECS.map((field) => ({
    ...field,
    value: values.get(field.key),
    ...metadata.get(field.key)
  }));

  [...values.entries()]
    .filter(([key]) => !knownKeys.has(key) && key !== 'extras' && key !== 'raw_json')
    .sort(([first], [second]) => first.localeCompare(second, undefined, { numeric: true }))
    .forEach(([key, value]) => {
      fields.push({
        key,
        label: formatFieldLabel(key),
        category: inferCategory(key),
        value,
        ...metadata.get(key)
      });
    });

  return fields;
}

function FieldTable({ fields }: { fields: DashboardField[] }) {
  return (
    <div className="raw-data-page__table" role="table">
      <div className="raw-data-page__table-header" role="row">
        <span role="columnheader">Parameter</span>
        <span role="columnheader">Live value</span>
      </div>
      {fields.map((field) => (
        <div className="raw-data-page__table-row" role="row" key={field.key}>
          <span className="raw-data-page__field" role="cell" title={field.key}>
            <strong>{field.label}</strong>
            <small>{field.key}</small>
          </span>
          <span
            className="raw-data-page__value"
            role="cell"
            title={formatFieldValue(field.value, field.unit)}
          >
            {formatFieldValue(field.value, field.unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

export function RawTelemetryPage({
  liveState,
  connection,
  rawPackets,
  onExit
}: RawTelemetryPageProps) {
  const fields = useMemo(
    () => buildDashboardFields(liveState, rawPackets),
    [liveState, rawPackets]
  );
  const categories = CATEGORY_DETAILS.map((category) => ({
    ...category,
    fields: fields.filter((field) => field.category === category.id)
  })).filter((category) => category.id !== 'additional' || category.fields.length > 0);
  const populatedCount = fields.filter((field) => field.value != null && field.value !== '').length;

  return (
    <section className="raw-data-page" aria-label="Live flight data dashboard">
      <div className="raw-data-page__reporting" aria-live="polite">
        <span className={`raw-data-page__status raw-data-page__status--${connection.status}`} />
        <div>
          <strong>{populatedCount} / {fields.length}</strong>
          <span> fields reporting</span>
        </div>
      </div>

      <div className="raw-data-page__scroll">
        <div className="raw-data-page__sections">
          {categories.map((category) => (
            <section
              className={`raw-data-page__section raw-data-page__section--${category.id}`}
              key={category.id}
            >
              <div className="raw-data-page__section-heading">
                <div>
                  <strong>{category.title}</strong>
                  <span>{category.description}</span>
                </div>
                <b>{category.fields.length}</b>
              </div>
              <FieldTable fields={category.fields} />
            </section>
          ))}
        </div>
      </div>
      <button className="raw-data-page__exit secondary-button" type="button" onClick={onExit}>
        Exit
      </button>
    </section>
  );
}
