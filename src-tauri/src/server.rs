use std::{
    collections::VecDeque,
    sync::{Arc, Mutex as StdMutex},
};

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use hyper::{
    body::Bytes,
    header::{
        HeaderValue, ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
        ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH, CONTENT_RANGE,
        CONTENT_TYPE, RANGE,
    },
    service::service_fn,
    Body, HeaderMap, Method, Request, Response, StatusCode,
};
use tauri::{async_runtime::spawn, AppHandle};
use tokio::{
    fs::{metadata, File},
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom},
    net::{TcpListener, TcpStream, UdpSocket},
    sync::{broadcast, mpsc, Notify},
    time::{timeout, Duration, Instant},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::{
    models::LegacyTelemetryPacketType,
    runtime::{AppRuntime, IngestSource, LegacyTelemetryProcessResult},
};

const LEGACY_ALERT_LENGTH_TIMEOUT_SECS: u64 = 5;
const LEGACY_ALERT_PAYLOAD_TIMEOUT_SECS: u64 = 20;
const MAX_LEGACY_ALERT_PAYLOAD_BYTES: usize = 24 * 1024 * 1024;
const LEGACY_TELEMETRY_INGRESS_CAPACITY: usize = 2_048;
const LEGACY_TELEMETRY_BUFFER_BYTES: usize = 64 * 1024;
const LEGACY_TELEMETRY_PERSISTENCE_CAPACITY: usize = 8_192;
const LEGACY_TELEMETRY_BATCH_SIZE: usize = 64;
const LEGACY_TELEMETRY_BATCH_INTERVAL_MS: u64 = 200;
const LEGACY_TELEMETRY_FRONTEND_INTERVAL_MS: u64 = 100;

struct ReceivedLegacyTelemetry {
    bytes: Vec<u8>,
    packet_type: LegacyTelemetryPacketType,
    received_at: DateTime<Utc>,
    received_instant: Instant,
}

#[derive(Default)]
struct TelemetryIngressQueueState {
    packets: VecDeque<ReceivedLegacyTelemetry>,
    closed: bool,
    high_water: usize,
}

#[derive(Default)]
struct TelemetryQueuePushResult {
    depth: usize,
    high_water: usize,
    coalesced: u64,
    dropped: u64,
}

struct TelemetryIngressQueue {
    capacity: usize,
    state: StdMutex<TelemetryIngressQueueState>,
    available: Notify,
}

impl TelemetryIngressQueue {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            state: StdMutex::new(TelemetryIngressQueueState::default()),
            available: Notify::new(),
        }
    }

    fn push(&self, packet: ReceivedLegacyTelemetry) -> TelemetryQueuePushResult {
        let mut result = TelemetryQueuePushResult::default();
        let Ok(mut state) = self.state.lock() else {
            result.dropped = 1;
            return result;
        };
        if state.closed {
            result.dropped = 1;
            return result;
        }

        if state.packets.len() >= self.capacity {
            let replace_index = if packet.packet_type == LegacyTelemetryPacketType::OnChange {
                state
                    .packets
                    .iter()
                    .position(|queued| queued.packet_type != LegacyTelemetryPacketType::OnChange)
            } else {
                state
                    .packets
                    .iter()
                    .position(|queued| queued.packet_type == packet.packet_type)
            };

            if let Some(index) = replace_index {
                state.packets.remove(index);
                if packet.packet_type == LegacyTelemetryPacketType::OnChange {
                    result.dropped = 1;
                } else {
                    result.coalesced = 1;
                }
            } else if packet.packet_type != LegacyTelemetryPacketType::OnChange {
                result.dropped = 1;
                result.depth = state.packets.len();
                result.high_water = state.high_water;
                return result;
            } else {
                state.packets.pop_front();
                result.dropped = 1;
            }
        }

        state.packets.push_back(packet);
        state.high_water = state.high_water.max(state.packets.len());
        result.depth = state.packets.len();
        result.high_water = state.high_water;
        drop(state);
        self.available.notify_one();
        result
    }

    fn close(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.closed = true;
        }
        self.available.notify_waiters();
    }

    fn len(&self) -> usize {
        self.state
            .lock()
            .map(|state| state.packets.len())
            .unwrap_or_default()
    }

    async fn pop(&self) -> Option<ReceivedLegacyTelemetry> {
        loop {
            if let Ok(mut state) = self.state.lock() {
                if let Some(packet) = state.packets.pop_front() {
                    return Some(packet);
                }
                if state.closed {
                    return None;
                }
            } else {
                return None;
            }
            self.available.notified().await;
        }
    }
}

