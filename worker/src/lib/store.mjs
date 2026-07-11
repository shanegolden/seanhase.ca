// D1 access helpers. Settings are JSON values in a key/value table, merged over
// defaults so a fresh database behaves sanely before Sean touches anything.

export const SETTING_DEFAULTS = {
  timezone: 'America/Vancouver',
  durationMin: 60,
  granularityMin: 30,
  bumperMin: 15,
  bookingBufferMin: 15,
  leadHours: 12,
  horizonDays: 21,
  notifyEmail: null,          // where contact/booking notifications go (CMS-managed)
  notifyEmailStatus: 'unset', // unset | pending_verification | verified
  calendarFeedUrl: null,      // Sean's secret iCal URL (read-only busy source)
  retentionMonths: 12,        // PIPEDA retention: purge old bookings/messages
  feedToken: null,            // tokenized bookings-feed URL segment (set at bootstrap)
  emailProvider: 'auto',      // auto | cf | resend | stub
  resendApiKey: null,         // optional, unlocks client-facing email
  patExpiresOn: null,         // YYYY-MM-DD, for the health countdown
  siteTitle: 'Sean Hase',
  resetTokenHash: null,       // self-service password reset (1h expiry)
  resetTokenExpires: null,
};

export async function getSettings(db) {
  const rows = await db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of rows.results || []) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch { /* ignore corrupt row, default wins */ }
  }
  return out;
}

export async function saveSettings(db, patch) {
  const stmts = Object.entries(patch)
    .filter(([k]) => k in SETTING_DEFAULTS)
    .map(([k, v]) => db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).bind(k, JSON.stringify(v)));
  if (stmts.length) await db.batch(stmts);
}

export async function getWindows(db) {
  const rows = await db.prepare(
    'SELECT id, weekday, start_min AS startMin, end_min AS endMin FROM availability_windows ORDER BY weekday, start_min',
  ).all();
  return rows.results || [];
}

export async function replaceWindows(db, windows) {
  const stmts = [db.prepare('DELETE FROM availability_windows')];
  for (const w of windows) {
    stmts.push(db.prepare(
      'INSERT INTO availability_windows (weekday, start_min, end_min) VALUES (?, ?, ?)',
    ).bind(w.weekday, w.startMin, w.endMin));
  }
  await db.batch(stmts);
}

export async function getBlackouts(db) {
  const rows = await db.prepare('SELECT date, reason FROM blackout_dates ORDER BY date').all();
  return rows.results || [];
}

export async function replaceBlackouts(db, blackouts) {
  const stmts = [db.prepare('DELETE FROM blackout_dates')];
  for (const b of blackouts) {
    stmts.push(db.prepare('INSERT INTO blackout_dates (date, reason) VALUES (?, ?)').bind(b.date, b.reason || null));
  }
  await db.batch(stmts);
}

export async function confirmedBookingsBetween(db, startIso, endIso) {
  const rows = await db.prepare(
    "SELECT slot_start AS start, slot_end AS end FROM bookings WHERE status = 'confirmed' AND slot_end > ? AND slot_start < ?",
  ).bind(startIso, endIso).all();
  return rows.results || [];
}

export async function logMail(db, { to, subject, kind, status, error = null }) {
  await db.prepare(
    'INSERT INTO mail_log (to_addr, subject, kind, status, error) VALUES (?, ?, ?, ?, ?)',
  ).bind(to, subject, kind, status, error).run();
}
