const booking = require('./booking');
const { TIME_ZONE, DAY_ORDER, parseHours, hoursForDate, salonDate, addDays, validDate, getAvailableSlots, checkRequestedSlot, bookAppointment } = booking;
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const CONFIRM_HEADER = 'Please confirm your booking:';
const YES = /^(?:yes(?: please)?|confirm(?: booking)?|yes,? (?:book it|confirm)|book it|go ahead|sure|okay|ok)[.!\s]*$/i;
const NEW_BOOKING = /\b(?:new|another|separate)\s+(?:booking|appointment)\b/i;
const CANCEL = /^(?:cancel|stop|never mind|nevermind|no thanks|no)[.!\s]*$/i;

// Tri-state: a positive separate-booking request starts intent; cancellation or
// explicit negation revokes it; unrelated conversation leaves it unchanged.
function additionalBookingIntent(message) {
  const text = String(message || '').trim().replace(/[’‘]/g, "'");
  if (CANCEL.test(text) || /^(?:no)\b/i.test(text) || /\b(?:cancel|stop|nevermind)\b|never mind/i.test(text)
      || /\b(?:don't|do not|dont)\s+(?:book|confirm)\b/i.test(text)) return false;
  if (!NEW_BOOKING.test(text)) return null;
  return !/\b(?:no|not|never|don't|dont|cannot|can't)\b|do not/i.test(text);
}

function describeHours(hours) {
  if (!hours) return 'The salon needs to check its opening hours. Please contact the salon directly before booking.';
  const labels = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  const open = DAY_ORDER.filter(day => hours[day] !== 'closed').map(day => `${labels[day]} ${hours[day]}`);
  return open.length ? `We're open ${open.join(', ')} (South Africa time).` : 'Online booking is currently closed. Please contact the salon directly.';
}
function describeServices(services) {
  return services.length ? `Here's what we offer: ${services.map(s => `${s.name} (R${s.price}, ${s.duration_mins} min)`).join(', ')}.`
    : "The salon hasn't loaded its services yet. Please contact the salon directly to book.";
}
function serviceQuestion(services) {
  return services.length ? `Which service would you like to book? ${services.map(s => `${s.name} (R${s.price})`).join(', ')}.` : describeServices(services);
}
function frontDoor(client) {
  return `Hi! Welcome to ${client.salon}.\n1. Book Appointment\n2. View Services\n3. My Appointment\n4. Contact Salon\nReply with an option.`;
}
function isFrontDoor(text) { return /1\. Book Appointment\n2\. View Services/.test(text || ''); }
function modularMessage(message, previousReply, services) {
  const value = message.trim();
  if (isFrontDoor(previousReply)) return ({ '1': 'Book Appointment', '2': 'View Services', '3': 'My Appointment', '4': 'Contact Salon' })[value] || message;
  if (/^Which service would you like to book\?\n/.test(previousReply) && /^\d+$/.test(value)) {
    const shown = previousReply.split('\n').find(line => line.startsWith(`${Number(value)}. `));
    return services.find(s => shown === `${Number(value)}. ${s.name} (R${s.price}, ${s.duration_mins} min)`)?.name || message;
  }
  return message;
}
function modularServiceQuestion(services) {
  return services.length ? `Which service would you like to book?\n${services.map((s, i) => `${i + 1}. ${s.name} (R${s.price}, ${s.duration_mins} min)`).join('\n')}\nReply with a service name or number.` : describeServices(services);
}
function qualifiedTechnicians(salon, clientId, serviceId) {
  return salon.qualifiedStaff(clientId, serviceId).filter(s => typeof s.name === 'string' && s.name.trim() && !/[\p{Cc}\p{Cf}]/u.test(s.name));
}
function technicianLabel(staff, roster) {
  // A reference is necessary only when two qualified technicians share a name.
  return roster.filter(s => s.name === staff.name).length > 1 ? `${staff.name} [${staff.id}]` : staff.name;
}
function technicianQuestion(salon, clientId, service) {
  const roster = qualifiedTechnicians(salon, clientId, service.id);
  if (!roster.length) return `There are no qualified technicians available to book ${service.name} online. Please contact the salon directly.`;
  return `Which technician would you prefer for ${service.name}?\n${roster.map((s, i) => `${i + 1}. ${technicianLabel(s, roster)}`).join('\n')}\n${roster.length + 1}. Any qualified technician\nReply with a name, number, or \"any\".`;
}
function applyBookingInput(state, message, previousReply, services, now, salon, clientId) {
  if (!salon) return applyInput(state, message, previousReply, services, now);
  const previousServiceId = state.service?.id;
  const normalized = modularMessage(message, previousReply, services);
  const technicianIntent = /\b(?:with|technician|stylist|staff member)\b/i.test(normalized);
  // A technician correction must not be mistaken for an unknown service change.
  state = applyInput(state, technicianIntent ? normalized.replace(/\b(?:actually|instead)\b/gi, '') : normalized, previousReply, services, now);
  if (!state.service || previousServiceId !== state.service.id) {
    delete state.staffId;
    delete state.staffPreference;
  }
  if (!state.active || !state.service) return state;
  const roster = qualifiedTechnicians(salon, clientId, state.service.id);
  const selecting = /^Which technician would you prefer/.test(previousReply);
  const changing = /\b(?:change|different|another)\s+(?:the\s+)?(?:technician|stylist|staff member)\b/i.test(normalized);
  const text = normalized.trim().replace(/[.!]+$/, '');
  if (changing) { delete state.staffId; delete state.staffPreference; }
  const number = selecting && /^\d+$/.test(text) ? Number(text) : null;
  const shownChoice = number === null ? null : previousReply.split('\n').find(line => line.startsWith(`${number}. `))?.slice(`${number}. `.length);
  if (/^(?:any(?: qualified)?(?: technician| stylist| staff member)?|anyone|no preference)$/i.test(text)
      || /\bwith\s+(?:anyone|any(?: qualified)? technician|any stylist)\b/i.test(text)
      || shownChoice === 'Any qualified technician') {
    state.staffPreference = 'any';
    delete state.staffId;
  } else {
    const matches = roster.filter(staff => {
      const label = technicianLabel(staff, roster);
      if ((selecting || changing) && text.toLowerCase() === label.toLowerCase()) return true;
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b(?:with|(?:technician|stylist|staff member)\\s+to)\\s+${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text);
    });
    const shownMatches = shownChoice ? roster.filter(s => technicianLabel(s, roster) === shownChoice) : [];
    const chosen = number !== null ? (shownMatches.length === 1 ? shownMatches[0] : null) : matches.length === 1 ? matches[0] : null;
    if (chosen) { state.staffId = chosen.id; state.staffPreference = 'specific'; }
  }
  if (state.staffId && !roster.some(s => s.id === state.staffId)) { delete state.staffId; delete state.staffPreference; }
  return state;
}
function contactSalon(client) {
  const phone = typeof client.phone === 'string' && /^\+?[\d ()-]{7,24}$/.test(client.phone) ? ` on ${client.phone}` : '';
  return `Please contact ${client.salon} directly${phone} for help.`;
}
function reminderPreference(input) {
  const command = String(input.incomingMessage || '').trim().replace(/[.!]+$/, '').trim().toUpperCase();
  if (!['STOP', 'STOP REMINDERS', 'UNSUBSCRIBE', 'START REMINDERS'].includes(command)) return null;
  const salon = booking.modularSalon(input.client.id);
  if (!salon) return null;
  const enable = command === 'START REMINDERS', stopDraft = command === 'STOP';
  if (input.dryRun === true || input.customerPhone === 'simulator') return { handled: true, mode: 'rules', text: `Simulator preview: reminders would be turned ${enable ? 'on' : 'off'} for a recognized customer. No reminder preferences or appointments were changed.` };
  if (typeof input.customerPhone !== 'string' || !/^\+?[1-9]\d{6,14}$/.test(input.customerPhone)) {
    return { handled: true, mode: 'rules', text: `I can't verify your WhatsApp number, so I haven't changed reminder preferences. ${contactSalon(input.client)}` };
  }
  const sender = input.customerPhone.replace(/^\+/, '');
  const customer = require('./db').prepare('SELECT id, opt_out_at FROM customers WHERE client_id=? AND phone=?').get(input.client.id, sender);
  if (!customer) return { handled: true, mode: 'rules', text: `${stopDraft ? "I've stopped this booking request. " : ''}${enable ? `I couldn't find a customer record for this WhatsApp number. Please book an appointment or contact the salon before enabling reminders.` : 'No reminders are enabled for this WhatsApp number.'} Existing appointments are unchanged.` };
  // A delayed or same-second START cannot undo a more recent STOP. Meta's
  // second-resolution sender timestamp is the authorization clock here.
  if (enable && customer.opt_out_at) {
    const sentAt = new Date(input.messageAt || input.now || new Date()).getTime();
    const optedOutAt = Date.parse(customer.opt_out_at);
    if (!Number.isFinite(sentAt) || Math.floor(sentAt / 1000) <= Math.floor(optedOutAt / 1000)) {
      return { handled: true, mode: 'rules', text: 'Reminders are still off. If you want to turn them on, please wait two seconds and send START REMINDERS again. Existing appointments are unchanged.' };
    }
  }
  salon.setOptIn(input.client.id, customer.id, enable);
  return { handled: true, mode: 'rules', text: `${stopDraft ? "I've stopped this booking request. " : ''}${enable ? 'Your reminder preference is on. Reminder delivery still depends on the salon enabling its messaging service.' : 'Reminders are off for this WhatsApp number.'} Existing appointments are unchanged.` };
}
function managementLink(salon, clientId, appointmentId) {
  if (!process.env.PUBLIC_BASE_URL || !process.env.JWT_SECRET) return null;
  try {
    const base = new URL(process.env.PUBLIC_BASE_URL);
    if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !['', '/'].includes(base.pathname)) return null;
    const token = salon.manageToken(clientId, appointmentId);
    const verified = salon.fromToken(token);
    if (verified.clientId !== clientId || verified.booking.id !== appointmentId) return null;
    return `${base.origin}/manage/${encodeURIComponent(token)}`;
  } catch { return null; }
}
function customerAppointments(client, customerPhone, now, salon) {
  if (typeof customerPhone !== 'string' || !/^\+?\d{7,15}$/.test(customerPhone)) return `I can't verify your WhatsApp number. ${contactSalon(client)}`;
  const sender = customerPhone.replace(/^\+/, '');
  const appointments = require('./db').prepare("SELECT a.*, s.name AS staff_name FROM appointments a LEFT JOIN staff s ON s.client_id=a.client_id AND s.id=a.staff_id WHERE a.client_id=? AND (a.customer_phone=? OR a.customer_phone=?) ORDER BY a.starts_at DESC, a.created_at DESC").all(client.id, sender, '+' + sender)
    .filter(a => ['confirmed', 'pending'].includes(a.status) && booking.storedInstant(a.starts_at) >= new Date(now).getTime()).reverse().slice(0, 5);
  if (!appointments.length) return `I couldn't find an upcoming appointment for this WhatsApp number. ${contactSalon(client)} You can also choose Book Appointment.`;
  let hasLink = false;
  const lines = appointments.map(a => {
    const instant = booking.storedInstant(a.starts_at);
    const date = salonDate(instant), time = new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(instant);
    const link = managementLink(salon, client.id, a.id);
    if (link) hasLink = true;
    return `${a.service_name}${a.staff_name ? ` with ${a.staff_name}` : ''}: ${date} at ${time} (South Africa), ${a.status}.${link ? `\nManage this appointment: ${link}` : ''}`;
  });
  return `Your upcoming appointments:\n${lines.join('\n')}\n${hasLink ? 'Use your private management link to view cancellation and rescheduling options. ' : 'To cancel or reschedule, '}${contactSalon(client).replace(/^Please /, 'please ')}`;
}
function nameIsUsable(value) {
  return typeof value === 'string' && value.trim().length >= 2 && value.trim().length <= 120
    && !/[\p{Cc}\p{Cf}:]/u.test(value) && !/^(?:simulator|whatsapp customer|customer|unknown)$/i.test(value.trim());
}
function parseDate(message, now) {
  const text = message.toLowerCase();
  const today = salonDate(now);
  let match = text.match(/\b(\d{4}-\d{1,2}-\d{1,2})\b/);
  if (match) return { found: true, date: validDate(match[1]) ? match[1] : null };
  match = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (match) {
    const date = `${match[3] || today.slice(0, 4)}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return { found: true, date: validDate(date) ? date : null };
  }
  const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  match = text.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/);
  if (match) {
    const month = months.findIndex(m => m.startsWith(match[2])) + 1;
    const date = `${match[3] || today.slice(0, 4)}-${String(month).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
    return { found: true, date: validDate(date) ? date : null };
  }
  if (/\byesterday\b/.test(text)) return { found: true, date: addDays(today, -1) };
  if (/\bday after tomorrow\b/.test(text)) return { found: true, date: addDays(today, 2) };
  if (/\btomorrow\b/.test(text)) return { found: true, date: addDays(today, 1) };
  if (/\btoday\b/.test(text)) return { found: true, date: today };
  for (let i = 0; i < DAY_NAMES.length; i++) {
    if (new RegExp(`\\b${DAY_NAMES[i]}\\b`).test(text)) {
      const day = new Date(`${today}T00:00:00Z`).getUTCDay();
      let diff = (i - day + 7) % 7;
      if (new RegExp(`\\bnext\\s+${DAY_NAMES[i]}\\b`).test(text)) diff = diff || 7;
      if (new RegExp(`\\blast\\s+${DAY_NAMES[i]}\\b`).test(text)) diff -= 7;
      return { found: true, date: addDays(today, diff) };
    }
  }
  return { found: false };
}
function parseTime(message, expectingTime) {
  const text = message.toLowerCase();
  // A date's day/month digits must never be mistaken for a chosen time.
  let match = text.match(/\b(\d{1,2})(?::(\d{2})|h(\d{2})?)(?:\s*(am|pm))?\b/);
  if (!match) {
    const ampm = text.match(/\b(\d{1,2})\s*(am|pm)\b/);
    if (ampm) match = [ampm[0], ampm[1], '00', undefined, ampm[2]];
  }
  if (!match) {
    const plain = text.match(/\bat\s+(\d{1,2})(?!\d|[:/.-])\b/)
      || (expectingTime && text.match(/^\s*(\d{1,2})\s*$/));
    if (plain) match = [plain[0], plain[1], '00'];
  }
  if (!match) return { found: false };
  let hour = Number(match[1]);
  const minute = Number(match[2] || match[3] || 0);
  const period = match[4];
  if ((period && (hour < 1 || hour > 12)) || hour > 23 || minute > 59) return { found: true, time: null };
  if (period) hour = hour % 12 + (period === 'pm' ? 12 : 0);
  return { found: true, time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}` };
}
function findService(message, services) {
  const normalized = message.toLowerCase();
  const matches = services.filter(s => {
    const escaped = s.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'u').test(normalized);
  });
  // Prefer an exact longer name over a name contained within it (e.g. Gel / Gel Nails).
  const specific = matches.filter(s => !matches.some(other => other !== s && other.name.toLowerCase().includes(s.name.toLowerCase())));
  return specific.length === 1 ? specific[0] : null;
}
function confirmationFrom(text, services, salon, clientId) {
  if (!text.startsWith(CONFIRM_HEADER)) return null;
  const fields = {};
  for (const name of ['Service', 'Date', 'Time', 'Name']) {
    const match = text.match(new RegExp(`^${name}: (.+)$`, 'm'));
    if (!match) return null;
    fields[name.toLowerCase()] = match[1];
  }
  const service = services.find(s => s.name === fields.service);
  const time = fields.time.replace(' (South Africa)', '');
  const price = text.match(/^Price: R(\d+(?:\.\d+)?)$/m);
  const duration = text.match(/^Duration: (\d+) min$/m);
  if (!service || /[\p{Cc}\p{Cf}]/u.test(service.name) || !price || Number(price[1]) !== service.price || !duration || Number(duration[1]) !== service.duration_mins
      || !validDate(fields.date) || !booking.validTime(time) || !nameIsUsable(fields.name)) return null;
  const state = { active: true, service, date: fields.date, time, name: fields.name };
  if (salon) {
    const technician = text.match(/^Technician: (.+)$/m), reference = text.match(/^Technician reference: (.+)$/m), deposit = text.match(/^Deposit: R(\d+(?:\.\d+)?)(?: .*)?$/m);
    const roster = qualifiedTechnicians(salon, clientId, service.id);
    const matches = technician && reference ? roster.filter(s => s.id === reference[1] && technicianLabel(s, roster) === technician[1]) : [];
    if (matches.length !== 1 || !deposit || Number(deposit[1]) !== salon.depositAmount(clientId, service.id)) return null;
    state.staffId = matches[0].id;
    state.staffPreference = 'specific';
    state.staffName = matches[0].name;
    state.deposit = Number(deposit[1]);
  }
  return state;
}
function applyInput(state, message, previousReply, services, now) {
  const text = message.trim().replace(/[’‘]/g, "'");
  const service = findService(text, services);
  const day = parseDate(text, now);
  const clock = parseTime(text, /(?:what time|available times|choose a time|another time)/i.test(previousReply));
  const explicitName = text.match(/\b(?:my name is|name is|i am|i'm|it is|it's|for)\s+([\p{L}][\p{L}\p{M} .'-]{1,119})[.!]?$/iu);
  let name = explicitName?.[1]?.trim().replace(/[.!]+$/, '');
  if (name && (/\b(?:book|booking|today|tomorrow|please|on|at|am|pm)\b/i.test(name) || findService(name, services) || parseDate(name, now).found)) name = null;
  if (!name && /what name should/i.test(previousReply) && /^[\p{L}][\p{L}\p{M} .'-]{1,119}$/u.test(text)
      && !service && !day.found && !YES.test(text) && !CANCEL.test(text)) name = text;
  if (additionalBookingIntent(text) === false) return { active: false, cancelled: true };
  if (additionalBookingIntent(text) === true) state = { active: true, name: state.name };
  if (service) {
    if (new RegExp(`\\b(?:not|no)\\s+${service.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text)) {
      state.service = null;
      state.time = null;
    } else {
      if (state.service?.id !== service.id) state.time = null;
      state.service = service;
    }
    state.active = true;
  } else if (/\b(?:change (?:the )?service|different service|instead of)\b/i.test(text)
      || (/\b(?:actually|instead)\b/i.test(text) && !day.found && !clock.found && !name)) {
    state.service = null;
    state.time = null;
  }
  if (day.found) {
    if (day.date !== state.date) state.time = null;
    state.date = day.date;
    state.invalidDate = !day.date;
    state.active = true;
  }
  if (clock.found) { state.time = clock.time; state.invalidTime = !clock.time; state.active = true; }
  if (nameIsUsable(name)) state.name = name;
  if (/\b(?:book(?:ing)?s?|appointments?|availability|available|free slots?)\b/i.test(text)) state.active = true;
  return state;
}
function rebuildState(history, services, customerName, now, salon, clientId) {
  let state = { active: false, name: nameIsUsable(customerName) ? customerName.trim() : undefined };
  let previousReply = '';
  for (const message of history) {
    if (typeof message?.body !== 'string') continue;
    if (message.direction === 'out') {
      previousReply = message.body;
      const confirmed = confirmationFrom(previousReply, services, salon, clientId);
      if (confirmed) state = confirmed;
      if (/^(?:You're booked!|Preview complete:|I've stopped this booking request)/.test(previousReply)) state = { active: false, name: state.name };
    } else if (message.direction === 'in') {
      const timestamp = message.created_at && Number.isFinite(Date.parse(message.created_at)) ? new Date(message.created_at) : now;
      state = applyBookingInput(state, message.body, previousReply, services, timestamp, salon, clientId);
    }
  }
  return { state, previousReply };
}
function failureText(reason) {
  const messages = {
    past_datetime: 'That date or time has already passed in South Africa. Which future date and time would you like?',
    bad_datetime: 'Please use a valid date (YYYY-MM-DD) and time (for example 14:30).',
    closed: "We're closed on that date. Which other day would you like?",
    outside_hours: "That appointment would be outside the salon's opening hours. Please choose another time.",
    slot_taken: 'That time is no longer available. Please choose another time.',
    missing_customer_phone: "I can't verify your WhatsApp number for this booking. Please contact the salon directly.",
    invalid_hours: 'The salon needs to check its opening hours. Please contact the salon directly before booking.',
    invalid_calendar: 'The salon needs to check its calendar. Please contact the salon directly before booking.',
    unknown_service: 'That service is no longer available. Which other service would you like?',
    missing_message_id: 'I cannot verify this booking request. Please contact the salon directly.',
    origin_already_used: 'This request already belongs to an existing booking. Please contact the salon directly to change it.',
    service_changed: 'The service details have changed. Please ask for a new booking summary before confirming.',
    staff_changed: 'The technician details have changed. Please choose a technician again and review a new booking summary.',
    no_qualified_staff: 'There are no qualified technicians for that service. Please contact the salon directly.',
    unqualified_staff: 'That technician is no longer available for this service. Please choose another technician.',
    staff_unavailable: 'That technician is not available at this time. Please choose another time or technician.',
    deposit_changed: 'The deposit details have changed. Please review a new booking summary before confirming.',
    booking_disabled: 'Online booking is currently disabled. Please contact the salon directly.',
    booking_horizon: 'Please choose a date within the next year.',
  };
  return messages[reason] || "I couldn't complete that booking. Please contact the salon directly.";
}
function rulesRespond({ client, services = [], history = [], incomingMessage, customerPhone, customerName, dryRun, now = new Date(), messageAt = now, receivedAt = now, incomingMessageId, confirmationMessageId, latestBooking, allowAdditionalBooking, bookingNeedsReview = false, photoSelection }) {
  const reminder = reminderPreference({ client, incomingMessage, customerPhone, dryRun, now, messageAt });
  if (reminder) return reminder;
  const salon = booking.modularSalon(client.id), clientId = client.id;
  if (salon) services = services.filter(s => s.active !== 0);
  const latestReply = [...history].reverse().find(m => m.direction === 'out' && typeof m.body === 'string')?.body || '';
  const message = salon ? modularMessage(String(incomingMessage || '').trim(), latestReply, services) : String(incomingMessage || '').trim();
  if (salon) {
    const sender = typeof customerPhone === 'string' ? customerPhone.replace(/^\+/, '') : '';
    const known = require('./db').prepare('SELECT name FROM customers WHERE client_id=? AND phone=?').get(client.id, sender);
    if (nameIsUsable(known?.name)) customerName = known.name;
    if (/^(?:contact salon|contact)[.!\s]*$/i.test(message)) return { handled: true, text: contactSalon(client) };
    if (/^(?:my appointments?|view my appointments?)[.!\s]*$/i.test(message)) return { handled: true, text: customerAppointments(client, customerPhone, now, salon) };
    if (/^(?:menu|start|hi|hello|hey)[.!\s]*$/i.test(message)) return { handled: true, text: frontDoor(client) };
  }
  // Answer informational detours without changing or accidentally confirming a booking.
  if (/\b(hours?|open(ing)?|clos(e|ed|ing))\b/i.test(message) && !/\b(?:book|appointment|availability|slots?)\b/i.test(message)) {
    const hours = parseHours(client);
    const day = parseDate(message, messageAt);
    if (!day.found || !hours) return { handled: true, text: describeHours(hours) };
    if (!day.date) return { handled: true, text: 'That date is not valid. Please use YYYY-MM-DD.' };
    const range = hoursForDate(hours, day.date);
    return { handled: true, text: range ? `We're open on ${day.date} from ${range.open} to ${range.close} (South Africa).` : `We're closed on ${day.date}.` };
  }
  if (/\b(prices?|costs?|how much|menu|services?)\b/i.test(message) && !/\b(?:book|change|different)\b/i.test(message)) return { handled: true, text: describeServices(services) };
  if (/\b(?:cancel|reschedule|move)\s+(?:my|the|an?)?\s*(?:appointment|booking)\b/i.test(message)) {
    return { handled: true, text: salon ? customerAppointments(client, customerPhone, now, salon) : 'Please contact the salon directly to change or cancel an existing appointment.' };
  }
  if (bookingNeedsReview) return { handled: true, text: 'The salon needs to review your existing booking and its confirmation before I can make another booking. Please contact the salon directly to resolve it.' };
  if (latestBooking && (latestBooking.client_id !== client.id || latestBooking.customer_phone !== customerPhone)) {
    return { handled: true, text: 'I cannot verify your existing booking details. Please contact the salon directly.' };
  }
  if (latestBooking) {
    const originIndex = latestBooking.origin_message_id ? history.findIndex(m => m.direction === 'in' && m.wa_message_id === latestBooking.origin_message_id) : -1;
    history = originIndex >= 0 ? history.slice(originIndex + 1)
      : history.filter(m => Date.parse(m.created_at) > Date.parse(latestBooking.created_at));
    const localIntent = [...history.filter(m => m.direction === 'in').map(m => m.body), message]
      .reduce((allowed, body) => additionalBookingIntent(body) ?? allowed, false);
    const allowNew = typeof allowAdditionalBooking === 'boolean' ? allowAdditionalBooking : localIntent;
    if (!allowNew) {
      const instant = booking.storedInstant(latestBooking.starts_at);
      const when = Number.isFinite(instant) ? `${salonDate(instant)} at ${new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit' }).format(instant)} (South Africa)` : 'the recorded time';
      const status = latestBooking.status === 'cancelled' ? 'was cancelled' : 'is already recorded';
      const link = salon ? managementLink(salon, client.id, latestBooking.id) : null;
      return { handled: true, text: `Your ${latestBooking.service_name} appointment for ${when} ${status}. ${link ? `Manage this appointment: ${link}` : 'Please contact the salon directly to change an existing appointment.'} For a separate appointment, say \"new booking\".` };
    }
  }
  const { state: recovered, previousReply } = rebuildState(history, services, customerName, now, salon, clientId);
  const lastEvent = [...history].reverse().find(m => ['in', 'out'].includes(m?.direction) && typeof m.body === 'string' && m.body);
  // A queued or batched YES must not confirm a summary generated after that YES
  // was sent. Also ignore stale summaries followed by an input whose reply failed.
  const sentAt = new Date(messageAt).getTime();
  const summaryTimestamp = dryRun || customerPhone === 'simulator' ? lastEvent?.created_at : lastEvent?.accepted_at;
  const summaryAt = summaryTimestamp ? Date.parse(summaryTimestamp) : NaN;
  const received = new Date(receivedAt).getTime();
  const contextMatches = dryRun || customerPhone === 'simulator' || confirmationMessageId === undefined
    || (typeof confirmationMessageId === 'string' && confirmationMessageId === lastEvent?.id);
  // Meta timestamps have only second precision. A real YES in the same
  // second as acceptance is ambiguous, so require a strictly later second.
  // This deliberately re-prompts ultra-fast replies rather than risking consent.
  const safelyAfterAcceptance = dryRun || customerPhone === 'simulator'
    ? Math.floor(sentAt / 1000) >= Math.floor(summaryAt / 1000)
    : Math.floor(sentAt / 1000) > Math.floor(summaryAt / 1000);
  const summaryWasShown = contextMatches && lastEvent?.direction === 'out' && Number.isFinite(summaryAt)
    && Number.isFinite(sentAt) && Number.isFinite(received) && received >= summaryAt
    && safelyAfterAcceptance;
  const pending = summaryWasShown ? confirmationFrom(previousReply, services, salon, clientId) : null;
  const explainTimingRetry = YES.test(message) && !summaryWasShown && !!confirmationFrom(previousReply, services, salon, clientId);
  if (YES.test(message) && /^(?:You're booked!|Preview complete:)/.test(previousReply)) {
    return { handled: true, text: previousReply };
  }
  if (YES.test(message) && pending) {
    const result = bookAppointment(client.id, {
      customerName: pending.name, customerPhone, serviceName: pending.service.name, durationMins: pending.service.duration_mins,
      dateStr: pending.date, time: pending.time, ...(salon ? { staffId: pending.staffId, expectedStaffName: pending.staffName, expectedDeposit: pending.deposit } : {}), incomingMessageId, expectedPrice: pending.service.price, source: dryRun ? 'simulator' : 'whatsapp', dryRun, now, photoSelection,
    });
    const details = `${pending.service.name}${salon ? ` with ${pending.staffName}` : ''} on ${pending.date} at ${pending.time} (South Africa), R${pending.service.price}, for ${pending.name}.`;
    if (result.ok) {
      const link = salon && !result.dryRun ? managementLink(salon, client.id, result.id) : null;
      const deposit = salon && pending.deposit > 0 ? ` Deposit due: R${pending.deposit}; payment is not collected in this chat.` : '';
      return { handled: true, text: result.dryRun ? `Preview complete: ${details} No appointment was saved.` : `You're booked! ${details}${deposit} See you then! ✨${link ? `\nManage this appointment: ${link}` : ''}` };
    }
    return { handled: true, text: failureText(result.reason) };
  }
  const state = applyBookingInput(recovered, message, previousReply, services, messageAt, salon, clientId);
  if (state.cancelled) return { handled: true, text: "I've stopped this booking request. Existing appointments are unchanged." };
  if (!state.active && !/which service/i.test(previousReply)) return salon ? { handled: true, text: frontDoor(client) } : { handled: false, text: client.greeting || 'Hi! I can help with bookings, prices and opening hours. What would you like?' };
  if (!state.service) return { handled: true, text: salon ? modularServiceQuestion(services) : serviceQuestion(services) };
  if (salon && !state.staffPreference) return { handled: true, text: technicianQuestion(salon, client.id, state.service) };
  if (state.invalidDate) return { handled: true, text: 'That date is not valid. What day would you like? You can use YYYY-MM-DD.' };
  if (!state.date) return { handled: true, text: `${state.service.name} is R${state.service.price} (${state.service.duration_mins} min). What day would you like?` };
  if (state.date < salonDate(now)) return { handled: true, text: failureText('past_datetime') };
  if (!parseHours(client)) return { handled: true, text: failureText('invalid_hours') };
  if (!hoursForDate(parseHours(client), state.date)) return { handled: true, text: failureText('closed') };
  const staffOptions = { now, ...(state.staffId ? { staffId: state.staffId } : {}) };
  const slots = salon ? [...new Set(salon.availableSlots(client.id, state.service.id, state.date, staffOptions).map(s => s.time))]
    : getAvailableSlots(client.id, client, state.service.duration_mins, state.date, { now });
  if (!state.time || state.invalidTime) {
    if (!slots.length) return { handled: true, text: `There are no available times for ${state.service.name} on ${state.date}. Which other day would you like?` };
    return { handled: true, text: `${state.invalidTime ? 'Please use a valid time. ' : ''}Available times for ${state.service.name} on ${state.date}: ${slots.join(', ')} (South Africa). What time would you like?` };
  }
  const availability = salon ? salon.checkSlot(client.id, state.service.id, state.date, state.time, staffOptions)
    : checkRequestedSlot(client.id, client, state.service.duration_mins, state.date, state.time, { now });
  if (!availability.ok) return { handled: true, text: `${failureText(availability.reason)}${slots.length && ['slot_taken', 'outside_hours'].includes(availability.reason) ? ` Available times: ${slots.join(', ')} (South Africa).` : ''}` };
  if (!nameIsUsable(state.name)) return { handled: true, text: `What name should I put on your ${state.service.name} booking for ${state.date} at ${state.time} (South Africa)?` };
  const preview = dryRun || customerPhone === 'simulator';
  return { handled: true, text: `${CONFIRM_HEADER}\nService: ${state.service.name}${salon ? `\nTechnician: ${technicianLabel(availability.staff, qualifiedTechnicians(salon, client.id, state.service.id))}\nTechnician reference: ${availability.staff.id}` : ''}\nDate: ${state.date}\nTime: ${state.time} (South Africa)\nName: ${state.name}\nPrice: R${state.service.price}\nDuration: ${state.service.duration_mins} min${salon ? `\nDeposit: R${salon.depositAmount(client.id, state.service.id)} (payment is not collected in this chat)` : ''}\n${explainTimingRetry && !preview ? 'Please check these details, wait two seconds, then reply YES again. Tell me what to change if needed.' : `Reply YES to ${preview ? 'preview' : 'book'}, or tell me what to change.`}${preview ? '\nThis is a simulator; no appointment will be saved.' : ''}` };
}

// Booking state and all mutations are handled above, regardless of AI availability.
// Claude may answer general questions, but has no write tools or booking authority.
let Anthropic;
async function callClaude({ client, services, history, incomingMessage, now = new Date() }) {
  if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
  const provider = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 12000 });
  const messages = history.filter(m => ['in', 'out'].includes(m.direction) && m.body).map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
  messages.push({ role: 'user', content: incomingMessage });
  const response = await provider.messages.create({
    model: 'claude-haiku-4-5', max_tokens: 400,
    system: [
      `You are the receptionist for ${client.salon}, a beauty salon in ${client.city || 'South Africa'}. Today is ${salonDate(now)} in ${TIME_ZONE}.`,
      describeHours(parseHours(client)), describeServices(services),
      'Reply warmly and briefly. Only give facts present here. Never invent addresses, policies, services, dates, prices or appointment availability.',
      'You have no booking, cancellation, rescheduling, notification or messaging tools. Never say an appointment is booked, confirmed, reserved, changed or cancelled. Never promise an owner follow-up. For booking ask the customer to send Bookings; for issues outside bookings/prices/hours ask them to contact the salon directly.',
    ].join('\n'), messages,
  });
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  if (!text || /\b(booked|confirmed|reserved|cancelled|canceled|rescheduled)\b|please confirm|reply.{0,20}\byes\b/i.test(text)) throw new Error('unsafe_or_empty_provider_reply');
  return text;
}
async function generateReply(input) {
  const context = { services: [], history: [], ...input, dryRun: input.dryRun === true || input.customerPhone === 'simulator' };
  // Reminder controls take precedence over the photo workflow. Plain STOP also
  // runs the existing cancellation cleanup; other controls preserve its context.
  const reminder = reminderPreference(context);
  if (reminder) {
    if (!context.dryRun) {
      const db = require('./db');
      const session = db.prepare('SELECT id FROM photo_sessions WHERE client_id=? AND customer_phone=?').get(context.client.id, context.customerPhone);
      if (session) {
        if (/^STOP[.!\s]*$/i.test(String(context.incomingMessage || '').trim())) {
          await require('./photo-flow').createPhotoFlow().handle(context);
        } else {
          db.prepare("UPDATE messages SET photo_session_id=? WHERE client_id=? AND customer_phone=? AND direction='in' AND wa_message_id=?").run(session.id, context.client.id, context.customerPhone, context.incomingMessageId);
        }
        reminder.photoSessionId = session.id;
      }
    }
    return reminder;
  }
  let photoResult;
  if (!context.dryRun) {
    photoResult = await require('./photo-flow').createPhotoFlow().handle(context);
    if (photoResult?.text) return photoResult;
  }
  context.history = context.history.filter(m => !m.photo_session_id && m.incoming_type !== 'image');
  if (photoResult?.photoSelection) {
    const selection = photoResult.photoSelection;
    const db = require('./db');
    const session = db.prepare('SELECT * FROM photo_sessions WHERE id=?').get(selection.sessionId);
    // Only the customer-selected service and subsequent booking messages enter
    // the deterministic booking parser; image prompts/details never do.
    const afterSelection = new Set(db.prepare("SELECT id FROM messages WHERE client_id=? AND customer_phone=? AND rowid > COALESCE((SELECT rowid FROM messages WHERE client_id=? AND wa_message_id=? AND direction='in'), 9223372036854775807)").all(context.client.id,context.customerPhone,context.client.id,session.selection_message_id).map(m=>m.id));
    context.history = (input.history || []).filter(m => m.photo_session_id === selection.sessionId && afterSelection.has(m.id));
    context.history.unshift({direction:'in',body:`book ${selection.service.name}`,created_at:new Date(context.messageAt || Date.now()).toISOString()});
    context.services = [selection.service];
    context.photoSelection = selection;
    if (context.incomingMessageId === session.selection_message_id) context.incomingMessage = `book ${selection.service.name}`;
  }
  const response = rulesRespond(context);
  if (photoResult?.photoSelection) {
    const text = response.text + '\nPhoto menu estimate only: the salon must check the work required and agree any price change with you before starting.';
    return {text, mode:'photo_guided',photoSessionId:photoResult.photoSessionId};
  }
  if (response.handled || !process.env.ANTHROPIC_API_KEY) return { text: response.text, mode: 'rules' };
  try { return { text: await callClaude(context), mode: 'claude' }; }
  catch (error) { return { text: response.text, mode: 'rules_fallback', error: String(error.message || error) }; }
}
module.exports = { ...booking, generateReply, describeHours, describeServices, additionalBookingIntent };