fn classify_legacy_packet_type(bytes: &[u8]) -> LegacyTelemetryPacketType {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return LegacyTelemetryPacketType::Unknown;
    };
    let Some(type_key) = text.find("\"type\"") else {
        return LegacyTelemetryPacketType::Unknown;
    };
    let Some(after_colon) = text[type_key + 6..].split_once(':').map(|(_, value)| value) else {
        return LegacyTelemetryPacketType::Unknown;
    };
    let value = after_colon.trim_start();
    if value.starts_with("\"hf\"") {
        LegacyTelemetryPacketType::HighFrequency
    } else if value.starts_with("\"mf\"") {
        LegacyTelemetryPacketType::MediumFrequency
    } else if value.starts_with("\"lf\"") {
        LegacyTelemetryPacketType::LowFrequency
    } else if value.starts_with("\"oc\"") {
        LegacyTelemetryPacketType::OnChange
    } else {
        LegacyTelemetryPacketType::Unknown
    }
}

pub fn spawn_websocket_server(
    runtime: Arc<AppRuntime>,
    app: AppHandle,
    port: u16,
    mut shutdown: broadcast::Receiver<()>,
) -> tauri::async_runtime::JoinHandle<()> {
    spawn(async move {
        let listener = match TcpListener::bind(("0.0.0.0", port)).await {
            Ok(listener) => listener,
            Err(error) => {
                runtime
                    .push_warning(
                        &app,
                        format!("Unable to bind telemetry WebSocket on port {port}: {error}"),
                    )
                    .await;
                return;
            }
        };

        loop {
            let (stream, peer_addr) = tokio::select! {
                _ = shutdown.recv() => break,
                accept_result = listener.accept() => match accept_result {
                    Ok(parts) => parts,
                    Err(error) => {
                        runtime
                            .push_warning(&app, format!("Telemetry accept error: {error}"))
                            .await;
                        continue;
                    }
                }
            };

            let runtime = runtime.clone();
            let app = app.clone();

            spawn(async move {
                let websocket = match accept_async(stream).await {
                    Ok(socket) => socket,
                    Err(error) => {
                        runtime
                            .push_warning(
                                &app,
                                format!("WebSocket handshake failed for {peer_addr}: {error}"),
                            )
                            .await;
                        return;
                    }
                };

                let (_, mut reader) = websocket.split();

                while let Some(message) = reader.next().await {
                    match message {
                        Ok(Message::Text(text)) => {
                            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                                let _ = runtime
                                    .ingest_json(&app, line, IngestSource::WebSocket)
                                    .await;
                            }
                        }
                        Ok(Message::Binary(bytes)) => match String::from_utf8(bytes.to_vec()) {
                            Ok(text) => {
                                for line in text.lines().filter(|line| !line.trim().is_empty()) {
                                    let _ = runtime
                                        .ingest_json(&app, line, IngestSource::WebSocket)
                                        .await;
                                }
                            }
                            Err(_) => {
                                runtime
                                    .push_warning(
                                        &app,
                                        "Received binary packet that was not valid UTF-8".into(),
                                    )
                                    .await;
                            }
                        },
                        Ok(Message::Close(_)) => break,
                        Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
                        Ok(Message::Frame(_)) => {}
                        Err(error) => {
                            runtime
                                .push_warning(
                                    &app,
                                    format!("Connection to {peer_addr} dropped: {error}"),
                                )
                                .await;
                            break;
                        }
                    }
                }
            });
        }
    })
}

pub fn spawn_offline_asset_server(
    runtime: Arc<AppRuntime>,
    mut shutdown: broadcast::Receiver<()>,
) -> Result<(String, tauri::async_runtime::JoinHandle<()>), String> {
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    std_listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let local_addr = std_listener
        .local_addr()
        .map_err(|error| error.to_string())?;

    let handle = spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Kerbodyne offline asset server failed to attach to Tokio: {error}");
                return;
            }
        };

        loop {
            let (stream, _) = tokio::select! {
                _ = shutdown.recv() => break,
                accept_result = listener.accept() => match accept_result {
                    Ok(parts) => parts,
                    Err(error) => {
                        eprintln!("Kerbodyne offline asset server listener failed: {error}");
                        break;
                    }
                }
            };

            let runtime = runtime.clone();
            spawn(async move {
                let service = service_fn(move |request| {
                    let runtime = runtime.clone();
                    async move {
                        Ok::<_, std::convert::Infallible>(
                            handle_asset_request(runtime, request).await,
                        )
                    }
                });

                if let Err(error) = hyper::server::conn::Http::new()
                    .http1_only(true)
                    .serve_connection(stream, service)
                    .await
                {
                    eprintln!("Kerbodyne offline asset server connection failed: {error}");
                }
            });
        }
    });

    Ok((format!("http://127.0.0.1:{}", local_addr.port()), handle))
}

