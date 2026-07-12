// seanhase-api: one Worker, three faces.
//   api.seanhase.ca   - public API (slots, bookings, contact, feed) CORS-locked to the site
//   admin.seanhase.ca - admin SPA (static assets) + same-origin admin API
//   local dev         - both faces on one host, no host gating
//
// Data lives in D1. All slot math is in lib/slots.mjs (pure, unit-tested).

import { DateTime } from 'luxon';
import { computeSlots, isSlotAvailable } from './lib/slots.mjs';
import {
  getSettings, saveSettings, getWindows, replaceWindows, getBlackouts,
  replaceBlackouts, confirmedBookingsBetween, SETTING_DEFAULTS,
} from './lib/store.mjs';
import {
  createAdmin, verifyLogin, setPassword, createSession, checkSession,
  destroySession, rateLimit, randomHex, sha256Hex, passwordMeetsFloor,
  timingSafeEqualHex,
} from './lib/auth.mjs';
import { getBusy, calendarHealth } from './lib/calendar.mjs';
import { sendMail } from './lib/email.mjs';
import { bookingIcs, bookingsFeedIcs } from './lib/ics.mjs';
import { commitFiles, latestBuildStatus, patDaysLeft } from './lib/github.mjs';
import { DEFAULT_CONTENT } from '../../shared/default-content.mjs';

const MAX_BODY = 64 * 1024;          // JSON bodies
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_IMAGES = 10;
const COOKIE = 'sh_sess';

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error('unhandled', e && e.stack || e);
      return json({ error: 'internal error' }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyMaintenance(env));
  },
};

/* ---------------------------------- routing ---------------------------------- */

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  // DEV_MODE is set by `wrangler dev --var DEV_MODE:1` (local + e2e). Hostname
  // alone is not enough: with custom-domain routes configured, wrangler dev
  // presents the first route's hostname to the Worker, not 127.0.0.1.
  const isDev = env.DEV_MODE === '1' || url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  const adminHost = safeHost(env.ADMIN_ORIGIN);
  const isAdminFace = isDev || url.hostname === adminHost;
  const isApiFace = isDev || url.hostname !== adminHost;

  if (request.method === 'OPTIONS') return preflight(request, env, isDev);

  // ------- public API (api face) -------
  if (isApiFace) {
    if (path === '/api/health') return withCors(await health(env), request, env, isDev);
    if (path === '/api/slots' && request.method === 'GET') {
      return withCors(await listSlots(env), request, env, isDev);
    }
    if (path === '/api/bookings' && request.method === 'POST') {
      return withCors(await createBooking(request, env, ctx), request, env, isDev);
    }
    const manage = path.match(/^\/api\/bookings\/manage\/([a-f0-9]{32,64})$/);
    if (manage && request.method === 'GET') {
      return withCors(await getManagedBooking(request, env, manage[1]), request, env, isDev);
    }
    const manageCancel = path.match(/^\/api\/bookings\/manage\/([a-f0-9]{32,64})\/cancel$/);
    if (manageCancel && request.method === 'POST') {
      return withCors(await cancelManagedBooking(request, env, ctx, manageCancel[1]), request, env, isDev);
    }
    if (path === '/api/contact' && request.method === 'POST') {
      return withCors(await submitContact(request, env, ctx), request, env, isDev);
    }
    const feed = path.match(/^\/api\/feed\/([a-f0-9]{16,64})\.ics$/);
    if (feed && request.method === 'GET') return bookingsFeed(env, feed[1]);
  }

  // ------- admin API + SPA (admin face) -------
  if (isAdminFace) {
    if (path.startsWith('/api/admin/')) return adminApi(request, env, ctx, path, isDev);
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);
  }

  return json({ error: 'not found' }, 404);
}

