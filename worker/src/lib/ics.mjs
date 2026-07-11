// Minimal, spec-correct iCalendar generation for bookings (single VEVENT for
// email attachments / downloads, and the tokenized subscribe feed for Sean).

function icsEscape(s) {
  return String(s || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDate(iso) {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function foldLine(line) {
  // RFC 5545: lines longer than 75 octets are folded with CRLF + space.
  const out = [];
  let rest = line;
  while (rest.length > 74) {
    out.push(rest.slice(0, 74));
    rest = ` ${rest.slice(74)}`;
  }
  out.push(rest);
  return out.join('\r\n');
}

function vevent({ uid, start, end, summary, description, location, status = 'CONFIRMED', stampIso }) {
  return [
    'BEGIN:VEVENT',
    `UID:${icsEscape(uid)}`,
    `DTSTAMP:${icsDate(stampIso || start)}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    foldLine(`SUMMARY:${icsEscape(summary)}`),
    description ? foldLine(`DESCRIPTION:${icsEscape(description)}`) : null,
    location ? foldLine(`LOCATION:${icsEscape(location)}`) : null,
    `STATUS:${status}`,
    'END:VEVENT',
  ].filter(Boolean).join('\r\n');
}

export function bookingIcs(booking, siteTitle) {
  const body = vevent({
    uid: `booking-${booking.id}@seanhase.ca`,
    start: booking.slot_start,
    end: booking.slot_end,
    summary: `${siteTitle}: session with ${booking.name}`,
    description: [
      `Client: ${booking.name} <${booking.email}>`,
      booking.phone ? `Phone: ${booking.phone}` : null,
      booking.note ? `Note: ${booking.note}` : null,
    ].filter(Boolean).join('\n'),
    stampIso: booking.created_at ? new Date(booking.created_at).toISOString() : undefined,
  });
  return wrapCalendar([body], { method: 'PUBLISH' });
}

export function bookingsFeedIcs(bookings, siteTitle) {
  const events = bookings.map((b) => vevent({
    uid: `booking-${b.id}@seanhase.ca`,
    start: b.slot_start,
    end: b.slot_end,
    summary: `${siteTitle}: ${b.name}`,
    description: [`${b.name} <${b.email}>`, b.phone, b.note].filter(Boolean).join('\n'),
    status: b.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED',
    stampIso: b.created_at ? new Date(b.created_at).toISOString() : undefined,
  }));
  return wrapCalendar(events, { name: `${siteTitle} bookings` });
}

function wrapCalendar(events, { method, name } = {}) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//seanhase.ca//booking//EN',
    'CALSCALE:GREGORIAN',
    method ? `METHOD:${method}` : null,
    name ? foldLine(`X-WR-CALNAME:${icsEscape(name)}`) : null,
    ...events,
    'END:VCALENDAR',
    '',
  ].filter((l) => l !== null).join('\r\n');
}
