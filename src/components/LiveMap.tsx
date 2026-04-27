import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl, { type GeoJSONSource, type Map } from 'maplibre-gl';
import {
  buildAlertSectorsGeoJson,
  buildAircraftGeoJson,
  buildAlertsGeoJson,
  buildCoverageBoundsGeoJson,
  buildCoverageMaskGeoJson,
  buildTrackGeoJson
} from '../lib/geometry';
import { createMapStyle, ensurePmtilesProtocol } from '../lib/map-style';
import type {
  AircraftLiveState,
  AlertRecord,
  AppConfig,
  MapMode,
  OfflineRegionManifest
} from '../lib/types';

interface LiveMapProps {
  config: AppConfig;
  liveState?: AircraftLiveState | null;
  track: Array<[number, number]>;
  alerts: AlertRecord[];
  selectedAlertId?: string | null;
  enabledRegions: OfflineRegionManifest[];
  selectedRegion?: OfflineRegionManifest | null;
  assetOrigin?: string | null;
  mapMode: MapMode;
  activeFlight: boolean;
  reviewMode: boolean;
  measureToolbarHost?: HTMLElement | null;
  focusTarget?: [number, number] | null;
  focusKey?: string | null;
  onSelectAlert: (alertId: string) => void;
}

const SOURCE_AIRCRAFT = 'aircraft-source';
const SOURCE_TRACK = 'track-source';
const SOURCE_ALERTS = 'alerts-source';
const SOURCE_SECTOR = 'sector-source';
const SOURCE_COVERAGE_MASK = 'coverage-mask-source';
const SOURCE_COVERAGE_BOUNDS = 'coverage-bounds-source';
const SOURCE_MEASURE = 'measure-source';
const INTERACTIVE_LAYERS = ['alerts-layer', 'alerts-halo-layer', 'sector-mask', 'sector-fill'];
type MeasureUnit = 'nm' | 'mi' | 'm' | 'km';
const MEASURE_UNIT_LABELS: Record<MeasureUnit, string> = {
  nm: 'Nautical Miles',
  mi: 'Miles',
  m: 'Meters',
  km: 'Kilometers'
};

