import { describe, expect, it } from 'vitest';
import {
  ApprovalFlow,
  ConnectionRegistry,
  GoogleCalendar,
  TwilioProvider,
  WakeGate,
  ageModeFor,
  can,
  canManage,
  canRead,
  describeOutcome,
  escalationFor,
  firstPlace,
  forecastLines,
  htmlTitle,
  htmlToText,
  isBlockedHost,
  isBlockedIp,
  parseHttpUrl,
  readForecast,
  evaluate,
  lastDue,
  makeExpense,
  modeAllowed,
  modeInfo,
  moveFocus,
  needsApproval,
  resolveContact,
  stripWake,
  summarize,
  timelineKindFor,
  timelineMonths,
  toolsForMode,
  twinPrompt,
  wakePhrases,
  type Member,
  type MemoryItem,
  type ToolSpec,
} from '../src';

const m = (id: string, role: Member['role'], familyId = 'f1'): Member => ({ id, role, familyId });

describe('roles', () => {
  it('admins only control their own family', () => {
    expect(canManage(m('a', 'admin'), m('k', 'child'))).toBe(true);
    expect(canManage(m('a', 'admin'), m('k', 'child', 'f2'))).toBe(false);
  });
  it('admins cannot remove the owner or another admin, owner can remove an admin', () => {
    expect(canManage(m('a', 'admin'), m('o', 'owner'))).toBe(false);
    expect(canManage(m('a', 'admin'), m('b', 'admin'))).toBe(false);
    expect(canManage(m('o', 'owner'), m('b', 'admin'))).toBe(true);
  });
  it('children cannot approve money', () => {
    expect(can(m('k', 'child'), 'approve_money')).toBe(false);
    expect(can(m('p', 'adult'), 'approve_money')).toBe(true);
  });
  it('age modes', () => {
    expect(ageModeFor(8)).toBe('under13');
    expect(ageModeFor(15)).toBe('teen');
    expect(ageModeFor(30)).toBe('adult');
    expect(ageModeFor(70)).toBe('elder');
    expect(() => ageModeFor(-1)).toThrow();
  });
});

describe('approvals', () => {
  const none = { aiMode: false, standing: new Set<string>() };
  const aiMode = { aiMode: true, standing: new Set<string>() };
  const tool = (risk: ToolSpec['risk']): ToolSpec => ({ name: `t.${risk}`, risk, description: '' });

  it('money and high risk always need approval, even in AI Mode', () => {
    expect(needsApproval(tool('money'), aiMode)).toBe(true);
    expect(needsApproval(tool('high'), aiMode)).toBe(true);
  });
  it('low never, medium unless AI Mode', () => {
    expect(needsApproval(tool('low'), none)).toBe(false);
    expect(needsApproval(tool('medium'), none)).toBe(true);
    expect(needsApproval(tool('medium'), aiMode)).toBe(false);
  });
  it('does not run before approval and reports honestly when verification fails', async () => {
    const flow = new ApprovalFlow();
    const req = flow.propose(tool('medium'), { x: 1 }, 'u1');
    await expect(flow.run(req.id, async () => 1, async () => true)).rejects.toThrow();
    flow.approve(req.id, m('p', 'adult'));
    const done = await flow.run(req.id, async () => 'ok', async () => false);
    expect(done.status).toBe('failed');
    expect(describeOutcome(done)).toContain('did not work');
  });
  it('keeps the real error when the tool throws', async () => {
    const flow = new ApprovalFlow();
    const req = flow.propose(tool('medium'), {}, 'u1');
    flow.approve(req.id, m('p', 'adult'));
    const done = await flow.run(req.id, async () => { throw new Error('boom'); }, async () => true);
    expect(done.status).toBe('failed');
    expect(done.error).toBe('boom');
  });
  it('verified only after execute and check both pass', async () => {
    const flow = new ApprovalFlow();
    const req = flow.propose(tool('medium'), {}, 'u1');
    flow.approve(req.id, m('p', 'adult'));
    const done = await flow.run(req.id, async () => 'ok', async () => true);
    expect(done.status).toBe('verified');
  });
  it('a child cannot approve a money request, and old requests expire', () => {
    let now = 0;
    const flow = new ApprovalFlow({ now: () => now, ttlMs: 1000 });
    const req = flow.propose(tool('money'), {}, 'u1');
    expect(() => flow.approve(req.id, m('k', 'child'))).toThrow();
    now = 5000;
    expect(flow.get(req.id).status).toBe('expired');
  });
});

