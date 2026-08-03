'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const platform=require('../public/platform-commerce');

function environment(platformName,{installed=true,digitalGoods=true}={}){
  return {
    navigatorObject:{userAgentData:{platform:platformName}},
    windowObject:digitalGoods?{getDigitalGoodsService(){}}:{},
    matchMediaFunction(query){
      return {matches:installed&&query==='(display-mode: fullscreen)'};
    },
  };
}

test('Microsoft Store PWA context requires Windows, installation, and Digital Goods',()=>{
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('Windows')),true);
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('Windows',{installed:false})),false);
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('Windows',{digitalGoods:false})),false);
});

test('Chromebooks are not mistaken for the Microsoft Store app',()=>{
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('Chrome OS')),false);
  const contradictory=environment('Windows');
  contradictory.navigatorObject.userAgent='Mozilla/5.0 (X11; CrOS x86_64) Chrome/130';
  assert.equal(platform.isMicrosoftStoreCommerceContext(contradictory),false);
});

test('Premium remains available to macOS and ordinary browser sessions',()=>{
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('macOS')),false);
  const mac=environment('Windows');
  mac.navigatorObject.platform='MacIntel';
  assert.equal(platform.isMicrosoftStoreCommerceContext(mac),false);
  assert.equal(platform.isMicrosoftStoreCommerceContext(environment('Windows',{installed:false})),false);
});

test('installed display detection accepts supported PWA display modes only',()=>{
  assert.equal(platform.installedDisplayMode(query=>({matches:query==='(display-mode: standalone)'})),true);
  assert.equal(platform.installedDisplayMode(()=>({matches:false})),false);
  assert.equal(platform.installedDisplayMode(null),false);
});