export function LiveMap({
  config,
  liveState,
  track,
  alerts,
  selectedAlertId,
  enabledRegions,
  selectedRegion,
  assetOrigin,
  mapMode,
  activeFlight,
  reviewMode,
  measureToolbarHost,
  focusTarget,
  focusKey,
  onSelectAlert
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const lastRightClickRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const didAutoFitTrack = useRef(false);
  const fittedRegionIdRef = useRef<string | null>(null);
  const onSelectAlertRef = useRef(onSelectAlert);
  const liveStateRef = useRef(liveState);
  const trackRef = useRef(track);
  const alertsRef = useRef(alerts);
  const selectedAlertIdRef = useRef(selectedAlertId);
  const mapModeRef = useRef(mapMode);
  const reviewModeRef = useRef(reviewMode);
  const measureEnabledRef = useRef(false);
  const measurePointsRef = useRef<Array<[number, number]>>([]);
  const measureUnitRef = useRef<MeasureUnit>('nm');
  const lastFocusKeyRef = useRef<string | null>(null);
  const lastSelectedRegionIdRef = useRef<string | null>(null);
  const measureShellRef = useRef<HTMLDivElement | null>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [mapLoadingLabel, setMapLoadingLabel] = useState<string | null>(null);
  const [measureOpen, setMeasureOpen] = useState(false);
  const [measureMenuOpen, setMeasureMenuOpen] = useState(false);
  const [measureUnit, setMeasureUnit] = useState<MeasureUnit>('nm');
  const [measurePoints, setMeasurePoints] = useState<Array<[number, number]>>([]);
  const [measureLabelScreen, setMeasureLabelScreen] = useState<{
    x: number;
    y: number;
    label: string;
  } | null>(null);
  const [scaleIndicator, setScaleIndicator] = useState<{ widthPx: number; label: string } | null>(
    null
  );
  const [centerCoordinates, setCenterCoordinates] = useState<[number, number]>(
    selectedRegion
      ? [selectedRegion.center[1], selectedRegion.center[0]]
      : enabledRegions[0]
        ? [enabledRegions[0].center[1], enabledRegions[0].center[0]]
        : [38.575, -121.493]
  );
  const filteredLiveState = useMemo(
    () => (isValidCoordinate(liveState?.lat, liveState?.lon) ? liveState ?? null : null),
    [liveState]
  );
  const filteredTrack = useMemo(() => track.filter(isValidTrackPoint), [track]);
  const filteredAlerts = useMemo(() => alerts.filter(isValidAlertRecord), [alerts]);
  const style = useMemo(
    () =>
      createMapStyle(config, {
        enabledRegions,
        assetOrigin,
        mapMode
      }),
    [
      enabledRegions,
      assetOrigin,
      config.default_map_mode,
      config.map_style_url,
      config.map_tile_template,
      mapMode
    ]
  );
  const coverageUnavailable = enabledRegions.length > 0
    ? !enabledRegions.some((region) =>
        coordinateWithinBounds(centerCoordinates[0], centerCoordinates[1], region.bounds)
      )
    : false;
  const measurementDistanceM = useMemo(() => {
    if (measurePoints.length < 2) {
      return null;
    }
    return distanceMetersForPath(measurePoints);
  }, [measurePoints]);
  const measurementLabel = useMemo(() => {
    if (measurementDistanceM == null) {
      return null;
    }
    return formatMeasurement(measurementDistanceM, measureUnit);
  }, [measurementDistanceM, measureUnit]);
  const measureControl = (
    <div ref={measureShellRef} className="measure-shell">
      <button
        className={`secondary-button measure-shell__toggle ${
          measureOpen ? 'secondary-button--active' : ''
        }`}
        onClick={() => setMeasureOpen((current) => !current)}
        aria-expanded={measureOpen}
      >
        Measure
      </button>
      {measureOpen ? (
        <div className="measure-panel">
          <div className="measure-panel__header">
            <div className="measure-panel__intro">
              <strong>Measure</strong>
              <div className="measure-panel__readout">
                {measurementLabel ??
                  (measurePoints.length === 1
                    ? 'Select next point'
                    : measurePoints.length > 1
                      ? 'Add another point or clear'
                      : 'Select first point')}
              </div>
            </div>
            <button
              className="secondary-button secondary-button--muted"
              onClick={() => {
                setMeasureOpen(false);
                setMeasureMenuOpen(false);
                setMeasurePoints([]);
              }}
            >
              Close
            </button>
          </div>
          <div className="measure-panel__row">
            <div className="measure-unit-picker">
              <button
                className={`secondary-button measure-unit-picker__button ${
                  measureMenuOpen ? 'secondary-button--active' : ''
                }`}
                onClick={() => setMeasureMenuOpen((current) => !current)}
              >
                <span>{MEASURE_UNIT_LABELS[measureUnit]}</span>
                <span className="measure-unit-picker__chevron" aria-hidden="true">
                  ▾
                </span>
              </button>
              {measureMenuOpen ? (
                <div className="measure-unit-picker__menu">
                  {(Object.keys(MEASURE_UNIT_LABELS) as MeasureUnit[]).map((unit) => (
                    <button
                      key={unit}
                      className={`measure-unit-picker__option ${
                        unit === measureUnit ? 'measure-unit-picker__option--active' : ''
                      }`}
                      onClick={() => {
                        setMeasureUnit(unit);
                        setMeasureMenuOpen(false);
                      }}
                    >
                      {MEASURE_UNIT_LABELS[unit]}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              className="secondary-button secondary-button--muted"
              onClick={() => setMeasurePoints([])}
            >
              Clear
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );

  useEffect(() => {
    onSelectAlertRef.current = onSelectAlert;
  }, [onSelectAlert]);

  useEffect(() => {
    liveStateRef.current = filteredLiveState;
    trackRef.current = filteredTrack;
    alertsRef.current = filteredAlerts;
    selectedAlertIdRef.current = selectedAlertId;
    mapModeRef.current = mapMode;
    reviewModeRef.current = reviewMode;
    measureEnabledRef.current = measureOpen;
    measurePointsRef.current = measurePoints;
    measureUnitRef.current = measureUnit;
  }, [activeFlight, filteredAlerts, filteredLiveState, filteredTrack, mapMode, measureOpen, measurePoints, measureUnit, reviewMode, selectedAlertId]);

  useEffect(() => {
    ensurePmtilesProtocol();
  }, []);

  useEffect(() => {
    if (!measureMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!measureShellRef.current?.contains(event.target as Node)) {
        setMeasureMenuOpen(false);
      }
    }

    window.addEventListener('mousedown', handlePointerDown);
    return () => window.removeEventListener('mousedown', handlePointerDown);
  }, [measureMenuOpen]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    setMapError(null);
    didAutoFitTrack.current = false;
    fittedRegionIdRef.current = null;
    lastFocusKeyRef.current = null;
    lastSelectedRegionIdRef.current = null;

    const initialView = computeInitialView(selectedRegion, enabledRegions, containerRef.current);

    try {
      setMapLoadingLabel(buildMapLoadingLabel(mapMode));
      const map = new maplibregl.Map({
        container: containerRef.current,
        style,
        center: initialView.center,
        zoom: initialView.zoom,
        pitch: 0,
        pitchWithRotate: false,
        attributionControl: false,
        renderWorldCopies: false
      });

      map.dragRotate.enable();
      map.touchZoomRotate.disableRotation();

      map.on('error', (event) => {
        const message =
          event.error instanceof Error ? event.error.message : 'Map rendering failed';
        console.error('Kerbodyne map error:', event.error ?? event);
        setMapError(message);
      });

      map.on('style.load', () => {
        ensureSources(map);
        applyOverlayAppearance(map, mapModeRef.current);
        syncMapData(
          map,
          liveStateRef.current,
          trackRef.current,
          alertsRef.current,
          selectedAlertIdRef.current,
          enabledRegions
        );
        syncMeasureData(map, measurePointsRef.current);
        syncMeasureOverlay(map, measurePointsRef.current, measureUnitRef.current, setMeasureLabelScreen);
        const currentCenter = map.getCenter();
        setCenterCoordinates([currentCenter.lat, currentCenter.lng]);
        syncScaleIndicator(map, setScaleIndicator);
      });

      map.on('idle', () => {
        setMapLoadingLabel(null);
      });

      map.on('click', (event) => {
        if (measureEnabledRef.current) {
          setMeasurePoints((current) => {
            const nextPoint: [number, number] = [event.lngLat.lat, event.lngLat.lng];
            return [...current, nextPoint];
          });
          return;
        }
        const interactiveLayers = getInteractiveLayers(map);
        if (interactiveLayers.length === 0) {
          return;
        }
        const feature = map
          .queryRenderedFeatures(event.point, {
            layers: interactiveLayers
          })
          .find((entry) => typeof entry.properties?.id === 'string');
        const alertId = feature?.properties?.id;
        if (typeof alertId === 'string') {
          onSelectAlertRef.current(alertId);
        }
      });

      map.on('mousemove', (event) => {
        if (measureEnabledRef.current) {
          map.getCanvas().style.cursor = 'crosshair';
          return;
        }
        const interactiveLayers = getInteractiveLayers(map);
        if (interactiveLayers.length === 0) {
          map.getCanvas().style.cursor = '';
          return;
        }
        const interactive = map.queryRenderedFeatures(event.point, {
          layers: interactiveLayers
        });
        map.getCanvas().style.cursor = interactive.length > 0 ? 'pointer' : '';
      });

      map.on('mouseout', () => {
        map.getCanvas().style.cursor = '';
      });

      map.on('move', () => {
        const currentCenter = map.getCenter();
        setCenterCoordinates([currentCenter.lat, currentCenter.lng]);
        syncMeasureOverlay(map, measurePointsRef.current, measureUnitRef.current, setMeasureLabelScreen);
        syncScaleIndicator(map, setScaleIndicator);
      });

      const canvas = map.getCanvas();
      const handleContextMenu = (event: MouseEvent) => {
        event.preventDefault();
      };
      const handleMouseUp = (event: MouseEvent) => {
        if (event.button !== 2) {
          return;
        }
        const now = Date.now();
        const current = { at: now, x: event.clientX, y: event.clientY };
        const previous = lastRightClickRef.current;
        if (
          previous &&
          now - previous.at <= 320 &&
          Math.hypot(current.x - previous.x, current.y - previous.y) <= 10
        ) {
          map.easeTo({
            bearing: 0,
            pitch: 0,
            duration: 350
          });
          lastRightClickRef.current = null;
          return;
        }
        lastRightClickRef.current = current;
      };
      canvas.addEventListener('contextmenu', handleContextMenu);
      canvas.addEventListener('mouseup', handleMouseUp);

      mapRef.current = map;
      return () => {
        canvas.removeEventListener('contextmenu', handleContextMenu);
        canvas.removeEventListener('mouseup', handleMouseUp);
        map.remove();
        mapRef.current = null;
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Map initialization failed';
      console.error('Kerbodyne map initialization failed:', error);
      setMapError(message);
      return undefined;
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    setMapError(null);
    try {
      setMapLoadingLabel(buildMapLoadingLabel(mapMode));
      map.setStyle(style);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to switch map style';
      console.error('Kerbodyne map style update failed:', error);
      setMapError(message);
      setMapLoadingLabel(null);
    }
  }, [style]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    ensureSources(map);
    applyOverlayAppearance(map, mapMode);
    syncMapData(map, filteredLiveState, filteredTrack, filteredAlerts, selectedAlertId, enabledRegions);
    syncMeasureData(map, measurePoints);
    syncMeasureOverlay(map, measurePoints, measureUnit, setMeasureLabelScreen);
  }, [enabledRegions, filteredAlerts, filteredLiveState, filteredTrack, mapMode, measurePoints, measureUnit, selectedAlertId]);

  useEffect(() => {
    if (filteredTrack.length === 0) {
      didAutoFitTrack.current = false;
    }
  }, [filteredTrack.length]);

  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      ((!activeFlight && enabledRegions.length > 0) || filteredTrack.length === 0 || didAutoFitTrack.current)
    ) {
      return;
    }

    const last = filteredTrack[filteredTrack.length - 1];
    if (!last) {
      return;
    }

    map.easeTo({
      center: [last[1], last[0]],
      zoom: 14.3,
      duration: 900
    });
    didAutoFitTrack.current = true;
  }, [activeFlight, filteredTrack]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || enabledRegions.length === 0 || (activeFlight && filteredTrack.length > 0)) {
      return;
    }

    const regionKey =
      selectedRegion?.id ?? enabledRegions.map((region) => region.id).join('|');
    if (fittedRegionIdRef.current === regionKey) {
      return;
    }

    const bounds = selectedRegion
      ? selectedRegion.bounds
      : mergeRegionBounds(enabledRegions);
    const [west, south, east, north] = bounds;
    map.fitBounds([[west, south], [east, north]], {
      padding: 72,
      duration: 900,
      maxZoom: 15.1
    });
    fittedRegionIdRef.current = regionKey;
  }, [activeFlight, enabledRegions, filteredTrack.length, selectedRegion]);

  useEffect(() => {
    const map = mapRef.current;
    const selectedRegionId = selectedRegion?.id ?? null;
    if (!map) {
      return;
    }
    if (!selectedRegion) {
      lastSelectedRegionIdRef.current = null;
      return;
    }
    if (lastSelectedRegionIdRef.current === selectedRegionId) {
      return;
    }

    const [west, south, east, north] = selectedRegion.bounds;
    map.fitBounds([[west, south], [east, north]], {
      padding: 72,
      duration: 700,
      maxZoom: 15.1
    });
    lastSelectedRegionIdRef.current = selectedRegionId;
  }, [selectedRegion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    if (!focusKey || !focusTarget) {
      if (!focusKey) {
        lastFocusKeyRef.current = null;
      }
      return;
    }

    if (lastFocusKeyRef.current === focusKey || !isValidCoordinate(focusTarget[0], focusTarget[1])) {
      return;
    }

    map.easeTo({
      center: [focusTarget[1], focusTarget[0]],
      zoom: Math.max(map.getZoom(), 14.3),
      duration: 700
    });
    lastFocusKeyRef.current = focusKey;
  }, [focusKey, focusTarget]);

  return (
    <div className="map-stage">
      <div ref={containerRef} className="map-canvas" />
      {mapError ? (
        <div className="map-fallback">
          <span className="section-title">Map unavailable</span>
          <strong>{mapError}</strong>
        </div>
      ) : null}
      {mapLoadingLabel ? <div className="map-loading-indicator">{mapLoadingLabel}</div> : null}
      {coverageUnavailable ? (
        <div className="map-coverage-indicator">Outside imported map coverage</div>
      ) : null}
      {measureToolbarHost && measureControl ? createPortal(measureControl, measureToolbarHost) : measureControl}
      {measureLabelScreen ? (
        <div
          className="measure-map-label"
          style={{
            left: `${measureLabelScreen.x}px`,
            top: `${measureLabelScreen.y}px`
          }}
        >
          {measureLabelScreen.label}
        </div>
      ) : null}
      {scaleIndicator ? (
        <div className="map-scale-indicator">
          <span className="map-scale-indicator__label">Scale: {scaleIndicator.label}</span>
          <div className="map-scale-indicator__bar-shell">
            <div
              className="map-scale-indicator__bar"
              style={{ width: `${Math.max(scaleIndicator.widthPx, 24)}px` }}
            />
          </div>
        </div>
      ) : null}
      <div className="map-center-tracker">
        {centerCoordinates[0].toFixed(5)}, {centerCoordinates[1].toFixed(5)}
      </div>
    </div>
  );
}

function getInteractiveLayers(map: Map) {
  return INTERACTIVE_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId)));
}

