'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const receipts=require('../purchase-receipts');

const server=fs.readFileSync(path.join(__dirname,'..','server.js'),'utf8');

test('purchase confirmation contains useful details without claiming to be a tax invoice',()=>{
  const receipt=receipts.buildPurchaseReceipt({
    playerName:'riley7',
    product:{
      name:'Supporter Pack',
      grants:{
        shards:500,
        cosmetics:{nameColor:['pulse'],trail:['plasma'],killFx:['shockwave']},
      },
    },
    checkout:{
      id:'cs_test_receipt123',
      amount_total:599,
      currency:'nzd',
      created:1785272400,
    },
  });
  assert.equal(receipt.subject,'Arena.io purchase confirmed — Supporter Pack');
  assert.match(receipt.text,/Hi riley7,/);
  assert.match(receipt.text,/Amount: NZ\$5\.99/);
  assert.match(receipt.text,/Delivered: 500 Shards and 3 exclusive cosmetics/);
  assert.match(receipt.text,/Reference: cs_test_receipt123/);
  assert.doesNotMatch(receipt.text,/tax invoice/i);
});

test('receipt builder handles currency packs and invalid payment totals safely',()=>{
  assert.equal(receipts.formatAmount(299,'nzd'),'NZ$2.99');
  assert.equal(receipts.formatAmount(undefined,'nzd'),'Payment received');
  assert.equal(receipts.deliveredSummary({grants:{shards:2500,cosmetics:{}}}),'2,500 Shards');
  assert.throws(()=>receipts.buildPurchaseReceipt({product:{},checkout:{}}),/invalid_receipt_data/);
});

test('fulfilled purchases email the verified account through the purchases sender',()=>{
  assert.match(server,/PURCHASE_EMAIL_FROM=process\.env\.PURCHASE_EMAIL_FROM\|\|'Arena\.io Purchases <purchases@mail\.rileybylsma\.tech>'/);
  assert.match(server,/to:rank\.secureEmail/);
  assert.match(server,/from:PURCHASE_EMAIL_FROM/);
  assert.match(server,/idempotencyKey:`purchase-receipt-\$\{checkout\.id\}`/);
  assert.match(server,/receiptEmailSentAt:new Date\(\)/);
});

test('receipt failure preserves fulfillment and asks Stripe to retry safely',()=>{
  assert.match(server,/let receiptError=null/);
  assert.match(server,/return \{\.\.\.grant,receiptError\}/);
  assert.match(server,/if \(fulfillment\.receiptError\) throw fulfillment\.receiptError/);
  assert.match(server,/fulfilledCheckoutIds\.includes\(checkout\.id\)/);
});
