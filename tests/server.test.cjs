const {test} = require('node:test');
const assert = require('node:assert/strict');
const {spawn, spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const secret = 'local-test-meta-secret-not-production';
const adminPass = 'local-test-admin-passphrase';
async function freePort() { const s = net.createServer(); await new Promise(r => s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
async function launch(t, overrides = {}, beforeStart) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'beautydesk-pilot-'));
  const port=await freePort(), dbPath=path.join(dir,'test.db');
  const env={PATH:process.env.PATH,PORT:String(port),DB_PATH:dbPath,NODE_ENV:'test',JWT_SECRET:'local-test-jwt-secret-at-least-32-characters',ADMIN_PASSCODE:adminPass,META_APP_SECRET:secret,...overrides};
  if (beforeStart) await beforeStart(dbPath, env);
  const child=spawn(process.execPath,['--require',path.join(__dirname,'network-mocks.cjs'),'server.js'],{cwd:root,env,stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',b=>output+=b); child.stderr.on('data',b=>output+=b);
  t.after(async()=>{ if(child.exitCode===null) { child.kill(); await new Promise(r=>child.once('exit',r)); } fs.rmSync(dir,{recursive:true,force:true}); });
  const base='http://127.0.0.1:'+port;
  for(let i=0;i<100;i++){ if(child.exitCode!==null) throw Error('Startup failed: '+output); try { if((await fetch(base+'/healthz')).ok) return {base,dbPath,dir,child,env,output:()=>output}; } catch{} await sleep(30); }
  throw Error('Startup timeout: '+output);
}
async function request(h,method,url,body,cookie,headers={}) {
  const res=await fetch(h.base+url,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  const text=await res.text(); let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:res.status,data,cookie:res.headers.get('set-cookie')?.split(';')[0],headers:res.headers};
}
async function seed(h, email='Test@Example.invalid') {
  assert.equal((await request(h,'POST','/api/signups',{salon:'Test Salon',owner:'Owner',email,phone:'27820000000',city:'Test City'})).status,201);
  const admin=await request(h,'POST','/api/admin/login',{passcode:adminPass}); assert.equal(admin.status,200);
  const signups=await request(h,'GET','/api/admin/signups',undefined,admin.cookie);
  const signup=signups.data.find(s=>s.email===email.toLowerCase());
  const active=await request(h,'POST',`/api/admin/signups/${signup.id}/activate`,{},admin.cookie); assert.equal(active.status,200);
  const login=await request(h,'POST','/api/client/login',{email:email.toUpperCase(),password:active.data.tempPassword}); assert.equal(login.status,200);
  const me=await request(h,'GET','/api/client/me',undefined,login.cookie);
  return {id:me.data.id,cookie:login.cookie,password:active.data.tempPassword,adminCookie:admin.cookie,me:me.data};
}
const inbound=(id,body='hello',phone='123456789012345',from='27820000000')=>({entry:[{changes:[{value:{metadata:{phone_number_id:phone},contacts:[{wa_id:from,profile:{name:'Alan'}}],messages:[{id,from,timestamp:String(Math.floor(Date.now()/1000)),type:'text',text:{body}}]}}]}]});
async function webhook(h,id,body,signature=true) { const raw=JSON.stringify(body); return fetch(h.base+'/webhooks/whatsapp/'+id,{method:'POST',headers:{'content-type':'application/json',...(signature?{'x-hub-signature-256':'sha256='+crypto.createHmac('sha256',secret).update(raw).digest('hex')}:{})},body:raw}); }
async function waitFor(fn) { for(let i=0;i<150;i++){if(await fn())return;await sleep(20);}throw Error('Timed out awaiting local processing'); }
async function connect(h,c,phone='123456789012345') { assert.equal((await request(h,'PATCH','/api/client/whatsapp-connection',{phoneNumberId:phone,accessToken:'test-token-placeholder-no-real-access'},c.cookie)).status,200); }

test('HTTP startup/auth, normalized signup, safe assets, security headers and HTTPS callback',async t=>{
  const h=await launch(t,{PUBLIC_BASE_URL:'https://pilot.example.invalid'}), c=await seed(h);
  assert.equal(c.me.webhook_url,`https://pilot.example.invalid/webhooks/whatsapp/${c.id}`);
  assert.equal(c.me.responder_mode,'guided'); assert.equal(c.me.wa_signature_configured,true);
  assert.equal((await request(h,'GET','/api/client/me')).status,401);
  assert.equal((await request(h,'GET','/api/admin/signups',undefined,c.cookie)).status,401);
  for(const file of ['/server.js','/db.js','/.env','/package.json','/data/beautydesk.db']) assert.equal((await fetch(h.base+file)).status,404);
  for(const file of ['/','/app.js','/favicon.svg']) assert.equal((await fetch(h.base+file)).status,200);
  assert.equal((await request(h,'GET','/api/client/me',undefined,c.cookie)).headers.get('cache-control'),'no-store');
  assert.equal((await request(h,'POST','/api/signups',{salon:{},owner:'x',email:'bad',phone:'1',city:'x'})).status,400);
  assert.equal((await request(h,'POST','/api/client/logout',{},c.cookie,{'origin':'https://evil.example.invalid'})).status,403);
  assert.equal((await fetch(h.base+'/api/client/logout',{method:'POST',headers:{cookie:c.cookie}})).status,415);
  assert.equal((await request(h,'POST','/api/signups',{salon:'Duplicate',owner:'x',email:'TEST@example.invalid',phone:'1',city:'x'})).status,200);
});

test('tenant isolation, strict service/settings validation and idempotent cancellation',async t=>{
  const h=await launch(t), a=await seed(h), b=await seed(h,'second@example.invalid');
  let r=await request(h,'POST','/api/client/services',{name:'Haircut',price:150,durationMins:60},a.cookie); assert.equal(r.status,201);const service=r.data;
  assert.equal((await request(h,'POST','/api/client/services',{name:' haircut ',price:150,durationMins:60},a.cookie)).status,409);
  for(const body of [{name:'Bad',price:-1,durationMins:60},{name:'Bad',price:1,durationMins:-2},{name:'Bad',price:1,durationMins:1.5}]) assert.equal((await request(h,'POST','/api/client/services',body,a.cookie)).status,400);
  assert.equal((await request(h,'GET','/api/client/services',undefined,b.cookie)).data.length,0);
  await request(h,'DELETE','/api/client/services/'+service.id,{},b.cookie);
  assert.equal((await request(h,'GET','/api/client/services',undefined,a.cookie)).data.length,1);
  assert.equal((await request(h,'PATCH','/api/client/settings',{hours:{mon:'nonsense'}},a.cookie)).status,400);
  assert.equal((await request(h,'PATCH','/api/client/settings',{greeting:'New greeting'},a.cookie)).status,200);
  assert.equal((await request(h,'GET','/api/client/me',undefined,a.cookie)).data.whatsapp_enabled,1);
  await connect(h,a); assert.equal((await request(h,'PATCH','/api/client/whatsapp-connection',{phoneNumberId:'123456789012345',accessToken:'test-token-placeholder-no-real-access'},b.cookie)).status,409);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  db.prepare('INSERT INTO appointments(id,client_id,customer_name,service_name,starts_at,created_at) VALUES(?,?,?,?,?,?)').run('appt',a.id,'Alan','Haircut','2027-01-05T12:00:00+02:00',new Date().toISOString());
  assert.equal((await request(h,'POST','/api/client/appointments/appt/cancel',{},b.cookie)).status,404);
  for(let i=0;i<2;i++)assert.equal((await request(h,'POST','/api/client/appointments/appt/cancel',{},a.cookie)).status,200);
  assert.equal(db.prepare('SELECT status FROM appointments').get().status,'cancelled');
});

test('password change validates current password, revokes old sessions and admits new credentials',async t=>{
  const h=await launch(t), c=await seed(h);
  assert.equal((await request(h,'PATCH','/api/client/password',{currentPassword:'wrong',newPassword:'valid-new-test-password'},c.cookie)).data.error,'invalid_current_password');
  assert.equal((await request(h,'PATCH','/api/client/password',{currentPassword:c.password,newPassword:'short'},c.cookie)).data.error,'weak_password');
  const changed=await request(h,'PATCH','/api/client/password',{currentPassword:c.password,newPassword:'valid-new-test-password'},c.cookie);assert.equal(changed.status,200);
  assert.equal((await request(h,'GET','/api/client/me',undefined,c.cookie)).status,401);
  assert.equal((await request(h,'GET','/api/client/me',undefined,changed.cookie)).status,200);
  assert.equal((await request(h,'POST','/api/client/login',{email:'test@example.invalid',password:c.password})).status,401);
  assert.equal((await request(h,'POST','/api/client/login',{email:'test@example.invalid',password:'valid-new-test-password'})).status,200);
});

test('signed webhook durable queue, batches, deduplication, real contact context and receipt ordering',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  assert.equal((await webhook(h,c.id,inbound('unsigned'),false)).status,401);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,0);
  assert.equal((await webhook(h,c.id,inbound('wrong-sender','hello','999999999'))).status,200);
  assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,0);
  const batch=inbound('in.1','Bookings');batch.entry[0].changes[0].value.messages.push(inbound('in.2','hours').entry[0].changes[0].value.messages[0]);
  assert.equal((await webhook(h,c.id,batch)).status,200);
  assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_jobs').get().n,2);
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===2);
  const out=db.prepare("SELECT * FROM messages WHERE direction='out' ORDER BY rowid").all();assert.equal(out.length,2);assert.notEqual(out[0].body,out[1].body);
  assert.equal(out[0].customer_phone,'27820000000'); assert.equal(out[0].customer_name,'Alan');
  await webhook(h,c.id,batch);await sleep(50);assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,4);
  const receipt=status=>({entry:[{changes:[{value:{metadata:{phone_number_id:'123456789012345'},statuses:[{id:out[0].wa_message_id,status}]}}]}]});
  for(const status of ['delivered','read','sent','failed']) assert.equal((await webhook(h,c.id,receipt(status))).status,200);
  assert.equal(db.prepare('SELECT delivery_status FROM messages WHERE id=?').get(out[0].id).delivery_status,'read');
  const before=db.prepare('SELECT count(*) n FROM appointments').get().n;
  assert.equal((await request(h,'POST','/api/whatsapp/simulate',{message:'Bookings'},c.cookie)).status,200);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,before);
  await request(h,'PATCH','/api/client/settings',{whatsappEnabled:false},c.cookie);
  await webhook(h,c.id,inbound('paused'));assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_jobs').get().n,2);
});

