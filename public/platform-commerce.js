'use strict';

(function exposePlatformCommerce(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.ArenaPlatformCommerce=api;
})(typeof globalThis!=='undefined'?globalThis:this,function createPlatformCommerce(){
  function platformLabel(navigatorObject){
    const nav=navigatorObject||{};
    return String(
      nav.userAgentData&&nav.userAgentData.platform
      ||nav.platform
      ||nav.userAgent
      ||''
    );
  }

  function platformSignals(navigatorObject){
    const nav=navigatorObject||{};
    return [nav.userAgentData&&nav.userAgentData.platform,nav.platform,nav.userAgent]
      .filter(value=>typeof value==='string'&&value.trim())
      .map(value=>value.trim());
  }

  function installedDisplayMode(matchMediaFunction){
    if(typeof matchMediaFunction!=='function')return false;
    return ['standalone','fullscreen','minimal-ui'].some(mode=>{
      try{return !!matchMediaFunction(`(display-mode: ${mode})`).matches;}
      catch{return false;}
    });
  }

  function isMicrosoftStoreCommerceContext(environment={}){
    const win=environment.windowObject
      ||(typeof window!=='undefined'?window:null)
      ||{};
    const nav=environment.navigatorObject
      ||(typeof navigator!=='undefined'?navigator:null)
      ||{};
    const match=environment.matchMediaFunction
      ||(typeof win.matchMedia==='function'?win.matchMedia.bind(win):null);

    const signals=platformSignals(nav);
    const hasWindowsSignal=signals.some(value=>/windows|win32|win64/i.test(value));
    // Chromium-derived browsers can expose Digital Goods outside Microsoft
    // Store. A contradictory ChromeOS/macOS/Linux signal always wins so those
    // devices never lose Arena's normal Premium checkout.
    const hasOtherDeviceSignal=signals.some(value=>/cros|chrome\s*os|macintosh|macintel|mac\s*os|iphone|ipad|android|linux/i.test(value));
    const isWindows=hasWindowsSignal&&!hasOtherDeviceSignal;
    const hasDigitalGoods=typeof win.getDigitalGoodsService==='function';
    return isWindows&&hasDigitalGoods&&installedDisplayMode(match);
  }

  return {platformLabel,platformSignals,installedDisplayMode,isMicrosoftStoreCommerceContext};
});
