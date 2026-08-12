export function recordMuxerKeyframe(muxer, position) {
  const positions = muxer?.kfPosition;
  if (!Array.isArray(positions) || !Number.isFinite(position)) {
    return false;
  }
  if (positions[positions.length - 1] !== position) {
    positions.push(position);
  }
  return true;
}

export function pruneMuxerBuffer(muxer, currentTime, retainSeconds = 15) {
  if (!Number.isFinite(currentTime) || currentTime <= retainSeconds) {
    return false;
  }
  const controller = muxer?.bufferControllers?.video;
  if (!controller || typeof controller.initCleanup !== 'function') {
    return false;
  }
  controller.cleanOffset = retainSeconds;
  controller.initCleanup(currentTime);
  return true;
}
