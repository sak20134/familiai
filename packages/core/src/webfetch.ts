// Reading a web page safely. Ported from the idea behind browser-use: let the AI read a page,
// but never let it reach inside our own network. Every check here runs on the server.

/** Only real web addresses. Returns null for anything else (file://, javascript:, nonsense). */
export function parseHttpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

const BLOCKED_NAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback', 'metadata', 'metadata.google.internal']);

/** True for addresses inside our own machine or private network, which the AI must never fetch. */
export function isBlockedIp(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (addr === '' || addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd')) return true; // link-local, unique-local
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  const mapped = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const parts = mapped.split('.');
  if (parts.length !== 4) return false;
  const [a, b] = parts.map((p) => Number(p));
  if (parts.some((p) => !/^\d{1,3}$/.test(p)) || a === undefined || b === undefined || a > 255 || b > 255) return false;
  if (a === 0 || a === 127 || a === 10) return true; // this host, loopback, private
  if (a === 169 && b === 254) return true; // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

/** True when the host name itself is off limits, before any lookup. */
export function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (host === '') return true;
  if (BLOCKED_NAMES.has(host)) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) return true;
  if (!host.includes('.') && !host.includes(':')) return true; // bare names are internal
  return isBlockedIp(host);
}

const DROP_TAGS = /<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", mdash: '—', ndash: '–', hellip: '…',
};

/** Turns a page into plain readable text. No HTML survives, so nothing from a page can run. */
export function htmlToText(html: string, limit = 4000): string {
  const text = html
    .replace(DROP_TAGS, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&([a-z]+|#x?[0-9a-f]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}\n… (page continues)` : text;
}

/** The page title, when it has one. */
export function htmlTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
  if (!m?.[1]) return null;
  const t = htmlToText(m[1], 200);
  return t.length > 0 ? t : null;
}
