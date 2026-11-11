use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use bytes::Bytes;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use qrcode::QrCode;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncSeekExt, SeekFrom};
use tokio_util::io::ReaderStream;

use crate::auth;
use crate::net::Interface;
use crate::store::{now_secs, FileMeta, FileStatus, NewUpload, Store, StoreError};
use crate::VERSION;

pub const MAX_CHUNK: usize = 8 * 1024 * 1024;
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
const MAX_FAILURES: usize = 20;
const MAX_TRACKED_CLIENTS: usize = 5000;

#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    pub key: Arc<str>,
    pub device_name: Arc<str>,
    pub interfaces: Arc<Vec<Interface>>,
    pub started_at: u64,
    pub auth_failures: Arc<Mutex<HashMap<IpAddr, Vec<Instant>>>>,
}

pub fn router(state: AppState) -> Router {
    let gated = Router::new()
        .route("/info", get(info))
        .route("/files", get(list_files))
        .route("/files/{id}", get(get_file).delete(delete_file))
        .route("/files/{id}/download", get(download))
        .route("/uploads", post(create_upload))
        .route("/uploads/{id}", put(append_chunk))
        .route("/qr", post(qr))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_key));

    let api = Router::new()
        .route("/health", get(health))
        .route("/session", post(create_session).delete(delete_session))
        .merge(gated);

    Router::new()
        .route("/", get(index))
        .route("/app.js", get(script))
        .route("/style.css", get(style))
        .route("/favicon.svg", get(favicon))
        .nest("/api", api)
        .with_state(state)
        .layer(DefaultBodyLimit::max(MAX_CHUNK + 64 * 1024))
        .layer(middleware::from_fn(csrf_guard))
        .layer(middleware::from_fn(security_headers))
}

async fn index() -> Response {
    asset(
        include_str!("../web/index.html"),
        "text/html; charset=utf-8",
    )
}

async fn script() -> Response {
    asset(
        include_str!("../web/app.js"),
        "text/javascript; charset=utf-8",
    )
}

async fn style() -> Response {
    asset(include_str!("../web/style.css"), "text/css; charset=utf-8")
}

async fn favicon() -> Response {
    asset(include_str!("../web/favicon.svg"), "image/svg+xml")
}

fn asset(body: &'static str, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(content_type),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    response
}

#[derive(Serialize)]
struct HealthResponse {
    ok: bool,
    version: &'static str,
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        ok: true,
        version: VERSION,
    })
}

#[derive(Serialize)]
struct InfoResponse {
    device_name: String,
    version: &'static str,
    started_at: u64,
    server_time: u64,
    max_chunk: usize,
    interfaces: Vec<Interface>,
}

async fn info(State(state): State<AppState>) -> Json<InfoResponse> {
    Json(InfoResponse {
        device_name: state.device_name.to_string(),
        version: VERSION,
        started_at: state.started_at,
        server_time: now_secs(),
        max_chunk: MAX_CHUNK,
        interfaces: state.interfaces.as_ref().clone(),
    })
}

#[derive(Serialize)]
struct Stats {
    count: usize,
    bytes: u64,
    uploading: usize,
}

#[derive(Serialize)]
struct FilesResponse {
    files: Vec<FileMeta>,
    stats: Stats,
    server_time: u64,
}

async fn list_files(State(state): State<AppState>) -> Result<Json<FilesResponse>, ApiError> {
    let files = state.store.list().await.map_err(ApiError::from)?;
    let stats = Stats {
        count: files
            .iter()
            .filter(|file| file.status == FileStatus::Complete)
            .count(),
        bytes: files
            .iter()
            .filter(|file| file.status == FileStatus::Complete)
            .map(|file| file.size)
            .sum(),
        uploading: files
            .iter()
            .filter(|file| file.status == FileStatus::Uploading)
            .count(),
    };
    Ok(Json(FilesResponse {
        files,
        stats,
        server_time: now_secs(),
    }))
}

