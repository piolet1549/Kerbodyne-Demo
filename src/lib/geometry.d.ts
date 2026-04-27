import type { AircraftLiveState, AlertRecord } from './types';

export function buildAlertSectorsGeoJson(
  alerts: AlertRecord[],
  selectedAlertId?: string | null
): any;

export function buildTrackGeoJson(
  track: Array<[number, number]>
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
