// Web search for the AI without any account or key: it asks DuckDuckGo's plain HTML page and
// reads the first results (title, address, short text). What comes back is information for the
// bot to use, never instructions, and it is cut down before the AI sees it.

import { htmlToText } from '@familiai/core';

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

const decode = (s: string) => htmlToText(s, 300).replace(/\s+/g, ' ').trim();

/** DuckDuckGo wraps each result in a redirect link; this finds the real address inside it. */
function realUrl(href: string): string | null {
  try {
    const u = new URL(href.startsWith('//') ? `https:${href}` : href, 'https://duckduckgo.com');
    const target = u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/') ? u.searchParams.get('uddg') : u.href;
    if (!target) return null;
    const t = new URL(target);
    return t.protocol === 'https:' || t.protocol === 'http:' ? t.href : null;
  } catch {
    return null;
  }
}

export function parseResults(html: string, max = 5): SearchHit[] {
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a[^>]+class="[^"]*result__a|$)/g;
  for (let m = re.exec(html); m && hits.length < max; m = re.exec(html)) {
    const url = realUrl(m[1]!.replace(/&amp;/g, '&'));
    if (!url || /duckduckgo\.com\/y\.js/.test(url)) continue; // adverts
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/.exec(m[3]!);
    hits.push({ title: decode(m[2]!), url, snippet: snip ? decode(snip[1]!) : '' });
  }
  return hits;
}

/** Wikipedia's own search API: official and stable, so it is the fallback when a page-scraping engine says no. */
export function parseWikipedia(json: unknown, max = 5): SearchHit[] {
  const list = (json as { query?: { search?: Array<{ title?: string; snippet?: string }> } })?.query?.search ?? [];
  return list.filter((r) => r.title).slice(0, max).map((r) => ({
    title: r.title!,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(r.title!.replace(/ /g, '_'))}`,
    snippet: decode(r.snippet ?? ''),
  }));
}

export async function webSearch(query: string, opts: { fetchImpl?: typeof fetch; max?: number } = {}): Promise<SearchHit[]> {
  const q = query.trim().slice(0, 200);
  if (!q) throw new Error('Tell me what to search for.');
  const f = opts.fetchImpl ?? fetch;
  const max = opts.max ?? 5;
  let reached = false;

  try {
    const res = await f(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Montex)', accept: 'text/html' }, signal: AbortSignal.timeout(15_000) });
    reached = true;
    if (res.ok) {
      const hits = parseResults((await res.text()).slice(0, 600_000), max);
      if (hits.length) return hits;
    }
  } catch {
    // fall through to the next engine
  }
  try {
    const res = await f(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&srlimit=${max}&format=json&utf8=1`, { headers: { 'user-agent': 'Montex/0.3 (family desktop bot)' }, signal: AbortSignal.timeout(15_000) });
    reached = true;
    if (res.ok) {
      const hits = parseWikipedia(await res.json().catch(() => null), max);
      if (hits.length) return hits;
    }
  } catch {
    // reported below
  }
  throw new Error(reached
    ? 'The search engines would not give me results just now (they sometimes ask for a human check). Try again later, or say "open google.com" and search there.'
    : 'I could not reach a search engine. Check your internet connection.');
}
