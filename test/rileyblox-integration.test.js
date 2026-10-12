'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const path=require('node:path');
const {defaultProfile,validateProfile,createStore}=require('../rileyblox-integration');
const root=path.join(__dirname,'..');
function boot(){return new Promise((resolve,reject)=>{const fixture=`const fs=require('fs'),Module=require('module'),path=require('path');const file=path.resolve('server.js');let source=fs.readFileSync(file,'utf8');source=source.replace('startServer().catch(err => {',\"(async()=>{const rank=getPlayerRank('SecureTester');const rec=await secureAccounts.hashPassword('ExampleTestPassword123!');rank.secureEmail='secure@example.test';rank.emailVerifiedAt=new Date().toISOString();rank.passwordSalt=rec.salt;rank.passwordHash=rec.hash;await persistRankRecord(rank);await startServer()})().catch(err => {\");const mod=new Module(file,module);mod.filename=file;mod.paths=Module._nodeModulePaths(process.cwd());mod._compile(source,file);`;const child=spawn(process.execPath,['-e',fixture],{cwd:root,env:{...process.env,PORT:'0',MONGODB_URI:'',PUBLIC_BASE_URL:'',ADMIN_KEY:'rileyblox-local-test',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',RESEND_API_KEY:'test-only',EMAIL_FROM:'test@example.test',NODE_ENV:'test',EMAIL_TEST_MODE:'1'},stdio:['ignore','pipe','pipe']});const timer=setTimeout(()=>{child.kill();reject(Error('Startup timeout'))},10000);let logs='';const output=b=>{logs+=b;const m=logs.match(/Arena\.io — port (\d+)/);if(m){clearTimeout(timer);resolve({child,url:'http://127.0.0.1:'+m[1]})}};child.stdout.on('data',output);child.stderr.on('data',output);child.on('error',reject)});}
test('profile schema strips unrelated identity/economy fields and rejects invalid progress',()=>{const p=defaultProfile();p.favourites=['arena'];const clean=validateProfile({...p,accountId:'victim',shards:99999});assert.equal(clean.accountId,undefined);assert.equal(clean.shards,undefined);assert.deepEqual(clean.favourites,['arena']);for(const bad of [{coins:-1},{wins:{arena:1}},{scores:{gems:99}},{recent:['x']},{trail:'x'},{rounds:NaN},{recent:['arena','arena']}])assert.throws(()=>validateProfile({...p,...bad}));});
test('store isolates accounts and rejects stale writes',async()=>{const store=createStore(()=>null);assert.equal(await store.write('one',defaultProfile(),0),true);assert.equal(await store.write('one',{...defaultProfile(),coins:500},0),false);assert.equal(await store.read('two'),null);await store.delete('one');assert.equal(await store.read('one'),null);});
test('Mongo writes use an immutable account key and optimistic revision',async()=>{const calls=[];const collection={updateOne:async(...args)=>{calls.push(args);return {matchedCount:1}},findOne:async q=>({_id:q._id,revision:2}),deleteOne:async q=>calls.push(q)};const store=createStore(()=>({collection:name=>{assert.equal(name,'rileyblox_profiles');return collection}}));await store.write('account-id',defaultProfile(),1);assert.deepEqual(calls[0][0],{_id:'account-id',revision:1});assert.equal(calls[0][2].upsert,false);collection.updateOne=async()=>{throw Object.assign(Error('duplicate'),{code:11000})};assert.equal(await store.write('account-id',defaultProfile(),0),false);});
test('real Arena routes share PIN/password sessions with RileyBlox',{timeout:30000},async t=>{
 const {child,url}=await boot();t.after(()=>child.kill());
 async function req(route,{body,cookie,origin=url}={}){const r=await fetch(url+route,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined});const type=r.headers.get('content-type')||'';return {status:r.status,data:type.includes('json')?await r.json():await r.text(),cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 assert.equal((await req('/rileyblox/')).status,200);assert.equal((await req('/rileyblox/assets/arena-icon.png')).status,200);assert.equal((await req('/api/rileyblox/profile')).status,401);
 let login=await req('/api/account/pin-auth',{body:{name:'LauncherTester',pin:'1234',mode:'create'}});assert.equal(login.status,200);let cookie=login.cookie;
 let loaded=await req('/api/rileyblox/profile',{cookie});assert.equal(loaded.data.account.name,'LauncherTester');assert.equal(loaded.data.account.level,'pin');const id=loaded.data.account.id;const profile={...defaultProfile(),coins:83,hat:'duck',favourites:['arena']};
 let write=await req('/api/rileyblox/profile',{cookie,body:{profile,expectedRevision:0,expectedAccountId:id}});assert.equal(write.status,200);assert.equal(write.data.revision,1);
 assert.equal((await req('/api/rileyblox/profile',{cookie,body:{profile,expectedRevision:0,expectedAccountId:id}})).status,409);
 assert.equal((await req('/api/rileyblox/profile',{cookie,body:{profile,expectedRevision:1,expectedAccountId:'someone-else'}})).status,409);
 assert.equal((await req('/api/rileyblox/profile',{cookie,origin:'https://untrusted.example',body:{profile,expectedRevision:1,expectedAccountId:id}})).status,403);
 let two=await req('/api/account/pin-auth',{body:{name:'OtherTester',pin:'9876',mode:'create'}});assert.equal((await req('/api/rileyblox/profile',{cookie:two.cookie})).data.profile.coins,0);
 assert.equal((await req('/api/account/login',{body:{name:'LauncherTester',password:'wrong'}})).status,401);
 await req('/api/account/logout',{cookie,body:{}});assert.equal((await req('/api/rileyblox/profile',{cookie})).status,401);
 login=await req('/api/account/pin-auth',{body:{name:'LauncherTester',pin:'1234',mode:'login'}});cookie=login.cookie;
 assert.equal((await req('/api/rileyblox/profile',{cookie})).data.profile.hat,'duck');
 let secure=await req('/api/account/login',{body:{name:'SecureTester',password:'ExampleTestPassword123!',remember:true}});assert.equal(secure.status,200);
 let secureLoaded=await req('/api/rileyblox/profile',{cookie:secure.cookie});assert.equal(secureLoaded.data.account.level,'secure');assert.equal(secureLoaded.data.account.name,'SecureTester');
 assert.equal((await req('/api/account/login',{body:{name:'SecureTester',password:'wrong'}})).status,401);
 let removed=await req('/api/account/delete',{cookie,body:{accountName:'LauncherTester',credential:'1234'}});assert.equal(removed.status,200);assert.equal((await req('/api/rileyblox/profile',{cookie})).status,401);
 login=await req('/api/account/pin-auth',{body:{name:'LauncherTester',pin:'1234',mode:'create'}});loaded=await req('/api/rileyblox/profile',{cookie:login.cookie});assert.equal(loaded.data.profile.coins,0);assert.notEqual(loaded.data.account.id,id);
});

test('playground profiles migrate old saves and validate outfits and all six favourites',()=>{
 const old=defaultProfile();delete old.outfits;assert.deepEqual(validateProfile(old).outfits,[]);
 const look={colour:'#123456',skin:'#ffcc66',hat:'duck',face:'happy',back:'wings',trail:'rainbow',shirt:'star'};
 const p={...defaultProfile(),outfits:[look,null,look],scores:{spinner:60},wins:{spinner:1},favourites:['arena','obby','lava','meteor','gems','spinner']};
 const saved=validateProfile(p);assert.deepEqual(saved.outfits,p.outfits);assert.equal(saved.scores.spinner,60);assert.equal(saved.favourites.length,6);
 for(const outfits of [[{...look,hat:'invalid'}],[{...look,colour:'url(javascript:x)'}],[look,look,look,look],'bad'])assert.throws(()=>validateProfile({...p,outfits}));
 assert.equal(validateProfile({...p,outfits:[{...look,accountId:'someone-else'}]}).outfits[0].accountId,undefined);
});
