'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const client=fs.readFileSync(path.join(root,'public','index.html'),'utf8');

test('Stripe webhook signature sees the raw request body before JSON parsing',()=>{
  const webhook=server.indexOf("app.post('/api/shop/stripe-webhook',express.raw");
  const json=server.indexOf("app.use(express.json");
  assert.ok(webhook>=0&&json>webhook);
  assert.match(server,/stripe\.webhooks\.constructEvent\(req\.body,req\.get\('stripe-signature'\),STRIPE_WEBHOOK_SECRET\)/);
});

test('premium fulfillment validates server metadata and configured Price ID',()=>{
  assert.match(server,/checkout\.metadata\?\.accountId!==req\.accountSession\.accountId/);
  assert.match(server,/checkout_price_mismatch/);
  assert.match(server,/fulfilledCheckoutIds\.includes\(checkout\.id\)/);
  assert.match(server,/idempotencyKey:`checkout-\$\{rank\.accountId\}-\$\{productKey\}-\$\{checkoutRequestId\}`/);
});

test('paid purchases require a verified secure account session',()=>{
  assert.match(server,/app\.post\('\/api\/shop\/checkout',requireSameOrigin,requireSecureSession/);
  assert.match(server,/customer_email:rank\.secureEmail/);
  assert.match(server,/client_reference_id:rank\.accountId/);
  assert.match(client,/credentials:'include'/);
  assert.match(client,/resumeSecureSession/);
  assert.doesNotMatch(client,/safeStorage\.set\(pinKey/);
});

test('the Shop adds Premium without adding another main-menu button',()=>{
  assert.match(client,/id="shoptab-premium"/);
  assert.match(client,/id="shop-account-bar"/);
  assert.match(client,/buyPremiumProduct/);
  assert.match(client,/ArenaPlatformCommerce\.isMicrosoftStoreCommerceContext\(\)/);
  assert.equal((client.match(/id="btn-shop"/g)||[]).length,1);
});

test('secured accounts are not incorrectly treated as missing a PIN',()=>{
  assert.match(client,/if\(!account\.hasPin&&!account\.secured\)/);
  assert.doesNotMatch(client,/if\(!account\.hasPin\)\{\s*button\.textContent='Create a PIN by playing first'/);
});

test('main menu exposes one compact account hub without another tool-grid tile',()=>{
  assert.equal((client.match(/id="menu-account-btn"/g)||[]).length,1);
  assert.match(client,/class="name-account-row"/);
  assert.match(client,/id="menu-account-signin"/);
  assert.match(client,/id="menu-account-create"/);
  assert.match(client,/id="menu-account-guest"/);
  assert.match(client,/id="menu-account-signout"/);
  assert.equal((client.match(/id="menu-account-btn"[^>]*class="menu-tools"/g)||[]).length,0);
});

test('browser and socket account sessions stay synchronized',()=>{
  assert.match(server,/socket\.on\('getSessionAccount'/);
  assert.match(server,/socket\.emit\('sessionAccount',sessionAccountSummary\(socket\.data\.accountSession\)\)/);
  assert.match(server,/socket\.on\('logoutAccount'/);
  assert.match(client,/apiRequest\('\/api\/account\/logout'/);
  assert.match(client,/emitWithAck\('logoutAccount',\{\}\)/);
  assert.match(client,/socket\.on\('sessionAccount'/);
  assert.match(client,/socket\.emit\('getSessionAccount'\)/);
});

test('account switching leaves the old room and waits for socket confirmation',()=>{
  assert.match(server,/function leaveCurrentRoom\(reason='leave'\)/);
  assert.match(server,/socket\.on\('leaveGame'/);
  assert.match(server,/socket\.leave\(`room:\$\{room\.id\}`\)/);
  assert.match(server,/socket\.on\('logoutAccount'.*leaveCurrentRoom\('account_logout'\)/s);
  assert.match(server,/playerNameKey\(joinedPlayer\.name\)!==record\.nameKey.*leaveCurrentRoom\('account_switch'\)/s);
  assert.match(client,/id="menu-account-switch"/);
  assert.match(client,/await emitWithAck\('logoutAccount',\{\}\)/);
  assert.match(client,/data\.reason==='already_joined'.*emitWithAck\('leaveGame',\{\}\).*actuallyJoin\(name,true\)/s);
});

test('Shop responses are bound to the player identity that requested them',()=>{
  assert.match(server,/playerName:rank\.name/);
  assert.match(client,/socket\.on\('shopState'.*data\.playerName.*getCurrentPlayerName\(\)\.toLowerCase\(\)/s);
  assert.match(client,/socket\.on\('shopResult'.*result\.shop\.playerName.*getCurrentPlayerName\(\)\.toLowerCase\(\)/s);
});

test('new names can create an account before playing or explicitly continue as guest',()=>{
  assert.match(client,/New player name — create an account to protect it, or play as a guest\./);
  assert.match(client,/if\(afterAuth==='join'\)actuallyJoin\(name\)/);
  assert.match(client,/showPinModal\('create',name,pinFlow\.afterAuth\)/);
});