async fn get_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<FileMeta>, ApiError> {
    Ok(Json(state.store.get(&id).await.map_err(ApiError::from)?))
}

async fn create_upload(
    State(state): State<AppState>,
    Json(request): Json<NewUpload>,
) -> Result<Json<FileMeta>, ApiError> {
    Ok(Json(
        state
            .store
            .create_or_resume(request)
            .await
            .map_err(ApiError::from)?,
    ))
}

#[derive(Deserialize)]
struct OffsetQuery {
    offset: u64,
}

async fn append_chunk(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<OffsetQuery>,
    body: Bytes,
) -> Result<Json<FileMeta>, ApiError> {
    let meta = state
        .store
        .append(&id, query.offset, &body)
        .await
        .map_err(ApiError::from)?;
    if meta.status == FileStatus::Complete {
        eprintln!("ferry: received {} ({} bytes)", meta.name, meta.size);
    }
    Ok(Json(meta))
}

async fn delete_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, ApiError> {
    state.store.delete(&id).await.map_err(ApiError::from)?;
    Ok(StatusCode::NO_CONTENT)
}

async fn download(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: axum::http::HeaderMap,
) -> Result<Response, ApiError> {
    let meta = state.store.get(&id).await.map_err(ApiError::from)?;
    if meta.status != FileStatus::Complete {
        return Err(ApiError::BadRequest(
            "file is still uploading".to_string(),
        ));
    }

    let requested = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(|value| parse_range(value, meta.size))
        .transpose()
        .map_err(|_| ApiError::Range { size: meta.size })?;

    let (status, start, end) = match requested {
        Some(range) => (StatusCode::PARTIAL_CONTENT, range.start, range.end),
        None if meta.size == 0 => (StatusCode::OK, 0, 0),
        None => (StatusCode::OK, 0, meta.size - 1),
    };
    let length = if meta.size == 0 { 0 } else { end - start + 1 };

    let mut file = state.store.read_blob(&id).await.map_err(ApiError::from)?;
    if start > 0 {
        file.seek(SeekFrom::Start(start))
            .await
            .map_err(ApiError::from)?;
    }
    let stream = ReaderStream::new(file.take(length));

    let mut builder = Response::builder()
        .status(status)
        // Always serve an opaque attachment. Never reflect a user-supplied
        // MIME type, so an uploaded HTML or SVG file cannot run on this origin.
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .header(header::CONTENT_LENGTH, length.to_string())
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_DISPOSITION, content_disposition(&meta.name))
        .header(
            HeaderName::from_static("content-security-policy"),
            "sandbox; default-src 'none'",
        )
        .header(
            header::ETAG,
            format!("\"{}-{}\"", meta.id, meta.size),
        );

    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", meta.size),
        );
    }

    builder
        .body(Body::from_stream(stream))
        .map_err(|error| ApiError::Internal(error.to_string()))
}

#[derive(Deserialize)]
struct QrRequest {
    text: String,
}

async fn qr(Json(query): Json<QrRequest>) -> Result<Response, ApiError> {
    if query.text.is_empty() || query.text.len() > 2048 {
        return Err(ApiError::BadRequest(
            "QR text must be between 1 and 2048 bytes".to_string(),
        ));
    }
    let code = QrCode::new(query.text.as_bytes())
        .map_err(|error| ApiError::BadRequest(format!("cannot build QR code: {error}")))?;
    let svg = code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(240, 240)
        .build();

    let mut response = svg.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline; filename=\"ferry-qr.svg\""),
    );
    headers.insert(
        HeaderName::from_static("content-security-policy"),
        HeaderValue::from_static("default-src 'none'; style-src 'none'"),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

async fn create_session(State(state): State<AppState>, request: Request) -> Response {
    let ip = client_ip(&request);
    if let Some(retry) = retry_after(&state, ip) {
        return too_many(retry);
    }

    let supplied = request
        .headers()
        .get("x-ferry-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");

    if !auth::constant_time_eq(supplied.as_bytes(), state.key.as_bytes()) {
        record_failure(&state, ip);
        return unauthorized();
    }

    clear_failures(&state, ip);
    let Some(token) = auth::issue_session(&state.key) else {
        return ApiError::Internal("could not sign a session".to_string()).into_response();
    };

    let secure = request
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(cookie) = HeaderValue::from_str(&session_cookie(&token, secure)) {
        headers.insert(header::SET_COOKIE, cookie);
    }
    response
}

async fn delete_session() -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::SET_COOKIE,
        HeaderValue::from_static(
            "ferry_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; \
             Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        ),
    );
    response
}

