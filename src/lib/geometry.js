const EARTH_RADIUS_M = 6378137;
const DISPLAY_CONE_RANGE_M = 1000;
const DEFAULT_CONE_FOV_DEG = 38;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function toFiniteNumber(value, fallback = null) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeBearing(value) {
  const normalized = value % 360;
  return normalized < 0 ? normalized + 360 : normalized;
}

function normalizeCoordinate(latitude, longitude) {
  const lat = toFiniteNumber(latitude);
  const lon = toFiniteNumber(longitude);
  if (lat == null || lon == null) {
    return null;
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return null;
  }
  if (Math.abs(lat) < 0.000001 && Math.abs(lon) < 0.000001) {
    return null;
  }
  return { lat, lon };
}

function normalizeAlertSector(alert) {
  const sector = alert?.sector;
  const coordinate = normalizeCoordinate(sector?.center_lat, sector?.center_lon);
  if (!coordinate) {
    return null;
  }
  const bearing = normalizeBearing(toFiniteNumber(sector?.bearing_deg, 0));
  const fov = clamp(toFiniteNumber(sector?.fov_deg, DEFAULT_CONE_FOV_DEG), 1, 160);
  return {
    id: alert.id,
    class_label: alert.class_label,
    confidence: toFiniteNumber(alert.confidence, 0),
    center_lat: coordinate.lat,
    center_lon: coordinate.lon,
    bearing_deg: bearing,
    fov_deg: fov
  };
}

function projectCoordinate(latitude, longitude, bearingDeg, distanceM) {
  const bearing = toRadians(bearingDeg);
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const lat1 = toRadians(latitude);
  const lon1 = toRadians(longitude);

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngularDistance = Math.sin(angularDistance);
  const cosAngularDistance = Math.cos(angularDistance);

  const lat2 = Math.asin(
    sinLat1 * cosAngularDistance +
      cosLat1 * sinAngularDistance * Math.cos(bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * sinAngularDistance * cosLat1,
      cosAngularDistance - sinLat1 * Math.sin(lat2)
    );

  return [toDegrees(lon2), toDegrees(lat2)];
}

function buildSectorArc(
  latitude,
  longitude,
  bearingDeg,
  fovDeg,
  distanceM,
  steps = 28
) {
  const start = bearingDeg - fovDeg / 2;
  const end = bearingDeg + fovDeg / 2;
  const points = [];

  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    const bearing = start + ratio * (end - start);
    points.push(projectCoordinate(latitude, longitude, bearing, distanceM));
  }

  return points;
}

function buildSectorBandPolygon(
  latitude,
  longitude,
  bearingDeg,
  fovDeg,
  innerRadiusM,
  outerRadiusM
) {
  const outerArc = buildSectorArc(
    latitude,
    longitude,
    bearingDeg,
    fovDeg,
    outerRadiusM
  );
  const innerArc =
    innerRadiusM > 0
      ? buildSectorArc(
          latitude,
          longitude,
          bearingDeg,
          fovDeg,
          innerRadiusM
        ).reverse()
      : [[longitude, latitude]];

  return [...outerArc, ...innerArc, outerArc[0] || [longitude, latitude]];
}

