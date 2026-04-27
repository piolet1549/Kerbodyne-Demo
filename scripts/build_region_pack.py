import argparse
import json
import math
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import rasterio
import requests
from PIL import Image, ImageEnhance, ImageOps
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds


USER_AGENT = "Kerbodyne Ground Station Prototype"
STREET_BASE_SERVICE = (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer"
)
SATELLITE_SERVICE = (
    "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer"
)
HENNEPIN_2025_SATELLITE_SERVICE = (
    "https://gis.hennepin.us/arcgis/rest/services/Maps/UTM_CACHE_AERIAL/MapServer"
)
USGS_NAIP_PLUS_IMAGE_SERVICE = (
    "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer"
)
WEB_MERCATOR_WKID = 3857
WEB_MERCATOR_CRS = "EPSG:3857"
WEB_MERCATOR_LAT_LIMIT = 85.05112878
WEB_MERCATOR_HALF = 20037508.34
WEB_MERCATOR_SPAN = WEB_MERCATOR_HALF * 2
TILE_SIZE = 256


def parse_args():
    parser = argparse.ArgumentParser(description="Build a Kerbodyne offline region pack.")
    parser.add_argument("--id", required=True, help="Region id / folder name")
    parser.add_argument("--name", required=True, help="Region display name")
    parser.add_argument("--min-lat", type=float, required=True)
    parser.add_argument("--min-lon", type=float, required=True)
    parser.add_argument("--max-lat", type=float, required=True)
    parser.add_argument("--max-lon", type=float, required=True)
    parser.add_argument("--buffer-m", type=float, default=400.0)
    parser.add_argument("--image-size", type=int, default=8192)
    parser.add_argument("--output-root", required=True)
    parser.add_argument("--satellite-service", default=SATELLITE_SERVICE)
    parser.add_argument("--activate-db", help="Optional path to kerbodyne.db")
    return parser.parse_args()


def buffered_bounds(min_lat, min_lon, max_lat, max_lon, buffer_m):
    center_lat = (min_lat + max_lat) / 2
    lat_buf = buffer_m / 111_320
    lon_buf = buffer_m / (111_320 * math.cos(math.radians(center_lat)))
    return (
        min_lat - lat_buf,
        min_lon - lon_buf,
        max_lat + lat_buf,
        max_lon + lon_buf,
    )


def lat_lon_to_web_mercator(lat, lon):
    clamped_lat = max(min(lat, WEB_MERCATOR_LAT_LIMIT), -WEB_MERCATOR_LAT_LIMIT)
    x = lon * 20037508.34 / 180.0
    y = math.log(math.tan((90.0 + clamped_lat) * math.pi / 360.0)) / (math.pi / 180.0)
    y = y * 20037508.34 / 180.0
    return x, y


def mercator_bounds_from_wgs84(min_lat, min_lon, max_lat, max_lon):
    min_x, min_y = lat_lon_to_web_mercator(min_lat, min_lon)
    max_x, max_y = lat_lon_to_web_mercator(max_lat, max_lon)
    return min_x, min_y, max_x, max_y


def dimensions_for_bounds(mercator_bounds, max_dimension):
    min_x, min_y, max_x, max_y = mercator_bounds
    width_m = max(max_x - min_x, 1.0)
    height_m = max(max_y - min_y, 1.0)

    if width_m >= height_m:
        width = max_dimension
        height = max(1, round(max_dimension * (height_m / width_m)))
    else:
        height = max_dimension
        width = max(1, round(max_dimension * (width_m / height_m)))

    return width, height


def candidate_export_dimensions(mercator_bounds, image_size):
    for max_dimension in [image_size, 3072, 2560, 2048, 1536, 1280, 1024]:
        if max_dimension > image_size:
            continue
        yield dimensions_for_bounds(mercator_bounds, max_dimension)


def mercator_to_tile_x(x, zoom):
    return ((x + WEB_MERCATOR_HALF) / WEB_MERCATOR_SPAN) * (2**zoom)


def mercator_to_tile_y(y, zoom):
    return ((WEB_MERCATOR_HALF - y) / WEB_MERCATOR_SPAN) * (2**zoom)