pub fn spawn_legacy_telemetry_listener(
    runtime: Arc<AppRuntime>,
    app: AppHandle,
    socket: UdpSocket,
    mut shutdown: broadcast::Receiver<()>,
) -> Vec<tauri::async_runtime::JoinHandle<()>> {
    let ingress = Arc::new(TelemetryIngressQueue::new(
        LEGACY_TELEMETRY_INGRESS_CAPACITY,
    ));
    let (persistence_sender, mut persistence_receiver) =
        mpsc::channel(LEGACY_TELEMETRY_PERSISTENCE_CAPACITY);

    let persistence_runtime = runtime.clone();
    let persistence_app = app.clone();
    let persistence_handle = spawn(async move {
        loop {
            let Some(first) = persistence_receiver.recv().await else {
                break;
            };
            let mut batch = vec![first];
            let deadline =
                Instant::now() + Duration::from_millis(LEGACY_TELEMETRY_BATCH_INTERVAL_MS);
            let mut channel_closed = false;

            while batch.len() < LEGACY_TELEMETRY_BATCH_SIZE {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match timeout(remaining, persistence_receiver.recv()).await {
                    Ok(Some(write)) => batch.push(write),
                    Ok(None) => {
                        channel_closed = true;
                        break;
                    }
                    Err(_) => break,
                }
            }

            persistence_runtime.record_persistence_queue_depth(
                LEGACY_TELEMETRY_PERSISTENCE_CAPACITY - persistence_receiver.capacity(),
            );
            persistence_runtime
                .persist_telemetry_batch(&persistence_app, batch)
                .await;
            if channel_closed {
                break;
            }
        }
        persistence_runtime.record_persistence_queue_depth(0);
    });

    let processor_runtime = runtime.clone();
    let processor_app = app.clone();
    let processor_ingress = ingress.clone();
    let processor_handle = spawn(async move {
        let mut pending_track_points = Vec::new();
        let mut pending_raw_packets = Vec::new();
        let mut last_frontend_emit = Instant::now()
            .checked_sub(Duration::from_millis(LEGACY_TELEMETRY_FRONTEND_INTERVAL_MS))
            .unwrap_or_else(Instant::now);
        let mut warned_about_invalid_packet = false;
        let mut warned_about_persistence_overflow = false;

        while let Some(packet) = processor_ingress.pop().await {
            let queue_depth = processor_ingress.len();
            let text = match std::str::from_utf8(&packet.bytes) {
                Ok(text) => text,
                Err(_) => {
                    processor_runtime.record_telemetry_parse_error(queue_depth);
                    if !warned_about_invalid_packet {
                        warned_about_invalid_packet = true;
                        processor_runtime
                            .push_warning(
                                &processor_app,
                                "Received UDP telemetry that was not valid UTF-8 JSON".into(),
                            )
                            .await;
                    }
                    continue;
                }
            };

            let result = processor_runtime
                .ingest_legacy_telemetry_received(
                    &processor_app,
                    text,
                    IngestSource::CompatibilityTelemetry,
                    packet.received_at,
                    packet.received_instant,
                    queue_depth,
                )
                .await;

            let Some(LegacyTelemetryProcessResult {
                packet_type,
                persistence_write,
                track_point,
                raw_packet,
            }) = (match result {
                Ok(result) => result,
                Err(error) => {
                    processor_runtime.record_telemetry_parse_error(queue_depth);
                    if !warned_about_invalid_packet {
                        warned_about_invalid_packet = true;
                        processor_runtime
                            .push_warning(
                                &processor_app,
                                format!("Unable to process incoming telemetry: {error}"),
                            )
                            .await;
                    }
                    continue;
                }
            })
            else {
                continue;
            };

            pending_raw_packets.push(raw_packet);
            if let Some(point) = track_point {
                pending_track_points.push(point);
            }

            if let Some(write) = persistence_write {
                match persistence_sender.try_send(write) {
                    Ok(()) => {
                        processor_runtime.record_persistence_queue_depth(
                            LEGACY_TELEMETRY_PERSISTENCE_CAPACITY - persistence_sender.capacity(),
                        );
                    }
                    Err(mpsc::error::TrySendError::Full(write))
                        if packet_type == LegacyTelemetryPacketType::OnChange =>
                    {
                        if persistence_sender.send(write).await.is_err() {
                            processor_runtime.record_persistence_drop(1);
                        }
                    }
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        processor_runtime.record_persistence_drop(1);
                        if !warned_about_persistence_overflow {
                            warned_about_persistence_overflow = true;
                            processor_runtime
                                .push_warning(
                                    &processor_app,
                                    "Telemetry recording queue overflowed; live telemetry remains current but a recorded packet was dropped.".into(),
                                )
                                .await;
                        }
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        processor_runtime.record_persistence_drop(1);
                    }
                }
            }

            let should_emit = packet_type == LegacyTelemetryPacketType::OnChange
                || last_frontend_emit.elapsed()
                    >= Duration::from_millis(LEGACY_TELEMETRY_FRONTEND_INTERVAL_MS);
            if should_emit {
                let track_points = std::mem::take(&mut pending_track_points);
                let raw_packets = std::mem::take(&mut pending_raw_packets);
                let _ = processor_runtime
                    .emit_live_telemetry_update(&processor_app, track_points, raw_packets)
                    .await;
                last_frontend_emit = Instant::now();
            }
        }

        if !pending_track_points.is_empty() || !pending_raw_packets.is_empty() {
            let _ = processor_runtime
                .emit_live_telemetry_update(
                    &processor_app,
                    pending_track_points,
                    pending_raw_packets,
                )
                .await;
        }
        drop(persistence_sender);
    });

    let receiver_runtime = runtime;
    let receiver_app = app;
    let receiver_ingress = ingress;
    let receiver_handle = spawn(async move {
        let mut buffer = vec![0_u8; LEGACY_TELEMETRY_BUFFER_BYTES];

        loop {
            match tokio::select! {
                _ = shutdown.recv() => break,
                recv_result = socket.recv_from(&mut buffer) => recv_result,
            } {
                Ok((size, _)) => {
                    let received_instant = Instant::now();
                    let received_at = Utc::now();
                    let packet_type = classify_legacy_packet_type(&buffer[..size]);
                    let push_result = receiver_ingress.push(ReceivedLegacyTelemetry {
                        bytes: buffer[..size].to_vec(),
                        packet_type,
                        received_at,
                        received_instant,
                    });
                    receiver_runtime.record_telemetry_received(
                        packet_type,
                        received_at,
                        push_result.depth,
                        push_result.high_water,
                        push_result.coalesced,
                        push_result.dropped,
                    );
                }
                Err(error) => {
                    receiver_runtime.mark_legacy_udp_listener_down().await;
                    receiver_runtime
                        .push_warning(
                            &receiver_app,
                            format!("Telemetry UDP listener failed: {error}"),
                        )
                        .await;
                    break;
                }
            }
        }
        receiver_ingress.close();
    });

    vec![receiver_handle, processor_handle, persistence_handle]
}

