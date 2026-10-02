/* ============ REQUESTS & FEEDBACK ============ */
async function api(method, url, body){
  if(body === undefined && !['GET','HEAD'].includes(method)) body = {};
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
function fmtDate(iso){ return new Date(iso).toLocaleDateString('en-ZA',{day:'numeric',month:'short',timeZone:'Africa/Johannesburg'}); }
function esc(s){ return (s == null ? '' : s).toString().replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const byId = id => document.getElementById(id);
const PENDING = new Set();
function errorMessage(err, fallback){
  if(err.status === 401 && !['invalid_credentials','invalid_passcode'].includes(err.message)) return 'Your session expired. Log in again, then retry.';
  if(err.status === 429) return 'Too many attempts. Please wait before trying again.';
  return fallback || 'Could not complete that request. Check your connection and try again.';
}
async function runAction(key, controls, task, onError){
  if(PENDING.has(key)) return false;
  PENDING.add(key);
  const nodes = Array.from(controls || []).filter(Boolean);
  const prior = nodes.map(node => node.disabled);
  nodes.forEach(node => { node.disabled = true; });
  try{ await task(); return true; }
  catch(err){ if(onError) onError(err); else toast(errorMessage(err)); return false; }
  finally{ PENDING.delete(key); nodes.forEach((node,i) => { node.disabled = prior[i]; }); }
}
function formControls(form){ return form.querySelectorAll('button, input, textarea, select'); }
function fieldValue(form, name){ return form.elements.namedItem(name).value.trim(); }
let toastTimer;
function toast(msg){
  const t = byId('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(()=>t.classList.remove('show'), 6000);
}

/* ============ ROUTER & SESSION GATES ============ */
let ACTIVE_VIEW = 'site';
let clientGeneration = 0;
let refreshTimer;
function viewForHash(){ return /^#(?:\/client|cl-)/.test(location.hash) ? 'client' : /^#(?:\/admin|adm-)/.test(location.hash) ? 'admin' : 'site'; }
function go(view, fromHistory){
  ACTIVE_VIEW = view;
  clientGeneration++;
  clearInterval(refreshTimer);
  ['site','admin','client'].forEach(name => { byId('view-'+name).hidden = view!==name; });
  if(!fromHistory){
    const hash = view === 'site' ? '' : '#/'+view;
    if(location.hash !== hash) history.pushState(null, '', location.pathname+location.search+hash);
    window.scrollTo(0,0);
  }
  byId('loginMenu').hidden = true;
  if(view==='admin') renderAdminGate();
  if(view==='client') renderClientGate();
}
window.addEventListener('popstate', ()=>{ const view=viewForHash(); if(view!==ACTIVE_VIEW) go(view,true); });
window.addEventListener('hashchange', ()=>{ if(viewForHash() !== ACTIVE_VIEW) go(viewForHash(), true); });
async function renderAdminGate(){
  try{
    const { authed } = await api('GET','/api/admin/session');
    if(ACTIVE_VIEW !== 'admin') return;
    byId('admin-login').hidden = authed; byId('admin-dash').hidden = !authed;
    if(authed) await renderAdmin();
  }catch(err){ toast(errorMessage(err, 'Could not load the owner dashboard. Please retry.')); }
}
async function renderClientGate(){
  const generation = clientGeneration;
  try{
    const me = await api('GET','/api/client/me');
    if(ACTIVE_VIEW !== 'client' || generation !== clientGeneration) return;
    byId('client-login').hidden = true; byId('client-dash').hidden = false;
    await renderClient(me, generation);
    if(generation === clientGeneration && ACTIVE_VIEW === 'client'){
      clearInterval(refreshTimer);
      refreshTimer = setInterval(()=>{ if(!document.hidden) refreshClientData(false); },30000);
    }
  }catch(err){
    if(generation !== clientGeneration) return;
    if(err.status === 401 || err.status === 404){
      byId('client-login').hidden = false; byId('client-dash').hidden = true;
    }else toast(errorMessage(err, 'Could not load the salon dashboard. Please retry.'));
  }
}
byId('loginMenuBtn').addEventListener('click', function(e){ e.stopPropagation(); byId('loginMenu').hidden = !byId('loginMenu').hidden; });
document.addEventListener('click', ()=>{ byId('loginMenu').hidden = true; });

/* ============ PUBLIC FORMS ============ */
let signupReturnFocus;
function openSignup(){ signupReturnFocus = document.activeElement; byId('signupModal').hidden = false; byId('signupModal').querySelector('input').focus(); }
function closeSignup(){ byId('signupModal').hidden = true; if(signupReturnFocus) signupReturnFocus.focus(); }
byId('signupModal').addEventListener('click', function(e){ if(e.target===this) closeSignup(); });
document.addEventListener('keydown', e=>{
  if(byId('signupModal').hidden) return;
  if(e.key === 'Escape'){ closeSignup(); return; }
  if(e.key === 'Tab'){
    const nodes = Array.from(byId('signupModal').querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled)'));
    const first = nodes[0], last = nodes[nodes.length-1];
    if(e.shiftKey && document.activeElement===first){ last.focus(); e.preventDefault(); }
    else if(!e.shiftKey && document.activeElement===last){ first.focus(); e.preventDefault(); }
  }
});
async function submitSignup(e){
  e.preventDefault(); const f = e.target;
  const payload = Object.fromEntries(['salon','owner','email','phone','city'].map(name=>[name,fieldValue(f,name)]));
  await runAction('signup', formControls(f), async()=>{
    await api('POST','/api/signups',payload); f.reset(); closeSignup();
    toast('Pilot request saved. The BeautyDesk owner will follow up. No payment was taken.');
  }, err=>toast(errorMessage(err, err.message==='duplicate_signup' ? 'A request already exists for this email. Contact the BeautyDesk owner for access.' : 'Could not save your request. Check your details and try again.')));
  return false;
}
async function submitInquiry(e){
  e.preventDefault(); const f = e.target;
  const payload = Object.fromEntries(['name','salon','email','phone','city','message'].map(name=>[name,fieldValue(f,name)]));
  await runAction('inquiry', formControls(f), async()=>{ await api('POST','/api/inquiries',payload); f.reset(); toast('Thanks! Your enquiry is saved for the BeautyDesk owner.'); });
  return false;
}

/* ============ OWNER PORTAL ============ */
async function adminLogin(e){
  e.preventDefault(); const passcode = byId('adminPass').value;
  await runAction('admin-login',formControls(e.target),async()=>{
    await api('POST','/api/admin/login',{passcode}); byId('adminPass').value=''; await renderAdminGate();
  },err=>toast(errorMessage(err,err.status===401?'Passcode not recognised.':'Could not log in. Please retry.')));
  return false;
}
async function adminLogout(){
  await runAction('admin-logout',[],async()=>{ await api('POST','/api/admin/logout'); dismissActivationResult(); await renderAdminGate(); });
}
async function renderAdmin(){
  const [inquiries, signups] = await Promise.all([api('GET','/api/admin/inquiries'),api('GET','/api/admin/signups')]);
  byId('adminDateLine').textContent = new Date().toLocaleDateString('en-ZA',{weekday:'long',day:'numeric',month:'long',year:'numeric',timeZone:'Africa/Johannesburg'});
  const weekAgo = Date.now()-86400000*7;
  const newThisWeek = inquiries.filter(i=>new Date(i.created_at).getTime()>weekAgo).length;
  const activated = signups.filter(s=>s.status==='active').length;
  byId('adminStats').innerHTML = [
    ['New enquiries (7d)',newThisWeek,'Live contact form submissions','up'],
    ['Activated salons',activated,'Login access, not payment status','flat'],
    ['Pilot requests',signups.length,'Live access requests','flat'],
    ['Payments','Not connected','PayFast is not integrated','flat'],
  ].map(s=>`<div class="stat-tile"><div class="label">${s[0]}</div><div class="val"${typeof s[1]==='string'?' style="font-size:1.3rem"':''}>${s[1]}</div><div class="delta ${s[3]}">${s[2]}</div></div>`).join('');
  byId('chartConversations').innerHTML = '<p class="status-note">No conversation totals are estimated here. Activation grants access only; it does not record revenue.</p>';
  const byCity = {};
  inquiries.forEach(i=>{ byCity[i.city]=(byCity[i.city]||0)+1; });
  drawBars('chartCities',Object.entries(byCity).sort((a,b)=>b[1]-a[1]).length ? Object.entries(byCity).sort((a,b)=>b[1]-a[1]) : [['No enquiries yet',0]]);
  byId('inquiriesBody').innerHTML = inquiries.map(i=>`
    <tr><td><b>${esc(i.salon)}</b><br><span class="status-note">${esc(i.name)}</span></td>
    <td>${esc(i.email)}<br><span class="status-note">${esc(i.phone)}</span></td><td>${esc(i.city)}</td>
    <td><span class="pill ${['new','contacted','converted','lost'].includes(i.status)?i.status:'pending'}">${esc(i.status)}</span></td><td>${fmtDate(i.created_at)}</td>
    <td><div class="row-actions">${i.status!=='contacted'?`<button class="mini-btn" onclick="setInquiryStatus('${esc(i.id)}','contacted',this)">Mark contacted</button>`:''}${i.status!=='converted'?`<button class="mini-btn" onclick="setInquiryStatus('${esc(i.id)}','converted',this)">Mark converted</button>`:''}</div></td></tr>`).join('') || '<tr><td colspan="6">No enquiries yet.</td></tr>';
  byId('signupsBody').innerHTML = signups.map(s=>`
    <tr><td><b>${esc(s.salon)}</b></td><td>${esc(s.owner)}<br><span class="status-note">${esc(s.email)}</span></td><td>${esc(s.city)}</td><td>${esc(s.plan)}</td>
    <td><span class="pill ${s.status==='active'?'active':'pending'}">${s.status==='active'?'Access activated':esc(s.status)}</span></td>
    <td>${s.status!=='active'?`<button class="mini-btn" onclick="activateSignup('${esc(s.id)}',this)">Activate salon access</button>`:''}</td></tr>`).join('') || '<tr><td colspan="6">No pilot requests yet.</td></tr>';
}
async function setInquiryStatus(id,status,button){
  await runAction('inquiry-'+id,[button],async()=>{ await api('PATCH','/api/admin/inquiries/'+encodeURIComponent(id),{status}); await renderAdmin(); });
}
async function activateSignup(id,button){
  await runAction('activate-'+id,[button],async()=>{
    const result = await api('POST','/api/admin/signups/'+encodeURIComponent(id)+'/activate');
    byId('activationMessage').textContent = result.tempPassword ? `Salon access created. Save this one-time login securely: ${result.clientEmail} / ${result.tempPassword}. Give it to the salon owner through your agreed secure channel and ask them to change it under Account security. No payment was taken.` : 'Salon access activated. An existing login was retained. No payment was taken.';
    byId('activationResult').hidden = false; await renderAdmin();
  });
}
function dismissActivationResult(){ byId('activationMessage').textContent=''; byId('activationResult').hidden=true; }

/* ============ SALON DASHBOARD ============ */
let CURRENT_CLIENT = null;
let CURRENT_SERVICES = [];
let CURRENT_HOURS = null;
let PHOTO_SETTINGS_DIRTY = false;
async function clientLogin(e){
  e.preventDefault(); const email=byId('clientEmail').value.trim(), password=byId('clientPassword').value;
  await runAction('client-login',formControls(e.target),async()=>{
    await api('POST','/api/client/login',{email,password}); byId('clientPassword').value=''; await renderClientGate();
  },err=>toast(err.status===401?'Email or password not recognised.':err.status===429?'Too many attempts. Please wait before trying again.':err.status?'BeautyDesk could not complete sign-in. Please try again shortly.':'Could not reach BeautyDesk. Check your connection and try again.'));
  return false;
}
async function clientLogout(){
  await runAction('client-logout',[],async()=>{
    await api('POST','/api/client/logout'); clientGeneration++; clearInterval(refreshTimer); CURRENT_CLIENT=null; CURRENT_SERVICES=[]; PHOTO_SETTINGS_DIRTY=false; clearClientLists();
    byId('waAccessToken').value=''; byId('waPhoneNumberId').value=''; byId('passwordForm').reset(); byId('passwordFeedback').textContent='';
    byId('client-dash').hidden=true; byId('client-login').hidden=false;
  });
}
function parseClientHours(hours){ try{ return typeof hours==='string' ? JSON.parse(hours) : (hours || {}); }catch(e){ return {}; } }
function clearClientLists(){ ['apptList','msgList','simBody','servicesList','waReviewList'].forEach(id=>{byId(id).textContent='Loading…';}); }
async function renderClient(me,generation){
  clearClientLists();
  delete byId('simModePill').dataset.resultMode;
  CURRENT_CLIENT=me; CURRENT_SERVICES=[]; PHOTO_SETTINGS_DIRTY=false; CURRENT_HOURS=parseClientHours(me.hours);
  byId('photoSettingsFeedback').textContent='';
  byId('clientSalonHeading').textContent='Welcome back, '+me.salon;
  byId('clientNameTag').textContent=me.salon; byId('clientAvatar').textContent=me.salon.trim().charAt(0).toUpperCase();
  byId('billingStatus').textContent='Online billing is not connected';
  byId('waToggle').checked=!!me.whatsapp_enabled; byId('waGreeting').value=me.greeting||'';
  byId('waWebhookUrl').value=me.webhook_url||''; byId('waVerifyToken').value=me.wa_verify_token||'';
  renderHoursForm(CURRENT_HOURS); renderClientStatus(me); updateWaStatusUI(!!me.whatsapp_enabled);
  const [services,appts,recentMsgs,simMsgs,reviews]=await Promise.all([
    api('GET','/api/client/services'),api('GET','/api/client/appointments'),api('GET','/api/client/recent-messages'),api('GET','/api/client/simulator/messages'),api('GET','/api/client/whatsapp-reviews'),
  ]);
  if(generation!==clientGeneration || ACTIVE_VIEW!=='client') return;
  CURRENT_SERVICES=services; renderServices(services); renderAppointments(appts); renderRecentMessages(recentMsgs); renderSimMessages(simMsgs); renderWhatsappReviews(reviews); renderPilotChecklist();
  setRefreshStatus();
}
function renderClientStatus(me){
  const claude = me.responder_mode==='claude';
  byId('responderMode').textContent=claude?'Guided + AI':'Guided booking';
  byId('responderModeNote').textContent=claude?'Optional Claude configured · unverified':'Works without an AI key';
  if(!byId('simModePill').dataset.resultMode) byId('simModePill').textContent=claude?'Claude configured':'Guided booking';
  byId('clientConnectionState').textContent=!me.wa_signature_configured?'Host setup needed':me.wa_connected?'Details saved':'Not configured';
  byId('waSignatureStatus').textContent=me.wa_signature_configured?'Webhook signature verification is configured on the host. A real delivery test is still required.':'Blocked: the deployment owner must configure META_APP_SECRET securely on the host before WhatsApp webhook replies can work.';
  renderWhatsappConnection(me); renderPhotoSettings(me);
}
function renderPilotChecklist(){
  if(!CURRENT_CLIENT) return;
  const me=CURRENT_CLIENT, hours=parseClientHours(me.hours);
  const hasHours=HOUR_DAYS.every(([key])=>validHoursValue(hours[key])) && HOUR_DAYS.some(([key])=>hours[key]!=='closed');
  const delivered=me.wa_last_delivery && ['delivered','read'].includes(me.wa_last_delivery.delivery_status);
  const items=[
    [CURRENT_SERVICES.length>0, CURRENT_SERVICES.length>0?'Services loaded. Review names, prices and durations.':'Add at least one service with a price and duration.'],
    [hasHours,hasHours?'Opening hours saved. Check they match the salon.':'Set valid opening hours, with at least one open day.'],
    [!!me.whatsapp_enabled,me.whatsapp_enabled?'Receptionist enabled in saved settings.':'Receptionist is paused. Enable and save before the real test.'],
    [!!me.wa_signature_configured,me.wa_signature_configured?'Host webhook signature verification configured.':'Launch blocked: ask the deployment owner to configure the Meta App Secret securely.'],
    [!!me.wa_connected,me.wa_connected?'Meta connection details saved. This does not prove the number works.':'Save the Meta Phone Number ID and access token securely.'],
    [!!delivered,delivered?'Last outgoing reply was delivered/read. Verify the booking flow too.':'Run an end-to-end WhatsApp test and verify the reply is delivered/read.'],
  ];
  if(Number(me.wa_pending_reviews)>0) items.push([false,`${Number(me.wa_pending_reviews)} interrupted or uncertain WhatsApp request(s) need manual review. Check the Message review queue below and confirm booking status before replying to customers.`]);
  byId('pilotChecklist').innerHTML=items.map(([ok,text])=>`<li><span aria-label="${ok?'Checked':'Needs attention'}">${ok?'✓':'!'}</span> ${esc(text)}</li>`).join('');
}
function updateWaStatusUI(on){
  byId('waStatusCard').classList.toggle('off',!on);
  byId('waStatusText').textContent=on?'Receptionist enabled in settings':'Receptionist paused in settings';
  if(CURRENT_CLIENT && on!==!!CURRENT_CLIENT.whatsapp_enabled) byId('waStatusText').textContent += ' · unsaved';
}
function toggleWhatsapp(){ updateWaStatusUI(byId('waToggle').checked); }
async function saveWaSettings(){
  const settings={whatsappEnabled:byId('waToggle').checked,greeting:byId('waGreeting').value};
  await runAction('settings',[byId('saveWaButton'),byId('waToggle'),byId('waGreeting'),byId('saveHoursButton')],async()=>{
    await api('PATCH','/api/client/settings',settings);
    CURRENT_CLIENT={...CURRENT_CLIENT,whatsapp_enabled:settings.whatsappEnabled,greeting:settings.greeting};
    updateWaStatusUI(settings.whatsappEnabled); renderPilotChecklist(); toast('Receptionist settings saved.');
  });
}
function setRefreshStatus(message){ byId('clientRefreshStatus').textContent=message||'Last refreshed '+new Date().toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Johannesburg'})+' SAST · refreshes every 30 seconds while this dashboard is visible'; }
async function refreshClientData(manual){
  if(!CURRENT_CLIENT || ACTIVE_VIEW!=='client') return;
  const generation=clientGeneration;
  await runAction('client-refresh',[byId('refreshClientButton')],async()=>{
    const [me,appts,msgs,reviews]=await Promise.all([api('GET','/api/client/me'),api('GET','/api/client/appointments'),api('GET','/api/client/recent-messages'),api('GET','/api/client/whatsapp-reviews')]);
    if(generation!==clientGeneration || ACTIVE_VIEW!=='client') return;
    CURRENT_CLIENT=me; renderClientStatus(me); renderAppointments(appts); renderRecentMessages(msgs); renderWhatsappReviews(reviews); renderPilotChecklist(); updateWaStatusUI(byId('waToggle').checked); setRefreshStatus();
    if(manual) toast('Appointments and WhatsApp status refreshed.');
  },err=>{
    if(generation!==clientGeneration) return;
    setRefreshStatus(errorMessage(err,'Refresh failed. Showing the last loaded data; try Refresh again.'));
    if(err.status===401){ clearInterval(refreshTimer); CURRENT_CLIENT=null; byId('client-dash').hidden=true; byId('client-login').hidden=false; }
    if(manual) toast(errorMessage(err));
  });
}

/* ---- appointments & real messages ---- */
function appointmentDate(iso){ return new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(iso) ? iso : iso+'+02:00'); }
function renderAppointments(appts){
  // Older releases used simulator markers for both practice and real WhatsApp
  // bookings. Preserve every record; only a human can resolve that ambiguity.
  byId('clientBookingCount').textContent=String(appts.length)+(appts.length===50?'+':'');
  byId('apptList').innerHTML=appts.length?appts.map(a=>{
    const legacy=['simulator','whatsapp-ai'].includes(a.source) || ['simulator','whatsapp-ai'].includes(a.customer_phone);
    const d=appointmentDate(a.starts_at), opts={timeZone:'Africa/Johannesburg'};
    const day=d.toLocaleDateString('en-ZA',{...opts,day:'numeric'}), mon=d.toLocaleDateString('en-ZA',{...opts,month:'short'}), time=d.toLocaleTimeString('en-ZA',{...opts,hour:'2-digit',minute:'2-digit'});
    return `<div class="appt-item"><div class="appt-date"><b>${day}</b><span>${mon}</span></div><div class="appt-details"><b>${esc(a.customer_name)} — ${esc(a.service_name)}</b><br><span class="status-note">${time} SAST · ${esc(a.duration_mins)} min · ${legacy?'Legacy booking · verify with customer':a.source==='whatsapp_ai'||a.source==='whatsapp'?'WhatsApp booking':'Salon booking'}</span>${a.customer_phone&&!['simulator','whatsapp-ai'].includes(a.customer_phone)?`<br><span class="status-note">${esc(a.customer_phone)}</span>`:''}${a.quote_kind==='photo_menu_estimate'?`<p class="status-note">Photo menu estimate: ${fmtZAR(a.price_at_booking)}. Check the required work and agree any price change with the customer before starting.</p>`:''}${legacy?'<p class="status-note" style="color:var(--warn)">This older record may be a real customer booking. Keep its slot blocked until you verify it; cancel only after review.</p>':''}</div><button class="mini-btn" onclick="cancelAppointment('${esc(a.id)}',this)">Cancel booking</button></div>`;
  }).join(''):'<p class="status-note">No upcoming bookings. New simulator tests do not create appointments or reserve slots.</p>';
}
async function cancelAppointment(id,button){
  if(PENDING.has('cancel-'+id)) return;
  if(!window.confirm('Cancel this appointment and release its time slot? This does not send a WhatsApp notification. Contact the customer separately.')) return;
  await runAction('cancel-'+id,[button],async()=>{ await api('POST','/api/client/appointments/'+encodeURIComponent(id)+'/cancel',{}); button.disabled=true; button.textContent='Cancelled'; await refreshClientData(false); toast('Booking cancelled. Notify the customer separately.'); },err=>toast(errorMessage(err,err.status===404?'This booking was not found. Refresh the appointment list.':'Could not cancel the booking. Refresh and try again.')));
}
function renderRecentMessages(msgs){
  const real=msgs.filter(m=>m.customer_phone!=='simulator');
  byId('msgList').innerHTML=real.length?real.map(m=>`<div class="msg-item"><div class="phone-avatar" style="background:var(--blush-500)">${esc((m.customer_name||'?').charAt(0))}</div><div><b>${esc(m.customer_name||'WhatsApp customer')}</b><br><span class="status-note">${esc(m.body)}</span><br><span class="status-note">${timeAgo(m.created_at)}</span></div></div>`).join(''):'<p class="status-note">No real WhatsApp messages yet. Simulator conversations stay in the test panel.</p>';
}
function timeAgo(iso){ const mins=Math.max(1,Math.round((Date.now()-new Date(iso).getTime())/60000)); if(mins<60)return mins+'m ago'; const hrs=Math.round(mins/60); return hrs<24?hrs+'h ago':Math.round(hrs/24)+'d ago'; }

/* ---- manual delivery review; never automatically resends ---- */
function renderWhatsappReviews(reviews){
  byId('waReviewList').innerHTML=reviews.length?reviews.map(item=>`<div style="padding:14px 0;border-top:1px solid var(--line)">
    <b>${esc(item.customer_name||'WhatsApp customer')}</b> <span class="status-note">${esc(item.customer_phone||'')} · ${fmtDate(item.created_at)}</span>
    <p class="status-note">Status: ${esc(item.state)}${item.error_code?' · '+esc(item.error_code):''}</p>
    ${item.appointment_id?`<p class="status-note" style="color:var(--warn)"><b>Appointment already saved:</b> ${esc(item.appointment_service)} · ${esc(item.appointment_starts_at)} · ${esc(item.appointment_status)}. Check this booking before any follow-up; marking reviewed does not cancel it.</p>`:''}
    <p class="status-note"><b>Incoming:</b> ${esc(item.incoming_body||'No message text available')}</p>
    ${item.reply_body?`<p class="status-note"><b>Attempted reply:</b> ${esc(item.reply_body)}</p>`:''}
    <button class="mini-btn" style="margin-top:10px" onclick="acknowledgeWhatsappReview('${esc(item.id)}',this)">Mark reviewed</button>
  </div>`).join(''):'<p class="status-note">No WhatsApp messages currently need manual delivery review.</p>';
}
async function acknowledgeWhatsappReview(id,button){
  if(PENDING.has('review-'+id))return;
  if(!window.confirm('I checked this message and handled any follow-up. Mark it reviewed? This does not resend a message or change an appointment.'))return;
  await runAction('review-'+id,[button],async()=>{
    await api('POST','/api/client/whatsapp-reviews/'+encodeURIComponent(id)+'/acknowledge',{});
    await refreshClientData(false);toast('Marked reviewed. No message was sent.');
  });
}

/* ---- opt-in photo estimates; host configuration is not a live test ---- */
function eligiblePhotoServices(){
  return CURRENT_SERVICES.filter(s=>!!s.photo_eligible && ['hair','nails','beauty'].includes(s.photo_category) && typeof s.photo_description==='string' && s.photo_description.trim().length>=10);
}
function renderPhotoSettings(me){
  if(!me) return;
  const toggle=byId('photoEstimatesToggle'), saved=!!me.photo_estimates_enabled;
  const hostReady=me.photo_estimates_status?.ready===true, catalogReady=eligiblePhotoServices().length>0;
  if(!PHOTO_SETTINGS_DIRTY && !PENDING.has('photo-settings')) toggle.checked=saved;
  const blocked=!hostReady || !catalogReady;
  toggle.disabled=PENDING.has('photo-settings') || (blocked && !saved);
  byId('savePhotoSettingsButton').disabled=PENDING.has('photo-settings') || !PHOTO_SETTINGS_DIRTY || (toggle.checked && blocked);
  let status, label;
  if(!hostReady){
    label='Host setup needed';
    status='Photo estimates cannot run: the image provider is not ready on the host. Ask the deployment owner to review privacy and provider settings before enabling.';
    if(me.photo_estimates_status?.reason) status+=' Host status: '+String(me.photo_estimates_status.reason)+'.';
  }else if(!catalogReady){
    label='No eligible services';
    status='Include at least one service with a category and a description of 10–400 characters in Photo settings above. Save that service before enabling photo estimates.';
  }else if(saved){
    label='Enabled · unverified';
    status='Photo estimates are enabled in saved salon settings. The provider is configured and '+eligiblePhotoServices().length+' service(s) are eligible. Privacy review and a real end-to-end WhatsApp photo test are still required before launch.';
  }else{
    label='Off in saved settings';
    status='The provider is configured and '+eligiblePhotoServices().length+' service(s) are eligible. Photo estimates remain off until you enable and save this separate setting. Configuration is not a live test.';
  }
  if(blocked && saved) status+=' This salon is still enabled in saved settings; you can switch it off and save.';
  if(PHOTO_SETTINGS_DIRTY) status+=' Unsaved change: photo estimates will be '+(toggle.checked?'enabled':'disabled')+' only after saving.';
  byId('photoEstimatesPill').textContent=label;
  byId('photoEstimatesStatus').textContent=status;
}
function togglePhotoEstimates(){
  PHOTO_SETTINGS_DIRTY=byId('photoEstimatesToggle').checked!==!!CURRENT_CLIENT?.photo_estimates_enabled;
  byId('photoSettingsFeedback').textContent=''; renderPhotoSettings(CURRENT_CLIENT);
}
async function savePhotoSettings(){
  if(!CURRENT_CLIENT || PENDING.has('photo-settings')) return;
  const enabled=byId('photoEstimatesToggle').checked, feedback=byId('photoSettingsFeedback'), generation=clientGeneration;
  if(enabled && CURRENT_CLIENT.photo_estimates_status?.ready!==true){ feedback.textContent='Photo estimates cannot be enabled until the deployment owner configures the image provider and privacy settings on the host.'; return; }
  if(enabled && !eligiblePhotoServices().length){ feedback.textContent='Save at least one eligible service with its photo category and a description of the included work first.'; return; }
  if(enabled===!!CURRENT_CLIENT.photo_estimates_enabled){ PHOTO_SETTINGS_DIRTY=false; renderPhotoSettings(CURRENT_CLIENT); return; }
  feedback.textContent='';
  await runAction('photo-settings',[byId('savePhotoSettingsButton'),byId('photoEstimatesToggle')],async()=>{
    await api('PATCH','/api/client/settings',{photoEstimatesEnabled:enabled});
    if(generation!==clientGeneration || !CURRENT_CLIENT) return;
    CURRENT_CLIENT={...CURRENT_CLIENT,photo_estimates_enabled:enabled}; PHOTO_SETTINGS_DIRTY=false;
    feedback.textContent=enabled?'Photo estimates enabled in saved settings. Complete privacy review and a real WhatsApp photo test before launch.':'Photo estimates disabled in saved settings.';
    renderPilotChecklist();
  },err=>{ if(generation===clientGeneration) feedback.textContent=errorMessage(err,({photo_host_not_ready:'The host is not ready. Ask the deployment owner to check the image provider and privacy configuration.',photo_catalog_required:'No eligible photo services are saved. Add a category and a clear description to at least one service first.'})[err.message]||'Could not save the photo setting. Your change is still unsaved; check your connection and retry.'); });
  if(generation===clientGeneration) renderPhotoSettings(CURRENT_CLIENT);
}

/* ---- services ---- */
function renderServices(services){
  // Preserve other services' unsaved photo edits when the menu is refreshed.
  const drafts=new Map();
  CURRENT_SERVICES.forEach(s=>{
    const form=byId('photoServiceForm-'+s.id), details=byId('photoDetails-'+s.id);
    if(form?.elements && form.dataset.dirty==='true') drafts.set(s.id,{photoEligible:form.elements.namedItem('photoEligible').checked,photoCategory:form.elements.namedItem('photoCategory').value,photoDescription:form.elements.namedItem('photoDescription').value,open:!!details?.open});
  });
  CURRENT_SERVICES=services;
  byId('servicesList').innerHTML=services.length?services.map(s=>`<div class="service-photo">
    <div class="mock-row" style="gap:12px"><span><b>${esc(s.name)}</b> — ${fmtZAR(s.price)} · ${esc(s.duration_mins)} min</span><button id="removeService-${esc(s.id)}" class="mini-btn" onclick="deleteService('${esc(s.id)}',this)">Remove</button></div>
    <details id="photoDetails-${esc(s.id)}"><summary>Photo settings <span class="photo-state" id="photoServiceState-${esc(s.id)}">· ${s.photo_eligible?'Included in photo catalog':'Excluded from photo catalog'}</span></summary>
      <form id="photoServiceForm-${esc(s.id)}" data-service-id="${esc(s.id)}" onsubmit="saveServicePhoto(event);return false" oninput="markServicePhotoDraft(this)">
        <div class="photo-option"><input type="checkbox" id="photoEligible-${esc(s.id)}" name="photoEligible" ${s.photo_eligible?'checked':''} aria-describedby="photoCatalogHelp photoPrice-${esc(s.id)}"><label for="photoEligible-${esc(s.id)}">Include ${esc(s.name)} in automated photo matching</label></div>
        <p id="photoPrice-${esc(s.id)}" class="panel-note">Saved menu estimate: ${fmtZAR(s.price)} · ${esc(s.duration_mins)} minutes. This form edits photo eligibility only. Never promise additional work or combine menu prices from a photo.</p>
        <div class="field"><label for="photoCategory-${esc(s.id)}">Photo category</label><select id="photoCategory-${esc(s.id)}" name="photoCategory" ${s.photo_eligible?'required':''}><option value="">Choose a category</option>${[['hair','Hair'],['nails','Nails'],['beauty','Beauty (non-medical)']].map(([value,label])=>`<option value="${value}" ${s.photo_category===value?'selected':''}>${label}</option>`).join('')}</select></div>
        <div class="field"><label for="photoDescription-${esc(s.id)}">Included work and price boundaries</label><textarea id="photoDescription-${esc(s.id)}" name="photoDescription" rows="3" maxlength="400" ${s.photo_eligible?'required minlength="10"':''} aria-describedby="photoCatalogHelp photoDescriptionHelp-${esc(s.id)}" placeholder="Describe the result, included work and limits covered by this saved price.">${esc(s.photo_description||'')}</textarea><p id="photoDescriptionHelp-${esc(s.id)}" class="status-note">10–400 characters when included. Describe a reference style this service covers, what is excluded, and when a consultation is needed. Do not include medical or health services.</p></div>
        <button class="mini-btn" type="submit">Save photo settings for ${esc(s.name)}</button><p id="photoServiceFeedback-${esc(s.id)}" class="form-feedback" role="status"></p>
      </form>
    </details>
  </div>`).join(''):'<p class="status-note">Add your first service so the receptionist can quote prices and offer bookings.</p>';
  drafts.forEach((draft,id)=>{
    if(!services.some(s=>s.id===id)) return;
    const form=byId('photoServiceForm-'+id);
    if(!form?.elements) return;
    form.elements.namedItem('photoEligible').checked=draft.photoEligible;
    form.elements.namedItem('photoCategory').value=draft.photoCategory;
    form.elements.namedItem('photoDescription').value=draft.photoDescription;
    byId('photoDetails-'+id).open=draft.open; markServicePhotoDraft(form);
  });
  renderPilotChecklist(); renderPhotoSettings(CURRENT_CLIENT);
}
function markServicePhotoDraft(form){
  form.dataset.dirty='true';
  const enabled=form.elements.namedItem('photoEligible').checked;
  form.elements.namedItem('photoCategory').required=enabled;
  form.elements.namedItem('photoDescription').required=enabled;
  form.elements.namedItem('photoDescription').minLength=enabled?10:0;
  byId('photoServiceFeedback-'+form.dataset.serviceId).textContent='Unsaved photo settings';
}
async function saveServicePhoto(e){
  e.preventDefault();
  const form=e.target, id=form.dataset.serviceId, generation=clientGeneration;
  if(!CURRENT_CLIENT || PENDING.has('service-'+id)) return false;
  const photoEligible=form.elements.namedItem('photoEligible').checked;
  const photoCategory=fieldValue(form,'photoCategory'), photoDescription=fieldValue(form,'photoDescription');
  const feedback=byId('photoServiceFeedback-'+id);
  if((photoEligible && !['hair','nails','beauty'].includes(photoCategory)) || (photoCategory && !['hair','nails','beauty'].includes(photoCategory))){ feedback.textContent='Choose Hair, Nails or Beauty (non-medical) before including this service.'; form.elements.namedItem('photoCategory').focus(); return false; }
  if(photoDescription.length>400 || (photoEligible && photoDescription.length<10)){ feedback.textContent='Describe the included work and price boundaries in 10–400 characters before including this service.'; form.elements.namedItem('photoDescription').focus(); return false; }
  feedback.textContent='';
  await runAction('service-'+id,[...formControls(form),byId('removeService-'+id)],async()=>{
    await api('PATCH','/api/client/services/'+encodeURIComponent(id)+'/photo-settings',{photoEligible,photoCategory:photoCategory||null,photoDescription});
    if(generation!==clientGeneration || !CURRENT_CLIENT) return;
    CURRENT_SERVICES=CURRENT_SERVICES.map(s=>s.id===id?{...s,photo_eligible:photoEligible?1:0,photo_category:photoCategory||null,photo_description:photoDescription}:s);
    form.dataset.dirty='false';
    byId('photoServiceState-'+id).textContent='· '+(photoEligible?'Included in photo catalog':'Excluded from photo catalog');
    feedback.textContent=photoEligible?'Photo settings saved. This service is eligible; the separate salon photo setting must also be enabled.':'Photo settings saved. This service is excluded from automated photo matching.';
    renderPhotoSettings(CURRENT_CLIENT); renderPilotChecklist();
  },err=>{ if(generation===clientGeneration) feedback.textContent=errorMessage(err,err.status===404?'This service no longer exists. Reopen the dashboard to refresh the menu.':'Could not save these photo settings. Your edits are still here; check the category and description and retry.'); });
  return false;
}
async function addService(){
  const name=byId('svcName').value.trim(), price=byId('svcPrice').value, durationMins=byId('svcDuration').value;
  if(!name || price==='' || !Number.isInteger(Number(price)) || Number(price)<0 || Number(price)>100000){ toast('Enter a service name and a whole-Rand price from R0 to R100,000.'); return; }
  if(durationMins==='' || !Number.isInteger(Number(durationMins)) || Number(durationMins)<5 || Number(durationMins)>720){ toast('Enter a duration from 5 to 720 minutes, using a whole number.'); return; }
  await runAction('add-service',[byId('addServiceButton'),byId('svcName'),byId('svcPrice'),byId('svcDuration')],async()=>{
    await api('POST','/api/client/services',{name,price:Number(price),durationMins:Number(durationMins)});
    byId('svcName').value='';byId('svcPrice').value='';byId('svcDuration').value='';
    try{renderServices(await api('GET','/api/client/services'));toast('Service added.');}catch(err){toast('Service saved, but the list could not refresh. Reopen the dashboard before adding it again.');}
  },err=>toast(errorMessage(err,err.message==='duplicate_service'?'That service name is already in your list.':'Could not add the service. Check its name, price and duration.')));
}
async function deleteService(id,button){
  if(PENDING.has('service-'+id)) return;
  if(!window.confirm('Remove this service from new bookings? Existing appointments will remain.')) return;
  await runAction('service-'+id,[button],async()=>{ await api('DELETE','/api/client/services/'+encodeURIComponent(id)); try{renderServices(await api('GET','/api/client/services'));toast('Service removed from new bookings.');}catch(err){toast('Service removed. Reopen the dashboard to refresh the list.');} });
}

/* ---- business hours ---- */
const HOUR_DAYS=[['mon','Monday'],['tue','Tuesday'],['wed','Wednesday'],['thu','Thursday'],['fri','Friday'],['sat','Saturday'],['sun','Sunday']];
function validHoursValue(value){
  if(value==='closed') return true;
  if(typeof value!=='string' || !/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(value)) return false;
  const [open,close]=value.split('-'); return close>open;
}
function renderHoursForm(hours){ byId('hoursForm').innerHTML=HOUR_DAYS.map(([key,label])=>`<div class="field"><label for="hours_${key}">${label}</label><input id="hours_${key}" aria-describedby="hoursError" placeholder="09:00-18:00 or closed" value="${esc(hours[key]||'closed')}"></div>`).join(''); }
async function saveHours(){
  const hours={};let invalid=null;
  HOUR_DAYS.forEach(([key,label])=>{ const input=byId('hours_'+key); hours[key]=input.value.trim().toLowerCase(); const valid=validHoursValue(hours[key]); input.setAttribute('aria-invalid',String(!valid)); if(!valid&&!invalid)invalid=[key,label]; });
  if(invalid){ byId('hoursError').textContent=`${invalid[1]}: enter closed or a 24-hour range such as 09:00-18:00, with closing after opening.`; byId('hours_'+invalid[0]).focus(); return; }
  byId('hoursError').textContent='';
  await runAction('settings',[byId('saveHoursButton'),byId('saveWaButton'),...HOUR_DAYS.map(([key])=>byId('hours_'+key))],async()=>{
    await api('PATCH','/api/client/settings',{hours});
    CURRENT_HOURS=hours;CURRENT_CLIENT={...CURRENT_CLIENT,hours};renderPilotChecklist();toast('Business hours saved in South Africa time.');
  },err=>{ byId('hoursError').textContent=errorMessage(err,'Could not save hours. Use a valid range or closed for all seven days.'); });
}

/* ---- secure account settings ---- */
async function changeClientPassword(e){
  e.preventDefault(); const form=e.target, currentPassword=byId('currentPassword').value, newPassword=byId('newPassword').value;
  const feedback=byId('passwordFeedback'); feedback.style.color='var(--crit)';
  if(newPassword!==byId('confirmPassword').value){ feedback.textContent='The new passwords do not match.'; return false; }
  if(Array.from(newPassword).length<12 || new TextEncoder().encode(newPassword).length>72){ feedback.textContent='Use at least 12 characters and at most 72 UTF-8 bytes (some characters use several bytes).'; return false; }
  if(currentPassword===newPassword){ feedback.textContent='Choose a new password different from your current one.'; return false; }
  feedback.textContent='';
  await runAction('password',formControls(form),async()=>{
    await api('PATCH','/api/client/password',{currentPassword,newPassword}); form.reset(); feedback.style.color='var(--good)'; feedback.textContent='Password changed. Use your new password next time you log in.';
  },err=>{ feedback.style.color='var(--crit)'; feedback.textContent=errorMessage(err,({invalid_current_password:'Current password not recognised.',weak_password:'Use at least 12 characters and at most 72 UTF-8 bytes.',unchanged_password:'Choose a password different from your current one.'})[err.message]||'Could not change your password. Please retry.'); });
  return false;
}

/* ---- WhatsApp connection ---- */
function protectWhatsappInputs(){ byId('waPhoneNumberId').setAttribute('autocomplete','off');byId('waPhoneNumberId').setAttribute('inputmode','numeric');byId('waAccessToken').setAttribute('autocomplete','new-password');byId('waAccessToken').setAttribute('type','password'); }
function renderWhatsappConnection(me){
  protectWhatsappInputs();const pill=byId('waConnectedPill'),last=me.wa_last_delivery;
  let label=me.wa_connected?'Saved · delivery unverified':'Not configured',good=false;
  if(me.wa_connected&&last){
    const labels={pending:'Reply sending',accepted:'Reply accepted · awaiting delivery',sent:'Reply sent · awaiting delivery',delivered:'Last reply delivered',read:'Last reply read',unknown:'Reply delivery unknown',failed:'Reply failed'};
    label=labels[last.delivery_status]||label;if(last.delivery_error_code)label+=' ('+last.delivery_error_code+')';good=['delivered','read'].includes(last.delivery_status);
  }
  pill.textContent=label;pill.style.background=good?'var(--good-bg)':'var(--warn-bg)';pill.style.color=good?'var(--good)':'var(--warn)';
}
async function saveWhatsappConnection(){
  const idInput=byId('waPhoneNumberId'),tokenInput=byId('waAccessToken'),phoneNumberId=idInput.value.trim(),accessToken=tokenInput.value.trim();
  if(!phoneNumberId&&!accessToken){toast('Enter connection details to update. Blank fields keep saved values.');return;}
  if(phoneNumberId&&!/^\d{1,32}$/.test(phoneNumberId)){toast('Use the numeric Meta Phone Number ID, not an email or display phone number.');return;}
  if(accessToken&&(accessToken.length<20||accessToken.length>4096||/[\s@]/.test(accessToken))){toast('Use your Meta access token, not your login password.');return;}
  await runAction('connection',[byId('saveConnectionButton'),idInput,tokenInput],async()=>{
    await api('PATCH','/api/client/whatsapp-connection',{phoneNumberId,accessToken});tokenInput.value='';idInput.value='';
    await refreshClientData(false);toast('Connection details saved. Test a real reply to verify delivery.');
  },err=>toast(errorMessage(err,({invalid_phone_number_id:'Enter the numeric Meta Phone Number ID.',invalid_access_token:'Enter a valid-format Meta access token.',no_connection_changes:'Enter new details; saved values are unchanged.'})[err.message]||'Could not save the connection. Please try again.')));
}

/* ---- isolated simulator ---- */
function renderSimMessages(msgs){
  const body=byId('simBody');
  body.innerHTML=msgs.length?msgs.map(m=>`<div class="bubble ${m.direction==='in'?'in':'out'}">${esc(m.body)}<time>${new Date(m.created_at).toLocaleTimeString('en-ZA',{hour:'2-digit',minute:'2-digit',timeZone:'Africa/Johannesburg'})}</time></div>`).join(''):'<p style="color:#666;font-size:.8rem;text-align:center;margin-top:20px">Ask about services, prices or hours. This is a test conversation only.</p>';
  body.scrollTop=body.scrollHeight;
}
async function sendSimMessage(){
  if(PENDING.has('simulator'))return;
  const input=byId('simInput'),message=input.value.trim();if(!message)return;
  const generation=clientGeneration;
  await runAction('simulator',[input,byId('simSendButton'),byId('simResetButton')],async()=>{
    const result=await api('POST','/api/whatsapp/simulate',{message});
    if(generation!==clientGeneration)return;
    input.value='';byId('simModePill').dataset.resultMode=result.mode||'rules';byId('simModePill').textContent=result.mode==='claude'?'Claude AI':['rules_fallback','mock_fallback','guided_fallback'].includes(result.mode)?'Guided · AI fallback':result.mode==='error'?'Reply error':'Guided booking';
    renderSimMessages(await api('GET','/api/client/simulator/messages'));
  },err=>toast(errorMessage(err,'The simulator request failed. Refresh the dashboard before retrying if you are unsure whether it sent.')));
  if(!input.disabled && generation===clientGeneration && ACTIVE_VIEW==='client')input.focus();
}
async function resetSimulator(){
  if(PENDING.has('simulator'))return;
  if(!window.confirm('Clear this test conversation? Real appointments and WhatsApp messages are unchanged.'))return;
  await runAction('simulator',[byId('simInput'),byId('simSendButton'),byId('simResetButton')],async()=>{await api('POST','/api/client/simulator/reset');delete byId('simModePill').dataset.resultMode;renderClientStatus(CURRENT_CLIENT);renderSimMessages([]);byId('simInput').value='';toast('Test conversation reset.');});
}

/* ============ CHARTS ============ */
function drawBars(containerId,entries){
  const max=Math.max(...entries.map(e=>e[1]),1);
  byId(containerId).innerHTML='<div style="display:flex;flex-direction:column;gap:12px;padding-top:4px">'+entries.map(([label,val])=>`<div><div style="display:flex;justify-content:space-between;font-size:.82rem;margin-bottom:5px"><span>${esc(label)}</span><b>${val}</b></div><div style="background:var(--line);border-radius:999px;height:10px;overflow:hidden"><div style="width:${Math.max(val/max*100,val>0?6:0)}%;background:linear-gradient(90deg,var(--gold-400),var(--gold-600));height:100%;border-radius:999px"></div></div></div>`).join('')+'</div>';
}

/* ============ INIT ============ */
document.querySelectorAll('.field').forEach((field,index)=>{const label=field.querySelector('label'),input=field.querySelector('input,textarea,select');if(label&&input){if(!input.id)input.id='field-'+index;label.htmlFor=input.id;}});
protectWhatsappInputs();
go(viewForHash(),true);
