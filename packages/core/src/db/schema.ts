// Step 2: database tables (Postgres via Drizzle). Every family-owned row carries family_id
// so the server can enforce "family A never sees family B" on every query.

import { bigint, boolean, index, integer, jsonb, pgTable, real, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name'),
  aiName: text('ai_name'), // what this user calls the AI
  birthYear: integer('birth_year'),
  botLook: text('bot_look'), // big cat | small bot | girl | boy | ...
  botRole: text('bot_role'), // talking pet | mom | dad | friend | ...
  onboarded: boolean('onboarded').notNull().default(false),
  /** AI Mode: the AI may do medium-risk work without asking. Money and high risk still always ask. */
  aiMode: boolean('ai_mode').notNull().default(false),
  /** Extra names the AI answers to (wake words), besides ai_name. */
  aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
  /** Family Twin: this person agreed that the AI may guess their answers from what they SHARED. */
  twinOptIn: boolean('twin_opt_in').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

/** Login sessions. Only a SHA-256 hash of the cookie token is stored, never the token itself. */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('sessions_user').on(t.userId)],
);

export const families = pgTable('families', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const members = pgTable(
  'members',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    role: text('role').notNull(), // owner | admin | adult | teen | child | elder | guest
    nickname: text('nickname'), // what the AI calls this person
    phone: text('phone'), // E.164, used for calls and check-ins
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [uniqueIndex('members_family_user').on(t.familyId, t.userId), index('members_family').on(t.familyId)],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // user | assistant | tool
    content: text('content').notNull(),
    /** Which mode this was said in: chat | voice | coder | learn | twin. Each mode keeps its own thread. */
    mode: text('mode').notNull().default('chat'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('messages_member_time').on(t.memberId, t.createdAt), index('messages_member_mode').on(t.memberId, t.mode)],
);

export const memories = pgTable(
  'memories',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    ownerId: text('owner_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(), // private | family | house
    sensitivity: text('sensitivity').notNull().default('normal'),
    text: text('text').notNull(),
    source: text('source').notNull(),
    confidence: real('confidence').notNull().default(0.8),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    expiresAt: timestamp('expires_at'),
  },
  (t) => [index('memories_family_scope').on(t.familyId, t.scope)],
);

export const invites = pgTable('invites', {
  code: text('code').primaryKey(),
  familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  createdBy: text('created_by').notNull().references(() => members.id, { onDelete: 'cascade' }),
  usedBy: text('used_by').references(() => users.id, { onDelete: 'set null' }),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const approvals = pgTable(
  'approvals',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').notNull().references(() => members.id, { onDelete: 'cascade' }),
    decidedBy: text('decided_by').references(() => members.id, { onDelete: 'set null' }),
    tool: text('tool').notNull(),
    risk: text('risk').notNull(),
    summary: text('summary').notNull(),
    args: jsonb('args').notNull(),
    status: text('status').notNull().default('pending'),
    result: jsonb('result'),
    error: text('error'),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    decidedAt: timestamp('decided_at'),
  },
  (t) => [index('approvals_family_status').on(t.familyId, t.status)],
);

export const reminders = pgTable(
  'reminders',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    dueAt: timestamp('due_at'),
    done: boolean('done').notNull().default(false),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('reminders_member').on(t.memberId)],
);

/** Every action, for the family activity feed. */
export const activity = pgTable(
  'activity',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('activity_family_time').on(t.familyId, t.createdAt)],
);

/** Deleted searches/numbers kept in a protected vault. Admin views are logged in vault_access. */
export const vaultItems = pgTable('vault_items', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // search | phone_number | message
  payload: jsonb('payload').notNull(),
  deletedAt: timestamp('deleted_at').defaultNow().notNull(),
  purgeAfter: timestamp('purge_after'),
});

export const vaultAccess = pgTable('vault_access', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
  viewerId: text('viewer_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull().references(() => vaultItems.id, { onDelete: 'cascade' }),
  viewedAt: timestamp('viewed_at').defaultNow().notNull(),
});

export const connections = pgTable('connections', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  accountLabel: text('account_label').notNull(),
  scopes: jsonb('scopes').$type<string[]>().notNull(),
  status: text('status').notNull().default('connected'),
  lastError: text('last_error'),
  connectedAt: timestamp('connected_at').defaultNow().notNull(),
});

export const ledger = pgTable(
  'ledger',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    // Kept when a member leaves (family history stays), but no longer linked to them.
    memberId: text('member_id').references(() => members.id, { onDelete: 'set null' }),
    amountMinor: bigint('amount_minor', { mode: 'number' }).notNull(),
    currency: text('currency').notNull(),
    category: text('category').notNull(),
    note: text('note').notNull().default(''),
    at: timestamp('at').notNull(),
  },
  (t) => [index('ledger_family_time').on(t.familyId, t.at)],
);

export const checkInPlans = pgTable('check_in_plans', {
  id: text('id').primaryKey(),
  familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
  memberId: text('member_id').notNull().references(() => members.id, { onDelete: 'cascade' }),
  hour: integer('hour').notNull(),
  minute: integer('minute').notNull(),
  utcOffsetMinutes: integer('utc_offset_minutes').notNull(),
  graceMinutes: integer('grace_minutes').notNull().default(30),
  enabled: boolean('enabled').notNull().default(true),
  lastAnsweredAt: timestamp('last_answered_at'),
  /** The due time we last escalated for, so each miss is handled once. */
  lastHandledDue: timestamp('last_handled_due'),
  missCount: integer('miss_count').notNull().default(0),
});

/** House Knowledge: appliances, inventory, maintenance and home facts. */
export const houseItems = pgTable(
  'house_items',
  {
    id: text('id').primaryKey(),
    familyId: text('family_id').notNull().references(() => families.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // appliance | inventory | maintenance | fact
    name: text('name').notNull(),
    details: text('details').notNull().default(''),
    dueAt: timestamp('due_at'),
    createdBy: text('created_by').references(() => members.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
  },
  (t) => [index('house_family').on(t.familyId)],
);

/** OAuth tokens for a connection, encrypted at rest (AES-256-GCM). */
export const oauthTokens = pgTable('oauth_tokens', {
  connectionId: text('connection_id').primaryKey().references(() => connections.id, { onDelete: 'cascade' }),
  accessTokenEnc: text('access_token_enc').notNull(),
  refreshTokenEnc: text('refresh_token_enc'),
  expiresAt: timestamp('expires_at').notNull(),
});
