import i18n from '../i18n';

export function formatBytes(bytes: number | undefined | null): string {
  if (bytes == null || bytes === 0) return '0 B';
  if (bytes < 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const k = 1024;
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), units.length - 1);
  const value = bytes / Math.pow(k, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();

function getRelativeTimeFormatter(locale: string): Intl.RelativeTimeFormat {
  let rtf = relativeTimeFormatters.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    relativeTimeFormatters.set(locale, rtf);
  }
  return rtf;
}

export function formatRelativeTime(dateStr: string | undefined | null): string {
  if (!dateStr) return i18n.t('common:never');
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const rtf = getRelativeTimeFormatter(i18n.language);

  if (diffMs < 0) return rtf.format(0, 'second');
  if (diffMs < 60_000) return rtf.format(-Math.floor(diffMs / 1000), 'second');
  if (diffMs < 3_600_000) return rtf.format(-Math.floor(diffMs / 60_000), 'minute');
  if (diffMs < 86_400_000) return rtf.format(-Math.floor(diffMs / 3_600_000), 'hour');
  return rtf.format(-Math.floor(diffMs / 86_400_000), 'day');
}

export function formatDateTime(dateStr: string | undefined | null): string {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function shortImageDigest(image: string): string | undefined {
  return image
    .match(/@sha256:([a-fA-F0-9]{64})$/)?.[1]
    ?.slice(0, 6)
    .toLowerCase();
}

export function formatPercentage(used: number, total: number): string {
  if (total === 0) return '0%';
  return `${((used / total) * 100).toFixed(1)}%`;
}