pub fn spawn_legacy_alert_listener(
    runtime: Arc<AppRuntime>,
    app: AppHandle,
    listener: TcpListener,
    mut shutdown: broadcast::Receiver<()>,
) -> tauri::async_runtime::JoinHandle<()> {
    spawn(async move {
        loop {
            let (stream, addr) = match tokio::select! {
                _ = shutdown.recv() => break,
                accept_result = listener.accept() => accept_result,
            } {
                Ok(parts) => parts,
                Err(error) => {
                    runtime.mark_legacy_tcp_listener_down().await;
                    runtime
                        .push_warning(&app, format!("Alert TCP accept error: {error}"))
                        .await;
                    break;
                }
            };

            let runtime = runtime.clone();
            let app = app.clone();

            spawn(async move {
                if let Err(error) = receive_legacy_alert_stream(&runtime, &app, stream).await {
                    runtime
                        .push_warning(
                            &app,
                            format!("Error parsing incoming alert from {addr}: {error}"),
                        )
                        .await;
                }
            });
        }
    })
}

async fn receive_legacy_alert_stream(
    runtime: &Arc<AppRuntime>,
    app: &AppHandle,
    mut stream: TcpStream,
) -> Result<(), String> {
    let _ = stream.set_nodelay(true);

    loop {
        let mut length_bytes = [0_u8; 4];
        match timeout(
            Duration::from_secs(LEGACY_ALERT_LENGTH_TIMEOUT_SECS),
            stream.read_exact(&mut length_bytes),
        )
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => return Err("timed out waiting for TCP alert frame length".into()),
        }

        let message_length = u32::from_be_bytes(length_bytes) as usize;
        if message_length == 0 {
            return Err("received empty TCP alert frame".into());
        }
        if message_length > MAX_LEGACY_ALERT_PAYLOAD_BYTES {
            return Err(format!(
                "TCP alert frame too large: {} bytes exceeds {} byte limit",
                message_length, MAX_LEGACY_ALERT_PAYLOAD_BYTES
            ));
        }

        let mut payload = vec![0_u8; message_length];
        match timeout(
            Duration::from_secs(LEGACY_ALERT_PAYLOAD_TIMEOUT_SECS),
            stream.read_exact(&mut payload),
        )
        .await
        {
            Ok(Ok(_)) => {}
            Ok(Err(error)) => return Err(error.to_string()),
            Err(_) => {
                return Err(format!(
                    "timed out waiting for {} byte TCP alert payload",
                    message_length
                ))
            }
        }

        let raw_json = String::from_utf8(payload).map_err(|error| error.to_string())?;
        runtime
            .ingest_legacy_alert(app, &raw_json, IngestSource::CompatibilityAlert)
            .await?;
        let _ = stream.write_all(b"OK\n").await;
    }
}

