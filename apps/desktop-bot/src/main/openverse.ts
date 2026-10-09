// Image search on Openverse (free-license images). Pure functions, so they are easy to test.

import type { ImageResult } from '../shared/api';

const ENDPOINT = 'https://api.openverse.org/v1/images/';

export function cleanQuery(raw: string): string | null {
  const q = raw.replace(/\s+/g, ' ').trim();
  if (q.length < 2 || q.length > 80) return null;
  return q;
}

export function buildSearchUrl(query: string, pageSize = 12): string {
  const params = new URLSearchParams({
    q: query,
    page_size: String(pageSize),
    mature: 'false', // keep results family-safe
    filter_dead: 'true',
  });
  return `${ENDPOINT}?${params.toString()}`;
}

interface RawResult {
  id?: unknown;
  title?: unknown;
  thumbnail?: unknown;
  license?: unknown;
  license_version?: unknown;
  license_url?: unknown;
  creator?: unknown;
  foreign_landing_url?: unknown;
  mature?: unknown;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

export function parseResults(json: unknown): ImageResult[] {
  const results = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const out: ImageResult[] = [];
  for (const r of results as RawResult[]) {
    const id = str(r.id);
    const thumbnail = str(r.thumbnail);
    if (!id || !thumbnail || r.mature === true) continue;
    const license = str(r.license);
    if (!license) continue; // never show an image without a known license
    const version = str(r.license_version);
    out.push({
      id,
      title: str(r.title) ?? 'Untitled',
      thumbnail,
      license: `CC ${license.toUpperCase()}${version ? ' ' + version : ''}`,
      licenseUrl: str(r.license_url),
      creator: str(r.creator),
      pageUrl: str(r.foreign_landing_url),
    });
  }
  return out;
}

export async function searchImages(
  query: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ImageResult[]> {
  const res = await fetchImpl(buildSearchUrl(query), {
    headers: { 'User-Agent': 'FamilyAI-DesktopBot/0.1', Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Image search failed (${res.status}). Try again in a moment.`);
  return parseResults(await res.json());
}
