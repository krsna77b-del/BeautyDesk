const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-modular-whatsapp-'));
process.env.DB_PATH = path.join(dir, 'test.sqlite');
process.env.JWT_SECRET = 'modular-whatsapp-test-secret-not-for-production';
delete process.env.ANTHROPIC_API_KEY;
const db = require('../db');
const salon = require('../modules/salon');
const ai = require('../ai');
const now = new Date('2031-10-01T07:00:00Z');
const phone = '27821234567';
let client, services;
function reload() {
  client = db.prepare("SELECT * FROM clients WHERE id='salon'").get();
  services = db.prepare("SELECT * FROM services WHERE client_id='salon' ORDER BY name").all();
}
beforeEach(() => {
  delete process.env.PUBLIC_BASE_URL;
  for (const table of ['notification_outbox','appointment_events','booking_requests','booking_quotes','payments','subscriptions','staff_time_off','staff_services','staff','customers','salon_settings','photo_sessions','photo_uploads','messages','appointments','services','clients']) db.prepare(`DELETE FROM ${table}`).run();
  db.prepare("INSERT INTO clients(id,salon,owner,email,password_hash,phone,created_at,hours) VALUES('salon','Test Salon','Owner','owner@example.test','unused','27820009999',?,?)").run(now.toISOString(),db.DEFAULT_HOURS);
  db.prepare("INSERT INTO services(id,client_id,name,price,duration_mins,created_at,deposit_amount) VALUES('braids','salon','Braids',350,90,?,100),('nails','salon','Gel Nails',250,60,?,0)").run(now.toISOString(),now.toISOString());
  salon.ensureSalon('salon');
  db.prepare("DELETE FROM staff_services WHERE client_id='salon'").run();
  db.prepare("DELETE FROM staff WHERE client_id='salon'").run();
  for (const [id,name] of [['tumi','Tumi'],['rina','Rina'],['nails-only','Nandi']]) db.prepare("INSERT INTO staff(id,client_id,name,hours,created_at) VALUES(?,'salon',?,?,?)").run(id,name,db.DEFAULT_HOURS,now.toISOString());
  for (const [staffId,serviceId] of [['tumi','braids'],['rina','braids'],['nails-only','nails']]) db.prepare("INSERT INTO staff_services(client_id,staff_id,service_id) VALUES('salon',?,?)").run(staffId,serviceId);
  reload();
});
after(() => { db.close(); fs.rmSync(dir,{recursive:true,force:true}); });
const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
function book(extra={}) {
  return ai.bookAppointment('salon',{customerName:'Lerato',customerPhone:phone,serviceName:'Braids',durationMins:90,dateStr:'2031-10-02',time:'10:00',staffId:'tumi',expectedPrice:350,expectedDeposit:100,incomingMessageId:crypto.randomUUID(),now,...extra});
}
function chat(extra={}) {
  const history=[];
  let tick=0;
  const send=async (incomingMessage,overrides={}) => {
    reload();
    const at=new Date(now.getTime()+(++tick)*2000), prior=history.at(-1);
    const result=await ai.generateReply({client,services,history,incomingMessage,customerPhone:phone,incomingMessageId:crypto.randomUUID(),confirmationMessageId:prior?.direction==='out'?prior.id:null,now:at,...extra,...overrides});
    history.push({id:crypto.randomUUID(),direction:'in',body:incomingMessage,created_at:at.toISOString()},{id:crypto.randomUUID(),direction:'out',body:result.text,created_at:at.toISOString(),accepted_at:at.toISOString()});
    return result.text;
  };
  send.history=history;
  return send;
}

