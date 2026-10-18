import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityLog, redact } from '../src/main/agent/activity';
import { Agent, describe as describeOutcome, forModel } from '../src/main/agent/agent';
import { canApprove, Gate } from '../src/main/agent/gate';
import { MemoryStore } from '../src/main/agent/memory';
import { parseAnthropic, parseOllama } from '../src/main/agent/model';
import { desktopPlanner, familyPlanner, PLANNERS, streamPlanner } from '../src/main/agent/planners';
import { ok, type Actor, type ToolDef } from '../src/main/agent/types';

const owner: Actor = { id: 'owner', name: 'Sakthi', role: 'owner', via: 'desktop' };
const adult: Actor = { id: 'mom', name: 'Mom', role: 'adult', via: 'phone' };
const child: Actor = { id: 'kid', name: 'Kid', role: 'child', via: 'phone' };

function tool(name: string, risk: ToolDef['spec']['risk'], run = async () => ok(`${name} ran`), extra: Partial<ToolDef> = {}): ToolDef {
  return { spec: { name, risk, description: `Do ${name}.` }, input: { type: 'object', properties: {} }, run, ...extra };
}

describe('gate', () => {
  it('lets low risk run, asks for medium, ALWAYS asks for high and money', () => {
    const g = new Gate();
    expect(g.check(tool('look', 'low'), {}, owner).kind).toBe('clear');
    expect(g.check(tool('close', 'medium'), {}, owner).kind).toBe('needs_approval');
    g.setAiMode(true, owner);
    expect(g.check(tool('close', 'medium'), {}, owner).kind).toBe('clear');
    expect(g.check(tool('ban', 'high'), {}, owner).kind).toBe('needs_approval');
    expect(g.check(tool('pay', 'money'), {}, owner).kind).toBe('needs_approval');
  });

  it('never lets children run more than low risk, even in AI Mode, and children cannot turn AI Mode on', () => {
    const g = new Gate();
    expect(g.setAiMode(true, child)).toBe(false);
    g.setAiMode(true, owner);
    const d = g.check(tool('close', 'medium'), {}, child);
    expect(d).toMatchObject({ kind: 'needs_approval' });
    expect(d.kind === 'needs_approval' && d.summary).toContain("parent's OK");
    expect(() => g.claim((d as { id: string }).id, child)).toThrow(/cannot approve/);
    expect(g.claim((d as { id: string }).id, adult).tool.spec.name).toBe('close');
  });

  it('runs an approved request exactly once and forgets expired ones', () => {
    let now = 0;
    const g = new Gate({ now: () => now, ttlMs: 1000 });
    const a = g.check(tool('x', 'high'), {}, owner) as { id: string };
    g.claim(a.id, owner);
    expect(() => g.claim(a.id, owner)).toThrow(/gone/);
    const b = g.check(tool('x', 'high'), {}, owner) as { id: string };
    now = 5000;
    expect(() => g.claim(b.id, owner)).toThrow(/gone/);
  });

  it('the stop switch blocks everything and only a parent can resume', () => {
    const g = new Gate();
    g.check(tool('x', 'high'), {}, owner);
    g.stop(child);
    expect(g.list()).toHaveLength(0);
    expect(g.check(tool('look', 'low'), {}, owner).kind).toBe('blocked');
    expect(g.resume(child)).toBe(false);
    expect(g.resume(adult)).toBe(true);
    expect(g.check(tool('look', 'low'), {}, owner).kind).toBe('clear');
  });

  it('respects role limits on tools and money approvals', () => {
    const g = new Gate();
    expect(g.check(tool('limit', 'low', undefined, { roles: ['owner', 'admin'] }), {}, adult).kind).toBe('blocked');
    expect(canApprove({ ...owner, role: 'teen' }, 'high')).toBe(false);
    expect(canApprove(adult, 'money')).toBe(true);
    expect(canApprove({ ...owner, role: 'elder' }, 'high')).toBe(false);
  });

  it('standing OKs only skip medium risk', () => {
    const g = new Gate();
    g.standing.add('type').add('force');
    expect(g.check(tool('type', 'medium'), {}, owner).kind).toBe('clear');
    expect(g.check(tool('force', 'high'), {}, owner).kind).toBe('needs_approval');
  });
});

