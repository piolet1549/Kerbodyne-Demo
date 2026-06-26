import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import maplibregl, { type GeoJSONSource, type LayerSpecification, type Map } from 'maplibre-gl';
import {
  buildAlertSectorsGeoJson,
  buildAlertsGeoJson,
  buildConvergenceLinesGeoJson,
  buildConvergencesGeoJson,
  buildCoverageBoundsGeoJson,
  buildCoverageMaskGeoJson,
  buildTrackGeoJson
} from '../lib/geometry';
import { createMapStyle, ensurePmtilesProtocol } from '../lib/map-style';
import type {
  AircraftLiveState,
  AlertRecord,
  AppConfig,
  DetectionConvergence,
  MapMode,
  OfflineRegionManifest,
  TrackPointRecord
} from '../lib/types';

interface LiveMapProps {
  config: AppConfig;
  liveState?: AircraftLiveState | null;
  track: TrackPointRecord[];
  alerts: AlertRecord[];
  selectedAlertId?: string | null;
  highlightedAlertIds?: string[];
  convergences?: DetectionConvergence[];
  selectedConvergenceId?: string | null;
  convergenceAlerts?: AlertRecord[];
  enabledRegions: OfflineRegionManifest[];
  selectedRegion?: OfflineRegionManifest | null;
  assetOrigin?: string | null;
  mapMode: MapMode;
  activeFlight: boolean;
  reviewMode: boolean;
  linkPulseActive: boolean;
  compactFlightView?: boolean;
  forceFollow?: boolean;
  preferredInitialView?: { center: [number, number]; zoom: number; bearing: number } | null;
  measureToolbarHost?: HTMLElement | null;
  focusTarget?: [number, number] | null;
  focusKey?: string | null;
  onViewStateChange?: (view: { center: [number, number]; zoom: number; bearing: number }) => void;
  onFollowModeChange?: (enabled: boolean) => void;
  onMeasureModeChange?: (enabled: boolean) => void;
  onSelectAlert: (alertId: string) => void;
  onSelectConvergence?: (convergenceId: string) => void;
}

const SOURCE_TRACK = 'track-source';
const SOURCE_ALERTS = 'alerts-source';
const SOURCE_SECTOR = 'sector-source';
const SOURCE_CONVERGENCES = 'convergences-source';
const SOURCE_CONVERGENCE_LINES = 'convergence-lines-source';
const SOURCE_COVERAGE_MASK = 'coverage-mask-source';
const SOURCE_COVERAGE_BOUNDS = 'coverage-bounds-source';
const SOURCE_MEASURE = 'measure-source';
const INTERACTIVE_LAYERS = [
  'convergence-hit-layer',
  'alerts-layer',
  'alerts-halo-layer',
  'sector-mask',
  'sector-fill',
  'sector-border'
];
type MeasureUnit = 'nm' | 'mi' | 'm' | 'km';
const MEASURE_UNIT_LABELS: Record<MeasureUnit, string> = {
  nm: 'Nautical Miles',
  mi: 'Miles',
  m: 'Meters',
  km: 'Kilometers'
};

