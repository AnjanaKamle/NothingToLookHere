import http from 'node:http';
import { loadConfig } from './config.js';
import { createPool, checkDatabase } from './db/pool.js';
import { createApp } from './app.js';
import { createNotifier } from './realtime/notifier.js';
import { createRealtimeServer } from './realtime/socket.js';
import { scheduleMaintenance } from './services/maintenance.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const notifier = createNotifier();
const app = createApp({ config, pool, notifier, checkDatabase: () => checkDatabase(pool) });
const httpServer = http.createServer(app);
const io = createRealtimeServer(httpServer, { config, pool, notifier });
const stopMaintenance = scheduleMaintenance(pool, config);

httpServer.listen(config.port, config.host, () => {
  console.log(`[api] listening on http://${config.host}:${config.port} (${config.nodeEnv})`);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received, shutting down`);
  stopMaintenance();
  // io.close() also closes the underlying HTTP server.
  await new Promise((resolve) => io.close(() => resolve()));
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