export function buildAlertSectorsGeoJson(alerts, selectedAlertId, highlightedAlertIds) {
  if (!alerts || alerts.length === 0) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const bandCount = 7;
  const bandWidth = DISPLAY_CONE_RANGE_M / bandCount;
  const features = [];
  const highlightedIds = normalizeIdSet(highlightedAlertIds);
  const selectedConeColors = [
    '#ff6f18',
    '#ff781e',
    '#ff8126',
    '#ff8b30',
    '#ff953c',
    '#ffa04a',
    '#ffad5c'
  ];

  for (const alert of alerts) {
    const sector = normalizeAlertSector(alert);
    if (!sector) {
      continue;
    }
    const selected = selectedAlertId != null && alert.id === selectedAlertId;
    const highlighted = selected || highlightedIds.has(alert.id);

    for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
      const innerRadiusM = bandIndex * bandWidth;
      const outerRadiusM = (bandIndex + 1) * bandWidth;
      const tintBase = 0.78;
      const tintStep = 0.095;
      const tintOpacity = Math.max(
        0.18,
        tintBase - bandIndex * tintStep
      );
      const maskOpacityStreet = 0;
      const maskOpacitySatellite = 0.012;

      features.push({
        type: 'Feature',
        properties: {
          id: alert.id,
          class_label: alert.class_label,
          selected,
          highlighted,
          tint_opacity: tintOpacity,
          mask_opacity_street: maskOpacityStreet,
          mask_opacity_satellite: maskOpacitySatellite,
          fill_color: selectedConeColors[bandIndex],
          border_color: selected ? '#fff4e8' : '#ff9a45',
          border_opacity: selected ? 0.95 : 0,
          border_width: selected ? 2.6 : 0
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            buildSectorBandPolygon(
              sector.center_lat,
              sector.center_lon,
              sector.bearing_deg,
              sector.fov_deg,
              innerRadiusM,
              outerRadiusM
            )
          ]
        }
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features
  };
}

export function buildCoverageMaskGeoJson(enabledRegions) {
  if (!enabledRegions || enabledRegions.length === 0) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-180, -85],
              [180, -85],
              [180, 85],
              [-180, 85],
              [-180, -85]
            ],
            ...enabledRegions.map((region) => {
              const [west, south, east, north] = region.bounds;
              return [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south]
              ];
            })
          ]
        }
      }
    ]
  };
}

export function buildCoverageBoundsGeoJson(enabledRegions) {
  if (!enabledRegions || enabledRegions.length === 0) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  return {
    type: 'FeatureCollection',
    features: enabledRegions.map((region) => {
      const [west, south, east, north] = region.bounds;
      return {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [west, south],
              [east, south],
              [east, north],
              [west, north],
              [west, south]
            ]
          ]
        }
      };
    })
  };
}

export function buildTrackGeoJson(track, staleAfterSeconds = 10) {
  const normalizedTrack = Array.isArray(track)
    ? track.map(normalizeTrackPoint).filter(Boolean)
    : [];
  if (normalizedTrack.length < 2) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const features = [];
  let currentSegment = [normalizedTrack[0]];

  for (let index = 1; index < normalizedTrack.length; index += 1) {
    const previous = normalizedTrack[index - 1];
    const current = normalizedTrack[index];
    const elapsedSeconds = Math.max(
      0,
      (Date.parse(current.recorded_at) - Date.parse(previous.recorded_at)) / 1000
    );
    const staleGap = Number.isFinite(elapsedSeconds) && elapsedSeconds > staleAfterSeconds;

    if (staleGap) {
      features.push(...buildTrackSegmentFeatures(currentSegment));
      features.push(...buildGapMarkerFeatures(previous, current));
      currentSegment = [current];
      continue;
    }

    currentSegment.push(current);
  }

  features.push(...buildTrackSegmentFeatures(currentSegment));

  return {
    type: 'FeatureCollection',
    features
  };
}

function normalizeTrackPoint(point) {
  const coordinate = normalizeCoordinate(point?.lat, point?.lon);
  if (!coordinate) {
    return null;
  }
  const recordedAt =
    typeof point.recorded_at === 'string' && point.recorded_at.trim() !== ''
      ? point.recorded_at
      : new Date(0).toISOString();
  return {
    ...point,
    lat: coordinate.lat,
    lon: coordinate.lon,
    recorded_at: recordedAt,
    alt_msl_m: toFiniteNumber(point.alt_msl_m),
    heading_deg: toFiniteNumber(point.heading_deg),
    groundspeed_mps: toFiniteNumber(point.groundspeed_mps)
  };
}