async function adminApi(request, env, ctx, path, isDev) {
  const db = env.DB;
  const ip = clientIp(request);
  const method = request.method;

  // CSRF: every mutating admin call must carry the custom header (SameSite=Lax
  // cookies + custom header = no cross-site writes).
  if (method !== 'GET' && request.headers.get('x-seanhase-admin') !== '1') {
    return json({ error: 'missing admin header' }, 403);
  }

  if (path === '/api/admin/status' && method === 'GET') {
    const existing = await db.prepare('SELECT id FROM admin_user WHERE id = 1').first();
    return json({ provisioned: !!existing });
  }

  if (path === '/api/admin/bootstrap' && method === 'POST') {
    const existing = await db.prepare('SELECT id FROM admin_user WHERE id = 1').first();
    if (existing) return json({ error: 'already provisioned' }, 409);
    const body = await readJson(request);
    if (!isEmail(body.email) || !passwordMeetsFloor(body.password)) {
      return json({ error: 'valid email and a password of 12+ chars with letters and numbers required' }, 400);
    }
    await createAdmin(db, body.email.trim(), body.password, env.PEPPER || 'dev-pepper');
    const settings = await getSettings(db);
    const patch = { notifyEmail: body.email.trim(), notifyEmailStatus: 'unset' };
    if (!settings.feedToken) patch.feedToken = randomHex(16);
    await saveSettings(db, patch);
    const s = await createSession(db);
    return withSessionCookie(json({ ok: true }), s, request);
  }

  if (path === '/api/admin/login' && method === 'POST') {
    // Request-level throttle only; the real brute-force guard is the account
    // lockout after 5 consecutive failures (see verifyLogin).
    if (!(await rateLimit(db, `login:${ip}`, 20, 15))) return json({ error: 'too many attempts, wait 15 minutes' }, 429);
    const body = await readJson(request);
    const result = await verifyLogin(db, String(body.password || ''), env.PEPPER || 'dev-pepper');
    if (!result.ok) {
      const msg = result.reason === 'locked' ? 'account locked for 15 minutes'
        : result.reason === 'no_admin' ? 'not provisioned yet' : 'wrong password';
      return json({ error: msg }, 401);
    }
    const s = await createSession(db);
    return withSessionCookie(json({ ok: true, mustChangePassword: !!result.user.must_change_pw }), s, request);
  }

  if (path === '/api/admin/reset-request' && method === 'POST') {
    if (!(await rateLimit(db, `reset:${ip}`, 3, 60))) return json({ error: 'too many reset requests' }, 429);
    const settings = await getSettings(db);
    const user = await db.prepare('SELECT email FROM admin_user WHERE id = 1').first();
    if (user && settings.notifyEmail) {
      const token = randomHex(24);
      await saveSettings(db, {
        resetTokenHash: await sha256Hex(token),
        resetTokenExpires: new Date(Date.now() + 3_600_000).toISOString(),
      });
      await sendMail(env, db, settings, {
        to: settings.notifyEmail,
        subject: 'Reset your seanhase.ca admin password',
        kind: 'reset',
        text: `Someone (hopefully you) asked to reset the admin password.\n\nOpen this link within 1 hour:\n${env.ADMIN_ORIGIN}/#reset=${token}\n\nIf this wasn't you, you can ignore this email.`,
      });
    }
    return json({ ok: true }); // same response either way: no account probing
  }

  if (path === '/api/admin/reset' && method === 'POST') {
    const body = await readJson(request);
    const settings = await getSettings(db);
    const expired = !settings.resetTokenHash || !settings.resetTokenExpires
      || settings.resetTokenExpires < new Date().toISOString();
    if (expired) return json({ error: 'reset link expired, request a new one' }, 400);
    if (!timingSafeEqualHex(await sha256Hex(String(body.token || '')), settings.resetTokenHash)) {
      return json({ error: 'invalid reset link' }, 400);
    }
    if (!passwordMeetsFloor(body.next)) return json({ error: 'new password needs 12+ chars with letters and numbers' }, 400);
    await setPassword(db, body.next, env.PEPPER || 'dev-pepper');
    await saveSettings(db, { resetTokenHash: null, resetTokenExpires: null });
    return json({ ok: true });
  }

  // Everything below requires a session.
  const session = await checkSession(db, getCookie(request, COOKIE));
  if (!session) return json({ error: 'not signed in' }, 401);

  if (path === '/api/admin/logout' && method === 'POST') {
    await destroySession(db, getCookie(request, COOKIE));
    const res = json({ ok: true });
    res.headers.append('set-cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return res;
  }

  if (path === '/api/admin/me' && method === 'GET') {
    const user = await db.prepare('SELECT email, must_change_pw FROM admin_user WHERE id = 1').first();
    return json({ ok: true, email: user?.email, mustChangePassword: !!user?.must_change_pw });
  }

  if (path === '/api/admin/password' && method === 'POST') {
    const body = await readJson(request);
    const check = await verifyLogin(db, String(body.current || ''), env.PEPPER || 'dev-pepper');
    if (!check.ok) return json({ error: 'current password is wrong' }, 403);
    if (!passwordMeetsFloor(body.next)) return json({ error: 'new password needs 12+ chars with letters and numbers' }, 400);
    await setPassword(db, body.next, env.PEPPER || 'dev-pepper');
    return json({ ok: true });
  }

  if (path === '/api/admin/settings' && method === 'GET') {
    const settings = await getSettings(db);
    return json({
      ...settings,
      resendApiKey: settings.resendApiKey ? 'set' : null,
      resetTokenHash: undefined,
      resetTokenExpires: undefined,
    });
  }
  if (path === '/api/admin/settings' && method === 'PUT') {
    const body = await readJson(request);
    const patch = sanitizeSettingsPatch(body);
    if (patch.error) return json({ error: patch.error }, 400);
    const before = await getSettings(db);
    if (patch.value.notifyEmail && patch.value.notifyEmail !== before.notifyEmail) {
      patch.value.notifyEmailStatus = await registerDestination(env, patch.value.notifyEmail);
    }
    await saveSettings(db, patch.value);
    return json({ ok: true, settings: await getSettings(db) });
  }

  if (path === '/api/admin/windows' && method === 'GET') return json({ windows: await getWindows(db) });
  if (path === '/api/admin/windows' && method === 'PUT') {
    const body = await readJson(request);
    const windows = Array.isArray(body.windows) ? body.windows : null;
    if (!windows || windows.some((w) => !Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6
      || !Number.isInteger(w.startMin) || !Number.isInteger(w.endMin)
      || w.startMin < 0 || w.endMin > 1440 || w.endMin <= w.startMin)) {
      return json({ error: 'invalid windows' }, 400);
    }
    await replaceWindows(db, windows);
    return json({ ok: true });
  }

  if (path === '/api/admin/blackouts' && method === 'GET') return json({ blackouts: await getBlackouts(db) });
  if (path === '/api/admin/blackouts' && method === 'PUT') {
    const body = await readJson(request);
    const list = Array.isArray(body.blackouts) ? body.blackouts : null;
    if (!list || list.some((b) => !/^\d{4}-\d{2}-\d{2}$/.test(b.date || ''))) {
      return json({ error: 'invalid blackouts' }, 400);
    }
    await replaceBlackouts(db, list.map((b) => ({ date: b.date, reason: String(b.reason || '').slice(0, 200) })));
    return json({ ok: true });
  }

  if (path === '/api/admin/content' && method === 'GET') {
    const row = await db.prepare("SELECT json FROM content_drafts WHERE key = 'content'").first();
    return json({ content: row ? JSON.parse(row.json) : DEFAULT_CONTENT, isDefault: !row });
  }
  if (path === '/api/admin/content' && method === 'PUT') {
    const body = await readJson(request, 256 * 1024);
    const content = sanitizeContent(body.content);
    if (!content) return json({ error: 'invalid content' }, 400);
    await db.prepare(
      "INSERT INTO content_drafts (key, json, updated_at) VALUES ('content', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) "
      + 'ON CONFLICT(key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at',
    ).bind(JSON.stringify(content)).run();
    return json({ ok: true });
  }

  if (path === '/api/admin/images' && method === 'GET') {
    const rows = await db.prepare('SELECT id, filename, mime, size, created_at FROM draft_images ORDER BY id DESC').all();
    return json({ images: rows.results || [] });
  }
  if (path === '/api/admin/images' && method === 'POST') {
    const body = await readJson(request, 4 * 1024 * 1024);
    const parsed = parseDataUrl(body.dataUrl);
    if (!parsed) return json({ error: 'invalid image data' }, 400);
    if (parsed.bytes.length > MAX_IMAGE_BYTES) return json({ error: 'image too large (2 MB max after resize)' }, 400);
    const filename = slugFilename(body.filename, parsed.ext);
    const count = await db.prepare('SELECT COUNT(*) AS n FROM draft_images').first();
    if (count.n >= MAX_PENDING_IMAGES) return json({ error: 'too many pending images, publish first' }, 400);
    await db.prepare('DELETE FROM draft_images WHERE filename = ?').bind(filename).run();
    await db.prepare('INSERT INTO draft_images (filename, mime, bytes, size) VALUES (?, ?, ?, ?)')
      .bind(filename, parsed.mime, parsed.bytes, parsed.bytes.length).run();
    return json({ ok: true, filename, path: `assets/img/${filename}` });
  }
  const imgDel = path.match(/^\/api\/admin\/images\/(\d+)$/);
  if (imgDel && method === 'DELETE') {
    await db.prepare('DELETE FROM draft_images WHERE id = ?').bind(Number(imgDel[1])).run();
    return json({ ok: true });
  }
  const imgGet = path.match(/^\/api\/admin\/images\/(\d+)\/raw$/);
  if (imgGet && method === 'GET') {
    const row = await db.prepare('SELECT mime, bytes FROM draft_images WHERE id = ?').bind(Number(imgGet[1])).first();
    if (!row) return json({ error: 'not found' }, 404);
    return new Response(row.bytes, { headers: { 'content-type': row.mime, 'cache-control': 'no-store' } });
  }

  if (path === '/api/admin/bookings' && method === 'GET') {
    const rows = await db.prepare(
      'SELECT id, slot_start, slot_end, name, email, phone, note, status, created_at, cancelled_at, cancelled_by '
      + 'FROM bookings ORDER BY slot_start DESC LIMIT 200',
    ).all();
    const settings = await getSettings(db);
    return json({ bookings: rows.results || [], timezone: settings.timezone });
  }
  const adminCancel = path.match(/^\/api\/admin\/bookings\/(\d+)\/cancel$/);
  if (adminCancel && method === 'POST') {
    const id = Number(adminCancel[1]);
    const r = await db.prepare(
      "UPDATE bookings SET status = 'cancelled', cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), cancelled_by = 'admin' "
      + "WHERE id = ? AND status = 'confirmed'",
    ).bind(id).run();
    if (!r.meta.changes) return json({ error: 'not found or already cancelled' }, 404);
    const booking = await db.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
    ctx.waitUntil(notifySean(env, db, 'cancel', booking));
    return json({ ok: true });
  }

  if (path === '/api/admin/calendar/test' && method === 'POST') {
    const settings = await getSettings(db);
    const from = DateTime.utc().toISO();
    const to = DateTime.utc().plus({ days: 7 }).toISO();
    const result = await getBusy(db, settings, from, to, { forceFresh: true });
    if (!result.ok) return json({ ok: false, error: result.reason });
    return json({ ok: true, eventsNext7Days: result.busy.length, sample: result.busy.slice(0, 5) });
  }

  if (path === '/api/admin/publish' && method === 'POST') {
    return publishSite(env, db);
  }
  if (path === '/api/admin/publish/status' && method === 'GET') {
    return publishStatus(env, db);
  }

  if (path === '/api/admin/health-summary' && method === 'GET') {
    const settings = await getSettings(db);
    const cal = await calendarHealth(db, settings);
    const fails = await db.prepare(
      "SELECT COUNT(*) AS n FROM mail_log WHERE status = 'failed' AND created_at > datetime('now', '-1 day')",
    ).first();
    const upcoming = await db.prepare(
      "SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND slot_start > strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    ).first();
    return json({
      calendar: cal,
      mailFailures24h: fails.n,
      upcomingBookings: upcoming.n,
      patDaysLeft: patDaysLeft(settings.patExpiresOn),
      notifyEmail: settings.notifyEmail,
      notifyEmailStatus: settings.notifyEmailStatus,
      feedToken: settings.feedToken,
    });
  }

  return json({ error: 'not found' }, 404);
}

/* ---------------------------------- public handlers ---------------------------------- */

async function health(env) {
  try {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM settings').first();
    return json({ ok: true, settingsRows: row.n });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

async function listSlots(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const windows = await getWindows(db);
  const blackouts = (await getBlackouts(db)).map((b) => b.date);
  const now = DateTime.utc();
  const rangeStart = now.toISO();
  const rangeEnd = now.plus({ days: settings.horizonDays + 1 }).toISO();

  const busyRes = await getBusy(db, settings, rangeStart, rangeEnd);
  if (!busyRes.ok) {
    return json({ slots: [], timezone: settings.timezone, calendarUnavailable: true }, 200, { 'cache-control': 'no-store' });
  }
  const bookings = await confirmedBookingsBetween(db, rangeStart, rangeEnd);
  const slots = computeSlots({
    settings, windows, blackouts, busy: busyRes.busy, bookings, now: rangeStart,
  });
  return json({
    slots, timezone: settings.timezone, durationMin: settings.durationMin, degraded: busyRes.degraded,
  }, 200, { 'cache-control': 'no-store' });
}

async function createBooking(request, env, ctx) {
  const db = env.DB;
  const ip = clientIp(request);
  if (!(await rateLimit(db, `book:${ip}`, 15, 60))) return json({ error: 'too many booking attempts, try later' }, 429);

  const body = await readJson(request);
  const name = cleanText(body.name, 100);
  const email = String(body.email || '').trim().slice(0, 200);
  const phone = cleanText(body.phone, 40);
  const note = cleanText(body.note, 500);
  const start = String(body.start || '');
  if (!name || !isEmail(email)) return json({ error: 'name and a valid email are required' }, 400);
  if (body.consent !== true) return json({ error: 'consent is required' }, 400);
  const startDt = DateTime.fromISO(start, { zone: 'utc' });
  if (!startDt.isValid) return json({ error: 'invalid slot' }, 400);

  const settings = await getSettings(db);
  const windows = await getWindows(db);
  const blackouts = (await getBlackouts(db)).map((b) => b.date);
  const now = DateTime.utc();
  const rangeEnd = now.plus({ days: settings.horizonDays + 1 }).toISO();

  // Fail-closed revalidation against Sean's REAL calendar (fresh fetch).
  const busyRes = await getBusy(db, settings, now.toISO(), rangeEnd, { forceFresh: true });
  if (!busyRes.ok) return json({ error: 'booking is temporarily unavailable, please try again soon' }, 503);
  const bookings = await confirmedBookingsBetween(db, now.toISO(), rangeEnd);

  const args = { settings, windows, blackouts, busy: busyRes.busy, bookings, now: now.toISO() };
  if (!isSlotAvailable(start, args)) return json({ error: 'that time was just taken, please pick another' }, 409);

  const slotStart = startDt.toISO({ suppressMilliseconds: true });
  const slotEnd = startDt.plus({ minutes: settings.durationMin }).toISO({ suppressMilliseconds: true });
  const manageToken = randomHex(16);
  const tokenHash = await sha256Hex(manageToken);

  // THE atomicity guard: single conditional INSERT, no interactive transaction
  // needed (D1 has none). meta.changes === 0 -> somebody won the race -> 409.
  const res = await db.prepare(
    `INSERT INTO bookings (slot_start, slot_end, name, email, phone, note, manage_token_hash)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
     WHERE NOT EXISTS (
       SELECT 1 FROM bookings WHERE status = 'confirmed' AND slot_start < ?2 AND slot_end > ?1
     )`,
  ).bind(slotStart, slotEnd, name, email, phone || null, note || null, tokenHash).run();
  if (!res.meta.changes) return json({ error: 'that time was just taken, please pick another' }, 409);

  const booking = await db.prepare('SELECT * FROM bookings WHERE manage_token_hash = ?').bind(tokenHash).first();
  ctx.waitUntil(notifySean(env, db, 'booking', booking));

  return json({
    ok: true,
    booking: { start: slotStart, end: slotEnd, name },
    timezone: settings.timezone,
    manageToken,
    ics: bookingIcs(booking, settings.siteTitle),
  }, 201);
}

async function getManagedBooking(request, env, token) {
  const db = env.DB;
  if (!(await rateLimit(db, `manage:${clientIp(request)}`, 30, 15))) return json({ error: 'slow down' }, 429);
  const row = await db.prepare('SELECT * FROM bookings WHERE manage_token_hash = ?')
    .bind(await sha256Hex(token)).first();
  if (!row) return json({ error: 'not found' }, 404);
  const settings = await getSettings(db);
  return json({
    booking: {
      start: row.slot_start, end: row.slot_end, name: row.name, status: row.status,
    },
    timezone: settings.timezone,
    ics: row.status === 'confirmed' ? bookingIcs(row, settings.siteTitle) : null,
  });
}

async function cancelManagedBooking(request, env, ctx, token) {
  const db = env.DB;
  if (!(await rateLimit(db, `manage:${clientIp(request)}`, 30, 15))) return json({ error: 'slow down' }, 429);
  const nowIso = new Date().toISOString();
  const r = await db.prepare(
    "UPDATE bookings SET status = 'cancelled', cancelled_at = ?, cancelled_by = 'client' "
    + "WHERE manage_token_hash = ? AND status = 'confirmed' AND slot_start > ?",
  ).bind(nowIso, await sha256Hex(token), nowIso).run();
  if (!r.meta.changes) return json({ error: 'booking not found, already cancelled, or already in the past' }, 409);
  const booking = await db.prepare('SELECT * FROM bookings WHERE manage_token_hash = ?')
    .bind(await sha256Hex(token)).first();
  ctx.waitUntil(notifySean(env, db, 'cancel', booking));
  return json({ ok: true });
}

async function submitContact(request, env, ctx) {
  const db = env.DB;
  const ip = clientIp(request);
  if (!(await rateLimit(db, `contact:${ip}`, 3, 15))) return json({ error: 'too many messages, try later' }, 429);
  const body = await readJson(request);
  if (body.website) return json({ ok: true }); // honeypot: swallow silently
  const name = cleanText(body.name, 100);
  const email = String(body.email || '').trim().slice(0, 200);
  const message = cleanText(body.message, 2000);
  if (!name || !isEmail(email) || !message) return json({ error: 'name, valid email, and a message are required' }, 400);

  await db.prepare('INSERT INTO contact_messages (name, email, message) VALUES (?, ?, ?)')
    .bind(name, email, message).run();

  const settings = await getSettings(db);
  if (settings.notifyEmail) {
    ctx.waitUntil(sendMail(env, db, settings, {
      to: settings.notifyEmail,
      subject: `New message from ${name} via seanhase.ca`,
      kind: 'contact',
      text: `From: ${name} <${email}>\n\n${message}\n\nReply directly to ${email}.`,
    }));
  }
  return json({ ok: true });
}

async function bookingsFeed(env, token) {
  const db = env.DB;
  const settings = await getSettings(db);
  if (!settings.feedToken || token !== settings.feedToken) return json({ error: 'not found' }, 404);
  const rows = await db.prepare(
    "SELECT * FROM bookings WHERE slot_start > strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days') ORDER BY slot_start",
  ).all();
  return new Response(bookingsFeedIcs(rows.results || [], settings.siteTitle), {
    headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* ---------------------------------- publish ---------------------------------- */

async function publishSite(env, db) {
  const contentRow = await db.prepare("SELECT json FROM content_drafts WHERE key = 'content'").first();
  const content = contentRow ? JSON.parse(contentRow.json) : DEFAULT_CONTENT;
  const images = await db.prepare('SELECT id, filename, bytes FROM draft_images').all();

  const log = await db.prepare("INSERT INTO publish_log (status) VALUES ('committing') RETURNING id").first();
  const files = [{ path: 'site/content/content.json', content: `${JSON.stringify(content, null, 2)}\n` }];
  for (const img of images.results || []) {
    files.push({ path: `site/assets/img/${img.filename}`, base64: bytesToBase64(img.bytes) });
  }

  try {
    const { sha } = await commitFiles(env, files, 'CMS publish from admin.seanhase.ca');
    await db.prepare("UPDATE publish_log SET status = 'building', commit_sha = ? WHERE id = ?").bind(sha, log.id).run();
    await db.prepare('DELETE FROM draft_images').run();
    return json({ ok: true, sha, status: 'building' });
  } catch (e) {
    const error = String(e.message || e).slice(0, 400);
    await db.prepare("UPDATE publish_log SET status = 'commit_failed', error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .bind(error, log.id).run();
    return json({ ok: false, stage: 'commit', error }, 502);
  }
}

async function publishStatus(env, db) {
  const row = await db.prepare('SELECT * FROM publish_log ORDER BY id DESC LIMIT 1').first();
  if (!row) return json({ status: 'never_published' });
  if (row.status === 'building') {
    try {
      const b = await latestBuildStatus(env, row.commit_sha);
      if (b.state === 'live' || b.state === 'build_failed') {
        await env.DB.prepare("UPDATE publish_log SET status = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .bind(b.state, row.id).run();
        return json({ status: b.state, sha: row.commit_sha, buildUrl: b.url });
      }
      return json({ status: 'building', sha: row.commit_sha });
    } catch {
      return json({ status: 'building', sha: row.commit_sha, note: 'build status unavailable' });
    }
  }
  return json({ status: row.status, sha: row.commit_sha, error: row.error });
}

/* ---------------------------------- cron ---------------------------------- */

async function dailyMaintenance(env) {
  const db = env.DB;
  const settings = await getSettings(db);
  const problems = [];

  // Purges: rate-limit rows, expired sessions, stale draft images, PII retention.
  await db.batch([
    db.prepare("DELETE FROM rate_limits WHERE window_start < datetime('now', '-1 day')"),
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')"),
    db.prepare("DELETE FROM draft_images WHERE created_at < datetime('now', '-7 days')"),
    db.prepare(`DELETE FROM bookings WHERE slot_end < datetime('now', '-${Number(settings.retentionMonths) || 12} months')`),
    db.prepare(`DELETE FROM contact_messages WHERE created_at < datetime('now', '-${Number(settings.retentionMonths) || 12} months')`),
    db.prepare(`DELETE FROM mail_log WHERE created_at < datetime('now', '-${Number(settings.retentionMonths) || 12} months')`),
  ]);

  // Health checks -> alert email to Sean.
  if (settings.calendarFeedUrl) {
    const probe = await getBusy(db, settings, new Date().toISOString(),
      new Date(Date.now() + 7 * 86_400_000).toISOString(), { forceFresh: true });
    if (!probe.ok) problems.push(`Calendar feed is failing: ${probe.reason}`);
    else if (probe.degraded) problems.push('Calendar feed is degraded (serving cached data).');
  }
  const days = patDaysLeft(settings.patExpiresOn);
  if (days != null && days <= 30) problems.push(`GitHub publish token expires in ${days} days. Site edits will stop working when it does.`);
  const fails = await db.prepare(
    "SELECT COUNT(*) AS n FROM mail_log WHERE status = 'failed' AND created_at > datetime('now', '-1 day')",
  ).first();
  if (fails.n > 0) problems.push(`${fails.n} email(s) failed to send in the last 24h.`);

  if (problems.length && settings.notifyEmail) {
    await sendMail(env, db, settings, {
      to: settings.notifyEmail,
      subject: 'seanhase.ca needs attention',
      kind: 'alert',
      text: `Daily health check found:\n\n- ${problems.join('\n- ')}\n\nSign in at ${env.ADMIN_ORIGIN} for details.`,
    });
  }
}

/* ---------------------------------- notifications ---------------------------------- */

async function notifySean(env, db, kind, booking) {
  const settings = await getSettings(db);
  if (!settings.notifyEmail || !booking) return;
  const tz = settings.timezone;
  const when = DateTime.fromISO(booking.slot_start, { zone: 'utc' }).setZone(tz)
    .toFormat("cccc, LLLL d 'at' h:mm a");
  if (kind === 'booking') {
    await sendMail(env, db, settings, {
      to: settings.notifyEmail,
      subject: `New booking: ${booking.name} on ${when}`,
      kind: 'booking',
      text: `${booking.name} booked a session.\n\nWhen: ${when} (${tz})\nEmail: ${booking.email}\nPhone: ${booking.phone || 'not given'}\nNote: ${booking.note || 'none'}\n\nThe attached calendar file adds it to your calendar. Manage bookings at ${env.ADMIN_ORIGIN}.`,
      ics: bookingIcs(booking, settings.siteTitle),
    });
  } else if (kind === 'cancel') {
    await sendMail(env, db, settings, {
      to: settings.notifyEmail,
      subject: `Cancelled: ${booking.name} on ${when}`,
      kind: 'cancel',
      text: `The booking for ${booking.name} on ${when} (${tz}) was cancelled (${booking.cancelled_by === 'admin' ? 'by you' : 'by the client'}).`,
    });
  }
}

/** Adds the new notify address as a Cloudflare Email Routing destination so the
 * free verified-destination sending keeps working after Sean changes it. */
async function registerDestination(env, email) {
  if (!env.CF_API_TOKEN || !env.CF_ACCOUNT_ID) return 'pending_verification'; // wired at deploy
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/email/routing/addresses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (data.success || (data.errors || []).some((e) => /already exists/i.test(e.message))) {
      return 'pending_verification';
    }
    return 'pending_verification';
  } catch {
    return 'pending_verification';
  }
}

/* ---------------------------------- helpers ---------------------------------- */

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

async function readJson(request, cap = MAX_BODY) {
  const text = await request.text();
  if (text.length > cap) throw new Error('body too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    return {};
  }
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || '127.0.0.1';
}

function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 200;
}

function cleanText(v, max) {
  // Strip control characters except newline and tab; cap length.
  return String(v || '').replace(/[ --]/g, '').trim().slice(0, max);
}

function safeHost(origin) {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function getCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

function withSessionCookie(res, session, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  res.headers.append('set-cookie',
    `${COOKIE}=${session.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure}`);
  return res;
}

const DEV_ORIGINS = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function corsHeaders(request, env, isDev) {
  const origin = request.headers.get('origin');
  if (!origin) return {};
  // localhost origins stay allowed in prod: the public endpoints are unauthenticated
  // by design and this keeps local site previews debuggable against the real API.
  // www + the interim GitHub Pages address are also allowed.
  const extra = ['https://www.seanhase.ca', 'http://www.shanegolden.ca', 'https://www.shanegolden.ca'];
  const allowed = origin === env.SITE_ORIGIN || origin === env.ADMIN_ORIGIN
    || extra.includes(origin) || DEV_ORIGINS.test(origin);
  if (!allowed) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function preflight(request, env, isDev) {
  return new Response(null, { status: 204, headers: corsHeaders(request, env, isDev) });
}

function withCors(res, request, env, isDev) {
  const h = corsHeaders(request, env, isDev);
  for (const [k, v] of Object.entries(h)) res.headers.set(k, v);
  return res;
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const mime = m[1];
  const ext = m[2] === 'jpeg' ? 'jpg' : m[2];
  try {
    const bin = atob(m[3]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { mime, ext, bytes };
  } catch {
    return null;
  }
}

function slugFilename(name, ext) {
  const base = String(name || 'image').replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'image';
  return `${base}.${ext}`;
}

function bytesToBase64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function sanitizeSettingsPatch(body) {
  const out = {};
  const intFields = {
    durationMin: [15, 240], granularityMin: [5, 120], bumperMin: [0, 120],
    bookingBufferMin: [0, 120], leadHours: [0, 336], horizonDays: [1, 90], retentionMonths: [1, 84],
  };
  for (const [k, [lo, hi]] of Object.entries(intFields)) {
    if (body[k] != null) {
      const v = Number(body[k]);
      if (!Number.isInteger(v) || v < lo || v > hi) return { error: `${k} must be between ${lo} and ${hi}` };
      out[k] = v;
    }
  }
  if (body.timezone != null) {
    if (!DateTime.local().setZone(body.timezone).isValid) return { error: 'invalid timezone' };
    out.timezone = body.timezone;
  }
  if (body.notifyEmail != null) {
    if (!isEmail(body.notifyEmail)) return { error: 'invalid notification email' };
    out.notifyEmail = body.notifyEmail.trim();
  }
  if (body.calendarFeedUrl != null) {
    const u = String(body.calendarFeedUrl).trim();
    // https required; plain http is allowed only for loopback (local dev + e2e stubs).
    if (u && !/^https:\/\/.+/i.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(u)) {
      return { error: 'calendar feed must be an https URL' };
    }
    out.calendarFeedUrl = u || null;
  }
  if (body.emailProvider != null) {
    if (!['auto', 'cf', 'resend', 'stub'].includes(body.emailProvider)) return { error: 'invalid email provider' };
    out.emailProvider = body.emailProvider;
  }
  if (body.resendApiKey != null) out.resendApiKey = String(body.resendApiKey).slice(0, 200) || null;
  if (body.patExpiresOn != null) {
    if (body.patExpiresOn && !/^\d{4}-\d{2}-\d{2}$/.test(body.patExpiresOn)) return { error: 'invalid PAT expiry date' };
    out.patExpiresOn = body.patExpiresOn || null;
  }
  if (body.siteTitle != null) out.siteTitle = cleanText(body.siteTitle, 80) || SETTING_DEFAULTS.siteTitle;
  return { value: out };
}

function sanitizeContent(c) {
  if (!c || typeof c !== 'object') return null;
  // Deep sanitize: strings only where expected, length caps, structure preserved.
  const walk = (node, depth = 0) => {
    if (depth > 6) return null;
    if (typeof node === 'string') return cleanText(node, 4000);
    if (Array.isArray(node)) return node.slice(0, 20).map((x) => walk(x, depth + 1));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node).slice(0, 40)) {
        if (/^[a-zA-Z0-9_]{1,40}$/.test(k)) out[k] = walk(v, depth + 1);
      }
      return out;
    }
    return null;
  };
  return walk(c);
}
