'use strict';

function safeText(value,fallback='') {
  return String(value??fallback).replace(/[\u0000-\u001f\u007f]/g,' ').trim();
}

function formatAmount(amountMinor,currency='nzd') {
  const amount=Number(amountMinor);
  const code=safeText(currency,'nzd').toUpperCase();
  if (!Number.isFinite(amount)||!/^[A-Z]{3}$/.test(code)) return 'Payment received';
  if (code==='NZD') return `NZ$${(amount/100).toFixed(2)}`;
  try{
    return new Intl.NumberFormat('en-NZ',{
      style:'currency',
      currency:code,
      minimumFractionDigits:2,
    }).format(amount/100);
  }catch{
    return `${code} ${(amount/100).toFixed(2)}`;
  }
}

function deliveredSummary(product) {
  const grants=product&&product.grants||{};
  const parts=[];
  const shards=Math.max(0,Math.floor(Number(grants.shards)||0));
  if (shards) parts.push(`${shards.toLocaleString('en-NZ')} Shards`);
  const cosmeticCount=Object.values(grants.cosmetics||{})
    .reduce((total,items)=>total+(Array.isArray(items)?items.length:0),0);
  if (cosmeticCount) parts.push(`${cosmeticCount} exclusive cosmetic${cosmeticCount===1?'':'s'}`);
  return parts.join(' and ')||'Your purchased Arena.io content';
}

function buildPurchaseReceipt({playerName,product,checkout}) {
  if (!product||!checkout||!safeText(checkout.id)) throw new Error('invalid_receipt_data');
  const name=safeText(playerName,'Player').slice(0,32)||'Player';
  const productName=safeText(product.name,'Arena.io purchase').slice(0,100);
  const reference=safeText(checkout.id).slice(0,160);
  const created=Number(checkout.created);
  const purchasedAt=Number.isFinite(created)&&created>0
    ?new Date(created*1000).toISOString().replace('T',' ').replace('.000Z',' UTC')
    :new Date().toISOString().replace('T',' ').replace('.000Z',' UTC');
  const amount=formatAmount(checkout.amount_total,checkout.currency);
  const delivered=deliveredSummary(product);
  return{
    subject:`Arena.io purchase confirmed — ${productName}`,
    text:[
      `Hi ${name},`,
      '',
      'Your Arena.io purchase was successful and has been delivered to your account.',
      '',
      `Product: ${productName}`,
      `Amount: ${amount}`,
      `Delivered: ${delivered}`,
      `Purchased: ${purchasedAt}`,
      `Reference: ${reference}`,
      '',
      'Keep this email as confirmation of your purchase.',
      '',
      'Arena.io',
      'This is an automated purchase confirmation sent to your verified account email.',
    ].join('\n'),
  };
}

module.exports={formatAmount,deliveredSummary,buildPurchaseReceipt};
