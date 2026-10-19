import { describe, expect, it } from 'vitest';
import { Gmail } from '../src/main/email/gmail';
import { emailTools } from '../src/main/email/tools';
import { parseResults, parseWikipedia, webSearch } from '../src/main/desktop/search';
import { checkArgs, examplesFor, keepKnown, pickTools } from '../src/main/agent/toolpick';
import type { InputSchema } from '../src/main/agent/types';

const resultsHtml = `
<div class="result"><h2><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpasta&amp;rut=x">Best <b>Pasta</b> Recipes</a></h2>
<a class="result__snippet" href="x">Boil water, add salt &amp; pasta.</a></div>
<div class="result"><a class="result__a" href="//duckduckgo.com/y.js?ad=1">Advert</a><a class="result__snippet">buy now</a></div>
<div class="result"><a class="result__a" href="https://other.org/page">Other page</a><a class="result__snippet">Second hit</a></div>`;

describe('web search', () => {
  it('reads real addresses, skips adverts', () => {
    const hits = parseResults(resultsHtml);
    expect(hits.map((h) => h.url)).toEqual(['https://example.com/pasta', 'https://other.org/page']);
    expect(hits[0]).toMatchObject({ title: 'Best Pasta Recipes', snippet: 'Boil water, add salt & pasta.' });
  });
});

describe('web search fallback', () => {
  it('uses Wikipedia when the first engine blocks, and says so plainly when all fail', async () => {
    const wiki = { query: { search: [{ title: 'Pasta salad', snippet: 'A <span>cold</span> dish &amp; more' }] } };
    const f = (async (url: string) => String(url).includes('duckduckgo') ? new Response('<title>anomaly challenge</title>') : new Response(JSON.stringify(wiki))) as unknown as typeof fetch;
    expect(await webSearch('pasta', { fetchImpl: f })).toEqual([{ title: 'Pasta salad', url: 'https://en.wikipedia.org/wiki/Pasta_salad', snippet: 'A cold dish & more' }]);
    expect(parseWikipedia({})).toEqual([]);
    const blocked = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(webSearch('x', { fetchImpl: blocked })).rejects.toThrow(/human check/);
    const down = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(webSearch('x', { fetchImpl: down })).rejects.toThrow(/could not reach/);
  });
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
function gmailWith(fetchImpl: typeof fetch, refresh: { v?: string } = { v: 'r1' }) {
  return new Gmail({ clientId: () => 'cid', clientSecret: () => 'sec', refreshToken: () => refresh.v, saveRefreshToken: (t) => { refresh.v = t; }, openExternal: async () => {}, fetchImpl });
}
const b64 = (s: string) => Buffer.from(s).toString('base64url');

describe('gmail (read-only)', () => {
  const calls: string[] = [];
  const api = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url); calls.push(u);
    if (u.includes('oauth2.googleapis.com')) return json({ access_token: 'at', expires_in: 3600 });
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer at');
    if (u.includes('/messages?')) return json({ messages: [{ id: 'm1' }] });
    if (u.includes('format=metadata')) return json({ id: 'm1', snippet: 'Hi there', payload: { headers: [{ name: 'From', value: 'Mom <mom@x.com>' }, { name: 'Subject', value: 'Dinner' }, { name: 'Date', value: 'Mon' }] } });
    return json({ payload: { headers: [{ name: 'Subject', value: 'Dinner' }], parts: [{ mimeType: 'text/plain', body: { data: b64('See you at 7') } }] } });
  }) as typeof fetch;

  it('lists and reads mail with only the read-only permission', async () => {
    const g = gmailWith(api);
    const list = await g.check();
    expect(list).toEqual([{ id: 'm1', from: 'Mom', subject: 'Dinner', date: 'Mon', snippet: 'Hi there', unread: false, when: expect.any(String) }]);
    expect((await g.read('m1')).text).toBe('See you at 7');
    expect(calls.some((c) => /send|modify|delete/i.test(c))).toBe(false);
  });

  it('tools are read-only, adults only, and explain a missing connection', async () => {
    const tools = emailTools(gmailWith(api, {}));
    expect(tools.every((t) => t.spec.risk === 'low' && !t.roles!.includes('child'))).toBe(true);
    const r = await tools[0]!.run({}, {} as never);
    expect(r).toMatchObject({ ok: false, text: expect.stringContaining('Connect Gmail') });
  });

  it('signs in through the browser with a state check and saves only the refresh token', async () => {
    const saved: { v?: string } = {};
    let authUrl = '';
    const token = (async () => json({ refresh_token: 'RT', access_token: 'at', expires_in: 3600 })) as unknown as typeof fetch;
    const g = new Gmail({
      clientId: () => 'cid', clientSecret: () => 'sec', refreshToken: () => saved.v, saveRefreshToken: (t) => { saved.v = t; }, fetchImpl: token,
      openExternal: async (url) => {
        authUrl = url;
        const u = new URL(url);
        const back = new URL(u.searchParams.get('redirect_uri')!);
        await fetch(`${back.origin}/?state=WRONG&code=evil`); // a forged answer is refused
        await fetch(`${back.origin}/?state=${u.searchParams.get('state')}&code=good`);
      },
    });
    await g.connect();
    expect(saved.v).toBe('RT');
    expect(new URL(authUrl).searchParams.get('scope')).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(new URL(authUrl).searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('helping a small brain', () => {
  const tool = (name: string, description: string, input: InputSchema = { type: 'object', properties: {} }) => ({ name, description, input });
  const all = [
    tool('open_app', 'Open an app on this computer by name.'), tool('close_app', 'Close an app, letting it save first.'),
    tool('web_search', 'Search the web and get the top results.'), tool('check_email', 'Check Gmail.'),
    tool('screen_time', 'How much time is used and left today.'), tool('stream_chat_ban', 'Ban a chatter permanently.'),
    tool('remember', 'Save a note.'), tool('recall', 'Look up saved notes.'),
  ];
  it('offers the fitting tools first, and a safe default set otherwise', () => {
    expect(pickTools('please close discord', all)[0]!.name).toBe('close_app');
    expect(pickTools('check my gmail inbox', all)[0]!.name).toBe('check_email');
    expect(pickTools('search for pasta recipes', all)[0]!.name).toBe('web_search');
    expect(pickTools('hmm okay', all).map((t) => t.name)).toContain('open_app');
    expect(pickTools('open close search gmail', all, 2).length).toBeLessThanOrEqual(2);
    expect(examplesFor(pickTools('ban bob', all))[0]).toContain('stream_chat_ban');
  });
  it('explains wrong fields and drops invented ones', () => {
    const input: InputSchema = { type: 'object', properties: { app: { type: 'string' }, minutes: { type: 'number' }, scope: { type: 'string', enum: ['private', 'family'] } }, required: ['app'] };
    expect(checkArgs(input, {})).toContain('"app" is missing');
    expect(checkArgs(input, { app: 'x', minutes: 'ten' })).toContain('"minutes" must be a number');
    expect(checkArgs(input, { app: 'x', scope: 'world' })).toContain('one of');
    expect(checkArgs(input, { app: 'x', minutes: 5 })).toBeNull();
    expect(keepKnown(input, { app: 'x', bogus: 1 })).toEqual({ app: 'x' });
  });
});
