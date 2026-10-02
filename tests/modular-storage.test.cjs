const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const Database=require('better-sqlite3');
test('production rejects empty and unrelated existing database files before writing schema',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bd-storage-guard-'));
 try {
  for(const kind of ['empty','unrelated']){
   const file=path.join(dir,kind+'.db');
   if(kind==='empty')fs.writeFileSync(file,'');
   else {const db=new Database(file);db.exec('CREATE TABLE unrelated(id INTEGER)');db.close();}
   const before=fs.readFileSync(file);
   const r=spawnSync(process.execPath,['-e',"require('./db').close()"],{cwd:path.resolve(__dirname,'..'),env:{PATH:process.env.PATH,DB_PATH:file,NODE_ENV:'production'},encoding:'utf8'});
   assert.notEqual(r.status,0);
   assert.match(r.stderr,/not a recognized BeautyDesk database/);
   assert.deepEqual(fs.readFileSync(file),before);
   assert.equal(fs.existsSync(file+'-wal'),false);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
