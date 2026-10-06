const fs=require('fs'),vm=require('vm'),assert=require('node:assert/strict');
const {test}=require('node:test'),{spawn}=require('node:child_process'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const root=path.resolve(__dirname,'..');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),js=fs.readFileSync(path.join(root,'app.js'),'utf8');
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);assert.equal(new Set(ids).size,ids.length,'unique HTML IDs');
const nodes=new Map();
function node(id){ if(!nodes.has(id))nodes.set(id,{id,value:'',innerHTML:'',textContent:'',hidden:false,disabled:false,checked:false,style:{},attrs:{},dataset:{},classList:{add(){},remove(){},toggle(){}},addEventListener(){},setAttribute(k,v){this.attrs[k]=v},querySelectorAll(){return []},querySelector(){return node('stub-input')},focus(){},reset(){this.resets=(this.resets||0)+1},scrollHeight:0,scrollTop:0});return nodes.get(id); }
ids.forEach(node); ['mon','tue','wed','thu','fri','sat','sun'].forEach(d=>node('hours_'+d));
let calls=[], handler=async()=>({ok:true}),confirm=true;
const context={console,TextEncoder,Date,Set,Array,Object,Number,String,Math,JSON,Error,Promise,encodeURIComponent,location:{hash:'',pathname:'/',search:'',replace(url){this.redirectedTo=url;}},history:{pushState(){}},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},window:{scrollTo(){},addEventListener(){},confirm:()=>confirm},document:{hidden:false,activeElement:null,getElementById:node,querySelectorAll:()=>[],addEventListener(){}},fetch:async(url,options)=>{calls.push({url,...options});let data=await handler(url,options);return {ok:!data.error,status:data.status||200,json:async()=>data};}};
vm.createContext(context);vm.runInContext(js,context);
const run=code=>vm.runInContext(code,context);
function setClient(){run(`CURRENT_CLIENT={id:'fixture',salon:'Fixture salon',whatsapp_enabled:true,greeting:'Saved greeting',hours:JSON.stringify({mon:'09:00-18:00',tue:'closed',wed:'closed',thu:'closed',fri:'closed',sat:'closed',sun:'closed'}),responder_mode:'guided',wa_signature_configured:false,wa_connected:false}; CURRENT_SERVICES=[]; ACTIVE_VIEW='client';`)}
const form={elements:{namedItem:name=>({value:({salon:'Fixture',owner:'Fixture',email:'fixture@example.test',phone:'123',city:'Test',name:'Fixture',message:'hello'})[name]})},querySelectorAll:()=>[node('form-button')],reset(){this.resets=(this.resets||0)+1}};

test('HTTP-backed frontend login, simulator/reset, cancellation, review acknowledgement and logout', async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-ui-http-')), dbPath=path.join(dir,'fixture.db');
 process.env.DB_PATH=dbPath;
 const db=require('../db'), bcrypt=require('bcryptjs'), at=new Date().toISOString();
 db.prepare('INSERT INTO clients(id,salon,owner,email,password_hash,hours,greeting,created_at) VALUES(?,?,?,?,?,?,?,?)').run('qa-salon','Lumière Salon','Local QA','qa@example.invalid',bcrypt.hashSync('local-qa-only-passphrase',10),db.DEFAULT_HOURS,'Hello',at);
 db.prepare('INSERT INTO services(id,client_id,name,price,duration_mins,created_at) VALUES(?,?,?,?,?,?)').run('hair','qa-salon','Haircut',180,60,at);
 db.prepare('INSERT INTO appointments(id,client_id,customer_name,customer_phone,service_name,starts_at,duration_mins,status,source,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('qa-appointment','qa-salon','Alan Fixture','27820000000','Haircut','2027-01-05T12:00:00+02:00',60,'confirmed','whatsapp',at);
 db.prepare('INSERT INTO messages(id,client_id,customer_phone,customer_name,direction,body,created_at,wa_message_id) VALUES(?,?,?,?,?,?,?,?)').run('qa-incoming','qa-salon','27820000000','Alan Fixture','in','Can I book a haircut?',at,'qa-wamid');
 db.prepare('INSERT INTO whatsapp_jobs(id,client_id,customer_phone,customer_name,incoming_id,state,error_code,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('qa-review','qa-salon','27820000000','Alan Fixture','qa-wamid','failed','190',at,at);db.close();
 const listener=net.createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
 const child=spawn(process.execPath,['--require',path.join(__dirname,'network-mocks.cjs'),'server.js'],{cwd:root,env:{PATH:process.env.PATH,DB_PATH:dbPath,PORT:String(port),NODE_ENV:'test',JWT_SECRET:'local-test-ui-jwt-at-least-32-characters',ADMIN_PASSCODE:'local-qa-admin-passphrase',META_APP_SECRET:'local-test-meta-app-secret'},stdio:'pipe'});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}fs.rmSync(dir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+port;
 let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(output);try{if((await fetch(base+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,30));}assert(ready,output);
 let cookie='';let mutations=[];
 context.fetch=async(url,options)=>{
   if(options.method!=='GET')mutations.push(url);
   const res=await fetch(base+url,{...options,headers:{...(options.headers||{}),...(cookie?{Cookie:cookie}:{}),Origin:base}});
   console.log(options.method,url,res.status);const set=res.headers.get('set-cookie');if(set)cookie=set.split(';')[0];return res;
 };
 run("ACTIVE_VIEW='client';");
 node('clientEmail').value='qa@example.invalid';node('clientPassword').value='local-qa-only-passphrase';
 await context.clientLogin({target:form,preventDefault(){}});
 console.log('Login feedback:',node('toast').textContent);assert.equal(node('client-dash').hidden,false);assert.match(node('clientSalonHeading').textContent,/Lumière/);assert.equal(node('responderMode').textContent,'Guided booking');
 assert.equal(node('clientBookingCount').textContent,'1');assert.match(node('waReviewList').innerHTML,/Alan Fixture/);console.log('PASS backend-backed login, dashboard, appointments and review queue');
 node('simInput').value='services';await context.sendSimMessage();assert.match(node('simBody').innerHTML,/Haircut/i);assert.match(node('simModePill').textContent,/Guided booking/);
 await context.resetSimulator();assert.match(node('simBody').innerHTML,/test conversation only/);assert.equal(node('clientBookingCount').textContent,'1');console.log('PASS backend-backed simulator and JSON reset');
 await context.cancelAppointment('qa-appointment',node('cancel-fixture'));assert.equal(node('clientBookingCount').textContent,'0');console.log('PASS backend-backed cancellation updates appointment count');
 await context.acknowledgeWhatsappReview('qa-review',node('review-fixture'));assert.match(node('waReviewList').innerHTML,/No WhatsApp messages currently need/);console.log('PASS backend-backed review acknowledgement clears queue without sending');
 await context.clientLogout();assert.equal(context.location.redirectedTo,'/login?next=photo-pilot');assert.equal(node('client-dash').hidden,true);assert.equal(run('CURRENT_CLIENT'),null);
 await assert.rejects(()=>context.api('GET','/api/client/me'));console.log('PASS backend-backed logout clears session');
 assert.ok(!mutations.some(url=>url.includes('send')));console.log('5 HTTP-backed frontend checks passed; only disposable fixture data was changed');
});