async fn handle_asset_request(runtime: Arc<AppRuntime>, request: Request<Body>) -> Response<Body> {
    if request.method() == Method::OPTIONS {
        return with_cors(
            Response::builder()
                .status(StatusCode::NO_CONTENT)
                .body(Body::empty())
                .unwrap_or_else(|_| Response::new(Body::empty())),
        );
    }

    if request.method() != Method::GET && request.method() != Method::HEAD {
        return build_response(
            StatusCode::METHOD_NOT_ALLOWED,
            Some("text/plain; charset=utf-8"),
            b"Method not allowed".to_vec(),
        );
    }

    if request.uri().path() == "/__preview__/live.mjpg" {
        return handle_live_preview_request(runtime, request).await;
    }
    if request.uri().path() == "/__preview__/live.jpg" {
        return handle_live_preview_frame_request(runtime, request).await;
    }

    let asset_path = match runtime
        .resolve_offline_asset_path(request.uri().path())
        .await
    {
        Ok(Some(path)) => path,
        Ok(None) => {
            return build_response(
                StatusCode::NOT_FOUND,
                Some("text/plain; charset=utf-8"),
                b"Asset not found".to_vec(),
            )
        }
        Err(error) => {
            return build_response(
                StatusCode::BAD_REQUEST,
                Some("text/plain; charset=utf-8"),
                error.into_bytes(),
            )
        }
    };

    let file_metadata = match metadata(&asset_path).await {
        Ok(metadata) => metadata,
        Err(error) => {
            return build_response(
                StatusCode::NOT_FOUND,
                Some("text/plain; charset=utf-8"),
                error.to_string().into_bytes(),
            )
        }
    };
    let file_len = file_metadata.len();
    let content_type = content_type_for_path(&asset_path);
    let is_head = request.method() == Method::HEAD;

    let response = match parse_range_header(request.headers().get(RANGE), file_len) {
        Ok(Some((start, end))) => {
            let length = end - start + 1;
            let mut file = match File::open(&asset_path).await {
                Ok(file) => file,
                Err(error) => {
                    return build_response(
                        StatusCode::NOT_FOUND,
                        Some("text/plain; charset=utf-8"),
                        error.to_string().into_bytes(),
                    )
                }
            };

            if let Err(error) = file.seek(SeekFrom::Start(start)).await {
                return build_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Some("text/plain; charset=utf-8"),
                    error.to_string().into_bytes(),
                );
            }

            let body = if is_head {
                Vec::new()
            } else {
                let mut bytes = vec![0_u8; length as usize];
                if let Err(error) = file.read_exact(&mut bytes).await {
                    return build_response(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Some("text/plain; charset=utf-8"),
                        error.to_string().into_bytes(),
                    );
                }
                bytes
            };

            let mut response = Response::builder()
                .status(StatusCode::PARTIAL_CONTENT)
                .header(CONTENT_TYPE, content_type)
                .header(ACCEPT_RANGES, "bytes")
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{file_len}"))
                .header(CONTENT_LENGTH, length.to_string())
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()));
            apply_cors_headers(response.headers_mut());
            response
        }
        Ok(None) => {
            let body = if is_head {
                Vec::new()
            } else {
                match tokio::fs::read(&asset_path).await {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        return build_response(
                            StatusCode::INTERNAL_SERVER_ERROR,
                            Some("text/plain; charset=utf-8"),
                            error.to_string().into_bytes(),
                        )
                    }
                }
            };

            let mut response = Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, content_type)
                .header(ACCEPT_RANGES, "bytes")
                .header(CONTENT_LENGTH, file_len.to_string())
                .body(Body::from(body))
                .unwrap_or_else(|_| Response::new(Body::empty()));
            apply_cors_headers(response.headers_mut());
            response
        }
        Err(error) => {
            let mut response = Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(CONTENT_TYPE, "text/plain; charset=utf-8")
                .header(CONTENT_RANGE, format!("bytes */{file_len}"))
                .body(Body::from(error.into_bytes()))
                .unwrap_or_else(|_| Response::new(Body::empty()));
            apply_cors_headers(response.headers_mut());
            response
        }
    };

    response
}

