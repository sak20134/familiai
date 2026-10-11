// Builds the HTTP app. Kept separate from index.ts so tests can create it with an in-memory database.

import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './context';
import type { Db } from './db/client';
import type { BrainConfig } from './brain/agent';
import { defaultLimits, type Limits } from './security';
import { authRoutes, meRoutes, requireUser } from './routes/auth';
import { approvalRoutes, chatRoutes } from './routes/chat';
import { familyRoutes, inviteRoutes } from './routes/family';
import { recordRoutes } from './routes/records';

export function createApp(db: Db, brain: BrainConfig, limits: Limits = defaultLimits()) {
  const app = new Hono<AppEnv>();

  app.use('*', secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'"],
    },
  }));

  // Cross-site request protection: changes must be JSON from our own page.
  app.use('/api/*', async (c, next) => {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      const type = c.req.header('content-type') ?? '';
      if (!type.toLowerCase().startsWith('application/json')) {
        return c.json({ error: 'Requests must be JSON.' }, 415);
      }
      const origin = c.req.header('origin');
      if (origin && new URL(origin).host !== new URL(c.req.url).host) {
        return c.json({ error: 'Cross-site request blocked.' }, 403);
      }
    }
    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, brain: brain.apiKey ? 'model' : 'demo' }));
  app.route('/api/auth', authRoutes(db, limits));

  const user = requireUser(db);
  for (const path of ['/api/me', '/api/me/*', '/api/family', '/api/family/*', '/api/invites/*', '/api/chat', '/api/chat/*',
    '/api/approvals', '/api/approvals/*', '/api/records/*']) {
    app.use(path, user);
  }
  app.route('/api/me', meRoutes());
  app.route('/api/family', familyRoutes());
  app.route('/api/invites', inviteRoutes(limits));
  app.route('/api/chat', chatRoutes(brain));
  app.route('/api/approvals', approvalRoutes());
  app.route('/api/records', recordRoutes());

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'Not found.' }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: 'Something went wrong on the server.' }, 500);
  });

  return app;
}
