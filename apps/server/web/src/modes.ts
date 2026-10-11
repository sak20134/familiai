// The other four modes (Voice, Coder, Learn, Twin) and the Family Memory Timeline.
// Voice is the golden-globe screen; text Chat stays plain, with no globe.

// --- Speech (built into the browser; the app still works without it) -------------------------

interface SpeechResultLike { 0?: { transcript?: string } }
interface Recognizer {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<SpeechResultLike> }) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

function newRecognizer(continuous: boolean): Recognizer | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognizer; webkitSpeechRecognition?: new () => Recognizer };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const r = new Ctor();
  r.lang = navigator.language || 'en-IN';
  r.continuous = continuous;
  r.interimResults = false;
  return r;
}

function speak(text: string): void {
  try {
    if (!('speechSynthesis' in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || 'en-IN';
    speechSynthesis.speak(u);
  } catch { /* speaking is a bonus, never required */ }
}

/** Did they say one of the wake phrases? (The server strips it before the AI sees it.) */
function heardWake(text: string, phrases: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return phrases.some((p) => p.trim() && lower.includes(p.trim().toLowerCase()));
}

// --- Voice mode: the golden glowing globe ---------------------------------------------------

async function voiceView(main: HTMLElement): Promise<void> {
  const me = state.me!;
  const globe = h('button', { class: 'globe', type: 'button', 'data-state': 'idle', 'aria-label': `Talk to ${me.aiName}` },
    h('span', { class: 'globe-core', 'aria-hidden': 'true' }), h('span', { class: 'globe-ring', 'aria-hidden': 'true' }));
  const status = h('p', { class: 'voice-state', 'aria-live': 'polite' }, 'Tap the globe and talk');
  const said = h('p', { class: 'voice-said' });
  const reply = h('p', { class: 'voice-reply' });
  const hands = h('input', { type: 'checkbox', id: 'handsfree' });
  const typed = h('input', { type: 'text', maxlength: '2000', placeholder: `Type to ${me.aiName} instead` });
  const sendBtn = h('button', { type: 'button', class: 'primary' }, 'Send');
  const history = h('div', { class: 'voice-history' });

  const setState = (s: 'idle' | 'listening' | 'thinking' | 'speaking', label: string) => {
    globe.dataset.state = s;
    status.textContent = label;
  };

  let rec: Recognizer | null = null;
  const stopListening = () => { try { rec?.stop(); } catch { /* already stopped */ } rec = null; };

  async function ask(text: string): Promise<void> {
    said.textContent = `You: ${text}`;
    reply.textContent = '';
    setState('thinking', 'Thinking…');
    try {
      const r = await sendTurn(text, 'voice');
      reply.textContent = r.reply;
      history.prepend(h('div', { class: 'voice-turn' }, h('span', { class: 'muted' }, text), h('span', {}, r.reply)));
      setState('speaking', `${me.aiName} is speaking`);
      speak(r.reply);
      setTimeout(() => setState('idle', 'Tap the globe and talk'), Math.min(12000, 1200 + r.reply.length * 55));
      void refreshBadge();
    } catch (e) {
      reply.textContent = errorText(e);
      setState('idle', 'Tap the globe and talk');
    }
  }

  function listen(): void {
    const continuous = hands.checked;
    rec = newRecognizer(continuous);
    if (!rec) {
      setState('idle', 'This browser cannot listen. Type below instead.');
      return;
    }
    rec.onresult = (e) => {
      const last = e.results[e.results.length - 1];
      const text = (last?.[0]?.transcript ?? '').trim();
      if (!text) return;
      if (continuous && !heardWake(text, me.wakePhrases)) {
        status.textContent = `Say "${me.wakePhrases[0] ?? 'hey ' + me.aiName.toLowerCase()}" to wake me`;
        return;
      }
      if (!continuous) stopListening();
      void ask(text);
    };
    rec.onerror = (e) => setState('idle', e.error === 'not-allowed' ? 'Microphone blocked. Allow it in your browser.' : 'I did not catch that.');
    rec.onend = () => { if (globe.dataset.state === 'listening' && !continuous) setState('idle', 'Tap the globe and talk'); };
    setState('listening', continuous ? `Hands-free: say "${me.wakePhrases[0] ?? 'hey ' + me.aiName.toLowerCase()}"` : 'Listening…');
    try {
      rec.start();
    } catch {
      setState('idle', 'Could not start the microphone.');
    }
  }

  globe.addEventListener('click', () => {
    if (globe.dataset.state === 'listening') { stopListening(); setState('idle', 'Stopped.'); return; }
    speechSynthesis?.cancel();
    listen();
  });
  hands.addEventListener('change', () => { stopListening(); if (hands.checked) listen(); else setState('idle', 'Tap the globe and talk'); });
  const sendTyped = () => {
    const text = typed.value.trim();
    if (!text) return;
    typed.value = '';
    void busy(sendBtn, () => ask(text));
  };
  sendBtn.addEventListener('click', sendTyped);
  typed.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') sendTyped(); });

  main.replaceChildren(h('section', { class: 'voice' },
    h('div', { class: 'globe-stage' }, globe),
    status, said, reply,
    h('label', { class: 'row voice-hands', for: 'handsfree' }, hands, h('span', {}, `Hands-free (wake word: ${me.wakePhrases.join(' / ')})`)),
    h('div', { class: 'row voice-type' }, h('div', { class: 'grow' }, typed), sendBtn),
    h('p', { class: 'fine' }, 'Money and calls still ask you first, every time.'),
    history));

  const past = await loadThread('voice');
  for (const m of past.slice(-6).reverse()) {
    if (m.role === 'assistant') history.append(h('div', { class: 'voice-turn' }, h('span', {}, m.content)));
  }
}

// --- Coder mode: Codex-style dark workspace -------------------------------------------------

/** Splits a reply into plain text and fenced code blocks. Code always goes in as text, never HTML. */
function codeParts(text: string): Array<{ code: boolean; lang: string; body: string }> {
  const out: Array<{ code: boolean; lang: string; body: string }> = [];
  const re = /```([\w+-]*)\n?([\s\S]*?)```/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ code: false, lang: '', body: text.slice(at, m.index) });
    out.push({ code: true, lang: m[1] ?? '', body: m[2] ?? '' });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ code: false, lang: '', body: text.slice(at) });
  return out.filter((p) => p.body.trim().length > 0);
}

