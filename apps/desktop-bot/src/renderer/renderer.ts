// The bot window. Uses textContent (never innerHTML) for anything that comes from outside.

import type { BotState, OutcomeView, ReplyView, Role } from '../shared/api';
import { removeBackgroundPixels } from './bg';
import pixelCat from './pixelcat.json';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing element #${id}`);
  return e as T;
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { cls?: string; text?: string; type?: string } = {}, kids: Node[] = []): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.cls) e.className = props.cls;
  if (props.text !== undefined) e.textContent = props.text;
  if (props.type && e instanceof HTMLButtonElement) e.type = props.type as 'button';
  e.append(...kids);
  return e;
}

const botBtn = $<HTMLButtonElement>('bot');
const botImg = $<HTMLImageElement>('bot-img');
const botCat = document.getElementById('bot-cat') as unknown as SVGElement;
const speech = $('speech');
const panel = $('panel');
const cards = $('cards');
const banner = $('banner');
const ask = $<HTMLInputElement>('ask');
const menuBtn = $<HTMLButtonElement>('btn-menu');

let state: BotState | null = null;

/** Draws the built-in pixel cat (one square per pixel). Eye pixels go in their own group so they blink. */
function drawPixelCat(svg: SVGElement): void {
  const NS = 'http://www.w3.org/2000/svg';
  const eyes = document.createElementNS(NS, 'g');
  eyes.setAttribute('class', 'eyes');
  const palette = pixelCat.palette as Record<string, string>;
  svg.setAttribute('viewBox', `0 0 ${pixelCat.rows[0]?.length ?? 16} ${pixelCat.rows.length}`);
  pixelCat.rows.forEach((row, y) => [...row].forEach((ch, x) => {
    const fill = palette[ch];
    if (!fill) return;
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(x));
    r.setAttribute('y', String(y));
    r.setAttribute('width', '1.02'); // a hair wider, so no seams show between squares
    r.setAttribute('height', '1.02');
    r.setAttribute('fill', fill);
    (ch === 'E' || ch === 'e' ? eyes : svg).appendChild(r);
  }));
  svg.appendChild(eyes);
}
drawPixelCat(botCat);
let speechTimer: number | undefined;
const recent: Array<{ you: string; reply: ReplyView }> = [];

// ---- click-through: only catch the mouse while it is over the bot or a panel ----
let interactive = false;
const setInteractive = (on: boolean) => { if (on !== interactive) { interactive = on; window.bot.setInteractive(on); } };
document.addEventListener('mousemove', (e) => setInteractive(Boolean((e.target as HTMLElement | null)?.closest('[data-hit]'))));
document.addEventListener('mouseleave', () => setInteractive(false));

// ---- talking ----
function say(text: string, ms = 5000): void {
  if (state?.settings.quiet) return;
  speech.textContent = text.length > 280 ? `${text.slice(0, 280)}…` : text;
  speech.hidden = false;
  window.clearTimeout(speechTimer);
  speechTimer = window.setTimeout(() => { speech.hidden = true; }, Math.max(ms, Math.min(15000, text.length * 60)));
}

