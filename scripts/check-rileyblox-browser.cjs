'use strict';
// Developer smoke test. Install Playwright and its Chromium, or set CHROMIUM_PATH.
const {chromium}=require('playwright');
const {spawn}=require('node:child_process');
const path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
async function boot(){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['server.js'],{cwd:root,env:{...process.env,PORT:'0',MONGODB_URI:'',PUBLIC_BASE_URL:'',ADMIN_KEY:'browser-test',STRIPE_SECRET_KEY:'',STRIPE_WEBHOOK_SECRET:'',RESEND_API_KEY:''},stdio:['ignore','pipe','pipe']});let logs='';const timeout=setTimeout(()=>{child.kill();reject(Error('Server startup timed out'))},10000);const ondata=b=>{logs+=b;const match=logs.match(/Arena\.io — port (\d+)/);if(match){clearTimeout(timeout);resolve({child,url:'http://127.0.0.1:'+match[1]})}};child.stdout.on('data',ondata);child.stderr.on('data',ondata);child.on('error',reject)});}
(async()=>{const {child,url}=await boot();let browser;try{
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox','--disable-gpu']});
 const context=await browser.newContext({viewport:{width:1366,height:950}});const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const created=await fetch(url+'/api/account/pin-auth',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({name:'BrowserTester',pin:'1234',mode:'create'})});assert.equal(created.status,200);
 await page.goto(url+'/rileyblox/');await page.locator('#loginForm').waitFor();
 await page.locator('#username').fill('BrowserTester');await page.locator('#password').fill('9999');await page.locator('#loginBtn').click();await page.locator('#loginError').filter({hasText:'did not match'}).waitFor();
 await page.locator('#password').fill('1234');await page.locator('#loginBtn').click();await page.locator('#shell').waitFor({state:'visible'});assert.equal(await page.locator('#profileName').innerText(),'BrowserTester');assert.equal(await page.locator('.card').count(),6);
 if(process.env.QA_DIR)await page.screenshot({path:path.join(process.env.QA_DIR,'rileyblox-home.png'),fullPage:true});
 await page.locator('#search').fill('arena');assert.equal(await page.locator('.card').count(),1);await page.locator('#clearSearch').click();
 await page.locator('aside [data-page="avatar"]').click();const saved=page.waitForResponse(r=>r.url().endsWith('/api/rileyblox/profile')&&r.request().method()==='POST');await page.locator('.accessory').filter({hasText:'Duck buddy'}).click();assert.equal((await saved).status(),200);
 if(process.env.QA_DIR)await page.screenshot({path:path.join(process.env.QA_DIR,'rileyblox-avatar.png'),fullPage:true});
 await page.reload();await page.locator('#shell').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>profile.hat),'duck');
 // Arena runs in the launcher with the same authenticated session and no popup.
 const pagesBefore=context.pages().length;await page.locator('.arenaHero [data-play="arena"]').click();
 await page.locator('#arenaLayer').waitFor({state:'visible'});const arenaFrame=await page.locator('#arenaFrame').elementHandle();const gameFrame=await arenaFrame.contentFrame();
 await gameFrame.waitForFunction(()=>typeof sessionAccount!=='undefined'&&sessionAccount.signedIn,{timeout:10000});
 assert.equal(context.pages().length,pagesBefore);assert.equal(await gameFrame.evaluate(()=>sessionAccount.name),'BrowserTester');await gameFrame.locator('#play-btn').click();await gameFrame.waitForFunction(()=>inGame&&myId);await gameFrame.locator('canvas').first().click({position:{x:250,y:250}});await gameFrame.locator('body').press('w');
 await page.locator('#arenaBack').click();await page.locator('#arenaLayer').waitFor({state:'hidden'});assert.equal(await page.locator('#arenaFrame').getAttribute('src'),'about:blank');
 await page.locator('.arenaHero [data-play="arena"]').click();await gameFrame.waitForFunction(()=>typeof sessionAccount!=='undefined'&&sessionAccount.signedIn);
 await gameFrame.locator('a[href="/rileyblox/"]').click();await page.locator('#arenaLayer').waitFor({state:'hidden'});
 // Outfit slots persist through the same cloud-save API.
 await page.locator('aside [data-page="avatar"]').click();let slotSave=page.waitForResponse(r=>r.url().endsWith('/api/rileyblox/profile')&&r.request().method()==='POST');await page.locator('#outfitSlots .outfitSlot').first().getByText('Save look',{exact:true}).click();assert.equal((await slotSave).status(),200);
 await page.reload();await page.locator('#shell').waitFor({state:'visible'});assert.equal(await page.evaluate(()=>profile.outfits[0].hat),'duck');
 // Another window saving newer progress must not silently lose it.
 await page.waitForTimeout(700);const second=await context.newPage();await second.goto(url+'/rileyblox/');await second.locator('#shell').waitFor({state:'visible'});
 await page.locator('aside [data-page="avatar"]').click();const saveA=page.waitForResponse(r=>r.url().endsWith('/api/rileyblox/profile')&&r.request().method()==='POST');await page.locator('.accessory').filter({hasText:'Royal crown'}).click();assert.equal((await saveA).status(),200);
 await second.locator('aside [data-page="avatar"]').click();const saveB=second.waitForResponse(r=>r.url().endsWith('/api/rileyblox/profile')&&r.request().method()==='POST');await second.locator('.accessory').filter({hasText:'Cat ears'}).click();assert.equal((await saveB).status(),409);assert.equal(await second.evaluate(()=>profileConflict),true);await second.locator('aside [data-page="settings"]').click();await second.locator('#reloadArena').click();await second.waitForFunction(()=>profile.hat==='crown');assert.equal(await second.evaluate(()=>profile.hat),'crown');await second.close();
 await page.locator('#logout').click();await page.locator('#login').waitFor({state:'visible'});assert.equal((await context.request.get(url+'/api/rileyblox/profile')).status(),401);
 await page.locator('#mode').selectOption('demo');await page.locator('#loginBtn').click();await page.locator('#shell').waitFor({state:'visible'});
 for(const name of ['Skybound','Lava Shuffle','Meteor Mayhem','Gem Rush','Spin City']){await page.locator('.cardPlay').filter({hasText:name}).click();await page.locator('#gameLayer').waitFor({state:'visible'});await page.keyboard.press('ArrowRight');await page.keyboard.press('Space');await page.keyboard.press('Escape');await page.locator('#overlay').waitFor({state:'visible'});await page.locator('#home').click();}
 // Exercise collisions, shields, cooldowns and course reachability using real game logic.
 await page.evaluate(()=>{
 const check=(v,m)=>{if(!v)throw Error(m)};profile.sound=false;
 start('spinner');state.invulnerable=0;state.p.x=2;state.p.z=0;update(.001);check(state.hearts===2,'Beam removes one heart');update(.001);check(state.hearts===2,'Invulnerability prevents repeated damage');state.invulnerable=0;state.p.y=1;update(.001);check(state.hearts===2,'Jump clears beam');
 start('meteor');state.shield=1;state.meteors=[{x:0,z:0,t:1.04,hit:false}];update(.02);check(!state.finished&&state.shield===0,'Shield absorbs one meteor');state.meteors=[{x:0,z:0,t:1.04,hit:false}];update(.02);check(state.finished,'Second meteor ends unshielded run');
 start('gems');keys={KeyD:true,ShiftLeft:true};update(.01);check(state.dash>2.9&&state.dashTime>0,'Dash starts');keys={};update(.2);check(state.dashTime===0,'Dash expires');
 for(const gem of state.gems){state.p.x=gem.x;state.p.z=gem.z;state.p.y=1;state.invulnerable=99;update(.001)}check(state.collected===25&&state.finished&&state.bestCombo===25,'Gem combos and win');
 const coins=profile.coins;finish(true,'duplicate');check(profile.coins===coins,'No duplicate reward');
 start('obby');update(.001);
 for(let i=1;i<18;i++){
  keys={};update(.001);keys={Space:true};
  for(let tick=0;tick<160&&!state.finished;tick++){
   const a=state.platforms[i],p=state.p,ex=a.x-p.x,ez=a.z-p.z,jump=keys.Space;keys={};if(jump)keys.Space=true;
   if(Math.hypot(ex,ez)>.06){let best=-Infinity,bk={};for(let h=-1;h<=1;h++)for(let v=-1;v<=1;v++){if(!h&&!v)continue;const x=h+v,z=v-h,n=Math.hypot(x,z),dot=(x*ex+z*ez)/n;if(dot>best){best=dot;bk={...(h>0?{KeyD:true}:h<0?{KeyA:true}:{}),...(v>0?{KeyS:true}:v<0?{KeyW:true}:{})}}}Object.assign(keys,bk)}
   update(1/120);if(tick>5&&state.p.ground)break;
  }
  check(state.falls===0&&Math.abs(state.p.x-state.platforms[i].x)<1.2,'Unreachable island '+i);
 }
 check(state.finished,'Course completes');
 start('obby');state.p.ground=false;state.p.y=.005;state.p.vy=-1;keys={Space:true};update(.01);check(state.p.ground,'Buffered jump lands first');update(.01);check(state.p.vy>0,'Jump buffer fires on landing');
 pause();const pausedTime=state.time;update(1);check(state.time===pausedTime,'Paused time stays frozen');check(lavaCycle(55).warning<lavaCycle(0).warning,'Lava difficulty ramps');$('#home').click();
 });
 await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 if(process.env.QA_DIR)await page.screenshot({path:path.join(process.env.QA_DIR,'rileyblox-mobile.png'),fullPage:true});
 // Coarse-pointer controls: held movement and jump release without stuck input.
 const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});const touchPage=await mobile.newPage();touchPage.on('pageerror',e=>errors.push(e.message));await touchPage.goto(url+'/rileyblox/');await touchPage.locator('#mode').selectOption('demo');await touchPage.locator('#loginBtn').click();await touchPage.locator('.newDrop [data-play="spinner"]').click();assert(await touchPage.locator('.touchControls').isVisible());
 const jumpBox=await touchPage.locator('[data-key="Space"]').boundingBox();await touchPage.mouse.move(jumpBox.x+jumpBox.width/2,jumpBox.y+jumpBox.height/2);await touchPage.mouse.down();await touchPage.waitForTimeout(100);assert(await touchPage.evaluate(()=>state.p.y>0));await touchPage.mouse.up();assert.equal(await touchPage.evaluate(()=>!!keys.Space),false);
 const controlsBox=await touchPage.locator('.touchControls').boundingBox(),hintBox=await touchPage.locator('.gameBottom').boundingBox();assert(controlsBox.y+controlsBox.height<=hintBox.y,'Touch controls do not overlap hints');if(process.env.QA_DIR)await touchPage.screenshot({path:path.join(process.env.QA_DIR,'rileyblox-spin-city.png')});await mobile.close();
 assert.deepEqual(errors,[]);console.log('PASS: browser PIN login/errors, 6 cards, search, wardrobe cloud save/reload, embedded Arena session/return, saved outfits, beam/shield/dash/combo collisions, all 17 obby jumps, revision conflicts, logout, all minigames, mobile overflow; no launcher JS errors.');
 }finally{if(browser)await browser.close();child.kill()}})().catch(e=>{console.error(e);process.exitCode=1});
