import type { AircraftLiveState, AlertRecord, TrackPointRecord } from './types';

export function buildAlertSectorsGeoJson(
  alerts: AlertRecord[],
  selectedAlertId?: string | null
): any;

export function buildTrackGeoJson(
  track: TrackPointRecord[],
  staleAfterSeconds?: number
): any;

export function buildAlertsGeoJson(
  alerts: AlertRecord[],
  selectedAlertId?: string | null
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