function speak(text: string): void {
  if (!state?.config.speakReplies || state.settings.quiet || !('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text.slice(0, 400)));
}

function outcomeText(o: OutcomeView): string {
  if (o.kind === 'done') return o.verified ? `✓ ${o.text}` : `• ${o.text} (not double-checked)`;
  if (o.kind === 'needs_approval') return `… waiting for an OK: ${o.summary}`;
  if (o.kind === 'blocked') return `⛔ ${o.text}`;
  return `✗ ${o.text}`;
}

async function send(text: string): Promise<void> {
  const t = text.trim();
  if (!t) return;
  ask.disabled = true;
  botBtn.classList.add('thinking');
  say('Thinking…', 60000);
  const r = await window.bot.ask(t);
  botBtn.classList.remove('thinking');
  ask.disabled = false;
  ask.focus();
  if (!r.ok) { say(r.error); return; }
  recent.unshift({ you: t, reply: r.value });
  recent.splice(8);
  say(r.value.text);
  speak(r.value.text);
  await refresh();
}

// ---- drawing ----
function applyLook(s: BotState): void {
  const look = s.settings;
  if (look.imageUrl) {
    botImg.src = look.imageUrl;
    botImg.hidden = false;
    botCat.style.display = 'none';
  } else {
    botImg.hidden = true;
    botImg.removeAttribute('src');
    botCat.style.display = '';
  }
  botBtn.classList.toggle('quiet', look.quiet);
  botBtn.classList.toggle('takeover', s.takeover.active);
  botBtn.classList.toggle('stopped', s.stopped);
  $('btn-quiet').textContent = look.quiet ? 'Wake up' : 'Quiet';
  if (s.takeover.active) {
    banner.textContent = `Controlling your keyboard until ${new Date(s.takeover.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · Ctrl+Alt+S or ■ stops it`;
    banner.className = 'danger';
  } else if (s.stopped) {
    banner.textContent = 'Stopped. Say "resume" to continue.';
    banner.className = 'muted';
  }
  banner.hidden = !s.takeover.active && !s.stopped;
}

function renderCards(s: BotState): void {
  cards.replaceChildren();
  for (const p of s.pending.slice(0, 2)) {
    const card = el('div', { cls: `card risk-${p.risk}` }, [el('div', { text: p.summary }), el('div', { cls: 'note', text: `Asked by ${p.requestedBy} · ${p.risk} risk` })]);
    if (s.canApprove) {
      const yes = el('button', { cls: 'ok', text: 'Approve', type: 'button' });
      const no = el('button', { cls: 'no', text: 'Reject', type: 'button' });
      yes.onclick = () => void decide(p.id, true);
      no.onclick = () => void decide(p.id, false);
      card.append(el('div', { cls: 'actions' }, [yes, no]));
    }
    cards.append(card);
  }
  if (s.pending.length > 2) cards.append(el('div', { cls: 'note more', text: `+${s.pending.length - 2} more in the panel` }));
}

async function decide(id: string, yes: boolean): Promise<void> {
  const r = yes ? await window.bot.approve(id) : await window.bot.reject(id);
  if (r.ok) { say(outcomeText(r.value)); speak(outcomeText(r.value)); } else say(r.error);
  await refresh();
}

function pill(node: HTMLElement, s: { state: string; detail: string }, detail: HTMLElement): void {
  node.textContent = s.state;
  node.className = `pill ${s.state}`;
  detail.textContent = s.detail;
}

function renderPanel(s: BotState): void {
  // Home
  const brain = `Brain: ${s.brain.detail}`;
  const parts = [brain, s.aiMode ? 'AI Mode ON' : 'asks before medium-risk actions'];
  $('status-line').textContent = parts.join(' · ');
  const pl = $('pending-list');
  pl.replaceChildren(...(s.pending.length ? s.pending.map((p) => {
    const row = el('div', { cls: 'card' }, [el('div', { text: `${p.id}: ${p.summary}` }), el('div', { cls: 'note', text: `${p.requestedBy} · ${p.risk} risk` })]);
    if (s.canApprove) {
      const yes = el('button', { cls: 'ok', text: 'Approve', type: 'button' });
      const no = el('button', { cls: 'no', text: 'Reject', type: 'button' });
      yes.onclick = () => void decide(p.id, true);
      no.onclick = () => void decide(p.id, false);
      row.append(el('div', { cls: 'actions' }, [yes, no]));
    }
    return row;
  }) : [el('p', { cls: 'note', text: 'Nothing is waiting.' })]));
  $('log').replaceChildren(...(recent.length ? recent.map((r) => el('div', { cls: 'exchange' }, [
    el('div', { cls: 'you', text: r.you }),
    el('div', { cls: 'reply', text: r.reply.text }),
    ...r.reply.outcomes.map((o) => el('div', { cls: `outcome ${o.kind}`, text: outcomeText(o) })),
  ])) : [el('p', { cls: 'note', text: 'Ask me something below.' })]));

  // Stream
  pill($('obs-state'), s.stream.obs, $('obs-detail'));
  pill($('twitch-state'), s.stream.twitch, $('twitch-detail'));
  $('stream-extra').textContent = [s.stream.poll && `Poll: ${s.stream.poll}`, s.stream.giveaway && `Giveaway: ${s.stream.giveaway}`].filter(Boolean).join(' · ');

  // Family
  $('limits').replaceChildren(...(s.limits.length ? s.limits.map((l) => {
    const rm = el('button', { text: 'Remove', type: 'button' });
    rm.onclick = () => void send(`remove the ${l.label} limit`);
    return el('li', { cls: 'row-between' }, [el('span', { text: `${l.label}: ${l.leftMinutes} min left (${l.usedMinutes}/${l.dailyMinutes})` }), rm]);
  }) : [el('li', { cls: 'note', text: 'No limits yet.' })]));
  $('members').replaceChildren(...s.members.map((m) => {
    const kids: Node[] = [el('span', { text: `${m.name} · ${m.role}` })];
    if (s.phone.running && s.canManage) {
      const pair = el('button', { text: 'Pair a phone', type: 'button' });
      pair.onclick = async () => { const r = await window.bot.startPairing(m.id); if (!r.ok) say(r.error); else render(r.value); };
      kids.push(pair);
    }
    if (m.role !== 'owner' && s.canManage) {
      const rm = el('button', { text: '✕', type: 'button' });
      rm.setAttribute('aria-label', `Remove ${m.name}`);
      rm.onclick = async () => { const r = await window.bot.removeMember(m.id); if (!r.ok) say(r.error); else render(r.value); };
      kids.push(rm);
    }
    return el('li', { cls: 'row-between' }, kids);
  }));
  const pb = $('phone-box');
  if (!s.phone.running) pb.replaceChildren(el('p', { cls: 'note', text: s.phone.error ?? 'Phone control is off. Turn it on in Settings to command the bot from phones on your home Wi-Fi.' }));
  else if (s.phone.pairing) {
    const cancel = el('button', { text: 'Cancel', type: 'button' });
    cancel.onclick = async () => { const r = await window.bot.cancelPairing(); if (r.ok) render(r.value); };
    pb.replaceChildren(el('div', { cls: 'card' }, [
      el('div', { cls: 'note', text: `Pairing a phone for ${s.phone.pairing.member}. On the phone, open:` }),
      el('div', { cls: 'mono', text: s.phone.urls.join('  or  ') || '(no Wi-Fi address found)' }),
      el('div', { cls: 'note', text: 'and type this code:' }),
      el('div', { cls: 'code', text: s.phone.pairing.code }),
      cancel,
    ]));
  } else pb.replaceChildren(el('p', { cls: 'note', text: `Phones on this Wi-Fi can open ${s.phone.urls[0] ?? '(no address found)'}. Tap "Pair a phone" next to a person.` }));
  $('devices').replaceChildren(...s.devices.map((d) => {
    const rm = el('button', { text: 'Unpair', type: 'button' });
    rm.onclick = async () => { const r = await window.bot.revokeDevice(d.id); if (r.ok) render(r.value); else say(r.error); };
    return el('li', { cls: 'row-between' }, [el('span', { text: `${d.name} (${d.memberName})` }), rm]);
  }));

  // Activity
  $('activity').replaceChildren(...s.activity.map((a) => el('li', {}, [
    el('div', { text: a.text }),
    el('div', { cls: `note st-${a.status}`, text: `${new Date(a.at).toLocaleString()} · ${a.actor} · ${a.status}` }),
  ])));
}

/** Settings fields are only filled when the panel opens, so typing is never overwritten. */
function fillSettings(s: BotState): void {
  const c = s.config;
  const set = (id: string, v: string) => { $<HTMLInputElement>(id).value = v; };
  set('cfg-obs', c.obsUrl);
  set('cfg-tw-id', c.twitchClientId);
  set('cfg-tw-channel', c.twitchChannel);
  set('bot-name', s.settings.botName);
  for (const [id, name] of [['cfg-obs-pass', 'obsPassword'], ['cfg-tw-token', 'twitchToken']] as const) {
    const input = $<HTMLInputElement>(id);
    input.value = '';
    input.placeholder = s.secrets[name] ? 'saved (type to replace, or "-" to remove)' : 'not set';
  }
  $<HTMLSelectElement>('cfg-brain').value = c.brain;
  set('cfg-api-url', c.apiUrl);
  set('cfg-api-model', c.apiModel);
  const key = $<HTMLInputElement>('cfg-api-key');
  key.value = '';
  key.placeholder = s.secrets.apiKey ? 'saved (type to replace, or "-" to remove)' : 'not set';
  set('cfg-g-id', c.googleClientId);
  const gs = $<HTMLInputElement>('cfg-g-secret');
  gs.value = '';
  gs.placeholder = s.secrets.googleClientSecret ? 'saved (type to replace, or "-" to remove)' : 'not set';
  $('gmail-note').textContent = s.secrets.googleRefresh ? 'Gmail is connected (read-only).' : 'Gmail is not connected.';
  $<HTMLInputElement>('cfg-autoconnect').checked = c.autoConnectStream;
  $<HTMLInputElement>('cfg-aimode').checked = s.aiMode;
  $<HTMLInputElement>('cfg-phone').checked = c.phoneControl;
  $<HTMLInputElement>('cfg-speak').checked = c.speakReplies;
  $('secure-note').textContent = s.secureStorage ? 'Keys and tokens are encrypted by your operating system and never shown again.' : 'This computer has no secure key storage, so keys cannot be saved here. Put them in the .env file instead.';
  showBrainNote();
}

function showBrainNote(): void {
  const choice = $<HTMLSelectElement>('cfg-brain').value;
  $('api-fields').hidden = choice !== 'api';
  const where = choice === 'api'
    ? 'Online: what you say to the bot is sent to the service you choose, so use it only if that is OK for you and your family.'
    : choice === 'off' ? 'No AI: only fixed commands like "close notepad" work.' : 'Runs on this computer, so nothing you say leaves it.';
  $('brain-note').textContent = `${where} Status: ${state?.brain.detail ?? ''}`;
}
$('cfg-brain').addEventListener('change', showBrainNote);

function render(s: BotState): void {
  state = s;
  applyLook(s);
  renderCards(s);
  if (!panel.hidden) renderPanel(s);
}

let refreshing: Promise<void> | null = null;
async function refresh(): Promise<void> {
  refreshing ??= window.bot.getState().then(render).finally(() => { refreshing = null; });
  return refreshing;
}

// ---- controls ----
$<HTMLFormElement>('ask-form').addEventListener('submit', (e) => { e.preventDefault(); const t = ask.value; ask.value = ''; void send(t); });
$('btn-stop').addEventListener('click', () => { window.bot.stop(); });
botBtn.addEventListener('click', () => {
  botBtn.classList.remove('poke');
  void botBtn.offsetWidth;
  botBtn.classList.add('poke');
  ask.focus();
  say(state?.pending.length ? 'Something is waiting for your OK.' : 'Hi! Type below and press Enter.');
});
menuBtn.addEventListener('click', () => {
  const open = panel.hidden === true;
  panel.hidden = !open;
  menuBtn.setAttribute('aria-expanded', String(open));
  window.bot.setExpanded(open);
  if (open && state) { renderPanel(state); fillSettings(state); }
});
for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  tab.addEventListener('click', () => {
    for (const t of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll<HTMLElement>('.tab')) p.hidden = p.id !== `tab-${tab.dataset.tab}`;
    if (tab.dataset.tab === 'settings' && state) fillSettings(state);
  });
}

$('btn-gmail').addEventListener('click', async () => {
  $('gmail-note').textContent = 'Opening Google sign-in in your browser… save your client ID and secret first.';
  const r = await window.bot.connectGmail();
  if (!r.ok) { $('gmail-note').textContent = r.error; return; }
  render(r.value);
  fillSettings(r.value);
});
$('btn-connect').addEventListener('click', async () => {
  say('Connecting…');
  const r = await window.bot.connectStream();
  if (!r.ok) { say(r.error); return; }
  render(r.value);
  say(`OBS: ${r.value.stream.obs.state}. Twitch: ${r.value.stream.twitch.state}.`);
});
const chips: Array<[string, string]> = [['BRB', 'switch to BRB'], ['Gameplay', 'switch to gameplay'], ['Mute mic', 'mute mic'], ['Unmute mic', 'unmute mic'], ['Close poll', 'end poll'], ['Draw winner', 'draw winner'], ['Summary', 'summary'], ['Go live', 'go live'], ['End stream', 'end stream']];
$('stream-chips').replaceChildren(...chips.map(([label, cmd]) => { const b = el('button', { text: label, type: 'button' }); b.onclick = () => void send(cmd); return b; }));

$<HTMLFormElement>('limit-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const app = $<HTMLInputElement>('limit-app').value.trim();
  const min = Number($<HTMLInputElement>('limit-min').value);
  if (app && min > 0) void send(`limit ${app} to ${min} minutes`);
});
$<HTMLFormElement>('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.bot.addMember($<HTMLInputElement>('member-name').value, $<HTMLSelectElement>('member-role').value as Role);
  if (!r.ok) { say(r.error); return; }
  $<HTMLInputElement>('member-name').value = '';
  render(r.value);
});