test('webhooks fail closed without app secret and login throttles repeated attempts',async t=>{
  const h=await launch(t,{META_APP_SECRET:''});
  assert.equal((await webhook(h,'unknown',inbound('in.1'))).status,503);
  for(let i=0;i<15;i++) assert.equal((await request(h,'POST','/api/admin/login',{passcode:'wrong'})).status,401);
  const limited=await request(h,'POST','/api/admin/login',{passcode:'wrong'});assert.equal(limited.status,429);assert(limited.headers.get('retry-after'));
});

test('startup refuses missing security settings and production deployment misconfiguration',async()=>{
  for(const extra of [{JWT_SECRET:''},{ADMIN_PASSCODE:''},{NODE_ENV:'production',PUBLIC_BASE_URL:''},{NODE_ENV:'production',PUBLIC_BASE_URL:'https://pilot.example.invalid',DB_PATH:'./data/no.db'}]) {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-startup-'));
    const result=spawnSync(process.execPath,['--require',path.join(__dirname,'network-mocks.cjs'),'server.js'],{cwd:root,env:{PATH:process.env.PATH,DB_PATH:path.join(dir,'fixture.db'),JWT_SECRET:'local-test-jwt-secret-at-least-32-characters',ADMIN_PASSCODE:adminPass,NODE_ENV:'test',...extra},encoding:'utf8',timeout:2000});
    assert.notEqual(result.status,0);assert(!result.error || result.error.code!=='ETIMEDOUT');fs.rmSync(dir,{recursive:true,force:true});
  }
});

