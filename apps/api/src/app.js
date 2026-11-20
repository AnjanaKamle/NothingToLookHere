import express from 'express';
import helmet from 'helmet';
import { PROTOCOL_VERSION } from '@capstone/protocol';
import { createHealthRouter } from './routes/health.js';
import { createApiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { cookies, createRateLimiters, requestLogger } from './http/middleware.js';

/**
 * Builds the Express application.
 *
 * @param {object} deps
 * @param {object} deps.config          from loadConfig()
 * @param {import('pg').Pool} deps.pool shared PostgreSQL pool
 * @param {object} deps.notifier        real-time notifier (see realtime/notifier.js)
 * @param {() => Promise<boolean>} deps.checkDatabase
 * @param {object} [options]
 * @param {boolean} [options.rateLimit=true]  disable only in tests
 * @param {boolean} [options.logRequests=true]
 */
export function createApp(deps, { rateLimit = true, logRequests = true } = {}) {
  const app = express();

  app.disable('x-powered-by');
  // Which proxies may set X-Forwarded-For (the Vite dev proxy, or a reverse proxy in production).
  app.set('trust proxy', deps.config.trustProxy);
  app.use(helmet());
  // API responses are personal and short-lived: never cache them.
  app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  if (logRequests) app.use(requestLogger);
  app.use(express.json({ limit: '16kb' }));
  app.use(cookies);

  app.use(
    '/api/health',
    createHealthRouter({ checkDatabase: deps.checkDatabase, protocolVersion: PROTOCOL_VERSION }),
  );
  app.use('/api', createApiRouter(deps, createRateLimiters(rateLimit)));

  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