describe('memory scopes', () => {
  const item = (over: Partial<MemoryItem>): MemoryItem => ({
    id: 'x', familyId: 'f1', ownerId: 'u1', scope: 'private', text: 't',
    sensitivity: 'normal', source: 'chat', confidence: 1, createdAt: 0, ...over,
  });
  it('private memory is owner-only, admins included', () => {
    expect(canRead(m('u1', 'adult'), item({}))).toBe(true);
    expect(canRead(m('a', 'admin'), item({}))).toBe(false);
  });
  it('never crosses families and hides expired items', () => {
    expect(canRead(m('u1', 'adult', 'f2'), item({ scope: 'family' }))).toBe(false);
    expect(canRead(m('u1', 'adult'), item({ scope: 'family', expiresAt: 5 }), 10)).toBe(false);
  });
  it('sensitive family items are hidden from children', () => {
    expect(canRead(m('k', 'child'), item({ scope: 'family', sensitivity: 'sensitive' }))).toBe(false);
    expect(canRead(m('p', 'adult'), item({ scope: 'family', sensitivity: 'sensitive' }))).toBe(true);
  });
});

describe('connections', () => {
  it('does not mark revoked when the provider revoke fails', async () => {
    const reg = new ConnectionRegistry();
    reg.connect({ id: 'c1', userId: 'u1', provider: 'google', accountLabel: 'me', scopes: ['calendar'] });
    await expect(reg.revoke('u1', 'c1', async () => { throw new Error('network'); })).rejects.toThrow('network');
    expect(reg.hasScope('u1', 'google', 'calendar')).toBe(true);
    await reg.revoke('u1', 'c1', async () => {});
    expect(reg.hasScope('u1', 'google', 'calendar')).toBe(false);
  });
  it("cannot revoke someone else's connection", async () => {
    const reg = new ConnectionRegistry();
    reg.connect({ id: 'c1', userId: 'u1', provider: 'google', accountLabel: 'me', scopes: [] });
    await expect(reg.revoke('u2', 'c1', async () => {})).rejects.toThrow();
  });
});

describe('money', () => {
  it('rejects bad amounts and summarizes by category', () => {
    expect(() => makeExpense({ familyId: 'f', memberId: 'm', amountMinor: 10.5, currency: 'INR', category: 'x', note: '', at: 0 })).toThrow();
    const now = new Date(Date.UTC(2026, 9, 9, 12));
    const e = (amountMinor: number, category: string, at: number) =>
      makeExpense({ familyId: 'f', memberId: 'm', amountMinor, currency: 'INR', category, note: '', at });
    const entries = [
      e(60000, 'groceries', Date.UTC(2026, 9, 9, 8)),
      e(20000, 'bills', Date.UTC(2026, 9, 2)),
      e(99999, 'old', Date.UTC(2026, 5, 1)),
    ];
    expect(summarize(entries, 'today', now).totalMinor).toBe(60000);
    const month = summarize(entries, 'month', now);
    expect(month.totalMinor).toBe(80000);
    expect(month.byCategory).toEqual({ groceries: 60000, bills: 20000 });
  });
});

describe('calls', () => {
  const contacts = [
    { id: '1', name: 'Ravi Kumar', aliases: ['Dad', 'Appa'], phone: '+919800000001' },
    { id: '2', name: 'Dad Uncle', aliases: ['Dad2'], phone: '+919800000002' },
  ];
  it('resolves exact aliases and asks when ambiguous', () => {
    expect(resolveContact('dad', contacts)).toMatchObject({ kind: 'match' });
    expect(resolveContact('da', contacts)).toMatchObject({ kind: 'ambiguous' });
    expect(resolveContact('mom', contacts)).toEqual({ kind: 'none' });
  });
  it('twilio provider reports the real error and validates numbers', async () => {
    const bad = new TwilioProvider({ accountSid: 'AC1', authToken: 't', fetchImpl: async () => new Response('nope', { status: 401 }) });
    await expect(bad.startCall({ to: '+919800000001', from: '+15550001111' })).rejects.toThrow('401');
    await expect(bad.startCall({ to: '98000', from: '+15550001111' })).rejects.toThrow('E.164');
    const good = new TwilioProvider({ accountSid: 'AC1', authToken: 't', fetchImpl: async () => new Response(JSON.stringify({ sid: 'CA9' }), { status: 201 }) });
    expect(await good.startCall({ to: '+919800000001', from: '+15550001111' })).toEqual({ callId: 'CA9' });
  });
});

