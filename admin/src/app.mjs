// seanhase.ca admin CMS. One small Preact app, five views:
// Dashboard / Content / Availability / Bookings / Settings.
// Served same-origin with the admin API by the Worker.

import { h, render, Fragment } from 'preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import htm from 'htm';
import { api } from './api.mjs';

const html = htm.bind(h);

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMEZONES = [
  'America/Vancouver', 'America/Edmonton', 'America/Regina', 'America/Winnipeg',
  'America/Toronto', 'America/Halifax', 'America/St_Johns',
];

const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeToMin = (t) => {
  const [hh, mm] = String(t || '0:0').split(':').map(Number);
  return hh * 60 + mm;
};
const fmtWhen = (iso, tz) => new Intl.DateTimeFormat('en-CA', {
  timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
}).format(new Date(iso)).replace(/\./g, '');

/* ================================ root ================================ */

function App() {
  const [phase, setPhase] = useState('checking'); // checking|login|bootstrap|reset|app
  const [resetToken, setResetToken] = useState(null);

  useEffect(() => {
    const m = location.hash.match(/^#reset=([a-f0-9]{16,64})$/);
    if (m) { setResetToken(m[1]); setPhase('reset'); return; }
    api('/api/admin/me')
      .then(() => setPhase('app'))
      .catch(async () => {
        try {
          const s = await api('/api/admin/status');
          setPhase(s.provisioned ? 'login' : 'bootstrap');
        } catch {
          setPhase('login');
        }
      });
  }, []);

  if (phase === 'checking') return html`<div class="center-page"><p class="muted">Loading…</p></div>`;
  if (phase === 'login') return html`<${Login} onDone=${() => setPhase('app')} />`;
  if (phase === 'bootstrap') return html`<${Bootstrap} onDone=${() => setPhase('app')} />`;
  if (phase === 'reset') return html`<${Reset} token=${resetToken} onDone=${() => { location.hash = ''; setPhase('login'); }} />`;
  return html`<${Shell} onLogout=${() => setPhase('login')} />`;
}

/* ================================ auth views ================================ */

function AuthCard({ title, children }) {
  return html`
    <div class="center-page">
      <div class="auth-card">
        <p class="wordmark">Sean<span>Hase</span> <em>admin</em></p>
        <h1>${title}</h1>
        ${children}
      </div>
    </div>`;
}

function Login({ onDone }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const submit = async (ev) => {
    ev.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/api/admin/login', { method: 'POST', body: { password: ev.target.password.value } });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const forgot = async () => {
    try { await api('/api/admin/reset-request', { method: 'POST', body: {} }); setResetSent(true); } catch (e) { setErr(e.message); }
  };
  return html`
    <${AuthCard} title="Sign in">
      <form onSubmit=${submit}>
        <label>Password<input type="password" name="password" required autofocus /></label>
        ${err && html`<p class="error">${err}</p>`}
        <button class="btn primary" disabled=${busy}>${busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" class="linkish" onClick=${forgot}>Forgot password?</button>
        ${resetSent && html`<p class="ok">If the account exists, a reset link was emailed to the notification address.</p>`}
      </form>
    <//>`;
}

function Bootstrap({ onDone }) {
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (ev) => {
    ev.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api('/api/admin/bootstrap', {
        method: 'POST',
        body: { email: ev.target.email.value, password: ev.target.password.value },
      });
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return html`
    <${AuthCard} title="First-time setup">
      <p class="muted">Create the one admin account for this site. The email also becomes where booking and contact notifications go (changeable later).</p>
      <form onSubmit=${submit}>
        <label>Your email<input type="email" name="email" required /></label>
        <label>Choose a password <span class="muted">(12+ characters, letters and numbers)</span>
          <input type="password" name="password" required minlength="12" /></label>
        ${err && html`<p class="error">${err}</p>`}
        <button class="btn primary" disabled=${busy}>${busy ? 'Setting up…' : 'Create account'}</button>
      </form>
    <//>`;
}

function Reset({ token, onDone }) {
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);
  const submit = async (ev) => {
    ev.preventDefault();
    setErr(null);
    try {
      await api('/api/admin/reset', { method: 'POST', body: { token, next: ev.target.next.value } });
      setDone(true);
      setTimeout(onDone, 1200);
    } catch (e) { setErr(e.message); }
  };
  return html`
    <${AuthCard} title="Set a new password">
      ${done ? html`<p class="ok">Password updated. Taking you to sign in…</p>` : html`
      <form onSubmit=${submit}>
        <label>New password<input type="password" name="next" required minlength="12" /></label>
        ${err && html`<p class="error">${err}</p>`}
        <button class="btn primary">Save password</button>
      </form>`}
    <//>`;
}

/* ================================ shell ================================ */

const TABS = ['Dashboard', 'Content', 'Availability', 'Bookings', 'Settings'];

function Shell({ onLogout }) {
  const [tab, setTab] = useState('Dashboard');
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const notify = useCallback((msg, kind = 'ok') => {
    setToast({ msg, kind });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);
  const logout = async () => {
    try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* session may be gone */ }
    onLogout();
  };
  return html`
    <div class="shell">
      <header class="topbar">
        <p class="wordmark">Sean<span>Hase</span> <em>admin</em></p>
        <nav>
          ${TABS.map((t) => html`<button class=${t === tab ? 'tab active' : 'tab'} onClick=${() => setTab(t)}>${t}</button>`)}
        </nav>
        <button class="linkish" onClick=${logout}>Sign out</button>
      </header>
      <main class="content">
        ${tab === 'Dashboard' && html`<${Dashboard} notify=${notify} goTab=${setTab} />`}
        ${tab === 'Content' && html`<${Content} notify=${notify} />`}
        ${tab === 'Availability' && html`<${Availability} notify=${notify} />`}
        ${tab === 'Bookings' && html`<${Bookings} notify=${notify} />`}
        ${tab === 'Settings' && html`<${Settings} notify=${notify} />`}
      </main>
      ${toast && html`<div class="toast ${toast.kind}">${toast.msg}</div>`}
    </div>`;
}

/* ================================ dashboard ================================ */

function Dashboard({ notify, goTab }) {
  const [health, setHealth] = useState(null);
  const [bookings, setBookings] = useState(null);
  const [tz, setTz] = useState('America/Vancouver');
  useEffect(() => {
    api('/api/admin/health-summary').then(setHealth).catch((e) => notify(e.message, 'err'));
    api('/api/admin/bookings').then((d) => { setBookings(d.bookings); setTz(d.timezone); }).catch(() => {});
  }, []);
  if (!health) return html`<p class="muted">Loading…</p>`;
  const upcoming = (bookings || []).filter((b) => b.status === 'confirmed' && new Date(b.slot_start) > new Date())
    .sort((a, b) => a.slot_start < b.slot_start ? -1 : 1).slice(0, 5);
  const feedUrl = health.feedToken ? `${location.origin.replace(/^http/, 'webcal').replace('admin.', 'api.')}/api/feed/${health.feedToken}.ics` : null;
  return html`
    <h1>Dashboard</h1>
    <div class="stat-row">
      <div class="stat"><span class="stat-num">${health.upcomingBookings}</span><span>upcoming bookings</span></div>
      <div class="stat ${health.calendar.configured ? (health.calendar.lastError ? 'warn' : '') : 'warn'}">
        <span class="stat-num">${health.calendar.configured ? (health.calendar.lastError ? '!' : 'OK') : '–'}</span>
        <span>${health.calendar.configured ? (health.calendar.lastError ? 'calendar feed erroring' : 'calendar sync') : 'calendar not linked yet'}</span>
      </div>
      <div class="stat ${health.mailFailures24h ? 'warn' : ''}"><span class="stat-num">${health.mailFailures24h}</span><span>email failures (24h)</span></div>
      ${health.patDaysLeft != null && html`<div class="stat ${health.patDaysLeft <= 30 ? 'warn' : ''}"><span class="stat-num">${health.patDaysLeft}d</span><span>publish token left</span></div>`}
    </div>
    ${!health.notifyEmail && html`<p class="banner warn">No notification email is set. Add one in Settings so bookings reach you.</p>`}
    ${health.notifyEmailStatus === 'pending_verification' && html`<p class="banner warn">Your notification email is waiting for verification. Check that inbox for a Cloudflare confirmation link.</p>`}
    <h2>Next appointments</h2>
    ${upcoming.length ? html`
      <table class="table">
        <thead><tr><th>When</th><th>Client</th><th>Contact</th></tr></thead>
        <tbody>${upcoming.map((b) => html`
          <tr><td>${fmtWhen(b.slot_start, tz)}</td><td>${b.name}</td><td>${b.email}${b.phone ? ` · ${b.phone}` : ''}</td></tr>`)}
        </tbody>
      </table>` : html`<p class="muted">Nothing booked yet.</p>`}
    ${feedUrl && html`
      <h2>See bookings in your own calendar</h2>
      <p class="muted">Subscribe once and every new booking appears automatically. In Google Calendar: Other calendars → From URL. On iPhone: Settings → Calendar → Accounts → Add Subscribed Calendar.</p>
      <code class="copyable" onClick=${() => { navigator.clipboard.writeText(feedUrl.replace(/^webcal/, 'https')); notify('Feed link copied'); }}>${feedUrl}</code>`}
    <p style="margin-top:1.5rem"><button class="btn" onClick=${() => goTab('Availability')}>Set your hours</button></p>`;
}

/* ================================ content ================================ */

function Content({ notify }) {
  const [content, setContent] = useState(null);
  const [publish, setPublish] = useState(null); // null | {status, error}
  const pollRef = useRef(null);

  useEffect(() => {
    api('/api/admin/content').then((d) => setContent(d.content)).catch((e) => notify(e.message, 'err'));
    refreshPublish();
    return () => clearInterval(pollRef.current);
  }, []);

  const refreshPublish = () => api('/api/admin/publish/status').then(setPublish).catch(() => {});

  const set = (path, value) => {
    setContent((c) => {
      const next = structuredClone(c);
      const keys = path.split('.');
      let node = next;
      while (keys.length > 1) node = node[keys.shift()];
      node[keys[0]] = value;
      return next;
    });
  };

  const save = async () => {
    try {
      await api('/api/admin/content', { method: 'PUT', body: { content } });
      notify('Draft saved');
    } catch (e) { notify(e.message, 'err'); }
  };

  const doPublish = async () => {
    try {
      await api('/api/admin/content', { method: 'PUT', body: { content } }); // save first, always
      setPublish({ status: 'committing' });
      const r = await api('/api/admin/publish', { method: 'POST', body: {} });
      setPublish({ status: r.status });
      clearInterval(pollRef.current);
      pollRef.current = setInterval(async () => {
        const s = await api('/api/admin/publish/status').catch(() => null);
        if (s) setPublish(s);
        if (s && (s.status === 'live' || s.status.endsWith('failed'))) clearInterval(pollRef.current);
      }, 5000);
    } catch (e) {
      setPublish({ status: 'commit_failed', error: e.message });
    }
  };

  const uploadImage = async (file) => {
    try {
      const dataUrl = await resizeImage(file, 1600);
      const r = await api('/api/admin/images', { method: 'POST', body: { filename: file.name, dataUrl } });
      set('about.imagePath', r.path);
      notify('Photo uploaded. It goes live when you publish.');
    } catch (e) { notify(e.message, 'err'); }
  };

  if (!content) return html`<p class="muted">Loading…</p>`;
  const c = content;
  const field = (label, path, opts = {}) => html`
    <label>${label}${opts.textarea
      ? html`<textarea rows=${opts.rows || 3} value=${get(c, path)} onInput=${(e) => set(path, e.target.value)} />`
      : html`<input value=${get(c, path)} onInput=${(e) => set(path, e.target.value)} />`}
    </label>`;

  return html`
    <div class="page-head">
      <h1>Site content</h1>
      <div class="head-actions">
        <button class="btn" onClick=${save}>Save draft</button>
        <button class="btn primary" onClick=${doPublish} disabled=${publish && (publish.status === 'committing' || publish.status === 'building')}>
          ${publish && publish.status === 'committing' ? 'Publishing…' : publish && publish.status === 'building' ? 'Building…' : 'Publish to site'}
        </button>
      </div>
    </div>
    ${publish && html`<${PublishBanner} publish=${publish} />`}

    <section class="panel">
      <h2>Top of page</h2>
      ${field('Small label above the headline', 'hero.eyebrow')}
      ${field('Headline', 'hero.headline')}
      ${field('Intro sentence', 'hero.subhead', { textarea: true })}
      <div class="two-col">
        ${field('Main button text', 'hero.ctaLabel')}
        ${field('Second button text', 'hero.secondaryCtaLabel')}
      </div>
    </section>

    <section class="panel">
      <h2>About</h2>
      ${field('Heading', 'about.heading')}
      ${field('Your story (blank line = new paragraph)', 'about.body', { textarea: true, rows: 7 })}
      <label>Photo
        <div class="img-row">
          <img class="img-preview" src=${imgPreviewSrc(c.about.imagePath)} alt="about preview" />
          <input type="file" accept="image/jpeg,image/png,image/webp"
            onChange=${(e) => e.target.files[0] && uploadImage(e.target.files[0])} />
        </div>
      </label>
      ${field('Photo description (for screen readers)', 'about.imageAlt')}
    </section>

    <section class="panel">
      <h2>Sessions</h2>
      ${field('Heading', 'services.heading')}
      ${field('Intro', 'services.intro')}
      ${(c.services.items || []).map((it, i) => html`
        <div class="item-card">
          <div class="two-col">
            <label>Title<input value=${it.title} onInput=${(e) => set(`services.items.${i}.title`, e.target.value)} /></label>
            <label>Tag (e.g. 60 minutes)<input value=${it.detail || ''} onInput=${(e) => set(`services.items.${i}.detail`, e.target.value)} /></label>
          </div>
          <label>Description<textarea rows="2" value=${it.desc} onInput=${(e) => set(`services.items.${i}.desc`, e.target.value)} /></label>
          <button class="linkish danger" onClick=${() => set('services.items', c.services.items.filter((_, j) => j !== i))}>Remove</button>
        </div>`)}
      <button class="btn" onClick=${() => set('services.items', [...c.services.items, { title: '', desc: '', detail: '' }])}>Add a session type</button>
      ${field('Fine-print note', 'services.note', { textarea: true })}
    </section>

    <section class="panel">
      <h2>Booking + contact sections</h2>
      <div class="two-col">
        ${field('Booking heading', 'booking.heading')}
        ${field('Contact heading', 'contact.heading')}
      </div>
      ${field('Booking intro', 'booking.intro', { textarea: true })}
      ${field('Contact intro', 'contact.intro', { textarea: true })}
    </section>

    <section class="panel">
      <h2>Footer + search results</h2>
      ${field('Footer tagline', 'footer.tagline')}
      <div class="two-col">
        ${field('Location', 'footer.location')}
        ${field('Instagram handle (optional)', 'footer.instagram')}
      </div>
      ${field('Public email shown in footer (optional)', 'footer.email')}
      ${field('Browser tab title', 'meta.title')}
      ${field('Search result description', 'meta.description', { textarea: true })}
    </section>`;
}

function PublishBanner({ publish }) {
  const map = {
    never_published: ['muted', 'Not published yet. "Publish to site" makes your draft live.'],
    committing: ['', 'Publishing your changes…'],
    building: ['', 'Changes saved to the site. Building now, live in about a minute…'],
    live: ['ok', 'Your latest publish is LIVE.'],
    commit_failed: ['err', `Publish failed before it reached the site${publish.error ? `: ${publish.error}` : ''}. Your draft is safe. Try again or contact Shane.`],
    build_failed: ['err', 'The site build failed. Your draft is safe. Contact Shane with this message.'],
  };
  const [kind, msg] = map[publish.status] || ['', publish.status];
  return html`<p class="banner ${kind}">${msg}</p>`;
}

function get(obj, path) {
  return path.split('.').reduce((a, k) => (a == null ? '' : a[k]), obj) ?? '';
}

function imgPreviewSrc(imagePath) {
  // Draft preview is best-effort: pending upload preview comes from the draft
  // store; otherwise show the live site's copy.
  return `https://seanhase.ca/${imagePath}?cb=${Date.now() % 1e6}`;
}

async function resizeImage(file, maxDim) {
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(file);
  });
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/* ================================ availability ================================ */

