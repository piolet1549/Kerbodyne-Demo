const EARTH_RADIUS_M = 6378137;
const DISPLAY_CONE_RANGE_M = 1000;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
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

export function buildAlertSectorsGeoJson(alerts, selectedAlertId) {
  if (!alerts || alerts.length === 0) {
    return {
      type: 'FeatureCollection',
      features: []
    };
  }

  const bandCount = 7;
  const bandWidth = DISPLAY_CONE_RANGE_M / bandCount;
  const features = [];

  for (const alert of alerts) {
    const selected = selectedAlertId != null && alert.id === selectedAlertId;

    for (let bandIndex = 0; bandIndex < bandCount; bandIndex += 1) {
      const innerRadiusM = bandIndex * bandWidth;
      const outerRadiusM = (bandIndex + 1) * bandWidth;
      const tintBase = selected ? 0.18 : 0.07;
      const tintStep = selected ? 0.022 : 0.01;
      const tintOpacity = Math.max(
        selected ? 0.05 : 0.015,
        tintBase - bandIndex * tintStep
      );
      const streetMaskBase = selected ? 0.12 : 0.08;
      const satelliteMaskBase = selected ? 0.34 : 0.22;
      const maskStep = selected ? 0.015 : 0.012;
      const maskOpacityStreet = Math.max(
        selected ? 0.035 : 0.02,
        streetMaskBase - bandIndex * maskStep
      );
      const maskOpacitySatellite = Math.max(
        selected ? 0.14 : 0.08,
        satelliteMaskBase - bandIndex * (maskStep * 1.35)
      );

      features.push({
        type: 'Feature',
        properties: {
          id: alert.id,
          class_label: alert.class_label,
          selected,
          tint_opacity: tintOpacity,
          mask_opacity_street: maskOpacityStreet,
          mask_opacity_satellite: maskOpacitySatellite,
          fill_color: selected ? '#ff8c57' : '#d5d5d5'
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            buildSectorBandPolygon(
              alert.sector.center_lat,
              alert.sector.center_lon,
              alert.sector.bearing_deg,
              alert.sector.fov_deg,
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

export function buildTrackGeoJson(track) {
  return {
    type: 'FeatureCollection',
    features:
      track.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'LineString',
                coordinates: track.map(([lat, lon]) => [lon, lat])
              }
            }
          ]
        : []
  };
}

export function buildAlertsGeoJson(alerts, selectedAlertId) {
  return {
    type: 'FeatureCollection',
    features: alerts.map((alert) => ({
      type: 'Feature',
      properties: (() => {
        const selected = selectedAlertId != null && alert.id === selectedAlertId;
        return {
          id: alert.id,
          class_label: alert.class_label,
          confidence: alert.confidence,
          selected,
          fill_color: selected ? '#ff7b45' : '#cecece',
          stroke_color: selected ? '#fff4ec' : '#6b6b6b',
          radius: selected ? 7.5 : 5.25,
          stroke_width: selected ? 2.6 : 1.35,
          opacity: selected ? 0.98 : 0.42,
          halo_radius: selected ? 10.5 : 7.4,
          halo_color: selected ? 'rgba(0, 0, 0, 0.42)' : 'rgba(0, 0, 0, 0.2)',
          halo_opacity: selected ? 0.45 : 0.22
        };
      })(),
      geometry: {
        type: 'Point',
        coordinates: [alert.sector.center_lon, alert.sector.center_lat]
      }
    }))
  };
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
