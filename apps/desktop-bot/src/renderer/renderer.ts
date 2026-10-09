// The bot's screen. Uses textContent (never innerHTML) for anything that comes from outside.

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const botBtn = $<HTMLButtonElement>('bot');
const botImg = $<HTMLImageElement>('bot-img');
const botCat = document.getElementById('bot-cat') as unknown as SVGElement;
const speech = $('speech');
const chatPanel = $('chat');
const chatLog = $('chat-log');
const chatForm = $<HTMLFormElement>('chat-form');
const chatInput = $<HTMLInputElement>('chat-input');
const demoNote = $('demo-note');
const searchPanel = $('search');
const searchForm = $<HTMLFormElement>('search-form');
const searchInput = $<HTMLInputElement>('search-input');
const searchStatus = $('search-status');
const results = $('results');
const quietBtn = $<HTMLButtonElement>('btn-quiet');

let current: { imageUrl: string | null; quiet: boolean; botName: string; hasModelKey: boolean } = {
  imageUrl: null,
  quiet: false,
  botName: 'Buddy',
  hasModelKey: false,
};
let speechTimer: number | undefined;

// ---- click-through: only catch the mouse while it is over the bot or a panel ----
let interactive = false;
document.addEventListener('mousemove', (e) => {
  const target = e.target as HTMLElement | null;
  const over = Boolean(target?.closest('[data-hit]'));
  if (over !== interactive) {
    interactive = over;
    window.bot.setInteractive(over);
  }
});
document.addEventListener('mouseleave', () => {
  if (interactive) {
    interactive = false;
    window.bot.setInteractive(false);
  }
});

// ---- drawing ----
function applySettings(s: typeof current): void {
  current = s;
  if (s.imageUrl) {
    botImg.src = s.imageUrl;
    botImg.hidden = false;
    botCat.setAttribute('hidden', '');
    botCat.style.display = 'none';
  } else {
    botImg.hidden = true;
    botImg.removeAttribute('src');
    botCat.removeAttribute('hidden');
    botCat.style.display = '';
  }
  botBtn.classList.toggle('quiet', s.quiet);
  quietBtn.setAttribute('aria-pressed', String(s.quiet));
  quietBtn.textContent = s.quiet ? 'Wake up' : 'Quiet';
  demoNote.hidden = s.hasModelKey;
}

function say(text: string, ms = 3500): void {
  if (current.quiet) return;
  speech.textContent = text;
  speech.hidden = false;
  window.clearTimeout(speechTimer);
  speechTimer = window.setTimeout(() => { speech.hidden = true; }, ms);
}

