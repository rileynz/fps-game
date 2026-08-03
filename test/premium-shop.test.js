'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const shop=require(path.join(__dirname,'..','premium-shop'));

function rank(){
  return {
    shards:25,
    ownedCosmetics:{nameColor:['nc_default'],trail:['tr_none'],killFx:['kf_default']},
    equipped:{nameColor:'nc_default',trail:'tr_none',killFx:'kf_default'},
  };
}

test('premium product grants are idempotent',()=>{
  const player=rank();
  assert.equal(shop.grantProduct(player,'supporter_pack','cs_test_one').duplicate,false);
  assert.equal(player.shards,525);
  assert.ok(player.ownedCosmetics.trail.includes('tr_supporter_plasma'));
  assert.equal(shop.grantProduct(player,'supporter_pack','cs_test_one').duplicate,true);
  assert.equal(player.shards,525);
});

test('refunds revoke exclusive items and record unspent shard debt',()=>{
  const player=rank();
  shop.grantProduct(player,'elite_pack','cs_test_elite');
  player.shards=100;
  assert.equal(shop.revokeProduct(player,'elite_pack','cs_test_elite').duplicate,false);
  assert.equal(player.shards,0);
  assert.equal(player.shardDebt,1100);
  assert.equal(player.ownedCosmetics.nameColor.includes('nc_elite_prism'),false);
  shop.applyShardAward(player,1200);
  assert.equal(player.shardDebt,0);
  assert.equal(player.shards,100);
});

test('shared pack cosmetics stay owned while another entitlement is active',()=>{
  const player=rank();
  shop.grantProduct(player,'supporter_pack','cs_supporter');
  shop.grantProduct(player,'elite_pack','cs_elite');
  shop.revokeProduct(player,'elite_pack','cs_elite');
  assert.ok(player.ownedCosmetics.nameColor.includes('nc_supporter_pulse'));
  assert.equal(player.ownedCosmetics.nameColor.includes('nc_elite_prism'),false);
});

test('Shard packs remain repeatable and each purchase can be refunded',()=>{
  const player=rank();
  shop.grantProduct(player,'shards_500','cs_shards_one');
  shop.grantProduct(player,'shards_500','cs_shards_two');
  assert.equal(player.shards,1025);
  assert.equal(player.premiumEntitlements.shards_500,undefined);
  assert.equal(shop.publicProducts({}).find(item=>item.key==='shards_500').repeatable,true);

  assert.equal(shop.revokeProduct(player,'shards_500','cs_shards_one').duplicate,false);
  assert.equal(player.shards,525);
  assert.equal(shop.revokeProduct(player,'shards_500','cs_shards_one').duplicate,true);
  assert.equal(player.shards,525);
  assert.equal(shop.revokeProduct(player,'shards_500','cs_shards_two').duplicate,false);
  assert.equal(player.shards,25);
});

test('Stripe Price IDs remain server-side',()=>{
  const env={STRIPE_PRICE_SUPPORTER:'price_private_123'};
  const publicProduct=shop.publicProducts(env).find(item=>item.key==='supporter_pack');
  assert.equal(publicProduct.configured,true);
  assert.equal(JSON.stringify(publicProduct).includes('price_private_123'),false);
  assert.equal(shop.priceIdFor('supporter_pack',env),'price_private_123');
});
