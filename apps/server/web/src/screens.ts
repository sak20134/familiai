// Sign-in screen and the first-run setup questions (age first, then names, look, role, family).

function authScreen(onDone: () => void): void {
  let mode: 'login' | 'signup' = 'login';
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: '60', required: true });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true });
  const password = h('input', { type: 'password', autocomplete: 'current-password', minlength: '8', required: true });
  const nameField = field('Your name', name);
  const submit = h('button', { type: 'submit', class: 'primary wide' }, 'Log in');
  const switcher = h('button', { type: 'button', class: 'link' }, 'New here? Create an account');

  const render = () => {
    nameField.hidden = mode === 'login';
    name.required = mode === 'signup';
    password.setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
    submit.textContent = mode === 'login' ? 'Log in' : 'Create account';
    switcher.textContent = mode === 'login' ? 'New here? Create an account' : 'Have an account? Log in';
  };
  switcher.addEventListener('click', () => { mode = mode === 'login' ? 'signup' : 'login'; render(); });

  const form = h('form', { class: 'card auth' },
    h('div', { class: 'brand' }, h('span', { class: 'mark', 'aria-hidden': 'true' }), 'Family AI'),
    h('p', { class: 'muted' }, 'Your family, your memory, your helper.'),
    nameField, field('Email', email), field('Password', password), submit, switcher);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void busy(submit, async () => {
      if (mode === 'signup') await api('POST', '/auth/signup', { email: email.value, password: password.value, displayName: name.value });
      else await api('POST', '/auth/login', { email: email.value, password: password.value });
      onDone();
    });
  });
  render();
  mount(h('main', { class: 'center' }, form));
}

const LOOKS = ['Big cat', 'Small bot', 'Girl', 'Boy', 'Golden globe'];
const ROLES = ['Talking pet', 'Mom', 'Dad', 'Friend', 'Teacher', 'Butler'];

function choiceGrid(options: string[], current: string | null, pick: (v: string) => void): HTMLElement {
  const grid = h('div', { class: 'choices', role: 'radiogroup' });
  for (const o of options) {
    const b = h('button', { type: 'button', class: 'choice', role: 'radio', 'aria-checked': String(o === current) }, o);
    b.addEventListener('click', () => {
      grid.querySelectorAll('.choice').forEach((x) => x.setAttribute('aria-checked', 'false'));
      b.setAttribute('aria-checked', 'true');
      pick(o);
    });
    grid.append(b);
  }
  return grid;
}

function onboardingScreen(onDone: () => void): void {
  const me = state.me!;
  const answers = {
    birthYear: me.birthYear ?? undefined as number | undefined,
    nickname: me.member?.nickname ?? me.displayName ?? '',
    aiName: me.aiName,
    botLook: me.botLook ?? 'Big cat',
    botRole: me.botRole ?? 'Friend',
  };
  let step = 0;
  const thisYear = new Date().getFullYear();

  const steps: Array<{ title: string; body: () => HTMLElement; valid: () => string | null }> = [
    {
      title: 'First, how old are you?',
      body: () => {
        const input = h('input', { type: 'number', min: '1', max: '120', inputmode: 'numeric', value: answers.birthYear ? String(thisYear - answers.birthYear) : '' });
        input.addEventListener('input', () => { const age = Number(input.value); answers.birthYear = age > 0 && age <= 120 ? thisYear - age : undefined; });
        return h('div', {}, h('p', { class: 'muted' }, 'I talk differently to kids, teens, adults and elders.'), field('Age', input));
      },
      valid: () => (answers.birthYear ? null : 'Please enter your age.'),
    },
    {
      title: 'What should we call each other?',
      body: () => {
        const you = h('input', { type: 'text', maxlength: '40', value: answers.nickname });
        you.addEventListener('input', () => { answers.nickname = you.value; });
        const ai = h('input', { type: 'text', maxlength: '30', value: answers.aiName });
        ai.addEventListener('input', () => { answers.aiName = ai.value; });
        return h('div', {}, field('What I call you', you), field('What you call me', ai));
      },
      valid: () => (answers.nickname.trim() && answers.aiName.trim() ? null : 'Fill in both names.'),
    },
    {
      title: 'How should I look?',
      body: () => choiceGrid(LOOKS, answers.botLook, (v) => { answers.botLook = v; }),
      valid: () => null,
    },
    {
      title: 'How should I act?',
      body: () => choiceGrid(ROLES, answers.botRole, (v) => { answers.botRole = v; }),
      valid: () => null,
    },
  ];

  const familyStep = (): HTMLElement => {
    const name = h('input', { type: 'text', maxlength: '60', placeholder: 'e.g. The Kumar Family' });
    const code = h('input', { type: 'text', maxlength: '12', placeholder: 'Invite code' });
    const create = h('button', { type: 'button', class: 'primary' }, 'Create family');
    const join = h('button', { type: 'button' }, 'Join with code');
    create.addEventListener('click', () => void busy(create, async () => { await api('POST', '/family', { name: name.value }); await finish(); }));
    join.addEventListener('click', () => void busy(join, async () => { await api('POST', '/invites/accept', { code: code.value }); await finish(); }));
    return h('div', { class: 'card onboarding' },
      h('p', { class: 'step' }, 'Last step'), h('h1', {}, 'Your family'),
      h('p', { class: 'muted' }, 'Start a new family (you become the owner) or join one with an invite code.'),
      field('Family name', name), create, h('div', { class: 'or' }, 'or'), field('Invite code', code), join);
  };

  const finish = async () => {
    await api('PATCH', '/me', { ...(answers.nickname.trim() ? { nickname: answers.nickname.trim() } : {}), onboarded: true });
    onDone();
  };

  const render = () => {
    if (step >= steps.length) {
      if (state.me?.member) { void finish(); return; }
      mount(h('main', { class: 'center' }, familyStep()));
      return;
    }
    const s = steps[step]!;
    const next = h('button', { type: 'button', class: 'primary' }, step === steps.length - 1 ? 'Continue' : 'Next');
    const back = h('button', { type: 'button', disabled: step === 0 }, 'Back');
    back.addEventListener('click', () => { step--; render(); });
    next.addEventListener('click', () => void busy(next, async () => {
      const problem = s.valid();
      if (problem) { toast(problem, 'error'); return; }
      if (step === steps.length - 1) {
        state.me = await api<Profile>('PATCH', '/me', {
          birthYear: answers.birthYear, aiName: answers.aiName.trim(), botLook: answers.botLook, botRole: answers.botRole,
          ...(state.me?.member ? { nickname: answers.nickname.trim() } : {}),
        });
      }
      step++;
      render();
    }));
    mount(h('main', { class: 'center' }, h('div', { class: 'card onboarding' },
      h('p', { class: 'step' }, `Step ${step + 1} of ${steps.length + 1}`), h('h1', {}, s.title), s.body(),
      h('div', { class: 'row end' }, back, next))));
  };
  render();
}
