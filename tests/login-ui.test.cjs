const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
test('modular login feedback distinguishes generic 401, throttling, server errors and network failures',async()=>{
 const js=fs.readFileSync(path.join(__dirname,'..','ui.js'),'utf8');
 // Execute the shipped request helper and wrapper, without bootstrapping unrelated DOM.
 const code=js.split('\n').filter(line=>line.startsWith('async function api(')||line.startsWith('function friendlyError(')||line.startsWith('const originalApi=')||line.startsWith('api=async function(')).join('\n');
 let response;
 const context={FormData:class{},fetch:async()=>{if(response instanceof Error)throw response;return{ok:response.status===200,status:response.status,json:async()=>response.data};}};
 vm.createContext(context);vm.runInContext(code+'\nglobalThis.loginApi=api;',context);
 for(const [status,expected] of [[401,/email or password/],[429,/too many attempts/],[500,/could not complete sign-in/],[503,/could not complete sign-in/]]){
  response={status,data:{error:'private_server_details'}};
  await assert.rejects(context.loginApi('/auth/login',{method:'POST',body:{email:'fixture@example.invalid',password:'synthetic-password'}}),err=>{assert.match(err.message,expected);assert.equal(err.status,status);assert.doesNotMatch(err.message,/private_server_details/);return true;});
 }
 response=new Error('offline');await assert.rejects(context.loginApi('/auth/login'),/Check your connection/);
 response={status:200,data:{ok:true}};assert.equal((await context.loginApi('/auth/login')).ok,true);
});
