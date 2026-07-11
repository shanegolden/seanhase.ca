// Admin auth: PBKDF2-SHA256 (WebCrypto, native) + per-user salt + server pepper,
// opaque session tokens stored hashed, fixed-window rate limiting with lockout.
// Iteration count is tuned to the Workers free-tier CPU budget; the pepper (a
// Worker secret, absent from D1) is what makes an offline DB-only crack useless.

const ITERATIONS = 100_000; // measured locally ~15-40ms wall, native WebCrypto
const SESSION_DAYS = 30;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MINUTES = 15;

const enc = new TextEncoder();

export function randomHex(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, saltHex, iterations, pepper) {
  const key = await crypto.subtle.importKey('raw', enc.encode(`${password}${pepper}`), 'PBKDF2', false, ['deriveBits']);
  const salt = Uint8Array.from(saltHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    256,
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function passwordMeetsFloor(pw) {
  return typeof pw === 'string' && pw.length >= 12 && /[a-zA-Z]/.test(pw) && /[0-9]/.test(pw);
}

export async function createAdmin(db, email, password, pepper, { mustChange = 0 } = {}) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, ITERATIONS, pepper);
  await db.prepare(
    'INSERT INTO admin_user (id, email, pass_hash, salt, iterations, must_change_pw) VALUES (1, ?, ?, ?, ?, ?)',
  ).bind(email, hash, salt, ITERATIONS, mustChange).run();
}

export async function verifyLogin(db, password, pepper) {
  const user = await db.prepare('SELECT * FROM admin_user WHERE id = 1').first();
  if (!user) return { ok: false, reason: 'no_admin' };
  if (user.locked_until && user.locked_until > new Date().toISOString()) {
    return { ok: false, reason: 'locked', until: user.locked_until };
  }
  const hash = await hashPassword(password, user.salt, user.iterations, pepper);
  if (!timingSafeEqualHex(hash, user.pass_hash)) {
    const fails = (user.failed_attempts || 0) + 1;
    const lock = fails >= LOCKOUT_AFTER
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null;
    await db.prepare('UPDATE admin_user SET failed_attempts = ?, locked_until = ? WHERE id = 1')
      .bind(lock ? 0 : fails, lock).run();
    return { ok: false, reason: lock ? 'locked' : 'bad_password' };
  }
  await db.prepare('UPDATE admin_user SET failed_attempts = 0, locked_until = NULL WHERE id = 1').run();
  return { ok: true, user };
}

export async function setPassword(db, password, pepper) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, ITERATIONS, pepper);
  await db.prepare(
    'UPDATE admin_user SET pass_hash = ?, salt = ?, iterations = ?, must_change_pw = 0, failed_attempts = 0, locked_until = NULL WHERE id = 1',
  ).bind(hash, salt, ITERATIONS).run();
}

export async function createSession(db) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').bind(tokenHash, expires).run();
  return { token, expires };
}

export async function checkSession(db, token) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = await db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, nowIso).first();
  if (!row) return null;
  // Rolling expiry, refreshed at most once an hour to keep writes rare.
  if (!row.last_seen || row.last_seen < new Date(Date.now() - 3_600_000).toISOString()) {
    const newExp = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
    await db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
      .bind(nowIso, newExp, tokenHash).run();
  }
  return row;
}

export async function destroySession(db, token) {
  if (!token) return;
  await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
}

// Fixed-window rate limit: N events per windowMinutes per key. Returns true if allowed.
export async function rateLimit(db, key, max, windowMinutes) {
  const windowStart = new Date(Math.floor(Date.now() / (windowMinutes * 60_000)) * windowMinutes * 60_000).toISOString();
  const row = await db.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || row.window_start !== windowStart) {
    await db.prepare(
      'INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) '
      + 'ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, count = 1',
    ).bind(key, windowStart).run();
    return true;
  }
  if (row.count >= max) return false;
  await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
  return true;
}
