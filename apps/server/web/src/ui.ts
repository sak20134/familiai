// Tiny DOM helpers. Text always goes in as textContent, so nothing from the server can inject HTML.

type Child = Node | string | null | undefined | false;
type Attrs = Record<string, string | boolean | ((e: Event) => void) | undefined>;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
    else if (v === true) el.setAttribute(k, '');
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const appRoot = (): HTMLElement => document.getElementById('app')!;

function mount(...nodes: Node[]): void {
  appRoot().replaceChildren(...nodes);
}

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, message);
  document.body.append(t);
  setTimeout(() => t.remove(), 4500);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.';
}

/** Runs an async action with the button disabled, and shows errors as a toast. */
async function busy(btn: HTMLButtonElement | null, fn: () => Promise<void>): Promise<void> {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (e) {
    toast(errorText(e), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function field(label: string, input: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', {}, label), input);
}

function formatTime(iso: string | number): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function rupees(minor: number): string {
  return `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}