fn session_cookie(token: &str, secure: bool) -> String {
    let mut cookie = format!(
        "{}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}",
        auth::SESSION_COOKIE,
        auth::SESSION_TTL
    );
    if secure {
        cookie.push_str("; Secure");
    }
    cookie
}

async fn require_key(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let ip = client_ip(&request);
    if let Some(retry) = retry_after(&state, ip) {
        return too_many(retry);
    }

    let header_key = request
        .headers()
        .get("x-ferry-key")
        .and_then(|value| value.to_str().ok());
    let cookie_token = request
        .headers()
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| cookie_value(value, auth::SESSION_COOKIE));

    let authorized = header_key
        .map(|value| auth::constant_time_eq(value.as_bytes(), state.key.as_bytes()))
        .unwrap_or(false)
        || cookie_token
            .map(|value| auth::verify_session(&state.key, &value))
            .unwrap_or(false);

    if authorized {
        clear_failures(&state, ip);
        return next.run(request).await;
    }

    record_failure(&state, ip);
    unauthorized()
}

fn unauthorized() -> Response {
    let mut response = (
        StatusCode::UNAUTHORIZED,
        Json(json!({
            "error": "unauthorized",
            "message": "A valid share key is required."
        })),
    )
        .into_response();
    response.headers_mut().insert(
        header::WWW_AUTHENTICATE,
        HeaderValue::from_static("Ferry"),
    );
    response
}

fn too_many(retry: u64) -> Response {
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(json!({
            "error": "rate_limited",
            "message": "Too many failed attempts. Try again later."
        })),
    )
        .into_response();
    if let Ok(value) = HeaderValue::from_str(&retry.to_string()) {
        response.headers_mut().insert(header::RETRY_AFTER, value);
    }
    response
}

fn cookie_value(header: &str, name: &str) -> Option<String> {
    for part in header.split(';') {
        let Some((key, value)) = part.split_once('=') else {
            continue;
        };
        if key.trim() == name {
            return Some(value.trim().to_string());
        }
    }
    None
}

fn client_ip(request: &Request) -> Option<IpAddr> {
    request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
}

fn retry_after(state: &AppState, ip: Option<IpAddr>) -> Option<u64> {
    let ip = ip?;
    let mut tracked = state.auth_failures.lock().ok()?;
    let hits = tracked.get_mut(&ip)?;
    hits.retain(|time| time.elapsed() < FAILURE_WINDOW);
    if hits.is_empty() {
        tracked.remove(&ip);
        return None;
    }
    if hits.len() < MAX_FAILURES {
        return None;
    }
    Some(
        FAILURE_WINDOW
            .saturating_sub(hits[0].elapsed())
            .as_secs()
            .max(1),
    )
}

fn record_failure(state: &AppState, ip: Option<IpAddr>) {
    let Some(ip) = ip else {
        return;
    };
    let Ok(mut tracked) = state.auth_failures.lock() else {
        return;
    };
    if tracked.len() > MAX_TRACKED_CLIENTS {
        tracked.retain(|_, hits| {
            hits.retain(|time| time.elapsed() < FAILURE_WINDOW);
            !hits.is_empty()
        });
    }
    let hits = tracked.entry(ip).or_default();
    hits.retain(|time| time.elapsed() < FAILURE_WINDOW);
    hits.push(Instant::now());
    if hits.len() > MAX_FAILURES {
        hits.remove(0);
    }
}

