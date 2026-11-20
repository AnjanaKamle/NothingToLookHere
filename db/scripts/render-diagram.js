#!/usr/bin/env node
// Renders dbms/02_er_diagram.mmd to dbms/02_er_diagram.png with the official Mermaid CLI.
// Uses an installed Google Chrome (set CHROME_PATH to override) so no browser is downloaded.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { paths } from '../src/paths.js';

const MERMAID_CLI = '@mermaid-js/mermaid-cli@12.0.0';
const chrome =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(chrome)) {
  console.error(`Chrome not found at ${chrome}. Set CHROME_PATH to a Chrome or Chromium binary.`);
  process.exit(1);
}

const workDir = mkdtempSync(path.join(tmpdir(), 'capstone-mmdc-'));
const puppeteerConfig = path.join(workDir, 'puppeteer.json');
writeFileSync(puppeteerConfig, JSON.stringify({ executablePath: chrome, headless: 'shell' }));

try {
  execFileSync(
    'npx',
    [
      '--yes',
      MERMAID_CLI,
      '--input',
      path.join(paths.apDir, '02_er_diagram.mmd'),
      '--output',
      path.join(paths.apDir, '02_er_diagram.png'),
      '--puppeteerConfigFile',
      puppeteerConfig,
      '--backgroundColor',
      'white',
      '--scale',
      '2',
    ],
    { stdio: 'inherit', env: { ...process.env, PUPPETEER_SKIP_DOWNLOAD: '1' } },
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