$('btn-save').addEventListener('click', async () => {
  const status = $('save-status');
  status.textContent = 'Saving…';
  const v = (id: string) => $<HTMLInputElement>(id).value;
  const c = (id: string) => $<HTMLInputElement>(id).checked;
  let r = await window.bot.updateConfig({
    obsUrl: v('cfg-obs'),
    brain: v('cfg-brain') as 'default' | 'light' | 'api' | 'off', apiUrl: v('cfg-api-url'), apiModel: v('cfg-api-model'), googleClientId: v('cfg-g-id'),
    twitchClientId: v('cfg-tw-id'), twitchChannel: v('cfg-tw-channel'), autoConnectStream: c('cfg-autoconnect'), phoneControl: c('cfg-phone'), speakReplies: c('cfg-speak'),
  });
  for (const [id, name] of [['cfg-obs-pass', 'obsPassword'], ['cfg-tw-token', 'twitchToken'], ['cfg-api-key', 'apiKey'], ['cfg-g-secret', 'googleClientSecret']] as const) {
    const typed = v(id).trim();
    if (r.ok && typed) r = await window.bot.setSecret(name, typed === '-' ? '' : typed);
  }
  if (r.ok && c('cfg-aimode') !== r.value.aiMode) r = await window.bot.setAiMode(c('cfg-aimode'));
  if (!r.ok) { status.textContent = r.error; return; }
  render(r.value);
  fillSettings(r.value);
  status.textContent = r.value.phone.error ? `Saved, but phone control: ${r.value.phone.error}` : 'Saved.';
});
$('btn-quit').addEventListener('click', () => window.bot.quit());

