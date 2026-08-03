'use strict';

// Stripe Price IDs stay in environment variables. The browser only receives
// these public product keys and display details; it never receives a Price ID
// or secret key and therefore cannot choose its own amount.
const PRODUCTS = {
  shards_500: {
    key:'shards_500',
    name:'500 Shards',
    description:'A quick boost for any cosmetics in the Shard shop.',
    priceLabel:'NZ$2.99',
    priceEnv:'STRIPE_PRICE_SHARDS_500',
    accent:'#9b59b6',
    icon:'💎',
    repeatable:true,
    grants:{shards:500,cosmetics:{}},
  },
  shards_1200: {
    key:'shards_1200',
    name:'1,200 Shards',
    description:'Enough for several premium-tier Shard cosmetics.',
    priceLabel:'NZ$5.49',
    priceEnv:'STRIPE_PRICE_SHARDS_1200',
    accent:'#8e44ad',
    icon:'💎',
    repeatable:true,
    grants:{shards:1200,cosmetics:{}},
  },
  shards_2500: {
    key:'shards_2500',
    name:'2,500 Shards',
    description:'Best-value Shard pack for building a full loadout.',
    priceLabel:'NZ$9.99',
    priceEnv:'STRIPE_PRICE_SHARDS_2500',
    accent:'#f39c12',
    icon:'💠',
    repeatable:true,
    grants:{shards:2500,cosmetics:{}},
  },
  supporter_pack: {
    key:'supporter_pack',
    name:'Supporter Pack',
    description:'Pulse name colour, Plasma trail, Shockwave tag and 500 Shards.',
    priceLabel:'NZ$5.99',
    priceEnv:'STRIPE_PRICE_SUPPORTER',
    accent:'#00e5ff',
    icon:'⚡',
    grants:{
      shards:500,
      cosmetics:{
        nameColor:['nc_supporter_pulse'],
        trail:['tr_supporter_plasma'],
        killFx:['kf_supporter_shockwave'],
      },
    },
  },
  elite_pack: {
    key:'elite_pack',
    name:'Arena Elite Pack',
    description:'Both exclusive sets, six cosmetics and 1,200 Shards.',
    priceLabel:'NZ$9.99',
    priceEnv:'STRIPE_PRICE_ELITE',
    accent:'#f39c12',
    icon:'👑',
    grants:{
      shards:1200,
      cosmetics:{
        nameColor:['nc_supporter_pulse','nc_elite_prism'],
        trail:['tr_supporter_plasma','tr_elite_nova'],
        killFx:['kf_supporter_shockwave','kf_elite_arena'],
      },
    },
  },
};

function ensurePremiumState(rank) {
  if (!rank.premiumEntitlements || typeof rank.premiumEntitlements !== 'object') {
    rank.premiumEntitlements={};
  }
  if (!Array.isArray(rank.fulfilledCheckoutIds)) rank.fulfilledCheckoutIds=[];
  if (!Array.isArray(rank.refundedCheckoutIds)) rank.refundedCheckoutIds=[];
  if (!Number.isFinite(Number(rank.shardDebt))) rank.shardDebt=0;
  rank.shardDebt=Math.max(0,Math.floor(Number(rank.shardDebt)));
}

function addUnique(target,values) {
  for (const value of values||[]) if (!target.includes(value)) target.push(value);
}

function grantProduct(rank,productKey,checkoutId,purchasedAt=Date.now()) {
  const product=PRODUCTS[productKey];
  if (!product) return {ok:false,reason:'unknown_product'};
  ensurePremiumState(rank);
  if (rank.fulfilledCheckoutIds.includes(checkoutId)) return {ok:true,duplicate:true};
  rank.fulfilledCheckoutIds.push(checkoutId);
  rank.fulfilledCheckoutIds=rank.fulfilledCheckoutIds.slice(-200);
  // Paid Shards also settle any debt left by an earlier refund. This prevents
  // refund/rebuy cycles from creating currency that was already spent.
  applyShardAward(rank,product.grants.shards);
  for (const [category,ids] of Object.entries(product.grants.cosmetics)) {
    if (!Array.isArray(rank.ownedCosmetics[category])) rank.ownedCosmetics[category]=[];
    addUnique(rank.ownedCosmetics[category],ids);
  }
  // Repeatable currency packs are individual purchases, not permanent
  // entitlements. Recording them as "owned" hid their buy button and made an
  // older purchase impossible to refund after a newer one was made.
  if (!product.repeatable) {
    rank.premiumEntitlements[productKey]={
      checkoutId,
      purchasedAt:new Date(purchasedAt).toISOString(),
      status:'active',
    };
  }
  return {ok:true,duplicate:false};
}

