require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const PRODUCTION = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE;
if (!JWT_SECRET || Buffer.byteLength(JWT_SECRET) < 32 || !ADMIN_PASSCODE || ADMIN_PASSCODE.length < 12) {
  throw new Error('Set a strong JWT_SECRET (at least 32 bytes) and ADMIN_PASSCODE (at least 12 characters) before starting. No default credentials are enabled.');
}
const META_APP_SECRET = process.env.META_APP_SECRET || '';
const configuredOrigin = process.env.PUBLIC_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
let PUBLIC_ORIGIN = '';
if (configuredOrigin) {
  const parsed = new URL(configuredOrigin);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' ||
      (PRODUCTION && parsed.protocol !== 'https:') || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('PUBLIC_BASE_URL must be an origin, HTTPS in production.');
  PUBLIC_ORIGIN = parsed.origin;
}
if (PRODUCTION && !PUBLIC_ORIGIN) throw new Error('Set PUBLIC_BASE_URL to the public HTTPS origin before starting.');
if (PRODUCTION && !path.isAbsolute(process.env.DB_PATH || '')) throw new Error('Set DB_PATH to an absolute path on the existing persistent volume before starting.');
const db = require('./db');
const { normalizeEmail, findClientsByEmail } = require('./auth-email');
const ai = require('./ai');
const photo = require('./photo-flow');
if (!META_APP_SECRET) console.warn('WhatsApp webhooks disabled until META_APP_SECRET is configured.');
app.disable('x-powered-by');
app.set('trust proxy', PRODUCTION ? 1 : false);
app.use(express.json({ limit: '256kb', verify(req, res, buffer) { req.rawBody = buffer; } }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  if (PRODUCTION) res.set('Strict-Transport-Security', 'max-age=31536000');
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    const expected = PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`;
    if (req.get('origin') && req.get('origin') !== expected) return res.status(403).json({ error: 'invalid_origin' });
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) return res.status(400).json({ error: 'invalid_body' });
  }
  next();
});

function rateLimit(limit, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now(), key = req.ip;
    if (hits.size > 10000) for (const [ip, v] of hits) if (v.reset <= now) hits.delete(ip);
    let entry = hits.get(key);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + windowMs }; hits.set(key, entry); }
    if (++entry.count > limit) { res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000))); return res.status(429).json({ error: 'too_many_requests' }); }
    next();
  };
}
const loginLimit = rateLimit(15, 15 * 60 * 1000);
const publicLimit = rateLimit(20, 60 * 60 * 1000);
const simulatorLimit = rateLimit(30, 60 * 1000);
function clean(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function publicFields(body, inquiry = false) {
  const rec = { salon: clean(body.salon, 120), email: clean(body.email, 254).toLowerCase(), phone: clean(body.phone, 40), city: clean(body.city, 100) };
  rec[inquiry ? 'name' : 'owner'] = clean(body[inquiry ? 'name' : 'owner'], 120);
  if (Object.values(rec).some(v => !v) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rec.email)) return null;
  return rec;
}
app.use(cookieParser());

// Serve only the three real front-end assets, explicitly — not a blanket
// static mount over __dirname, since server.js/ai.js/db.js/package.json also
// live at the repo root now (flattened so it can be uploaded from a phone
// without a subfolder) and must never be servable over HTTP.
app.get('/pilot', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get(['/','/login','/signup','/onboarding','/dashboard','/calendar','/appointments','/bookings','/customers','/services','/staff','/payments','/messages','/whatsapp','/subscription','/reports','/settings','/book/:slug','/manage/:token','/platform'], (req,res)=>{res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");res.sendFile(path.join(__dirname,'ui.html'));});
for(const file of ['ui.js','ui.css']) app.get('/'+file,(req,res)=>res.sendFile(path.join(__dirname,file)));
app.use('/assets',express.static(path.join(__dirname,'assets'),{dotfiles:'deny',index:false}));
app.get('/app.js', (req, res) => res.sendFile(path.join(__dirname, 'app.js')));
app.get('/favicon.svg', (req, res) => res.sendFile(path.join(__dirname, 'favicon.svg')));

function uid() { return crypto.randomUUID(); }
function nowIso() { return new Date().toISOString(); }
function genTempPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function sign(payload, expiresIn) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn, algorithm: 'HS256', issuer: 'beautydesk', audience: 'beautydesk-app' });
}
function verify(token) {
  try { return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'beautydesk', audience: 'beautydesk-app' }); } catch { return null; }
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
  const client = db.prepare('SELECT id, auth_version FROM clients WHERE id=?').get(data.clientId);
  if (!client || data.version !== client.auth_version) return res.status(401).json({ error: 'not_authenticated' });
  req.clientId = client.id;
  next();
}

const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: PRODUCTION, path: '/' };
require('./modules/routes')(app,{requireClient,requireAdmin,sign,cookieOpts,loginLimit,publicLimit});

/* ---------- PUBLIC: inquiries & signups ---------- */

app.post('/api/inquiries', publicLimit, (req, res) => {
  const fields = publicFields(req.body, true);
  if (!fields) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  const rec = { id: uid(), ...fields, message: clean(req.body.message, 2000), status: 'new', created_at: nowIso() };
  db.prepare(`INSERT INTO inquiries (id,name,salon,email,phone,city,message,status,created_at)
              VALUES (@id,@name,@salon,@email,@phone,@city,@message,@status,@created_at)`).run(rec);
  res.status(201).json({ ok: true });
});

app.post('/api/signups', publicLimit, (req, res) => {
  const fields = publicFields(req.body);
  if (!fields) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (db.prepare("SELECT id FROM signups WHERE email=? COLLATE NOCASE AND status IN ('pending','active')").get(fields.email)) return res.json({ ok: true });
  const rec = { id: uid(), ...fields, plan: 'R799/mo', status: 'pending', client_id: null, created_at: nowIso() };
  db.prepare(`INSERT INTO signups (id,salon,owner,email,phone,city,plan,status,client_id,created_at)
              VALUES (@id,@salon,@owner,@email,@phone,@city,@plan,@status,@client_id,@created_at)`).run(rec);
  res.status(201).json({ ok: true });
});

/* ---------- ADMIN ---------- */

app.post('/api/admin/login', loginLimit, (req, res) => {
  const { passcode } = req.body || {};
  const a = Buffer.from(String(passcode || ''));
  const b = Buffer.from(String(ADMIN_PASSCODE));
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!match) return res.status(401).json({ error: 'invalid_passcode' });
  const token = sign({ role: 'admin' }, '12h');
  res.cookie('bd_admin', token, cookieOpts);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('bd_admin', cookieOpts); res.json({ ok: true }); });
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

  const matches = findClientsByEmail(db, signup.email);
  if (matches.length > 1) return res.status(409).json({ error: 'account_requires_review' });
  let client = matches[0];
  let tempPassword = null;
  if (!client) {
    tempPassword = genTempPassword();
    const hash = bcrypt.hashSync(tempPassword, 10);
    const clientId = uid();
    db.prepare(`INSERT INTO clients (id,salon,owner,email,phone,city,password_hash,whatsapp_enabled,greeting,plan_status,hours,wa_verify_token,created_at)
                VALUES (@id,@salon,@owner,@email,@phone,@city,@password_hash,1,@greeting,'active',@hours,@wa_verify_token,@created_at)`).run({
      id: clientId, salon: signup.salon, owner: signup.owner, email: normalizeEmail(signup.email), phone: signup.phone, city: signup.city,
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

app.post('/api/client/login', loginLimit, (req, res) => {
  const { email, password } = req.body || {};
  const matches = findClientsByEmail(db, email);
  const client = matches.length === 1 ? matches[0] : null;
  if (!client || typeof password !== 'string' || !bcrypt.compareSync(password, client.password_hash)) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  const token = sign({ role: 'client', clientId: client.id, version: client.auth_version }, '7d');
  res.cookie('bd_client', token, cookieOpts);
  res.json({ ok: true });
});
app.post('/api/client/logout', (req, res) => { res.clearCookie('bd_client', cookieOpts); res.json({ ok: true }); });

app.get('/api/client/me', requireClient, (req, res) => {
  const c = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  if (!c) return res.status(404).json({ error: 'not_found' });
  const webhookUrl = `${PUBLIC_ORIGIN || `${req.protocol}://${req.get('host')}`}/webhooks/whatsapp/${c.id}`;
  res.json({
    id: c.id, salon: c.salon, owner: c.owner, email: c.email, phone: c.phone, city: c.city,
    photo_estimates_enabled: !!c.photo_estimates_enabled, photo_estimates_status: photo.photoStatus(),
    whatsapp_enabled: c.whatsapp_enabled, greeting: c.greeting, plan_status: c.plan_status,
    hours: c.hours || db.DEFAULT_HOURS,
    wa_connected: !!(c.wa_phone_number_id && c.wa_access_token),
    responder_mode: process.env.ANTHROPIC_API_KEY ? 'claude' : 'guided',
    wa_signature_configured: !!META_APP_SECRET,
    wa_pending_reviews: db.prepare("SELECT count(*) AS n FROM whatsapp_jobs WHERE client_id=? AND state IN ('review','unknown','failed')").get(c.id).n,
    wa_last_delivery: db.prepare("SELECT delivery_status, delivery_error_code FROM messages WHERE client_id=? AND direction='out' AND delivery_status IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1").get(c.id) || null,
    wa_verify_token: c.wa_verify_token,
    webhook_url: webhookUrl,
  });
});
app.patch('/api/client/password', requireClient, loginLimit, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  if (typeof currentPassword !== 'string' || !bcrypt.compareSync(currentPassword, client.password_hash)) return res.status(400).json({ error: 'invalid_current_password' });
  if (typeof newPassword !== 'string' || newPassword.length < 12 || Buffer.byteLength(newPassword) > 72) return res.status(400).json({ error: 'weak_password' });
  if (bcrypt.compareSync(newPassword, client.password_hash)) return res.status(400).json({ error: 'unchanged_password' });
  const version = client.auth_version + 1;
  db.prepare('UPDATE clients SET password_hash=?, auth_version=? WHERE id=?').run(bcrypt.hashSync(newPassword, 12), version, client.id);
  res.cookie('bd_client', sign({ role: 'client', clientId: client.id, version }, '7d'), cookieOpts);
  res.json({ ok: true });
});
app.patch('/api/client/settings', requireClient, (req, res) => {
  const { whatsappEnabled, greeting, hours, photoEstimatesEnabled } = req.body;
  const current = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  if (photoEstimatesEnabled != null && typeof photoEstimatesEnabled !== 'boolean') return res.status(400).json({ error: 'invalid_settings' });
  if (photoEstimatesEnabled === true && !photo.photoStatus().ready) return res.status(409).json({ error: 'photo_host_not_ready' });
  if (photoEstimatesEnabled === true && !photo.eligibleServices(req.clientId, db.prepare('SELECT * FROM services WHERE client_id=?').all(req.clientId)).length) return res.status(409).json({ error: 'photo_catalog_required' });
  if (whatsappEnabled != null && typeof whatsappEnabled !== 'boolean') return res.status(400).json({ error: 'invalid_settings' });
  if (greeting != null && (typeof greeting !== 'string' || greeting.length > 500)) return res.status(400).json({ error: 'invalid_settings' });
  const checked = hours == null ? { ok: true, hours: JSON.parse(current.hours || db.DEFAULT_HOURS) } : ai.validateHours(hours);
  if (!checked.ok) return res.status(400).json({ error: 'invalid_hours' });
  db.prepare('UPDATE clients SET whatsapp_enabled=?, greeting=?, hours=? WHERE id=?')
    .run(whatsappEnabled == null ? current.whatsapp_enabled : Number(whatsappEnabled), greeting == null ? current.greeting : greeting.trim(), JSON.stringify(checked.hours), req.clientId);
  if (photoEstimatesEnabled != null) {
    db.prepare('UPDATE clients SET photo_estimates_enabled=? WHERE id=?').run(Number(photoEstimatesEnabled), req.clientId);
    if (!photoEstimatesEnabled) {
      db.prepare('DELETE FROM photo_uploads WHERE client_id=?').run(req.clientId);
      db.prepare('DELETE FROM photo_sessions WHERE client_id=?').run(req.clientId);
    }
  }
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
  // Older databases may contain duplicate number links. Do not block token rotation
  // on an unchanged link; reject newly claiming another salon's configured number.
  if (id !== current.wa_phone_number_id && db.prepare('SELECT id FROM clients WHERE wa_phone_number_id=? AND id<>?').get(id, req.clientId)) return res.status(409).json({ error: 'phone_number_already_linked' });
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
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name) || !Number.isFinite(Number(price)) || Number(price) < 0 || Number(price) > 100000 || !Number.isInteger(Number(durationMins)) || Number(durationMins) < 5 || Number(durationMins) > 720) return res.status(400).json({ error: 'invalid_service' });
  if (db.prepare('SELECT id FROM services WHERE client_id=? AND name=? COLLATE NOCASE').get(req.clientId, name.trim())) return res.status(409).json({ error: 'duplicate_service' });
  const rec = { id: uid(), client_id: req.clientId, name: name.trim(), price: Math.round(Number(price)), duration_mins: Number(durationMins), created_at: nowIso() };
  db.prepare(`INSERT INTO services (id,client_id,name,price,duration_mins,created_at) VALUES (@id,@client_id,@name,@price,@duration_mins,@created_at)`).run(rec);
  res.status(201).json(rec);
});
app.patch('/api/client/services/:id/photo-settings', requireClient, (req, res) => {
  const { photoEligible, photoCategory, photoDescription } = req.body;
  if (typeof photoEligible !== 'boolean' || (photoCategory != null && !['hair','nails','beauty'].includes(photoCategory))
      || typeof photoDescription !== 'string' || photoDescription.length > 400 || /[\p{Cc}\p{Cf}]/u.test(photoDescription)
      || (photoEligible && (!photoCategory || photoDescription.trim().length < 10))) return res.status(400).json({ error: 'invalid_photo_settings' });
  const result = db.prepare('UPDATE services SET photo_eligible=?, photo_category=?, photo_description=? WHERE id=? AND client_id=?')
    .run(Number(photoEligible), photoCategory || null, photoDescription.trim(), req.params.id, req.clientId);
  if (!result.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true });
});
app.delete('/api/client/services/:id', requireClient, (req, res) => {
  if(require('./modules/salon').isModular(req.clientId)){const result=db.prepare('UPDATE services SET active=0 WHERE id=? AND client_id=?').run(req.params.id,req.clientId);return res.json({ok:true});}
  db.prepare('DELETE FROM services WHERE id=? AND client_id=?').run(req.params.id, req.clientId);
  res.json({ ok: true });
});

/* ---------- APPOINTMENTS ---------- */

app.get('/api/client/recent-messages', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT * FROM messages WHERE client_id=? AND direction='in' AND customer_phone<>'simulator' ORDER BY created_at DESC, rowid DESC LIMIT 8`).all(req.clientId);
  res.json(rows);
});