test('consistent SQLite backup preserves WAL data and refuses overwrite',async t=>{
  const h=await launch(t), c=await seed(h), dest=path.join(h.dir,'safe-backup.db');
  const env={PATH:process.env.PATH,DB_PATH:h.dbPath};
  let result=spawnSync(process.execPath,['scripts/backup.cjs',dest],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const backup=new Database(dest,{readonly:true});assert.equal(backup.prepare('SELECT id FROM clients').get().id,c.id);assert.equal(backup.pragma('quick_check',{simple:true}),'ok');backup.close();
  result=spawnSync(process.execPath,['scripts/backup.cjs',dest],{cwd:root,env,encoding:'utf8'});assert.notEqual(result.status,0);
});

test('a batch cannot pre-confirm unseen details; later explicit confirmation makes one real booking',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);
  assert.equal((await request(h,'POST','/api/client/services',{name:'Haircut',price:150,durationMins:60},c.cookie)).status,201);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  const texts=['Hey it’s Alan','Bookings','Haircut','2027-01-05','12:00','YES'];
  const batch=inbound('batch.0',texts[0]);batch.entry[0].changes[0].value.messages=texts.map((text,i)=>inbound('batch.'+i,text).entry[0].changes[0].value.messages[0]);
  assert.equal((await webhook(h,c.id,batch)).status,200);
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===6);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);
  const last=db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body;assert.match(last,/Please confirm your booking/);assert.match(last,/Alan/);
  await sleep(1100);
  assert.equal((await webhook(h,c.id,inbound('confirm.later','YES'))).status,200);
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===7);
  const appts=db.prepare('SELECT * FROM appointments').all();assert.equal(appts.length,1);assert.equal(appts[0].customer_phone,'27820000000');assert.equal(appts[0].starts_at,'2027-01-05T12:00:00+02:00');
  await webhook(h,c.id,inbound('confirm.later','YES'));await sleep(50);assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
});

test('stale signed input is quarantined before any booking or reply; review is tenant-scoped',async t=>{
  const h=await launch(t), a=await seed(h), b=await seed(h,'other@example.invalid');await connect(h,a);
  const body=inbound('stale','book Haircut tomorrow at 12 for Alan');body.entry[0].changes[0].value.messages[0].timestamp=String(Math.floor(Date.now()/1000)-86401);
  assert.equal((await webhook(h,a.id,body)).status,200);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='review'").get().n===1);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE direction='out'").get().n,0);
  let reviews=await request(h,'GET','/api/client/whatsapp-reviews',undefined,a.cookie);assert.equal(reviews.data.length,1);const id=reviews.data[0].id;assert.equal(reviews.data[0].error_code,'message_window_expired');
  assert.equal((await request(h,'GET','/api/client/whatsapp-reviews',undefined,b.cookie)).data.length,0);
  assert.equal((await request(h,'POST',`/api/client/whatsapp-reviews/${id}/acknowledge`,{},b.cookie)).status,404);
  for(let i=0;i<2;i++)assert.equal((await request(h,'POST',`/api/client/whatsapp-reviews/${id}/acknowledge`,{},a.cookie)).status,200);
  assert.equal((await request(h,'GET','/api/client/whatsapp-reviews',undefined,a.cookie)).data.length,0);
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE direction='out'").get().n,0);
});