function buildMapLoadingLabel(mapMode: MapMode) {
  return `Loading ${mapMode === 'satellite' ? 'satellite' : 'street'} map`;
}

function isValidCoordinate(
  lat: number | null | undefined,
  lon: number | null | undefined
) {
  if (typeof lat !== 'number' || typeof lon !== 'number') {
    return false;
  }

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return false;
  }

  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return false;
  }

  return !(Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001);
}

function isValidTrackPoint(point: [number, number]) {
  return isValidCoordinate(point[0], point[1]);
}

function isValidAlertRecord(alert: AlertRecord) {
  return isValidCoordinate(alert.sector.center_lat, alert.sector.center_lon);
}

function ensureSources(map: Map) {
  if (!map.getSource(SOURCE_SECTOR)) {
    map.addSource(SOURCE_SECTOR, {
      type: 'geojson',
      data: buildAlertSectorsGeoJson([], null)
    });
    map.addLayer({
      id: 'sector-mask',
      type: 'fill',
      source: SOURCE_SECTOR,
      paint: {
        'fill-color': '#020202',
        'fill-opacity': ['coalesce', ['get', 'mask_opacity_street'], 0.06]
      }
    });
    map.addLayer({
      id: 'sector-fill',
      type: 'fill',
      source: SOURCE_SECTOR,
      paint: {
        'fill-color': ['coalesce', ['get', 'fill_color'], '#d5d5d5'],
        'fill-opacity': ['coalesce', ['get', 'tint_opacity'], 0.08]
      }
    });
  }

  if (!map.getSource(SOURCE_COVERAGE_MASK)) {
    map.addSource(SOURCE_COVERAGE_MASK, {
      type: 'geojson',
      data: buildCoverageMaskGeoJson(null)
    });
    map.addLayer({
      id: 'coverage-mask-layer',
      type: 'fill',
      source: SOURCE_COVERAGE_MASK,
      paint: {
        'fill-color': '#040404',
        'fill-opacity': 0.58
      }
    });
  }

  if (!map.getSource(SOURCE_COVERAGE_BOUNDS)) {
    map.addSource(SOURCE_COVERAGE_BOUNDS, {
      type: 'geojson',
      data: buildCoverageBoundsGeoJson(null)
    });
    map.addLayer({
      id: 'coverage-bounds-layer',
      type: 'line',
      source: SOURCE_COVERAGE_BOUNDS,
      paint: {
        'line-color': '#c9d0d8',
        'line-width': 1.15,
        'line-opacity': 0.52,
        'line-dasharray': [2, 2]
      }
    });
  }

  if (!map.getSource(SOURCE_MEASURE)) {
    map.addSource(SOURCE_MEASURE, {
      type: 'geojson',
      data: buildMeasureGeoJson([])
    });
    map.addLayer({
      id: 'measure-line',
      type: 'line',
      source: SOURCE_MEASURE,
      filter: ['==', ['get', 'kind'], 'line'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 2.6,
        'line-dasharray': [2, 1.4]
      }
    });
    map.addLayer({
      id: 'measure-points',
      type: 'circle',
      source: SOURCE_MEASURE,
      filter: ['==', ['get', 'kind'], 'point'],
      paint: {
        'circle-radius': 5.2,
        'circle-color': '#f5f5f5',
        'circle-stroke-color': '#050505',
        'circle-stroke-width': 1.6
      }
    });
  }

  if (!map.getSource(SOURCE_TRACK)) {
    map.addSource(SOURCE_TRACK, {
      type: 'geojson',
      data: buildTrackGeoJson([])
    });
    map.addLayer({
      id: 'track-casing',
      type: 'line',
      source: SOURCE_TRACK,
      paint: {
        'line-width': 5.4,
        'line-color': '#050505',
        'line-opacity': 0.48
      }
    });
    map.addLayer({
      id: 'track-layer',
      type: 'line',
      source: SOURCE_TRACK,
      paint: {
        'line-width': 2.8,
        'line-color': '#f0f0f0',
        'line-opacity': 0.94
      }
    });
  }

  if (!map.getSource(SOURCE_ALERTS)) {
    map.addSource(SOURCE_ALERTS, {
      type: 'geojson',
      data: buildAlertsGeoJson([])
    });
    map.addLayer({
      id: 'alerts-halo-layer',
      type: 'circle',
      source: SOURCE_ALERTS,
      paint: {
        'circle-radius': ['coalesce', ['get', 'halo_radius'], 8],
        'circle-color': '#030303',
        'circle-opacity': ['coalesce', ['get', 'halo_opacity'], 0.24]
      }
    });
    map.addLayer({
      id: 'alerts-layer',
      type: 'circle',
      source: SOURCE_ALERTS,
      paint: {
        'circle-radius': ['coalesce', ['get', 'radius'], 5.25],
        'circle-color': ['coalesce', ['get', 'fill_color'], '#d8d8d8'],
        'circle-stroke-color': ['coalesce', ['get', 'stroke_color'], '#111111'],
        'circle-stroke-width': ['coalesce', ['get', 'stroke_width'], 1.5],
        'circle-opacity': ['coalesce', ['get', 'opacity'], 0.58]
      }
    });
  }

  if (!map.getSource(SOURCE_AIRCRAFT)) {
    map.addSource(SOURCE_AIRCRAFT, {
      type: 'geojson',
      data: buildAircraftGeoJson(null)
    });
    map.addLayer({
      id: 'aircraft-layer',
      type: 'fill',
      source: SOURCE_AIRCRAFT,
      paint: {
        'fill-color': '#f7f7f7',
        'fill-opacity': 0.98
      }
    });
    map.addLayer({
      id: 'aircraft-outline',
      type: 'line',
      source: SOURCE_AIRCRAFT,
      paint: {
        'line-color': '#020202',
        'line-width': 1.8
      }
    });
  }
}

