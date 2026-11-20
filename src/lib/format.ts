export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i === 0 ? 0 : decimals)} ${units[i]}`;
}

export function formatTimestamp(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const normalized = isoOrSql.includes('T') ? isoOrSql : `${isoOrSql.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return isoOrSql;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatRelativePercent(used: number, quota: number): number {
  if (!quota || quota <= 0) return 0;
  return Math.min(100, Math.round((used / quota) * 100));
}

export function humanizeFileStatus(status: string): string {
  switch (status) {
    case 'RECEIVING':
      return 'Uploading';
    case 'STAGED':
      return 'Staged';
    case 'QUEUED':
      return 'Queued';
    case 'UPLOADING':
      return 'Syncing';
    case 'VERIFYING':
      return 'Verifying';
    case 'SYNCED':
      return 'In Cloud';
    case 'FAILED':
      return 'Failed';
    default:
      return status;
  }
}

export function isPreviewableMime(mimeType: string): 'image' | 'text' | 'pdf' | 'video' | 'audio' | null {
  const m = mimeType.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (
    m.startsWith('text/') ||
    m.includes('json') ||
    m.includes('xml') ||
    m.includes('yaml') ||
    m.includes('javascript') ||
    m.includes('typescript')
  ) {
    return 'text';
  }
  return null;
}
