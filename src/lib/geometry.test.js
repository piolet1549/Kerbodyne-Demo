import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_RENDERED_TRACK_SOURCE_POINTS,
  buildTrackGeoJson
} from './geometry.js';

function makeTrack(count, gapAfter = null) {
  let elapsedSeconds = 0;
  return Array.from({ length: count }, (_, index) => {
    if (gapAfter != null && index === gapAfter + 1) {
      elapsedSeconds += 20;
    }
    const point = {
      lat: 38.5 + Math.sin(index / 25) * 0.001 + index * 0.000001,
      lon: -121.5 + index * 0.000002,
      recorded_at: new Date(elapsedSeconds * 1000).toISOString()
    };
    elapsedSeconds += 0.1;
    return point;
  });
}

test('long flight paths use bounded render geometry without losing endpoints', () => {
  const track = makeTrack(20_000);
  const result = buildTrackGeoJson(track, 10);
  assert.equal(result.features.length, 1);
  const coordinates = result.features[0].geometry.coordinates;
  assert.ok(coordinates.length <= MAX_RENDERED_TRACK_SOURCE_POINTS * 2);
  assert.deepEqual(coordinates[0], [track[0].lon, track[0].lat]);
  assert.deepEqual(coordinates.at(-1), [track.at(-1).lon, track.at(-1).lat]);
});

test('render reduction preserves stale-link gap segments', () => {
  const track = makeTrack(10_000, 4999);
  const result = buildTrackGeoJson(track, 10);
  assert.deepEqual(result.features.map((feature) => feature.properties.kind), [
    'segment',
    'gap',
    'segment'
  ]);
  assert.deepEqual(result.features[1].geometry.coordinates, [
    [track[4999].lon, track[4999].lat],
    [track[5000].lon, track[5000].lat]
  ]);
  const renderedSegmentPoints = result.features
    .filter((feature) => feature.properties.kind === 'segment')
    .reduce((total, feature) => total + feature.geometry.coordinates.length, 0);
  assert.ok(renderedSegmentPoints <= MAX_RENDERED_TRACK_SOURCE_POINTS * 2);
});
