import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppConfig,
  AppSnapshot,
  OfflineRegionCatalog,
  OfflineRegionManifest,
  RuntimeEvent
} from './types';

export async function bootstrapApp(): Promise<AppSnapshot> {
  return invoke<AppSnapshot>('bootstrap_app');
}

export async function updateConfig(config: AppConfig): Promise<AppConfig> {
  return invoke<AppConfig>('update_config', { config });
}

export async function listOfflineRegions(): Promise<OfflineRegionCatalog> {
  return invoke<OfflineRegionCatalog>('list_offline_regions');
}

export async function selectOfflineRegion(
  regionId?: string | null
): Promise<AppConfig> {
  return invoke<AppConfig>('select_offline_region', { regionId: regionId ?? null });
}

export async function validateOfflineRegion(
  regionId: string
): Promise<OfflineRegionManifest> {
  return invoke<OfflineRegionManifest>('validate_offline_region', { regionId });
}

export async function startLiveIngest(): Promise<void> {
  return invoke('start_live_ingest');
}

export async function completeActiveStream(
  save: boolean,
  name?: string | null,
  description?: string | null
): Promise<void> {
  return invoke('complete_active_stream', { save, name, description });
}

export async function focusSession(sessionId: string): Promise<void> {
  return invoke('focus_session', { sessionId });
}

export async function clearFocusedSession(): Promise<void> {
  return invoke('clear_focused_session');
}

export async function updateSessionDetails(
  sessionId: string,
  name: string,
  description?: string | null
): Promise<void> {
  return invoke('update_session_details', { sessionId, name, description });
}

export async function deleteSession(sessionId: string): Promise<void> {
  return invoke('delete_session', { sessionId });
}

export async function listenToRuntimeEvents(
  handler: (event: RuntimeEvent) => void
): Promise<UnlistenFn> {
  return listen<RuntimeEvent>('kerbodyne://runtime', (event) => {
    handler(event.payload);
  });
}