/*
function RotateLeftIcon() {
  return (
    <span className="legacy-rotate-symbol legacy-rotate-symbol--left" aria-hidden="true">
      ↶
    </span>
  );
}

function RotateRightIcon() {
  return (
    <span className="legacy-rotate-symbol legacy-rotate-symbol--right" aria-hidden="true">
      ↷
    </span>
  );
}

*/
export function LiveMap({
  config,
  liveState,
  track,
  alerts,
  selectedAlertId,
  highlightedAlertIds = [],
  convergences = [],
  selectedConvergenceId = null,
  convergenceAlerts = [],
  enabledRegions,
  selectedRegion,
  assetOrigin,
  mapMode,
  activeFlight,
  reviewMode,
  linkPulseActive,
  compactFlightView = false,
  forceFollow = false,
  preferredInitialView,
  measureToolbarHost,
  focusTarget,
  focusKey,
  onViewStateChange,
  onFollowModeChange,
  onMeasureModeChange,
  onSelectAlert,
  onSelectConvergence
}: LiveMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const aircraftMarkerRef = useRef<maplibregl.Marker | null>(null);
  const aircraftMarkerGlyphRef = useRef<HTMLDivElement | null>(null);
  const appliedStyleKeyRef = useRef<string | null>(null);
  const lastRightClickRef = useRef<{ at: number; x: number; y: number } | null>(null);
  const fittedRegionIdRef = useRef<string | null>(null);
  const onSelectAlertRef = useRef(onSelectAlert);
  const onSelectConvergenceRef = useRef(onSelectConvergence);
  const liveStateRef = useRef(liveState);
  const trackRef = useRef(track);
  const alertsRef = useRef(alerts);
  const convergencesRef = useRef(convergences);
  const selectedConvergenceIdRef = useRef(selectedConvergenceId);
  const convergenceAlertsRef = useRef(convergenceAlerts);
  const selectedAlertIdRef = useRef(selectedAlertId);
  const highlightedAlertIdsRef = useRef(highlightedAlertIds);
  const mapModeRef = useRef(mapMode);
  const reviewModeRef = useRef(reviewMode);
  const configRef = useRef(config);
  const linkPulseActiveRef = useRef(linkPulseActive);
  const activeFlightRef = useRef(activeFlight);
  const enabledRegionsRef = useRef(enabledRegions);
  const selectedRegionRef = useRef(selectedRegion);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const onFollowModeChangeRef = useRef(onFollowModeChange);
  const onMeasureModeChangeRef = useRef(onMeasureModeChange);
  const previousFollowAvailabilityRef = useRef(false);
  const measureEnabledRef = useRef(false);
  const measurePointsRef = useRef<Array<[number, number]>>([]);
  const measureUnitRef = useRef<MeasureUnit>('nm');
  const lastFocusKeyRef = useRef<string | null>(null);
  const lastAlertFocusKeyRef = useRef<string | null>(null);
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
  const [mapOverlayRevision, setMapOverlayRevision] = useState(0);
  const [followEnabled, setFollowEnabled] = useState(true);
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
  const styleKey = useMemo(
    () =>
      JSON.stringify({
        mapMode,
        assetOrigin: assetOrigin ?? '',
        regions: enabledRegions.map((region) => ({
          id: region.id,
          street_pmtiles: region.street_pmtiles,
          street_source_type: region.street_source_type ?? '',
          street_image: region.street_image ?? '',
          satellite_pmtiles: region.satellite_pmtiles,
          satellite_image: region.satellite_image ?? ''
        }))
      }),
    [assetOrigin, enabledRegions, mapMode]
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
  const followAvailable = activeFlight && Boolean(filteredLiveState?.armed);
  const effectiveFollowEnabled = forceFollow || followEnabled;
  const svgMapOverlay = useMemo(() => {
    const map = mapRef.current;
    if (!map || mapError) {
      return null;
    }
    return buildSvgMapOverlay({
      map,
      track: filteredTrack,
      alerts: filteredAlerts,
      selectedAlertId,
      highlightedAlertIds,
      convergences,
      selectedConvergenceId,
      convergenceAlerts,
      trackDisplay: config.track_display,
      staleAfterSeconds: config.stale_after_seconds,
      mapMode,
      interactive: !measureOpen,
      onSelectAlert: (alertId) => onSelectAlertRef.current(alertId),
      onSelectConvergence: (convergenceId) => onSelectConvergenceRef.current?.(convergenceId)
    });
  }, [
    config.stale_after_seconds,
    config.track_display,
    convergenceAlerts,
    convergences,
    filteredAlerts,
    filteredTrack,
    highlightedAlertIds,
    mapError,
    mapMode,
    mapOverlayRevision,
    measureOpen,
    selectedAlertId,
    selectedConvergenceId
  ]);
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
    onSelectConvergenceRef.current = onSelectConvergence;
  }, [onSelectConvergence]);

  useEffect(() => {
    onMeasureModeChangeRef.current = onMeasureModeChange;
  }, [onMeasureModeChange]);

  useEffect(() => {
    onMeasureModeChangeRef.current?.(measureOpen);
  }, [measureOpen]);

  useEffect(() => {
    liveStateRef.current = filteredLiveState;
    trackRef.current = filteredTrack;
    alertsRef.current = filteredAlerts;
    convergencesRef.current = convergences;
    selectedConvergenceIdRef.current = selectedConvergenceId;
    convergenceAlertsRef.current = convergenceAlerts;
    selectedAlertIdRef.current = selectedAlertId;
    highlightedAlertIdsRef.current = highlightedAlertIds;
    mapModeRef.current = mapMode;
    reviewModeRef.current = reviewMode;
    configRef.current = config;
    linkPulseActiveRef.current = linkPulseActive;
    activeFlightRef.current = activeFlight;
    enabledRegionsRef.current = enabledRegions;
    selectedRegionRef.current = selectedRegion;
    onViewStateChangeRef.current = onViewStateChange;
    onFollowModeChangeRef.current = onFollowModeChange;
    onMeasureModeChangeRef.current = onMeasureModeChange;
    measureEnabledRef.current = measureOpen;
    measurePointsRef.current = measurePoints;
    measureUnitRef.current = measureUnit;
  }, [
    activeFlight,
    config,
    convergenceAlerts,
    convergences,
    enabledRegions,
    filteredAlerts,
    filteredLiveState,
    filteredTrack,
    linkPulseActive,
    mapMode,
    measureOpen,
    measurePoints,
    measureUnit,
    reviewMode,
    selectedAlertId,
    selectedConvergenceId,
    highlightedAlertIds,
    selectedRegion,
    onViewStateChange,
    onFollowModeChange,
    onMeasureModeChange
  ]);

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
    if (!compactFlightView) {
      return;
    }
    setMeasureOpen(false);
    setMeasureMenuOpen(false);
  }, [compactFlightView]);

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    setMapError(null);
    fittedRegionIdRef.current = null;
    lastFocusKeyRef.current = null;
    lastSelectedRegionIdRef.current = null;

    const initialView = preferredInitialView ?? computeInitialView(selectedRegion, enabledRegions, containerRef.current);

      try {
        setMapLoadingLabel(buildMapLoadingLabel(mapMode));
        const map = new maplibregl.Map({
          container: containerRef.current,
          style,
          center: initialView.center,
          zoom: initialView.zoom,
          bearing: initialView.bearing,
          pitch: 0,
          pitchWithRotate: false,
          attributionControl: false,
          renderWorldCopies: false
        });

        map.dragRotate.enable();
        map.touchZoomRotate.disableRotation();
        map.doubleClickZoom.disable();

        const aircraftMarkerElement = document.createElement('div');
        aircraftMarkerElement.className = 'aircraft-marker';
        const aircraftMarkerPulse = document.createElement('div');
        aircraftMarkerPulse.className = 'aircraft-marker__pulse';
        const aircraftMarkerGlyph = document.createElement('div');
        aircraftMarkerGlyph.className = 'aircraft-marker__glyph';
        aircraftMarkerElement.appendChild(aircraftMarkerPulse);
        aircraftMarkerElement.appendChild(aircraftMarkerGlyph);
        const aircraftMarker = new maplibregl.Marker({
          element: aircraftMarkerElement,
          anchor: 'center',
          rotationAlignment: 'map'
        })
          .setLngLat([0, 0])
          .addTo(map);
        aircraftMarkerRef.current = aircraftMarker;
        aircraftMarkerGlyphRef.current = aircraftMarkerGlyph;
        appliedStyleKeyRef.current = styleKey;
        syncAircraftMarker(
          aircraftMarker,
          aircraftMarkerGlyph,
          liveStateRef.current,
          configRef.current,
          activeFlightRef.current,
          linkPulseActiveRef.current
        );
        let disposed = false;
        const syncCurrentMapOverlays = () => {
          if (disposed || !map.isStyleLoaded()) {
            return false;
          }
          try {
            ensureSources(map);
            applyOverlayAppearance(map, mapModeRef.current, configRef.current.track_display);
            syncMapData(
              map,
              trackRef.current,
              alertsRef.current,
              selectedAlertIdRef.current,
              highlightedAlertIdsRef.current,
              convergencesRef.current,
              selectedConvergenceIdRef.current,
              convergenceAlertsRef.current,
              enabledRegionsRef.current,
              configRef.current.stale_after_seconds
            );
            syncAircraftMarker(
              aircraftMarkerRef.current,
              aircraftMarkerGlyphRef.current,
              liveStateRef.current,
              configRef.current,
              activeFlightRef.current,
              linkPulseActiveRef.current
            );
            syncMeasureData(map, measurePointsRef.current);
            syncMeasureOverlay(
              map,
              measurePointsRef.current,
              measureUnitRef.current,
              setMeasureLabelScreen
            );
            const currentCenter = map.getCenter();
            setCenterCoordinates([currentCenter.lat, currentCenter.lng]);
            syncScaleIndicator(map, setScaleIndicator);
            setMapOverlayRevision((revision) => (revision + 1) % 1_000_000);
            setMapLoadingLabel(null);
            return true;
          } catch (error) {
            const message =
              error instanceof Error ? error.message : 'Map overlay synchronization failed';
            console.error('Kerbodyne map overlay synchronization failed:', error);
            setMapError(message);
            return false;
          }
        };

        map.on('error', (event) => {
        const message =
          event.error instanceof Error ? event.error.message : 'Map rendering failed';
        console.error('Kerbodyne map error:', event.error ?? event);
        setMapError(message);
      });

        map.on('style.load', syncCurrentMapOverlays);
        map.on('load', syncCurrentMapOverlays);

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
        const featureId = feature?.properties?.id;
        if (typeof featureId !== 'string') {
          return;
        }
        if (feature?.layer.id === 'convergence-hit-layer') {
          onSelectConvergenceRef.current?.(featureId);
          return;
        }
        const alertId = featureId;
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
        setMapOverlayRevision((revision) => (revision + 1) % 1_000_000);
      });

      map.on('moveend', () => {
        const currentCenter = map.getCenter();
        onViewStateChangeRef.current?.({
          center: [currentCenter.lng, currentCenter.lat],
          zoom: map.getZoom(),
          bearing: map.getBearing()
        });
      });

      map.on('dblclick', (event) => {
        event.preventDefault();
        resetMapView(map, selectedRegionRef.current, enabledRegionsRef.current);
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
      const initialOverlaySyncFrame = window.requestAnimationFrame(() => {
        if (!syncCurrentMapOverlays()) {
          map.once('idle', syncCurrentMapOverlays);
        }
      });
        return () => {
          disposed = true;
          window.cancelAnimationFrame(initialOverlaySyncFrame);
          map.off('style.load', syncCurrentMapOverlays);
          map.off('load', syncCurrentMapOverlays);
          map.off('idle', syncCurrentMapOverlays);
          canvas.removeEventListener('contextmenu', handleContextMenu);
          canvas.removeEventListener('mouseup', handleMouseUp);
          aircraftMarker.remove();
          aircraftMarkerRef.current = null;
          aircraftMarkerGlyphRef.current = null;
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

    if (appliedStyleKeyRef.current === styleKey) {
      return;
    }

    setMapError(null);
    setMapLoadingLabel(buildMapLoadingLabel(mapMode));
    appliedStyleKeyRef.current = styleKey;

    let cleared = false;
    const clearLoading = () => {
      if (cleared) {
        return;
      }
      cleared = true;
      setMapLoadingLabel(null);
    };

    try {
      map.once('styledata', clearLoading);
      map.once('idle', clearLoading);
      map.setStyle(style, { diff: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to switch map style';
      console.error('Kerbodyne map style update failed:', error);
      setMapError(message);
      setMapLoadingLabel(null);
    }
  }, [mapMode, style, styleKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) {
      return;
    }

    ensureSources(map);
    applyOverlayAppearance(map, mapMode, config.track_display);
    syncMapData(
      map,
      filteredTrack,
      filteredAlerts,
      selectedAlertId,
      highlightedAlertIds,
      convergences,
      selectedConvergenceId,
      convergenceAlerts,
      enabledRegions,
      config.stale_after_seconds
    );
    syncMeasureData(map, measurePoints);
    syncMeasureOverlay(map, measurePoints, measureUnit, setMeasureLabelScreen);
  }, [
    config,
    convergenceAlerts,
    convergences,
    enabledRegions,
    filteredAlerts,
    filteredTrack,
    mapMode,
    measurePoints,
    measureUnit,
    selectedAlertId,
    selectedConvergenceId,
    highlightedAlertIds
  ]);

  useEffect(() => {
    syncAircraftMarker(
      aircraftMarkerRef.current,
      aircraftMarkerGlyphRef.current,
      filteredLiveState,
      config,
      activeFlight,
      linkPulseActive
    );
  }, [activeFlight, config, filteredLiveState, linkPulseActive]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || enabledRegions.length === 0 || activeFlight || reviewMode) {
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
  }, [activeFlight, enabledRegions, reviewMode, selectedRegion]);

  useEffect(() => {
    if (!activeFlight) {
      setFollowEnabled(false);
    }
  }, [activeFlight]);

  useEffect(() => {
    if (followAvailable !== previousFollowAvailabilityRef.current) {
      if (
        followAvailable &&
        filteredLiveState &&
        isValidCoordinate(filteredLiveState.lat, filteredLiveState.lon)
      ) {
        mapRef.current?.easeTo({
          center: [filteredLiveState.lon as number, filteredLiveState.lat as number],
          duration: 320
        });
      }
      setFollowEnabled(false);
      previousFollowAvailabilityRef.current = followAvailable;
    }
  }, [filteredLiveState, followAvailable]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tagName = target?.tagName?.toLowerCase();
      if (
        target?.isContentEditable ||
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select'
      ) {
        return;
      }

      const map = mapRef.current;
      if (!map) {
        return;
      }

      if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        map.zoomIn({ duration: 220 });
        return;
      }
      if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        map.zoomOut({ duration: 220 });
        return;
      }
      if (event.key === '.' || event.key === '>') {
        event.preventDefault();
        map.easeTo({ bearing: map.getBearing() + 20, duration: 240 });
        return;
      }
      if (event.key === ',' || event.key === '<') {
        event.preventDefault();
        map.easeTo({ bearing: map.getBearing() - 20, duration: 240 });
        return;
      }
      if (event.key.toLowerCase() === 'f') {
        if (event.repeat || !followAvailable) {
          return;
        }
        event.preventDefault();
        setFollowEnabled((current) => {
          const nextFollow = !current;
          onFollowModeChangeRef.current?.(nextFollow);
          const currentState = liveStateRef.current;
          if (
            nextFollow &&
            currentState &&
            isValidCoordinate(currentState.lat, currentState.lon)
          ) {
            map.easeTo({
              center: [currentState.lon as number, currentState.lat as number],
              duration: 320
            });
          }
          return nextFollow;
        });
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [followAvailable]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeFlight || selectedAlertId || !effectiveFollowEnabled || !filteredLiveState?.armed) {
      return;
    }

    if (!isValidCoordinate(filteredLiveState.lat, filteredLiveState.lon)) {
      return;
    }

    map.easeTo({
      center: [filteredLiveState.lon as number, filteredLiveState.lat as number],
      duration: 280
    });
  }, [
    activeFlight,
    effectiveFollowEnabled,
    filteredLiveState?.armed,
    filteredLiveState?.lat,
    filteredLiveState?.lon,
    selectedAlertId
  ]);

  useEffect(() => {
    const map = mapRef.current;
    if (
      !map ||
      !forceFollow ||
      selectedAlertId ||
      !activeFlight ||
      !filteredLiveState?.armed ||
      !isValidCoordinate(filteredLiveState.lat, filteredLiveState.lon)
    ) {
      return;
    }

    map.easeTo({
      center: [filteredLiveState.lon as number, filteredLiveState.lat as number],
      duration: 240
    });
  }, [activeFlight, filteredLiveState, forceFollow, selectedAlertId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !activeFlight || !selectedAlertId) {
      if (!selectedAlertId) {
        lastAlertFocusKeyRef.current = null;
      }
      return;
    }
    const selectedAlert = filteredAlerts.find((alert) => alert.id === selectedAlertId);
    if (!selectedAlert || !isValidAlertRecord(selectedAlert)) {
      return;
    }
    const focusKeyForAlert = `${selectedAlert.id}:${selectedAlert.detected_at}`;
    if (lastAlertFocusKeyRef.current === focusKeyForAlert) {
      return;
    }
    map.easeTo({
      center: [selectedAlert.sector.center_lon, selectedAlert.sector.center_lat],
      zoom: Math.max(map.getZoom(), compactFlightView ? 14.6 : 15.1),
      duration: 520
    });
    lastAlertFocusKeyRef.current = focusKeyForAlert;
  }, [activeFlight, compactFlightView, filteredAlerts, selectedAlertId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }

    const handle = window.requestAnimationFrame(() => {
      map.resize();
      const currentCenter = map.getCenter();
      setCenterCoordinates([currentCenter.lat, currentCenter.lng]);
      syncScaleIndicator(map, setScaleIndicator);
      syncMeasureOverlay(map, measurePointsRef.current, measureUnitRef.current, setMeasureLabelScreen);
      setMapOverlayRevision((revision) => (revision + 1) % 1_000_000);
    });

    return () => window.cancelAnimationFrame(handle);
  }, [compactFlightView]);

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
    <div className={`map-stage ${compactFlightView ? 'map-stage--compact' : ''}`}>
      <div ref={containerRef} className="map-canvas" />
      {svgMapOverlay}
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
      {!compactFlightView
        ? measureToolbarHost && measureControl
          ? createPortal(measureControl, measureToolbarHost)
          : measureControl
        : null}
      {!compactFlightView && measureLabelScreen ? (
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
      {!compactFlightView ? (
      <div className="map-bottom-strip">
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
      ) : null}
    </div>
  );
}