test('restart resumes queued/prepared work and quarantines processing/sending ambiguities',async t=>{
  const h=await launch(t,{},async(dbPath,env)=>{
    const migration=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env,encoding:'utf8'});assert.equal(migration.status,0,migration.stderr);
    const db=new Database(dbPath), at=new Date().toISOString();
    db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,greeting,wa_phone_number_id,wa_access_token,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run('c','Fixture Salon','Owner','restore@example.invalid','unused','Hello','123456789012345','local-test-no-real-provider-token',at);
    for(const state of ['queued','prepared','processing','sending']){
      db.prepare('INSERT INTO messages(id,client_id,customer_phone,customer_name,direction,body,created_at,wa_message_id) VALUES(?,?,?,?,?,?,?,?)').run('in-'+state,'c','27820000000','Alan','in','hello',at,'wamid.in.'+state);
      const outgoing=['prepared','sending'].includes(state)?'out-'+state:null;
      if(outgoing) db.prepare('INSERT INTO messages(id,client_id,customer_phone,customer_name,direction,body,created_at,delivery_status) VALUES(?,?,?,?,?,?,?,?)').run(outgoing,'c','27820000000','Alan','out','Previously prepared reply',at,'pending');
      db.prepare('INSERT INTO whatsapp_jobs(id,client_id,customer_phone,customer_name,incoming_id,outgoing_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(state,'c','27820000000','Alan','wamid.in.'+state,outgoing,state,at,at);
    }db.close();
  });
  const db=new Database(h.dbPath);t.after(()=>db.close());
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===2);
  assert.equal(db.prepare("SELECT state FROM whatsapp_jobs WHERE id='processing'").get().state,'review');
  assert.equal(db.prepare("SELECT state FROM whatsapp_jobs WHERE id='sending'").get().state,'unknown');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE id='out-sending'").get().delivery_status,'unknown');
  assert.equal(db.prepare("SELECT count(*) n FROM messages WHERE direction='out' AND delivery_status='accepted'").get().n,2);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);
  const migration=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env:h.env,encoding:'utf8'});assert.equal(migration.status,0,migration.stderr);
  assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_jobs').get().n,4);
});

test('legacy deployed database migrates additively without changing client/message/appointment data',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-legacy-')),dbPath=path.join(dir,'legacy.db');
  // Frozen pre-patch schema copied from the inspected deployed commit.
  const Database=require('better-sqlite3'), db=new Database(dbPath);
  db.exec(`CREATE TABLE clients(id TEXT PRIMARY KEY,salon TEXT NOT NULL,owner TEXT NOT NULL,email TEXT UNIQUE NOT NULL,phone TEXT,city TEXT,password_hash TEXT NOT NULL,whatsapp_enabled INTEGER NOT NULL DEFAULT 1,greeting TEXT,plan_status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL);
  CREATE TABLE messages(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,customer_phone TEXT NOT NULL,customer_name TEXT,direction TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE appointments(id TEXT PRIMARY KEY,client_id TEXT NOT NULL,customer_name TEXT NOT NULL,customer_phone TEXT,service_name TEXT NOT NULL,starts_at TEXT NOT NULL,duration_mins INTEGER NOT NULL DEFAULT 60,status TEXT NOT NULL DEFAULT 'confirmed',source TEXT NOT NULL DEFAULT 'manual',created_at TEXT NOT NULL);`);
  db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,created_at) VALUES(?,?,?,?,?,?)').run('legacy','Existing Salon','Existing Owner','Legacy@Example.invalid','existing-hash','2026-01-01');
  db.prepare('INSERT INTO messages(id,client_id,customer_phone,direction,body,created_at) VALUES(?,?,?,?,?,?)').run('legacy-message','legacy','27820000000','out','Existing conversation','2026-01-01');
  db.prepare('INSERT INTO appointments(id,client_id,customer_name,service_name,starts_at,created_at) VALUES(?,?,?,?,?,?)').run('legacy-appt','legacy','Existing Customer','Existing Service','2027-01-05T12:00:00','2026-01-01');db.close();
  for(let i=0;i<2;i++){const run=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env:{PATH:process.env.PATH,DB_PATH:dbPath},encoding:'utf8'});assert.equal(run.status,0,run.stderr);}
  const checked=new Database(dbPath);assert.equal(checked.prepare('SELECT count(*) n FROM clients').get().n,1);const c=checked.prepare('SELECT * FROM clients').get();assert.equal(c.password_hash,'existing-hash');assert.equal(c.email,'Legacy@Example.invalid');assert.equal(c.auth_version,0);
  const m=checked.prepare('SELECT * FROM messages').get();assert.equal(m.body,'Existing conversation');assert.equal(m.delivery_status,null);
  const a=checked.prepare('SELECT * FROM appointments').get();assert.equal(a.starts_at,'2027-01-05T12:00:00');assert.equal(a.status,'confirmed');assert.equal(checked.pragma('quick_check',{simple:true}),'ok');checked.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('production refuses missing existing database and Railway volume mismatch without creating files',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-volume-'));
  for(const extra of [{DB_PATH:path.join(dir,'missing.db')},{DB_PATH:path.join(dir,'missing.db'),RAILWAY_PROJECT_ID:'test-project'},{DB_PATH:path.join(dir,'missing.db'),RAILWAY_VOLUME_MOUNT_PATH:'/different-test-volume'}]){
    const run=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env:{PATH:process.env.PATH,NODE_ENV:'production',...extra},encoding:'utf8'});assert.notEqual(run.status,0);assert.equal(fs.existsSync(extra.DB_PATH),false);
  }fs.rmSync(dir,{recursive:true,force:true});
});

