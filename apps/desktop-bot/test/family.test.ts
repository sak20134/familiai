import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/main/agent/memory';
import type { Actor } from '../src/main/agent/types';
import { ConfigStore, DEFAULT_CONFIG, parseConfig, type Cipher } from '../src/main/config';
import { Family } from '../src/main/family/family';
import { appsForLabel, dayKey, GAME_APPS, ScreenTime } from '../src/main/family/screentime';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fam-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const owner: Actor = { id: 'owner', name: 'Sakthi', role: 'owner', via: 'desktop' };
const MIN = 60_000;

describe('screen time', () => {
  it('counts only while the app runs, warns at 5 and 1 minutes, then enforces', () => {
    let now = new Date(2026, 9, 18, 15, 0).getTime();
    const st = new ScreenTime(join(dir, 's.json'), () => now);
    st.setLimit('gaming', 10, 'Mom');
    const game = [{ pid: 1, name: 'robloxplayerbeta' }];
    expect(st.tick([], MIN)).toEqual([]);
    for (let i = 0; i < 4; i++) st.tick(game, MIN);
    expect(st.tick(game, MIN)).toMatchObject([{ kind: 'warn', leftMinutes: 5 }]);
    for (let i = 0; i < 3; i++) st.tick(game, MIN);
    expect(st.tick(game, MIN)).toMatchObject([{ kind: 'warn', leftMinutes: 1 }]);
    expect(st.tick(game, MIN)).toMatchObject([{ kind: 'limit' }]);
    expect(st.status()[0]).toMatchObject({ usedMinutes: 10, leftMinutes: 0 });
    // the next day starts fresh
    now += 24 * 60 * MIN;
    expect(st.status()[0]).toMatchObject({ usedMinutes: 0, leftMinutes: 10 });
  });
  it('does not count a sleeping computer as play time, and survives a restart', () => {
    const now = Date.now();
    const a = new ScreenTime(join(dir, 's.json'), () => now);
    a.setLimit('minecraft', 60, 'Mom');
    a.tick([{ pid: 1, name: 'minecraft' }], 8 * 60 * MIN);
    expect(a.status()[0]?.usedMinutes).toBe(2);
    expect(new ScreenTime(join(dir, 's.json'), () => now).status()[0]).toMatchObject({ usedMinutes: 2 });
  });
  it('"gaming" means all common games; limits are validated', () => {
    expect(appsForLabel('Gaming')).toEqual([...GAME_APPS]);
    expect(appsForLabel('youtube')).toEqual(['youtube']);
    const st = new ScreenTime(join(dir, 's.json'));
    expect(() => st.setLimit('x', 0, 'a')).toThrow();
    expect(() => st.setLimit('', 10, 'a')).toThrow();
    st.setLimit('games', 30, 'a');
    st.setLimit('Games', 45, 'b');
    expect(st.rules()).toHaveLength(1);
    expect(st.removeLimit('games')?.dailyMinutes).toBe(45);
    expect(dayKey(new Date(2026, 0, 2).getTime())).toBe('2026-01-02');
  });
});