function addMessage(kind: 'user' | 'bot' | 'error', text: string): void {
  const div = document.createElement('div');
  div.className = `msg ${kind}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showError(message: string): void {
  say(message, 5000);
  if (!chatPanel.hidden) addMessage('error', message);
}

function togglePanel(which: 'chat' | 'search'): void {
  const panel = which === 'chat' ? chatPanel : searchPanel;
  const other = which === 'chat' ? searchPanel : chatPanel;
  other.hidden = true;
  panel.hidden = !panel.hidden;
  if (!panel.hidden) (which === 'chat' ? chatInput : searchInput).focus();
}

// ---- actions ----
const greetings = ['Hi!', 'Meow!', 'Need something?', 'I am here.', 'Hello!'];
botBtn.addEventListener('click', () => {
  botBtn.classList.remove('poke');
  void botBtn.offsetWidth; // restart the little bounce
  botBtn.classList.add('poke');
  say(greetings[Math.floor(Math.random() * greetings.length)] ?? 'Hi!');
});

$('btn-chat').addEventListener('click', () => togglePanel('chat'));
$('btn-search').addEventListener('click', () => togglePanel('search'));

$('btn-add').addEventListener('click', async () => {
  const r = await window.bot.pickImage();
  if (r.ok) { applySettings(r.value); say('Nice look!'); } else showError(r.error);
});

$('btn-reset').addEventListener('click', async () => {
  const r = await window.bot.resetImage();
  if (r.ok) applySettings(r.value); else showError(r.error);
});

quietBtn.addEventListener('click', async () => {
  const r = await window.bot.setQuiet(!current.quiet);
  if (r.ok) applySettings(r.value); else showError(r.error);
});

$('btn-quit').addEventListener('click', () => window.bot.quit());

$('btn-bg').addEventListener('click', async () => {
  if (!current.imageUrl) { showError('Add or search for an image first. The built-in cat has no background.'); return; }
  try {
    const img = new Image();
    img.src = current.imageUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not edit the image.');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const out = removeBackgroundPixels(data.data, canvas.width, canvas.height, 40);
    if (out.removed === 0) { showError(out.reason ?? 'Nothing to remove.'); return; }
    ctx.putImageData(data, 0, 0);
    const r = await window.bot.saveProcessedImage(canvas.toDataURL('image/png'));
    if (r.ok) { applySettings(r.value); say('Background removed!'); } else showError(r.error);
  } catch (e) {
    showError(e instanceof Error ? e.message : 'Could not remove the background.');
  }
});

// Same idea as src/main/background.ts (kept here because the page cannot import the main process code).
function removeBackgroundPixels(
  rgba: Uint8ClampedArray, width: number, height: number, tolerance: number,
): { removed: number; reason?: string } {
  const tol2 = tolerance * tolerance;
  const d2 = (i: number, r: number, g: number, b: number) => {
    const dr = (rgba[i] ?? 0) - r, dg = (rgba[i + 1] ?? 0) - g, db = (rgba[i + 2] ?? 0) - b;
    return dr * dr + dg * dg + db * db;
  };
  const px = (x: number, y: number) => (y * width + x) * 4;
  const c0 = px(0, 0);
  const bg = [rgba[c0] ?? 0, rgba[c0 + 1] ?? 0, rgba[c0 + 2] ?? 0] as const;
  const corners = [c0, px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
  if (corners.some((c) => d2(c, bg[0], bg[1], bg[2]) > tol2)) {
    return { removed: 0, reason: 'The background is not one plain color, so I left it alone.' };
  }
  const seen = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0, removed = 0;
  const push = (x: number, y: number) => {
    const idx = y * width + x;
    if (seen[idx] || d2(idx * 4, bg[0], bg[1], bg[2]) > tol2) return;
    seen[idx] = 1;
    queue[tail++] = idx;
  };
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1); }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y); }
  while (head < tail) {
    const idx = queue[head++] as number;
    rgba[idx * 4 + 3] = 0;
    removed++;
    const x = idx % width, y = (idx - x) / width;
    if (x > 0) push(x - 1, y);
    if (x < width - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < height - 1) push(x, y + 1);
  }
  return { removed };
}

chatForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  addMessage('user', text);
  chatInput.disabled = true;
  const r = await window.bot.chat(text);
  chatInput.disabled = false;
  chatInput.focus();
  if (r.ok) {
    addMessage('bot', r.value.text);
    say(r.value.text, 6000);
    demoNote.hidden = !r.value.demo;
  } else {
    addMessage('error', r.error);
  }
});

searchForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  results.replaceChildren();
  searchStatus.textContent = 'Searching...';
  const r = await window.bot.searchImages(searchInput.value);
  if (!r.ok) { searchStatus.textContent = r.error; return; }
  if (r.value.length === 0) { searchStatus.textContent = 'No images found. Try other words.'; return; }
  searchStatus.textContent = 'Tap an image to use it.';
  for (const item of r.value) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'result';
    b.title = `${item.title}${item.creator ? ' by ' + item.creator : ''} (${item.license})`;
    const img = document.createElement('img');
    img.src = item.thumbnail;
    img.alt = item.title;
    img.loading = 'lazy';
    const lic = document.createElement('span');
    lic.textContent = item.license;
    b.append(img, lic);
    b.addEventListener('click', async () => {
      searchStatus.textContent = 'Downloading...';
      const used = await window.bot.useSearchImage(item);
      if (used.ok) { applySettings(used.value); searchStatus.textContent = 'Done! Try "Remove bg" for a plain background.'; say('New look!'); }
      else searchStatus.textContent = used.error;
    });
    results.appendChild(b);
  }
});

window.bot.getSettings().then((s) => {
  applySettings(s);
  say(`Hi, I'm ${s.botName}!`);
});