describe('planners', () => {
  it('understands stream, family and desktop commands without AI', () => {
    expect(streamPlanner('switch to BRB')).toEqual({ tool: 'stream_obs_switch_scene', args: { scene: 'BRB' } });
    expect(streamPlanner('ban spammer')?.tool).toBe('stream_chat_ban');
    expect(familyPlanner('limit gaming to 1 hour a day')).toEqual({ tool: 'set_screen_limit', args: { app: 'gaming', minutes: 60 } });
    expect(familyPlanner('limit minecraft to 30 minutes')).toEqual({ tool: 'set_screen_limit', args: { app: 'minecraft', minutes: 30 } });
    expect(familyPlanner('remove the gaming limit')).toEqual({ tool: 'remove_screen_limit', args: { app: 'gaming' } });
    expect(familyPlanner('close all games')?.tool).toBe('close_games');
    expect(familyPlanner('remember for family: the wifi password is on the router')).toEqual({ tool: 'remember', args: { scope: 'family', text: 'the wifi password is on the router' } });
    expect(desktopPlanner('open spotify')).toEqual({ tool: 'open_app', args: { app: 'spotify' } });
    expect(desktopPlanner('open youtube.com')).toEqual({ tool: 'open_website', args: { url: 'https://youtube.com' } });
    expect(desktopPlanner('force close chrome')).toEqual({ tool: 'force_close_app', args: { app: 'chrome' } });
    expect(desktopPlanner('take over for 5 minutes')).toEqual({ tool: 'take_over', args: { minutes: 5 } });
    expect(desktopPlanner('press ctrl+s')).toEqual({ tool: 'press_keys', args: { keys: 'ctrl+s' } });
    expect(desktopPlanner('type: hello world')).toEqual({ tool: 'type_text', args: { text: 'hello world' } });
  });

  it('leaves real questions for the AI instead of guessing a command', () => {
    for (const q of ['type of birds in India?', 'open the file I was working on yesterday afternoon', 'press release ideas for my shop', 'what is the capital of France']) {
      expect(PLANNERS.map((p) => p(q)).filter(Boolean)).toEqual([]);
    }
  });

  it('tries stream words before desktop words', () => {
    expect(PLANNERS.map((p) => p('close the poll')).find(Boolean)?.tool).toBe('stream_poll_end');
    expect(PLANNERS.map((p) => p('start a giveaway for a game key')).find(Boolean)?.tool).toBe('stream_giveaway_start');
  });
});

