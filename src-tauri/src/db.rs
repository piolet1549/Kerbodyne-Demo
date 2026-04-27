use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, Error as SqlError, OptionalExtension};
use crate::models::{
    AlertRecord, AppConfig, MapAlertSector, MissionSession, ReplayFrame, SystemStatusRecord,
};

pub struct Database {
    connection: Mutex<Connection>,
}

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|error| error.to_string())?;
        let database = Self {
            connection: Mutex::new(connection),
        };
        database.initialize()?;
        Ok(database)
    }

    fn initialize(&self) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;

        connection
            .execute_batch(
                r#"
                PRAGMA journal_mode = WAL;
                CREATE TABLE IF NOT EXISTS app_meta (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sessions (
                    id TEXT PRIMARY KEY,
                    name TEXT,
                    description TEXT,
                    aircraft_id TEXT NOT NULL,
                    source TEXT NOT NULL,
                    started_at TEXT NOT NULL,
                    ended_at TEXT,
                    event_count INTEGER NOT NULL DEFAULT 0,
                    alert_count INTEGER NOT NULL DEFAULT 0
                );

                CREATE TABLE IF NOT EXISTS alerts (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    aircraft_id TEXT NOT NULL,
                    class_label TEXT NOT NULL,
                    confidence REAL NOT NULL,
                    detected_at TEXT NOT NULL,
                    alt_msl_m REAL,
                    image_path TEXT,
                    image_format TEXT,
                    center_lat REAL NOT NULL,
                    center_lon REAL NOT NULL,
                    bearing_deg REAL NOT NULL,
                    fov_deg REAL NOT NULL,
                    range_m REAL NOT NULL,
                    model_name TEXT,
                    extras_json TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS track_points (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    recorded_at TEXT NOT NULL,
                    lat REAL NOT NULL,
                    lon REAL NOT NULL,
                    alt_msl_m REAL NOT NULL,
                    heading_deg REAL,
                    groundspeed_mps REAL
                );

                CREATE TABLE IF NOT EXISTS replay_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    sent_at TEXT NOT NULL,
                    envelope_json TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS system_status_events (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    aircraft_id TEXT NOT NULL,
                    status TEXT NOT NULL,
                    message TEXT NOT NULL,
                    reported_at TEXT NOT NULL,
                    lat REAL,
                    lon REAL,
                    alt_msl_m REAL,
                    heading_deg REAL,
                    extras_json TEXT NOT NULL,
                    raw_json TEXT NOT NULL
                );
                "#,
            )
            .map_err(|error| error.to_string())?;

        ignore_duplicate_column(
            connection.execute("ALTER TABLE sessions ADD COLUMN name TEXT", []),
        )?;
        ignore_duplicate_column(
            connection.execute("ALTER TABLE sessions ADD COLUMN description TEXT", []),
        )?;

        Ok(())
    }

    pub fn load_config(&self) -> Result<Option<AppConfig>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let raw: Option<String> = connection
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'config'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;

        raw.map(|value| serde_json::from_str::<AppConfig>(&value).map_err(|error| error.to_string()))
            .transpose()
    }

    pub fn save_config(&self, config: &AppConfig) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let raw = serde_json::to_string(config).map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO app_meta (key, value) VALUES ('config', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![raw],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn load_sessions(&self, limit: usize) -> Result<Vec<MissionSession>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, name, description, aircraft_id, source, started_at, ended_at, event_count, alert_count
                 FROM sessions
                 ORDER BY started_at DESC
                 LIMIT ?1",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([limit as i64], |row| {
                let id: String = row.get(0)?;
                let started_at: String = row.get(5)?;
                let ended_at: Option<String> = row.get(6)?;
                Ok(MissionSession {
                    id: id.clone(),
                    name: session_display_name(row.get::<_, Option<String>>(1)?, &started_at),
                    description: row.get(2)?,
                    aircraft_id: row.get(3)?,
                    source: row.get(4)?,
                    started_at,
                    ended_at: ended_at.clone(),
                    is_active: ended_at.is_none(),
                    event_count: row.get::<_, i64>(7)? as u32,
                    alert_count: row.get::<_, i64>(8)? as u32,
                    storage_bytes: session_storage_bytes(&connection, &id)?,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn close_active_sessions(&self, ended_at: &str) -> Result<usize, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "UPDATE sessions SET ended_at = ?1 WHERE ended_at IS NULL",
                params![ended_at],
            )
            .map_err(|error| error.to_string())
    }

    pub fn load_alerts_for_session(&self, session_id: &str) -> Result<Vec<AlertRecord>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, aircraft_id, class_label, confidence, detected_at, alt_msl_m,
                        image_path, image_format, center_lat, center_lon, bearing_deg, fov_deg, range_m,
                        model_name, extras_json
                 FROM alerts
                 WHERE session_id = ?1
                 ORDER BY detected_at DESC",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([session_id], |row| {
                let extras_json: String = row.get(15)?;
                let extras = serde_json::from_str(&extras_json).unwrap_or_default();
                Ok(AlertRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    aircraft_id: row.get(2)?,
                    class_label: row.get(3)?,
                    confidence: row.get(4)?,
                    detected_at: row.get(5)?,
                    alt_msl_m: row.get(6)?,
                    image_path: row.get(7)?,
                    image_format: row.get(8)?,
                    sector: MapAlertSector {
                        center_lat: row.get(9)?,
                        center_lon: row.get(10)?,
                        bearing_deg: row.get(11)?,
                        fov_deg: row.get(12)?,
                        range_m: row.get(13)?,
                    },
                    model_name: row.get(14)?,
                    extras,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn load_system_statuses_for_session(
        &self,
        session_id: &str,
    ) -> Result<Vec<SystemStatusRecord>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT id, session_id, aircraft_id, status, message, reported_at, lat, lon, alt_msl_m,
                        heading_deg, extras_json
                 FROM system_status_events
                 WHERE session_id = ?1
                 ORDER BY reported_at DESC",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([session_id], |row| {
                let extras_json: String = row.get(10)?;
                let extras = serde_json::from_str(&extras_json).unwrap_or_default();
                Ok(SystemStatusRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    aircraft_id: row.get(2)?,
                    status: row.get(3)?,
                    message: row.get(4)?,
                    reported_at: row.get(5)?,
                    lat: row.get(6)?,
                    lon: row.get(7)?,
                    alt_msl_m: row.get(8)?,
                    heading_deg: row.get(9)?,
                    extras,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn upsert_session(&self, session: &MissionSession) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO sessions (id, name, description, aircraft_id, source, started_at, ended_at, event_count, alert_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    description = excluded.description,
                    aircraft_id = excluded.aircraft_id,
                    source = excluded.source,
                    started_at = excluded.started_at,
                    ended_at = excluded.ended_at,
                    event_count = excluded.event_count,
                    alert_count = excluded.alert_count",
                params![
                    &session.id,
                    &session.name,
                    &session.description,
                    &session.aircraft_id,
                    &session.source,
                    &session.started_at,
                    &session.ended_at,
                    session.event_count as i64,
                    session.alert_count as i64
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_session_counts(
        &self,
        session_id: &str,
        event_count: u32,
        alert_count: u32,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "UPDATE sessions SET event_count = ?2, alert_count = ?3 WHERE id = ?1",
                params![session_id, event_count as i64, alert_count as i64],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn end_session(&self, session_id: &str, ended_at: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "UPDATE sessions SET ended_at = ?2 WHERE id = ?1",
                params![session_id, ended_at],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn update_session_details(
        &self,
        session_id: &str,
        name: &str,
        description: Option<&str>,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "UPDATE sessions SET name = ?2, description = ?3 WHERE id = ?1",
                params![session_id, name, description],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn insert_alert(&self, alert: &AlertRecord, raw_json: &str) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let extras_json = serde_json::to_string(&alert.extras).map_err(|error| error.to_string())?;

        connection
            .execute(
                "INSERT INTO alerts (
                    id, session_id, aircraft_id, class_label, confidence, detected_at, alt_msl_m, image_path,
                    image_format, center_lat, center_lon, bearing_deg, fov_deg, range_m, model_name, extras_json, raw_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
                params![
                    &alert.id,
                    &alert.session_id,
                    &alert.aircraft_id,
                    &alert.class_label,
                    alert.confidence,
                    &alert.detected_at,
                    alert.alt_msl_m,
                    &alert.image_path,
                    &alert.image_format,
                    alert.sector.center_lat,
                    alert.sector.center_lon,
                    alert.sector.bearing_deg,
                    alert.sector.fov_deg,
                    alert.sector.range_m,
                    &alert.model_name,
                    extras_json,
                    raw_json
                ],
            )
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    pub fn insert_system_status(
        &self,
        status: &SystemStatusRecord,
        raw_json: &str,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let extras_json =
            serde_json::to_string(&status.extras).map_err(|error| error.to_string())?;

        connection
            .execute(
                "INSERT INTO system_status_events (
                    id, session_id, aircraft_id, status, message, reported_at, lat, lon, alt_msl_m,
                    heading_deg, extras_json, raw_json
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    &status.id,
                    &status.session_id,
                    &status.aircraft_id,
                    &status.status,
                    &status.message,
                    &status.reported_at,
                    status.lat,
                    status.lon,
                    status.alt_msl_m,
                    status.heading_deg,
                    extras_json,
                    raw_json
                ],
            )
            .map_err(|error| error.to_string())?;

        Ok(())
    }

    pub fn insert_track_point(
        &self,
        session_id: &str,
        recorded_at: &str,
        lat: f64,
        lon: f64,
        alt_msl_m: f64,
        heading_deg: Option<f64>,
        groundspeed_mps: Option<f64>,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO track_points (
                    session_id, recorded_at, lat, lon, alt_msl_m, heading_deg, groundspeed_mps
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    session_id,
                    recorded_at,
                    lat,
                    lon,
                    alt_msl_m,
                    heading_deg,
                    groundspeed_mps
                ],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn load_track(&self, session_id: &str) -> Result<Vec<(f64, f64)>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT lat, lon
                 FROM track_points
                 WHERE session_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([session_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn insert_replay_event(
        &self,
        session_id: &str,
        sent_at: &str,
        envelope_json: &str,
    ) -> Result<(), String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        connection
            .execute(
                "INSERT INTO replay_events (session_id, sent_at, envelope_json) VALUES (?1, ?2, ?3)",
                params![session_id, sent_at, envelope_json],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    pub fn load_replay_events(&self, session_id: &str) -> Result<Vec<ReplayFrame>, String> {
        let connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let mut statement = connection
            .prepare(
                "SELECT envelope_json
                 FROM replay_events
                 WHERE session_id = ?1
                 ORDER BY id ASC",
            )
            .map_err(|error| error.to_string())?;

        let rows = statement
            .query_map([session_id], |row| {
                Ok(ReplayFrame {
                    envelope_json: row.get(0)?,
                })
            })
            .map_err(|error| error.to_string())?;

        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())
    }

    pub fn delete_session(&self, session_id: &str) -> Result<Vec<String>, String> {
        let mut connection = self.connection.lock().map_err(|_| "database mutex poisoned".to_string())?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;

        let mut statement = transaction
            .prepare("SELECT image_path FROM alerts WHERE session_id = ?1 AND image_path IS NOT NULL")
            .map_err(|error| error.to_string())?;
        let image_paths = statement
            .query_map([session_id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        drop(statement);

        transaction
            .execute("DELETE FROM alerts WHERE session_id = ?1", params![session_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM system_status_events WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM track_points WHERE session_id = ?1", params![session_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM replay_events WHERE session_id = ?1", params![session_id])
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM sessions WHERE id = ?1", params![session_id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;

        Ok(image_paths)
    }

}

fn session_storage_bytes(connection: &Connection, session_id: &str) -> Result<u64, SqlError> {
    let replay_bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(LENGTH(envelope_json)), 0) FROM replay_events WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let alert_json_bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(LENGTH(raw_json) + LENGTH(COALESCE(extras_json, ''))), 0) FROM alerts WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let status_bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(LENGTH(raw_json) + LENGTH(COALESCE(extras_json, ''))), 0) FROM system_status_events WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;
    let track_bytes: i64 = connection.query_row(
        "SELECT COALESCE(SUM(LENGTH(recorded_at)), 0) + COUNT(*) * 48 FROM track_points WHERE session_id = ?1",
        params![session_id],
        |row| row.get(0),
    )?;

    let mut image_bytes = 0u64;
    let mut statement = connection.prepare(
        "SELECT image_path FROM alerts WHERE session_id = ?1 AND image_path IS NOT NULL",
    )?;
    let image_paths = statement.query_map([session_id], |row| row.get::<_, String>(0))?;
    for image_path in image_paths {
        let path = image_path?;
        if let Ok(metadata) = std::fs::metadata(&path) {
            image_bytes = image_bytes.saturating_add(metadata.len());
        }
    }

    let db_bytes = replay_bytes
        .saturating_add(alert_json_bytes)
        .saturating_add(status_bytes)
        .saturating_add(track_bytes);

    Ok((db_bytes.max(0) as u64).saturating_add(image_bytes))
}

fn ignore_duplicate_column(result: Result<usize, SqlError>) -> Result<(), String> {
    match result {
        Ok(_) => Ok(()),
        Err(SqlError::SqliteFailure(_, Some(message)))
            if message.contains("duplicate column name") =>
        {
            Ok(())
        }
        Err(error) => Err(error.to_string()),
    }
}

fn session_display_name(stored_name: Option<String>, started_at: &str) -> String {
    stored_name.unwrap_or_else(|| format!("Flight {}", started_at))
}
