use std::sync::Arc;

use futures_util::StreamExt;
use hyper::{
    header::{
        HeaderValue, ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_HEADERS, ACCESS_CONTROL_ALLOW_METHODS,
        ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CONTENT_LENGTH,
        CONTENT_RANGE, CONTENT_TYPE, RANGE,
    },
    service::service_fn,
    HeaderMap,
    Body, Method, Request, Response, StatusCode,
};
use tauri::{async_runtime::spawn, AppHandle};
use tokio::{
    fs::{metadata, File},
    io::{AsyncReadExt, AsyncSeekExt, SeekFrom},
    net::{TcpListener, TcpStream, UdpSocket},
};
use tokio_tungstenite::{accept_async, tungstenite::Message};

use crate::runtime::{AppRuntime, IngestSource};

pub fn spawn_websocket_server(runtime: Arc<AppRuntime>, app: AppHandle, port: u16) {
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
            let (stream, peer_addr) = match listener.accept().await {
                Ok(parts) => parts,
                Err(error) => {
                    runtime
                        .push_warning(&app, format!("Telemetry accept error: {error}"))
                        .await;
                    continue;
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
    });
}

pub fn spawn_offline_asset_server(runtime: Arc<AppRuntime>) -> Result<String, String> {
    let std_listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    std_listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let local_addr = std_listener
        .local_addr()
        .map_err(|error| error.to_string())?;

    spawn(async move {
        let listener = match TcpListener::from_std(std_listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Kerbodyne offline asset server failed to attach to Tokio: {error}");
                return;
            }
        };

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(parts) => parts,
                Err(error) => {
                    eprintln!("Kerbodyne offline asset server listener failed: {error}");
                    break;
                }
            };

            let runtime = runtime.clone();
            spawn(async move {
                let service = service_fn(move |request| {
                    let runtime = runtime.clone();
                    async move { Ok::<_, std::convert::Infallible>(handle_asset_request(runtime, request).await) }
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

    Ok(format!("http://127.0.0.1:{}", local_addr.port()))
}

pub fn spawn_legacy_telemetry_listener(
    runtime: Arc<AppRuntime>,
    app: AppHandle,
    socket: UdpSocket,
) -> tauri::async_runtime::JoinHandle<()> {
    spawn(async move {
        let mut buffer = [0_u8; 2048];

        loop {
            match socket.recv_from(&mut buffer).await {
                Ok((size, _)) => match std::str::from_utf8(&buffer[..size]) {
                    Ok(text) => {
                        let _ = runtime
                            .ingest_legacy_telemetry(
                                &app,
                                text,
                                IngestSource::CompatibilityTelemetry,
                            )
                            .await;
                    }
                    Err(_) => {
                        runtime
                            .push_warning(
                                &app,
                                "Received UDP telemetry that was not valid UTF-8 JSON".into(),
                            )
                            .await;
                    }
                },
                Err(error) => {
                    runtime
                        .push_warning(&app, format!("Telemetry UDP listener failed: {error}"))
                        .await;
                    break;
                }
            }
        }
    })
}

pub fn spawn_legacy_alert_listener(
    runtime: Arc<AppRuntime>,
    app: AppHandle,
    listener: TcpListener,
) -> tauri::async_runtime::JoinHandle<()> {
    spawn(async move {
        loop {
            let (stream, addr) = match listener.accept().await {
                Ok(parts) => parts,
                Err(error) => {
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
                        .push_warning(&app, format!("Error parsing incoming alert from {addr}: {error}"))
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
    let mut length_bytes = [0_u8; 4];
    stream
        .read_exact(&mut length_bytes)
        .await
        .map_err(|error| error.to_string())?;
    let message_length = u32::from_be_bytes(length_bytes) as usize;

    let mut payload = vec![0_u8; message_length];
    stream
        .read_exact(&mut payload)
        .await
        .map_err(|error| error.to_string())?;

    let raw_json = String::from_utf8(payload).map_err(|error| error.to_string())?;
    runtime
        .ingest_legacy_alert(app, &raw_json, IngestSource::CompatibilityAlert)
        .await
}

async fn handle_asset_request(
    runtime: Arc<AppRuntime>,
    request: Request<Body>,
) -> Response<Body> {
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

    let asset_path = match runtime.resolve_offline_asset_path(request.uri().path()).await {
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