test('front door and numbered service selection expose only qualified technicians',async()=>{
  const send=chat();
  assert.match(await send('Hi'),/Book Appointment[\s\S]*View Services[\s\S]*My Appointment[\s\S]*Contact Salon/);
  assert.match(await send('1'),/^Which service/);
  const reply=await send('1');
  assert.match(reply,/Which technician.*Braids[\s\S]*Rina[\s\S]*Tumi[\s\S]*Any qualified technician/);
  assert.doesNotMatch(reply,/Nandi/);
  assert.equal(count('appointments'),0);
});
test('full staff booking keeps chosen technician, deposit and explicit accepted-summary confirmation',async()=>{
  const send=chat();
  await send('Book Appointment'); await send('Braids');
  assert.match(await send('Tumi'),/What day/);
  assert.match(await send('tomorrow'),/Available times/);
  assert.match(await send('10:00'),/What name/);
  assert.match(await send('Lerato'),/Please confirm[\s\S]*Technician: Tumi[\s\S]*Name: Lerato[\s\S]*Deposit: R100/);
  assert.equal(count('appointments'),0);
  const reply=await send('YES');
  assert.match(reply,/You're booked!.*with Tumi.*Deposit due: R100/);
  const row=db.prepare('SELECT * FROM appointments').get();
  assert.equal(row.staff_id,'tumi'); assert.equal(row.service_id,'braids'); assert.equal(row.deposit_amount,100);
  assert.equal(db.prepare('SELECT name FROM customers WHERE id=?').get(row.customer_id).name,'Lerato');
  assert.equal(count('appointment_events'),1);
  assert.equal(await send('YES'),reply);
  assert.equal(count('appointments'),1); assert.equal(count('appointment_events'),1);
});
test('one-message booking still asks technician unless explicitly chosen',async()=>{
  assert.match(await chat({customerName:'Lerato'})('Braids tomorrow at 10am'),/Which technician/);
  assert.match(await chat({customerName:'Lerato'})('Braids with Tumi tomorrow at 10am'),/Please confirm[\s\S]*Technician: Tumi/);
  assert.equal(count('appointments'),0);
});
test('any qualified technician selects an actual free technician before confirmation',async()=>{
  assert.equal(book({staffId:'rina',customerPhone:'27820000001'}).ok,true);
  const send=chat({customerName:'Lerato'});
  await send('Braids tomorrow at 10am');
  assert.match(await send('any'),/Please confirm[\s\S]*Technician: Tumi/);
  assert.match(await send('yes'),/You're booked!.*with Tumi/);
  assert.equal(count('appointments'),2);
});
test('same time may book different qualified staff, never overlap the same technician',()=>{
  assert.equal(book().ok,true);
  assert.equal(book({staffId:'rina',customerPhone:'27820000001'}).ok,true);
  assert.equal(book({customerPhone:'27820000002'}).reason,'slot_taken');
  assert.equal(count('appointments'),2);
});
test('staff breaks, time off and qualifications are enforced in offered slots and final booking',async()=>{
  db.prepare("UPDATE staff SET breaks=? WHERE id='tumi'").run(JSON.stringify([{day:'thu',start:'10:00',end:'11:00'}]));
  db.prepare("INSERT INTO staff_time_off VALUES('leave','salon','rina',?,?,?)").run('2031-10-02T08:00:00Z','2031-10-02T10:00:00Z','Time off');
  assert.equal(book().reason,'slot_taken');
  assert.equal(book({staffId:'rina'}).reason,'slot_taken');
  assert.equal(book({staffId:'nails-only'}).reason,'no_qualified_staff');
  const send=chat({customerName:'Lerato'}); await send('Braids with Tumi');
  const reply=await send('tomorrow');
  assert.match(reply,/Available times/); assert.doesNotMatch(reply,/10:00|10:15|10:30|10:45/);
});
test('a selected technician becoming busy cannot silently switch to another technician on YES',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  book({customerPhone:'27820000001'});
  assert.match(await send('yes'),/no longer available/);
  assert.equal(count('appointments'),1);
});
test('qualification removed after summary requires selection again and cannot book',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  db.prepare("DELETE FROM staff_services WHERE staff_id='tumi'").run();
  assert.match(await send('yes'),/Which technician/);
  assert.equal(count('appointments'),0);
});
test('changing service clears an incompatible technician selection',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  assert.match(await send('Change service to Gel Nails'),/Which technician.*Gel Nails[\s\S]*Nandi/);
  assert.equal(count('appointments'),0);
});
test('deposit changed after summary requires a new summary and explicit confirmation',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  db.prepare("UPDATE services SET deposit_amount=150 WHERE id='braids'").run();
  assert.match(await send('yes'),/Please confirm[\s\S]*Deposit: R150/);
  assert.equal(count('appointments'),0);
  assert.match(await send('yes'),/You're booked/);
  assert.equal(db.prepare('SELECT deposit_amount FROM appointments').get().deposit_amount,150);
});
test('transaction checks current deposit and technician name even for stale caller snapshots',()=>{
  assert.equal(book({expectedDeposit:50}).reason,'deposit_changed');
  assert.equal(book({expectedStaffName:'Old Name'}).reason,'staff_changed');
  assert.equal(count('appointments'),0);
});
test('origin replay preserves selected staff and deposit with no duplicated events',()=>{
  const first=book({incomingMessageId:'one-yes'}), events=count('appointment_events'), notifications=count('notification_outbox');
  assert.equal(first.ok,true);
  const repeat=book({incomingMessageId:'one-yes'});
  assert.equal(repeat.id,first.id); assert.equal(repeat.alreadyBooked,true);
  assert.equal(book({incomingMessageId:'one-yes',staffId:'rina'}).reason,'origin_already_used');
  assert.equal(book({incomingMessageId:'one-yes',expectedDeposit:0}).reason,'origin_already_used');
  assert.equal(count('appointment_events'),events); assert.equal(count('notification_outbox'),notifications);
});
test('same-second or mismatched acceptance context cannot confirm modular summary',async()=>{
  const send=chat({customerName:'Lerato'});
  const summary=await send('Braids with Tumi tomorrow at 10am');
  const acceptedAt=send.history.at(-1).accepted_at;
  assert.match(await send('yes',{messageAt:new Date(acceptedAt),receivedAt:new Date(acceptedAt)}),/Please confirm/);
  assert.equal(count('appointments'),0);
  assert.match(await send('yes',{confirmationMessageId:'not-the-summary'}),/Please confirm/);
  assert.equal(count('appointments'),0);
  assert.match(summary,/Technician: Tumi/);
});
test('informational detour cannot authorize a modular booking until summary is shown again',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  assert.match(await send('View Services'),/Here's what we offer/);
  assert.match(await send('yes'),/Please confirm/);
  assert.equal(count('appointments'),0);
});
test('modular simulator creates no appointments, customers, events or notifications',async()=>{
  const send=chat({customerPhone:'simulator',customerName:'Lerato',dryRun:true});
  assert.match(await send('Braids with Tumi tomorrow at 10am'),/Technician: Tumi[\s\S]*simulator/);
  assert.match(await send('yes'),/Preview complete/);
  for(const table of ['appointments','customers','appointment_events','notification_outbox']) assert.equal(count(table),0);
});
test('saved customer name is found only for this salon and verified sender',async()=>{
  salon.upsertCustomer('salon',{phone,name:'Saved Customer'});
  assert.match(await chat({customerName:'WhatsApp customer'})('Braids with Tumi tomorrow at 10am'),/Name: Saved Customer/);
  assert.match(await chat({customerPhone:'27820000001',customerName:'WhatsApp customer'})('Braids with Tumi tomorrow at 10am'),/What name/);
  assert.equal(count('appointments'),0);
});
test('My Appointment is sender scoped and offers verified private management links only when configured',async()=>{
  const first=book(); book({staffId:'rina',customerName:'Other Person',customerPhone:'27820000001'});
  const send=chat();
  const noLink=await send('My Appointment');
  assert.match(noLink,/Braids with Tumi/); assert.doesNotMatch(noLink,/Rina|Other Person|https:/);
  process.env.PUBLIC_BASE_URL='https://beautydesk.example.test';
  const reply=await send('My Appointment');
  const link=reply.match(/https:\/\/beautydesk\.example\.test\/manage\/(\S+)/);
  assert.ok(link); assert.equal(salon.fromToken(decodeURIComponent(link[1])).booking.id,first.id);
  assert.match(await send('cancel my appointment'),/private management link/);
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id=?').get(first.id).status,'confirmed');
});
test('unsafe or incomplete public base URL never becomes a management link',async()=>{
  book();
  for(const base of ['http://beautydesk.example.test','https://user:pass@beautydesk.example.test','https://beautydesk.example.test/?token=bad']){
    process.env.PUBLIC_BASE_URL=base;
    assert.doesNotMatch(await chat()('My Appointment'),/Manage this appointment:|user:pass|token=bad/);
  }
});
test('photo booking keeps consent snapshot checks and uses the same qualified staff availability',()=>{
  db.prepare("UPDATE clients SET photo_estimates_enabled=1 WHERE id='salon'").run();
  db.prepare("UPDATE services SET photo_eligible=1,photo_category='hair' WHERE id='braids'").run();
  reload(); const service=services.find(s=>s.id==='braids');
  db.prepare("INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at,consent_at,selected_json) VALUES('photo','salon',?,'source','booking',?,?,?)").run(phone,'2031-10-02T00:00:00Z',now.toISOString(),JSON.stringify(require('../photo-flow').snapshot(service)));
  assert.equal(book({staffId:'nails-only',photoSelection:{sessionId:'photo'}}).reason,'no_qualified_staff');
  assert.equal(book({photoSelection:{sessionId:'photo'}}).ok,true);
  assert.equal(db.prepare('SELECT quote_kind FROM appointments').get().quote_kind,'photo_menu_estimate');
  db.prepare("UPDATE photo_sessions SET consent_at=NULL WHERE id='photo'").run();
  assert.equal(book({staffId:'rina',time:'14:00',photoSelection:{sessionId:'photo'}}).reason,'service_changed');
  assert.equal(count('appointments'),1);
});
test('legacy salons remain on original one-capacity booking flow until initialized',async()=>{
  db.prepare("DELETE FROM subscriptions WHERE client_id='salon'").run();
  db.prepare("DELETE FROM salon_settings WHERE client_id='salon'").run();
  assert.equal(ai.modularSalon('salon'),null);
  const send=chat({customerName:'Lerato'});
  assert.match(await send('Braids tomorrow at 10am'),/Please confirm/);
  assert.doesNotMatch(send.history.at(-1).body,/Technician:|Deposit:/);
  assert.match(await send('yes'),/You're booked/);
  assert.equal(db.prepare('SELECT staff_id FROM appointments').get().staff_id,null);
});

test('technician corrections retain the service and require a new accepted summary',async()=>{
  const send=chat({customerName:'Lerato'});
  await send('Braids with Tumi tomorrow at 10am');
  assert.match(await send('Actually with Rina instead'),/Please confirm[\s\S]*Service: Braids[\s\S]*Technician: Rina/);
  assert.equal(count('appointments'),0);
  assert.match(await send('yes'),/You're booked!.*with Rina/);
  assert.equal(db.prepare('SELECT staff_id FROM appointments').get().staff_id,'rina');
});
test('numbered technician choices refer to the displayed roster even after roster changes',async()=>{
  const send=chat({customerName:'Lerato'});
  const prompt=await send('Braids tomorrow at 10am');
  assert.match(prompt,/2\. Tumi/);
  db.prepare("INSERT INTO staff(id,client_id,name,hours,created_at) VALUES('added','salon','Alice',?,?)").run(db.DEFAULT_HOURS,now.toISOString());
  db.prepare("INSERT INTO staff_services VALUES('salon','added','braids')").run();
  assert.match(await send('2'),/Technician: Tumi/);
  await send('yes');
  assert.equal(db.prepare('SELECT staff_id FROM appointments').get().staff_id,'tumi');
});
test('a replacement technician with the same name cannot reuse another technician accepted summary',async()=>{
  const send=chat({customerName:'Lerato'});
  const old=await send('Braids with Tumi tomorrow at 10am');
  assert.match(old,/Technician reference: tumi/);
  db.prepare("DELETE FROM staff_services WHERE staff_id='tumi'").run();
  db.prepare("DELETE FROM staff WHERE id='tumi'").run();
  db.prepare("INSERT INTO staff(id,client_id,name,hours,created_at) VALUES('replacement','salon','Tumi',?,?)").run(db.DEFAULT_HOURS,now.toISOString());
  db.prepare("INSERT INTO staff_services VALUES('salon','replacement','braids')").run();
  assert.match(await send('yes'),/Please confirm[\s\S]*Technician reference: replacement/);
  assert.equal(count('appointments'),0);
});
test('duplicate technician names require the displayed unique choice rather than ambiguous name matching',async()=>{
  db.prepare("UPDATE staff SET name='Tumi' WHERE id='rina'").run();
  const send=chat({customerName:'Lerato'});
  assert.match(await send('Braids tomorrow at 10am'),/Tumi \[rina\][\s\S]*Tumi \[tumi\]/);
  assert.match(await send('Tumi'),/Which technician/);
  assert.match(await send('2'),/Technician reference: tumi/);
  await send('yes');
  assert.equal(db.prepare('SELECT staff_id FROM appointments').get().staff_id,'tumi');
});
test('a fourth technician choice is not confused with the front door contact option',async()=>{
  for(const [id,name] of [['extra-a','Anna'],['extra-b','Bea']]){
    db.prepare("INSERT INTO staff(id,client_id,name,hours,created_at) VALUES(?,'salon',?,?,?)").run(id,name,db.DEFAULT_HOURS,now.toISOString());
    db.prepare("INSERT INTO staff_services VALUES('salon',?,'braids')").run(id);
  }
  const send=chat({customerName:'Lerato'});
  assert.match(await send('Braids tomorrow at 10am'),/4\. Tumi/);
  assert.match(await send('4'),/Please confirm[\s\S]*Technician: Tumi/);
});
test('separate SQLite connections serialize bookings for the same modular technician',async()=>{
  const {spawn}=require('node:child_process');
  const script=`const b=require('./booking'); const result=b.bookAppointment('salon',{customerName:'Concurrent',customerPhone:'27820000001',serviceName:'Braids',durationMins:90,dateStr:'2031-10-02',time:'10:00',staffId:'tumi',expectedDeposit:100,incomingMessageId:'concurrent-'+process.pid,now:'${now.toISOString()}'});process.stdout.write(JSON.stringify(result));require('./db').close();`;
  const run=()=>new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['-e',script],{cwd:path.resolve(__dirname,'..'),env:process.env}); let out='',err='';
    child.stdout.on('data',data=>out+=data); child.stderr.on('data',data=>err+=data); child.on('error',reject); child.on('close',code=>code===0?resolve(JSON.parse(out)):reject(Error(err)));
  });
  const results=await Promise.all([run(),run()]);
  assert.equal(results.filter(r=>r.ok).length,1); assert.equal(results.filter(r=>r.reason==='slot_taken').length,1);
  assert.equal(count('appointments'),1); assert.equal(count('appointment_events'),1);
});

