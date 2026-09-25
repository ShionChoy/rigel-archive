// Sets the backup's secrets on the deployed Worker from tools/ra/backup.env (npm run secrets:backup).
// The values go to `wrangler secret bulk` on stdin; nothing is printed or written elsewhere.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const KEYS = ['B2_KEY_ID', 'B2_APP_KEY', 'B2_BUCKET', 'BACKUP_CRYPT_PASSWORD', 'BACKUP_CRYPT_SALT'];
const file = new URL('../../tools/ra/backup.env', import.meta.url);
const values = {};
for (const line of readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
  if (m && !line.trimStart().startsWith('#')) values[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}
const missing = KEYS.filter((k) => !values[k]);
if (missing.length) {
  console.error(`tools/ra/backup.env is missing: ${missing.join(', ')}`);
  process.exit(1);
}
const secrets = Object.fromEntries(KEYS.map((k) => [k, values[k]]));
const result = spawnSync('npx', ['wrangler', 'secret', 'bulk'], { input: JSON.stringify(secrets), stdio: ['pipe', 'inherit', 'inherit'] });
process.exit(result.status ?? 1);
