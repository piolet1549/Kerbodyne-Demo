use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use crate::models::{AppConfig, MapMode, OfflineRegionManifest};

pub fn default_offline_maps_root(data_dir: &Path) -> PathBuf {
    data_dir.join("offline-maps")
}

pub fn normalize_config(config: &mut AppConfig, data_dir: &Path) -> Result<(), String> {
    if config
        .offline_maps_root
        .as_deref()
        .map(str::trim)
        .is_none_or(str::is_empty)
    {
        config.offline_maps_root = Some(
            default_offline_maps_root(data_dir)
                .to_string_lossy()
                .to_string(),
        );
    }

    if config
        .selected_region_id
        .as_deref()
        .is_some_and(|value| value.trim().is_empty())
    {
        config.selected_region_id = None;
    }

    config.enabled_region_ids = config
        .enabled_region_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .fold(Vec::<String>::new(), |mut unique, value| {
            if !unique.iter().any(|existing| existing == value) {
                unique.push(value.to_string());
            }
            unique
        });

    config.region_name_overrides = config
        .region_name_overrides
        .iter()
        .filter_map(|(region_id, display_name)| {
            let region_id = region_id.trim();
            let display_name = display_name.trim();
            if region_id.is_empty() || display_name.is_empty() {
                None
            } else {
                Some((region_id.to_string(), display_name.to_string()))
            }
        })
        .collect();

    if let Some(selected_region_id) = config.selected_region_id.clone() {
        if config.enabled_region_ids.is_empty() {
            config.enabled_region_ids.push(selected_region_id);
        } else if !config
            .enabled_region_ids
            .iter()
            .any(|region_id| region_id == &selected_region_id)
        {
            config.selected_region_id = config.enabled_region_ids.first().cloned();
        }
    }

    if config.enabled_region_ids.is_empty() {
        config.selected_region_id = None;
    } else if config.selected_region_id.is_none() {
        config.selected_region_id = config.enabled_region_ids.first().cloned();
    }

    if matches!(config.default_map_mode, MapMode::Unknown) {
        config.default_map_mode = MapMode::StreetDark;
    }

    let root = offline_maps_root(config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn offline_maps_root(config: &AppConfig) -> Result<PathBuf, String> {
    let raw = config
        .offline_maps_root
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Offline maps root is not configured.".to_string())?;
    Ok(PathBuf::from(raw))
}

pub fn list_regions(config: &AppConfig) -> Result<Vec<OfflineRegionManifest>, String> {
    let root = offline_maps_root(config)?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;

    let mut manifests = Vec::new();
    let entries = fs::read_dir(&root).map_err(|error| error.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let manifest_path = path.join("manifest.json");
        if !manifest_path.is_file() {
            continue;
        }

        let folder_name = entry.file_name().to_string_lossy().to_string();
        if let Ok(manifest) = read_manifest_from_path(&path, &folder_name) {
            manifests.push(manifest);
        }
    }

    manifests.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(manifests)
}

pub fn load_region(config: &AppConfig, region_id: &str) -> Result<OfflineRegionManifest, String> {
    let region_dir = region_directory(config, region_id)?;
    read_manifest_from_path(&region_dir, region_id)
}

pub fn resolve_asset_path(config: &AppConfig, request_path: &str) -> Result<Option<PathBuf>, String> {
    let segments = request_path
        .trim_start_matches('/')
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>();

    if segments.len() < 3 || segments[0] != "regions" {
        return Ok(None);
    }

    let region_id = segments[1];
    let region_dir = region_directory(config, region_id)?;
    let relative_path = join_safe_relative_segments(&segments[2..])?;
    let asset_path = region_dir.join(relative_path);

    if !asset_path.is_file() {
        return Ok(None);
    }

    Ok(Some(asset_path))
}

fn read_manifest_from_path(
    region_dir: &Path,
    fallback_id: &str,
) -> Result<OfflineRegionManifest, String> {
    let manifest_path = region_dir.join("manifest.json");
    let raw = fs::read_to_string(&manifest_path).map_err(|error| error.to_string())?;
    let manifest: OfflineRegionManifest =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    validate_manifest(region_dir, manifest, fallback_id)
}

fn validate_manifest(
    region_dir: &Path,
    mut manifest: OfflineRegionManifest,
    fallback_id: &str,
) -> Result<OfflineRegionManifest, String> {
    if manifest.id.trim().is_empty() {
        manifest.id = fallback_id.to_string();
    }

    if manifest.name.trim().is_empty() {
        manifest.name = fallback_id.to_string();
    }

    if manifest.bounds[0] >= manifest.bounds[2] || manifest.bounds[1] >= manifest.bounds[3] {
        return Err(format!(
            "Offline region '{}' has invalid bounds in manifest.json",
            manifest.id
        ));
    }

    validate_relative_asset(region_dir, &manifest.street_pmtiles, "street_pmtiles")?;
    validate_relative_asset(
        region_dir,
        &manifest.satellite_pmtiles,
        "satellite_pmtiles",
    )?;

    if let Some(style_path) = manifest.street_style_path.as_deref() {
        validate_relative_asset(region_dir, style_path, "street_style_path")?;
    }

    Ok(manifest)
}

fn validate_relative_asset(region_dir: &Path, relative_path: &str, field_name: &str) -> Result<(), String> {
    let safe_relative = safe_relative_path(relative_path)?;
    let full_path = region_dir.join(safe_relative);
    if !full_path.is_file() {
        return Err(format!(
            "Offline region asset '{}' is missing: {}",
            field_name,
            full_path.display()
        ));
    }

    Ok(())
}

fn region_directory(config: &AppConfig, region_id: &str) -> Result<PathBuf, String> {
    if !is_safe_segment(region_id) {
        return Err(format!("Invalid offline region id '{region_id}'."));
    }

    let root = offline_maps_root(config)?;
    let directory = root.join(region_id);
    if !directory.is_dir() {
        return Err(format!(
            "Offline region '{}' was not found in {}",
            region_id,
            root.display()
        ));
    }

    Ok(directory)
}

fn join_safe_relative_segments(segments: &[&str]) -> Result<PathBuf, String> {
    let mut path = PathBuf::new();
    for segment in segments {
        if !is_safe_segment(segment) {
            return Err(format!("Invalid offline asset path segment '{}'.", segment));
        }
        path.push(segment);
    }
    Ok(path)
}

fn safe_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute() {
        return Err("Offline region assets must use relative paths.".into());
    }

    let mut safe = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_string_lossy();
                if !is_safe_segment(&value) {
                    return Err(format!("Invalid offline asset path '{}'.", relative_path));
                }
                safe.push(value.as_ref());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Invalid offline asset path '{}'.", relative_path));
            }
        }
    }

    if safe.as_os_str().is_empty() {
        return Err("Offline region asset path cannot be empty.".into());
    }

    Ok(safe)
}

