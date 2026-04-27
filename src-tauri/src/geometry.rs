const EARTH_RADIUS_M: f64 = 6_371_000.0;

fn to_radians(value: f64) -> f64 {
    value.to_radians()
}

pub fn distance_m(lat_a: f64, lon_a: f64, lat_b: f64, lon_b: f64) -> f64 {
    let delta_lat = to_radians(lat_b - lat_a);
    let delta_lon = to_radians(lon_b - lon_a);
    let lat_a = to_radians(lat_a);
    let lat_b = to_radians(lat_b);

    let sin_lat = (delta_lat / 2.0).sin();
    let sin_lon = (delta_lon / 2.0).sin();

    let a = sin_lat * sin_lat + lat_a.cos() * lat_b.cos() * sin_lon * sin_lon;
    let c = 2.0 * a.sqrt().atan2((1.0 - a).sqrt());

    EARTH_RADIUS_M * c
}

#[cfg(test)]
mod tests {
    use super::distance_m;

    #[test]
    fn distance_is_zero_for_same_point() {
        assert!(distance_m(38.575, -121.493, 38.575, -121.493) < 0.001);
    }

    #[test]
    fn distance_matches_expected_scale() {
        let distance = distance_m(38.5750, -121.4930, 38.5760, -121.4930);
        assert!(distance > 100.0);
        assert!(distance < 120.0);
    }
}
