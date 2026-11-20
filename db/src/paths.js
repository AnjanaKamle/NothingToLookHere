import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dbDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const paths = Object.freeze({
  dbDir,
  migrationsDir: path.join(dbDir, 'migrations'),
  queriesFile: path.join(dbDir, 'queries.sql'),
  apDir: path.join(dbDir, '..', 'dbms'),
  apPlansDir: path.join(dbDir, '..', 'dbms', 'plans'),
});