async fn handle_live_preview_request(
    runtime: Arc<AppRuntime>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD {
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "multipart/x-mixed-replace; boundary=frame")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
        return with_cors(response);
    }

    let mut receiver = runtime.subscribe_preview_frames();
    let (mut sender, body) = Body::channel();

    spawn(async move {
        loop {
            let frame = receiver.borrow().clone();
            if let Some(frame) = frame {
                let mut chunk = format!(
                    "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: {}\r\n\r\n",
                    frame.len()
                )
                .into_bytes();
                chunk.extend_from_slice(&frame);
                chunk.extend_from_slice(b"\r\n");
                if sender.send_data(Bytes::from(chunk)).await.is_err() {
                    break;
                }
            }

            if receiver.changed().await.is_err() {
                break;
            }
        }
    });

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "multipart/x-mixed-replace; boundary=frame")
        .body(body)
        .unwrap_or_else(|_| Response::new(Body::empty()));
    with_cors(response)
}

async fn handle_live_preview_frame_request(
    runtime: Arc<AppRuntime>,
    request: Request<Body>,
) -> Response<Body> {
    if request.method() == Method::HEAD {
        let response = Response::builder()
            .status(StatusCode::OK)
            .header(CONTENT_TYPE, "image/jpeg")
            .header("Cache-Control", "no-store, no-cache, must-revalidate")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
        return with_cors(response);
    }

    let Some(frame) = runtime.latest_preview_frame().await else {
        let response = Response::builder()
            .status(StatusCode::NO_CONTENT)
            .header("Cache-Control", "no-store, no-cache, must-revalidate")
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
        return with_cors(response);
    };

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, "image/jpeg")
        .header(CONTENT_LENGTH, frame.len().to_string())
        .header("Cache-Control", "no-store, no-cache, must-revalidate")
        .body(Body::from(frame))
        .unwrap_or_else(|_| Response::new(Body::empty()));
    with_cors(response)
}

fn parse_range_header(
    value: Option<&HeaderValue>,
    file_len: u64,
) -> Result<Option<(u64, u64)>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.to_str().map_err(|error| error.to_string())?;
    if !value.starts_with("bytes=") {
        return Err("Unsupported range unit".into());
    }

    let spec = value.trim_start_matches("bytes=");
    if spec.contains(',') {
        return Err("Multiple ranges are not supported".into());
    }

    let (start_raw, end_raw) = spec
        .split_once('-')
        .ok_or_else(|| "Malformed Range header".to_string())?;

    if start_raw.is_empty() {
        let suffix_len = end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid Range header".to_string())?;
        if suffix_len == 0 || file_len == 0 {
            return Err("Invalid range".into());
        }
        let start = file_len.saturating_sub(suffix_len);
        return Ok(Some((start, file_len - 1)));
    }

    let start = start_raw
        .parse::<u64>()
        .map_err(|_| "Invalid Range header".to_string())?;
    let end = if end_raw.is_empty() {
        file_len.saturating_sub(1)
    } else {
        end_raw
            .parse::<u64>()
            .map_err(|_| "Invalid Range header".to_string())?
    };

    if file_len == 0 || start >= file_len || end < start {
        return Err("Requested range is not satisfiable".into());
    }

    Ok(Some((start, end.min(file_len - 1))))
}

