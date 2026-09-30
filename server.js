require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const ai = require('./ai');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'BeautyDesk2026';

app.use(express.json());
app.use(cookieParser());

// Serve only the three real front-end assets, explicitly — not a blanket
// static mount over __dirname, since server.js/ai.js/db.js/package.json also
// live at the repo root now (flattened so it can be uploaded from a phone
// without a subfolder) and must never be servable over HTTP.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));

function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function genTempPassword() {
  return crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 9);
}

function sign(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}
function verify(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

function requireAdmin(req, res, next) {
  const token = req.cookies.bd_admin;
  const data = token && verify(token);
  if (!data || data.role !== 'admin') return res.status(401).json({ error: 'not_authenticated' });
  next();
}
function requireClient(req, res, next) {
  const token = req.cookies.bd_client;
  const data = token && verify(token);
  if (!data || data.role !== 'client') return res.status(401).json({ error: 'not_authenticated' });
  req.clientId = data.clientId;
  next();
}

const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' };

/* ---------- PUBLIC: inquiries & signups ---------- */

app.post('/api/inquiries', (req, res) => {
  const { name, salon, email, phone, city, message } = req.body || {};
  if (!name || !salon || !email || !phone || !city) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const rec = { id: uid(), name, salon, email, phone, city, message: message || '', status: 'new', created_at: nowIso() };
  db.prepare(`INSERT INTO inquiries (id,name,salon,email,phone,city,message,status,created_at)
              VALUES (@id,@name,@salon,@email,@phone,@city,@message,@status,@created_at)`).run(rec);
  res.status(201).json({ ok: true });
});

app.post('/api/signups', (req, res) => {
  const { salon, owner, email, phone, city } = req.body || {};
  if (!salon || !owner || !email || !phone || !city) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const rec = { id: uid(), salon, owner, email, phone, city, plan: 'R799/mo', status: 'pending', client_id: null, created_at: nowIso() };
  db.prepare(`INSERT INTO signups (id,salon,owner,email,phone,city,plan,status,client_id,created_at)
              VALUES (@id,@salon,@owner,@email,@phone,@city,@plan,@status,@client_id,@created_at)`).run(rec);
  res.status(201).json({ ok: true });
});

/* ---------- ADMIN ---------- */

app.post('/api/admin/login', (req, res) => {
  const { passcode } = req.body || {};
  const a = Buffer.from(String(passcode || ''));
  const b = Buffer.from(String(ADMIN_PASSCODE));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: 'invalid_passcode' });
  const token = sign({ role: 'admin' }, '12h');
  res.cookie('bd_admin', token, cookieOpts);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('bd_admin'); res.json({ ok: true }); });
app.get('/api/admin/session', (req, res) => {
  const data = req.cookies.bd_admin && verify(req.cookies.bd_admin);
  res.json({ authed: !!(data && data.role === 'admin') });
});

app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC').all();
  res.json(rows);
});
app.patch('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['new', 'contacted', 'converted', 'lost'].includes(status)) return res.status(400).json({ error: 'bad_status' });
  const info = db.prepare('UPDATE inquiries SET status=? WHERE id=?').run(status, req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});

app.get('/api/admin/signups', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM signups ORDER BY created_at DESC').all();
  res.json(rows);
});

// Activating a signup creates (or reuses) a real client account and returns a one-time temp password.
app.post('/api/admin/signups/:id/activate', requireAdmin, (req, res) => {
  const signup = db.prepare('SELECT * FROM signups WHERE id=?').get(req.params.id);
  if (!signup) return res.status(404).json({ error: 'not_found' });

  let client = db.prepare('SELECT * FROM clients WHERE email=?').get(signup.email);
  let tempPassword = null;
  if (!client) {
    tempPassword = genTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 10);
    const clientId = uid();
    db.prepare(`INSERT INTO clients (id,salon,owner,email,phone,city,password_hash,whatsapp_enabled,greeting,plan_status,hours,wa_verify_token,created_at)
                VALUES (@id,@salon,@owner,@email,@phone,@city,@password_hash,1,@greeting,'active',@hours,@wa_verify_token,@created_at)`).run({
      id: clientId, salon: signup.salon, owner: signup.owner, email: signup.email, phone: signup.phone, city: signup.city,
      password_hash: hash, greeting: `Hi! Thanks for messaging ${signup.salon} 💛 How can I help — booking, prices or hours?`,
      hours: db.DEFAULT_HOURS, wa_verify_token: crypto.randomBytes(12).toString('hex'),
      created_at: nowIso(),
    });
    client = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId);
  }
  db.prepare('UPDATE signups SET status=?, client_id=? WHERE id=?').run('active', client.id, signup.id);
  res.json({ ok: true, clientEmail: client.email, tempPassword }); // tempPassword is null if account already existed
});