app.get('/api/client/appointments', requireClient, (req, res) => {
  const rows = db.prepare(`SELECT * FROM appointments WHERE client_id=? AND status='confirmed' AND starts_at >= ? ORDER BY starts_at ASC LIMIT 50`)
    .all(req.clientId, new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()));
  res.json(rows);
});

app.post('/api/client/appointments/:id/cancel', requireClient, (req, res) => {
  const appointment = db.prepare('SELECT id FROM appointments WHERE id=? AND client_id=?').get(req.params.id, req.clientId);
  if (!appointment) return res.status(404).json({ error: 'not_found' });
  const domain=require('./modules/salon');
  if(domain.isModular(req.clientId)){try{const a=domain.appointment(req.clientId,req.params.id);domain.changeAppointment(req.clientId,a.id,{status:'cancelled',version:a.version});}catch(e){return res.status(e.status||500).json({error:e.status?e.message:'request_failed'});}}else db.prepare("UPDATE appointments SET status='cancelled' WHERE id=? AND client_id=?").run(req.params.id, req.clientId);
  res.json({ ok: true });
});

app.get('/api/client/whatsapp-reviews', requireClient, (req, res) => {
  res.json(db.prepare(`SELECT j.id,j.customer_phone,j.customer_name,j.created_at,j.state,j.error_code,
    incoming.body AS incoming_body, outgoing.body AS reply_body, booking.id AS appointment_id,
    booking.service_name AS appointment_service, booking.starts_at AS appointment_starts_at, booking.status AS appointment_status FROM whatsapp_jobs j
    LEFT JOIN messages incoming ON incoming.client_id=j.client_id AND incoming.direction='in' AND incoming.wa_message_id=j.incoming_id
    LEFT JOIN messages outgoing ON outgoing.id=j.outgoing_id AND outgoing.client_id=j.client_id
    LEFT JOIN appointments booking ON booking.client_id=j.client_id AND booking.origin_message_id=j.incoming_id
    WHERE j.client_id=? AND j.state IN ('review','unknown','failed') ORDER BY j.created_at,j.rowid LIMIT 50`).all(req.clientId));
});
app.post('/api/client/whatsapp-reviews/:id/acknowledge', requireClient, (req, res) => {
  const job = db.prepare('SELECT * FROM whatsapp_jobs WHERE id=? AND client_id=?').get(req.params.id, req.clientId);
  if (!job) return res.status(404).json({ error: 'not_found' });
  if (!['review','unknown','failed','reviewed'].includes(job.state)) return res.status(409).json({ error: 'review_not_required' });
  db.prepare("UPDATE whatsapp_jobs SET state='reviewed', updated_at=? WHERE id=? AND client_id=?").run(nowIso(), job.id, req.clientId);
  res.json({ ok: true });
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
app.post('/api/whatsapp/simulate', requireClient, simulatorLimit, async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) return res.status(400).json({ error: 'empty_message' });
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.clientId);
  const services = db.prepare('SELECT * FROM services WHERE client_id=?').all(req.clientId);
  const history = db.prepare(`SELECT * FROM messages WHERE client_id=? AND customer_phone=? ORDER BY created_at DESC, rowid DESC LIMIT 40`).all(req.clientId, SIM_PHONE).reverse();

  db.prepare(`INSERT INTO messages (id,client_id,customer_phone,customer_name,direction,body,created_at) VALUES (?,?,?,?,?,?,?)`)
    .run(uid(), req.clientId, SIM_PHONE, 'Simulator', 'in', String(message).slice(0, 1000), nowIso());

  let reply;
  try {
    reply = await ai.generateReply({ client, services, history, incomingMessage: String(message).slice(0, 1000), customerPhone: SIM_PHONE, customerName: 'Simulator', dryRun: true });
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
  if (receipt) {
    db.prepare("UPDATE messages SET delivery_status=?, delivery_error_code=? WHERE client_id=? AND direction='out' AND wa_message_id=?")
      .run(receipt.delivery_status, receipt.delivery_error_code, clientId, messageId);
    if (['delivered', 'read'].includes(receipt.delivery_status)) db.prepare("UPDATE whatsapp_jobs SET state='completed', error_code=NULL, updated_at=? WHERE outgoing_id IN (SELECT id FROM messages WHERE client_id=? AND direction='out' AND wa_message_id=?) AND state IN ('failed','unknown')").run(nowIso(), clientId, messageId);
    if (receipt.delivery_status === 'failed') db.prepare("UPDATE whatsapp_jobs SET state='failed', error_code=?, updated_at=? WHERE outgoing_id IN (SELECT id FROM messages WHERE client_id=? AND direction='out' AND wa_message_id=?) AND state<>'reviewed'").run(receipt.delivery_error_code, nowIso(), clientId, messageId);
  }
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

function validWebhookSignature(req) {
  const signature = req.get('x-hub-signature-256');
  if (!META_APP_SECRET || !Buffer.isBuffer(req.rawBody) || typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody).digest();
  return crypto.timingSafeEqual(expected, Buffer.from(signature.slice(7), 'hex'));
}

// Never replay an operation that might already have created a booking or sent a message.
// Queued/prepared work is safe to resume. Interrupted work is surfaced for owner review.
db.transaction(() => {
  db.prepare("UPDATE whatsapp_jobs SET state='review', error_code='interrupted_generation', updated_at=? WHERE state='processing'").run(nowIso());
  db.prepare("UPDATE messages SET delivery_status='unknown', delivery_error_code='interrupted_send' WHERE id IN (SELECT outgoing_id FROM whatsapp_jobs WHERE state='sending')").run();
  db.prepare("UPDATE whatsapp_jobs SET state='unknown', error_code='interrupted_send', updated_at=? WHERE state='sending'").run(nowIso());
})();

const stageWebhook = db.transaction((client, body) => {
  for (const entry of webhookArray(body?.entry)) {
    for (const change of webhookArray(entry?.changes)) {
      const value = change?.value;
      // Match the configured number before touching history, receipts, or bookings.
      if (!value || value.metadata?.phone_number_id !== client.wa_phone_number_id) continue;
      for (const status of webhookArray(value.statuses)) applyWhatsAppStatus(client.id, status);
      if (!client.whatsapp_enabled) continue;
      for (const msg of webhookArray(value.messages)) {
        if (!['text','image'].includes(msg?.type) || typeof msg.from !== 'string' || !/^[1-9]\d{6,15}$/.test(msg.from) ||
            typeof msg.id !== 'string' || !msg.id || msg.id.length > 512 || (msg.type === 'text' && (typeof msg.text?.body !== 'string' || !msg.text.body.trim()))) continue;
        const sentMs = typeof msg.timestamp === 'string' && /^\d{1,12}$/.test(msg.timestamp) ? Number(msg.timestamp) * 1000 : NaN;
        if (!Number.isFinite(sentMs) || sentMs <= 0 || sentMs > Date.now() + 300000) continue;
        const messageAt = new Date(sentMs).toISOString();
        const from = msg.from, text = msg.type === 'image' ? '[Photo received; awaiting consent]' : msg.text.body.slice(0, 4096);
        const name = clean(webhookArray(value.contacts).find(c => c?.wa_id === from)?.profile?.name, 120) || 'WhatsApp customer';
        const inserted = db.prepare(`INSERT OR IGNORE INTO messages
          (id,client_id,customer_phone,customer_name,direction,body,created_at,wa_message_id)
          VALUES (?,?,?,?,?,?,?,?)`).run(uid(), client.id, from, name, 'in', text, messageAt, msg.id);
        if (!inserted.changes) continue;
        db.prepare("UPDATE messages SET incoming_type=? WHERE client_id=? AND wa_message_id=? AND direction='in'").run(msg.type,client.id,msg.id);
        if (msg.type === 'image' && typeof msg.image?.id === 'string' && /^[1-9][0-9]{0,31}$/.test(msg.image.id)
            && ['image/jpeg','image/png'].includes(msg.image.mime_type) && sentMs > Date.now() - photo.TTL_MS) {
          const digest = typeof msg.image.sha256 === 'string' && /^(?:[a-fA-F0-9]{64}|[A-Za-z0-9+/]{43}=)$/.test(msg.image.sha256) ? msg.image.sha256 : null;
          db.prepare('INSERT INTO photo_uploads(client_id,customer_phone,incoming_id,media_id,sha256,expires_at) VALUES (?,?,?,?,?,?)')
            .run(client.id,from,msg.id,msg.image.id,digest,new Date(Math.min(Date.now(),sentMs)+photo.TTL_MS).toISOString());
        }
        // Snapshot which reply had actually been accepted when this input arrived.
        // A later send completion cannot retroactively authorize an earlier YES.
        const replyContext = db.prepare(`SELECT id FROM messages WHERE client_id=? AND customer_phone=? AND direction='out'
          AND accepted_at IS NOT NULL AND delivery_status IN ('accepted','sent','delivered','read') ORDER BY rowid DESC LIMIT 1`).get(client.id, from);
        db.prepare(`INSERT INTO whatsapp_jobs(id,client_id,customer_phone,customer_name,sender_phone_number_id,incoming_id,reply_context_id,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,'queued',?,?)`).run(uid(), client.id, from, name, client.wa_phone_number_id, msg.id, replyContext?.id || null, nowIso(), nowIso());
      }
    }
  }
});
let draining = false;
let stopping = false;
async function drainWhatsAppJobs() {
  if (draining || stopping) return;
  draining = true;
  try {
    photo.cleanup();
    while (!stopping) {
      const job = db.prepare("SELECT * FROM whatsapp_jobs WHERE state IN ('queued','prepared') ORDER BY created_at, rowid LIMIT 1").get();
      if (!job) break;
      const client = db.prepare('SELECT * FROM clients WHERE id=?').get(job.client_id);
      if (!client || !client.whatsapp_enabled) {
        db.prepare("UPDATE whatsapp_jobs SET state='review', error_code='receptionist_paused', updated_at=? WHERE id=?").run(nowIso(), job.id);
        continue;
      }
      const incoming = db.prepare("SELECT rowid, * FROM messages WHERE client_id=? AND direction='in' AND wa_message_id=?").get(client.id, job.incoming_id);
      const expired = !incoming || !Number.isFinite(Date.parse(incoming.created_at)) || Date.now() - Date.parse(incoming.created_at) >= 86400000 - 60000;
      if (expired || (job.sender_phone_number_id && job.sender_phone_number_id !== client.wa_phone_number_id)) {
        const reason = expired ? 'message_window_expired' : 'phone_number_changed';
        db.prepare("UPDATE whatsapp_jobs SET state='review', error_code=?, updated_at=? WHERE id=?").run(reason, nowIso(), job.id);
        if (job.outgoing_id) db.prepare("UPDATE messages SET delivery_status='failed', delivery_error_code=? WHERE id=?").run(reason, job.outgoing_id);
        continue;
      }
      let outgoingId = job.outgoing_id, sendStarted = false;
      try {
        if (job.state === 'queued') {
          db.prepare("UPDATE whatsapp_jobs SET state='processing', updated_at=? WHERE id=?").run(nowIso(), job.id);
          const history = db.prepare(`SELECT m.* FROM messages m
            LEFT JOIN whatsapp_jobs j ON j.outgoing_id=m.id AND j.client_id=m.client_id
            LEFT JOIN messages source ON source.client_id=j.client_id AND source.direction='in' AND source.wa_message_id=j.incoming_id
            WHERE m.client_id=? AND m.customer_phone=? AND m.id<>?
            AND (CASE WHEN source.rowid IS NOT NULL THEN source.rowid ELSE m.rowid END) < ?
            AND (m.direction='in' OR m.delivery_status IN ('accepted','sent','delivered','read'))
            ORDER BY (CASE WHEN source.rowid IS NOT NULL THEN source.rowid ELSE m.rowid END) DESC, (m.direction='out') DESC
            LIMIT 40`).all(client.id, job.customer_phone, incoming.id, incoming.rowid).reverse();
          const services = db.prepare('SELECT * FROM services WHERE client_id=?').all(client.id);
          // Appointment state survives an uncertain/failed final reply and bounded history.
          const latestBooking = db.prepare(`SELECT * FROM appointments WHERE client_id=? AND customer_phone=?
            AND origin_message_id IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(client.id, job.customer_phone) || null;
          let allowAdditionalBooking = false;
          if (latestBooking) {
            const origin = db.prepare("SELECT rowid FROM messages WHERE client_id=? AND direction='in' AND wa_message_id=?").get(client.id, latestBooking.origin_message_id);
            if (origin) allowAdditionalBooking = db.prepare(`SELECT body FROM messages WHERE client_id=? AND customer_phone=?
              AND direction='in' AND rowid>? AND rowid<=? ORDER BY rowid`).all(client.id, job.customer_phone, origin.rowid, incoming.rowid)
              .reduce((allowed, m) => { const intent = ai.additionalBookingIntent(m.body); return intent == null ? allowed : intent; }, false);
          }
          const bookingNeedsReview = !!db.prepare(`SELECT j.id FROM whatsapp_jobs j JOIN appointments a
            ON a.client_id=j.client_id AND a.origin_message_id=j.incoming_id
            WHERE j.client_id=? AND j.customer_phone=? AND j.id<>? AND j.state IN ('review','unknown','failed') LIMIT 1`)
            .get(client.id, job.customer_phone, job.id);
          const reply = await ai.generateReply({ client, services, history, incomingMessage: incoming.body, incomingType: incoming.incoming_type,
            customerPhone: job.customer_phone, customerName: job.customer_name, dryRun: false,
            incomingMessageId: job.incoming_id, confirmationMessageId: job.reply_context_id, latestBooking, allowAdditionalBooking, bookingNeedsReview,
            messageAt: new Date(incoming.created_at), receivedAt: new Date(job.created_at) });
          if (typeof reply?.text !== 'string' || !reply.text.trim()) throw new Error('empty_reply');
          outgoingId = uid();
          db.transaction(() => {
            db.prepare(`INSERT INTO messages (id,client_id,customer_phone,customer_name,direction,body,created_at,delivery_status)
              VALUES (?,?,?,?,?,?,?,'pending')`).run(outgoingId, client.id, job.customer_phone, job.customer_name, 'out', reply.text.slice(0, 4096), nowIso());
            if (reply.photoSessionId) {
              db.prepare('UPDATE messages SET photo_session_id=? WHERE id=?').run(reply.photoSessionId,outgoingId);
              photo.bindReply(reply.photoSessionId,client.id,job.customer_phone,outgoingId);
            }
            db.prepare("UPDATE whatsapp_jobs SET outgoing_id=?, state='prepared', updated_at=? WHERE id=?").run(outgoingId, nowIso(), job.id);
          })();
        }
        const outbound = db.prepare('SELECT body FROM messages WHERE id=?').get(outgoingId);
        if (!outbound) throw new Error('missing_output');
        const currentClient = db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
        if (!currentClient?.whatsapp_enabled || currentClient.wa_phone_number_id !== client.wa_phone_number_id || Date.now() - Date.parse(incoming.created_at) >= 86400000 - 60000) {
          db.prepare("UPDATE whatsapp_jobs SET state='review', error_code='configuration_or_window_changed', updated_at=? WHERE id=?").run(nowIso(), job.id);
          db.prepare("UPDATE messages SET delivery_status='failed', delivery_error_code='configuration_or_window_changed' WHERE id=?").run(outgoingId);
          continue;
        }
        // Mark before network I/O; a restart cannot safely decide whether Meta accepted it.
        db.prepare("UPDATE whatsapp_jobs SET state='sending', updated_at=? WHERE id=?").run(nowIso(), job.id);
        sendStarted = true;
        const result = await sendWhatsAppMessage(currentClient, job.customer_phone, outbound.body);
        db.transaction(() => {
          db.prepare('UPDATE messages SET delivery_status=?, delivery_error_code=?, wa_message_id=?, accepted_at=? WHERE id=?')
            .run(result.status, result.code || null, result.messageId || null, result.ok ? nowIso() : null, outgoingId);
          db.prepare('UPDATE whatsapp_jobs SET state=?, error_code=?, updated_at=? WHERE id=?')
            .run(result.ok ? 'completed' : result.status === 'unknown' ? 'unknown' : 'failed', result.code || null, nowIso(), job.id);
          if (result.messageId) applyStoredWhatsAppStatus(client.id, result.messageId);
        })();
        if (!result.ok) console.error('whatsapp_send_failed', { status: result.status, code: result.code });
      } catch {
        if (outgoingId) db.prepare('UPDATE messages SET delivery_status=?, delivery_error_code=? WHERE id=?')
          .run(sendStarted ? 'unknown' : 'failed', sendStarted ? 'processing_error' : 'reply_generation_failed', outgoingId);
        db.prepare('UPDATE whatsapp_jobs SET state=?, error_code=?, updated_at=? WHERE id=?')
          .run(sendStarted ? 'unknown' : 'review', sendStarted ? 'processing_error' : 'reply_generation_failed', nowIso(), job.id);
        console.error('whatsapp_processing_failed');
      }
    }
  } catch { console.error('whatsapp_queue_failed'); }
  finally { draining = false; }
}
// Inbound messages and delivery receipts are authenticated, then persisted before ACK.
app.post('/webhooks/whatsapp/:clientId', (req, res) => {
  if (!META_APP_SECRET) return res.status(503).json({ error: 'webhook_not_configured' });
  if (!validWebhookSignature(req)) return res.status(401).json({ error: 'invalid_signature' });
  const client = db.prepare('SELECT * FROM clients WHERE id=?').get(req.params.clientId);
  if (!client) return res.sendStatus(404);
  try { stageWebhook(client, req.body); }
  catch { console.error('whatsapp_webhook_storage_failed'); return res.sendStatus(503); }
  res.sendStatus(200);
  setImmediate(drainWhatsAppJobs);
});
setImmediate(drainWhatsAppJobs);
const queueTimer = setInterval(drainWhatsAppJobs, 5000);
queueTimer.unref();

app.get('/healthz', (req, res) => {
  try { db.prepare('SELECT 1').get(); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
});
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500;
  if (status === 500) console.error('request_failed');
  res.status(status).json({ error: status === 500 ? 'request_failed' : 'invalid_request' });
});

const server = app.listen(PORT, () => console.log(`BeautyDesk server running on port ${PORT}`));
async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(queueTimer);
  server.close();
  const deadline = Date.now() + 25000;
  while (draining && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  // Any interrupted generation/send remains marked for review on next startup.
  db.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