fn clear_failures(state: &AppState, ip: Option<IpAddr>) {
    let Some(ip) = ip else {
        return;
    };
    if let Ok(mut tracked) = state.auth_failures.lock() {
        tracked.remove(&ip);
    }
}

async fn csrf_guard(request: Request, next: Next) -> Response {
    let unsafe_method = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );

    if unsafe_method {
        if request
            .headers()
            .get("sec-fetch-site")
            .and_then(|value| value.to_str().ok())
            == Some("cross-site")
        {
            return forbidden();
        }

        if let Some(origin) = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
        {
            let host = request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok());
            let origin_host = origin
                .strip_prefix("http://")
                .or_else(|| origin.strip_prefix("https://"))
                .map(|rest| rest.split('/').next().unwrap_or(rest));
            if origin == "null" || origin_host.is_none() || origin_host != host {
                return forbidden();
            }
        }
    }

    next.run(request).await
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(json!({
            "error": "cross_origin",
            "message": "Cross-origin state changes are not allowed."
        })),
    )
        .into_response()
}

async fn security_headers(request: Request, next: Next) -> Response {
    let secure_transport = request
        .headers()
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if !headers.contains_key(header::CONTENT_SECURITY_POLICY) {
        headers.insert(
            HeaderName::from_static("content-security-policy"),
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'none'; object-src 'none'; \
                 frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; \
                 manifest-src 'self'; img-src 'self' data:; media-src 'none'; \
                 style-src 'self'; script-src 'self'; connect-src 'self'; \
                 form-action 'self'; require-trusted-types-for 'script'",
            ),
        );
    }
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static(
            "geolocation=(), microphone=(), camera=(), usb=(), serial=(), payment=()",
        ),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("x-permitted-cross-domain-policies"),
        HeaderValue::from_static("none"),
    );
    headers.insert(
        HeaderName::from_static("x-robots-tag"),
        HeaderValue::from_static("noindex, nofollow, noarchive"),
    );
    if secure_transport {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000"),
        );
    }
    response
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

#[derive(Debug)]
struct RangeError;

fn parse_range(value: &str, size: u64) -> Result<ByteRange, RangeError> {
    if size == 0 {
        return Err(RangeError);
    }
    let value = value.trim();
    let rest = value.strip_prefix("bytes=").ok_or(RangeError)?;
    if rest.contains(',') {
        return Err(RangeError);
    }
    let (start_text, end_text) = rest.split_once('-').ok_or(RangeError)?;

    if start_text.is_empty() {
        let suffix: u64 = end_text.parse().map_err(|_| RangeError)?;
        if suffix == 0 {
            return Err(RangeError);
        }
        let start = size.saturating_sub(suffix);
        return Ok(ByteRange {
            start,
            end: size - 1,
        });
    }

    let start: u64 = start_text.parse().map_err(|_| RangeError)?;
    if start >= size {
        return Err(RangeError);
    }
    let end = if end_text.is_empty() {
        size - 1
    } else {
        end_text.parse::<u64>().map_err(|_| RangeError)?.min(size - 1)
    };
    if end < start {
        return Err(RangeError);
    }
    Ok(ByteRange { start, end })
}

fn content_disposition(name: &str) -> String {
    let fallback: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_graphic() && character != '"' && character != '\\' {
                character
            } else {
                '_'
            }
        })
        .collect();
    let fallback = if fallback.trim().is_empty() {
        "download".to_string()
    } else {
        fallback
    };
    let encoded = utf8_percent_encode(name, NON_ALPHANUMERIC).to_string();
    format!("attachment; filename=\"{fallback}\"; filename*=UTF-8''{encoded}")
}

#[derive(Debug)]
pub enum ApiError {
    NotFound,
    BadRequest(String),
    Conflict { offset: u64 },
    Range { size: u64 },
    Internal(String),
}