def choose_tile_zoom(mercator_bounds, image_size, min_zoom=14, max_zoom=19):
    min_x, min_y, max_x, max_y = mercator_bounds

    for zoom in range(max_zoom, min_zoom - 1, -1):
        width_px = (mercator_to_tile_x(max_x, zoom) - mercator_to_tile_x(min_x, zoom)) * TILE_SIZE
        height_px = (mercator_to_tile_y(min_y, zoom) - mercator_to_tile_y(max_y, zoom)) * TILE_SIZE
        if max(width_px, height_px) <= image_size:
            return zoom

    return min_zoom


def fetch_tile_image(service_root, zoom, row, column, session):
    url = f"{service_root}/tile/{zoom}/{row}/{column}"
    response = session.get(
        url,
        timeout=(30, 180),
        headers={"User-Agent": USER_AGENT},
    )
    response.raise_for_status()
    return Image.open(io_from_bytes(response.content))


def fetch_mapserver_metadata(service_root, session):
    response = session.get(
        service_root,
        params={"f": "json"},
        timeout=(30, 120),
        headers={"User-Agent": USER_AGENT},
    )
    response.raise_for_status()
    metadata = response.json()
    if "error" in metadata:
        raise RuntimeError(f"MapServer metadata error for {service_root}: {metadata['error']}")
    return metadata


def service_export_path(service_root):
    normalized = service_root.rstrip("/")
    if normalized.endswith("ImageServer"):
        return f"{normalized}/exportImage"
    return f"{normalized}/export"


def fetch_cached_tile_mosaic(
    service_root,
    mercator_bounds,
    image_size,
    session,
    transparent=False,
):
    min_x, min_y, max_x, max_y = mercator_bounds
    zoom = choose_tile_zoom(mercator_bounds, image_size)
    left_tile = mercator_to_tile_x(min_x, zoom)
    right_tile = mercator_to_tile_x(max_x, zoom)
    top_tile = mercator_to_tile_y(max_y, zoom)
    bottom_tile = mercator_to_tile_y(min_y, zoom)

    tile_x_min = math.floor(left_tile)
    tile_x_max = math.ceil(right_tile) - 1
    tile_y_min = math.floor(top_tile)
    tile_y_max = math.ceil(bottom_tile) - 1

    columns = tile_x_max - tile_x_min + 1
    rows = tile_y_max - tile_y_min + 1
    mode = "RGBA" if transparent else "RGB"
    composite = Image.new(mode, (columns * TILE_SIZE, rows * TILE_SIZE))

    for row in range(tile_y_min, tile_y_max + 1):
        for column in range(tile_x_min, tile_x_max + 1):
            tile = fetch_tile_image(service_root, zoom, row, column, session).convert(mode)
            composite.paste(
                tile,
                ((column - tile_x_min) * TILE_SIZE, (row - tile_y_min) * TILE_SIZE),
                tile if transparent else None,
            )

    crop_left = round((left_tile - tile_x_min) * TILE_SIZE)
    crop_top = round((top_tile - tile_y_min) * TILE_SIZE)
    crop_right = round((right_tile - tile_x_min) * TILE_SIZE)
    crop_bottom = round((bottom_tile - tile_y_min) * TILE_SIZE)
    cropped = composite.crop((crop_left, crop_top, crop_right, crop_bottom))

    return cropped, mercator_bounds