describe('check-ins', () => {
  const plan = { memberId: 'm', hour: 9, minute: 0, utcOffsetMinutes: 330, graceMinutes: 30 };
  const at = (h: number, min: number) => Date.UTC(2026, 9, 9, h, min); // UTC clock
  it('finds the last due time in the member timezone (09:00 IST = 03:30 UTC)', () => {
    expect(lastDue(plan, at(10, 0))).toBe(at(3, 30));
    expect(lastDue(plan, at(2, 0))).toBe(at(3, 30) - 24 * 3600_000);
  });
  it('ok, waiting, missed', () => {
    expect(evaluate(plan, at(3, 40), at(4, 0))).toBe('ok');
    expect(evaluate(plan, undefined, at(3, 45))).toBe('waiting');
    expect(evaluate(plan, undefined, at(4, 30))).toBe('missed');
  });
  it('escalates with repeated misses', () => {
    expect(escalationFor(0).action).toBe('none');
    expect(escalationFor(2).action).toBe('notify_admins');
    expect(escalationFor(5).action).toBe('call_emergency_contact');
  });
});

describe('google calendar', () => {
  const tokens = { getAccessToken: async () => 'tok' };
  it('creates an event and returns its id; surfaces 401 as needs reauth', async () => {
    const cal = new GoogleCalendar(tokens, async () => new Response(JSON.stringify({ id: 'ev1' }), { status: 200 }));
    const ev = await cal.createEvent('u', { summary: 'Dentist', start: '2026-10-10T10:00:00Z', end: '2026-10-10T11:00:00Z' });
    expect(ev.id).toBe('ev1');
    const bad = new GoogleCalendar(tokens, async () => new Response('expired', { status: 401 }));
    await expect(bad.listUpcoming('u', new Date())).rejects.toMatchObject({ needsReauth: true });
  });
  it('rejects events that end before they start', async () => {
    const cal = new GoogleCalendar(tokens, async () => new Response('{}'));
    await expect(cal.createEvent('u', { summary: 'x', start: '2026-10-10T11:00:00Z', end: '2026-10-10T10:00:00Z' })).rejects.toThrow();
  });
});

describe('wake word and tv focus', () => {
  it('needs consecutive frames and respects cooldown', () => {
    const g = new WakeGate({ threshold: 0.5, consecutive: 2, cooldownMs: 1000 });
    expect(g.feed(0.9, 0)).toBe(false);
    expect(g.feed(0.9, 20)).toBe(true);
    expect(g.feed(0.9, 40)).toBe(false);
    expect(g.feed(0.9, 60)).toBe(false);
    expect(g.feed(0.9, 1100)).toBe(false);
    expect(g.feed(0.9, 1120)).toBe(true);
  });
  it('builds phrases from chosen names', () => {
    expect(wakePhrases(['Nova', ' nova ', ''])).toEqual(['hey nova']);
  });
  it('moves focus across ragged rows without wrapping', () => {
    const rows = [5, 2, 4];
    expect(moveFocus(rows, { row: 0, col: 4 }, 'down')).toEqual({ row: 1, col: 1 });
    expect(moveFocus(rows, { row: 1, col: 1 }, 'right')).toEqual({ row: 1, col: 1 });
    expect(moveFocus(rows, { row: 0, col: 0 }, 'up')).toEqual({ row: 0, col: 0 });
  });
});

describe('modes', () => {
  const tools = [{ spec: { name: 'recall' } }, { spec: { name: 'send_money' } }, { spec: { name: 'add_reminder' } }];
  it('chat and voice keep every tool', () => {
    expect(toolsForMode('chat', tools)).toHaveLength(3);
    expect(toolsForMode('voice', tools)).toHaveLength(3);
    expect(modeInfo('voice').spoken).toBe(true);
  });
  it('coder gets no tools at all, so it can never touch money or the family', () => {
    expect(toolsForMode('coder', tools)).toEqual([]);
  });
  it('the learning coach only gets safe tools, and the twin only reads', () => {
    expect(toolsForMode('learn', tools).map((t) => t.spec.name)).toEqual(['recall', 'add_reminder']);
    expect(toolsForMode('twin', tools).map((t) => t.spec.name)).toEqual(['recall']);
  });
  it('guests only get chat and voice', () => {
    expect(modeAllowed('coder', 'guest')).toBe(false);
    expect(modeAllowed('twin', 'guest')).toBe(false);
    expect(modeAllowed('voice', 'guest')).toBe(true);
    expect(modeAllowed('twin', 'child')).toBe(true);
  });
});