function Availability({ notify }) {
  const [windows, setWindows] = useState(null);
  const [settings, setSettings] = useState(null);
  const [blackouts, setBlackouts] = useState(null);
  const [calTest, setCalTest] = useState(null);

  useEffect(() => {
    api('/api/admin/windows').then((d) => setWindows(d.windows)).catch((e) => notify(e.message, 'err'));
    api('/api/admin/settings').then(setSettings).catch(() => {});
    api('/api/admin/blackouts').then((d) => setBlackouts(d.blackouts)).catch(() => {});
  }, []);

  if (!windows || !settings || !blackouts) return html`<p class="muted">Loading…</p>`;

  const saveWindows = async () => {
    try {
      await api('/api/admin/windows', { method: 'PUT', body: { windows } });
      notify('Hours saved');
    } catch (e) { notify(e.message, 'err'); }
  };
  const saveSettings = async (patch) => {
    try {
      const r = await api('/api/admin/settings', { method: 'PUT', body: patch });
      setSettings((s) => ({ ...s, ...r.settings }));
      notify('Saved');
    } catch (e) { notify(e.message, 'err'); }
  };
  const saveBlackouts = async (next) => {
    setBlackouts(next);
    try {
      await api('/api/admin/blackouts', { method: 'PUT', body: { blackouts: next } });
      notify('Days off saved');
    } catch (e) { notify(e.message, 'err'); }
  };
  const testCalendar = async () => {
    setCalTest({ busy: true });
    try {
      await api('/api/admin/settings', { method: 'PUT', body: { calendarFeedUrl: settings.calendarFeedUrl || '' } });
      const r = await api('/api/admin/calendar/test', { method: 'POST', body: {} });
      setCalTest(r);
    } catch (e) { setCalTest({ ok: false, error: e.message }); }
  };

  const num = (label, key, hint) => html`
    <label>${label}${hint && html` <span class="muted">${hint}</span>`}
      <input type="number" value=${settings[key]} min="0"
        onChange=${(e) => saveSettings({ [key]: Number(e.target.value) })} />
    </label>`;

  return html`
    <h1>Availability</h1>

    <section class="panel">
      <h2>Weekly hours</h2>
      <p class="muted">These are the windows people can book inside. Add more than one window per day for split shifts.</p>
      ${WEEKDAYS.map((name, wd) => {
        const rows = windows.map((w, i) => ({ ...w, i })).filter((w) => w.weekday === wd);
        return html`
          <div class="day-row">
            <span class="day-name">${name}</span>
            <div class="day-windows">
              ${rows.length === 0 && html`<span class="muted">Closed</span>`}
              ${rows.map((w) => html`
                <span class="win">
                  <input type="time" step="300" value=${minToTime(w.startMin)}
                    onChange=${(e) => setWindows(windows.map((x, j) => j === w.i ? { ...x, startMin: timeToMin(e.target.value) } : x))} />
                  –
                  <input type="time" step="300" value=${minToTime(w.endMin)}
                    onChange=${(e) => setWindows(windows.map((x, j) => j === w.i ? { ...x, endMin: timeToMin(e.target.value) } : x))} />
                  <button class="linkish danger" onClick=${() => setWindows(windows.filter((_, j) => j !== w.i))}>✕</button>
                </span>`)}
              <button class="linkish" onClick=${() => setWindows([...windows, { weekday: wd, startMin: 540, endMin: 1020 }])}>+ add window</button>
            </div>
          </div>`;
      })}
      <button class="btn primary" onClick=${saveWindows}>Save hours</button>
    </section>

    <section class="panel">
      <h2>Booking rules</h2>
      <div class="grid-4">
        ${num('Session length (minutes)', 'durationMin')}
        ${num('Times offered every (minutes)', 'granularityMin')}
        ${num('Bumper around calendar events (minutes)', 'bumperMin')}
        ${num('Gap between appointments (minutes)', 'bookingBufferMin')}
        ${num('Minimum notice (hours)', 'leadHours')}
        ${num('How far ahead people can book (days)', 'horizonDays')}
      </div>
      <label>Timezone
        <select value=${settings.timezone} onChange=${(e) => saveSettings({ timezone: e.target.value })}>
          ${TIMEZONES.map((z) => html`<option value=${z}>${z}</option>`)}
        </select>
      </label>
    </section>

    <section class="panel">
      <h2>Sync your calendar</h2>
      <p class="muted">Paste your calendar's secret iCal address and booked times around your real life. In Google Calendar: Settings → your calendar → "Secret address in iCal format".</p>
      <label>Secret iCal URL
        <input type="url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
          value=${settings.calendarFeedUrl || ''}
          onInput=${(e) => setSettings((s) => ({ ...s, calendarFeedUrl: e.target.value }))} />
      </label>
      <div class="head-actions">
        <button class="btn" onClick=${testCalendar} disabled=${calTest && calTest.busy}>${calTest && calTest.busy ? 'Testing…' : 'Save + test connection'}</button>
      </div>
      ${calTest && !calTest.busy && html`
        <p class="banner ${calTest.ok ? 'ok' : 'err'}">
          ${calTest.ok ? `Connected. Found ${calTest.eventsNext7Days} event(s) in the next 7 days.` : `Could not read the feed: ${calTest.error}`}
        </p>`}
    </section>

    <section class="panel">
      <h2>Days off</h2>
      <p class="muted">Whole days with no bookings, on top of your weekly hours.</p>
      ${blackouts.map((b, i) => html`
        <div class="blackout-row">
          <input type="date" value=${b.date} onChange=${(e) => saveBlackouts(blackouts.map((x, j) => j === i ? { ...x, date: e.target.value } : x))} />
          <input placeholder="reason (just for you)" value=${b.reason || ''}
            onChange=${(e) => saveBlackouts(blackouts.map((x, j) => j === i ? { ...x, reason: e.target.value } : x))} />
          <button class="linkish danger" onClick=${() => saveBlackouts(blackouts.filter((_, j) => j !== i))}>✕</button>
        </div>`)}
      <button class="btn" onClick=${() => saveBlackouts([...blackouts, { date: new Date().toISOString().slice(0, 10), reason: '' }])}>Add a day off</button>
    </section>`;
}