test('a late successful receipt clears failed review without downgrading delivery',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);const db=new Database(h.dbPath);t.after(()=>db.close());
  await webhook(h,c.id,inbound('receipt.in','hello'));await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===1);
  const out=db.prepare("SELECT wa_message_id FROM messages WHERE direction='out'").get();
  const receipt=status=>({entry:[{changes:[{value:{metadata:{phone_number_id:'123456789012345'},statuses:[{id:out.wa_message_id,status,errors:[{code:131026}]}]}}]}]});
  await webhook(h,c.id,receipt('failed'));assert.equal((await request(h,'GET','/api/client/whatsapp-reviews',undefined,c.cookie)).data.length,1);
  await webhook(h,c.id,receipt('delivered'));await webhook(h,c.id,receipt('read'));assert.equal((await request(h,'GET','/api/client/whatsapp-reviews',undefined,c.cookie)).data.length,0);
  assert.equal(db.prepare('SELECT state FROM whatsapp_jobs').get().state,'completed');assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE direction='out'").get().delivery_status,'read');
});

test('valid production setup keeps existing volume data and sets secure session cookies',async t=>{
  const h=await launch(t,{NODE_ENV:'production',PUBLIC_BASE_URL:'https://pilot.example.invalid'},async(dbPath,env)=>{
    env.RAILWAY_VOLUME_MOUNT_PATH=path.dirname(dbPath);env.RAILWAY_PROJECT_ID='fixture-project';
    const init=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env:{...env,NODE_ENV:'test'},encoding:'utf8'});assert.equal(init.status,0,init.stderr);
  });
  const login=await request(h,'POST','/api/admin/login',{passcode:adminPass});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/Secure/);assert.match(login.headers.get('set-cookie'),/SameSite=Lax/);
  assert.match(login.headers.get('strict-transport-security'),/max-age=/);
  const db=new Database(h.dbPath);assert.equal(db.pragma('quick_check',{simple:true}),'ok');db.close();
});

test('provider rejections/unknown sends stay visible without retries; early receipts survive send response',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);const db=new Database(h.dbPath);t.after(()=>db.close());
  for(const [id,greeting,expected,code] of [['fail','MOCK_META_FAIL','failed','190'],['unknown','MOCK_META_UNKNOWN','unknown','transport_error']]) {
    await request(h,'PATCH','/api/client/settings',{greeting},c.cookie);await webhook(h,c.id,inbound(id,'hello'));
    await waitFor(()=>db.prepare('SELECT state FROM whatsapp_jobs WHERE incoming_id=?').get(id)?.state===expected);
    const row=db.prepare("SELECT * FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get();assert.equal(row.delivery_status,expected);assert.equal(row.delivery_error_code,code);
    const count=db.prepare('SELECT count(*) n FROM messages').get().n;await webhook(h,c.id,inbound(id,'hello'));await sleep(30);assert.equal(db.prepare('SELECT count(*) n FROM messages').get().n,count);
  }
  await request(h,'PATCH','/api/client/settings',{greeting:'MOCK_META_DELAY'},c.cookie);await webhook(h,c.id,inbound('early-receipt','hello'));
  await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='early-receipt'").get()?.state==='sending');
  const receipt={entry:[{changes:[{value:{metadata:{phone_number_id:'123456789012345'},statuses:[{id:'wamid.integration.1',status:'delivered'}]}}]}]};
  await webhook(h,c.id,receipt);await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='early-receipt'").get()?.state==='completed');
  assert.equal(db.prepare("SELECT delivery_status FROM messages WHERE wa_message_id='wamid.integration.1'").get().delivery_status,'delivered');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);
  assert(!h.output().includes('Test transport failure'));
});

test('actual Anthropic SDK import uses mocked provider successfully while booking stays guided',async t=>{
  const h=await launch(t,{ANTHROPIC_API_KEY:'local-fake-provider-key-no-access'}),c=await seed(h);
  const response=await request(h,'POST','/api/whatsapp/simulate',{message:'hello'},c.cookie);
  assert.equal(response.status,200);assert.equal(response.data.mode,'claude');assert.equal(response.data.reply,'Test receptionist reply');
  const booking=await request(h,'POST','/api/whatsapp/simulate',{message:'Bookings'},c.cookie);assert.equal(booking.status,200);assert.equal(booking.data.mode,'rules');
});

