const crypto = require('crypto');
const db = require('./db');

/* =========================================================================
   SCHEDULING HELPERS — shared by both the mock responder and the real
   Claude-powered one, so "what's actually free" always comes from the same
   source of truth (the appointments table), never from the AI's guess.
   ========================================================================= */

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function fmtDate(d) { return d.toISOString().slice(0, 10); }
function timeToMinutes(hhmm) { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; }
function minutesToTime(mins) {
  const h = Math.floor(mins / 60), m = mins % 60;
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}
function parseHours(client) {
  try { return JSON.parse(client.hours || db.DEFAULT_HOURS); } catch { return JSON.parse(db.DEFAULT_HOURS); }
}
function hoursForDate(hoursObj, dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const range = hoursObj[DAY_KEYS[d.getDay()]];
  if (!range || range === 'closed') return null;
  const [open, close] = range.split('-');
  return { open, close };
}

function getAppointmentsOn(clientId, dateStr) {
  return db.prepare(`SELECT * FROM appointments WHERE client_id=? AND status='confirmed' AND starts_at LIKE ?`)
    .all(clientId, dateStr + '%');
}

function getAvailableSlots(clientId, client, durationMins, dateStr) {
  const hours = parseHours(client);
  const range = hoursForDate(hours, dateStr);
  if (!range) return [];
  const openMin = timeToMinutes(range.open), closeMin = timeToMinutes(range.close);
  const busy = getAppointmentsOn(clientId, dateStr).map(a => {
    const start = new Date(a.starts_at);
    const startMin = start.getHours() * 60 + start.getMinutes();
    return [startMin, startMin + (a.duration_mins || 60)];
  });
  const slots = [];
  const STEP = 30;
  for (let t = openMin; t + durationMins <= closeMin; t += STEP) {
    const conflict = busy.some(([bs, be]) => t < be && (t + durationMins) > bs);
    if (!conflict) slots.push(minutesToTime(t));
  }
  return slots;
}

function bookAppointment(clientId, { customerName, customerPhone, serviceName, durationMins, dateStr, time, source }) {
  const startsAt = `${dateStr}T${time}:00`;
  const start = new Date(startsAt);
  if (isNaN(start.getTime())) return { ok: false, reason: 'bad_datetime' };
  const startMin = start.getHours() * 60 + start.getMinutes();
  const conflict = getAppointmentsOn(clientId, dateStr).some(a => {
    const s = new Date(a.starts_at);
    const sMin = s.getHours() * 60 + s.getMinutes();
    const eMin = sMin + (a.duration_mins || 60);
    return startMin < eMin && (startMin + durationMins) > sMin;
  });
  if (conflict) return { ok: false, reason: 'slot_taken' };
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO appointments (id,client_id,customer_name,customer_phone,service_name,starts_at,duration_mins,status,source,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, clientId, customerName || 'WhatsApp customer', customerPhone || '', serviceName, startsAt, durationMins, 'confirmed', source || 'ai', new Date().toISOString());
  return { ok: true, id, startsAt };
}

function matchDayPhrase(msg, today) {
  today = today || new Date();
  if (/\btoday\b/.test(msg)) return { dateStr: fmtDate(today), label: 'today' };
  if (/\btomorrow\b/.test(msg)) {
    const d = new Date(today); d.setDate(d.getDate() + 1);
    return { dateStr: fmtDate(d), label: 'tomorrow' };
  }
  for (let i = 0; i < 7; i++) {
    if (msg.includes(DAY_NAMES[i])) {
      const diff = (i - today.getDay() + 7) % 7;
      const d = new Date(today); d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
      return { dateStr: fmtDate(d), label: DAY_NAMES[i][0].toUpperCase() + DAY_NAMES[i].slice(1) };
    }
  }
  return null;
}

function describeHours(hoursObj) {
  const order = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const label = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  return "We're open " + order.filter(k => hoursObj[k] && hoursObj[k] !== 'closed')
    .map(k => `${label[k]} ${hoursObj[k]}`).join(', ') + '.';
}
function describeServices(services) {
  if (!services.length) return "We haven't loaded our price list yet — ask the salon directly for now!";
  return 'Here’s what we offer: ' + services.map(s => `${s.name} (R${s.price}, ${s.duration_mins} min)`).join(', ') + '.';
}

/* =========================================================================
   MOCK RESPONDER — zero setup, deterministic. Good enough to demo and test
   the booking flow end-to-end before any AI provider key is configured.
   ========================================================================= */

