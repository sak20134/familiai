// Starts Family AI on your computer: http://localhost:8787

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TwilioProvider } from '@familiai/core';
import { runCheckIns } from './services/checkins';
import type { Services } from './services/types';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { createDb } from './db/client';

const root = fileURLToPath(new URL('..', import.meta.url));

// Tiny .env loader (no extra package). Real environment variables win.
const envFile = `${root}.env`;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && m[2] && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.FAMILYAI_DATA_DIR ?? `${root}data`;
const { db } = await createDb(dataDir);

// Encryption key for stored Google tokens: created once, kept next to the data, never committed.
const keyFile = `${dataDir}/secret.key`;
if (!existsSync(keyFile)) {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 });
}
const env = process.env;
const services: Services = {
  secretKey: Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64'),
  ...(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM
    ? { calls: { provider: new TwilioProvider({ accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN }), from: env.TWILIO_FROM } }
    : {}),
  ...(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_REDIRECT_URI ?? `http://localhost:${port}/api/oauth/google/callback` } }
    : {}),
};

const app = createApp(db, {
  ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
  model: env.FAMILYAI_MODEL ?? 'claude-sonnet-5-5',
}, undefined, services);

// Daily check-ins: look once a minute for missed ones and escalate.
setInterval(() => {
  runCheckIns(db, services).catch((err) => console.error('Check-in run failed:', err));
}, 60_000).unref();

app.use('/*', serveStatic({ root: `${root}web/dist` }));
app.get('*', serveStatic({ path: `${root}web/dist/index.html` }));

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => {
  console.log(`Family AI is running: http://localhost:${info.port}`);
  console.log(env.ANTHROPIC_API_KEY ? 'Brain: AI model' : 'Brain: demo mode (add ANTHROPIC_API_KEY to .env for the full AI)');
  console.log(`Phone calls: ${services.calls ? 'Twilio connected' : 'off'} | Google Calendar: ${services.google ? 'ready' : 'off'}`);
});
