// Admin auth (multi-user): PBKDF2-SHA256 (WebCrypto, native) + per-user salt +
// server pepper, opaque session tokens stored hashed and tied to a user, fixed-
// window rate limiting, per-user lockout, per-user email reset.
// Login failures return ONE undifferentiated reason for bad email vs bad
// password (no account enumeration), with a dummy hash burn to keep timing flat.

const ITERATIONS = 100_000; // native WebCrypto; fine inside Workers CPU budget
const SESSION_DAYS = 30;
const LOCKOUT_AFTER = 5;
const LOCKOUT_MINUTES = 15;

const enc = new TextEncoder();

export function randomHex(bytes = 32) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Human-friendly but strong generated password (for new accounts). */
export function generatePassword() {
  const words = ['harbor', 'cedar', 'tide', 'summit', 'alder', 'coast', 'ridge', 'fern', 'stone', 'creek', 'maple', 'inlet'];
  const pick = () => words[crypto.getRandomValues(new Uint32Array(1))[0] % words.length];
  const num = 1000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 9000);
  return `${pick()}-${pick()}-${pick()}-${num}`;
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

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Creates a user; returns their id. Emails are stored lowercased; the column
 *  is COLLATE NOCASE so lookups use the unique index directly. */
export async function createUser(db, email, password, pepper, { mustChange = 0 } = {}) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, ITERATIONS, pepper);
  const row = await db.prepare(
    'INSERT INTO admin_users (email, pass_hash, salt, iterations, must_change_pw) VALUES (?, ?, ?, ?, ?) RETURNING id',
  ).bind(normalizeEmail(email), hash, salt, ITERATIONS, mustChange).first();
  return row.id;
}

export async function countUsers(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM admin_users').first();
  return row.n;
}

export async function listUsers(db) {
  const rows = await db.prepare('SELECT id, email, must_change_pw, created_at FROM admin_users ORDER BY id').all();
  return rows.results || [];
}

/** Deletes a user and every session they own. */
export async function deleteUser(db, userId) {
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
    db.prepare('DELETE FROM admin_users WHERE id = ?').bind(userId),
  ]);
}

const DUMMY_SALT = 'a3b1c2d4e5f60718293a4b5c6d7e8f90';

export async function verifyLogin(db, email, password, pepper) {
  const user = await db.prepare('SELECT * FROM admin_users WHERE email = ?')
    .bind(normalizeEmail(email)).first();
  if (!user) {
    // Burn a hash anyway: unknown-email and wrong-password take the same time
    // and return the same reason.
    await hashPassword(password, DUMMY_SALT, ITERATIONS, pepper);
    return { ok: false, reason: 'bad_credentials' };
  }
  if (user.locked_until && user.locked_until > new Date().toISOString()) {
    return { ok: false, reason: 'locked', until: user.locked_until };
  }
  const hash = await hashPassword(password, user.salt, user.iterations, pepper);
  if (!timingSafeEqualHex(hash, user.pass_hash)) {
    const fails = (user.failed_attempts || 0) + 1;
    const lock = fails >= LOCKOUT_AFTER
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null;
    await db.prepare('UPDATE admin_users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
      .bind(lock ? 0 : fails, lock, user.id).run();
    return { ok: false, reason: lock ? 'locked' : 'bad_credentials' };
  }
  await db.prepare('UPDATE admin_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?')
    .bind(user.id).run();
  return { ok: true, user };
}

/** Sets a user's password and revokes their OTHER sessions (compromise
 *  recovery: a stolen cookie must not outlive a password change). Pass the
 *  current session's token hash to keep exactly that one alive. */
export async function setPassword(db, userId, password, pepper, { keepSessionTokenHash = null } = {}) {
  const salt = randomHex(16);
  const hash = await hashPassword(password, salt, ITERATIONS, pepper);
  const stmts = [
    db.prepare(
      'UPDATE admin_users SET pass_hash = ?, salt = ?, iterations = ?, must_change_pw = 0, failed_attempts = 0, locked_until = NULL, reset_token_hash = NULL, reset_token_expires = NULL WHERE id = ?',
    ).bind(hash, salt, ITERATIONS, userId),
    keepSessionTokenHash
      ? db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(userId, keepSessionTokenHash)
      : db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ];
  await db.batch(stmts);
}

export async function createSession(db, userId) {
  const token = randomHex(32);
  const tokenHash = await sha256Hex(token);
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash, expires_at, user_id) VALUES (?, ?, ?)')
    .bind(tokenHash, expires, userId).run();
  return { token, expires };
}

/** Returns the session row (incl. user_id and the session's own token_hash) or
 *  null. Sessions without a user (pre-migration relics) are treated as dead. */
export async function checkSession(db, token) {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const nowIso = new Date().toISOString();
  const row = await db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?')
    .bind(tokenHash, nowIso).first();
  if (!row || !row.user_id) return null;
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

/** Stores a reset token on the user's row; returns the raw token, or null if
 *  the email doesn't belong to an account (caller answers identically). */
export async function createResetToken(db, email) {
  const user = await db.prepare('SELECT id FROM admin_users WHERE email = ?')
    .bind(normalizeEmail(email)).first();
  if (!user) return null;
  const token = randomHex(24);
  await db.prepare('UPDATE admin_users SET reset_token_hash = ?, reset_token_expires = ? WHERE id = ?')
    .bind(await sha256Hex(token), new Date(Date.now() + 3_600_000).toISOString(), user.id).run();
  return token;
}

/** Consumes a reset token: sets the password, clears the token, revokes ALL of
 *  the user's sessions. Returns true on success. */
export async function consumeResetToken(db, token, newPassword, pepper) {
  const tokenHash = await sha256Hex(String(token || ''));
  const user = await db.prepare(
    'SELECT id FROM admin_users WHERE reset_token_hash = ? AND reset_token_expires > ?',
  ).bind(tokenHash, new Date().toISOString()).first();
  if (!user) return false;
  await setPassword(db, user.id, newPassword, pepper); // also clears token + sessions
  return true;
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