function applyOverlayAppearance(map: Map, mapMode: MapMode) {
  const satellite = mapMode === 'satellite';
  map.setPaintProperty(
    'sector-mask',
    'fill-opacity',
    ['coalesce', ['get', satellite ? 'mask_opacity_satellite' : 'mask_opacity_street'], 0.08]
  );
  map.setPaintProperty('track-casing', 'line-width', satellite ? 6.2 : 5.2);
  map.setPaintProperty('track-casing', 'line-opacity', satellite ? 0.62 : 0.42);
  map.setPaintProperty('track-layer', 'line-width', satellite ? 3.6 : 2.8);
  map.setPaintProperty('track-layer', 'line-color', satellite ? '#ffffff' : '#ededed');
  map.setPaintProperty('alerts-halo-layer', 'circle-opacity', satellite ? 0.34 : 0.22);
  map.setPaintProperty('aircraft-outline', 'line-width', satellite ? 2.2 : 1.8);
  map.setPaintProperty('coverage-mask-layer', 'fill-opacity', satellite ? 0.64 : 0.56);
  map.setPaintProperty('coverage-bounds-layer', 'line-opacity', satellite ? 0.6 : 0.5);
}

function syncMapData(
  map: Map,
  liveState: AircraftLiveState | null | undefined,
  track: Array<[number, number]>,
  alerts: AlertRecord[],
  selectedAlertId?: string | null,
  enabledRegions: OfflineRegionManifest[] = []
) {
  (map.getSource(SOURCE_AIRCRAFT) as GeoJSONSource).setData(buildAircraftGeoJson(liveState));
  (map.getSource(SOURCE_TRACK) as GeoJSONSource).setData(buildTrackGeoJson(track));
  (map.getSource(SOURCE_ALERTS) as GeoJSONSource).setData(
    buildAlertsGeoJson(alerts, selectedAlertId)
  );
  (map.getSource(SOURCE_SECTOR) as GeoJSONSource).setData(
    buildAlertSectorsGeoJson(alerts, selectedAlertId)
  );
  (map.getSource(SOURCE_COVERAGE_MASK) as GeoJSONSource).setData(
    buildCoverageMaskGeoJson(enabledRegions)
  );
  (map.getSource(SOURCE_COVERAGE_BOUNDS) as GeoJSONSource).setData(
    buildCoverageBoundsGeoJson(enabledRegions)
  );
}