// ---- look ----
$<HTMLFormElement>('name-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await window.bot.setBotName($<HTMLInputElement>('bot-name').value);
  if (r.ok) { render(r.value); say(`I'm ${r.value.settings.botName} now!`); } else say(r.error);
});
$('btn-add').addEventListener('click', async () => { const r = await window.bot.pickImage(); if (r.ok) { render(r.value); say('Nice look!'); } else say(r.error); });
$('btn-reset').addEventListener('click', async () => { const r = await window.bot.resetImage(); if (r.ok) render(r.value); else say(r.error); });
$('btn-quiet').addEventListener('click', async () => { const r = await window.bot.setQuiet(!state?.settings.quiet); if (r.ok) render(r.value); else say(r.error); });
$('btn-bg').addEventListener('click', async () => {
  if (!state?.settings.imageUrl) { say('Add or search for an image first. The built-in cat has no background.'); return; }
  try {
    const img = new Image();
    img.src = state.settings.imageUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not edit the image.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = removeBackgroundPixels(data.data, canvas.width, canvas.height, 40);
    if (out.removed === 0) { say(out.reason ?? 'Nothing to remove.'); return; }
    ctx.putImageData(data, 0, 0);
    const r = await window.bot.saveProcessedImage(canvas.toDataURL('image/png'));
    if (r.ok) { render(r.value); say('Background removed!'); } else say(r.error);
  } catch (e) {
    say(e instanceof Error ? e.message : 'Could not remove the background.');
  }
});
$<HTMLFormElement>('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const results = $('results');
  const status = $('search-status');
  results.replaceChildren();
  status.textContent = 'Searching…';
  const r = await window.bot.searchImages($<HTMLInputElement>('search-input').value);
  if (!r.ok) { status.textContent = r.error; return; }
  if (r.value.length === 0) { status.textContent = 'No images found. Try other words.'; return; }
  status.textContent = 'Tap an image to use it. Check each license before sharing.';
  for (const item of r.value) {
    const b = el('button', { cls: 'result', type: 'button' });
    b.title = `${item.title}${item.creator ? ` by ${item.creator}` : ''} (${item.license})`;
    const img = el('img');
    img.src = item.thumbnail;
    img.alt = item.title;
    img.loading = 'lazy';
    b.append(img, el('span', { text: item.license }));
    b.onclick = async () => {
      status.textContent = 'Downloading…';
      const used = await window.bot.useSearchImage(item);
      if (used.ok) { render(used.value); status.textContent = 'Done! Try "Remove bg" for a plain background.'; } else status.textContent = used.error;
    };
    results.append(b);
  }
});

// ---- events from the bot ----
window.bot.onEvent((e) => {
  if (e.type === 'say') { say(e.text, 7000); speak(e.text); }
  void refresh();
});

void refresh().then(() => {
  if (!state) return;
  const b = state.brain;
  const extra = b.state === 'downloading' || b.state === 'missing' ? 'I\'m finishing setting up my brain. Simple commands work already.' : 'Ask me anything.';
  say(`Hi, I'm ${state.settings.botName}! ${extra}`);
});