describe('family twin', () => {
  it('always says it is a guess and never claims to be the person', () => {
    const lines = twinPrompt('Dad', ['likes filter coffee']).join(' ');
    expect(lines).toContain('guess');
    expect(lines).toContain('You are NOT Dad');
    expect(lines).toContain('likes filter coffee');
  });
  it('says there is nothing to go on when nothing was shared', () => {
    expect(twinPrompt('Mom', []).join(' ')).toContain('not shared anything');
  });
});

describe('wake phrase stripping', () => {
  it('passes on only the request', () => {
    expect(stripWake('Hey Nova, what is for dinner?', ['hey nova'])).toBe('what is for dinner?');
  });
  it('ignores speech with no wake phrase, and a wake phrase with nothing after it', () => {
    expect(stripWake('what is for dinner?', ['hey nova'])).toBe(null);
    expect(stripWake('hey nova', ['hey nova'])).toBe(null);
  });
});

describe('memory timeline', () => {
  const at = (iso: string) => new Date(iso).getTime();
  it('groups by month, newest first, newest entry first', () => {
    const months = timelineMonths([
      { id: 'a', kind: 'memory', text: 'old', at: at('2026-08-04T10:00:00Z') },
      { id: 'b', kind: 'money', text: 'new', at: at('2026-10-09T10:00:00Z') },
      { id: 'c', kind: 'house', text: 'newer', at: at('2026-10-10T10:00:00Z') },
    ]);
    expect(months.map((m) => m.month)).toEqual(['2026-10', '2026-08']);
    expect(months[0]!.label).toBe('October 2026');
    expect(months[0]!.entries.map((e) => e.text)).toEqual(['newer', 'new']);
  });
  it('keeps the moments worth keeping and drops the noise', () => {
    expect(timelineKindFor('expense_added')).toBe('money');
    expect(timelineKindFor('learning')).toBe('learning');
    expect(timelineKindFor('approval_requested')).toBe(null);
  });
});

describe('timeline has no duplicates', () => {
  it('leaves out the "saved" notes for things already on the timeline', () => {
    expect(timelineKindFor('memory_saved')).toBe(null);
    expect(timelineKindFor('house_item')).toBe(null);
  });
});

describe('reading web pages safely', () => {
  it('only accepts real web addresses', () => {
    expect(parseHttpUrl('https://example.com/a')?.hostname).toBe('example.com');
    expect(parseHttpUrl('file:///etc/passwd')).toBe(null);
    expect(parseHttpUrl('javascript:alert(1)')).toBe(null);
    expect(parseHttpUrl('not a url')).toBe(null);
  });
  it('never lets the AI reach our own machine or private network', () => {
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '[::1]', 'printer.local', 'intranet']) {
      expect(isBlockedHost(host)).toBe(true);
    }
    expect(isBlockedIp('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedHost('example.com')).toBe(false);
    expect(isBlockedIp('8.8.8.8')).toBe(false);
    expect(isBlockedIp('172.32.0.1')).toBe(false); // just outside the private range
  });
  it('turns a page into plain text with no scripts left', () => {
    const html = '<html><head><title>Hi &amp; bye</title><script>steal()</script></head><body><p>One</p><style>x{}</style><p>Two &lt;b&gt;</p></body></html>';
    const text = htmlToText(html);
    expect(text).toContain('One');
    expect(text).toContain('Two <b>');
    expect(text).not.toContain('steal');
    expect(htmlTitle(html)).toBe('Hi & bye');
    expect(htmlToText('x'.repeat(50), 10)).toContain('page continues');
  });
});

describe('weather', () => {
  it('reads a place and a forecast into one short spoken line', () => {
    const place = firstPlace({ results: [{ name: 'Chennai', country: 'India', latitude: 13.08, longitude: 80.27 }] });
    expect(place?.name).toBe('Chennai');
    expect(firstPlace({ results: [] })).toBe(null);
    const f = readForecast({
      current: { temperature_2m: 31.4, weather_code: 2 },
      daily: { time: ['2026-10-12', '2026-10-13'], weather_code: [61, 0], temperature_2m_max: [32, 33], temperature_2m_min: [25, 26], precipitation_probability_max: [70, 5] },
    });
    const line = forecastLines(place!, f!);
    expect(line).toContain('31°C and partly cloudy right now');
    expect(line).toContain('Today: 25–32°C, rain, 70% chance of rain');
    expect(line).toContain('Tomorrow: 26–33°C, clear');
    expect(line).not.toContain('5% chance'); // small chances are left out
  });
});

describe('learning coach method', () => {
  it('teaches at the edge of what they can do and has them explain it back', () => {
    const lines = modeInfo('learn').lines.join(' ');
    expect(lines).toContain('explain it back in their own words');
    expect(lines).toContain('just past that edge');
  });
});
