/* ============ FETCH HELPER ============ */
async function api(method, url, body){
  const res = await fetch(url, {
    method,
    headers: body ? {'Content-Type':'application/json'} : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try{ data = await res.json(); }catch(e){}
  if(!res.ok){ const err = new Error((data && data.error) || 'request_failed'); err.status = res.status; err.data = data; throw err; }
  return data;
}
function fmtZAR(n){ return 'R' + Number(n).toLocaleString('en-ZA'); }
function fmtDate(iso){ const d = new Date(iso); return d.toLocaleDateString('en-ZA',{day:'numeric',month:'short'}); }
function esc(s){ return (s||'').toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============ ROUTER ============ */
function go(view){
  document.getElementById('view-site').hidden = view!=='site';
  document.getElementById('view-admin').hidden = view!=='admin';
  document.getElementById('view-client').hidden = view!=='client';
  window.scrollTo(0,0);
  document.getElementById('loginMenu').hidden = true;
  if(view==='admin') renderAdminGate();
  if(view==='client') renderClientGate();
}
async function renderAdminGate(){
  const { authed } = await api('GET','/api/admin/session');
  document.getElementById('admin-login').hidden = authed;
  document.getElementById('admin-dash').hidden = !authed;
  if(authed) renderAdmin();
}
async function renderClientGate(){
  try{
    const me = await api('GET','/api/client/me');
    document.getElementById('client-login').hidden = true;
    document.getElementById('client-dash').hidden = false;
    renderClient(me);
  }catch(e){
    document.getElementById('client-login').hidden = false;
    document.getElementById('client-dash').hidden = true;
  }
}

document.getElementById('loginMenuBtn').addEventListener('click', function(e){
  e.stopPropagation();
  const m = document.getElementById('loginMenu');
  m.hidden = !m.hidden;
});
document.addEventListener('click', function(){ document.getElementById('loginMenu').hidden = true; });

/* ============ TOAST ============ */
let toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(()=>t.classList.remove('show'), 3600);
}

/* ============ SIGNUP MODAL ============ */
function openSignup(){ document.getElementById('signupModal').hidden = false; }
function closeSignup(){ document.getElementById('signupModal').hidden = true; }
document.getElementById('signupModal').addEventListener('click', function(e){ if(e.target===this) closeSignup(); });

async function submitSignup(e){
  e.preventDefault();
  const f = e.target;
  try{
    await api('POST','/api/signups', {
      salon: f.salon.value, owner: f.owner.value, email: f.email.value, phone: f.phone.value, city: f.city.value,
    });
    f.reset();
    closeSignup();
    toast('Spot reserved! We will contact you to activate billing.');
  }catch(err){
    toast('Something went wrong — please try again.');
  }
  return false;
}

/* ============ CONTACT / INQUIRY FORM ============ */
async function submitInquiry(e){
  e.preventDefault();
  const f = e.target;
  try{
    await api('POST','/api/inquiries', {
      name: f.name.value, salon: f.salon.value, email: f.email.value, phone: f.phone.value, city: f.city.value, message: f.message.value,
    });
    f.reset();
    toast('Thanks! Your enquiry has been sent.');
  }catch(err){
    toast('Something went wrong — please try again.');
  }
  return false;
}

/* ============ ADMIN ============ */
async function adminLogin(e){
  e.preventDefault();
  const passcode = document.getElementById('adminPass').value;
  try{
    await api('POST','/api/admin/login', { passcode });
    document.getElementById('adminPass').value = '';
    renderAdminGate();
  }catch(err){
    toast('Incorrect passcode.');
  }
  return false;
}
async function adminLogout(){ await api('POST','/api/admin/logout'); renderAdminGate(); }

async function renderAdmin(){
  document.getElementById('adminDateLine').textContent = new Date().toLocaleDateString('en-ZA',{weekday:'long', day:'numeric', month:'long', year:'numeric'});
  const [inquiries, signups] = await Promise.all([
    api('GET','/api/admin/inquiries'),
    api('GET','/api/admin/signups'),
  ]);
  const weekAgo = Date.now() - 1000*60*60*24*7;
  const newThisWeek = inquiries.filter(i=>new Date(i.created_at).getTime() > weekAgo).length;
  const activeClients = signups.filter(s=>s.status==='active').length;
  const mrr = activeClients * 799;
  const conv = inquiries.length ? Math.round((signups.length / inquiries.length) * 100) : 0;

  document.getElementById('adminStats').innerHTML = [
    ['New inquiries (7d)', newThisWeek, newThisWeek>0? '▲ live from contact form':'No new inquiries yet','up'],
    ['Active clients', activeClients, activeClients>0?'▲ paying subscribers':'None yet','up'],
    ['Estimated MRR', fmtZAR(mrr), 'From active clients × R799','flat'],
    ['Inquiry → signup rate', conv+'%', 'Across all-time inquiries','flat'],
  ].map(s => `<div class="stat-tile"><div class="label">${s[0]}</div><div class="val">${s[1]}</div><div class="delta ${s[3]}">${s[2]}</div></div>`).join('');

  drawArea('chartConversations', [120,135,128,150,162,158,175,190,182,205,220,238], ['Oct','Nov','Dec','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep']);

  const byCity = {};
  inquiries.forEach(i => { byCity[i.city] = (byCity[i.city]||0) + 1; });
  const cityEntries = Object.entries(byCity).sort((a,b)=>b[1]-a[1]);
  drawBars('chartCities', cityEntries.length ? cityEntries : [['No inquiries yet',0]]);

  document.getElementById('inquiriesBody').innerHTML = inquiries.map(i => `
    <tr>
      <td><b>${esc(i.salon)}</b><br><span style="color:var(--ink-faint);font-size:.8rem">${esc(i.name)}</span></td>
      <td>${esc(i.email)}<br><span style="color:var(--ink-faint);font-size:.8rem">${esc(i.phone)}</span></td>
      <td>${esc(i.city)}</td>
      <td><span class="pill ${i.status}">${i.status}</span></td>
      <td>${fmtDate(i.created_at)}</td>
      <td><div class="row-actions">
        ${i.status!=='contacted'?`<button class="mini-btn" onclick="setInquiryStatus('${i.id}','contacted')">Mark contacted</button>`:''}
        ${i.status!=='converted'?`<button class="mini-btn" onclick="setInquiryStatus('${i.id}','converted')">Mark converted</button>`:''}
      </div></td>
    </tr>`).join('') || `<tr><td colspan="6" style="color:var(--ink-faint)">No inquiries yet.</td></tr>`;

  document.getElementById('signupsBody').innerHTML = signups.map(s => `
    <tr>
      <td><b>${esc(s.salon)}</b></td>
      <td>${esc(s.owner)}<br><span style="color:var(--ink-faint);font-size:.8rem">${esc(s.email)}</span></td>
      <td>${esc(s.city)}</td>
      <td>${esc(s.plan)}</td>
      <td><span class="pill ${s.status==='active'?'active':'pending'}">${s.status}</span></td>
      <td>${s.status!=='active'?`<button class="mini-btn" onclick="activateSignup('${s.id}')">Activate client</button>`:''}</td>
    </tr>`).join('') || `<tr><td colspan="6" style="color:var(--ink-faint)">No signups yet.</td></tr>`;
}
async function setInquiryStatus(id, status){
  await api('PATCH', '/api/admin/inquiries/'+id, { status });
  renderAdmin();
}
async function activateSignup(id){
  const result = await api('POST', '/api/admin/signups/'+id+'/activate');
  renderAdmin();
  if(result.tempPassword){
    toast(`Client activated. Send them: ${result.clientEmail} / ${result.tempPassword} (shown once — copy it now)`);
  } else {
    toast('Client activated — they already have a BeautyDesk login.');
  }
}

/* ============ CLIENT PORTAL ============ */
async function clientLogin(e){
  e.preventDefault();
  const email = document.getElementById('clientEmail').value.trim();
  const password = document.getElementById('clientPassword').value;
  try{
    await api('POST','/api/client/login', { email, password });
    renderClientGate();
  }catch(err){
    toast('Email or password not recognised.');
  }
  return false;
}
async function clientLogout(){ await api('POST','/api/client/logout'); renderClientGate(); }

let CURRENT_HOURS = null;

async function renderClient(me){
  const initial = me.salon.trim().charAt(0).toUpperCase();
  document.getElementById('clientSalonHeading').textContent = 'Welcome back, ' + me.salon;
  document.getElementById('clientNameTag').textContent = me.salon;
  document.getElementById('clientAvatar').textContent = initial;
  document.getElementById('billingStatus').textContent = me.plan_status==='active' ? 'Active · next billing 1 Oct 2026' : 'Pending activation';
  document.getElementById('waToggle').checked = !!me.whatsapp_enabled;
  document.getElementById('waGreeting').value = me.greeting || '';
  updateWaStatusUI(!!me.whatsapp_enabled);

  document.getElementById('waWebhookUrl').value = me.webhook_url;
  document.getElementById('waVerifyToken').value = me.wa_verify_token;
  renderWhatsappConnection(me);

  CURRENT_HOURS = JSON.parse(me.hours);
  renderHoursForm(CURRENT_HOURS);

  const [services, appts, recentMsgs, simMsgs] = await Promise.all([
    api('GET','/api/client/services'),
    api('GET','/api/client/appointments'),
    api('GET','/api/client/recent-messages'),
    api('GET','/api/client/simulator/messages'),
  ]);
  renderServices(services);
  renderAppointments(appts);
  renderRecentMessages(recentMsgs);
  renderSimMessages(simMsgs);
}

function updateWaStatusUI(on){
  document.getElementById('waStatusCard').classList.toggle('off', !on);
  document.getElementById('waStatusText').textContent = on ? 'AI Receptionist is enabled' : 'AI Receptionist is paused';
}
function toggleWhatsapp(){
  updateWaStatusUI(document.getElementById('waToggle').checked);
}
async function saveWaSettings(){
  try{
    await api('PATCH','/api/client/settings', {
      whatsappEnabled: document.getElementById('waToggle').checked,
      greeting: document.getElementById('waGreeting').value,
    });
    toast('Settings saved.');
  }catch(err){
    toast('Could not save — please log in again.');
  }
}

/* ---- appointments & recent messages (real data) ---- */
function renderAppointments(appts){
  document.getElementById('apptList').innerHTML = appts.length ? appts.map(a=>{
    const d = new Date(a.starts_at);
    const day = d.toLocaleDateString('en-ZA',{day:'numeric'});
    const mon = d.toLocaleDateString('en-ZA',{month:'short'});
    const time = d.toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'});
    return `<div class="appt-item"><div class="appt-date"><b>${day}</b><span>${mon}</span></div><div><b>${esc(a.customer_name)} — ${esc(a.service_name)}</b><br><span style="color:var(--ink-faint);font-size:.85rem">${time} · via ${a.source==='whatsapp_ai'?'WhatsApp AI':a.source==='simulator'?'AI simulator':'manual entry'}</span></div></div>`;
  }).join('') : `<p style="color:var(--ink-faint);font-size:.9rem">No upcoming appointments yet — bookings made by your WhatsApp AI (or the simulator) will show up here.</p>`;
}
function renderRecentMessages(msgs){
  document.getElementById('msgList').innerHTML = msgs.length ? msgs.map(m=>{
    const ago = timeAgo(m.created_at);
    return `<div class="msg-item"><div class="phone-avatar" style="background:var(--blush-500)">${esc((m.customer_name||'?').charAt(0))}</div><div><b>${esc(m.customer_name||'WhatsApp customer')}</b><br><span style="color:var(--ink-faint);font-size:.85rem">${esc(m.body)}</span><br><span style="color:var(--ink-faint);font-size:.72rem">${ago}</span></div></div>`;
  }).join('') : `<p style="color:var(--ink-faint);font-size:.9rem">No messages yet — real WhatsApp conversations (and simulator tests) will appear here.</p>`;
}
function timeAgo(iso){
  const mins = Math.max(1, Math.round((Date.now()-new Date(iso).getTime())/60000));
  if(mins<60) return mins+'m ago';
  const hrs = Math.round(mins/60);
  if(hrs<24) return hrs+'h ago';
  return Math.round(hrs/24)+'d ago';
}

/* ---- services ---- */
function renderServices(services){
  document.getElementById('servicesList').innerHTML = services.length ? services.map(s=>`
    <div class="mock-row" style="padding:8px 0;border-top:1px solid var(--line)">
      <span><b>${esc(s.name)}</b> — R${s.price} · ${s.duration_mins} min</span>
      <button class="mini-btn" onclick="deleteService('${s.id}')">Remove</button>
    </div>`).join('') : `<p style="color:var(--ink-faint);font-size:.9rem">No services yet — add your first one below so the AI knows what to quote.</p>`;
}
async function addService(){
  const name = document.getElementById('svcName').value.trim();
  const price = document.getElementById('svcPrice').value;
  const durationMins = document.getElementById('svcDuration').value;
  if(!name || price===''){ toast('Add a service name and price.'); return; }
  try{
    await api('POST','/api/client/services', { name, price, durationMins });
    document.getElementById('svcName').value = '';
    document.getElementById('svcPrice').value = '';
    document.getElementById('svcDuration').value = '';
    renderServices(await api('GET','/api/client/services'));
  }catch(e){ toast('Could not add that service.'); }
}
async function deleteService(id){
  await api('DELETE','/api/client/services/'+id);
  renderServices(await api('GET','/api/client/services'));
}

/* ---- business hours ---- */
const HOUR_DAYS = [['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']];
function renderHoursForm(hours){
  document.getElementById('hoursForm').innerHTML = HOUR_DAYS.map(([key,label])=>`
    <div class="field"><label>${label}</label><input id="hours_${key}" value="${esc(hours[key]||'closed')}"></div>
  `).join('');
}
async function saveHours(){
  const hours = {};
  HOUR_DAYS.forEach(([key])=>{ hours[key] = document.getElementById('hours_'+key).value.trim() || 'closed'; });
  try{
    await api('PATCH','/api/client/settings', {
      whatsappEnabled: document.getElementById('waToggle').checked,
      greeting: document.getElementById('waGreeting').value,
      hours,
    });
    toast('Business hours saved.');
  }catch(e){ toast('Could not save hours.'); }
}

/* ---- WhatsApp connection ---- */
function protectWhatsappInputs(){
  const idInput = document.getElementById('waPhoneNumberId');
  const tokenInput = document.getElementById('waAccessToken');
  if(idInput){ idInput.setAttribute('autocomplete','off'); idInput.setAttribute('inputmode','numeric'); }
  if(tokenInput){ tokenInput.setAttribute('autocomplete','new-password'); tokenInput.setAttribute('type','password'); }
}
function renderWhatsappConnection(me){
  protectWhatsappInputs();
  const pill = document.getElementById('waConnectedPill');
  const last = me.wa_last_delivery;
  let label = me.wa_connected ? 'Saved · delivery unverified' : 'Not configured';
  let good = false;
  if(me.wa_connected && last){
    const labels = { pending: 'Reply sending', accepted: 'Reply accepted · awaiting delivery', sent: 'Reply sent · awaiting delivery', delivered: 'Last reply delivered', read: 'Last reply read', unknown: 'Reply delivery unknown', failed: 'Reply failed' };
    label = labels[last.delivery_status] || label;
    if(last.delivery_error_code) label += ' (' + last.delivery_error_code + ')';
    good = ['delivered','read'].includes(last.delivery_status);
  }
  pill.textContent = label;
  pill.style.background = good ? 'var(--good-bg)' : 'var(--warn-bg)';
  pill.style.color = good ? 'var(--good)' : 'var(--warn)';
}
async function saveWhatsappConnection(){
  const idInput = document.getElementById('waPhoneNumberId');
  const tokenInput = document.getElementById('waAccessToken');
  const phoneNumberId = idInput.value.trim();
  const accessToken = tokenInput.value.trim();
  if(!phoneNumberId && !accessToken){ toast('Enter connection details to update. Blank fields keep saved values.'); return; }
  if(phoneNumberId && !/^\d{1,32}$/.test(phoneNumberId)){ toast('Phone Number ID must contain digits, not your email or display phone number.'); return; }
  if(accessToken && (accessToken.length < 20 || accessToken.length > 4096 || /[\s@]/.test(accessToken))){ toast('Use your Meta access token, not your login password.'); return; }
  try{
    await api('PATCH','/api/client/whatsapp-connection', { phoneNumberId, accessToken });
    tokenInput.value = '';
    toast('Settings saved. Delivery is verified only after a WhatsApp reply arrives.');
    renderWhatsappConnection(await api('GET','/api/client/me'));
  }catch(e){
    const labels = { invalid_phone_number_id: 'Enter the numeric Meta Phone Number ID.', invalid_access_token: 'Enter a valid-format Meta access token.', no_connection_changes: 'Enter new details; saved values are unchanged.' };
    toast(labels[e.message] || 'Could not save — please try again.');
  }
}

/* ---- WhatsApp AI simulator ---- */
function renderSimMessages(msgs){
  const body = document.getElementById('simBody');
  body.innerHTML = msgs.length ? msgs.map(m=>{
    const t = new Date(m.created_at).toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit'});
    return `<div class="bubble ${m.direction==='in'?'in':'out'}">${esc(m.body)}<time>${t}</time></div>`;
  }).join('') : `<p style="color:#8a8a8a;font-size:.8rem;text-align:center;margin-top:20px">Say hi below to test your AI receptionist.</p>`;
  body.scrollTop = body.scrollHeight;
}
async function sendSimMessage(){
  const input = document.getElementById('simInput');
  const message = input.value.trim();
  if(!message) return;
  input.value = '';
  const body = document.getElementById('simBody');
  if(body){
    // Optimistic render so the customer's own message appears instantly, before the AI reply comes back.
    body.insertAdjacentHTML('beforeend', `<div class="bubble in">${esc(message)}</div>`);
    body.scrollTop = body.scrollHeight;
  }
  try{
    const result = await api('POST','/api/whatsapp/simulate', { message });
    document.getElementById('simModePill').textContent = result.mode==='claude' ? 'Claude AI' : (result.mode==='mock_fallback' ? 'demo (AI key error)' : 'demo mode');
    renderSimMessages(await api('GET','/api/client/simulator/messages'));
  }catch(e){ toast('The simulator hit an error — try again.'); }
}
async function resetSimulator(){
  await api('POST','/api/client/simulator/reset');
  renderSimMessages([]);
}

/* ============ CHARTS (inline SVG) ============ */
function drawArea(containerId, data, labels){
  const el = document.getElementById(containerId);
  const w = 480, h = 200, pad = {t:16,r:12,b:26,l:12};
  const max = Math.max(...data) * 1.15;
  const stepX = (w - pad.l - pad.r) / (data.length - 1);
  const x = i => pad.l + i*stepX;
  const y = v => pad.t + (h-pad.t-pad.b) * (1 - v/max);
  const linePts = data.map((v,i)=>`${x(i)},${y(v)}`).join(' ');
  const areaPts = `${x(0)},${y(0)} ` + linePts + ` ${x(data.length-1)},${y(0)}`;
  const gridLines = [0,0.5,1].map(f => {
    const gy = pad.t + (h-pad.t-pad.b)*f;
    return `<line x1="${pad.l}" y1="${gy}" x2="${w-pad.r}" y2="${gy}" stroke="var(--line)" stroke-width="1"/>`;
  }).join('');
  const lastIdx = data.length-1;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h+18}" style="width:100%;height:auto;font-family:var(--font-body)">
    <defs><linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--gold-400)" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="var(--gold-400)" stop-opacity="0"/>
    </linearGradient></defs>
    ${gridLines}
    <polygon points="${areaPts}" fill="url(#areaGrad)"/>
    <polyline points="${linePts}" fill="none" stroke="var(--gold-600)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(lastIdx)}" cy="${y(data[lastIdx])}" r="4.5" fill="var(--gold-600)"><title>${labels[lastIdx]}: ${data[lastIdx]}</title></circle>
    <text x="${x(lastIdx)}" y="${y(data[lastIdx])-12}" text-anchor="end" font-size="11" fill="var(--ink)" font-weight="700">${data[lastIdx]}</text>
    <text x="${x(0)}" y="${h+14}" font-size="10" fill="var(--ink-faint)">${labels[0]}</text>
    <text x="${x(lastIdx)}" y="${h+14}" text-anchor="end" font-size="10" fill="var(--ink-faint)">${labels[lastIdx]}</text>
  </svg>`;
}
function drawBars(containerId, entries){
  const el = document.getElementById(containerId);
  const max = Math.max(...entries.map(e=>e[1]), 1);
  el.innerHTML = `<div style="display:flex;flex-direction:column;gap:12px;padding-top:4px">` + entries.map(([label,val]) => {
    const pct = Math.max((val/max)*100, val>0?6:0);
    return `<div>
      <div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:5px"><span>${esc(label)}</span><b>${val}</b></div>
      <div style="background:var(--line);border-radius:999px;height:10px;overflow:hidden"><div style="width:${pct}%;background:linear-gradient(90deg,var(--gold-400),var(--gold-600));height:100%;border-radius:999px"></div></div>
    </div>`;
  }).join('') + `</div>`;
}

/* ============ INIT ============ */
protectWhatsappInputs();
go('site');