fn is_safe_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(['\\', '/', ':'])
        && value != "."
        && value != ".."
}

#[cfg(test)]
mod tests {
    use std::{env, fs};

    use uuid::Uuid;

    use super::{load_region, resolve_asset_path};
    use crate::models::{AppConfig, MapMode};

    #[test]
    fn load_region_reads_valid_manifest() {
        let root = temp_root();
        let region_dir = root.join("test-region");
        fs::create_dir_all(&region_dir).unwrap();
        fs::write(region_dir.join("street.pmtiles"), b"street").unwrap();
        fs::write(region_dir.join("satellite.pmtiles"), b"satellite").unwrap();
        fs::write(
            region_dir.join("manifest.json"),
            r#"{
                "id": "test-region",
                "name": "Test Region",
                "bounds": [-121.5, 38.5, -121.4, 38.6],
                "center": [-121.45, 38.55],
                "street_pmtiles": "street.pmtiles",
                "satellite_pmtiles": "satellite.pmtiles"
            }"#,
        )
        .unwrap();

        let config = test_config(&root);
        let manifest = load_region(&config, "test-region").unwrap();
        assert_eq!(manifest.id, "test-region");
        assert_eq!(manifest.name, "Test Region");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_asset_path_rejects_traversal() {
        let root = temp_root();
        fs::create_dir_all(root.join("test-region")).unwrap();
        let config = test_config(&root);
        let result =
            resolve_asset_path(&config, "/regions/test-region/../../secret.txt").unwrap_err();
        assert!(result.contains("Invalid offline asset path segment"));

        let _ = fs::remove_dir_all(root);
    }

    fn test_config(root: &std::path::Path) -> AppConfig {
        AppConfig {
            listen_port: 8765,
            aircraft_label: "Kerbodyne".into(),
            map_style_url: None,
            map_tile_template: None,
            offline_maps_root: Some(root.to_string_lossy().to_string()),
            selected_region_id: None,
            enabled_region_ids: Vec::new(),
            region_name_overrides: Default::default(),
            default_map_mode: MapMode::StreetDark,
            default_fov_deg: 38.0,
            default_range_m: 250.0,
            stale_after_seconds: 10,
            class_display_names: Default::default(),
        }
    }

    fn temp_root() -> std::path::PathBuf {
        env::temp_dir().join(format!("kerbodyne-offline-map-test-{}", Uuid::new_v4()))
    }
}