def fetch_cached_mapserver_mosaic(
    service_root,
    bounds_wgs84,
    image_size,
    session,
    transparent=False,
):
    metadata = fetch_mapserver_metadata(service_root, session)
    tile_info = metadata.get("tileInfo") or {}
    origin = tile_info.get("origin") or {}
    lods = tile_info.get("lods") or []
    cols = tile_info.get("cols") or TILE_SIZE
    rows = tile_info.get("rows") or TILE_SIZE
    spatial_reference = metadata.get("spatialReference") or {}
    wkid = spatial_reference.get("latestWkid") or spatial_reference.get("wkid")
    if not wkid or not lods:
        raise RuntimeError(f"{service_root} does not expose cached tile metadata.")

    service_crs = f"EPSG:{wkid}"
    min_lat, min_lon, max_lat, max_lon = bounds_wgs84
    min_x, min_y, max_x, max_y = transform_bounds(
        "EPSG:4326",
        service_crs,
        min_lon,
        min_lat,
        max_lon,
        max_lat,
        densify_pts=21,
    )

    width_m = max(max_x - min_x, 1.0)
    height_m = max(max_y - min_y, 1.0)
    selected_lod = lods[-1]
    for lod in reversed(lods):
        width_px = width_m / lod["resolution"]
        height_px = height_m / lod["resolution"]
        if max(width_px, height_px) <= image_size:
            selected_lod = lod
            break

    resolution = selected_lod["resolution"]
    level = selected_lod["level"]
    origin_x = origin["x"]
    origin_y = origin["y"]
    left_tile = (min_x - origin_x) / (resolution * cols)
    right_tile = (max_x - origin_x) / (resolution * cols)
    top_tile = (origin_y - max_y) / (resolution * rows)
    bottom_tile = (origin_y - min_y) / (resolution * rows)

    tile_x_min = math.floor(left_tile)
    tile_x_max = math.ceil(right_tile) - 1
    tile_y_min = math.floor(top_tile)
    tile_y_max = math.ceil(bottom_tile) - 1

    columns = tile_x_max - tile_x_min + 1
    tile_rows = tile_y_max - tile_y_min + 1
    mode = "RGBA" if transparent else "RGB"
    composite = Image.new(mode, (columns * cols, tile_rows * rows))

    for row in range(tile_y_min, tile_y_max + 1):
        for column in range(tile_x_min, tile_x_max + 1):
            tile = fetch_tile_image(service_root, level, row, column, session).convert(mode)
            composite.paste(
                tile,
                ((column - tile_x_min) * cols, (row - tile_y_min) * rows),
                tile if transparent else None,
            )

    crop_left = round((left_tile - tile_x_min) * cols)
    crop_top = round((top_tile - tile_y_min) * rows)
    crop_right = round((right_tile - tile_x_min) * cols)
    crop_bottom = round((bottom_tile - tile_y_min) * rows)
    cropped = composite.crop((crop_left, crop_top, crop_right, crop_bottom))

    return cropped, (min_x, min_y, max_x, max_y), service_crs


def try_export_image(
    service_root,
    mercator_bounds,
    width,
    height,
    session,
    image_format="png",
    transparent=False,
):
    url = service_export_path(service_root)
    min_x, min_y, max_x, max_y = mercator_bounds
    last_error = None
    seen_sizes = set()

    for scale in [1.0, 0.9, 0.8, 0.7, 0.6, 0.5]:
        candidate_width = max(1, round(width * scale))
        candidate_height = max(1, round(height * scale))
        if (candidate_width, candidate_height) in seen_sizes:
            continue
        seen_sizes.add((candidate_width, candidate_height))

        params = {
            "bbox": f"{min_x},{min_y},{max_x},{max_y}",
            "bboxSR": WEB_MERCATOR_WKID,
            "imageSR": WEB_MERCATOR_WKID,
            "size": f"{candidate_width},{candidate_height}",
            "format": image_format,
            "transparent": "true" if transparent else "false",
            "f": "image",
        }
        try:
            response = session.get(
                url,
                params=params,
                timeout=(30, 300),
                headers={"User-Agent": USER_AGENT},
            )
            response.raise_for_status()
            image = Image.open(io_from_bytes(response.content))
            if image.size != (width, height):
                image = image.resize((width, height), Image.Resampling.LANCZOS)
            return image
        except requests.RequestException as error:
            last_error = error

    raise last_error or RuntimeError(f"Unable to export image from {service_root}")


