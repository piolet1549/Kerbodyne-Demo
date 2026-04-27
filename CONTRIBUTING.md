# Contributing

Kerbodyne Ground Station is currently a **Windows-first Tauri desktop app**. Operator installs should use GitHub Releases; this guide is only for contributors working from source.

## Prerequisites

Install the following on Windows:

1. Node.js `20+`
2. Rust stable
3. Microsoft C++ Build Tools with `Desktop development with C++`
4. WebView2 runtime if it is not already installed

The official Tauri prerequisite guide is the reference for the Windows toolchain:

- [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)

## Local Development

Install dependencies:

```bash
npm install
```

Run the desktop app in development mode:

```bash
npm run tauri:dev
```

## Validation Commands

Frontend production build:

```bash
npm run build
```

Rust compile check:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

Full Windows installer build:

```bash
npm run tauri:build
```

Optional cleanup commands:

```bash
npm run clean:build
npm run clean:cache
npm run clean:all
```

## Project Notes

- The operator product is centered on live flight monitoring and saved-flight review.
- Offline map regions are stored outside the repo in the app-local data directory.
- Region packs are documented in [docs/offline-region-packs.md](docs/offline-region-packs.md).
- Release steps are documented in [docs/release-checklist.md](docs/release-checklist.md).
