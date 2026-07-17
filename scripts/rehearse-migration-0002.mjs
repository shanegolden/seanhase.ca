#!/usr/bin/env node
// Rehearses migration 0002 against a THROWAWAY local D1 that simulates the LIVE
// database's pre-migration state: 0001 applied, one admin_user row (fake hash),
// one live session. Asserts the account, its credentials, and the session
// survive with user_id backfilled. Run from the repo root:
//   node scripts/rehearse-migration-0002.mjs

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const DIR = '.wrangler-rehearse';
const CFG = '--config worker/wrangler.toml';
const P = `--persist-to ${DIR}`;

const sh = (cmd) => execSync(cmd, { stdio: 'pipe' }).toString();
const sql = (q) => JSON.parse(sh(`npx wrangler d1 execute seanhase --local ${P} ${CFG} --json --command "${q.replace(/"/g, '\\"')}"`))[0].results;

rmSync(DIR, { recursive: true, force: true });

// 1. Simulate live: apply ONLY 0001 by executing its file, then seed v1 data.
sh(`npx wrangler d1 execute seanhase --local ${P} ${CFG} --file worker/migrations/0001_init.sql`);
sql("INSERT INTO admin_user (id, email, pass_hash, salt, iterations, must_change_pw) VALUES (1, 'shane@shanegolden.ca', 'LIVEHASH', 'LIVESALT', 100000, 0)");
sql("INSERT INTO sessions (token_hash, expires_at) VALUES ('LIVESESSIONHASH', '2099-01-01T00:00:00Z')");

// 2. Apply 0002 exactly as deploy will.
sh(`npx wrangler d1 execute seanhase --local ${P} ${CFG} --file worker/migrations/0002_multi_user.sql`);

// 3. Assertions.
const users = sql('SELECT id, email, pass_hash, salt, iterations, must_change_pw FROM admin_users');
const sessions = sql('SELECT token_hash, user_id FROM sessions');
const oldTable = sql("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_user'");

const assert = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${msg}`);
  }
};

assert(users.length === 1, 'exactly one migrated user');
assert(users[0].email === 'shane@shanegolden.ca', 'email preserved');
assert(users[0].pass_hash === 'LIVEHASH' && users[0].salt === 'LIVESALT', 'credentials preserved byte-for-byte');
assert(users[0].iterations === 100000, 'iteration count preserved');
assert(sessions.length === 1 && sessions[0].user_id === users[0].id, 'live session survives with user_id backfilled');
assert(oldTable.length === 0, 'old admin_user table dropped');

// 4. Idempotence probe: re-running the file must fail loudly (duplicate ALTER),
// NOT half-apply. D1's migrations runner tracks applied files so this never
// happens in practice; this just documents the failure mode.
let rerunFailed = false;
try {
  sh(`npx wrangler d1 execute seanhase --local ${P} ${CFG} --file worker/migrations/0002_multi_user.sql`);
} catch {
  rerunFailed = true;
}
assert(rerunFailed, 're-run fails loudly instead of corrupting');

rmSync(DIR, { recursive: true, force: true });
console.log(process.exitCode ? 'REHEARSAL FAILED' : 'REHEARSAL PASSED');