type CoordinatePair = [number, number];
type ProjectedPoint = { x: number; y: number };

interface GeoJsonFeature {
  type: 'Feature';
  properties?: Record<string, unknown> | null;
  geometry?: {
    type: string;
    coordinates: unknown;
  } | null;
}

interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
}

interface SvgMapOverlayOptions {
  map: Map;
  track: TrackPointRecord[];
  alerts: AlertRecord[];
  selectedAlertId?: string | null;
  highlightedAlertIds: string[];
  convergences: DetectionConvergence[];
  selectedConvergenceId?: string | null;
  convergenceAlerts: AlertRecord[];
  trackDisplay: AppConfig['track_display'];
  staleAfterSeconds: number;
  mapMode: MapMode;
  interactive: boolean;
  onSelectAlert: (alertId: string) => void;
  onSelectConvergence: (convergenceId: string) => void;
}

function buildSvgMapOverlay({
  map,
  track,
  alerts,
  selectedAlertId,
  highlightedAlertIds,
  convergences,
  selectedConvergenceId,
  convergenceAlerts,
  trackDisplay,
  staleAfterSeconds,
  mapMode,
  interactive,
  onSelectAlert,
  onSelectConvergence
}: SvgMapOverlayOptions) {
  const size = map.getContainer().getBoundingClientRect();
  if (size.width <= 0 || size.height <= 0) {
    return null;
  }

  const satellite = mapMode === 'satellite';
  const selectedConvergence =
    selectedConvergenceId != null
      ? convergences.find((convergence) => convergence.id === selectedConvergenceId) ?? null
      : null;
  const trackGeoJson = buildTrackGeoJson(track, staleAfterSeconds) as GeoJsonFeatureCollection;
  const sectorGeoJson = buildAlertSectorsGeoJson(
    selectedConvergenceId ? [] : alerts,
    selectedAlertId,
    highlightedAlertIds
  ) as GeoJsonFeatureCollection;
  const alertsGeoJson = buildAlertsGeoJson(
    alerts,
    selectedAlertId,
    highlightedAlertIds
  ) as GeoJsonFeatureCollection;
  const convergenceGeoJson = buildConvergencesGeoJson(
    convergences,
    selectedConvergenceId
  ) as GeoJsonFeatureCollection;
  const convergenceLinesGeoJson = buildConvergenceLinesGeoJson(
    selectedConvergence,
    convergenceAlerts
  ) as GeoJsonFeatureCollection;
  const lineColor = trackDisplay.color_hex || (satellite ? '#ffffff' : '#ededed');
  const trackWidth = Math.max(trackDisplay.width_px, 1.2);
  const showDashedTrack = trackDisplay.style === 'dashed';

  return (
    <svg
      className="map-svg-overlay"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      aria-hidden="true"
    >
      <g className="map-svg-overlay__cones">
        {sectorGeoJson.features.map((feature, index) => {
          const path = svgPathForPolygon(map, feature.geometry?.coordinates);
          if (!path) return null;
          const fillColor = readFeatureString(feature, 'fill_color') ?? '#ff8a24';
          const opacity = readFeatureNumber(feature, 'tint_opacity') ?? 0.42;
          const borderWidth = readFeatureNumber(feature, 'border_width') ?? 0;
          const borderOpacity = readFeatureNumber(feature, 'border_opacity') ?? 0;
          return (
            <path
              key={`sector-${readFeatureString(feature, 'id') ?? index}-${index}`}
              d={path}
              fill={fillColor}
              fillOpacity={opacity}
              stroke={readFeatureString(feature, 'border_color') ?? '#ff9a45'}
              strokeWidth={borderWidth}
              strokeOpacity={borderOpacity}
              strokeLinejoin="round"
            />
          );
        })}
      </g>

      <g className="map-svg-overlay__convergence-lines">
        {convergenceLinesGeoJson.features.map((feature, index) => {
          const path = svgPathForLineString(map, feature.geometry?.coordinates);
          if (!path) return null;
          return (
            <path
              key={`convergence-line-${readFeatureString(feature, 'alert_id') ?? index}`}
              d={path}
              fill="none"
              stroke="#ff9a2f"
              strokeWidth={3.4}
              strokeOpacity={0.96}
              strokeDasharray="9 8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </g>

      {trackDisplay.enabled ? (
        <g className="map-svg-overlay__track">
          {trackGeoJson.features.map((feature, index) => {
            const kind = readFeatureString(feature, 'kind');
            if (kind === 'gap') {
              return renderSvgMultiLineFeature(map, feature, {
                keyPrefix: `track-gap-${index}`,
                casingColor: '#050505',
                casingWidth: trackWidth + 2.8,
                casingOpacity: 0.72,
                color: '#ff6b63',
                width: trackWidth + 0.4,
                opacity: 0.96
              });
            }
            const path = svgPathForLineString(map, feature.geometry?.coordinates);
            if (!path) return null;
            return (
              <g key={`track-${index}`}>
                <path
                  d={path}
                  fill="none"
                  stroke="#050505"
                  strokeWidth={trackWidth + 2.4}
                  strokeOpacity={satellite ? 0.62 : 0.42}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d={path}
                  fill="none"
                  stroke={lineColor}
                  strokeWidth={trackWidth}
                  strokeOpacity={0.96}
                  strokeDasharray={showDashedTrack ? '12 8' : undefined}
                  strokeLinecap={showDashedTrack ? 'butt' : 'round'}
                  strokeLinejoin={showDashedTrack ? 'miter' : 'round'}
                />
              </g>
            );
          })}
        </g>
      ) : null}

      <g className="map-svg-overlay__alerts">
        {alertsGeoJson.features.map((feature, index) => {
          const point = projectFeaturePoint(map, feature);
          if (!point) return null;
          const id = readFeatureString(feature, 'id');
          const radius = readFeatureNumber(feature, 'radius') ?? 7.4;
          const haloRadius = readFeatureNumber(feature, 'halo_radius') ?? radius + 3.4;
          return (
            <g key={`alert-${id ?? index}`}>
              <circle
                cx={point.x}
                cy={point.y}
                r={haloRadius}
                fill={readFeatureString(feature, 'halo_color') ?? 'rgba(255, 122, 34, 0.38)'}
                opacity={readFeatureNumber(feature, 'halo_opacity') ?? 0.48}
              />
              <circle
                cx={point.x}
                cy={point.y}
                r={radius}
                fill={readFeatureString(feature, 'fill_color') ?? '#ff7b22'}
                fillOpacity={readFeatureNumber(feature, 'opacity') ?? 1}
                stroke={readFeatureString(feature, 'stroke_color') ?? '#ffb06a'}
                strokeWidth={readFeatureNumber(feature, 'stroke_width') ?? 1.6}
                className={interactive && id ? 'map-svg-overlay__click-target' : undefined}
                onClick={
                  interactive && id
                    ? (event) => {
                        event.stopPropagation();
                        onSelectAlert(id);
                      }
                    : undefined
                }
              />
            </g>
          );
        })}
      </g>

      <g className="map-svg-overlay__convergences">
        {convergenceGeoJson.features.map((feature, index) => {
          const kind = readFeatureString(feature, 'kind');
          const id = readFeatureString(feature, 'id');
          const selected = readFeatureBoolean(feature, 'selected');
          if (kind === 'hit') {
            const point = projectFeaturePoint(map, feature);
            if (!point) return null;
            return (
              <circle
                key={`convergence-hit-${id ?? index}`}
                cx={point.x}
                cy={point.y}
                r={selected ? 22 : 18}
                fill="transparent"
                className={interactive && id ? 'map-svg-overlay__click-target' : undefined}
                onClick={
                  interactive && id
                    ? (event) => {
                        event.stopPropagation();
                        onSelectConvergence(id);
                      }
                    : undefined
                }
              />
            );
          }
          if (kind !== 'x') {
            return null;
          }
          return renderSvgMultiLineFeature(map, feature, {
            keyPrefix: `convergence-x-${id ?? index}`,
            casingColor: '#ffffff',
            casingWidth: selected ? 8.4 : 0,
            casingOpacity: selected ? 0.94 : 0,
            color: '#ff8a24',
            width: selected ? 5.2 : 4.1,
            opacity: readFeatureNumber(feature, 'opacity') ?? 0.92
          });
        })}
      </g>
    </svg>
  );
}

function renderSvgMultiLineFeature(
  map: Map,
  feature: GeoJsonFeature,
  options: {
    keyPrefix: string;
    casingColor: string;
    casingWidth: number;
    casingOpacity: number;
    color: string;
    width: number;
    opacity: number;
  }
) {
  const lines = Array.isArray(feature.geometry?.coordinates)
    ? (feature.geometry.coordinates as unknown[])
    : [];
  return (
    <g key={options.keyPrefix}>
      {lines.map((coordinates, index) => {
        const path = svgPathForLineString(map, coordinates);
        if (!path) return null;
        return (
          <g key={`${options.keyPrefix}-${index}`}>
            {options.casingWidth > 0 ? (
              <path
                d={path}
                fill="none"
                stroke={options.casingColor}
                strokeWidth={options.casingWidth}
                strokeOpacity={options.casingOpacity}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            <path
              d={path}
              fill="none"
              stroke={options.color}
              strokeWidth={options.width}
              strokeOpacity={options.opacity}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </g>
  );
}

function svgPathForLineString(map: Map, coordinates: unknown) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }
  const points = coordinates
    .map((coordinate) => projectCoordinatePair(map, coordinate))
    .filter(isProjectedPoint);
  if (points.length < 2) {
    return null;
  }
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`)
    .join(' ');
}

function svgPathForPolygon(map: Map, coordinates: unknown) {
  if (!Array.isArray(coordinates)) {
    return null;
  }
  const paths = coordinates.flatMap((ring) => {
    if (!Array.isArray(ring) || ring.length < 3) {
      return [];
    }
    const points = ring
      .map((coordinate) => projectCoordinatePair(map, coordinate))
      .filter(isProjectedPoint);
    if (points.length < 3) {
      return [];
    }
    return [
      `${points
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${formatSvgNumber(point.x)} ${formatSvgNumber(point.y)}`)
        .join(' ')} Z`
    ];
  });
  return paths.length > 0 ? paths.join(' ') : null;
}

function projectFeaturePoint(map: Map, feature: GeoJsonFeature) {
  return projectCoordinatePair(map, feature.geometry?.coordinates);
}

function projectCoordinatePair(map: Map, coordinate: unknown) {
  if (!Array.isArray(coordinate) || coordinate.length < 2) {
    return null;
  }
  const [lon, lat] = coordinate as CoordinatePair;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return null;
  }
  const point = map.project([lon, lat]);
  return Number.isFinite(point.x) && Number.isFinite(point.y)
    ? { x: point.x, y: point.y }
    : null;
}

function isProjectedPoint(point: ProjectedPoint | null): point is ProjectedPoint {
  return point != null;
}

function readFeatureString(feature: GeoJsonFeature, key: string) {
  const value = feature.properties?.[key];
  return typeof value === 'string' ? value : null;
}

function readFeatureNumber(feature: GeoJsonFeature, key: string) {
  const value = feature.properties?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readFeatureBoolean(feature: GeoJsonFeature, key: string) {
  return feature.properties?.[key] === true;
}

function formatSvgNumber(value: number) {
  return Number.isFinite(value) ? value.toFixed(2) : '0';
}

function getInteractiveLayers(map: Map) {
  return INTERACTIVE_LAYERS.filter((layerId) => Boolean(map.getLayer(layerId)));
}

function buildMapLoadingLabel(mapMode: MapMode) {
  return `Loading ${mapMode === 'satellite' ? 'satellite' : 'street'} map`;
}

function toFiniteNumber(value: number | string | null | undefined) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function isValidCoordinate(
  lat: number | string | null | undefined,
  lon: number | string | null | undefined
) {
  const normalizedLat = toFiniteNumber(lat);
  const normalizedLon = toFiniteNumber(lon);
  if (normalizedLat == null || normalizedLon == null) {
    return false;
  }

  if (normalizedLat < -90 || normalizedLat > 90 || normalizedLon < -180 || normalizedLon > 180) {
    return false;
  }

  return !(Math.abs(normalizedLat) < 0.000001 && Math.abs(normalizedLon) < 0.000001);
}

function isValidTrackPoint(point: TrackPointRecord) {
  return isValidCoordinate(point.lat, point.lon);
}

function isValidAlertRecord(alert: AlertRecord) {
  return isValidCoordinate(alert.sector.center_lat, alert.sector.center_lon);
}

function ensureGeoJsonSource(map: Map, sourceId: string, data: GeoJSON.GeoJSON) {
  if (map.getSource(sourceId)) {
    return;
  }
  map.addSource(sourceId, {
    type: 'geojson',
    data
  });
}

function ensureLayer(map: Map, layer: LayerSpecification) {
  if (map.getLayer(layer.id)) {
    return;
  }
  map.addLayer(layer);
}

function ensureSources(map: Map) {
  ensureGeoJsonSource(map, SOURCE_SECTOR, buildAlertSectorsGeoJson([], null));
  ensureLayer(
    map,
    {
      id: 'sector-mask',
      type: 'fill',
      source: SOURCE_SECTOR,
      paint: {
        'fill-color': '#020202',
        'fill-opacity': ['coalesce', ['get', 'mask_opacity_street'], 0.06]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'sector-fill',
      type: 'fill',
      source: SOURCE_SECTOR,
      paint: {
        'fill-color': ['coalesce', ['get', 'fill_color'], '#d5d5d5'],
        'fill-opacity': ['coalesce', ['get', 'tint_opacity'], 0.08]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'sector-border',
      type: 'line',
      source: SOURCE_SECTOR,
      paint: {
        'line-color': ['coalesce', ['get', 'border_color'], '#fff4e8'],
        'line-width': ['coalesce', ['get', 'border_width'], 0],
        'line-opacity': ['coalesce', ['get', 'border_opacity'], 0]
      }
    }
  );

  ensureGeoJsonSource(map, SOURCE_CONVERGENCE_LINES, buildConvergenceLinesGeoJson(null, []));
  ensureLayer(
    map,
    {
      id: 'convergence-line-casing-layer',
      type: 'line',
      source: SOURCE_CONVERGENCE_LINES,
      paint: {
        'line-color': '#050505',
        'line-width': 0,
        'line-opacity': 0,
        'line-dasharray': [2.8, 1.6]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'convergence-line-layer',
      type: 'line',
      source: SOURCE_CONVERGENCE_LINES,
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#ff8a24',
        'line-width': 3.1,
        'line-opacity': 0.96,
        'line-dasharray': [2.8, 1.6]
      }
    }
  );

  ensureGeoJsonSource(map, SOURCE_COVERAGE_MASK, buildCoverageMaskGeoJson(null));
  ensureLayer(
    map,
    {
      id: 'coverage-mask-layer',
      type: 'fill',
      source: SOURCE_COVERAGE_MASK,
      paint: {
        'fill-color': '#040404',
        'fill-opacity': 0.58
      }
    }
  );

  ensureGeoJsonSource(map, SOURCE_COVERAGE_BOUNDS, buildCoverageBoundsGeoJson(null));
  ensureLayer(
    map,
    {
      id: 'coverage-bounds-layer',
      type: 'line',
      source: SOURCE_COVERAGE_BOUNDS,
      paint: {
        'line-color': '#c9d0d8',
        'line-width': 1.15,
        'line-opacity': 0.52,
        'line-dasharray': [2, 2]
      }
    }
  );

  ensureGeoJsonSource(map, SOURCE_MEASURE, buildMeasureGeoJson([]));
  ensureLayer(
    map,
    {
      id: 'measure-line',
      type: 'line',
      source: SOURCE_MEASURE,
      filter: ['==', ['get', 'kind'], 'line'],
      paint: {
        'line-color': '#ffffff',
        'line-width': 2.6,
        'line-dasharray': [2, 1.4]
      }
    }
  );
  ensureLayer(
    map,
    {
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
    }
  );

  ensureGeoJsonSource(map, SOURCE_TRACK, buildTrackGeoJson([]));
  ensureLayer(
    map,
    {
      id: 'track-casing',
      type: 'line',
      source: SOURCE_TRACK,
      filter: ['==', ['get', 'kind'], 'segment'],
      paint: {
        'line-width': 5.4,
        'line-color': '#050505',
        'line-opacity': 0.48
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'track-layer',
      type: 'line',
      source: SOURCE_TRACK,
      filter: ['==', ['get', 'kind'], 'segment'],
      paint: {
        'line-width': 2.8,
        'line-color': '#f0f0f0',
        'line-opacity': 0.94
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'track-layer-dashed',
      type: 'line',
      source: SOURCE_TRACK,
      filter: ['==', ['get', 'kind'], 'segment'],
      paint: {
        'line-width': 2.8,
        'line-color': '#f0f0f0',
        'line-opacity': 0,
        'line-dasharray': [3.2, 2.2]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'track-gap-casing',
      type: 'line',
      source: SOURCE_TRACK,
      filter: ['==', ['get', 'kind'], 'gap'],
      paint: {
        'line-width': 5.4,
        'line-color': '#050505',
        'line-opacity': 0.66
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'track-gap-layer',
      type: 'line',
      source: SOURCE_TRACK,
      filter: ['==', ['get', 'kind'], 'gap'],
      paint: {
        'line-width': 2.8,
        'line-color': '#ff6b63',
        'line-opacity': 0.96
      }
    }
  );

  ensureGeoJsonSource(map, SOURCE_ALERTS, buildAlertsGeoJson([]));
  ensureLayer(
    map,
    {
      id: 'alerts-halo-layer',
      type: 'circle',
      source: SOURCE_ALERTS,
      paint: {
        'circle-radius': ['coalesce', ['get', 'halo_radius'], 8],
        'circle-color': '#030303',
        'circle-opacity': ['coalesce', ['get', 'halo_opacity'], 0.24]
      }
    }
  );
  ensureLayer(
    map,
    {
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
    }
  );

  ensureGeoJsonSource(map, SOURCE_CONVERGENCES, buildConvergencesGeoJson([], null));
  ensureLayer(
    map,
    {
      id: 'convergence-x-border-layer',
      type: 'line',
      source: SOURCE_CONVERGENCES,
      filter: ['==', ['get', 'kind'], 'x'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['case', ['boolean', ['get', 'selected'], false], 8.4, 0],
        'line-opacity': ['case', ['boolean', ['get', 'selected'], false], 0.94, 0]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'convergence-x-layer',
      type: 'line',
      source: SOURCE_CONVERGENCES,
      filter: ['==', ['get', 'kind'], 'x'],
      layout: {
        'line-cap': 'round',
        'line-join': 'round'
      },
      paint: {
        'line-color': '#ff8a24',
        'line-width': ['case', ['boolean', ['get', 'selected'], false], 5.2, 4.1],
        'line-opacity': ['coalesce', ['get', 'opacity'], 0.92]
      }
    }
  );
  ensureLayer(
    map,
    {
      id: 'convergence-hit-layer',
      type: 'circle',
      source: SOURCE_CONVERGENCES,
      filter: ['==', ['get', 'kind'], 'hit'],
      paint: {
        'circle-radius': ['case', ['boolean', ['get', 'selected'], false], 22, 18],
        'circle-color': '#ff8a24',
        'circle-opacity': 0.001
      }
    }
  );
}

function safeSetPaintProperty(map: Map, layerId: string, property: string, value: unknown) {
  if (!map.getLayer(layerId)) {
    return;
  }
  map.setPaintProperty(layerId, property, value as never);
}

function safeSetLayoutProperty(map: Map, layerId: string, property: string, value: unknown) {
  if (!map.getLayer(layerId)) {
    return;
  }
  map.setLayoutProperty(layerId, property, value as never);
}

function applyOverlayAppearance(
  map: Map,
  mapMode: MapMode,
  trackDisplay: AppConfig['track_display']
) {
  const satellite = mapMode === 'satellite';
  safeSetPaintProperty(
    map,
    'sector-mask',
    'fill-opacity',
    ['coalesce', ['get', satellite ? 'mask_opacity_satellite' : 'mask_opacity_street'], 0.08]
  );
  const baseWidth = Math.max(trackDisplay.width_px, 1.2);
  const lineColor = trackDisplay.color_hex || (satellite ? '#ffffff' : '#ededed');
  const showSolidTrack = trackDisplay.enabled && trackDisplay.style !== 'dashed';
  const showDashedTrack = trackDisplay.enabled && trackDisplay.style === 'dashed';
  safeSetPaintProperty(map, 'track-casing', 'line-width', trackDisplay.enabled ? baseWidth + 2.4 : 0.2);
  safeSetPaintProperty(map, 'track-casing', 'line-opacity', trackDisplay.enabled ? (satellite ? 0.62 : 0.42) : 0);
  safeSetPaintProperty(map, 'track-layer', 'line-width', trackDisplay.enabled ? baseWidth : 0.2);
  safeSetPaintProperty(map, 'track-layer', 'line-color', lineColor);
  safeSetPaintProperty(map, 'track-layer', 'line-opacity', showSolidTrack ? 0.96 : 0);
  safeSetPaintProperty(map, 'track-layer-dashed', 'line-width', trackDisplay.enabled ? baseWidth : 0.2);
  safeSetPaintProperty(map, 'track-layer-dashed', 'line-color', lineColor);
  safeSetPaintProperty(map, 'track-layer-dashed', 'line-opacity', showDashedTrack ? 0.96 : 0);
  safeSetPaintProperty(map, 'track-gap-casing', 'line-width', trackDisplay.enabled ? baseWidth + 2.8 : 0.2);
  safeSetPaintProperty(map, 'track-gap-casing', 'line-opacity', trackDisplay.enabled ? 0.72 : 0);
  safeSetPaintProperty(map, 'track-gap-layer', 'line-width', trackDisplay.enabled ? baseWidth + 0.4 : 0.2);
  safeSetPaintProperty(map, 'track-gap-layer', 'line-opacity', trackDisplay.enabled ? 0.96 : 0);
  safeSetLayoutProperty(
    map,
    'track-layer',
    'line-cap',
    'round'
  );
  safeSetLayoutProperty(
    map,
    'track-layer',
    'line-join',
    'round'
  );
  safeSetLayoutProperty(map, 'track-layer-dashed', 'line-cap', 'butt');
  safeSetLayoutProperty(map, 'track-layer-dashed', 'line-join', 'miter');
  safeSetPaintProperty(map, 'track-layer-dashed', 'line-dasharray', [3.2, 2.2]);
  safeSetLayoutProperty(map, 'track-gap-layer', 'line-cap', 'round');
  safeSetLayoutProperty(map, 'track-gap-layer', 'line-join', 'round');
  safeSetLayoutProperty(map, 'track-gap-casing', 'line-cap', 'round');
  safeSetLayoutProperty(map, 'track-gap-casing', 'line-join', 'round');
  safeSetPaintProperty(map, 'alerts-halo-layer', 'circle-opacity', satellite ? 0.34 : 0.22);
  safeSetPaintProperty(map, 'coverage-mask-layer', 'fill-opacity', satellite ? 0.64 : 0.56);
  safeSetPaintProperty(map, 'coverage-bounds-layer', 'line-opacity', satellite ? 0.6 : 0.5);
}

function syncMapData(
  map: Map,
  track: TrackPointRecord[],
  alerts: AlertRecord[],
  selectedAlertId?: string | null,
  highlightedAlertIds: string[] = [],
  convergences: DetectionConvergence[] = [],
  selectedConvergenceId: string | null = null,
  convergenceAlerts: AlertRecord[] = [],
  enabledRegions: OfflineRegionManifest[] = [],
  staleAfterSeconds = 10
) {
  const emptyOverlayData = emptyFeatureCollection();
  void track;
  void alerts;
  void selectedAlertId;
  void highlightedAlertIds;
  void convergences;
  void selectedConvergenceId;
  void convergenceAlerts;
  void staleAfterSeconds;
  (map.getSource(SOURCE_TRACK) as GeoJSONSource).setData(emptyOverlayData);
  (map.getSource(SOURCE_ALERTS) as GeoJSONSource).setData(emptyOverlayData);
  (map.getSource(SOURCE_SECTOR) as GeoJSONSource).setData(emptyOverlayData);
  (map.getSource(SOURCE_CONVERGENCES) as GeoJSONSource).setData(emptyOverlayData);
  (map.getSource(SOURCE_CONVERGENCE_LINES) as GeoJSONSource).setData(emptyOverlayData);
  (map.getSource(SOURCE_COVERAGE_MASK) as GeoJSONSource).setData(
    buildCoverageMaskGeoJson(enabledRegions)
  );
  (map.getSource(SOURCE_COVERAGE_BOUNDS) as GeoJSONSource).setData(
    buildCoverageBoundsGeoJson(enabledRegions)
  );
}

function emptyFeatureCollection() {
  return {
    type: 'FeatureCollection' as const,
    features: []
  };
}

function syncAircraftMarker(
  marker: maplibregl.Marker | null,
  glyph: HTMLDivElement | null,
  liveState: AircraftLiveState | null | undefined,
  config: AppConfig,
  activeFlight: boolean,
  linkPulseActive: boolean
) {
  if (!marker || !glyph) {
    return;
  }
  const element = marker.getElement();

  if (!liveState || !isValidCoordinate(liveState.lat, liveState.lon)) {
    element.style.display = 'none';
    return;
  }

  element.style.display = 'block';
  element.dataset.shape = config.aircraft_icon.shape;
  element.style.setProperty('--aircraft-size', `${config.aircraft_icon.size_px}px`);
  element.style.setProperty('--aircraft-fill', config.aircraft_icon.color_hex);
  element.classList.toggle('aircraft-marker--pulsing', activeFlight && linkPulseActive);
  marker.setLngLat([liveState.lon as number, liveState.lat as number]);
  marker.setRotation(Math.round(liveState.heading_deg ?? 0));
}

function resetMapView(
  map: Map,
  selectedRegion: OfflineRegionManifest | null | undefined,
  enabledRegions: OfflineRegionManifest[]
) {
  if (selectedRegion) {
    const [west, south, east, north] = selectedRegion.bounds;
    map.fitBounds([[west, south], [east, north]], {
      padding: 72,
      duration: 420,
      maxZoom: 15.1
    });
    return;
  }
  if (enabledRegions.length > 0) {
    const [west, south, east, north] = mergeRegionBounds(enabledRegions);
    map.fitBounds([[west, south], [east, north]], {
      padding: 72,
      duration: 420,
      maxZoom: 15.1
    });
    return;
  }
  map.easeTo({ center: [-121.493, 38.575], zoom: 12.8, bearing: 0, pitch: 0, duration: 420 });
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
      zoom: 12.8,
      bearing: 0
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
    zoom: Math.max(9.8, Math.min(15.1, Math.min(zoomLng, zoomLat) - 0.2)),
    bearing: 0
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
