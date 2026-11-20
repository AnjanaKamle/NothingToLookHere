import { readFileSync } from 'node:fs';
import { paths } from './paths.js';

const ID_PATTERN = /^Q-[A-Z]{3}-\d{2}$/;
const STATEMENT_VERBS = {
  READ: /^(SELECT|WITH)\b/i,
  WRITE: /^(INSERT|UPDATE|DELETE|WITH)\b/i,
};

/**
 * Parses the query catalogue format used by db/queries.sql:
 *
 *   -- @id Q-XXX-NN
 *   -- READ | WRITE
 *   -- description lines...
 *   SQL ...;
 *
 * Returns a Map of id -> { id, kind, description, sql } in file order.
 * Throws on duplicate ids, unknown kinds, or a statement whose verb does not match its kind.
 */
export function parseQueryCatalogue(text) {
  const queries = new Map();
  const blocks = text.split(/^-- @id /m).slice(1);

  for (const block of blocks) {
    const lines = block.split('\n');
    const id = lines[0].trim();
    if (!ID_PATTERN.test(id)) throw new Error(`Invalid query id "${id}"`);
    if (queries.has(id)) throw new Error(`Duplicate query id ${id}`);

    const kindMatch = /^-- (READ|WRITE)\s*$/.exec(lines[1] ?? '');
    if (!kindMatch) throw new Error(`${id}: second line must be "-- READ" or "-- WRITE"`);
    const kind = kindMatch[1];

    const description = [];
    let index = 2;
    while (index < lines.length && lines[index].startsWith('--')) {
      description.push(lines[index].replace(/^--\s?/, ''));
      index += 1;
    }

    // The statement runs up to the first line that ends with ';'.
    const sqlLines = [];
    for (; index < lines.length; index += 1) {
      sqlLines.push(lines[index]);
      if (lines[index].trimEnd().endsWith(';')) break;
    }
    const sql = sqlLines.join('\n').trim().replace(/;$/, '');
    if (!sql) throw new Error(`${id}: missing SQL statement`);
    if (!STATEMENT_VERBS[kind].test(sql)) {
      throw new Error(
        `${id}: marked ${kind} but the statement starts with "${sql.split(/\s/)[0]}"`,
      );
    }
    if (kind === 'READ' && /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)) {
      throw new Error(`${id}: marked READ but contains a data-modifying statement`);
    }

    queries.set(id, Object.freeze({ id, kind, description: description.join(' ').trim(), sql }));
  }

  return queries;
}

let cached;

/** Loads db/queries.sql once. Application code fetches statements with getQuery(id). */
export function loadQueries() {
  cached ??= parseQueryCatalogue(readFileSync(paths.queriesFile, 'utf8'));
  return cached;
}

/** Returns the SQL text for a query id, or throws if the id is unknown. */
export function getQuery(id) {
  const query = loadQueries().get(id);
  if (!query) throw new Error(`Unknown query id ${id}`);
  return query.sql;
}
