# Ground System Optimization Audit

## Removed
- Dormant simulation/demo replay runtime code and the unused `src-tauri/src/simulator.rs` module
- Unused Tauri command wrappers for `stop_active_stream` and `rename_session`
- Unreferenced frontend components:
  - `src/components/AlertFeed.tsx`
  - `src/components/SessionPanel.tsx`
  - `src/components/StatusStrip.tsx`
  - `src/components/SystemStatusPanel.tsx`
  - `src/components/TelemetryPanel.tsx`
- Unused Rust dependency: `rand`

## Preserved
- Offline region packs in `%LOCALAPPDATA%\\com.kerbodyne.groundstation\\offline-maps`
- Saved sessions, alerts, and metadata in `%LOCALAPPDATA%\\com.kerbodyne.groundstation\\kerbodyne.db`
- Saved alert media in `%LOCALAPPDATA%\\com.kerbodyne.groundstation\\alerts`
- Current live-ingest, saved-flight review, replay slider, and offline map workflows

## Cleanup Commands
- `npm run clean:build`
  - Removes `dist`
  - Removes `src-tauri/target/debug`
- `npm run clean:cache`
  - Removes `%LOCALAPPDATA%\\com.kerbodyne.groundstation\\EBWebView`
- `npm run clean:all`
  - Runs both cleanup scripts

## Notes
- The largest savings come from deleting Rust debug artifacts, not from source-file deletion alone.
- `target/debug` is safe to remove because it will be regenerated on the next development build.
- The WebView cache is safe to remove; it does not contain saved flights or offline map packs.