def fetch_export_image(
    service_root,
    mercator_bounds,
    image_size,
    session,
    image_format="png",
    transparent=False,
    max_tile_dimension=2048,
):
    total_width, total_height = dimensions_for_bounds(mercator_bounds, image_size)
    columns = max(1, math.ceil(total_width / max_tile_dimension))
    rows = max(1, math.ceil(total_height / max_tile_dimension))
    mode = "RGBA" if transparent else "RGB"
    composite = Image.new(mode, (total_width, total_height))
    min_x, min_y, max_x, max_y = mercator_bounds
    span_x = max_x - min_x
    span_y = max_y - min_y

    for row in range(rows):
        top = round(total_height * row / rows)
        bottom = round(total_height * (row + 1) / rows)
        tile_height = max(1, bottom - top)

        for column in range(columns):
            left = round(total_width * column / columns)
            right = round(total_width * (column + 1) / columns)
            tile_width = max(1, right - left)

            tile_min_x = min_x + span_x * (left / total_width)
            tile_max_x = min_x + span_x * (right / total_width)
            tile_max_y = max_y - span_y * (top / total_height)
            tile_min_y = max_y - span_y * (bottom / total_height)

            tile_image = try_export_image(
                service_root,
                (tile_min_x, tile_min_y, tile_max_x, tile_max_y),
                tile_width,
                tile_height,
                session,
                image_format=image_format,
                transparent=transparent,
            )

            tile_image = tile_image.convert(mode)
            if transparent:
                composite.alpha_composite(tile_image, (left, top))
            else:
                composite.paste(tile_image, (left, top))

    return composite, mercator_bounds


def io_from_bytes(payload):
    from io import BytesIO

    return BytesIO(payload)


def style_street_image(image):
    image = image.convert("RGB")
    muted = ImageEnhance.Color(image).enhance(0.08)
    muted = ImageEnhance.Contrast(muted).enhance(1.08)
    muted = ImageEnhance.Sharpness(muted).enhance(1.16)
    gray = ImageOps.autocontrast(ImageOps.grayscale(muted), cutoff=1)
    gray = ImageEnhance.Contrast(gray).enhance(1.26)
    styled = ImageOps.colorize(
        gray,
        black="#06080b",
        mid="#46515d",
        white="#f3f5f8",
    ).convert("RGB")
    return Image.blend(muted, styled, 0.84)


def style_satellite_image(image):
    image = ImageEnhance.Contrast(image).enhance(1.12)
    image = ImageEnhance.Sharpness(image).enhance(1.18)
    return image.convert("RGB")


def write_geotiff(path, image, bounds, crs):
    width, height = image.size
    data = np.array(image)
    with rasterio.open(
        path,
        "w",
        driver="GTiff",
        width=width,
        height=height,
        count=3,
        dtype=data.dtype,
        crs=crs,
        transform=from_bounds(*bounds, width=width, height=height),
        compress="lzw",
    ) as dataset:
        dataset.write(data[:, :, 0], 1)
        dataset.write(data[:, :, 1], 2)
        dataset.write(data[:, :, 2], 3)


def build_pmtiles(input_tif, output_pmtiles, name, description, attribution):
    command = [
        "rio",
        "pmtiles",
        str(input_tif),
        str(output_pmtiles),
        "--baselayer",
        "--format",
        "JPEG",
        "--tile-size",
        "512",
        "--name",
        name,
        "--description",
        description,
        "--attribution",
        attribution,
        "--silent",
    ]
    subprocess.run(command, check=True)


def write_manifest(path, region_id, name, bounds_wgs84):
    write_manifest_with_attribution(
        path,
        region_id,
        name,
        bounds_wgs84,
        "Esri World Street Map (dark styled), Esri World Imagery",
    )


