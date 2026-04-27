export function formatTimestamp(value?: string | null, includeSeconds = true): string {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const options: Intl.DateTimeFormatOptions = {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  };
  if (includeSeconds) {
    options.second = '2-digit';
  }
  return new Intl.DateTimeFormat(undefined, options)
    .format(date)
    .replace(/\s([AP]M)$/i, '$1');
}

export function formatDuration(totalSeconds?: number | null): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '--';
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, '0'))
    .join(':');
}

export function formatAge(value?: string | null): string {
  if (!value) return 'Unknown';
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return 'Unknown';
  const deltaMs = Date.now() - date;
  if (deltaMs < 2000) return 'Live';
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
