const crypto = require('crypto');
const db = require('./db');

const TIME_ZONE = 'Africa/Johannesburg';
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const OFFSET_MS = 2 * 60 * 60 * 1000; // South Africa has no daylight-saving time.

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function validDuration(value) { return Number.isInteger(value) && value > 0 && value <= 720; }
function timeToMinutes(value) { const [h, m] = value.split(':').map(Number); return h * 60 + m; }
function minutesToTime(value) { return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`; }
function salonDate(now = new Date()) { return new Date(new Date(now).getTime() + OFFSET_MS).toISOString().slice(0, 10); }
function localTimestamp(date, time) { return `${date}T${time}:00+02:00`; }
function addDays(date, count) { return new Date(Date.parse(`${date}T00:00:00Z`) + count * 86400000).toISOString().slice(0, 10); }

function validateHours(value) {
  let hours = value;
  if (typeof value === 'string') {
    try { hours = JSON.parse(value); } catch { return { ok: false, reason: 'invalid_hours' }; }
  }
  if (!hours || typeof hours !== 'object' || Array.isArray(hours) || Object.keys(hours).some(k => !DAY_KEYS.includes(k))) {
    return { ok: false, reason: 'invalid_hours' };
  }
  const normalized = {};
  for (const day of DAY_ORDER) {
    const range = hours[day];
    if (range === 'closed') { normalized[day] = 'closed'; continue; }
    if (typeof range !== 'string') return { ok: false, reason: 'invalid_hours' };
    const parts = range.split('-');
    if (parts.length !== 2 || !parts.every(validTime) || timeToMinutes(parts[0]) >= timeToMinutes(parts[1])) {
      return { ok: false, reason: 'invalid_hours' };
    }
    normalized[day] = range;
  }
  return { ok: true, hours: normalized };
}
function parseHours(client = {}) {
  const result = validateHours(client.hours == null || client.hours === '' ? db.DEFAULT_HOURS : client.hours);
  // Invalid saved configuration must fail closed, not silently use default opening hours.
  return result.ok ? result.hours : null;
}
function hoursForDate(hours, date) {
  if (!hours || !validDate(date)) return null;
  const range = hours[DAY_KEYS[new Date(`${date}T00:00:00Z`).getUTCDay()]];
  if (!range || range === 'closed') return null;
  const [open, close] = range.split('-');
  return { open, close };
}
function storedInstant(value) {
  if (typeof value !== 'string') return NaN;
  // Old BeautyDesk records were local wall-clock strings. Treat them as salon time,
  // independently of the operating system's timezone. New records include +02:00.
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
  return Date.parse(hasOffset ? value : `${value}+02:00`);
}
function busyIntervals(clientId) {
  return db.prepare("SELECT * FROM appointments WHERE client_id=? AND status='confirmed'").all(clientId).map(a => {
    const start = storedInstant(a.starts_at);
    return Number.isFinite(start) && validDuration(a.duration_mins) ? [start, start + a.duration_mins * 60000] : null;
  });
}
function slotCheck(clientId, client, durationMins, dateStr, time, now, busy) {
  if (!validDate(dateStr) || !validTime(time)) return 'bad_datetime';
  if (!validDuration(durationMins)) return 'invalid_duration';
  const start = Date.parse(localTimestamp(dateStr, time));
  const current = new Date(now).getTime();
  if (!Number.isFinite(current) || start <= current) return 'past_datetime';
  const hours = parseHours(client);
  if (!hours) return 'invalid_hours';
  const range = hoursForDate(hours, dateStr);
  if (!range) return 'closed';
  const minute = timeToMinutes(time);
  if (minute < timeToMinutes(range.open) || minute + durationMins > timeToMinutes(range.close)) return 'outside_hours';
  const intervals = busy || busyIntervals(clientId);
  if (intervals.some(i => !i)) return 'invalid_calendar';
  if (intervals.some(([s, e]) => start < e && start + durationMins * 60000 > s)) return 'slot_taken';
  return null;
}
function getAvailableSlots(clientId, client, durationMins, dateStr, { now = new Date() } = {}) {
  if (!validDate(dateStr) || !validDuration(durationMins)) return [];
  const range = hoursForDate(parseHours(client), dateStr);
  if (!range) return [];
  const busy = busyIntervals(clientId);
  const result = [];
  for (let t = timeToMinutes(range.open); t + durationMins <= timeToMinutes(range.close); t += 30) {
    const time = minutesToTime(t);
    if (!slotCheck(clientId, client, durationMins, dateStr, time, now, busy)) result.push(time);
  }
  return result;
}
function checkRequestedSlot(clientId, client, durationMins, dateStr, time, { now = new Date() } = {}) {
  const reason = slotCheck(clientId, client, durationMins, dateStr, time, now);
  return reason ? { ok: false, reason } : { ok: true };
}
// Only explicitly initialized salons use the additive modular scheduling domain.
// Keep imports lazy: salon's interval logic uses this module's date helpers.
function modularSalon(clientId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='salon_settings'").get()) return null;
  if (!db.prepare('SELECT 1 FROM salon_settings WHERE client_id=?').get(clientId)) return null;
  const salon = require('./modules/salon');
  return salon.isModular(clientId) ? salon : null;
}
function bookAppointment(clientId, details) {
  const { customerName, customerPhone, serviceName, durationMins, dateStr, time, source = 'whatsapp', now = new Date() } = details;
  const dryRun = details.dryRun === true || customerPhone === 'simulator' || source === 'simulator';
  const run = db.transaction(() => {
    const origin = details.incomingMessageId;
    if (!dryRun && source === 'whatsapp' && (typeof origin !== 'string' || !origin || origin.length > 512)) return { ok: false, reason: 'missing_message_id' };
    if (!dryRun && origin) {
      const existing = db.prepare('SELECT * FROM appointments WHERE client_id=? AND origin_message_id=?').get(clientId, origin);
      if (existing) {
        const same = existing.status === 'confirmed' && existing.customer_phone === customerPhone
          && existing.customer_name === String(customerName || '').trim()
          && existing.service_name.toLowerCase() === String(serviceName || '').trim().toLowerCase()
          && existing.duration_mins === durationMins && existing.starts_at === localTimestamp(dateStr, time)
          && (details.expectedPrice === undefined || details.expectedPrice === existing.price_at_booking)
          && (details.staffId === undefined || details.staffId === existing.staff_id)
          && (details.expectedDeposit === undefined || details.expectedDeposit === existing.deposit_amount);
        return same ? { ok: true, id: existing.id, startsAt: existing.starts_at, price: existing.price_at_booking, alreadyBooked: true }
          : { ok: false, reason: 'origin_already_used' };
      }
    }
    const client = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId);
    if (!client) return { ok: false, reason: 'unknown_client' };
    const service = db.prepare('SELECT * FROM services WHERE client_id=?').all(clientId)
      .find(s => typeof serviceName === 'string' && s.name.toLowerCase() === serviceName.trim().toLowerCase());
    if (!service || /[\p{Cc}\p{Cf}]/u.test(service.name)) return { ok: false, reason: 'unknown_service' };
    if (!validDuration(durationMins) || durationMins !== service.duration_mins) return { ok: false, reason: 'invalid_duration' };
    if (details.expectedPrice !== undefined && details.expectedPrice !== service.price) return { ok: false, reason: 'service_changed' };
    if (typeof customerName !== 'string' || !customerName.trim() || customerName.trim().length > 120 || /[\p{Cc}\p{Cf}]/u.test(customerName)) return { ok: false, reason: 'missing_customer_name' };
    if (!dryRun && (typeof customerPhone !== 'string' || !/^\+?\d{7,15}$/.test(customerPhone))) return { ok: false, reason: 'missing_customer_phone' };
    if (details.photoSelection) {
      const session = db.prepare('SELECT * FROM photo_sessions WHERE id=? AND client_id=? AND customer_phone=?').get(details.photoSelection.sessionId,clientId,customerPhone);
      if (!client.photo_estimates_enabled || !session || session.stage !== 'booking' || !session.consent_at || Date.parse(session.expires_at) <= new Date(now).getTime()
          || session.selected_json !== JSON.stringify(require('./photo-flow').snapshot(service)) || service.photo_eligible !== 1) return {ok:false,reason:'service_changed'};
    }
    const salon = modularSalon(clientId);
    const availability = salon ? salon.checkSlot(clientId, service.id, dateStr, time, { staffId: details.staffId, now })
      : checkRequestedSlot(clientId, client, durationMins, dateStr, time, { now });
    if (!availability.ok) return availability;
    if (salon && details.expectedStaffName !== undefined && details.expectedStaffName !== availability.staff?.name) return { ok: false, reason: 'staff_changed' };
    if (salon && details.expectedDeposit !== undefined && details.expectedDeposit !== service.deposit_amount) return { ok: false, reason: 'deposit_changed' };
    const startsAt = localTimestamp(dateStr, time);
    if (dryRun) return { ok: true, dryRun: true, startsAt };
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO appointments (id,client_id,customer_name,customer_phone,service_name,starts_at,duration_mins,status,source,created_at,origin_message_id,price_at_booking)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, clientId, customerName.trim(), customerPhone, service.name, startsAt, durationMins, 'confirmed', source, new Date(now).toISOString(), origin || null, service.price);
    if (details.photoSelection) db.prepare("UPDATE appointments SET quote_kind='photo_menu_estimate',photo_session_id=? WHERE id=?").run(details.photoSelection.sessionId,id);
    if (salon) salon.recordLegacyAppointment(id, availability.staff.id);
    return { ok: true, id, startsAt };
  });
  // BEGIN IMMEDIATE protects the read-check-write sequence across SQLite connections.
  return run.immediate();
}

module.exports = { TIME_ZONE, DAY_KEYS, DAY_ORDER, validateHours, validDate, validTime, validDuration, parseHours, hoursForDate,
  salonDate, addDays, getAvailableSlots, checkRequestedSlot, bookAppointment, storedInstant, modularSalon };