function buildTrackSegmentFeatures(segment) {
  if (!segment || segment.length < 2) {
    return [];
  }
  const coordinates = segment.map((point) => [point.lon, point.lat]);
  const smoothed = smoothPolyline(coordinates, 2);
  return [
    {
      type: 'Feature',
      properties: {
        kind: 'segment'
      },
      geometry: {
        type: 'LineString',
        coordinates: smoothed
      }
    }
  ];
}

function smoothPolyline(points, iterations = 1) {
  if (!Array.isArray(points) || points.length < 3) {
    return points;
  }

  let next = points.slice();
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    if (next.length < 3) {
      return next;
    }
    const smoothed = [next[0]];
    for (let index = 0; index < next.length - 1; index += 1) {
      const start = next[index];
      const end = next[index + 1];
      if (index === 0) {
        smoothed.push(interpolateCoordinate(start, end, 0.28));
      } else if (index === next.length - 2) {
        smoothed.push(interpolateCoordinate(start, end, 0.72));
      } else {
        smoothed.push(interpolateCoordinate(start, end, 0.25));
        smoothed.push(interpolateCoordinate(start, end, 0.75));
      }
    }
    smoothed.push(next[next.length - 1]);
    next = smoothed;
  }
  return next;
}

function interpolateCoordinate(start, end, ratio) {
  return [
    start[0] + (end[0] - start[0]) * ratio,
    start[1] + (end[1] - start[1]) * ratio
  ];
}

function buildGapMarkerFeatures(startPoint, endPoint) {
  const centers = buildGapMarkerCenters(startPoint, endPoint);
  const features = [];

  centers.forEach(([lat, lon]) => {
    const sizeM = 16;
    const diagOneStart = projectCoordinate(lat, lon, 45, sizeM);
    const diagOneEnd = projectCoordinate(lat, lon, 225, sizeM);
    const diagTwoStart = projectCoordinate(lat, lon, 135, sizeM);
    const diagTwoEnd = projectCoordinate(lat, lon, 315, sizeM);
    features.push({
      type: 'Feature',
      properties: {
        kind: 'gap'
      },
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [diagOneStart, diagOneEnd],
          [diagTwoStart, diagTwoEnd]
        ]
      }
    });
  });

  return features;
}

function buildGapMarkerCenters(startPoint, endPoint) {
  const distance = haversineDistanceM(
    startPoint.lat,
    startPoint.lon,
    endPoint.lat,
    endPoint.lon
  );
  const markerCount = Math.max(1, Math.min(4, Math.round(distance / 90)));
  const centers = [];

  for (let index = 0; index < markerCount; index += 1) {
    const ratio = markerCount === 1 ? 0.5 : (index + 1) / (markerCount + 1);
    centers.push([
      startPoint.lat + (endPoint.lat - startPoint.lat) * ratio,
      startPoint.lon + (endPoint.lon - startPoint.lon) * ratio
    ]);
  }

  return centers;
}

