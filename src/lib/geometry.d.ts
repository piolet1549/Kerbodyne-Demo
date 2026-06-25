import type { AircraftLiveState, AlertRecord, DetectionConvergence, TrackPointRecord } from './types';

export function buildAlertSectorsGeoJson(
  alerts: AlertRecord[],
  selectedAlertId?: string | null,
  highlightedAlertIds?: string[] | Set<string> | null
): any;

export function buildTrackGeoJson(
  track: TrackPointRecord[],
  staleAfterSeconds?: number
): any;

export function buildAlertsGeoJson(
  alerts: AlertRecord[],
  selectedAlertId?: string | null,
  highlightedAlertIds?: string[] | Set<string> | null
): any;

export function buildConvergencesGeoJson(
  convergences: DetectionConvergence[],
  selectedConvergenceId?: string | null
): any;

export function buildConvergenceLinesGeoJson(
  convergence: DetectionConvergence | null,
  alerts: AlertRecord[]
): any;

export function buildCoverageMaskGeoJson(enabledRegions?: Array<{
  bounds: [number, number, number, number];
}> | null): any;

export function buildCoverageBoundsGeoJson(enabledRegions?: Array<{
  bounds: [number, number, number, number];
}> | null): any;

export function buildAircraftGeoJson(
  liveState?: AircraftLiveState | null
): any;