function codeBubble(role: string, text: string): HTMLElement {
  const body = h('div', { class: 'body' });
  for (const part of codeParts(text)) {
    if (!part.code) { body.append(h('p', {}, part.body.trim())); continue; }
    const copy = h('button', { type: 'button', class: 'small' }, 'Copy');
    copy.addEventListener('click', () => void navigator.clipboard?.writeText(part.body).then(() => toast('Copied.'), () => toast('Could not copy.', 'error')));
    body.append(h('div', { class: 'codeblock' },
      h('div', { class: 'codebar' }, h('span', { class: 'muted' }, part.lang || 'code'), copy),
      h('pre', {}, h('code', {}, part.body.replace(/\s+$/, '')))));
  }
  return h('div', { class: `msg ${role}` }, body);
}

/** One chat thread for a mode, with its own log and composer. */
function thread(opts: {
  mode: string; placeholder: string; hello: HTMLElement; bubbleFor?: (role: string, text: string) => HTMLElement;
  twinOf?: string; onSent?: () => void;
}): HTMLElement {
  const make = opts.bubbleFor ?? bubble;
  const log = h('div', { class: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: '1', maxlength: '2000', placeholder: opts.placeholder, 'aria-label': 'Message' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, '↑');
  const form = h('form', { class: 'composer' }, input, send);
  log.append(opts.hello);

  void loadThread(opts.mode).then((past) => {
    if (past.length > 0) opts.hello.remove();
    for (const m of past) log.append(make(m.role, m.content));
    log.scrollTop = log.scrollHeight;
  }, () => { /* an empty thread is fine */ });

  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    opts.hello.remove();
    log.append(make('user', text));
    input.value = '';
    input.style.height = 'auto';
    const thinking = h('div', { class: 'msg assistant thinking' }, h('div', { class: 'body' }, 'Thinking…'));
    log.append(thinking);
    log.scrollTop = log.scrollHeight;
    void busy(send, async () => {
      try {
        const r = await sendTurn(text, opts.mode, opts.twinOf);
        thinking.replaceWith(make('assistant', r.reply));
        opts.onSent?.();
        void refreshBadge();
      } catch (err) {
        thinking.replaceWith(h('div', { class: 'msg error' }, h('div', { class: 'body' }, errorText(err))));
      }
      log.scrollTop = log.scrollHeight;
    });
  });
  setTimeout(() => input.focus(), 0);
  return h('div', { class: 'chat' }, log, h('div', { class: 'composer-wrap' }, form));
}