test('YES received while summary send is unaccepted cannot book even when acceptance occurs before processing',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);
  await request(h,'POST','/api/client/services',{name:'Haircut MOCK_META_DELAY',price:150,durationMins:60},c.cookie);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  await webhook(h,c.id,inbound('summary-unaccepted','book Haircut MOCK_META_DELAY 2027-01-05 at 12 for Alan'));
  await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='summary-unaccepted'").get()?.state==='sending');
  assert.equal(db.prepare("SELECT accepted_at FROM messages WHERE direction='out'").get().accepted_at,null);
  await webhook(h,c.id,inbound('yes-before-acceptance','YES'));
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===2);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);
  assert.match(db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body,/Please confirm your booking/);
  await sleep(1100);await webhook(h,c.id,inbound('yes-after-new-summary','YES'));
  await waitFor(()=>db.prepare("SELECT count(*) n FROM whatsapp_jobs WHERE state='completed'").get().n===3);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
});

for(const failure of ['unknown','failed']) test(`a ${failure} final confirmation cannot erase committed booking state or turn corrections into a second booking`,async t=>{
  const h=await launch(t,{TEST_FINAL_REPLY_MODE:failure}), c=await seed(h);await connect(h,c);
  await request(h,'POST','/api/client/services',{name:'Haircut',price:150,durationMins:60},c.cookie);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  const send=async(id,text)=>{await webhook(h,c.id,inbound(id,text));await waitFor(()=>['completed','unknown','failed','review'].includes(db.prepare('SELECT state FROM whatsapp_jobs WHERE incoming_id=?').get(id)?.state));};
  await send('summary','book Haircut 2027-01-05 at 12 for Alan');await sleep(1100);await send('yes','YES');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);assert.equal(db.prepare('SELECT origin_message_id FROM appointments').get().origin_message_id,'yes');
  assert.equal(db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='yes'").get().state,failure);
  await send('correction','Actually at 14:00');await send('yes-again','YES');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
  assert.equal(db.prepare('SELECT starts_at FROM appointments').get().starts_at,'2027-01-05T12:00:00+02:00');
  let last=db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body;assert.match(last,/salon|review/i);assert.doesNotMatch(last,/Please confirm your booking/);
  // Acknowledgement resolves the send review; it cannot erase the existing appointment.
  const review=db.prepare("SELECT id FROM whatsapp_jobs WHERE incoming_id='yes'").get();await request(h,'POST',`/api/client/whatsapp-reviews/${review.id}/acknowledge`,{},c.cookie);
  await send('after-review-correction','Actually at 14:00');await send('after-review-yes','YES');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
  // A separate appointment requires a genuinely separate request and a new summary.
  await send('separate','new booking Haircut 2027-01-05 at 14 for Alan');
  last=db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body;assert.match(last,/Please confirm your booking/);
});

test('restart after appointment commit but before reply persistence retains booking and blocks stale continuation',async t=>{
  const h=await launch(t,{},async(dbPath,env)=>{
    const init=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:root,env,encoding:'utf8'});assert.equal(init.status,0,init.stderr);
    const db=new Database(dbPath),at=new Date().toISOString();
    db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,wa_phone_number_id,wa_access_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run('c','Fixture Salon','Owner','crash@example.invalid','unused','123456789012345','test-fake-token-not-provider-access',at);
    db.prepare('INSERT INTO services(id,client_id,name,price,duration_mins,created_at) VALUES(?,?,?,?,?,?)').run('hair','c','Haircut',150,60,at);
    db.prepare('INSERT INTO messages(id,client_id,customer_phone,customer_name,direction,body,created_at,wa_message_id) VALUES(?,?,?,?,?,?,?,?)').run('in-yes','c','27820000000','Alan','in','YES',at,'committed-yes');
    db.prepare('INSERT INTO appointments(id,client_id,customer_name,customer_phone,service_name,starts_at,duration_mins,status,source,created_at,origin_message_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('committed','c','Alan','27820000000','Haircut','2027-01-05T12:00:00+02:00',60,'confirmed','whatsapp',at,'committed-yes');
    db.prepare('INSERT INTO whatsapp_jobs(id,client_id,customer_phone,customer_name,incoming_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run('interrupted','c','27820000000','Alan','committed-yes','processing',at,at);db.close();
  });
  const db=new Database(h.dbPath);t.after(()=>db.close());assert.equal(db.prepare("SELECT state FROM whatsapp_jobs WHERE id='interrupted'").get().state,'review');
  for(const [id,body] of [['correction','Actually at 14:00'],['repeat','YES'],['new-before-review','new booking Haircut 2027-01-05 at 14 for Alan']]){
    await webhook(h,'c',inbound(id,body));await waitFor(()=>db.prepare('SELECT state FROM whatsapp_jobs WHERE incoming_id=?').get(id)?.state==='completed');
  }
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
  const body=db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body;assert.match(body,/salon|review/i);assert.doesNotMatch(body,/Please confirm your booking/);
});

