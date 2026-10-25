// Control reads run in the web process, independently of expensive business API work.
// Identity is still checked against the single production database on every request.
import Fastify from 'fastify';
import postgres from 'postgres';
import { config } from '@aihot/backend/config';
import { sessionPrincipal } from '@aihot/backend/admin/auth';
import { adminHandler } from '../api/src/routes/admin-auth.ts';
import { registerServerConsole } from '../api/src/routes/server-console.ts';

export function isAdminControlPath(path: string) {
  return path === '/api/admin/me' || path === '/api/admin/server' || path.startsWith('/api/admin/magpie-proxy/');
}

export async function createAdminControl(options: { authenticate?: typeof sessionPrincipal } = {}) {
  const db = options.authenticate ? null : postgres(config.databaseUrl, {
    max: 1, idle_timeout: 30, connect_timeout: 3,
    connection: { application_name: 'geohot_admin_control', statement_timeout: 2000, lock_timeout: 500, jit: 'off' },
    types: {
      int8: { to: 20, from: [20], serialize: String, parse: Number },
      numeric: { to: 1700, from: [1700], serialize: String, parse: Number },
    },
  });
  const authenticate = options.authenticate ?? ((cookie: string | undefined) => sessionPrincipal(cookie, db!));
  const app = Fastify({ bodyLimit: 1_048_576, requestTimeout: 25_000 });
  app.get('/api/admin/me', adminHandler(async (_req, _reply, admin) => ({ name: admin.name, csrf: admin.csrf, dev: admin.dev }), authenticate));
  await registerServerConsole(app, undefined, authenticate);
  if (db) app.addHook('onClose', async () => { await db.end({ timeout: 2 }); });
  await app.ready();
  return app;
}