describe('agent', () => {
  let dir = '';
  let log: ActivityLog;
  let memory: MemoryStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-'));
    log = new ActivityLog(join(dir, 'a.jsonl'));
    memory = new MemoryStore(join(dir, 'm.json'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const make = (tools: ToolDef[], model: () => ReturnType<Exclude<ConstructorParameters<typeof Agent>[0]['model'], undefined>> = () => null) =>
    new Agent({ tools, planners: [(t) => (t === 'close it' ? { tool: 'close', args: {} } : t === 'look' ? { tool: 'look', args: {} } : null)], gate: new Gate(), log, memory, model, botName: () => 'Milo' });

  it('runs fixed commands, asks before medium risk, and runs only after approval', async () => {
    let ran = 0;
    const a = make([tool('close', 'medium', async () => { ran++; return ok('Closed it.'); })]);
    const r = await a.handle('close it', owner);
    expect(r.outcomes[0]).toMatchObject({ kind: 'needs_approval' });
    expect(ran).toBe(0);
    const id = (r.outcomes[0] as { id: string }).id;
    const out = await a.approve(id, owner);
    expect(out).toEqual({ kind: 'done', tool: 'close', text: 'Closed it.', verified: true });
    expect(ran).toBe(1);
    expect((await a.approve(id, owner)).kind).toBe('failed');
  });

  it('turns tool errors into honest failures and logs them', async () => {
    const a = make([tool('look', 'low', async () => { throw new Error('disk on fire'); })]);
    const r = await a.handle('look', owner);
    expect(r.outcomes[0]).toEqual({ kind: 'failed', tool: 'look', text: 'disk on fire' });
    expect(r.text).toContain("Couldn't");
    expect(log.recent(5).some((e) => e.status === 'failed')).toBe(true);
  });

  it('answers clearly with no AI set up', async () => {
    const r = await make([]).handle('what is the weather', owner);
    expect(r.offline).toBe(true);
    expect(r.text).toMatch(/fixed commands/);
  });

  it('handles stop, resume, pending and AI Mode words itself', async () => {
    const a = make([tool('look', 'low')]);
    expect((await a.handle('stop', child)).text).toMatch(/Stopped/);
    expect((await a.handle('look', owner)).outcomes[0]?.kind).toBe('blocked');
    expect((await a.handle('resume', child)).text).toMatch(/cannot resume/);
    expect((await a.handle('resume', owner)).text).toMatch(/Resumed/);
    expect((await a.handle('AI mode on', child)).text).toMatch(/cannot/);
    expect((await a.handle('pending', owner)).text).toMatch(/Nothing/);
  });

  it('never lets the AI model claim something that is only waiting', async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call++;
      const body = call === 1
        ? { content: [{ type: 'tool_use', id: 't1', name: 'close', input: {} }] }
        : { content: [{ type: 'text', text: 'All done, I closed it!' }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const a = make([tool('close', 'medium')], () => ({ provider: 'anthropic', model: 'm', apiKey: 'sk-test', fetchImpl }));
    const r = await a.handle('please shut that thing for me', owner);
    expect(r.outcomes[0]?.kind).toBe('needs_approval');
    expect(r.text).toContain('Waiting for your OK');
  });

  it('tells the model the plain status of each action', () => {
    expect(forModel({ kind: 'needs_approval', tool: 'x', id: 'a1', summary: 'Ban bob' })).toMatch(/^WAITING.*NOT happened/);
    expect(forModel({ kind: 'done', tool: 'x', text: 'ok', verified: false })).toMatch(/not independently confirmed/);
    expect(describeOutcome({ kind: 'done', tool: 'x', text: 'Typed.', verified: false })).toMatch(/could not double-check/);
  });
});

describe('model replies', () => {
  it('reads Claude text and tool calls', () => {
    expect(parseAnthropic([{ type: 'text', text: 'Hi ' }, { type: 'tool_use', id: 'a', name: 'open_app', input: { app: 'obs' } }, { type: 'junk' }])).toEqual({ text: 'Hi', calls: [{ id: 'a', name: 'open_app', args: { app: 'obs' } }] });
  });
  it('reads Ollama tool calls, even with string arguments, and drops <think> text', () => {
    let n = 0;
    const s = parseOllama({ role: 'assistant', content: '<think>hmm</think>Sure.', tool_calls: [{ function: { name: 'list_apps', arguments: '{"a":1}' } }, { function: { name: 'x', arguments: 'nope' } }] }, () => `c${++n}`);
    expect(s).toEqual({ text: 'Sure.', calls: [{ id: 'c1', name: 'list_apps', args: { a: 1 } }, { id: 'c2', name: 'x', args: {} }] });
  });
  it('sends the Claude key only in a header and never shows it in errors', async () => {
    let seen: RequestInit | undefined;
    const fetchImpl = (async (_u: unknown, init?: RequestInit) => { seen = init; return new Response('bad key sk-secret-123', { status: 401 }); }) as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), 'm-'));
    const a = new Agent({ tools: [], planners: [], gate: new Gate(), log: new ActivityLog(join(dir, 'a')), memory: new MemoryStore(join(dir, 'm')), model: () => ({ provider: 'anthropic', model: 'm', apiKey: 'sk-secret-123', fetchImpl }), botName: () => 'Milo' });
    const r = await a.handle('hello there friend', owner);
    expect((seen?.headers as Record<string, string>)['x-api-key']).toBe('sk-secret-123');
    expect(String(seen?.body)).not.toContain('sk-secret-123');
    expect(r.text).toContain('401');
    expect(r.text).not.toContain('sk-secret-123');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('activity log', () => {
  it('appends, survives a restart, and hides keys', () => {
    const dir = mkdtempSync(join(tmpdir(), 'log-'));
    const a = new ActivityLog(join(dir, 'x.jsonl'));
    a.add('action', 'done', 'Mom', 'set key sk-ant-abcdefghijklmnop');
    const b = new ActivityLog(join(dir, 'x.jsonl'));
    expect(b.recent(1)[0]?.text).toBe('set key [hidden]');
    expect(redact('oauth:abcdefgh12345678')).toBe('[hidden]');
    rmSync(dir, { recursive: true, force: true });
  });
});