impl From<StoreError> for ApiError {
    fn from(value: StoreError) -> Self {
        match value {
            StoreError::NotFound => Self::NotFound,
            StoreError::Conflict { offset } => Self::Conflict { offset },
            StoreError::Invalid(message) => Self::BadRequest(message),
            StoreError::Io(error) => {
                eprintln!("ferry: storage error: {error}");
                Self::Internal("storage error".to_string())
            }
        }
    }
}

impl From<io::Error> for ApiError {
    fn from(value: io::Error) -> Self {
        eprintln!("ferry: I/O error: {value}");
        Self::Internal("storage error".to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                Json(json!({
                    "error": "not_found",
                    "message": "File not found."
                })),
            )
                .into_response(),
            Self::BadRequest(message) => (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "bad_request",
                    "message": message
                })),
            )
                .into_response(),
            Self::Conflict { offset } => (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "offset_mismatch",
                    "offset": offset,
                    "message": "The upload offset has changed. Resume from the returned offset."
                })),
            )
                .into_response(),
            Self::Range { size } => {
                let mut response = (
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    Json(json!({
                        "error": "range_not_satisfiable",
                        "size": size,
                        "message": "The requested byte range is not available."
                    })),
                )
                    .into_response();
                response.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}"))
                        .unwrap_or_else(|_| HeaderValue::from_static("bytes */*")),
                );
                response
            }
            Self::Internal(message) => {
                eprintln!("ferry: internal error: {message}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({
                        "error": "internal_error",
                        "message": "Something went wrong on the server."
                    })),
                )
                    .into_response()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use tempfile::tempdir;
    use tower::ServiceExt;

    async fn app() -> (Router, tempfile::TempDir) {
        let directory = tempdir().unwrap();
        let store = Store::open(directory.path()).await.unwrap();
        let state = AppState {
            store: Arc::new(store),
            key: Arc::from("test-key"),
            device_name: Arc::from("Test Ferry"),
            interfaces: Arc::new(Vec::new()),
            started_at: now_secs(),
            auth_failures: Arc::new(Mutex::new(HashMap::new())),
        };
        (router(state), directory)
    }

    fn request(method: Method, uri: &str, body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method(method)
            .uri(uri)
            .header("x-ferry-key", "test-key")
            .header("content-type", "application/json")
            .body(body.into())
            .unwrap()
    }

    async fn body_json<T: serde::de::DeserializeOwned>(response: Response) -> T {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(
            parse_range("bytes=0-4", 10).unwrap(),
            ByteRange { start: 0, end: 4 }
        );
        assert_eq!(
            parse_range("bytes=5-", 10).unwrap(),
            ByteRange { start: 5, end: 9 }
        );
        assert_eq!(
            parse_range("bytes=-3", 10).unwrap(),
            ByteRange { start: 7, end: 9 }
        );
        assert!(parse_range("bytes=10-", 10).is_err());
        assert!(parse_range("bytes=3-1", 10).is_err());
        assert!(parse_range("items=0-1", 10).is_err());
        assert!(parse_range("bytes=0-1,4-5", 10).is_err());
    }

    #[test]
    fn builds_safe_content_dispositions() {
        let header = content_disposition("résumé \"final\".pdf");
        assert!(header.starts_with("attachment; filename=\""));
        assert!(header.contains("filename*=UTF-8''"));
        assert!(!header.contains('\r'));
        assert!(!header.contains('\n'));
    }

    #[tokio::test]
    async fn rejects_requests_without_the_share_key() {
        let (app, _directory) = app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn uploads_lists_ranges_and_deletes_a_file() {
        let (app, _directory) = app().await;

        let create = request(
            Method::POST,
            "/api/uploads",
            Body::from(
                json!({
                    "name": "hello.txt",
                    "size": 10,
                    "mime": "text/plain",
                    "modified_at": 42,
                    "fingerprint": "hello:10:42"
                })
                .to_string(),
            ),
        );
        let response = app.clone().oneshot(create).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let meta: FileMeta = body_json(response).await;
        assert_eq!(meta.offset, 0);

        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=0", meta.id),
                Body::from("hello"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=5", meta.id),
                Body::from("world"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let meta: FileMeta = body_json(response).await;
        assert_eq!(meta.status, FileStatus::Complete);

        let response = app
            .clone()
            .oneshot(request(Method::GET, "/api/files", Body::empty()))
            .await
            .unwrap();
        let listing: serde_json::Value = body_json(response).await;
        assert_eq!(listing["stats"]["count"], 1);
        assert_eq!(listing["stats"]["bytes"], 10);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/{}/download", meta.id))
                    .header("x-ferry-key", "test-key")
                    .header("range", "bytes=1-3")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            response.headers().get(header::CONTENT_RANGE).unwrap(),
            "bytes 1-3/10"
        );
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(&bytes[..], b"ell");

        let response = app
            .clone()
            .oneshot(request(
                Method::DELETE,
                &format!("/api/files/{}", meta.id),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);

        let response = app
            .oneshot(request(
                Method::GET,
                &format!("/api/files/{}", meta.id),
                Body::empty(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn reports_the_server_offset_on_conflict() {
        let (app, _directory) = app().await;
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/uploads",
                Body::from(
                    json!({
                        "name": "big.bin",
                        "size": 8,
                        "fingerprint": "big:8:1"
                    })
                    .to_string(),
                ),
            ))
            .await
            .unwrap();
        let meta: FileMeta = body_json(response).await;

        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=0", meta.id),
                Body::from("1234"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=0", meta.id),
                Body::from("1234"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body: serde_json::Value = body_json(response).await;
        assert_eq!(body["offset"], 4);
    }

    #[tokio::test]
    async fn resumes_by_fingerprint() {
        let (app, _directory) = app().await;
        let payload = json!({
            "name": "same.bin",
            "size": 4,
            "fingerprint": "same:4:7"
        })
        .to_string();

        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/uploads",
                Body::from(payload.clone()),
            ))
            .await
            .unwrap();
        let first: FileMeta = body_json(response).await;

        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=0", first.id),
                Body::from("ab"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(request(Method::POST, "/api/uploads", Body::from(payload)))
            .await
            .unwrap();
        let resumed: FileMeta = body_json(response).await;
        assert_eq!(resumed.id, first.id);
        assert_eq!(resumed.offset, 2);
    }

    #[tokio::test]
    async fn rejects_keys_in_the_query_string() {
        let (app, _directory) = app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/info?key=test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn exchanges_the_key_for_a_session_cookie() {
        let (app, _directory) = app().await;
        let response = app
            .clone()
            .oneshot(request(Method::POST, "/api/session", Body::empty()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_string();
        assert!(cookie.starts_with("ferry_session="));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/info")
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri("/api/session")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(
            response
                .headers()
                .get(header::SET_COOKIE)
                .unwrap()
                .to_str()
                .unwrap()
                .contains("Max-Age=0")
        );
    }

    #[tokio::test]
    async fn rejects_cross_origin_state_changes() {
        let (app, _directory) = app().await;
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/session")
                    .header("x-ferry-key", "test-key")
                    .header(header::ORIGIN, "https://evil.example")
                    .header(header::HOST, "127.0.0.1:8787")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn serves_downloads_as_attachments() {
        let (app, _directory) = app().await;
        let response = app
            .clone()
            .oneshot(request(
                Method::POST,
                "/api/uploads",
                Body::from(
                    json!({
                        "name": "page.html",
                        "size": 4,
                        "mime": "text/html"
                    })
                    .to_string(),
                ),
            ))
            .await
            .unwrap();
        let meta: FileMeta = body_json(response).await;
        let response = app
            .clone()
            .oneshot(request(
                Method::PUT,
                &format!("/api/uploads/{}?offset=0", meta.id),
                Body::from("<h1>"),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                Request::builder()
                    .uri(format!("/api/files/{}/download", meta.id))
                    .header("x-ferry-key", "test-key")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/octet-stream"
        );
        assert!(
            response
                .headers()
                .get(header::CONTENT_DISPOSITION)
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("attachment;")
        );
    }
}
