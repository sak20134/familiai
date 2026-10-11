// Family Hub and Settings (AI Mode, names, phone, check-ins, connections).

async function hubView(main: HTMLElement): Promise<void> {
  const d = await api<{
    moneyThisMonth: number | null; pendingApprovals: number; reminders: string[]; houseItems: number; houseDue: string[];
    members: number; checkInAlerts: number; myCheckIn: { answeredToday: boolean } | null; recent: Array<{ summary: string; createdAt: string }>;
  }>('GET', '/records/hub');
  const tile = (label: string, value: string, sub?: string) =>
    h('div', { class: 'tile' }, h('span', { class: 'tile-label' }, label), h('strong', { class: 'tile-value' }, value), sub ? h('span', { class: 'muted' }, sub) : null);
  const checkIn = d.myCheckIn
    ? (() => {
        const b = h('button', { type: 'button', class: d.myCheckIn.answeredToday ? '' : 'primary' }, d.myCheckIn.answeredToday ? 'Checked in today ✓' : "I'm okay");
        b.disabled = d.myCheckIn.answeredToday;
        b.addEventListener('click', () => void busy(b, async () => { await api('POST', '/checkins/answer'); await hubView(main); }));
        return h('div', { class: 'card inline' }, h('h2', {}, 'Daily check-in'), b);
      })()
    : null;
  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Family Hub'),
    h('div', { class: 'tiles' },
      d.moneyThisMonth === null ? null : tile('Spent this month', rupees(d.moneyThisMonth)),
      tile('Waiting for approval', String(d.pendingApprovals)),
      tile('House items', String(d.houseItems), d.houseDue.length ? `Due soon: ${d.houseDue.join(', ')}` : undefined),
      tile('Family members', String(d.members)),
      d.checkInAlerts ? tile('Missed check-ins', String(d.checkInAlerts), 'See Activity') : null),
    checkIn,
    h('div', { class: 'card inline' }, h('h2', {}, 'My reminders'),
      d.reminders.length ? h('ul', { class: 'plain' }, ...d.reminders.map((r) => h('li', {}, r))) : h('p', { class: 'muted' }, 'No reminders.')),
    h('div', { class: 'card inline' }, h('h2', {}, 'Recent'),
      h('ul', { class: 'feed' }, ...d.recent.map((a) => h('li', {}, h('time', {}, formatTime(a.createdAt)), h('span', {}, a.summary)))))));
}

