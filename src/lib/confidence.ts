export function confidenceTone(confidence: number) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(confidence) ? confidence : 0));
  const normalized = Math.max(0, Math.min(1, (clamped - 0.6) / 0.4));
  const hue = 16 + normalized * 114;
  const color = `hsl(${hue.toFixed(0)} 82% 62%)`;
  const background = `hsla(${hue.toFixed(0)} 88% 56% / 0.14)`;
  const border = `hsla(${hue.toFixed(0)} 90% 68% / 0.58)`;
  return { color, background, border };
}
