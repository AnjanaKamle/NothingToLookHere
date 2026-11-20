import { Router } from 'express';

/** GET /api/health reports whether the API and its database are reachable. */
export function createHealthRouter({ checkDatabase, protocolVersion }) {
  const router = Router();

  router.get('/', async (req, res) => {
    const databaseOk = await checkDatabase();
    res.status(databaseOk ? 200 : 503).json({
      status: databaseOk ? 'ok' : 'degraded',
      database: databaseOk ? 'ok' : 'unreachable',
      protocolVersion,
    });
  });

  return router;
}