/* ---------- CLIENT ---------- */

app.post('/api/client/login', (req, res) => {
  const { email, password } = req.body || {};
  const client = db.prepare('SELECT * FROM clients WHERE email=?').get(String(email || '').toLowerCase().trim());
  if (!client || !bcrypt.compareSync(String(password || ''), client.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = sign({ role: 'client', clientId: client.id }, '30d');
  res.cookie('bd_client', token, cookieOpts);
  res.json({ ok: true });
});
app.post('/api/client/logout', (req, res) => { res.clearCookie('bd_client'); res.json({ ok: true }); });

app.get('/api/client/me', requireClient, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const webhookUrl = `${req.protocol}://${req.get('host')}/webhooks/whatsapp/${c.id}`;
  res.json({
    id: c.id, salon: c.salon, owner: c.owner, email: c.email, phone: c.phone, city: c.city,
    whatsapp_enabled: c.whatsapp_enabled, greeting: c.greeting, plan_status: c.plan_status,
    hours: c.hours || db.DEFAULT_HOURS,
    wa_connected: !!(c.wa_phone_number_id && c.wa_access_token),
    wa_last_delivery: db.prepare("SELECT delivery_status, delivery_error_code FROM messages WHERE client_id=? AND direction='out' AND delivery_status IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(c.id) || null,
    wa_verify_token: c.wa_verify_token,
    webhook_url: webhookUrl,
  });
});
app.patch('/api/client/settings', requireClient, (req, res) => {
  const { whatsappEnabled, greeting, hours } = req.body || {};
  const current = db.prepare('SELECT hours FROM clients WHERE id=?').get(req.clientId);
  let hoursJson = current.hours || db.DEFAULT_HOURS;
  if (hours && typeof hours === 'object') {
    try { hoursJson = JSON.stringify(hours); } catch {}
  }
  db.prepare('UPDATE clients SET whatsapp_enabled=?, greeting=?, hours=? WHERE id=?')
    .run(whatsappEnabled ? 1 : 0, String(greeting || '').slice(0, 500), hoursJson, req.clientId);
  res.json({ ok: true });
});
app.patch('/api/client/whatsapp-connection', requireClient, (req, res) => {
  const { phoneNumberId, accessToken } = req.body || {};
  const current = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  if (!current) return res.status(404).json({ error: 'not_found' });
  if ((phoneNumberId != null && typeof phoneNumberId !== 'string') ||
      (accessToken != null && typeof accessToken !== 'string')) {
    return res.status(400).json({ error: 'invalid_connection_fields' });
  }
  const newId = (phoneNumberId || '').trim();
  const newToken = (accessToken || '').trim();
  if (!newId && !newToken) return res.status(400).json({ error: 'no_connection_changes' });
  // Empty inputs retain saved credentials; never overwrite them with autofill/blank data.
  const id = newId || current.wa_phone_number_id;
  const token = newToken || current.wa_access_token;
  if (!validPhoneNumberId(id)) return res.status(400).json({ error: 'invalid_phone_number_id' });
  if (!validAccessToken(token)) return res.status(400).json({ error: 'invalid_access_token' });
  db.prepare('UPDATE clients SET wa_phone_number_id=?, wa_access_token=? WHERE id=?')
    .run(id, token, req.clientId);
  res.json({ ok: true });
});

/* ---------- SERVICES (per client price list) ---------- */

app.get('/api/client/services', requireClient, (req, res) => {
  res.json(db.prepare('SELECT * FROM services WHERE client_id=? ORDER BY created_at ASC').all(req.clientId));
});
app.post('/api/client/services', requireClient, (req, res) => {
  const { name, price, durationMins } = req.body || {};
  if (!name || !Number.isFinite(Number(price))) return res.status(400).json({ error: 'missing_fields' });
  const rec = { id: uid(), client_id: req.clientId, name: String(name).slice(0, 80), price: Math.round(Number(price)), duration_mins: Math.round(Number(durationMins) || 60), created_at: nowIso() };
  db.prepare(`INSERT INTO services (id,client_id,name,price,duration_mins,created_at) VALUES (@id,@client_id,@name,@price,@duration_mins,@created_at)`).run(rec);
  res.status(201).json(rec);
});
app.delete('/api/client/services/:id', requireClient, (req, res) => {
  db.prepare('DELETE FROM services WHERE id=? AND client_id=?').run(req.params.id, req.clientId);
  res.json({ ok: true });
});

/* ---------- APPOINTMENTS ---------- */

app.get('/api/client/recent-messages', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT * FROM messages WHERE client_id=? AND direction='in' ORDER BY created_at DESC LIMIT 8`).all(req.clientId);
  res.json(rows);
});

app.get('/api/client/appointments', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT * FROM appointments WHERE client_id=? AND status='confirmed' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 50`)
    .all(req.clientId, nowIso().slice(0, 10));
  res.json(rows);
});

