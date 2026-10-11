// The app shell: sidebar + Claude-style chat, approvals, family, memory, activity and money views.

const NAV: Array<[typeof state.view, string]> = [
  ['chat', 'Chat'], ['approvals', 'Approvals'], ['family', 'Family'], ['memory', 'Memory'], ['activity', 'Activity'], ['money', 'Money'],
];

function approvalCard(a: { id: string; summary: string; risk: string; status: string; canDecide: boolean; error?: string | null }, onChange?: () => void): HTMLElement {
  const status = h('span', { class: `status ${a.status}` }, a.status);
  const card = h('div', { class: `approval risk-${a.risk}` },
    h('div', { class: 'approval-top' }, h('span', { class: 'risk' }, a.risk === 'money' ? 'Money' : `${a.risk} risk`), status),
    h('p', {}, a.summary));
  if (a.error) card.append(h('p', { class: 'error-text' }, a.error));
  if (a.status === 'pending' && a.canDecide) {
    const approve = h('button', { type: 'button', class: 'primary' }, 'Approve');
    const reject = h('button', { type: 'button' }, 'Reject');
    const decideFn = (d: 'approve' | 'reject', btn: HTMLButtonElement) => busy(btn, async () => {
      const r = await api<{ status: string; message: string }>('POST', `/approvals/${a.id}/${d}`);
      status.className = `status ${r.status}`;
      status.textContent = r.status;
      approve.remove(); reject.remove();
      card.append(h('p', { class: r.status === 'verified' ? 'ok-text' : 'muted' }, r.message));
      onChange?.();
    });
    approve.addEventListener('click', () => void decideFn('approve', approve));
    reject.addEventListener('click', () => void decideFn('reject', reject));
    card.append(h('div', { class: 'row' }, approve, reject));
  } else if (a.status === 'pending') {
    card.append(h('p', { class: 'muted' }, 'Waiting for an adult or admin to approve.'));
  }
  return card;
}

function bubble(role: string, text: string): HTMLElement {
  return h('div', { class: `msg ${role}` }, h('div', { class: 'body' }, text));
}