test('a delayed same-second YES cannot confirm an already accepted summary',async t=>{
  const h=await launch(t), c=await seed(h);await connect(h,c);
  await request(h,'POST','/api/client/services',{name:'Haircut',price:150,durationMins:60},c.cookie);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  await webhook(h,c.id,inbound('summary-same-second','book Haircut 2027-01-05 at 12 for Alan'));
  await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='summary-same-second'").get()?.state==='completed');
  const summary=db.prepare("SELECT id,accepted_at FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get();
  const delayed=inbound('delayed-same-second','YES');delayed.entry[0].changes[0].value.messages[0].timestamp=String(Math.floor(Date.parse(summary.accepted_at)/1000));
  await webhook(h,c.id,delayed);await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='delayed-same-second'").get()?.state==='completed');
  assert.equal(db.prepare("SELECT reply_context_id FROM whatsapp_jobs WHERE incoming_id='delayed-same-second'").get().reply_context_id,summary.id);
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,0);
  assert.match(db.prepare("SELECT body FROM messages WHERE direction='out' ORDER BY rowid DESC LIMIT 1").get().body,/Please confirm your booking/);
  await sleep(1100);await webhook(h,c.id,inbound('later-valid-yes','YES'));
  await waitFor(()=>db.prepare("SELECT state FROM whatsapp_jobs WHERE incoming_id='later-valid-yes'").get()?.state==='completed');
  assert.equal(db.prepare('SELECT count(*) n FROM appointments').get().n,1);
});

test('legacy duplicate number links retain token rotation without allowing new cross-account claims',async t=>{
  const h=await launch(t),a=await seed(h),b=await seed(h,'legacy-other@example.invalid');await connect(h,a);
  const db=new Database(h.dbPath);t.after(()=>db.close());
  db.prepare('UPDATE clients SET wa_phone_number_id=?,wa_access_token=? WHERE id=?').run('123456789012345','legacy-token-placeholder-not-real',b.id);
  const rotated=await request(h,'PATCH','/api/client/whatsapp-connection',{accessToken:'rotated-test-token-placeholder-not-real'},a.cookie);assert.equal(rotated.status,200);
  assert.equal(db.prepare('SELECT wa_access_token FROM clients WHERE id=?').get(b.id).wa_access_token,'legacy-token-placeholder-not-real');
  db.prepare('UPDATE clients SET wa_phone_number_id=NULL WHERE id=?').run(b.id);
  assert.equal((await request(h,'PATCH','/api/client/whatsapp-connection',{phoneNumberId:'123456789012345'},b.cookie)).status,409);
});

test('photo settings are scoped, opt-in, validated, and never expose provider secrets',async t=>{
  const h=await launch(t), a=await seed(h), b=await seed(h,'photo-other@example.invalid');
  assert.equal(a.me.photo_estimates_enabled,false); assert.equal(a.me.photo_estimates_status.ready,false);
  const service=(await request(h,'POST','/api/client/services',{name:'Gel nails',price:250,durationMins:60},a.cookie)).data;
  const route='/api/client/services/'+service.id+'/photo-settings';
  const valid={photoEligible:true,photoCategory:'nails',photoDescription:'Single colour gel on natural nails. Removal is excluded.'};
  assert.equal((await request(h,'PATCH',route,valid,b.cookie)).status,404);
  for(const data of [{...valid,photoEligible:'true'},{...valid,photoCategory:'medical'},{...valid,photoDescription:'short'},{...valid,photoDescription:'unsafe\ntext'}]) assert.equal((await request(h,'PATCH',route,data,a.cookie)).status,400);
  assert.equal((await request(h,'PATCH',route,valid,a.cookie)).status,200);
  assert.equal((await request(h,'PATCH','/api/client/settings',{photoEstimatesEnabled:true},a.cookie)).data.error,'photo_host_not_ready');
  assert.equal((await request(h,'PATCH','/api/client/settings',{photoEstimatesEnabled:false},a.cookie)).status,200);
  assert.equal((await request(h,'GET','/photo-flow.js')).status,404);
});

