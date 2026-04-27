# Kerbodyne Ground Station

Kerbodyne Ground Station is a Windows desktop application for monitoring a single autonomous UAV during wildfire detection missions. It is a receive-only beta ground station focused on live telemetry, alert review, saved-flight replay, and offline basemap support.

Operators should install the packaged Windows app from **GitHub Releases**. Building from source is only required for contributors.

## Install on Windows

1. Open the repository's **Releases** page on GitHub.
2. Download the latest Windows installer asset (`.exe`).
3. Run the installer.
4. Because this beta is currently **unsigned**, Windows SmartScreen may warn before launch. If you trust the source, use `More info` -> `Run anyway`.
5. Finish installation and launch **Kerbodyne Ground Station** from the Start menu or desktop shortcut.

Notes:

- The installer is built with Tauri's Windows NSIS target.
- The app is Windows-first in this beta.
- Operators do **not** need Node.js, Rust, Cargo, or a source checkout to use the installer build.

## First Launch

On first launch, the app creates its local data directory at:

```text
%LOCALAPPDATA%\com.kerbodyne.groundstation\
```

Important subfolders:

- `offline-maps\` for downloaded region packs
- `alerts\` for saved detection images
- `kerbodyne.db` for sessions, saved flights, and app settings

## Add Offline Map Regions

Offline map regions are distributed **separately** from the main installer.

1. Download a region-pack archive from the release assets or another provided source.
2. Extract the region folder into:

```text
%LOCALAPPDATA%\com.kerbodyne.groundstation\offline-maps\
```

3. Open `Settings`.
4. Enable the regions you want available in the app.
5. Use the toolbar region selector to center the map on any enabled region.
6. Use the `Street` / `Satellite` toggle to switch basemaps.

Detailed pack format documentation is in [docs/offline-region-packs.md](docs/offline-region-packs.md).

## Basic Operator Workflow

1. Open the app and confirm the correct map region is enabled.
2. Press `Start flight` to begin live ingest.
3. Monitor telemetry in the HUD and use `View raw data` if you need the live packet stream.
4. Review detections as they appear on the map.
5. Press `End flight` to save or discard the mission.
6. Open `Saved Flights` to review prior missions, replay telemetry, and inspect detections.

## Current Beta Scope

- One aircraft in the operator interface
- Receive-only monitoring
- Offline-capable street and satellite basemaps
- Detection image review and saved-flight replay
- Live ingest compatibility with the current Raspberry Pi airside downlink

The detection cone is intentionally approximate and should be treated as an operator aid rather than precise target geolocation.

## Contributor Setup

Contributor notes are in [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Install Node.js `20+`.
2. Install Rust stable.
3. Install the Windows Tauri prerequisites:
   - Microsoft C++ Build Tools with `Desktop development with C++`
   - WebView2 runtime if it is not already present
4. Run:

```bash
npm install
npm run tauri:dev
```

Useful validation commands:

```bash
npm run build
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri:build
```

## Repository Layout

- `src/` React + TypeScript frontend
- `src-tauri/` Tauri 2 Rust runtime and packaging config
- `docs/` operator and release documentation
- `scripts/` local maintenance and region-pack tooling

## Releases

- Windows installers are published through **GitHub Releases**
- Region packs should be published as **separate downloadable assets**
- The release process is documented in [docs/release-checklist.md](docs/release-checklist.md)

## License

This repository does not currently grant an open-source license. See [LICENSE](LICENSE).