function syncMeasureData(map: Map, points: Array<[number, number]>) {
  (map.getSource(SOURCE_MEASURE) as GeoJSONSource).setData(buildMeasureGeoJson(points));
}

function coordinateWithinBounds(
  lat: number,
  lon: number,
  bounds: [number, number, number, number]
) {
  const [west, south, east, north] = bounds;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

function computeInitialView(
  selectedRegion: OfflineRegionManifest | null | undefined,
  enabledRegions: OfflineRegionManifest[],
  container: HTMLDivElement
) {
  const targetRegion = selectedRegion ?? enabledRegions[0] ?? null;
  if (!targetRegion) {
    return {
      center: [-121.493, 38.575] as [number, number],
      zoom: 12.8
    };
  }

  const [west, south, east, north] = selectedRegion
    ? selectedRegion.bounds
    : mergeRegionBounds(enabledRegions);
  const width = Math.max(container.clientWidth, 320);
  const height = Math.max(container.clientHeight, 320);
  const padding = 72;
  const usableWidth = Math.max(width - padding * 2, 1);
  const usableHeight = Math.max(height - padding * 2, 1);
  const lngDiff = Math.max(Math.abs(east - west), 0.0001);
  const latFraction = Math.max(
    Math.abs(mercatorY(north) - mercatorY(south)),
    0.000001
  );
  const lngFraction = lngDiff / 360;
  const zoomLng = Math.log2(usableWidth / 512 / lngFraction);
  const zoomLat = Math.log2(usableHeight / 512 / latFraction);
  return {
    center: (selectedRegion ?? targetRegion).center as [number, number],
    zoom: Math.max(9.8, Math.min(15.1, Math.min(zoomLng, zoomLat) - 0.2))
  };
}

function mergeRegionBounds(regions: OfflineRegionManifest[]) {
  return regions.reduce<[number, number, number, number]>(
    (combined, region) => [
      Math.min(combined[0], region.bounds[0]),
      Math.min(combined[1], region.bounds[1]),
      Math.max(combined[2], region.bounds[2]),
      Math.max(combined[3], region.bounds[3])
    ],
    [regions[0].bounds[0], regions[0].bounds[1], regions[0].bounds[2], regions[0].bounds[3]]
  );
}

function mercatorY(lat: number) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
}

