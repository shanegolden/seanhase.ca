/* seanhase.ca front-end: booking widget, manage view, contact form, reveals.
   All times arrive as UTC ISO; everything shown to the visitor is formatted in
   the clinic timezone so the labels match Sean's actual door. */

(() => {
  const API = window.SEANHASE_API || 'https://api.seanhase.ca';
  const $ = (sel, el = document) => el.querySelector(sel);

  /* ---------- reveal on scroll ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  $('#year').textContent = new Date().getFullYear();

  /* ---------- shared formatting ---------- */
  let TZ = 'America/Vancouver';
  const fmtDay = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, weekday: 'short' }).format(new Date(iso));
  const fmtNum = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, day: 'numeric' }).format(new Date(iso));
  const fmtMonth = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, month: 'short' }).format(new Date(iso));
  const fmtTime = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)).replace(/\./g, '').replace(/\s/g, ' ');
  const fmtLong = (iso) => new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso)).replace(/\./g, '');
  const dayKey = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const tzLabel = () => {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, timeZoneName: 'long' }).formatToParts(new Date());
    return (parts.find((p) => p.type === 'timeZoneName') || {}).value || TZ;
  };

  async function api(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    let data = {};
    try { data = await res.json(); } catch { /* non-JSON error */ }
    if (!res.ok) throw Object.assign(new Error(data.error || `request failed (${res.status})`), { status: res.status, data });
    return data;
  }

  /* ---------- booking widget ---------- */
  const widget = $('#booking-widget');
  if (!widget) return;
  const views = {
    loading: $('.bw-loading', widget),
    error: $('.bw-error', widget),
    main: $('.bw-main', widget),
    success: $('.bw-success', widget),
    manage: $('.bw-manage', widget),
  };
  const show = (name) => {
    for (const [k, el] of Object.entries(views)) el.hidden = k !== name;
    views.loading.style.display = name === 'loading' ? '' : 'none';
    widget.dataset.state = name;
  };

  let slotsByDay = new Map();
  let selectedDay = null;
  let selectedSlot = null;

  async function loadSlots() {
    show('loading');
    try {
      const data = await api('/api/slots');
      TZ = data.timezone || TZ;
      $('#bw-tz').textContent = `Times shown in ${tzLabel()}`;
      if (data.calendarUnavailable) { show('error'); return; }
      slotsByDay = new Map();
      for (const s of data.slots) {
        const k = dayKey(s.start);
        if (!slotsByDay.has(k)) slotsByDay.set(k, []);
        slotsByDay.get(k).push(s);
      }
      if (!slotsByDay.size) {
        show('main');
        $('#bw-days').innerHTML = '';
        $('#bw-slots').innerHTML = '';
        $('#bw-empty').hidden = false;
        return;
      }
      $('#bw-empty').hidden = true;
      renderDays();
      show('main');
    } catch {
      show('error');
    }
  }

  function renderDays() {
    const days = [...slotsByDay.keys()].sort();
    if (!selectedDay || !slotsByDay.has(selectedDay)) selectedDay = days[0];
    const el = $('#bw-days');
    el.innerHTML = '';
    for (const k of days) {
      const first = slotsByDay.get(k)[0].start;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day-chip';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(k === selectedDay));
      b.innerHTML = `<span class="dow">${fmtDay(first)}</span><span class="num">${fmtNum(first)}</span><span class="cnt">${fmtMonth(first)} · ${slotsByDay.get(k).length} open</span>`;
      b.addEventListener('click', () => { selectedDay = k; hideForm(); renderDays(); });
      el.appendChild(b);
    }
    renderSlots();
  }

  function renderSlots() {
    const el = $('#bw-slots');
    el.innerHTML = '';
    for (const s of slotsByDay.get(selectedDay) || []) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'slot-chip';
      b.textContent = fmtTime(s.start);
      b.addEventListener('click', () => pickSlot(s));
      el.appendChild(b);
    }
  }

  function pickSlot(s) {
    selectedSlot = s;
    $('#bw-picked').innerHTML = `Booking: <em>${fmtLong(s.start)}</em>`;
    $('#bw-form').hidden = false;
    $('#bw-form-error').hidden = true;
    $('#bw-slots').style.display = 'none';
    $('#bw-days').style.display = 'none';
    $('#bw-form').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function hideForm() {
    $('#bw-form').hidden = true;
    $('#bw-slots').style.display = '';
    $('#bw-days').style.display = '';
    selectedSlot = null;
  }
  $('#bw-back').addEventListener('click', () => { hideForm(); loadSlots(); });

  $('#bw-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!selectedSlot) return;
    const f = ev.target;
    const btn = $('#bw-submit');
    btn.disabled = true;
    btn.textContent = 'Booking…';
    $('#bw-form-error').hidden = true;
    try {
      const data = await api('/api/bookings', {
        method: 'POST',
        body: JSON.stringify({
          name: f.name.value, email: f.email.value, phone: f.phone.value,
          note: f.note.value, start: selectedSlot.start, consent: f.consent.checked,
        }),
      });
      showSuccess(data);
    } catch (e) {
      $('#bw-form-error').textContent = e.message;
      $('#bw-form-error').hidden = false;
      if (e.status === 409) { hideForm(); await loadSlots(); $('#bw-form-error').hidden = false; views.main.prepend($('#bw-form-error')); }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Confirm booking';
    }
  });

  function showSuccess(data) {
    $('#bw-success-when').textContent = `${fmtLong(data.booking.start)} (${tzLabel()})`;
    const blob = new Blob([data.ics], { type: 'text/calendar' });
    $('#bw-ics').href = URL.createObjectURL(blob);
    const g = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    $('#bw-gcal').href = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`Massage with Sean Hase`)}&dates=${g(data.booking.start)}/${g(data.booking.end)}`;
    const manageUrl = `${location.origin}${location.pathname}#manage=${data.manageToken}`;
    const a = $('#bw-manage-link');
    a.href = manageUrl;
    a.textContent = manageUrl;
    show('success');
    widget.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ---------- manage view (tokenized link) ---------- */
  async function openManage(token) {
    show('loading');
    widget.scrollIntoView({ block: 'center' });
    try {
      const data = await api(`/api/bookings/manage/${token}`);
      TZ = data.timezone || TZ;
      $('#bw-manage-when').textContent = `${fmtLong(data.booking.start)} (${tzLabel()})`;
      const cancelled = data.booking.status === 'cancelled';
      const past = new Date(data.booking.start) < new Date();
      $('#bw-manage-status').textContent = cancelled ? 'This appointment was cancelled.'
        : past ? 'This appointment is in the past.' : 'This appointment is confirmed.';
      $('#bw-manage-cancel').hidden = cancelled || past;
      $('#bw-manage-rebook').hidden = !cancelled && !past;
      const icsBtn = $('#bw-manage-ics');
      if (data.ics && !cancelled && !past) {
        icsBtn.hidden = false;
        icsBtn.href = URL.createObjectURL(new Blob([data.ics], { type: 'text/calendar' }));
      } else icsBtn.hidden = true;
      $('#bw-manage-cancel').onclick = async () => {
        if (!confirm('Cancel this appointment?')) return;
        try {
          await api(`/api/bookings/manage/${token}/cancel`, { method: 'POST' });
          $('#bw-manage-status').textContent = 'Cancelled. The time is open for someone else now.';
          $('#bw-manage-cancel').hidden = true;
          $('#bw-manage-ics').hidden = true;
          $('#bw-manage-rebook').hidden = false;
        } catch (e) {
          $('#bw-manage-error').textContent = e.message;
          $('#bw-manage-error').hidden = false;
        }
      };
      show('manage');
    } catch {
      $('#bw-manage-when').textContent = '';
      $('#bw-manage-status').textContent = 'That link is not valid anymore.';
      $('#bw-manage-cancel').hidden = true;
      $('#bw-manage-ics').hidden = true;
      $('#bw-manage-rebook').hidden = false;
      show('manage');
    }
  }

  const manageMatch = location.hash.match(/^#manage=([a-f0-9]{16,64})$/);
  if (manageMatch) openManage(manageMatch[1]);
  else loadSlots();
  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#manage=([a-f0-9]{16,64})$/);
    if (m) openManage(m[1]);
    else if (location.hash === '#book' && widget.dataset.state === 'manage') loadSlots();
  });

  /* ---------- contact form ---------- */
  const cf = $('#contact-form');
  cf.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('button[type=submit]', cf);
    btn.disabled = true;
    $('#contact-error').hidden = true;
    try {
      await api('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: cf.name.value, email: cf.email.value, message: cf.message.value, website: cf.website.value,
        }),
      });
      $('#contact-success').hidden = false;
      cf.querySelectorAll('input:not(.hp), textarea').forEach((el) => { el.value = ''; });
    } catch (e) {
      $('#contact-error').textContent = e.message;
      $('#contact-error').hidden = false;
    } finally {
      btn.disabled = false;
    }
  });
})();
