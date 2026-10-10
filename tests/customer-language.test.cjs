const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beautydesk-language-'));
process.env.DB_PATH = path.join(dir, 'test.sqlite');
process.env.WHATSAPP_CUSTOMER_LANGUAGES = '1';
delete process.env.ANTHROPIC_API_KEY;
process.env.PHOTO_PRIVACY_URL='https://example.test/privacy';
const db = require('../db'), salon = require('../modules/salon'), ai = require('../ai');
let languages = require('../customer-language');
const copy = require('../customer-copy'), catalog = require('../customer-copy.json');
const now = new Date('2031-10-01T07:00:00Z'), phone = '27821234567';
let tick;
const count = table => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
beforeEach(() => {
  tick = 0;
  process.env.WHATSAPP_CUSTOMER_LANGUAGES = '1';
  for (const table of ['whatsapp_customer_languages','notification_outbox','appointment_events','booking_requests','booking_quotes','payments','subscriptions','staff_time_off','staff_services','staff','customers','salon_settings','photo_sessions','photo_uploads','messages','appointments','services','clients']) db.prepare(`DELETE FROM ${table}`).run();
  for (const id of ['salon','other']) {
    db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,phone,created_at,hours) VALUES(?,?,?,?,?,?,?,?)').run(id,id+' Salon','Owner',id+'@example.test','unused','27820009999',now.toISOString(),db.DEFAULT_HOURS);
    db.prepare('INSERT INTO services(id,client_id,name,price,duration_mins,created_at,deposit_amount) VALUES(?,?,?,?,?,?,?)').run(id+'-braids',id,'Braids',350,90,now.toISOString(),100);
    salon.ensureSalon(id);
    db.prepare('DELETE FROM staff_services WHERE client_id=?').run(id);
    db.prepare('DELETE FROM staff WHERE client_id=?').run(id);
    db.prepare('INSERT INTO staff(id,client_id,name,hours,created_at) VALUES(?,?,?,?,?)').run(id+'-tumi',id,'Tumi',db.DEFAULT_HOURS,now.toISOString());
    db.prepare('INSERT INTO staff_services(client_id,staff_id,service_id) VALUES(?,?,?)').run(id,id+'-tumi',id+'-braids');
  }
});
after(() => { db.close(); fs.rmSync(dir,{ recursive:true, force:true }); });
function preference(id='salon', sender=phone) {
  return db.prepare('SELECT * FROM whatsapp_customer_languages WHERE client_id=? AND customer_phone=?').get(id,sender.replace(/^\+/,''));
}
async function send(body, options = {}) {
  const clientId=options.clientId || 'salon', sender=options.phone || phone;
  const at=new Date(now.getTime()+(++tick)*3000), id=options.id || crypto.randomUUID();
  const history=db.prepare('SELECT * FROM messages WHERE client_id=? AND customer_phone=? AND (direction=\'in\' OR delivery_status IN (\'accepted\',\'sent\',\'delivered\',\'read\')) ORDER BY rowid').all(clientId,sender);
  const prior=[...history].reverse().find(m=>m.direction==='out' && m.accepted_at);
  db.prepare("INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at,wa_message_id,incoming_type) VALUES(?,?,?,'in',?,?,?,?)")
    .run(id,clientId,sender,body,at.toISOString(),id,options.incomingType || 'text');
  const result=await languages.generateReply({
    client:db.prepare('SELECT * FROM clients WHERE id=?').get(clientId),
    services:db.prepare('SELECT * FROM services WHERE client_id=?').all(clientId),
    history,incomingMessage:body,customerPhone:sender,customerName:'Lerato',incomingMessageId:id,
    confirmationMessageId:prior?.id,now:at,messageAt:at,receivedAt:at,...options
  });
  const output=crypto.randomUUID();
  db.prepare(`INSERT INTO messages(id,client_id,customer_phone,direction,body,canonical_body,message_format_json,language_control,customer_language,created_at,accepted_at,delivery_status,photo_session_id)
    VALUES(?,?,?,'out',?,?,?,?,?,?,?, ?,?)`).run(output,clientId,sender,result.text,result.canonicalText ?? result.text,result.messageFormat ? JSON.stringify(result.messageFormat):null,result.languageControl?1:0,result.language||null,at.toISOString(),options.failed?null:at.toISOString(),options.failed?'failed':'accepted',result.photoSessionId||null);
  if(result.photoSessionId) require('../photo-flow').bindReply(result.photoSessionId,clientId,sender,output);
  return {...result,id:output,at};
}
async function select(choice='1') {
  assert.equal((await send('Hi')).mode,'language');
  return send(choice);
}
const expected = { en:'Please confirm', zu:'Sicela uqinisekise', af:'Bevestig asseblief', xh:'Nceda uqinisekise' };
for(const [index,language] of languages.LANGUAGES.entries()) {
  test(`${language}: first contact, persistent choice, full booking and unchanged facts`,async()=>{
    const welcome=await select(String(index+1));
    assert.equal(preference().language,language);
    assert.equal(count('customers'),0);
    assert.ok(welcome.text.includes('salon Salon'));
    const summary=await send('Braids with Tumi tomorrow at 10am');
    assert.ok(summary.text.startsWith(expected[language]),summary.text);
    for(const fact of ['Braids','Tumi','2031-10-02','10:00','Lerato','R350','90 min','R100']) assert.ok(summary.text.includes(fact),fact);
    assert.match(summary.canonicalText,/^Please confirm/);
    assert.equal(count('appointments'),0);
    const result=await send(({en:'YES',zu:'yebo',af:'ja',xh:'ewe'})[language]);
    assert.match(result.canonicalText,/^You're booked!/);
    const booking=db.prepare('SELECT * FROM appointments').get();
    assert.equal(booking.service_name,'Braids'); assert.equal(booking.price_at_booking,350);
    assert.equal(booking.starts_at,'2031-10-02T10:00:00+02:00'); assert.equal(booking.staff_id,'salon-tumi');
    assert.equal(booking.deposit_amount,100); assert.equal(count('appointment_events'),1);
    assert.equal((await send('YES')).text,result.text);
    assert.equal(count('appointments'),1);
    delete require.cache[require.resolve('../customer-language')];
    languages=require('../customer-language');
    assert.equal((await send('hours')).language,language);
  });
}
test('first booking request is resumed after selection without consenting',async()=>{
  await send('Braids with Tumi tomorrow at 10am');
  const result=await send('2');
  assert.match(result.canonicalText,/^Please confirm/);
  assert.equal(count('appointments'),0);
});
test('all mid-flow switches redisplay a fresh summary and require later confirmation',async()=>{
  await select();
  await send('Braids with Tumi tomorrow at 10am');
  for(const [language,choice] of [['zu','2'],['af','3'],['xh','4'],['en','1']]) {
    assert.equal((await send('LANGUAGE')).mode,'language');
    const summary=await send(choice);
    assert.ok(summary.text.startsWith(expected[language]));
    assert.equal(count('appointments'),0);
    assert.match(summary.canonicalText,/Service: Braids[\s\S]*Technician: Tumi/);
  }
  await send('YES');
  assert.equal(count('appointments'),1);
});
test('language numbers are interpreted only while choosing; fourth choice is never booking consent',async()=>{
  await select('4');
  assert.equal(preference().language,'xh');
  assert.match((await send('1')).canonicalText,/^Which service/);
  assert.match((await send('1')).canonicalText,/^Which technician/);
  assert.match((await send('1')).canonicalText,/What day/);
  assert.equal(preference().language,'xh'); assert.equal(count('appointments'),0);
});
test('missing/invalid choices re-prompt, direct commands and localized switch words work',async()=>{
  for(const text of ['', '5', 'French', 'YES']) assert.equal((await send(text)).mode,'language');
  assert.equal(preference().language,null); assert.equal(count('appointments'),0);
  await send('isiZulu');
  for(const [command,language] of [['taal Afrikaans','af'],['ulwimi isiXhosa','xh'],['ulimi English','en'],['/language zu','zu']]) {
    assert.equal((await send(command)).language,language);
  }
  await send('LANGUAGE French');
  assert.equal(preference().language,'zu'); assert.equal(preference().choosing,1);
});
test('tenant isolation and canonical phone variants do not create CRM customers',async()=>{
  await select('2');
  await send('hello',{clientId:'other'}); await send('3',{clientId:'other'});
  assert.equal(preference().language,'zu'); assert.equal(preference('other').language,'af');
  assert.equal((await send('hours',{phone:'+'+phone})).language,'zu');
  assert.equal(count('whatsapp_customer_languages'),2); assert.equal(count('customers'),0);
});
test('existing legacy history survives rollout, and migration remains additive',async()=>{
  delete process.env.WHATSAPP_CUSTOMER_LANGUAGES;
  const summary=await send('Braids with Tumi tomorrow at 10am');
  assert.match(summary.text,/^Please confirm/);
  process.env.WHATSAPP_CUSTOMER_LANGUAGES='1';
  assert.equal((await send('YES')).mode,'language');
  assert.match((await send('4')).canonicalText,/^Please confirm/);
  assert.equal(count('appointments'),0);
  await send('ewe'); assert.equal(count('appointments'),1);
});
test('legacy salons without CRM initialization can choose and book',async()=>{
  db.prepare("DELETE FROM salon_settings WHERE client_id='salon'").run();
  await select('3');
  assert.match((await send('Braids tomorrow at 10am')).canonicalText,/^Please confirm/);
  await send('ja');
  assert.equal(count('appointments'),1);
  assert.equal(db.prepare('SELECT staff_id FROM appointments').get().staff_id,null);
});
test('stale language choices cannot replace a newer preference',async()=>{
  await select('2');
  const stamp=preference().updated_at_ms;
  await send('LANGUAGE af',{messageAt:new Date(stamp-3000)});
  assert.equal(preference().language,'zu');
});
test('same-second, mismatched-context and failed translated summaries cannot authorize booking',async()=>{
  await select('2');
  const summary=await send('Braids with Tumi tomorrow at 10am');
  await send('yebo',{messageAt:summary.at});
  assert.equal(count('appointments'),0);
  await send('yebo',{confirmationMessageId:'not-the-summary'});
  assert.equal(count('appointments'),0);
  await send('LANGUAGE af',{failed:true});
  await send('ja');
  assert.equal(count('appointments'),0);
});
test('service changes, slot conflicts, cancellation and dry-run retain booking safeguards',async()=>{
  await select('4'); await send('Braids with Tumi tomorrow at 10am');
  db.prepare("UPDATE services SET price=400 WHERE id='salon-braids'").run();
  assert.doesNotMatch((await send('ewe')).canonicalText,/^You're booked/);
  assert.equal(count('appointments'),0);
  await send('rhoxisa');
  await send('ewe'); assert.equal(count('appointments'),0);
  await send('Braids with Tumi tomorrow at 10am');
  assert.equal(ai.bookAppointment('salon',{customerName:'Another',customerPhone:'27820000001',serviceName:'Braids',durationMins:90,dateStr:'2031-10-02',time:'10:00',staffId:'salon-tumi',incomingMessageId:'competing',now}).ok,true);
  assert.match((await send('ewe')).canonicalText,/no longer available/);
  const prior=preference().language;
  await send('LANGUAGE af',{dryRun:true});
  assert.equal(preference().language,prior); assert.equal(count('appointments'),1);
});
test('STOP/opt-out takes priority over first contact and language switch menu',async()=>{
  const customer=salon.upsertCustomer('salon',{phone,name:'Lerato',whatsappOptIn:true});
  assert.match((await send('STOP')).canonicalText,/Reminders are off/);
  assert.equal(preference(),undefined);
  assert.equal(db.prepare('SELECT whatsapp_opt_in FROM customers WHERE id=?').get(customer.id).whatsapp_opt_in,0);
  await select('2'); await send('Braids with Tumi tomorrow at 10am');
  await send('LANGUAGE');
  assert.match((await send('STOP')).canonicalText,/stopped this booking request/);
  await send('3'); await send('YES'); assert.equal(count('appointments'),0);
});
test('all translation entries retain placeholders and opaque facts, including collisions',()=>{
  for(const [key,translations] of Object.entries(catalog)){
    const slots=[...key.matchAll(/\{(\d+)\}/g)].map(m=>Number(m[1]));
    const values=Array.from({length:Math.max(-1,...slots)+1},(_,i)=>`FACT-${i} Please confirm R350 2031-10-02`);
    for(const language of ['en','zu','af','xh']){
      assert.ok(language==='en'||translations[language]);
      const rendered=copy.render({version:1,key,values},language);
      for(const value of values) assert.ok(rendered.includes(value));
    }
  }
  const rendered=copy.render(copy.m`Hi! Welcome to ${'Please confirm your booking:'}.\n1. Book Appointment\n2. View Services\n3. My Appointment\n4. Contact Salon\nReply with an option.`,'af');
  assert.ok(rendered.includes('Please confirm your booking:'));
  assert.throws(()=>copy.render(copy.s('Unreviewed unknown copy'),'zu'),/missing_translation/);
});
test('photo consent remains explicit after a switch; I AGREE remains the documented command',async()=>{
  const photo=require('../photo-flow'), original=photo.createPhotoFlow;
  photo.createPhotoFlow=()=>original({status:()=>({ready:true}),retrieve:()=>{throw Error('Photo must not be retrieved before consent');}});
  try{
    await select('2');
    db.prepare("UPDATE clients SET photo_estimates_enabled=1 WHERE id='salon'").run();
    db.prepare("UPDATE services SET photo_eligible=1,photo_category='hair',photo_description='Shoulder-length braids from the salon menu' WHERE id='salon-braids'").run();
    db.prepare("INSERT INTO photo_sessions(id,client_id,customer_phone,source_message_id,stage,expires_at) VALUES('photo','salon',?,'source','consent','2031-10-02T00:00:00Z')").run(phone);
    await send('LANGUAGE 4');
    assert.equal(db.prepare("SELECT stage FROM photo_sessions WHERE id='photo'").get().stage,'consent');
    assert.equal((await send('ewe')).language,'xh');
    assert.equal(db.prepare("SELECT consent_at FROM photo_sessions WHERE id='photo'").get().consent_at,null);
    const result=await send('I AGREE');
    assert.ok(result.text.includes('REFERENCE'));
    assert.equal(db.prepare("SELECT stage FROM photo_sessions WHERE id='photo'").get().stage,'role');
    assert.equal(count('appointments'),0);
  } finally { photo.createPhotoFlow=original; }
});