function buildMeasureGeoJson(points: Array<[number, number]>) {
  const features: any[] = points.map((point, index) => ({
    type: 'Feature',
    properties: { id: `point-${index}`, kind: 'point' },
    geometry: {
      type: 'Point',
      coordinates: [point[1], point[0]]
    }
  }));

  if (points.length >= 2) {
    features.push({
      type: 'Feature',
      properties: { id: 'line-0', kind: 'line' },
      geometry: {
        type: 'LineString',
        coordinates: points.map((point) => [point[1], point[0]])
      }
    });
  }

  return {
    type: 'FeatureCollection' as const,
    features
  };
}

function distanceMeters(first: [number, number], second: [number, number]) {
  const earthRadiusM = 6_371_000;
  const lat1 = (first[0] * Math.PI) / 180;
  const lat2 = (second[0] * Math.PI) / 180;
  const deltaLat = ((second[0] - first[0]) * Math.PI) / 180;
  const deltaLon = ((second[1] - first[1]) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadiusM * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
}

function distanceMetersForPath(points: Array<[number, number]>) {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distanceMeters(points[index - 1], points[index]);
  }
  return total;
}

function interpolatePathMidpoint(points: Array<[number, number]>): [number, number] {
  if (points.length === 0) {
    return [0, 0];
  }
  if (points.length === 1) {
    return points[0];
  }

  const targetDistance = distanceMetersForPath(points) / 2;
  let traversed = 0;

  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segmentDistance = distanceMeters(start, end);
    if (traversed + segmentDistance >= targetDistance) {
      const ratio = segmentDistance === 0 ? 0 : (targetDistance - traversed) / segmentDistance;
      return [
        start[0] + (end[0] - start[0]) * ratio,
        start[1] + (end[1] - start[1]) * ratio
      ];
    }
    traversed += segmentDistance;
  }

  return points[points.length - 1];
}

