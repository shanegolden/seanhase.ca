// Email adapter. Drivers:
//   cf     - Cloudflare send_email binding (free, verified destinations only:
//            perfect for notifying Sean). Raw MIME built with mimetext.
//   resend - Resend API (unlocks client-facing email when a key is configured).
//   stub   - local dev / tests: no network, just the mail_log row.
// Every attempt is recorded in mail_log so sends are verifiable end to end.

import { createMimeMessage } from 'mimetext';
import { logMail } from './store.mjs';

const FROM = { addr: 'no-reply@seanhase.ca', name: 'seanhase.ca' };

export function pickDriver(env, settings) {
  const pref = settings.emailProvider || 'auto';
  if (pref !== 'auto') return pref;
  if (settings.resendApiKey || env.RESEND_API_KEY) return 'resend';
  if (env.MAIL) return 'cf';
  return 'stub';
}

/**
 * @returns {Promise<{ok: boolean, driver: string, error?: string}>}
 */
export async function sendMail(env, db, settings, { to, subject, text, html, ics, kind }) {
  const driver = pickDriver(env, settings);
  try {
    if (driver === 'cf') {
      await sendViaCf(env, { to, subject, text, html, ics });
    } else if (driver === 'resend') {
      await sendViaResend(settings.resendApiKey || env.RESEND_API_KEY, { to, subject, text, html, ics });
    } // stub: fall through, log only
    await logMail(db, { to, subject, kind, status: driver === 'stub' ? 'stubbed' : 'sent' });
    return { ok: true, driver };
  } catch (e) {
    const error = String(e && e.message || e).slice(0, 500);
    await logMail(db, { to, subject, kind, status: 'failed', error });
    return { ok: false, driver, error };
  }
}

async function sendViaCf(env, { to, subject, text, html, ics }) {
  const msg = createMimeMessage();
  msg.setSender({ addr: FROM.addr, name: FROM.name });
  msg.setRecipient(to);
  msg.setSubject(subject);
  if (text) msg.addMessage({ contentType: 'text/plain', data: text });
  if (html) msg.addMessage({ contentType: 'text/html', data: html });
  if (ics) {
    msg.addAttachment({
      filename: 'appointment.ics',
      contentType: 'text/calendar',
      data: btoa(unescape(encodeURIComponent(ics))),
      encoding: 'base64',
    });
  }
  // cloudflare:email is only resolvable inside the Workers runtime.
  const { EmailMessage } = await import('cloudflare:email');
  await env.MAIL.send(new EmailMessage(FROM.addr, to, msg.asRaw()));
}

async function sendViaResend(apiKey, { to, subject, text, html, ics }) {
  if (!apiKey) throw new Error('resend driver selected but no API key configured');
  const body = {
    from: `${FROM.name} <${FROM.addr}>`,
    to: [to],
    subject,
    text: text || undefined,
    html: html || undefined,
  };
  if (ics) {
    body.attachments = [{
      filename: 'appointment.ics',
      content: btoa(unescape(encodeURIComponent(ics))),
    }];
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