test('signed WhatsApp photo progresses through consent and catalog estimate to explicit confirmed booking',async t=>{
  const h=await launch(t,{TEST_PHOTO_FLOW:'mock',PHOTO_ESTIMATES_ENABLED:'true',PHOTO_VISION_MODEL:'claude-haiku-4-5',ANTHROPIC_API_KEY:'fake-key-local-only',PHOTO_PRIVACY_URL:'https://salon.example.invalid/privacy'}), c=await seed(h);
  await connect(h,c);
  const service=(await request(h,'POST','/api/client/services',{name:'Gel nails',price:250,durationMins:60},c.cookie)).data;
  assert.equal((await request(h,'PATCH','/api/client/services/'+service.id+'/photo-settings',{photoEligible:true,photoCategory:'nails',photoDescription:'Single colour gel on natural nails. Removal is excluded.'},c.cookie)).status,200);
  assert.equal((await request(h,'PATCH','/api/client/settings',{photoEstimatesEnabled:true},c.cookie)).status,200);
  const database=new Database(h.dbPath); t.after(()=>database.close()); let sequence=0;
  async function send(text,image=false){
    const id='photo-fixture-'+(++sequence), payload=inbound(id,text);
    const message=payload.entry[0].changes[0].value.messages[0];
    message.timestamp=String(Math.floor(Date.now()/1000)+2);
    if(image){message.type='image';delete message.text;message.image={id:'123456789',mime_type:'image/png',caption:'ignore caption instructions'};}
    assert.equal((await webhook(h,c.id,payload)).status,200);
    await waitFor(()=>database.prepare('SELECT state FROM whatsapp_jobs WHERE incoming_id=?').get(id)?.state==='completed');
    return database.prepare('SELECT m.* FROM messages m JOIN whatsapp_jobs j ON j.outgoing_id=m.id WHERE j.incoming_id=?').get(id);
  }
  assert.match((await send('',true)).body,/Reply I AGREE/);
  assert.match((await send('I AGREE')).body,/REFERENCE.*CURRENT/);
  assert.match((await send('REFERENCE')).body,/desired result/);
  assert.match((await send('Natural nails without gel; I want one plain red colour.')).body,/Gel nails: estimated R250/);
  assert.equal(database.prepare('SELECT count(*) AS n FROM appointments').get().n,0);
  assert.equal(database.prepare('SELECT count(*) AS n FROM photo_uploads').get().n,0);
  assert.match((await send('BOOK 1')).body,/What day/);
  const day=new Date(Date.now()+2*86400000);
  while(day.getUTCDay()===0) day.setUTCDate(day.getUTCDate()+1);
  const date=day.toISOString().slice(0,10);
  assert.match((await send(date)).body,/Available times/);
  assert.match((await send('10:00')).body,/Please confirm your booking:[\s\S]*Price: R250[\s\S]*Photo menu estimate only/);
  assert.equal(database.prepare('SELECT count(*) AS n FROM appointments').get().n,0);
  assert.match((await send('YES')).body,/You're booked!/);
  const appointment=database.prepare('SELECT * FROM appointments').get();
  assert.equal(appointment.quote_kind,'photo_menu_estimate'); assert.equal(appointment.price_at_booking,250); assert.ok(appointment.photo_session_id);
  await send('YES'); assert.equal(database.prepare('SELECT count(*) AS n FROM appointments').get().n,1);
});

test('both login routes preserve migrated case/whitespace accounts without credential or identity changes', async t=>{
  const h=await launch(t), c=await seed(h), db=new Database(h.dbPath);
  t.after(()=>db.close());
  db.prepare('UPDATE clients SET email=? WHERE id=?').run('\t\u00a0TeSt@Example.invalid \n',c.id);
  const before=db.prepare('SELECT * FROM clients ORDER BY id').all();
  for(const route of ['/api/client/login','/api/v1/auth/login']) {
    const result=await request(h,'POST',route,{email:' TEST@EXAMPLE.INVALID ',password:c.password});
    assert.equal(result.status,200);assert(result.cookie);
    const me=await request(h,'GET','/api/client/me',undefined,result.cookie);assert.equal(me.data.id,c.id);
    for(const body of [{email:'test@example.invalid',password:c.password+' '},{email:'absent@example.invalid',password:c.password},{email:{value:'test@example.invalid'},password:c.password}]) {
      const denied=await request(h,'POST',route,body);assert.equal(denied.status,401);assert.deepEqual(denied.data,{error:'invalid_credentials'});assert.equal(denied.cookie,undefined);
    }
  }
  assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY id').all(),before);
  const signup=await request(h,'POST','/api/v1/auth/signup',{name:'Another',salonName:'Another',email:'test@example.invalid',password:'synthetic-fixture-password'});
  assert.equal(signup.status,409);assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY id').all(),before);
  const existing=db.prepare('SELECT id FROM signups WHERE client_id=?').get(c.id);
  const activate=await request(h,'POST','/api/admin/signups/'+existing.id+'/activate',{},c.adminCookie);
  assert.equal(activate.status,200);assert.equal(activate.data.tempPassword,null);
  assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY id').all(),before);
});

test('normalized email collisions fail closed for both logins and activation without merging accounts', async t=>{
  const h=await launch(t), a=await seed(h), b=await seed(h,'second@example.invalid'), db=new Database(h.dbPath);
  t.after(()=>db.close());
  db.prepare('UPDATE clients SET email=? WHERE id=?').run(' TEST@example.invalid ',b.id);
  const before=db.prepare('SELECT * FROM clients ORDER BY id').all();
  for(const route of ['/api/client/login','/api/v1/auth/login']) for(const password of [a.password,b.password]) {
    const result=await request(h,'POST',route,{email:'test@example.invalid',password});
    assert.equal(result.status,401);assert.deepEqual(result.data,{error:'invalid_credentials'});assert.equal(result.cookie,undefined);
  }
  const signup=db.prepare('SELECT * FROM signups WHERE client_id=?').get(a.id);
  const result=await request(h,'POST','/api/admin/signups/'+signup.id+'/activate',{},a.adminCookie);
  assert.equal(result.status,409);assert.deepEqual(result.data,{error:'account_requires_review'});
  assert.deepEqual(db.prepare('SELECT * FROM signups WHERE id=?').get(signup.id),signup);
  assert.deepEqual(db.prepare('SELECT * FROM clients ORDER BY id').all(),before);
});
