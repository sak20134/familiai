// Reads a public web page for the AI, using Family AI's shared safety checks: only http(s),
// never this computer or the home network (checked again after every redirect), a size cap,
// and plain text only, so nothing on the page can run.

import { htmlTitle, htmlToText, isBlockedHost, isBlockedIp, parseHttpUrl } from '@familiai/core';
import { lookup } from 'node:dns/promises';

const MAX_BYTES = 1_000_000;
const MAX_REDIRECTS = 3;

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

export async function checkUrl(raw: string, resolve: Resolver = defaultResolver): Promise<URL> {
  const url = parseHttpUrl(raw);
  if (!url) throw new Error('That is not a web address (it should start with http:// or https://).');
  if (isBlockedHost(url.hostname)) throw new Error('I will not open addresses on this computer or your home network.');
  const ips = await resolve(url.hostname).catch(() => {
    throw new Error(`I could not find the website ${url.hostname}.`);
  });
  if (ips.length === 0 || ips.some(isBlockedIp)) throw new Error('That website points inside your home network, so I will not open it.');
  return url;
}

export async function readPage(raw: string, opts: { fetchImpl?: typeof fetch; resolve?: Resolver } = {}): Promise<{ url: string; title: string | null; text: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = await checkUrl(raw, opts.resolve);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchImpl(url, { redirect: 'manual', headers: { 'user-agent': 'FamilyAI-DesktopBot/0.2', accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(15_000) });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new Error('The website sent a broken redirect.');
      url = await checkUrl(new URL(next, url).href, opts.resolve);
      continue;
    }
    if (!res.ok) throw new Error(`The website answered with an error (${res.status}).`);
    const type = res.headers.get('content-type') ?? '';
    if (!/text\/(html|plain)|application\/xhtml/.test(type)) throw new Error('That page is not text I can read (it may be a file or a video).');
    const body = await readCapped(res);
    return { url: url.href, title: htmlTitle(body), text: htmlToText(body, 4000) };
  }
  throw new Error('The website redirected too many times.');
}

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}