test('photo-guided chat proceeds through staff selection and shares exact accepted summary booking',async()=>{
  const photo=require('../photo-flow'), originalFactory=photo.createPhotoFlow;
  photo.createPhotoFlow=()=>originalFactory({status:()=>({ready:true})});
  try {
    db.prepare("UPDATE clients SET photo_estimates_enabled=1 WHERE id='salon'").run();
    db.prepare("UPDATE services SET photo_eligible=1,photo_category='hair',photo_description='Shoulder-length braids from the approved salon menu' WHERE id='braids'").run();
    reload(); const service=services.find(s=>s.id==='braids');
    db.prepare("INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at,consent_at,selected_json,selection_message_id) VALUES('photo','salon',?,'source','booking',?,?,?,'selection')").run(phone,'2031-10-02T00:00:00Z',now.toISOString(),JSON.stringify(photo.snapshot(service)));
    let tick=0;
    async function send(body){
      const at=new Date(now.getTime()+(++tick)*3000), incomingId=tick===1?'selection':crypto.randomUUID();
      const history=db.prepare("SELECT * FROM messages WHERE client_id='salon' AND customer_phone=? ORDER BY rowid").all(phone);
      db.prepare("INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id) VALUES(?,'salon',?,'in',?,?,?)").run(crypto.randomUUID(),phone,body,at.toISOString(),incomingId);
      const result=await ai.generateReply({client,services,history,incomingMessage:body,customerPhone:phone,customerName:'Lerato',incomingMessageId:incomingId,confirmationMessageId:history.at(-1)?.id,now:at,messageAt:at,receivedAt:at});
      const outId=crypto.randomUUID();
      db.prepare("INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,accepted_at,delivery_status,photo_session_id) VALUES(?,'salon',?,'out',?,?,?,'accepted',?)").run(outId,phone,result.text,at.toISOString(),at.toISOString(),result.photoSessionId);
      photo.bindReply(result.photoSessionId,'salon',phone,outId);
      return result;
    }
    const selection=await send('BOOK 1'); assert.equal(selection.mode,'photo_guided'); assert.match(selection.text,/Which technician/);
    assert.match((await send('Tumi')).text,/What day/);
    assert.match((await send('tomorrow')).text,/Available times/);
    assert.match((await send('10:00')).text,/Please confirm[\s\S]*Technician: Tumi[\s\S]*Deposit: R100[\s\S]*Photo menu estimate only/);
    assert.equal(count('appointments'),0);
    assert.match((await send('YES')).text,/You're booked!.*with Tumi/);
    const row=db.prepare('SELECT * FROM appointments').get(); assert.equal(row.staff_id,'tumi'); assert.equal(row.photo_session_id,'photo');
  } finally { photo.createPhotoFlow=originalFactory; }
});

test('exact modular STOP, STOP REMINDERS and UNSUBSCRIBE opt out the recognized sender',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  for(const command of ['STOP','stop reminders','UNSUBSCRIBE!']){
    salon.setOptIn('salon',customer.id,true);
    const reply=await chat({customerPhone:'+'+phone})(command);
    assert.match(reply,/Reminders are off.*Existing appointments are unchanged/);
    const saved=db.prepare('SELECT * FROM customers WHERE id=?').get(customer.id);
    assert.equal(saved.whatsapp_opt_in,0); assert.ok(saved.opt_out_at);
  }
  assert.equal(count('appointments'),0);
});
test('reminder opt-out is tenant scoped even when another salon has the same phone',async()=>{
  const mine=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  db.prepare("INSERT INTO clients(id,salon,owner,email,password_hash,created_at,hours) VALUES('other','Other Salon','Other','other@example.test','unused',?,?)").run(now.toISOString(),db.DEFAULT_HOURS);
  const other=salon.upsertCustomer('other',{phone,name:'Private Other Customer',whatsappOptIn:true});
  const reply=await chat()('STOP REMINDERS');
  assert.doesNotMatch(reply,/Private Other/);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(mine.id).whatsapp_opt_in,0);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(other.id).whatsapp_opt_in,1);
});
test('dry-run reminder commands never mutate saved preferences or create customer records',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  for(const command of ['STOP','STOP REMINDERS','UNSUBSCRIBE','START REMINDERS']){
    assert.match(await chat({dryRun:true})(command),/Simulator preview[\s\S]*No reminder preferences or appointments were changed/);
    assert.match(await chat({customerPhone:'simulator'})(command),/Simulator preview/);
  }
  const saved=db.prepare('SELECT * FROM customers WHERE id=?').get(customer.id);
  assert.equal(saved.whatsapp_opt_in,1); assert.equal(saved.opt_out_at,null);
  assert.equal(count('customers'),1); assert.equal(count('appointments'),0);
});
test('opt-out blocks queued mock reminders without changing the existing appointment',async()=>{
  const result=book();
  const customer=db.prepare('SELECT * FROM customers WHERE phone=?').get(phone);
  salon.setOptIn('salon',customer.id,true);
  assert.ok(count('notification_outbox')>=1);
  assert.match(await chat()('UNSUBSCRIBE'),/Reminders are off/);
  salon.processMockNotifications(new Date('2031-10-02T07:30:00Z'));
  const notices=db.prepare('SELECT * FROM notification_outbox').all();
  assert.ok(notices.length); assert.ok(notices.every(n=>n.status==='blocked'&&n.reason==='opt_in_required'));
  assert.equal(db.prepare('SELECT status FROM appointments WHERE id=?').get(result.id).status,'confirmed');
});
test('only explicit START REMINDERS opts a recognized customer in, with truthful delivery qualification',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato'});
  const send=chat();
  await send('START');
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,0);
  const reply=await send('START REMINDERS');
  assert.match(reply,/preference is on[\s\S]*delivery still depends on the salon/);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,1);
  await send('stop talking please');
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,1);
});
test('unrecognized or unverified sender cannot create or alter reminder preferences',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  assert.match(await chat({customerPhone:'27820000001'})('STOP'),/No reminders are enabled for this WhatsApp number/);
  assert.match(await chat({customerPhone:'27820000001'})('START REMINDERS'),/couldn't find a customer record/);
  assert.match(await chat({customerPhone:'not-a-number'})('STOP'),/can't verify your WhatsApp number/);
  assert.equal(count('customers'),1);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,1);
});
test('STOP turns reminders off and retains draft cancellation rather than allowing later YES to book',async()=>{
  salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  const send=chat();
  await send('Braids with Tumi tomorrow at 10am');
  assert.match(await send('STOP'),/stopped this booking request[\s\S]*Reminders are off/);
  assert.doesNotMatch(await send('YES'),/You're booked/);
  assert.equal(count('appointments'),0);
});
test('active photo prompt cannot swallow STOP and temporary photo state is cleaned',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  db.prepare("INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at) VALUES('photo','salon',?,'source','consent','2031-10-02T00:00:00Z')").run(phone);
  db.prepare("INSERT INTO photo_uploads VALUES('salon',?,'source','123',NULL,'2031-10-02T00:00:00Z')").run(phone);
  const reply=await chat()('STOP');
  assert.match(reply,/Reminders are off/);
  assert.equal(count('photo_sessions'),0); assert.equal(count('photo_uploads'),0);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,0);
});
test('reminder-only opt-out preserves and tags photo context without analysing or booking',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  db.prepare("INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at) VALUES('photo','salon',?,'source','details','2031-10-02T00:00:00Z')").run(phone);
  db.prepare("INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id) VALUES('unsubscribe','salon',?,'in','UNSUBSCRIBE',?,'unsubscribe-id')").run(phone,now.toISOString());
  const result=await ai.generateReply({client,services,history:[],customerPhone:phone,incomingMessage:'UNSUBSCRIBE',incomingMessageId:'unsubscribe-id',now});
  assert.match(result.text,/Reminders are off/); assert.equal(result.photoSessionId,'photo');
  assert.equal(db.prepare("SELECT photo_session_id FROM messages WHERE id='unsubscribe'").get().photo_session_id,'photo');
  assert.equal(db.prepare("SELECT stage FROM photo_sessions WHERE id='photo'").get().stage,'details');
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,0);
  assert.equal(count('appointments'),0);
});

test('delayed or same-second START REMINDERS cannot undo a newer opt-out',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato'});
  db.prepare('UPDATE customers SET whatsapp_opt_in=0,opt_out_at=? WHERE id=?').run('2031-10-01T07:00:05.600Z',customer.id);
  const send=chat();
  for(const messageAt of ['2031-10-01T07:00:04Z','2031-10-01T07:00:05Z']){
    assert.match(await send('START REMINDERS',{messageAt:new Date(messageAt)}),/Reminders are still off/);
    assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,0);
  }
  assert.match(await send('START REMINDERS',{messageAt:new Date('2031-10-01T07:00:08Z')}),/preference is on/);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,1);
});