fn build_response(status: StatusCode, content_type: Option<&str>, body: Vec<u8>) -> Response<Body> {
    let mut builder = Response::builder().status(status);
    if let Some(content_type) = content_type {
        builder = builder.header(CONTENT_TYPE, content_type);
    }
    builder = builder.header(CONTENT_LENGTH, body.len().to_string());
    let mut response = builder
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()));
    apply_cors_headers(response.headers_mut());
    response
}

fn with_cors(mut response: Response<Body>) -> Response<Body> {
    apply_cors_headers(response.headers_mut());
    response
}

fn apply_cors_headers(headers: &mut HeaderMap) {
    headers.insert(ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    headers.insert(
        ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET,HEAD,OPTIONS"),
    );
    headers.insert(
        ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
    headers.insert(
        ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Accept-Ranges, Content-Length, Content-Range, Content-Type"),
    );
}

fn content_type_for_path(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "json" => "application/json; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "pbf" => "application/x-protobuf",
        "pmtiles" => "application/vnd.pmtiles",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(packet_type: LegacyTelemetryPacketType) -> ReceivedLegacyTelemetry {
        ReceivedLegacyTelemetry {
            bytes: Vec::new(),
            packet_type,
            received_at: Utc::now(),
            received_instant: Instant::now(),
        }
    }

    #[test]
    fn packet_type_classifier_accepts_sender_json_spacing() {
        assert_eq!(
            classify_legacy_packet_type(br#"{"type": "hf", "lat": 1}"#),
            LegacyTelemetryPacketType::HighFrequency
        );
        assert_eq!(
            classify_legacy_packet_type(br#"{"type":"oc","armed":true}"#),
            LegacyTelemetryPacketType::OnChange
        );
    }

    #[tokio::test]
    async fn full_queue_coalesces_periodic_packets_but_preserves_on_change() {
        let queue = TelemetryIngressQueue::new(3);
        queue.push(packet(LegacyTelemetryPacketType::HighFrequency));
        queue.push(packet(LegacyTelemetryPacketType::MediumFrequency));
        queue.push(packet(LegacyTelemetryPacketType::OnChange));

        let result = queue.push(packet(LegacyTelemetryPacketType::HighFrequency));
        assert_eq!(result.coalesced, 1);
        assert_eq!(result.dropped, 0);
        queue.close();

        let types = [
            queue.pop().await.unwrap().packet_type,
            queue.pop().await.unwrap().packet_type,
            queue.pop().await.unwrap().packet_type,
        ];
        assert_eq!(
            types,
            [
                LegacyTelemetryPacketType::MediumFrequency,
                LegacyTelemetryPacketType::OnChange,
                LegacyTelemetryPacketType::HighFrequency,
            ]
        );
    }

    #[tokio::test]
    async fn periodic_packet_cannot_displace_control_only_queue() {
        let queue = TelemetryIngressQueue::new(2);
        queue.push(packet(LegacyTelemetryPacketType::OnChange));
        queue.push(packet(LegacyTelemetryPacketType::OnChange));
        let result = queue.push(packet(LegacyTelemetryPacketType::HighFrequency));
        assert_eq!(result.dropped, 1);
        assert_eq!(queue.len(), 2);
    }

    #[tokio::test]
    async fn burst_queue_remains_bounded_and_retains_control_transition() {
        let queue = TelemetryIngressQueue::new(64);
        for index in 0..5_000 {
            let packet_type = if index == 4_500 {
                LegacyTelemetryPacketType::OnChange
            } else if index % 2 == 0 {
                LegacyTelemetryPacketType::HighFrequency
            } else {
                LegacyTelemetryPacketType::MediumFrequency
            };
            queue.push(packet(packet_type));
        }
        assert_eq!(queue.len(), 64);
        queue.close();
        let mut saw_on_change = false;
        while let Some(packet) = queue.pop().await {
            saw_on_change |= packet.packet_type == LegacyTelemetryPacketType::OnChange;
        }
        assert!(saw_on_change);
    }
}