function revokeProduct(rank,productKey,checkoutId,refundedAt=Date.now()) {
  const product=PRODUCTS[productKey];
  if (!product) return {ok:false,reason:'unknown_product'};
  ensurePremiumState(rank);
  if (product.repeatable) {
    if (!rank.fulfilledCheckoutIds.includes(checkoutId)) return {ok:false,reason:'purchase_not_found'};
    if (rank.refundedCheckoutIds.includes(checkoutId)) return {ok:true,duplicate:true};
    rank.refundedCheckoutIds.push(checkoutId);
    rank.refundedCheckoutIds=rank.refundedCheckoutIds.slice(-200);
    const currentShards=Math.max(0,Math.floor(Number(rank.shards)||0));
    const debit=product.grants.shards;
    rank.shards=Math.max(0,currentShards-debit);
    rank.shardDebt+=Math.max(0,debit-currentShards);
    return {ok:true,duplicate:false};
  }
  const entitlement=rank.premiumEntitlements[productKey];
  if (!entitlement||entitlement.checkoutId!==checkoutId||entitlement.status==='refunded') {
    return {ok:true,duplicate:true};
  }
  entitlement.status='refunded';
  entitlement.refundedAt=new Date(refundedAt).toISOString();

  const currentShards=Math.max(0,Math.floor(Number(rank.shards)||0));
  const debit=product.grants.shards;
  rank.shards=Math.max(0,currentShards-debit);
  rank.shardDebt+=Math.max(0,debit-currentShards);

  // A cosmetic can be included in more than one active pack. Only remove it
  // when no other active entitlement still grants it.
  for (const [category,ids] of Object.entries(product.grants.cosmetics)) {
    const stillGranted=new Set();
    for (const [otherKey,otherEntitlement] of Object.entries(rank.premiumEntitlements)) {
      if (otherKey===productKey||otherEntitlement.status!=='active'||!PRODUCTS[otherKey]) continue;
      for (const id of PRODUCTS[otherKey].grants.cosmetics[category]||[]) stillGranted.add(id);
    }
    rank.ownedCosmetics[category]=(rank.ownedCosmetics[category]||[])
      .filter(id=>!ids.includes(id)||stillGranted.has(id));
  }
  return {ok:true,duplicate:false};
}

function applyShardAward(rank,amount) {
  ensurePremiumState(rank);
  let remaining=Math.max(0,Math.floor(Number(amount)||0));
  if (rank.shardDebt>0) {
    const repaid=Math.min(rank.shardDebt,remaining);
    rank.shardDebt-=repaid;
    remaining-=repaid;
  }
  rank.shards=Math.max(0,Math.floor(Number(rank.shards)||0))+remaining;
  return remaining;
}

function publicProducts(env=process.env) {
  return Object.values(PRODUCTS).map(product=>({
    key:product.key,
    name:product.name,
    description:product.description,
    priceLabel:product.priceLabel,
    accent:product.accent,
    icon:product.icon,
    repeatable:product.repeatable===true,
    configured:typeof env[product.priceEnv]==='string'&&env[product.priceEnv].startsWith('price_'),
  }));
}

function priceIdFor(productKey,env=process.env) {
  const product=PRODUCTS[productKey];
  return product&&typeof env[product.priceEnv]==='string'?env[product.priceEnv]:'';
}

module.exports={
  PRODUCTS,
  ensurePremiumState,
  grantProduct,
  revokeProduct,
  applyShardAward,
  publicProducts,
  priceIdFor,
};