/* ================================ bookings ================================ */

function Bookings({ notify }) {
  const [data, setData] = useState(null);
  const load = () => api('/api/admin/bookings').then(setData).catch((e) => notify(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (!data) return html`<p class="muted">Loading…</p>`;
  const cancel = async (id) => {
    if (!confirm('Cancel this appointment? The client is NOT emailed automatically, reach out to them directly.')) return;
    try {
      await api(`/api/admin/bookings/${id}/cancel`, { method: 'POST', body: {} });
      notify('Cancelled');
      load();
    } catch (e) { notify(e.message, 'err'); }
  };
  const upcoming = data.bookings.filter((b) => new Date(b.slot_start) > new Date());
  const past = data.bookings.filter((b) => new Date(b.slot_start) <= new Date());
  const row = (b) => html`
    <tr class=${b.status === 'cancelled' ? 'cancelled' : ''}>
      <td>${fmtWhen(b.slot_start, data.timezone)}</td>
      <td>${b.name}</td>
      <td>${b.email}${b.phone ? html`<br /><span class="muted">${b.phone}</span>` : ''}</td>
      <td>${b.note || ''}</td>
      <td>${b.status === 'cancelled'
        ? html`<span class="chip">cancelled${b.cancelled_by ? ` by ${b.cancelled_by}` : ''}</span>`
        : new Date(b.slot_start) > new Date()
          ? html`<button class="linkish danger" onClick=${() => cancel(b.id)}>Cancel</button>`
          : html`<span class="chip ok">done</span>`}</td>
    </tr>`;
  return html`
    <h1>Bookings</h1>
    <h2>Upcoming</h2>
    ${upcoming.length ? html`<table class="table"><thead><tr><th>When</th><th>Client</th><th>Contact</th><th>Note</th><th></th></tr></thead><tbody>${upcoming.map(row)}</tbody></table>`
      : html`<p class="muted">Nothing upcoming.</p>`}
    <h2>Past</h2>
    ${past.length ? html`<table class="table"><thead><tr><th>When</th><th>Client</th><th>Contact</th><th>Note</th><th></th></tr></thead><tbody>${past.map(row)}</tbody></table>`
      : html`<p class="muted">No past bookings.</p>`}`;
}

/* ================================ settings ================================ */

function Settings({ notify }) {
  const [settings, setSettings] = useState(null);
  useEffect(() => { api('/api/admin/settings').then(setSettings).catch((e) => notify(e.message, 'err')); }, []);
  if (!settings) return html`<p class="muted">Loading…</p>`;

  const save = async (patch) => {
    try {
      const r = await api('/api/admin/settings', { method: 'PUT', body: patch });
      setSettings((s) => ({ ...s, ...r.settings }));
      notify('Saved');
    } catch (e) { notify(e.message, 'err'); }
  };

  const changePassword = async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    try {
      await api('/api/admin/password', { method: 'POST', body: { current: f.current.value, next: f.next.value } });
      notify('Password changed');
      f.reset();
    } catch (e) { notify(e.message, 'err'); }
  };

  return html`
    <h1>Settings</h1>

    <section class="panel">
      <h2>Notifications</h2>
      <p class="muted">Where new bookings, cancellations, and contact messages get emailed.</p>
      <label>Notification email
        <input type="email" value=${settings.notifyEmail || ''}
          onChange=${(e) => save({ notifyEmail: e.target.value })} />
      </label>
      ${settings.notifyEmailStatus === 'pending_verification' && html`
        <p class="banner warn">Waiting for verification. Check that inbox for a Cloudflare confirmation email and click the link.</p>`}
    </section>

    <section class="panel">
      <h2>Password</h2>
      <form onSubmit=${changePassword}>
        <div class="two-col">
          <label>Current password<input type="password" name="current" required /></label>
          <label>New password (12+ chars, letters and numbers)<input type="password" name="next" required minlength="12" /></label>
        </div>
        <button class="btn">Change password</button>
      </form>
    </section>

    <section class="panel">
      <h2>Data retention</h2>
      <label>Keep client details for (months)
        <input type="number" min="1" max="84" value=${settings.retentionMonths}
          onChange=${(e) => save({ retentionMonths: Number(e.target.value) })} />
      </label>
      <p class="muted">Older bookings and contact messages are deleted automatically.</p>
    </section>

    <section class="panel">
      <h2>Advanced (Shane territory)</h2>
      <div class="two-col">
        <label>Email provider
          <select value=${settings.emailProvider} onChange=${(e) => save({ emailProvider: e.target.value })}>
            <option value="auto">auto</option><option value="cf">cloudflare</option>
            <option value="resend">resend</option><option value="stub">stub (test)</option>
          </select>
        </label>
        <label>Resend API key ${settings.resendApiKey === 'set' ? html`<span class="chip ok">set</span>` : ''}
          <input type="password" placeholder="re_…" onChange=${(e) => e.target.value && save({ resendApiKey: e.target.value })} />
        </label>
      </div>
      <label>Publish token expires on
        <input type="date" value=${settings.patExpiresOn || ''} onChange=${(e) => save({ patExpiresOn: e.target.value })} />
      </label>
      <label>Site title (internal)
        <input value=${settings.siteTitle} onChange=${(e) => save({ siteTitle: e.target.value })} />
      </label>
    </section>`;
}

render(html`<${App} />`, document.getElementById('app'));
