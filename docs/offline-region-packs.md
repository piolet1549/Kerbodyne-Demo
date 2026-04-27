# Offline Region Packs

Kerbodyne Ground Station supports offline basemaps through **region packs**. Multiple regions can be installed at once, enabled or disabled in `Settings`, and selected from the toolbar region selector to recenter the map.

Region packs are distributed **separately** from the main Windows installer.

## Default Windows Location

By default, copy region folders into:

```text
%LOCALAPPDATA%\com.kerbodyne.groundstation\offline-maps\
```

Each region lives in its own folder:

```text
offline-maps/
  burn-unit-alpha/
    manifest.json
    street.pmtiles
    satellite.pmtiles
    street.png
    satellite.png
```

Notes:

- `street.pmtiles` and `satellite.pmtiles` are required by the current runtime validation.
- `street.png` and `satellite.png` are supported by the current region format and are used by the current packaged regions.
- Additional optional files may be referenced from the manifest, such as a street style JSON.

## Manifest Schema

Each region folder must include `manifest.json`.

Required fields:

```json
{
  "id": "burn-unit-alpha",
  "name": "Burn Unit Alpha",
  "bounds": [-121.5242, 38.5564, -121.4868, 38.5851],
  "center": [-121.5054, 38.5707],
  "street_pmtiles": "street.pmtiles",
  "satellite_pmtiles": "satellite.pmtiles"
}
```

Supported optional fields:

```json
{
  "street_source_type": "image",
  "street_image": "street.png",
  "satellite_image": "satellite.png",
  "imagery_attribution": "Esri World Street Map (dark styled), USGS NAIP Plus",
  "imagery_capture_date": null,
  "street_style_path": "street-style.json"
}
```

Field notes:

- `bounds` are `[west, south, east, north]`
- `center` is `[lon, lat]`
- asset paths must be **relative to the region folder**
- the runtime rejects missing required assets and invalid path traversal

## Operator Workflow

1. Download or receive a region-pack archive.
2. Extract the region folder into:

```text
%LOCALAPPDATA%\com.kerbodyne.groundstation\offline-maps\
```

3. Launch the app.
4. Open `Settings`.
5. Find the region in the region list.
6. Enable it with the circular toggle.
7. Optionally rename it in the editable region-name field.
8. Use the toolbar region selector to center the map on any enabled region.
9. Use the `Street` / `Satellite` toggle to switch map modes.

Only enabled regions appear in the toolbar selector.

## Packaging Guidance

For GitHub distribution, keep region packs separate from the main installer:

- main installer: application only
- region pack downloads: one archive per operating area

This keeps the installer smaller and lets operators install only the mission areas they need.
