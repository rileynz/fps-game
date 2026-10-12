'use strict';
// Arena owns authentication. This module only stores separate launcher progress.
const GAME_IDS=['obby','lava','meteor','gems','spinner'];
const CATALOG_IDS=[...GAME_IDS,'arena'];
const OPTIONS={hat:['none','cap','crown','cat','headphones','propeller','duck','wizard','tophat'],face:['smile','cool','happy','wink','robot'],back:['none','pack','wings','cape','rocket'],trail:['none','rainbow','stars','bubbles','fire'],shirt:['plain','star','stripe','bolt']};
function defaultProfile(){return {coins:0,colour:'#37a0f6',skin:'#ffcc66',hat:'none',face:'smile',back:'none',trail:'none',shirt:'star',scores:{},wins:{},rounds:0,totalGems:0,favourites:[],recent:[],sound:true,particles:true,outfits:[]};}
function validInteger(n,max=100000000){return Number.isSafeInteger(n)&&n>=0&&n<=max;}
function validateProfile(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('invalid_profile');
 const p=defaultProfile();
 for(const k of ['coins','rounds','totalGems']){if(!validInteger(input[k]))throw Error('invalid_'+k);p[k]=input[k];}
 for(const k of ['colour','skin']){if(typeof input[k]!=='string'||!/^#[a-f0-9]{6}$/i.test(input[k]))throw Error('invalid_'+k);p[k]=input[k];}
 for(const [k,choices] of Object.entries(OPTIONS)){if(!choices.includes(input[k]))throw Error('invalid_'+k);p[k]=input[k];}
 for(const k of ['scores','wins']){
  const obj=input[k];if(!obj||typeof obj!=='object'||Array.isArray(obj))throw Error('invalid_'+k);
  for(const [id,value] of Object.entries(obj)){
   if(!GAME_IDS.includes(id)||typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000||(k==='wins'&&!Number.isSafeInteger(value))||(k==='scores'&&id==='gems'&&value>25))throw Error('invalid_'+k);
   p[k][id]=value;
  }
 }
 for(const k of ['favourites','recent']){const a=input[k];if(!Array.isArray(a)||a.length>6||a.some(id=>!CATALOG_IDS.includes(id))||new Set(a).size!==a.length)throw Error('invalid_'+k);p[k]=[...a];}
 for(const k of ['sound','particles']){if(typeof input[k]!=='boolean')throw Error('invalid_'+k);p[k]=input[k];}
 if(input.outfits!==undefined){
  if(!Array.isArray(input.outfits)||input.outfits.length>3)throw Error('invalid_outfits');
  p.outfits=input.outfits.map(o=>{if(o===null)return null;if(!o||typeof o!=='object'||Array.isArray(o))throw Error('invalid_outfit');const look={};for(const k of ['colour','skin']){if(typeof o[k]!=='string'||!/^#[a-f0-9]{6}$/i.test(o[k]))throw Error('invalid_outfit');look[k]=o[k]}for(const [k,choices] of Object.entries(OPTIONS)){if(!choices.includes(o[k]))throw Error('invalid_outfit');look[k]=o[k]}return look;});
 }
 // Ignore all unknown fields, especially accountId, rank, shards and purchase data.
 return p;
}
function createStore(getDB){
 const memory=new Map();
 return {
  async read(accountId){const db=getDB();return db?await db.collection('rileyblox_profiles').findOne({_id:accountId}):memory.get(accountId)||null;},
  async write(accountId,profile,expectedRevision){
   const db=getDB();
   if(!db){const old=memory.get(accountId);if((old?.revision||0)!==expectedRevision)return false;memory.set(accountId,{_id:accountId,profile,revision:expectedRevision+1});return true;}
   try{const result=await db.collection('rileyblox_profiles').updateOne({_id:accountId,revision:expectedRevision},{$set:{profile,updatedAt:new Date()},$inc:{revision:1}},{upsert:expectedRevision===0});return !!(result.matchedCount||result.upsertedCount);}catch(e){if(e.code===11000)return false;throw e;}
  },
  async delete(accountId){memory.delete(accountId);const db=getDB();if(db)await db.collection('rileyblox_profiles').deleteOne({_id:accountId});}
 };
}
function mountRileyBlox(app,{getDB,requireSameOrigin,requireAccountSession,sessionAccountSummary}){
 const store=createStore(getDB);
 const noCache=(req,res,next)=>{res.set('Cache-Control','no-store');next();};
 app.get('/api/rileyblox/profile',noCache,requireAccountSession,async(req,res)=>{
  try{
   const session=req.accountSession,record=await store.read(session.accountId);
   const summary=sessionAccountSummary(session);
   res.json({ok:true,account:{...summary,id:session.accountId},profile:record?.profile||defaultProfile(),revision:record?.revision||0,storage:getDB()?'mongodb':'memory'});
  }catch{res.status(503).json({ok:false,reason:'profile_unavailable'});}
 });
 app.post('/api/rileyblox/profile',requireSameOrigin,requireAccountSession,async(req,res)=>{
  if(req.body?.expectedAccountId!==req.accountSession.accountId)return res.status(409).json({ok:false,reason:'account_changed'});
  let profile;const revision=req.body?.expectedRevision;
  try{profile=validateProfile(req.body?.profile);if(!validInteger(revision))throw Error('invalid_revision');}catch(e){return res.status(400).json({ok:false,reason:e.message});}
  try{
   const ok=await store.write(req.accountSession.accountId,profile,revision);
   if(!ok)return res.status(409).json({ok:false,reason:'profile_conflict'});
   res.json({ok:true,revision:revision+1,storage:getDB()?'mongodb':'memory'});
  }catch{res.status(503).json({ok:false,reason:'profile_unavailable'});}
 });
 return store;
}
module.exports={mountRileyBlox,defaultProfile,validateProfile,createStore};
