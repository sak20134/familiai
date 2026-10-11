// Starts Family AI on your computer: http://localhost:8787

import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
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
const app = createApp(db, {
  ...(process.env.ANTHROPIC_API_KEY ? { apiKey: process.env.ANTHROPIC_API_KEY } : {}),
  model: process.env.FAMILYAI_MODEL ?? 'claude-sonnet-5-5',
});

app.use('/*', serveStatic({ root: `${root}web/dist` }));
app.get('*', serveStatic({ path: `${root}web/dist/index.html` }));

serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? '127.0.0.1' }, (info) => {
  console.log(`Family AI is running: http://localhost:${info.port}`);
  console.log(process.env.ANTHROPIC_API_KEY ? 'Brain: AI model' : 'Brain: demo mode (add ANTHROPIC_API_KEY to .env for the full AI)');
});