def write_manifest_with_attribution(path, region_id, name, bounds_wgs84, imagery_attribution):
    min_lat, min_lon, max_lat, max_lon = bounds_wgs84
    manifest = {
        "id": region_id,
        "name": name,
        "bounds": [min_lon, min_lat, max_lon, max_lat],
        "center": [(min_lon + max_lon) / 2, (min_lat + max_lat) / 2],
        "street_pmtiles": "street.pmtiles",
        "street_source_type": "image",
        "street_image": "street.png",
        "satellite_pmtiles": "satellite.pmtiles",
        "satellite_image": "satellite.png",
        "imagery_attribution": imagery_attribution,
        "imagery_capture_date": None,
    }
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def activate_region(db_path, output_root, region_id):
    connection = sqlite3.connect(db_path)
    cursor = connection.cursor()
    row = cursor.execute(
        "select value from app_meta where key='config'"
    ).fetchone()
    if not row:
        raise RuntimeError("No app config row found in kerbodyne.db")

    config = json.loads(row[0])
    config["offline_maps_root"] = str(Path(output_root))
    enabled_region_ids = config.get("enabled_region_ids") or []
    if region_id not in enabled_region_ids:
        enabled_region_ids.append(region_id)
    config["enabled_region_ids"] = enabled_region_ids
    config["selected_region_id"] = region_id
    cursor.execute(
        "insert into app_meta (key, value) values ('config', ?) "
        "on conflict(key) do update set value=excluded.value",
        (json.dumps(config),),
    )
    connection.commit()
    connection.close()


def main():
    args = parse_args()
    min_lat, min_lon, max_lat, max_lon = buffered_bounds(
        args.min_lat,
        args.min_lon,
        args.max_lat,
        args.max_lon,
        args.buffer_m,
    )
    mercator_bounds = mercator_bounds_from_wgs84(min_lat, min_lon, max_lat, max_lon)

    output_root = Path(args.output_root)
    region_dir = output_root / args.id
    output_root.mkdir(parents=True, exist_ok=True)
    if region_dir.exists():
        shutil.rmtree(region_dir)
    region_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix=f"{args.id}-") as temp_dir_raw:
        temp_dir = Path(temp_dir_raw)
        with requests.Session() as session:
            satellite_crs = WEB_MERCATOR_CRS
            satellite_attribution = "Esri World Imagery"
            if args.satellite_service == HENNEPIN_2025_SATELLITE_SERVICE:
                satellite_image, satellite_bounds, satellite_crs = fetch_cached_mapserver_mosaic(
                    args.satellite_service,
                    (min_lat, min_lon, max_lat, max_lon),
                    args.image_size,
                    session,
                )
                satellite_attribution = "Hennepin County Nearmap Spring 2025"
            else:
                if args.satellite_service == USGS_NAIP_PLUS_IMAGE_SERVICE:
                    satellite_attribution = "USGS NAIP Plus"
                satellite_image, satellite_bounds = fetch_export_image(
                    args.satellite_service,
                    mercator_bounds,
                    args.image_size,
                    session,
                    image_format="jpgpng",
                    max_tile_dimension=2048,
                )
            street_base_image, street_bounds = fetch_cached_tile_mosaic(
                STREET_BASE_SERVICE,
                mercator_bounds,
                args.image_size,
                session,
            )
            street_source_image = street_base_image.convert("RGB")

        street_image = style_street_image(street_source_image)
        satellite_image = style_satellite_image(satellite_image)
        street_tif = temp_dir / "street.tif"
        satellite_tif = temp_dir / "satellite.tif"
        street_image.save(region_dir / "street.png", format="PNG")
        satellite_image.save(region_dir / "satellite.png", format="PNG")
        write_geotiff(street_tif, street_image, street_bounds, WEB_MERCATOR_CRS)
        write_geotiff(satellite_tif, satellite_image, satellite_bounds, satellite_crs)

        build_pmtiles(
            street_tif,
            region_dir / "street.pmtiles",
            args.name,
            f"{args.name} street basemap",
            "Esri World Street Map (dark styled)",
        )
        build_pmtiles(
            satellite_tif,
            region_dir / "satellite.pmtiles",
            args.name,
            f"{args.name} satellite imagery",
            satellite_attribution,
        )

    write_manifest_with_attribution(
        region_dir / "manifest.json",
        args.id,
        args.name,
        (min_lat, min_lon, max_lat, max_lon),
        f"Esri World Street Map (dark styled), {satellite_attribution}",
    )

    if args.activate_db:
        activate_region(args.activate_db, output_root, args.id)

    print(f"Region pack created at {region_dir}")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Failed to build region pack: {error}", file=sys.stderr)
        sys.exit(1)
