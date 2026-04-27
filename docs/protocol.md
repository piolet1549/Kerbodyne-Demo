# Kerbodyne Beta Protocol

The beta ground station accepts newline-delimited JSON messages over a persistent WebSocket connection from the aircraft-side Raspberry Pi.

## Envelope

Every message uses the same top-level envelope:

```json
{
  "schema_version": "kerbodyne.beta.v1",
  "message_id": "0d6a4d28-9f34-4ac9-bca9-00d7a9c11101",
  "aircraft_id": "prototype-001",
  "sent_at": "2026-04-13T16:00:03Z",
  "type": "telemetry",
  "payload": {}
}
```

Unknown top-level fields are allowed and should be preserved when practical.

## Telemetry Payload

```json
{
  "lat": 38.5754,
  "lon": -121.4932,
  "alt_msl_m": 182.6,
  "groundspeed_mps": 16.2,
  "heading_deg": 42.0,
  "flight_time_s": 96,
  "battery": {
    "percent": 86,
    "voltage_v": 21.8
  },
  "link": {
    "quality_percent": 91,
    "latency_ms": 43
  },
  "extras": {
    "mode": "AUTO",
    "gps_satellites": 15
  }
}
```

## Alert Payload

```json
{
  "class_label": "fire",
  "confidence": 0.94,
  "detected_at": "2026-04-13T16:00:18Z",
  "lat": 38.5762,
  "lon": -121.4911,
  "alt_msl_m": 184.0,
  "bearing_deg": 47.0,
  "fov_deg": 38.0,
  "range_m": 250.0,
  "model_name": "yolo-wildfire-v0.3",
  "image_format": "png",
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO2p4t8AAAAASUVORK5CYII="
}
```

`lat` and `lon` represent aircraft position at detection time for the beta UI. The cone shown on the map is an approximate line-of-sight wedge generated from aircraft position, `bearing_deg`, `fov_deg`, and `range_m`.

## Compatibility Rules

- `type` is currently `telemetry` or `alert`
- `class_label` is free-form
- telemetry can include unknown `extras` without requiring schema changes
- alert images can be PNG or JPEG as long as `image_format` matches the bytes
- timestamps should be ISO 8601 UTC strings