function coderView(main: HTMLElement): Promise<void> {
  const hello = h('div', { class: 'hello' }, h('h1', {}, 'Coder'),
    h('p', { class: 'muted' }, 'Ask for code, fixes or an explanation. This mode has no tools, so nothing here can touch your family data, money or calls.'));
  main.replaceChildren(h('section', { class: 'coder' }, thread({ mode: 'coder', placeholder: 'Describe what you want to build…', hello, bubbleFor: codeBubble })));
  return Promise.resolve();
}

// --- Learn mode: Kids Learning Coach --------------------------------------------------------

async function learnView(main: HTMLElement): Promise<void> {
  const d = await api<{ streak: number; sessions: number; topics: Array<{ text: string; at: string }> }>('GET', '/records/learning');
  const streak = h('strong', { class: 'tile-value' }, String(d.streak));
  const hello = h('div', { class: 'hello' }, h('h1', {}, 'Learning Coach'),
    h('p', { class: 'muted' }, 'Ask about anything you are learning. I give hints first, not answers — then we check it together.'));
  const chips = h('div', { class: 'tabs' }, ...d.topics.slice(0, 8).map((t) => h('span', { class: 'tag' }, t.text)));
  main.replaceChildren(h('section', { class: 'learn' },
    h('div', { class: 'learn-top' },
      h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, 'Day streak'), streak),
      h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, 'Sessions'), h('strong', { class: 'tile-value' }, String(d.sessions))),
      d.topics.length ? h('div', { class: 'grow' }, h('span', { class: 'tile-label' }, 'Recently'), chips) : null),
    thread({
      mode: 'learn', placeholder: 'What are we learning today?', hello,
      onSent: () => { streak.textContent = String(Math.max(1, d.streak)); },
    })));
}

// --- Family Twin ----------------------------------------------------------------------------

async function twinView(main: HTMLElement): Promise<void> {
  const d = await api<{ mine: boolean; people: Array<{ id: string; name: string }> }>('GET', '/family/twin');
  const note = h('p', { class: 'muted' }, 'A twin only uses what that person chose to SHARE with the family. Private notes are never used, and answers are a guess, not them.');
  if (d.people.length === 0) {
    main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Family Twin'), note,
      h('p', {}, 'Nobody has switched their twin on yet. Each person can turn theirs on in Settings.')));
    return;
  }
  const who = h('select', {}, ...d.people.map((p) => h('option', { value: p.id }, p.name)));
  const panel = h('div', { class: 'twin-panel' });
  const open = (id: string) => {
    const name = d.people.find((p) => p.id === id)?.name ?? 'them';
    const hello = h('div', { class: 'hello' }, h('h1', {}, `Ask ${name}'s twin`),
      h('p', { class: 'muted' }, `I will guess what ${name} would probably say, from what they shared. I will say so every time.`));
    panel.replaceChildren(thread({ mode: 'twin', twinOf: id, placeholder: `Ask what ${name} would say…`, hello }));
  };
  who.addEventListener('change', () => open(who.value));
  main.replaceChildren(h('section', { class: 'twin' }, h('div', { class: 'page twin-head' }, h('h1', {}, 'Family Twin'),
    h('div', { class: 'row' }, h('span', { class: 'tile-label' }, 'Ask'), who), note), panel));
  open(who.value);
}

// --- Family Memory Timeline -----------------------------------------------------------------

const TIMELINE_LABEL: Record<string, string> = {
  memory: 'Memory', moment: 'Moment', house: 'House', money: 'Money', learning: 'Learning',
};

async function timelineView(main: HTMLElement): Promise<void> {
  const d = await api<{ total: number; months: Array<{ month: string; label: string; entries: Array<{ id: string; kind: string; text: string; at: number }> }> }>('GET', '/records/timeline');
  const months = d.months.map((m) => h('section', { class: 'tl-month' }, h('h2', {}, m.label),
    h('ul', { class: 'tl' }, ...m.entries.map((e) => h('li', { class: `tl-item kind-${e.kind}` },
      h('span', { class: 'tag' }, TIMELINE_LABEL[e.kind] ?? e.kind),
      h('span', { class: 'grow' }, e.text),
      h('time', {}, formatTime(e.at)))))));
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Timeline'),
    h('p', { class: 'muted' }, d.total ? `${d.total} things your family saved. Private notes are only in your own timeline.` : 'Nothing saved yet.'),
    ...months));
}