/* ---------- WHATSAPP AI SIMULATOR (test the AI without any Meta account) ---------- */

const SIM_PHONE = 'simulator';

app.get('/api/client/simulator/messages', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT * FROM messages WHERE client_id=? AND customer_phone=? ORDER BY created_at ASC`).all(req.clientId, SIM_PHONE);
  res.json(rows);
});
app.post('/api/client/simulator/reset', requireClient, (req, res) => {
  db.prepare('DELETE FROM messages WHERE client_id=? AND customer_phone=?').run(req.clientId, SIM_PHONE);
  res.json({ ok: true });
});
app.post('/api/whatsapp/simulate', requireClient, async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'empty_message' });
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  const services = db.prepare('SELECT * FROM services WHERE client_id=?').all(req.clientId);
  const history = db.prepare(`SELECT * FROM messages WHERE client_id=? AND customer_phone=? ORDER BY created_at ASC LIMIT 20`).all(req.clientId, SIM_PHONE);

  db.prepare(`INSERT INTO messages (id,client_id,customer_phone,customer_name,direction,body,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(uid(), req.clientId, SIM_PHONE, 'Simulator', 'in', String(message).slice(0, 1000), nowIso());

  let reply;
  try {
    reply = await ai.generateReply({ client, services, history, incomingMessage: String(message).slice(0, 1000) });
  } catch (e) {
    reply = { text: "Sorry, something went wrong on my end — try again?", mode: 'error' };
  }

  db.prepare(`INSERT INTO messages (id,client_id,customer_phone,customer_name,direction,body,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(uid(), req.clientId, SIM_PHONE, 'Simulator', 'out', reply.text, nowIso());

  res.json({ reply: reply.text, mode: reply.mode });
});

/* ---------- REAL WHATSAPP WEBHOOK (Meta Cloud API) ----------
   Wire this up once you have a WhatsApp Business number: see README. */

function validPhoneNumberId(value) {
  return typeof value === 'string' && /^\d{1,32}$/.test(value);
}
function validAccessToken(value) {
  // Format checks prevent common autofill mistakes; they do NOT validate Meta access.
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096 && !/[\s@]/.test(value);
}
function metaErrorCode(error) {
  return Number.isInteger(error?.code) ? String(error.code) : null;
}
async function sendWhatsAppMessage(client, to, text) {
  if (!validPhoneNumberId(client.wa_phone_number_id) || !validAccessToken(client.wa_access_token)) {
    return { ok: false, status: 'failed', code: 'invalid_connection' };
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${client.wa_phone_number_id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${client.wa_access_token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
      signal: AbortSignal.timeout(15000),
    });
    let payload;
    try { payload = await res.json(); } catch { payload = null; }
    if (!res.ok) return { ok: false, status: 'failed', code: metaErrorCode(payload?.error) || `http_${res.status}` };
    const messageId = payload?.messages?.[0]?.id;
    if (typeof messageId !== 'string' || !messageId) {
      return { ok: false, status: 'unknown', code: 'missing_message_id' };
    }
    return { ok: true, status: 'accepted', messageId };
  } catch {
    // The request may already have reached Meta. Never retry automatically and risk duplicates.
    return { ok: false, status: 'unknown', code: 'transport_error' };
  }
}

function applyWhatsAppStatus(clientId, status) {
  if (!['sent', 'delivered', 'read', 'failed'].includes(status?.status) || typeof status.id !== 'string') return;
  const previous = db.prepare('SELECT delivery_status FROM whatsapp_receipts WHERE client_id=? AND wa_message_id=?').get(clientId, status.id);
  const rank = { sent: 2, failed: 2, delivered: 3, read: 4 };
  // Receipts can arrive out of order: never downgrade confirmed delivery/read.
  if (previous && (status.status === 'failed' ? rank[previous.delivery_status] >= 3 : rank[status.status] <= rank[previous.delivery_status])) return;
  const errorCode = status.status === 'failed' ? metaErrorCode(status.errors?.[0]) || 'delivery_failed' : null;
  db.prepare(`INSERT INTO whatsapp_receipts(client_id,wa_message_id,delivery_status,delivery_error_code) VALUES (?,?,?,?)
    ON CONFLICT(client_id,wa_message_id) DO UPDATE SET delivery_status=excluded.delivery_status, delivery_error_code=excluded.delivery_error_code`)
    .run(clientId, status.id, status.status, errorCode);
  applyStoredWhatsAppStatus(clientId, status.id);
  if (status.status === 'failed') console.error('whatsapp_delivery_failed', { code: errorCode });
}
function applyStoredWhatsAppStatus(clientId, messageId) {
  const receipt = db.prepare('SELECT * FROM whatsapp_receipts WHERE client_id=? AND wa_message_id=?').get(clientId, messageId);
  if (receipt) db.prepare("UPDATE messages SET delivery_status=?, delivery_error_code=? WHERE client_id=? AND direction='out' AND wa_message_id=?")
    .run(receipt.delivery_status, receipt.delivery_error_code, clientId, messageId);
}
function webhookArray(value) { return Array.isArray(value) ? value : []; }

// Meta verification handshake
app.get('/webhooks/whatsapp/:clientId', (req, res) => {
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.clientId);
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (client && mode === 'subscribe' && token === client.wa_verify_token) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Inbound messages and outbound delivery receipts share this webhook.
app.post('/webhooks/whatsapp/:clientId', async (req, res) => {
  res.sendStatus(200);
  try {
    const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.clientId);
    if (!client) return;
    for (const entry of webhookArray(req.body?.entry)) {
      for (const change of webhookArray(entry?.changes)) {
        const value = change?.value;
        if (!value) continue;
        for (const status of webhookArray(value.statuses)) applyWhatsAppStatus(client.id, status);
        if (!client.whatsapp_enabled) continue;
        for (const msg of webhookArray(value.messages)) {
          if (msg?.type !== 'text' || typeof msg.from !== 'string' || typeof msg.id !== 'string' || typeof msg.text?.body !== 'string') continue;
          let outgoingId;
          let sendStarted = false;
          try {
            const from = msg.from;
            const text = msg.text.body;
            const customerName = webhookArray(value.contacts).find(c => c?.wa_id === from)?.profile?.name || 'WhatsApp customer';
            // Get recent history before adding this input; the AI appends it once itself.
            const history = db.prepare(`SELECT * FROM messages WHERE client_id=? AND customer_phone=?
              AND (direction='in' OR delivery_status IS NULL OR delivery_status IN ('accepted','sent','delivered','read'))
              ORDER BY created_at DESC, rowid DESC LIMIT 20`).all(client.id, from).reverse();
            const inserted = db.prepare(`INSERT OR IGNORE INTO messages
              (id,client_id,customer_phone,customer_name,direction,body,created_at,wa_message_id)
              VALUES (?,?,?,?,?,?,?,?)`).run(uid(), client.id, from, customerName, 'in', text, nowIso(), msg.id);
            if (!inserted.changes) continue; // Meta retries must not create duplicate replies/bookings.
            outgoingId = uid();
            db.prepare(`INSERT INTO messages
              (id,client_id,customer_phone,customer_name,direction,body,created_at,delivery_status)
              VALUES (?,?,?,?,?,?,?,?)`).run(outgoingId, client.id, from, customerName, 'out', '', nowIso(), 'pending');
            const services = db.prepare('SELECT * FROM services WHERE client_id=?').all(client.id);
            const reply = await ai.generateReply({ client, services, history, incomingMessage: text });
            if (typeof reply?.text !== 'string' || !reply.text.trim()) throw new Error('empty_reply');
            db.prepare('UPDATE messages SET body=? WHERE id=?').run(reply.text, outgoingId);
            const wrongSender = validPhoneNumberId(client.wa_phone_number_id) &&
              typeof value.metadata?.phone_number_id === 'string' && value.metadata.phone_number_id !== client.wa_phone_number_id;
            sendStarted = true;
            const result = wrongSender ? { ok: false, status: 'failed', code: 'phone_number_mismatch' }
              : await sendWhatsAppMessage(client, from, reply.text);
            db.prepare('UPDATE messages SET delivery_status=?, delivery_error_code=?, wa_message_id=? WHERE id=?')
              .run(result.status, result.code || null, result.messageId || null, outgoingId);
            if (result.messageId) applyStoredWhatsAppStatus(client.id, result.messageId);
            if (!result.ok) console.error('whatsapp_send_failed', { status: result.status, code: result.code });
          } catch {
            if (outgoingId) db.prepare('UPDATE messages SET delivery_status=?, delivery_error_code=? WHERE id=?').run(sendStarted ? 'unknown' : 'failed', sendStarted ? 'processing_error' : 'reply_generation_failed', outgoingId);
            // Never log raw exceptions: provider errors can contain credentials or message text.
            console.error('whatsapp_processing_failed');
          }
        }
      }
    }
  } catch { console.error('whatsapp_webhook_processing_failed'); }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`BeautyDesk server running on port ${PORT}`));