function haversineDistanceM(startLat, startLon, endLat, endLon) {
  const lat1 = toRadians(startLat);
  const lat2 = toRadians(endLat);
  const latDiff = toRadians(endLat - startLat);
  const lonDiff = toRadians(endLon - startLon);
  const a =
    Math.sin(latDiff / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(lonDiff / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_M * c;
}

export function buildAlertsGeoJson(alerts, selectedAlertId, highlightedAlertIds) {
  const highlightedIds = normalizeIdSet(highlightedAlertIds);
  return {
    type: 'FeatureCollection',
    features: alerts.flatMap((alert) => {
      const sector = normalizeAlertSector(alert);
      if (!sector) {
        return [];
      }
      const selected = selectedAlertId != null && alert.id === selectedAlertId;
      const highlighted = selected || highlightedIds.has(alert.id);
      return [
        {
          type: 'Feature',
          properties: {
            id: alert.id,
            class_label: alert.class_label,
            confidence: sector.confidence,
            selected,
            highlighted,
            fill_color: '#ff7b22',
            stroke_color: selected ? '#ffffff' : '#ffb06a',
            radius: selected ? 8.8 : 7.4,
            stroke_width: selected ? 3.4 : 1.6,
            opacity: 1,
            halo_radius: selected ? 12.6 : 10.8,
            halo_color: selected ? 'rgba(255, 255, 255, 0.44)' : 'rgba(255, 122, 34, 0.38)',
            halo_opacity: selected ? 0.72 : 0.48
          },
          geometry: {
            type: 'Point',
            coordinates: [sector.center_lon, sector.center_lat]
          }
        }
      ];
    })
  };
}

export function buildConvergencesGeoJson(convergences, selectedConvergenceId) {
  return {
    type: 'FeatureCollection',
    features: Array.isArray(convergences)
      ? convergences.flatMap((convergence) => {
          const coordinate = normalizeCoordinate(convergence?.lat, convergence?.lon);
          if (!coordinate) {
            return [];
          }
          const selected = convergence.id === selectedConvergenceId;
          const sizeM = selected ? 34 : 28;
          const diagOneStart = projectCoordinate(coordinate.lat, coordinate.lon, 45, sizeM);
          const diagOneEnd = projectCoordinate(coordinate.lat, coordinate.lon, 225, sizeM);
          const diagTwoStart = projectCoordinate(coordinate.lat, coordinate.lon, 135, sizeM);
          const diagTwoEnd = projectCoordinate(coordinate.lat, coordinate.lon, 315, sizeM);
          return [
            {
              type: 'Feature',
              properties: {
                id: convergence.id,
                kind: 'x',
                selected,
                opacity: selected ? 1 : 0.92
              },
              geometry: {
                type: 'MultiLineString',
                coordinates: [
                  [diagOneStart, diagOneEnd],
                  [diagTwoStart, diagTwoEnd]
                ]
              }
            },
            {
              type: 'Feature',
              properties: {
                id: convergence.id,
                kind: 'hit',
                selected
              },
              geometry: {
                type: 'Point',
                coordinates: [coordinate.lon, coordinate.lat]
              }
            }
          ];
        })
      : []
  };
}

export function buildConvergenceLinesGeoJson(convergence, alerts) {
  if (!convergence || !Array.isArray(alerts)) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const target = normalizeCoordinate(convergence.lat, convergence.lon);
  if (!target) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const alertIds = normalizeIdSet(convergence.alertIds);
  return {
    type: 'FeatureCollection',
    features: alerts.flatMap((alert) => {
      if (!alertIds.has(alert.id)) {
        return [];
      }
      const sector = normalizeAlertSector(alert);
      if (!sector) {
        return [];
      }
      return [
        {
          type: 'Feature',
          properties: {
            id: convergence.id,
            alert_id: alert.id
          },
          geometry: {
            type: 'LineString',
            coordinates: [
              [sector.center_lon, sector.center_lat],
              [target.lon, target.lat]
            ]
          }
        }
      ];
    })
  };
}

function normalizeIdSet(value) {
  if (!value) {
    return new Set();
  }
  if (value instanceof Set) {
    return value;
  }
  if (Array.isArray(value)) {
    return new Set(value);
  }
  return new Set();
}

function buildAircraftPolygon(latitude, longitude, headingDeg) {
  const nose = projectCoordinate(latitude, longitude, headingDeg, 24);
  const rightWing = projectCoordinate(latitude, longitude, headingDeg + 145, 16);
  const tail = projectCoordinate(latitude, longitude, headingDeg + 180, 12);
  const leftWing = projectCoordinate(latitude, longitude, headingDeg - 145, 16);
  return [nose, rightWing, tail, leftWing, nose];
}

export function buildAircraftGeoJson(liveState) {
  if (!liveState) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const headingDeg =
    liveState.heading_deg === undefined || liveState.heading_deg === null
      ? 0
      : liveState.heading_deg;

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          heading_deg: headingDeg
        },
        geometry: {
          type: 'Polygon',
          coordinates: [buildAircraftPolygon(liveState.lat, liveState.lon, headingDeg)]
        }
      }
    ]
  };
}