describe('family and phone pairing', () => {
  it('creates an owner and enforces who may add whom', () => {
    const f = new Family(join(dir, 'f.json'), 'Sakthi');
    const kid = f.addMember('Asha', 'child', owner);
    expect(() => f.addMember('X', 'owner', owner)).toThrow();
    const kidActor = f.actor(kid, 'phone');
    expect(() => f.addMember('Y', 'child', kidActor)).toThrow(/cannot/);
    expect(new Family(join(dir, 'f.json'), 'Other').owner().name).toBe('Sakthi');
  });
  it('pairs a phone once with the code, stores only a hash, and can revoke it', () => {
    const f = new Family(join(dir, 'f.json'), 'Sakthi');
    const mom = f.addMember('Mom', 'adult', owner);
    expect(() => f.startPairing(mom.id, f.actor(mom, 'desktop'))).toThrow(/owner or an admin/);
    const { code } = f.startPairing(mom.id, owner);
    const { token, member } = f.completePairing(code, "Mom's phone");
    expect(member.name).toBe('Mom');
    expect(() => f.completePairing(code, 'again')).toThrow(/no pairing code/);
    expect(f.authenticate(token)?.member.id).toBe(mom.id);
    expect(f.authenticate('x'.repeat(43))).toBeNull();
    expect(readFileSync(join(dir, 'f.json'), 'utf8')).not.toContain(token);
    f.revokeDevice(f.devices()[0]!.id, owner);
    expect(f.authenticate(token)).toBeNull();
  });
  it('ends pairing after five wrong codes or when it expires', () => {
    let now = 0;
    const f = new Family(join(dir, 'f.json'), 'Sakthi', () => now);
    const { code } = f.startPairing('owner', owner);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect(() => f.completePairing(wrong, 'p')).toThrow();
    expect(() => f.completePairing(code, 'p')).toThrow(/no pairing code/);
    const second = f.startPairing('owner', owner);
    now = 6 * MIN;
    expect(() => f.completePairing(second.code, 'p')).toThrow(/no pairing code/);
  });
  it("removing a member unpairs their phones", () => {
    const f = new Family(join(dir, 'f.json'), 'Sakthi');
    const kid = f.addMember('Asha', 'child', owner);
    const { token } = f.completePairing(f.startPairing(kid.id, owner).code, 'tablet');
    f.removeMember(kid.id, owner);
    expect(f.authenticate(token)).toBeNull();
  });
});

describe('memory scopes', () => {
  const kid: Actor = { id: 'kid', name: 'Asha', role: 'child', via: 'phone' };
  const mom: Actor = { id: 'mom', name: 'Mom', role: 'admin', via: 'phone' };
  it('keeps private notes private, even from admins', () => {
    const m = new MemoryStore(join(dir, 'm.json'));
    m.remember(owner, 'my bank pin hint is the dog', 'private');
    m.remember(owner, 'the wifi password is on the router', 'family');
    expect(m.recall(mom, 'wifi router').map((i) => i.text)).toEqual(['the wifi password is on the router']);
    expect(m.recall(mom, 'bank pin dog')).toEqual([]);
    expect(m.recall(owner, 'bank pin dog')).toHaveLength(1);
  });
  it('children can only save private notes; deleted family notes go to the admin vault', () => {
    const m = new MemoryStore(join(dir, 'm.json'));
    expect(() => m.remember(kid, 'x', 'family')).toThrow();
    const item = m.remember(owner, 'dinner is at 8', 'family');
    m.forget(mom, item.id);
    expect(m.list(owner)).toEqual([]);
    expect(m.vault(mom)[0]).toMatchObject({ text: 'dinner is at 8', deletedBy: 'Mom' });
    expect(m.vault(kid)).toEqual([]);
    const secret = m.remember(owner, 'private thing', 'private');
    expect(() => m.forget(mom, secret.id)).toThrow();
  });
});

describe('config', () => {
  const cipher: Cipher = { available: () => true, encrypt: (t) => Buffer.from(t.split('').reverse().join('')), decrypt: (b) => b.toString().split('').reverse().join('') };
  it('cleans bad values', () => {
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(parseConfig({ provider: 'evil', obsUrl: 'javascript:x', phonePort: 80, twitchChannel: '#My_Chan!' })).toMatchObject({ obsUrl: DEFAULT_CONFIG.obsUrl, phonePort: 47778, twitchChannel: 'my_chan' });
  });
  it('encrypts secrets, never stores them in config.json, and reports only flags', () => {
    const c = new ConfigStore(dir, cipher);
    c.update({ twitchChannel: 'mine' });
    c.setSecret('twitchToken', 'sk-ant-secret');
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).not.toContain('sk-ant');
    expect(readFileSync(join(dir, 'secrets.bin'), 'utf8')).not.toContain('sk-ant-secret');
    expect(new ConfigStore(dir, cipher).secret('twitchToken')).toBe('sk-ant-secret');
    expect(c.secretFlags()).toEqual({ twitchToken: true, obsPassword: false });
    c.setSecret('twitchToken', '');
    expect(c.secretFlags().twitchToken).toBe(false);
  });
  it('refuses to save secrets without secure storage', () => {
    const c = new ConfigStore(dir, { ...cipher, available: () => false });
    expect(() => c.setSecret('twitchToken', 'x')).toThrow(/secure storage/);
  });
});
