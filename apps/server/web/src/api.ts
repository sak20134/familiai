// Talks to the server and holds the small amount of app state. Plain script (no modules).

interface Profile {
  id: string;
  email: string;
  displayName: string | null;
  aiName: string;
  birthYear: number | null;
  ageMode: string | null;
  botLook: string | null;
  botRole: string | null;
  onboarded: boolean;
  aiMode: boolean;
  twinOptIn: boolean;
  aliases: string[];
  wakePhrases: string[];
  member: { id: string; familyId: string; role: string; nickname: string | null; phone: string | null } | null;
}

interface Outcome {
  kind: 'done' | 'failed' | 'needs_approval';
  tool: string;
  text?: string;
  approvalId?: string;
  summary?: string;
}

interface Approval {
  id: string;
  tool: string;
  risk: string;
  summary: string;
  status: string;
  error: string | null;
  canDecide: boolean;
  createdAt: string;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function api<T>(method: string, path: string, data?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: data !== undefined || method !== 'GET' ? { 'content-type': 'application/json' } : {},
    ...(data !== undefined || method !== 'GET' ? { body: JSON.stringify(data ?? {}) } : {}),
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | null)?.error ?? `Request failed (${res.status}).`;
    throw new ApiError(res.status, msg);
  }
  return json as T;
}

type View = 'chat' | 'voice' | 'coder' | 'learn' | 'twin' | 'hub' | 'timeline' | 'approvals' | 'family' | 'memory' | 'activity' | 'money' | 'settings';

const state = {
  me: null as Profile | null,
  view: 'chat' as View,
};

interface TurnReply {
  reply: string;
  outcomes: Outcome[];
  demo: boolean;
}

/** One chat turn in any of the five modes. */
function sendTurn(message: string, mode: string, twinOf?: string): Promise<TurnReply> {
  return api<TurnReply>('POST', '/chat', { message, mode, ...(twinOf ? { twinOf } : {}) });
}

function loadThread(mode: string): Promise<Array<{ role: string; content: string }>> {
  return api<Array<{ role: string; content: string }>>('GET', `/chat/messages?mode=${mode}`);
}

async function loadMe(): Promise<Profile | null> {
  try {
    state.me = await api<Profile>('GET', '/me');
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) state.me = null;
    else throw e;
  }
  return state.me;
}