async function settingsView(main: HTMLElement): Promise<void> {
  const me = (await loadMe())!;
  const role = me.member?.role ?? '';
  const canAiMode = ['owner', 'admin', 'adult', 'elder'].includes(role);
  const isAdmin = role === 'owner' || role === 'admin';

  // AI Mode
  const aiToggle = h('input', { type: 'checkbox', id: 'aimode' });
  aiToggle.checked = me.aiMode;
  aiToggle.disabled = !canAiMode;
  aiToggle.addEventListener('change', () => void busy(null, async () => {
    try {
      await api('PATCH', '/me', { aiMode: aiToggle.checked });
      toast(aiToggle.checked ? 'AI Mode on. Money and calls still always ask.' : 'AI Mode off.');
    } catch (e) { aiToggle.checked = !aiToggle.checked; throw e; }
  }));

  // Names and phone
  const aiName = h('input', { type: 'text', maxlength: '30', value: me.aiName });
  const aliases = h('input', { type: 'text', maxlength: '160', value: me.aliases.join(', '), placeholder: 'e.g. Buddy, Jarvis' });
  const nick = h('input', { type: 'text', maxlength: '40', value: me.member?.nickname ?? '' });
  const phone = h('input', { type: 'tel', maxlength: '16', value: me.member?.phone ?? '', placeholder: '+919876543210' });
  const save = h('button', { type: 'button', class: 'primary' }, 'Save');
  const phrases = h('p', { class: 'muted' }, `Wake words: ${me.wakePhrases.join(', ')}`);
  save.addEventListener('click', () => void busy(save, async () => {
    const list = aliases.value.split(',').map((s) => s.trim()).filter(Boolean);
    const p = await api<Profile>('PATCH', '/me', {
      aiName: aiName.value.trim(), aliases: list, ...(nick.value.trim() ? { nickname: nick.value.trim() } : {}),
      ...(phone.value.trim() ? { phone: phone.value.trim() } : {}),
    });
    phrases.textContent = `Wake words: ${p.wakePhrases.join(', ')}`;
    toast('Saved.');
  }));

  // Connections
  const conns = await api<{ googleConfigured: boolean; connections: Array<{ id: string; provider: string; accountLabel: string; status: string }> }>('GET', '/connections');
  const live = conns.connections.filter((x) => x.status !== 'revoked');
  const connList = h('ul', { class: 'people' }, ...live.map((x) => {
    const revoke = h('button', { type: 'button', class: 'small' }, 'Disconnect');
    revoke.addEventListener('click', () => void busy(revoke, async () => { await api('DELETE', `/connections/${x.id}`); await settingsView(main); }));
    return h('li', { class: 'person' }, h('strong', { class: 'grow' }, `Google · ${x.accountLabel}`), h('span', { class: `tag` }, x.status), revoke);
  }));
  const connect = h('button', { type: 'button', class: 'primary', disabled: !conns.googleConfigured }, 'Connect Google Calendar');
  connect.addEventListener('click', () => void busy(connect, async () => {
    const r = await api<{ url: string }>('POST', '/connections/google/start');
    window.location.href = r.url;
  }));

  // Check-in plans (admins)
  let checkins: HTMLElement | null = null;
  if (isAdmin) {
    const fam = await api<{ members: Array<{ id: string; nickname: string | null; displayName: string | null; role: string }> }>('GET', '/family');
    const who = h('select', {}, ...fam.members.map((m) => h('option', { value: m.id }, m.nickname ?? m.displayName ?? m.role)));
    const time = h('input', { type: 'time', value: '09:00' });
    const set = h('button', { type: 'button', class: 'primary' }, 'Set daily check-in');
    set.addEventListener('click', () => void busy(set, async () => {
      const [hh, mm] = time.value.split(':').map(Number);
      await api('PUT', `/checkins/${who.value}`, { hour: hh, minute: mm, utcOffsetMinutes: -new Date().getTimezoneOffset(), graceMinutes: 30, enabled: true });
      toast('Check-in saved. Missed check-ins remind, then alert admins, then raise an emergency.');
    }));
    checkins = h('div', { class: 'card inline' }, h('h2', {}, 'Daily check-ins'),
      h('p', { class: 'muted' }, 'Family AI checks on someone every day. If they miss it, it reminds them, then tells admins, then raises an emergency.'),
      h('div', { class: 'row' }, who, time, set));
  }

  main.replaceChildren(h('section', { class: 'page' }, h('h1', {}, 'Settings'),
    h('div', { class: 'card inline' }, h('h2', {}, 'AI Mode'),
      h('label', { class: 'row', for: 'aimode' }, aiToggle, h('span', {}, 'Let the AI do everyday tasks without asking each time')),
      h('p', { class: 'muted' }, canAiMode ? 'Payments, calls and other high-risk actions still always ask you first.' : 'Ask a parent or family admin. AI Mode is for adults.')),
    h('div', { class: 'card inline' }, h('h2', {}, 'Names and phone'),
      field('What you call me', aiName), field('Other names I answer to (comma separated)', aliases), phrases,
      field('What I call you', nick), field('Your phone (for calls and check-ins)', phone), save),
    h('div', { class: 'card inline' }, h('h2', {}, 'Connections'),
      live.length ? connList : h('p', { class: 'muted' }, 'Nothing connected yet.'),
      conns.googleConfigured ? connect : h('p', { class: 'muted' }, 'Google is not set up on this server yet (see README).')),
    checkins));
}

/** After returning from Google, show what happened. */
function connectNotice(): void {
  const r = new URLSearchParams(location.search).get('connect');
  if (!r) return;
  const messages: Record<string, string> = {
    google: 'Google Calendar connected.', cancelled: 'Google connection cancelled.', expired: 'That Google sign-in link expired. Try again.',
    failed: 'Google connection failed. Try again.', 'not-configured': 'Google is not set up on this server.',
  };
  toast(messages[r] ?? 'Done.', r === 'google' ? 'info' : 'error');
  history.replaceState(null, '', '/');
}
