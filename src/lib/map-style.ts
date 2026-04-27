import { layers, namedFlavor } from '@protomaps/basemaps';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import { Protocol } from 'pmtiles';
import type { AppConfig, MapMode, OfflineRegionManifest } from './types';

interface MapStyleOptions {
  enabledRegions?: OfflineRegionManifest[];
  assetOrigin?: string | null;
  mapMode?: MapMode;
}

let protocolRegistered = false;

export function ensurePmtilesProtocol() {
  if (protocolRegistered) {
    return;
  }

  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocolRegistered = true;
}

export function createMapStyle(
  config: AppConfig,
  options: MapStyleOptions = {}
): StyleSpecification | string {
  const { enabledRegions = [], assetOrigin, mapMode = config.default_map_mode } = options;
  if (enabledRegions.length > 0 && assetOrigin) {
    return mapMode === 'satellite'
      ? createSatelliteRegionsStyle(enabledRegions, assetOrigin)
      : createStreetRegionsStyle(enabledRegions, assetOrigin);
  }

  if (config.map_style_url) {
    return config.map_style_url;
  }

  return createFallbackMapStyle(config);
}

function createStreetRegionsStyle(
  regions: OfflineRegionManifest[],
  assetOrigin: string
): StyleSpecification {
  const sources: NonNullable<StyleSpecification['sources']> = {};
  const styleLayers: NonNullable<StyleSpecification['layers']> = [buildBackgroundLayer()];

  for (const region of regions) {
    const sourceKey = `offline-street-${sanitizeRegionId(region.id)}`;

    if (region.street_source_type === 'image' && region.street_image) {
      sources[sourceKey] = buildImageSource(region, assetOrigin, region.street_image);
      styleLayers.push({
        id: `${sourceKey}-image`,
        type: 'raster',
        source: sourceKey,
        paint: {
          'raster-saturation': -0.18,
          'raster-contrast': 0.16,
          'raster-brightness-min': 0.04,
          'raster-brightness-max': 0.9
        }
      });
      continue;
    }

    if (region.street_source_type === 'raster') {
      sources[sourceKey] = {
        type: 'raster',
        url: buildPmtilesUrl(assetOrigin, region.id, region.street_pmtiles),
        tileSize: 512,
        attribution: region.imagery_attribution || 'Offline street basemap'
      };
      styleLayers.push({
        id: `${sourceKey}-raster`,
        type: 'raster',
        source: sourceKey,
        minzoom: 0,
        maxzoom: 22,
        paint: {
          'raster-saturation': -0.18,
          'raster-contrast': 0.16,
          'raster-brightness-min': 0.04,
          'raster-brightness-max': 0.9
        }
      });
      continue;
    }

    sources[sourceKey] = {
      type: 'vector',
      url: buildPmtilesUrl(assetOrigin, region.id, region.street_pmtiles),
      attribution: region.imagery_attribution || 'OpenStreetMap basemap'
    };
    styleLayers.push(
      ...layers(sourceKey, namedFlavor('black')).map((layer) => ({
        ...layer,
        id: `${sourceKey}-${layer.id}`
      }))
    );
  }

  return {
    version: 8,
    sources,
    layers: styleLayers
  };
}

function createSatelliteRegionsStyle(
  regions: OfflineRegionManifest[],
  assetOrigin: string
): StyleSpecification {
  const sources: NonNullable<StyleSpecification['sources']> = {};
  const styleLayers: NonNullable<StyleSpecification['layers']> = [buildBackgroundLayer()];

  for (const region of regions) {
    const sourceKey = `offline-satellite-${sanitizeRegionId(region.id)}`;
    if (region.satellite_image) {
      sources[sourceKey] = buildImageSource(region, assetOrigin, region.satellite_image);
      styleLayers.push({
        id: `${sourceKey}-image`,
        type: 'raster',
        source: sourceKey,
        paint: {
          'raster-saturation': -0.12,
          'raster-contrast': 0.18,
          'raster-brightness-min': 0.08,
          'raster-brightness-max': 0.82
        }
      });
      continue;
    }

    sources[sourceKey] = {
      type: 'raster',
      url: buildPmtilesUrl(assetOrigin, region.id, region.satellite_pmtiles),
      tileSize: 512,
      attribution: region.imagery_attribution || 'Offline satellite imagery'
    };
    styleLayers.push({
      id: `${sourceKey}-raster`,
      type: 'raster',
      source: sourceKey,
      minzoom: 0,
      maxzoom: 22,
      paint: {
        'raster-saturation': -0.12,
        'raster-contrast': 0.18,
        'raster-brightness-min': 0.08,
        'raster-brightness-max': 0.82
      }
    });
  }

  return {
    version: 8,
    sources,
    layers: styleLayers
  };
}

function buildImageSource(
  region: OfflineRegionManifest,
  assetOrigin: string,
  relativePath: string
) {
  const [west, south, east, north] = region.bounds;
  return {
    type: 'image' as const,
    url: buildAssetUrl(assetOrigin, region.id, relativePath),
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south]
    ] as [[number, number], [number, number], [number, number], [number, number]]
  };
}

function createFallbackMapStyle(config: AppConfig): StyleSpecification {
  const baseLayers: StyleSpecification['layers'] = [
    {
      id: 'background',
      type: 'background',
      paint: {
        'background-color': '#050505'
      }
    }
  ];

  if (config.map_tile_template) {
    return {
      version: 8,
      sources: {
        'offline-raster': {
          type: 'raster',
          tiles: [config.map_tile_template],
          tileSize: 256,
          attribution: 'Offline tile pack'
        }
      },
      layers: [
        ...baseLayers,
        {
          id: 'offline-raster',
          type: 'raster',
          source: 'offline-raster',
          minzoom: 0,
          maxzoom: 18,
          paint: {
            'raster-saturation': -1,
            'raster-contrast': 0.12,
            'raster-brightness-min': 0.12,
            'raster-brightness-max': 0.88
          }
        }
      ]
    };
  }

  return {
    version: 8,
    sources: {},
    layers: baseLayers
  };
}

function buildBackgroundLayer(): NonNullable<StyleSpecification['layers']>[number] {
  return {
    id: 'background',
    type: 'background',
    paint: {
      'background-color': '#020202'
    }
  };
}

function sanitizeRegionId(regionId: string) {
  return regionId.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function buildPmtilesUrl(assetOrigin: string, regionId: string, relativePath: string) {
  return `pmtiles://${buildAssetUrl(assetOrigin, regionId, relativePath)}`;
}

function buildAssetUrl(assetOrigin: string, regionId: string, relativePath: string) {
  const normalizedOrigin = assetOrigin.replace(/\/+$/, '');
  const encodedRegion = encodeURIComponent(regionId);
  const encodedPath = relativePath
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `${normalizedOrigin}/regions/${encodedRegion}/${encodedPath}`;
}
