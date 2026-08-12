import assert from 'node:assert/strict';
import test from 'node:test';
import { pruneMuxerBuffer, recordMuxerKeyframe } from './live-video-buffer.js';

test('records missing JMuxer keyframe positions without duplicates', () => {
  const muxer = { kfPosition: [] };
  assert.equal(recordMuxerKeyframe(muxer, 1000), true);
  assert.equal(recordMuxerKeyframe(muxer, 1000), true);
  assert.equal(recordMuxerKeyframe(muxer, 2000), true);
  assert.deepEqual(muxer.kfPosition, [1000, 2000]);
});

test('prunes the live MSE buffer while preserving the configured tail', () => {
  const calls = [];
  const video = {
    cleanOffset: 30,
    initCleanup: (currentTime) => calls.push(currentTime)
  };
  const muxer = { bufferControllers: { video } };
  assert.equal(pruneMuxerBuffer(muxer, 10, 15), false);
  assert.equal(pruneMuxerBuffer(muxer, 45, 15), true);
  assert.equal(video.cleanOffset, 15);
  assert.deepEqual(calls, [45]);
});