function mockRespond(client, services, message) {
  const msg = message.toLowerCase();
  const hours = parseHours(client);

  if (/\b(hours?|open(ing)?|clos(e|ed|ing))\b/.test(msg)) return describeHours(hours);
  if (/\b(prices?|costs?|how much|menu|services?)\b/.test(msg)) return describeServices(services);

  const matchedService = services.find(s => msg.includes(s.name.toLowerCase()));
  const dayMatch = matchDayPhrase(msg);

  if (matchedService && dayMatch) {
    if (!hoursForDate(hours, dayMatch.dateStr)) {
      const when = dayMatch.label === 'today' || dayMatch.label === 'tomorrow' ? dayMatch.label : `on ${dayMatch.label}`;
      return `We're closed ${when} — want to try another day?`;
    }
    const slots = getAvailableSlots(client.id, client, matchedService.duration_mins, dayMatch.dateStr);
    if (!slots.length) return `Sorry, we're fully booked for ${matchedService.name} on ${dayMatch.label}. Want to try another day?`;
    const result = bookAppointment(client.id, {
      customerName: 'WhatsApp customer', customerPhone: 'simulator', serviceName: matchedService.name,
      durationMins: matchedService.duration_mins, dateStr: dayMatch.dateStr, time: slots[0], source: 'simulator',
    });
    if (result.ok) return `You're booked! ${matchedService.name} on ${dayMatch.label} at ${slots[0]} — R${matchedService.price}. See you then! ✨`;
    return `That slot just got taken — want me to find another time?`;
  }
  if (matchedService) return `Great choice — ${matchedService.name} is R${matchedService.price} (${matchedService.duration_mins} min). What day would you like to come in?`;
  if (dayMatch) return `Sure — which service would you like on ${dayMatch.label}? We offer: ${services.map(s => s.name).join(', ')}.`;

  return client.greeting || "Hi! How can I help — booking, prices, or hours?";
}

/* =========================================================================
   REAL RESPONDER — Claude with tool use, grounded in the same scheduling
   functions above so it can never "hallucinate" an open slot.
   ========================================================================= */

let Anthropic = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!Anthropic) Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

const TOOLS = [
  {
    name: 'check_availability',
    description: "Check open appointment slots for a service on a given date. Always call this before promising a time.",
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Exact service name from the service list' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['service', 'date'],
    },
  },
  {
    name: 'book_appointment',
    description: 'Book a confirmed appointment. Only call this after check_availability shows the requested time is open.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM, 24-hour' },
        customer_name: { type: 'string' },
      },
      required: ['service', 'date', 'time', 'customer_name'],
    },
  },
];

function systemPrompt(client, services) {
  const hours = parseHours(client);
  return [
    `You are the WhatsApp AI receptionist for ${client.salon}, a beauty salon in South Africa.`,
    `Today's date is ${fmtDate(new Date())}.`,
    `Business hours: ${describeHours(hours)}`,
    `Services offered: ${services.length ? services.map(s => `${s.name} — R${s.price}, ${s.duration_mins} min`).join('; ') : '(none loaded yet)'}`,
    client.greeting ? `Your usual greeting style: "${client.greeting}"` : '',
    `Reply the way a warm, efficient South African salon receptionist would over WhatsApp: short, friendly, no corporate tone.`,
    `Always use check_availability before offering or confirming a time — never guess. Use book_appointment only once a specific open slot and the customer's name are confirmed.`,
    `If asked something you can't help with (medical advice, complaints, anything outside bookings/prices/hours), say you'll get the salon owner to follow up.`,
  ].filter(Boolean).join('\n');
}

async function callClaude(client, services, history, incomingMessage) {
  const anthropic = getAnthropic();
  const messages = history.map(m => ({ role: m.direction === 'in' ? 'user' : 'assistant', content: m.body }));
  messages.push({ role: 'user', content: incomingMessage });

  for (let round = 0; round < 4; round++) {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 500,
      system: systemPrompt(client, services),
      tools: TOOLS,
      messages,
    });

    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (!toolUses.length) {
      return resp.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim() || "Sorry, could you say that again?";
    }

    messages.push({ role: 'assistant', content: resp.content });
    const toolResults = [];
    for (const use of toolUses) {
      let result;
      try {
        if (use.name === 'check_availability') {
          const svc = services.find(s => s.name.toLowerCase() === String(use.input.service).toLowerCase()) || services[0];
          const slots = svc ? getAvailableSlots(client.id, client, svc.duration_mins, use.input.date) : [];
          result = { available: slots };
        } else if (use.name === 'book_appointment') {
          const svc = services.find(s => s.name.toLowerCase() === String(use.input.service).toLowerCase());
          if (!svc) { result = { ok: false, reason: 'unknown_service' }; }
          else {
            result = bookAppointment(client.id, {
              customerName: use.input.customer_name, customerPhone: 'whatsapp-ai',
              serviceName: svc.name, durationMins: svc.duration_mins,
              dateStr: use.input.date, time: use.input.time, source: 'whatsapp_ai',
            });
          }
        } else {
          result = { error: 'unknown_tool' };
        }
      } catch (e) {
        result = { error: String(e.message || e) };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: use.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'user', content: toolResults });
  }
  return "Let me get the salon to follow up on that one for you.";
}

/* =========================================================================
   PUBLIC ENTRY POINT
   ========================================================================= */

async function generateReply({ client, services, history, incomingMessage }) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return { text: await callClaude(client, services, history, incomingMessage), mode: 'claude' };
    } catch (e) {
      return { text: mockRespond(client, services, incomingMessage), mode: 'mock_fallback', error: String(e.message || e) };
    }
  }
  return { text: mockRespond(client, services, incomingMessage), mode: 'mock' };
}

module.exports = { generateReply, getAvailableSlots, bookAppointment, parseHours, describeHours, describeServices };
