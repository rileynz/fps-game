(function initialiseArenaItch(root){
  'use strict';

  const SERVER_URL='__ARENA_SERVER_URL__';
  const BUILD_VERSION='__ARENA_BUILD_VERSION__';
  const GUEST_NAME_KEY='arena_itch_guest_name';
  const NAME_PARTS=['aero','azur','cyra','evon','jett','kaio','kivo','luma','nori','nyro','nyx','onyx','rynx','sora','vexa','xeno','zelo'];
  let socketRef=null;
  let timerId=null;
  let healthTimerId=null;
  let cycleStartedAt=performance.now();
  let connected=false;
  let gameplayActive=false;
  const inviteListeners=new Set();
  const query=new URLSearchParams(root.location.search);
  const initialParty=String(query.get('party')||'').trim().toUpperCase();
  const initialInviteParams=/^[A-Z0-9]{6}$/.test(initialParty)?{party:initialParty}:null;

  function notifyInvite(params){
    for(const listener of inviteListeners){
      try{listener(params);}catch(error){}
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
    let element=document.getElementById('itch-loading');
    if(element)return element;
    element=document.createElement('section');
    element.id='itch-loading';
    element.setAttribute('role','status');
    element.setAttribute('aria-live','polite');
    element.innerHTML=`
      <div class="itch-loading-grid" aria-hidden="true"></div>
      <div class="itch-orbit itch-orbit-one" aria-hidden="true"></div>
      <div class="itch-orbit itch-orbit-two" aria-hidden="true"></div>
      <div class="itch-loading-card">
        <div class="itch-brand">Arena<span>.io</span></div>
        <div class="itch-kicker">itch.io build</div>
        <div class="itch-core" aria-hidden="true">
          <div class="itch-core-ring"></div>
          <div class="itch-core-dot"></div>
        </div>
        <h1 id="itch-loading-title">Starting Arena.io</h1>
        <p id="itch-loading-status">Preparing the game client…</p>
        <div class="itch-progress" aria-hidden="true"><div id="itch-progress-fill"></div></div>
        <div class="itch-loading-meta">
          <span id="itch-loading-step">CLIENT</span>
          <span id="itch-loading-time">0s elapsed</span>
        </div>
        <p id="itch-loading-tip">Tip: movement and aiming controls can be changed in Settings.</p>
        <button id="itch-loading-retry" type="button">Retry connection</button>
      </div>`;
    document.body.appendChild(element);
    element.querySelector('#itch-loading-retry').addEventListener('click',()=>{
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
    const fill=document.getElementById('itch-progress-fill');
    if(fill)fill.style.width=`${Math.max(4,Math.min(100,value))}%`;
  }

  function showOverlay(){
    const element=overlay();
    element.hidden=false;
    element.classList.remove('itch-ready');
    document.documentElement.classList.add('itch-connecting');
  }

  function hideOverlay(){
    const element=overlay();
    element.classList.add('itch-ready');
    document.documentElement.classList.remove('itch-connecting');
    setTimeout(()=>{
      if(connected)element.hidden=true;
    },520);
  }

  function updateLoadingState(){
    const elapsed=Math.max(0,(performance.now()-cycleStartedAt)/1000);
    setText('itch-loading-time',`${Math.floor(elapsed)}s elapsed`);
    const retry=document.getElementById('itch-loading-retry');
    if(retry)retry.classList.toggle('visible',elapsed>=15);

    if(connected){
      setText('itch-loading-title','Arena ready');
      setText('itch-loading-status','Connected securely. Entering the arena…');
      setText('itch-loading-step','READY');
      setProgress(100);
    }else if(elapsed<1.5){
      setText('itch-loading-title','Starting Arena.io');
      setText('itch-loading-status','Preparing the game client…');
      setText('itch-loading-step','CLIENT');
      setProgress(10+elapsed*12);
    }else if(elapsed<12){
      setText('itch-loading-title','Waking the arena');
      setText('itch-loading-status','The multiplayer server is starting. This can take a moment.');
      setText('itch-loading-step','SERVER');
      setProgress(28+elapsed*3.4);
    }else if(elapsed<25){
      setText('itch-loading-title','Server is nearly ready');
      setText('itch-loading-status','Render is still waking—connection will continue automatically.');
      setText('itch-loading-step','CONNECTING');
      setProgress(69+(elapsed-12)*1.2);
    }else{
      setText('itch-loading-title','Taking longer than usual');
      setText('itch-loading-status','Still retrying. You can wait or retry the connection.');
      setText('itch-loading-step','RETRYING');
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
        setText('itch-loading-status','Server awake. Opening the multiplayer connection…');
        setText('itch-loading-step','SYNCING');
        setProgress(92);
      }
    }catch(error){
      // A sleeping server is expected. Socket.IO continues its own retries.
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
    setText('itch-loading-tip',manualRetry
      ?'Retrying now—your controls and local settings are still saved.'
      :'Tip: the storm closes from a different direction each match.');
    updateLoadingState();
    timerId=setInterval(updateLoadingState,250);
    probeHealth();
  }

  if(document.readyState==='loading'){
    root.addEventListener('DOMContentLoaded',()=>{
      if(!socketRef)startConnectionCycle(false);
    },{once:true});
  }else{
    startConnectionCycle(false);
  }

  function finishConnection(){
    if(connected)return;
    connected=true;
    clearTimeout(healthTimerId);
    updateLoadingState();
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
      setText('itch-loading-title','Connection interrupted');
      setText('itch-loading-status','Reconnecting to the arena automatically…');
      setText('itch-loading-step','RECONNECTING');
    });
    socket.on('connect_error',()=>{
      if((performance.now()-cycleStartedAt)>7000){
        setText('itch-loading-status','The server is still waking. Retrying automatically…');
      }
    });
    if(socket.connected)finishConnection();
  }

  function gameplayStart(){
    gameplayActive=true;
  }

  function gameplayStop(){
    gameplayActive=false;
  }

  function onInviteParams(listener){
    if(typeof listener!=='function')return()=>{};
    inviteListeners.add(listener);
    if(initialInviteParams)queueMicrotask(()=>listener(initialInviteParams));
    return()=>inviteListeners.delete(listener);
  }

  function updateRoom(){
    return Promise.resolve(false);
  }

  function leftRoom(){
    return Promise.resolve(true);
  }

  function inviteLink(){
    return Promise.resolve('');
  }

  root.ArenaPlatform={
    id:'itch',
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
    isAudioForcedMuted:()=>false,
  };
  // The shared client already exposes portal lifecycle hooks through this
  // compatibility object. Keeping that interface avoids changing game logic.
  root.ArenaCrazyGames={
    attachSocket,
    gameplayStart,
    gameplayStop,
    updateRoom,
    leftRoom,
    inviteLink,
    sdkReady:Promise.resolve(true),
  };
})(window);