async function chatView(main: HTMLElement): Promise<void> {
  const me = state.me!;
  const log = h('div', { class: 'log', 'aria-live': 'polite' });
  const input = h('textarea', { rows: '1', maxlength: '2000', placeholder: `Message ${me.aiName}...`, 'aria-label': 'Message' });
  const send = h('button', { type: 'submit', class: 'send', 'aria-label': 'Send' }, '↑');
  const form = h('form', { class: 'composer' }, input, send);
  const note = h('p', { class: 'fine' }, `${me.aiName} asks before doing anything risky. Money always needs approval.`);
  main.replaceChildren(h('div', { class: 'chat' }, log, h('div', { class: 'composer-wrap' }, form, note)));

  const history = await api<Array<{ role: string; content: string }>>('GET', '/chat/messages');
  if (history.length === 0) {
    log.append(h('div', { class: 'hello' }, h('span', { class: 'mark big', 'aria-hidden': 'true' }),
      h('h1', {}, `Hi ${me.member?.nickname ?? me.displayName ?? ''}, I'm ${me.aiName}.`),
      h('p', { class: 'muted' }, 'Try: "spent 600 on groceries", "remember for family the wifi password is on the fridge", "remind me to call the plumber".')));
  }
  for (const m of history) log.append(bubble(m.role, m.content));
  log.scrollTop = log.scrollHeight;

  input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 200)}px`; });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    log.querySelector('.hello')?.remove();
    log.append(bubble('user', text));
    input.value = '';
    input.style.height = 'auto';
    const thinking = h('div', { class: 'msg assistant thinking' }, h('div', { class: 'body' }, 'Thinking…'));
    log.append(thinking);
    log.scrollTop = log.scrollHeight;
    void busy(send, async () => {
      try {
        const r = await api<{ reply: string; outcomes: Outcome[] }>('POST', '/chat', { message: text });
        thinking.replaceWith(bubble('assistant', r.reply));
        for (const o of r.outcomes) {
          if (o.kind === 'needs_approval' && o.approvalId) {
            const list = await api<Approval[]>('GET', '/approvals');
            const a = list.find((x) => x.id === o.approvalId);
            if (a) log.append(approvalCard(a, () => void refreshBadge()));
          }
        }
        void refreshBadge();
      } catch (err) {
        thinking.replaceWith(h('div', { class: 'msg error' }, h('div', { class: 'body' }, errorText(err))));
      }
      log.scrollTop = log.scrollHeight;
    });
  });
  input.focus();
}

async function approvalsView(main: HTMLElement): Promise<void> {
  const list = await api<Approval[]>('GET', '/approvals');
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Approvals'),
    list.length ? h('div', { class: 'stack' }, ...list.map((a) => approvalCard(a, () => void refreshBadge()))) : h('p', { class: 'muted' }, 'Nothing is waiting for approval.')));
}

async function familyView(main: HTMLElement): Promise<void> {
  const data = await api<{ family: { name: string }; me: { id: string; role: string }; members: Array<{ id: string; role: string; nickname: string | null; displayName: string | null; canManage: boolean }> }>('GET', '/family');
  const rows = data.members.map((m) => {
    const row = h('li', { class: 'person' }, h('span', { class: 'avatar', 'aria-hidden': 'true' }, (m.nickname ?? m.displayName ?? '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'grow' }, h('strong', {}, m.nickname ?? m.displayName ?? 'Member'), m.id === data.me.id ? h('span', { class: 'muted' }, ' (you)') : null),
      h('span', { class: 'tag' }, m.role));
    if (m.canManage) {
      const remove = h('button', { type: 'button', class: 'small' }, 'Remove');
      remove.addEventListener('click', () => void busy(remove, async () => { await api('DELETE', `/family/members/${m.id}`); await familyView(main); }));
      row.append(remove);
    }
    return row;
  });
  const role = h('select', {}, ...['adult', 'teen', 'child', 'elder', 'guest', ...(data.me.role === 'owner' ? ['admin'] : [])].map((r) => h('option', { value: r }, r)));
  const invite = h('button', { type: 'button', class: 'primary' }, 'Create invite code');
  const out = h('div', { class: 'invite-out' });
  invite.addEventListener('click', () => void busy(invite, async () => {
    const r = await api<{ code: string; role: string }>('POST', '/family/invites', { role: role.value });
    out.replaceChildren(h('p', {}, 'Share this code (works once, for 7 days): '), h('code', { class: 'code' }, r.code));
  }));
  const canInvite = data.me.role === 'owner' || data.me.role === 'admin';
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, data.family.name), h('ul', { class: 'people' }, ...rows),
    canInvite ? h('div', { class: 'card inline' }, h('h2', {}, 'Invite someone'), h('div', { class: 'row' }, role, invite), out) : null));
}

async function memoryView(main: HTMLElement): Promise<void> {
  const items = await api<Array<{ id: string; text: string; scope: string; mine: boolean; createdAt: number }>>('GET', '/records/memories');
  const admin = state.me?.member?.role === 'owner' || state.me?.member?.role === 'admin';
  const list = items.map((m) => {
    const del = h('button', { type: 'button', class: 'small' }, 'Delete');
    del.addEventListener('click', () => void busy(del, async () => { await api('DELETE', `/records/memories/${m.id}`); await memoryView(main); }));
    return h('li', { class: 'memory' }, h('span', { class: `tag scope-${m.scope}` }, m.scope), h('span', { class: 'grow' }, m.text), del);
  });
  const vaultBtn = h('button', { type: 'button' }, 'Open deleted-items vault');
  const vaultOut = h('div', {});
  vaultBtn.addEventListener('click', () => void busy(vaultBtn, async () => {
    const v = await api<Array<{ kind: string; payload: { text?: string }; deletedAt: string }>>('GET', '/records/vault');
    vaultOut.replaceChildren(h('p', { class: 'muted' }, 'Opening the vault is logged, and the owners are told.'),
      v.length ? h('ul', { class: 'plain' }, ...v.map((i) => h('li', {}, `${formatTime(i.deletedAt)} · ${i.kind}: ${i.payload.text ?? ''}`))) : h('p', {}, 'The vault is empty.'));
  }));
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Memory'),
    items.length ? h('ul', { class: 'memories' }, ...list) : h('p', { class: 'muted' }, 'Nothing saved yet. Say "remember that ..." in chat.'),
    admin ? h('div', { class: 'card inline' }, h('h2', {}, 'Vault'), vaultBtn, vaultOut) : null));
}

async function activityView(main: HTMLElement): Promise<void> {
  const items = await api<Array<{ summary: string; createdAt: string }>>('GET', '/records/activity');
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Activity'),
    h('ul', { class: 'feed' }, ...items.map((a) => h('li', {}, h('time', {}, formatTime(a.createdAt)), h('span', {}, a.summary))))));
}

async function moneyView(main: HTMLElement, period = 'month'): Promise<void> {
  const s = await api<{ totalMinor: number; count: number; byCategory: Record<string, number> }>('GET', `/records/money/summary?period=${period}`);
  const tabs = h('div', { class: 'tabs', role: 'tablist' }, ...[['today', 'Today'], ['month', 'This month'], ['3months', '3 months'], ['year', 'This year']].map(([k, label]) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': String(k === period) }, label!);
    b.addEventListener('click', () => void moneyView(main, k!));
    return b;
  }));
  const max = Math.max(1, ...Object.values(s.byCategory));
  const bars = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]).map(([cat, v]) => {
    const fill = h('div', { class: 'fill' });
    fill.style.width = `${Math.round((v / max) * 100)}%`;
    return h('li', {}, h('span', { class: 'cat' }, cat), h('div', { class: 'bar' }, fill), h('span', { class: 'amt' }, rupees(v)));
  });
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Money'), tabs,
    h('p', { class: 'total' }, rupees(s.totalMinor)), h('p', { class: 'muted' }, `${s.count} expense${s.count === 1 ? '' : 's'}`),
    bars.length ? h('ul', { class: 'bars' }, ...bars) : h('p', { class: 'muted' }, 'No spending yet. Say "spent 600 on groceries" in chat.')));
}

async function refreshBadge(): Promise<void> {
  const badge = document.getElementById('approvals-badge');
  if (!badge) return;
  try {
    const list = await api<Approval[]>('GET', '/approvals');
    const n = list.filter((a) => a.canDecide).length;
    badge.textContent = n ? String(n) : '';
    badge.hidden = n === 0;
  } catch { /* ignore */ }
}

function shell(): void {
  const me = state.me!;
  const main = h('main', { class: 'main', id: 'main' });
  const links = NAV.map(([key, label]) => {
    const b = h('button', { type: 'button', class: 'nav', 'aria-current': String(state.view === key) }, label,
      key === 'approvals' ? h('span', { class: 'badge', id: 'approvals-badge', hidden: true }) : null);
    b.addEventListener('click', () => { state.view = key; shell(); });
    return b;
  });
  const logout = h('button', { type: 'button', class: 'link' }, 'Log out');
  logout.addEventListener('click', () => void busy(logout, async () => { await api('POST', '/auth/logout'); state.me = null; void start(); }));
  mount(h('div', { class: 'layout' },
    h('aside', { class: 'sidebar' }, h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'Family AI'),
      h('nav', {}, ...links), h('div', { class: 'who' }, h('strong', {}, me.member?.nickname ?? me.displayName ?? ''), h('span', { class: 'muted' }, me.member?.role ?? ''), logout)),
    main));
  const views = { chat: chatView, approvals: approvalsView, family: familyView, memory: memoryView, activity: activityView, money: moneyView };
  views[state.view](main).catch((e) => main.replaceChildren(h('p', { class: 'error-text page' }, errorText(e))));
  void refreshBadge();
}

async function start(): Promise<void> {
  try {
    const me = await loadMe();
    if (!me) authScreen(() => void start());
    else if (!me.onboarded || !me.member) onboardingScreen(() => void start());
    else shell();
  } catch (e) {
    mount(h('main', { class: 'center' }, h('p', { class: 'error-text' }, `Could not reach the server: ${errorText(e)}`)));
  }
}

void start();