function syncMeasureOverlay(
  map: Map,
  points: Array<[number, number]>,
  unit: MeasureUnit,
  setMeasureLabelScreen: (value: { x: number; y: number; label: string } | null) => void
) {
  if (points.length < 2) {
    setMeasureLabelScreen(null);
    return;
  }

  const midpoint = interpolatePathMidpoint(points);
  const projected = map.project([midpoint[1], midpoint[0]]);
  setMeasureLabelScreen({
    x: projected.x,
    y: projected.y - 18,
    label: formatMeasurement(distanceMetersForPath(points), unit)
  });
}

function syncScaleIndicator(
  map: Map,
  setScaleIndicator: (value: { widthPx: number; label: string } | null) => void
) {
  const center = map.getCenter();
  const metersPerPixel = metersPerPixelAtLatitude(center.lat, map.getZoom());
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    setScaleIndicator(null);
    return;
  }

  const targetWidthPx = 112;
  const distanceM = chooseNiceScaleDistance(metersPerPixel * targetWidthPx);
  setScaleIndicator({
    widthPx: distanceM / metersPerPixel,
    label: formatScaleDistance(distanceM)
  });
}

function metersPerPixelAtLatitude(lat: number, zoom: number) {
  const earthCircumferenceM = 40_075_016.686;
  return (earthCircumferenceM * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** zoom);
}

function chooseNiceScaleDistance(distanceM: number) {
  if (distanceM <= 0) {
    return 0;
  }

  const magnitude = 10 ** Math.floor(Math.log10(distanceM));
  const normalized = distanceM / magnitude;
  if (normalized >= 5) {
    return 5 * magnitude;
  }
  if (normalized >= 2) {
    return 2 * magnitude;
  }
  return magnitude;
}

function formatScaleDistance(distanceM: number) {
  if (distanceM >= 1000) {
    const kilometers = distanceM / 1000;
    return Number.isInteger(kilometers) ? `${kilometers} km` : `${kilometers.toFixed(1)} km`;
  }
  return `${Math.round(distanceM)} m`;
}

function formatMeasurement(distanceM: number, unit: MeasureUnit) {
  switch (unit) {
    case 'nm':
      return `${(distanceM / 1852).toFixed(2)} NM`;
    case 'mi':
      return `${(distanceM / 1609.344).toFixed(2)} mi`;
    case 'km':
      return `${(distanceM / 1000).toFixed(2)} km`;
    case 'm':
    default:
      return `${distanceM.toFixed(distanceM >= 100 ? 0 : 1)} m`;
  }
}
