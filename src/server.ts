import { serve } from '@hono/node-server';

import { buildApp } from './api/app.js';
import { closeDb } from './db/pool.js';

const port = Number(process.env['PORT'] ?? 4200);
const server = serve({ fetch: buildApp().fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`eventgrain api on :${port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void closeDb().then(() => process.exit(0));
  });
}
