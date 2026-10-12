(function initialiseArenaCrazyGames(root){
  'use strict';

  const SERVER_URL='__ARENA_SERVER_URL__';
  const BUILD_VERSION='__ARENA_BUILD_VERSION__';
  const GUEST_NAME_KEY='arena_cg_guest_name';
  const NAME_PARTS=['aero','azur','cyra','evon','jett','kaio','kivo','luma','nori','nyro','nyx','onyx','rynx','sora','vexa','xeno','zelo'];
  let socketRef=null;
  let timerId=null;
  let healthTimerId=null;
  let cycleStartedAt=performance.now();
  let connected=false;
  let gameplayActive=false;
  let audioForcedMuted=false;
  let sdkInitialised=false;
  let instantMultiplayer=false;
  let initialInviteParams=null;
  const inviteListeners=new Set();

  function notifyInvite(params){
    const safe=params&&typeof params==='object'?params:{};
    for(const listener of inviteListeners){
      try{listener(safe);}catch(error){}
    }
  }

  function randomInt(max){
    if(root.crypto&&typeof root.crypto.getRandomValues==='function'){
      const values=new Uint32Array(1);
      root.crypto.getRandomValues(values);
      return values[0]%max;
    }
    return Math.floor(Math.random()*max);
  }

  function cleanGuestName(value){
    const clean=String(value||'').toLowerCase().replace(/[^a-z0-9_-]/g,'').slice(0,16);
    return clean.length>=3?clean:'';
  }

  function readStoredName(){
    try{return cleanGuestName(root.localStorage.getItem(GUEST_NAME_KEY));}
    catch(error){return '';}
  }

  function createGuestName(){
    const base=NAME_PARTS[randomInt(NAME_PARTS.length)];
    const suffix=(10+randomInt(90)).toString(36);
    const name=`${base}${suffix}`.slice(0,16);
    try{root.localStorage.setItem(GUEST_NAME_KEY,name);}catch(error){}
    return name;
  }

  function getGuestName(){
    return readStoredName()||createGuestName();
  }

  function nextGuestName(){
    return createGuestName();
  }

  function overlay(){
    let element=document.getElementById('cg-loading');
    if(element)return element;
    element=document.createElement('section');
    element.id='cg-loading';
    element.setAttribute('role','status');
    element.setAttribute('aria-live','polite');
    element.innerHTML=`
      <div class="cg-loading-grid" aria-hidden="true"></div>
      <div class="cg-orbit cg-orbit-one" aria-hidden="true"></div>
      <div class="cg-orbit cg-orbit-two" aria-hidden="true"></div>
      <div class="cg-loading-card">
        <div class="cg-brand">Arena<span>.io</span></div>
        <div class="cg-kicker">Ricochet combat online</div>
        <div class="cg-core" aria-hidden="true">
          <div class="cg-core-ring"></div>
          <div class="cg-core-dot"></div>
        </div>
        <h1 id="cg-loading-title">Starting Arena.io</h1>
        <p id="cg-loading-status">Preparing the game client…</p>
        <div class="cg-progress" aria-hidden="true"><div id="cg-progress-fill"></div></div>
        <div class="cg-loading-meta">
          <span id="cg-loading-step">CLIENT</span>
          <span id="cg-loading-time">0s elapsed</span>
        </div>
        <p id="cg-loading-tip">Tip: keep moving while you aim—standing still makes you an easy target.</p>
        <button id="cg-loading-retry" type="button">Retry connection</button>
      </div>`;
    document.body.appendChild(element);
    element.querySelector('#cg-loading-retry').addEventListener('click',()=>{
      startConnectionCycle(true);
      if(socketRef){
        try{socketRef.disconnect();}catch(error){}
        try{socketRef.connect();}catch(error){}
      }
    });
    return element;
  }

  function setText(id,value){
    const element=document.getElementById(id);
    if(element)element.textContent=value;
  }

  function setProgress(value){
    const fill=document.getElementById('cg-progress-fill');
    if(fill)fill.style.width=`${Math.max(4,Math.min(100,value))}%`;
  }

  function showOverlay(){
    const element=overlay();
    element.hidden=false;
    element.classList.remove('cg-ready');
    document.documentElement.classList.add('cg-connecting');
  }

  function hideOverlay(){
    const element=overlay();
    element.classList.add('cg-ready');
    document.documentElement.classList.remove('cg-connecting');
    setTimeout(()=>{
      if(connected)element.hidden=true;
    },520);
  }

  function updateLoadingState(){
    const elapsed=Math.max(0,(performance.now()-cycleStartedAt)/1000);
    const seconds=Math.floor(elapsed);
    setText('cg-loading-time',`${seconds}s elapsed`);
    const retry=document.getElementById('cg-loading-retry');
    if(retry)retry.classList.toggle('visible',elapsed>=15);

    if(connected){
      setText('cg-loading-title','Arena ready');
      setText('cg-loading-status','Connected securely. Entering the arena…');
      setText('cg-loading-step','READY');
      setProgress(100);
      return;
    }
    if(elapsed<1.5){
      setText('cg-loading-title','Starting Arena.io');
      setText('cg-loading-status','Preparing the game client…');
      setText('cg-loading-step','CLIENT');
      setProgress(10+elapsed*12);
    }else if(elapsed<12){
      setText('cg-loading-title','Waking the arena');
      setText('cg-loading-status','The game server is starting. This can take a moment.');
      setText('cg-loading-step','SERVER');
      setProgress(28+elapsed*3.4);
    }else if(elapsed<25){
      setText('cg-loading-title','Server is nearly ready');
      setText('cg-loading-status','Render is still waking—your connection will continue automatically.');
      setText('cg-loading-step','CONNECTING');
      setProgress(69+(elapsed-12)*1.2);
    }else{
      setText('cg-loading-title','Taking longer than usual');
      setText('cg-loading-status','We are still retrying. You can wait or retry the connection.');
      setText('cg-loading-step','RETRYING');
      setProgress(88);
    }
  }

  async function probeHealth(){
    if(connected)return;
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),7000);
    try{
      const response=await fetch(`${SERVER_URL}/api/health`,{
        cache:'no-store',
        mode:'cors',
        signal:controller.signal,
      });
      if(response.ok&&!connected){
        setText('cg-loading-status','Server awake. Opening the multiplayer connection…');
        setText('cg-loading-step','SYNCING');
        setProgress(92);
      }
    }catch(error){
      // Socket.IO continues retrying. A sleeping server or temporary network
      // failure is expected here and should not produce a scary error screen.
    }finally{
      clearTimeout(timeout);
      if(!connected)healthTimerId=setTimeout(probeHealth,3500);
    }
  }

  function startConnectionCycle(manualRetry=false){
    connected=false;
    cycleStartedAt=performance.now();
    clearInterval(timerId);
    clearTimeout(healthTimerId);
    showOverlay();
    setText('cg-loading-tip',manualRetry
      ?'Retrying now—your game settings are still saved.'
      :'Tip: bank a shot off a wall to earn bonus points.');
    updateLoadingState();
    timerId=setInterval(updateLoadingState,250);
    probeHealth();
  }

  async function initSdk(){
    try{
      const sdk=root.CrazyGames&&root.CrazyGames.SDK;
      if(!sdk)return false;
      await sdk.init();
      sdkInitialised=true;
      instantMultiplayer=sdk.game&&sdk.game.isInstantMultiplayer===true;
      if(sdk.game&&typeof sdk.game.loadingStart==='function')sdk.game.loadingStart();
      initialInviteParams=sdk.game&&sdk.game.inviteParams&&typeof sdk.game.inviteParams==='object'
        ?sdk.game.inviteParams
        :null;
      if(initialInviteParams)notifyInvite(initialInviteParams);
      if(sdk.game&&typeof sdk.game.addJoinRoomListener==='function'){
        sdk.game.addJoinRoomListener(params=>notifyInvite(params));
      }

      const applySettings=settings=>{
        audioForcedMuted=!!(settings&&settings.muteAudio);
        if(root.SoundFX&&typeof root.SoundFX.ready==='function')root.SoundFX.ready();
      };
      applySettings(sdk.game&&sdk.game.settings);
      if(sdk.game&&typeof sdk.game.addSettingsChangeListener==='function'){
        sdk.game.addSettingsChangeListener(applySettings);
      }
      return true;
    }catch(error){
      console.warn('[Arena.io] CrazyGames SDK could not initialise:',error);
      return false;
    }
  }

  const sdkReady=initSdk();

  // Render the connection screen as soon as the document is ready. Normally the
  // game client calls attachSocket during the same load, but this fallback gives
  // players immediate feedback even if a future client startup regression occurs.
  if(document.readyState==='loading'){
    root.addEventListener('DOMContentLoaded',()=>{
      if(!socketRef)startConnectionCycle(false);
    },{once:true});
  }else{
    startConnectionCycle(false);
  }

  async function finishConnection(){
    if(connected)return;
    connected=true;
    clearTimeout(healthTimerId);
    updateLoadingState();
    const sdkAvailable=await Promise.race([
      sdkReady,
      new Promise(resolve=>setTimeout(()=>resolve(false),1200)),
    ]);
    if(sdkAvailable){
      try{
        const game=root.CrazyGames.SDK.game;
        if(typeof game.loadingStop==='function')game.loadingStop();
      }catch(error){}
    }
    setTimeout(()=>{
      clearInterval(timerId);
      hideOverlay();
    },360);
  }

  function attachSocket(socket){
    socketRef=socket;
    startConnectionCycle(false);
    if(!socket||typeof socket.on!=='function')return;
    socket.on('connect',finishConnection);
    socket.on('disconnect',()=>{
      gameplayStop();
      startConnectionCycle(false);
      setText('cg-loading-title','Connection interrupted');
      setText('cg-loading-status','Reconnecting to the arena automatically…');
      setText('cg-loading-step','RECONNECTING');
    });
    socket.on('connect_error',()=>{
      if((performance.now()-cycleStartedAt)>7000){
        setText('cg-loading-status','The server is still waking. Retrying automatically…');
      }
    });
    if(socket.connected)finishConnection();
  }

  function gameplayStart(){
    if(gameplayActive)return;
    gameplayActive=true;
    if(!sdkInitialised)return;
    try{root.CrazyGames.SDK.game.gameplayStart();}catch(error){}
  }

  function gameplayStop(){
    if(!gameplayActive)return;
    gameplayActive=false;
    if(!sdkInitialised)return;
    try{root.CrazyGames.SDK.game.gameplayStop();}catch(error){}
  }

  async function updateRoom(roomData){
    const available=await sdkReady;
    if(!available||!roomData||typeof roomData.roomId!=='string')return false;
    try{
      root.CrazyGames.SDK.game.updateRoom({
        roomId:roomData.roomId,
        isJoinable:roomData.isJoinable===true,
        inviteParams:roomData.inviteParams&&typeof roomData.inviteParams==='object'
          ?roomData.inviteParams
          :{},
      });
      return true;
    }catch(error){
      console.warn('[Arena.io] CrazyGames room update failed:',error);
      return false;
    }
  }

  async function leftRoom(){
    const available=await sdkReady;
    if(!available)return false;
    try{
      root.CrazyGames.SDK.game.leftRoom();
      return true;
    }catch(error){
      return false;
    }
  }

  async function inviteLink(params){
    const available=await sdkReady;
    if(!available)return '';
    try{
      const result=await root.CrazyGames.SDK.game.inviteLink(
        params&&typeof params==='object'?params:{},
      );
      return typeof result==='string'?result:'';
    }catch(error){
      return '';
    }
  }

  async function showInviteButton(params){
    const available=await sdkReady;
    if(!available)return false;
    try{
      const game=root.CrazyGames.SDK.game;
      if(typeof game.showInviteButton!=='function')return false;
      game.showInviteButton(params&&typeof params==='object'?params:{});
      return true;
    }catch(error){return false;}
  }

  async function hideInviteButton(){
    const available=await sdkReady;
    if(!available)return false;
    try{
      const game=root.CrazyGames.SDK.game;
      if(typeof game.hideInviteButton!=='function')return false;
      game.hideInviteButton();
      return true;
    }catch(error){return false;}
  }

  function onInviteParams(listener){
    if(typeof listener!=='function')return()=>{};
    inviteListeners.add(listener);
    if(initialInviteParams)queueMicrotask(()=>listener(initialInviteParams));
    return()=>inviteListeners.delete(listener);
  }

  root.ArenaPlatform={
    id:'crazygames',
    buildVersion:BUILD_VERSION,
    socketUrl:SERVER_URL,
    guestOnly:true,
    accountsEnabled:false,
    shopEnabled:false,
    chatEnabled:false,
    disableCustomFullscreen:true,
    getGuestName,
    nextGuestName,
    getInitialInviteParams:()=>initialInviteParams,
    onInviteParams,
    isAudioForcedMuted:()=>audioForcedMuted,
  };
  root.ArenaCrazyGames={
    attachSocket,
    gameplayStart,
    gameplayStop,
    updateRoom,
    leftRoom,
    inviteLink,
    showInviteButton,
    hideInviteButton,
    isInstantMultiplayer:()=>instantMultiplayer,
    sdkReady,
  };
})(window);
