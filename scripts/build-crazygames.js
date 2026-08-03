#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const zlib=require('zlib');
const vm=require('vm');

const projectRoot=path.resolve(__dirname,'..');
const platformRoot=path.join(projectRoot,'platform','crazygames');
const outputRoot=path.join(projectRoot,'builds','crazygames');
const configPath=path.join(platformRoot,'config.json');
const packagePath=path.join(projectRoot,'package.json');

function replaceRequired(source,search,replacement,label){
  if(!source.includes(search)){
    throw new Error(`Could not prepare CrazyGames build: ${label} was not found in public/index.html.`);
  }
  return source.replace(search,replacement);
}

function transformIndex(source){
  let output=source;
  output=replaceRequired(
    output,
    '<html lang="en">',
    '<html lang="en" data-platform="crazygames">',
    'the root HTML element',
  );
  output=replaceRequired(output,'<title>Arena.io</title>','<title>Arena.io: Ricochet</title>','the game title');

  output=output
    .replace(/^[ \t]*<link rel="manifest"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link rel="apple-touch-icon"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link rel="preconnect" href="https:\/\/fonts\.[^"]+"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link href="https:\/\/fonts\.googleapis\.com[^"]+"[^>]*>\r?\n/gm,'');

  output=replaceRequired(
    output,
    '</head>',
    [
      '<link rel="stylesheet" href="./crazygames.css">',
      '<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>',
      '<script src="./crazygames-adapter.js"></script>',
      '</head>',
    ].join('\n'),
    'the closing head tag',
  );
  output=replaceRequired(
    output,
    '<script src="/socket.io/socket.io.js"></script>',
    '<script src="./socket.io.min.js"></script>',
    'the Socket.IO client tag',
  );
  output=replaceRequired(
    output,
    '<script src="/platform-commerce.js"></script>\n',
    '',
    'the web commerce adapter tag',
  );

  // Chat is disabled for the initial portal launch. Keep the hint element in the
  // DOM because the shared settings code updates it during startup, but hide it
  // so the unavailable feature is not advertised.
  output=output.replace(
    /(\s*)<b id="menu-chat-hint">Enter<\/b> opens player chat<br>(\r?\n)/,
    '$1<span hidden><b id="menu-chat-hint">Enter</b> opens player chat</span>$2',
  );
  return output;
}

function externalizeGameScript(source){
  const expression=/<script>\s*('use strict';[\s\S]*?)<\/script>\s*<\/body>/;
  const match=source.match(expression);
  if(!match)throw new Error('Could not find the main inline Arena.io game script.');
  const script=`${match[1]
    .replace(/\/\/ WEB_PWA_SW_START[\s\S]*?\/\/ WEB_PWA_SW_END/g,'')
    .trim()}\n`;
  let html=source.replace(
    expression,
    '<script src="./arena-game.js"></script>\n<script src="./crazygames-controls.js"></script>\n</body>',
  );

  // CrazyGames preview applies stricter browser security than the main site.
  // Remove string-based inline handlers and bind portal controls from the
  // external crazygames-controls.js file instead.
  html=html.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi,'');

  const attributes={
    'id="btn-ffa"':'id="btn-ffa" data-mode="ffa"',
    'id="btn-ranked"':'id="btn-ranked" data-mode="ranked"',
    'id="btn-lms"':'id="btn-lms" data-mode="lms"',
    'class="wtab active"':'class="wtab active" data-week="current"',
    'class="wtab" id="prev-tab"':'class="wtab" id="prev-tab" data-week="prev"',
    'id="challenge-tab-daily"':'id="challenge-tab-daily" data-challenge-tab="daily"',
    'id="challenge-tab-weekly"':'id="challenge-tab-weekly" data-challenge-tab="weekly"',
  };
  for(const [search,replacement] of Object.entries(attributes)){
    html=replaceRequired(html,search,replacement,`portal control marker ${search}`);
  }
  return {html,script};
}

function buildVersion(packageVersion,indexSource){
  const date=new Date().toISOString().slice(0,10).replaceAll('-','');
  const hash=crypto.createHash('sha256').update(indexSource).digest('hex').slice(0,8);
  return `${packageVersion}-cg.${date}.${hash}`;
}

function validateServerUrl(value){
  const parsed=new URL(String(value||''));
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'){
    throw new Error('platform/crazygames/config.json serverUrl must be a plain HTTPS origin.');
  }
  return parsed.origin;
}

function validateBuild(files){
  const failures=[];
  const index=files.get('index.html')?.toString('utf8')||'';
  const adapter=files.get('crazygames-adapter.js')?.toString('utf8')||'';

  if(!index.startsWith('<!DOCTYPE html>'))failures.push('index.html is missing its HTML5 doctype');
  if(!index.includes('data-platform="crazygames"'))failures.push('CrazyGames platform marker is missing');
  if(!index.includes('socket.io.min.js'))failures.push('local Socket.IO client is missing');
  if(!index.includes('crazygames-adapter.js'))failures.push('platform adapter is missing');
  if(!index.includes('crazygames.css'))failures.push('platform stylesheet is missing');
  if(!index.includes('arena-game.js'))failures.push('external game script is missing');
  if(!index.includes('crazygames-controls.js'))failures.push('external controls script is missing');
  for(const id of [
    'menu-move-hint',
    'menu-fire-hint',
    'menu-chat-hint',
    'chat-open-hint',
    'play-btn',
    'btn-ffa',
    'settings-menu-btn',
    'social-menu-btn',
    'game-menu-btn',
    'game-menu-panel',
    'social-panel',
  ]){
    if(!index.includes(`id="${id}"`))failures.push(`required startup element #${id} is missing`);
  }
  if(/(?:src|href)=["']\/(?!\/)/i.test(index))failures.push('root-relative src/href path found');
  if(/<script(?![^>]*\bsrc=)[^>]*>/i.test(index))failures.push('inline script found');
  if(/\son[a-z]+\s*=/i.test(index))failures.push('inline event handler found');
  if(/rel=["']manifest["']/i.test(index))failures.push('PWA manifest is still enabled');
  if(/platform-commerce\.js/i.test(index))failures.push('web/MS Store commerce adapter is still loaded');
  if(/serviceWorker\.register/i.test(index))failures.push('service worker registration is still enabled');
  if(adapter.includes('__ARENA_SERVER_URL__'))failures.push('server URL placeholder was not replaced');
  if(adapter.includes('__ARENA_BUILD_VERSION__'))failures.push('build version placeholder was not replaced');
  if(!/chatEnabled:false/.test(adapter))failures.push('chat is not disabled');
  if(!/accountsEnabled:false/.test(adapter))failures.push('external accounts are not disabled');
  if(!/shopEnabled:false/.test(adapter))failures.push('external shop is not disabled');
  if(!/function updateRoom\(/.test(adapter))failures.push('CrazyGames room reporting is missing');
  if(!/function inviteLink\(/.test(adapter))failures.push('CrazyGames invite links are missing');
  if(!/isInstantMultiplayer/.test(adapter))failures.push('CrazyGames instant multiplayer support is missing');
  if(!/function showInviteButton\(/.test(adapter))failures.push('CrazyGames invite button support is missing');
  if(!/addJoinRoomListener/.test(adapter))failures.push('CrazyGames join-room listener is missing');

  for(const fileName of ['arena-game.js','crazygames-adapter.js','crazygames-controls.js']){
    const code=files.get(fileName)?.toString('utf8');
    if(!code){
      failures.push(`${fileName} is missing`);
      continue;
    }
    try{new vm.Script(code,{filename:fileName});}
    catch(error){failures.push(`${fileName} has invalid JavaScript: ${error.message}`);}
  }

  const totalBytes=[...files.values()].reduce((total,file)=>total+file.length,0);
  if(files.size>1500)failures.push(`file count ${files.size} exceeds 1500`);
  if(totalBytes>20*1024*1024)failures.push(`initial package size ${totalBytes} exceeds 20 MB target`);
  if(failures.length)throw new Error(`CrazyGames validation failed:\n- ${failures.join('\n- ')}`);
  return {fileCount:files.size,totalBytes};
}

const crcTable=(()=>{
  const table=new Uint32Array(256);
  for(let i=0;i<256;i++){
    let value=i;
    for(let bit=0;bit<8;bit++)value=(value&1)?0xedb88320^(value>>>1):value>>>1;
    table[i]=value>>>0;
  }
  return table;
})();

function crc32(buffer){
  let value=0xffffffff;
  for(const byte of buffer)value=crcTable[(value^byte)&0xff]^(value>>>8);
  return (value^0xffffffff)>>>0;
}

function dosTimestamp(date){
  const year=Math.max(1980,date.getFullYear());
  const time=(date.getHours()<<11)|(date.getMinutes()<<5)|(date.getSeconds()>>>1);
  const day=((year-1980)<<9)|((date.getMonth()+1)<<5)|date.getDate();
  return {time,day};
}

function createZip(entries,outputPath){
  const now=dosTimestamp(new Date());
  const localParts=[];
  const centralParts=[];
  let offset=0;

  for(const [entryName,dataValue] of entries){
    const name=Buffer.from(entryName.replaceAll('\\','/'),'utf8');
    const data=Buffer.isBuffer(dataValue)?dataValue:Buffer.from(dataValue);
    const compressed=zlib.deflateRawSync(data,{level:9});
    const checksum=crc32(data);
    const flags=0x0800;
    const method=8;

    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0);
    local.writeUInt16LE(20,4);
    local.writeUInt16LE(flags,6);
    local.writeUInt16LE(method,8);
    local.writeUInt16LE(now.time,10);
    local.writeUInt16LE(now.day,12);
    local.writeUInt32LE(checksum,14);
    local.writeUInt32LE(compressed.length,18);
    local.writeUInt32LE(data.length,22);
    local.writeUInt16LE(name.length,26);
    local.writeUInt16LE(0,28);
    localParts.push(local,name,compressed);

    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50,0);
    central.writeUInt16LE(20,4);
    central.writeUInt16LE(20,6);
    central.writeUInt16LE(flags,8);
    central.writeUInt16LE(method,10);
    central.writeUInt16LE(now.time,12);
    central.writeUInt16LE(now.day,14);
    central.writeUInt32LE(checksum,16);
    central.writeUInt32LE(compressed.length,20);
    central.writeUInt32LE(data.length,24);
    central.writeUInt16LE(name.length,28);
    central.writeUInt16LE(0,30);
    central.writeUInt16LE(0,32);
    central.writeUInt16LE(0,34);
    central.writeUInt16LE(0,36);
    central.writeUInt32LE(0,38);
    central.writeUInt32LE(offset,42);
    centralParts.push(central,name);
    offset+=local.length+name.length+compressed.length;
  }

  const centralDirectory=Buffer.concat(centralParts);
  const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(0,4);
  end.writeUInt16LE(0,6);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(centralDirectory.length,12);
  end.writeUInt32LE(offset,16);
  end.writeUInt16LE(0,20);
  fs.writeFileSync(outputPath,Buffer.concat([...localParts,centralDirectory,end]));
}

function formatBytes(bytes){
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(2)} MB`;
}

function run(){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const packageJson=JSON.parse(fs.readFileSync(packagePath,'utf8'));
  const serverUrl=validateServerUrl(process.env.ARENA_CRAZYGAMES_SERVER_URL||config.serverUrl);
  const sourceIndex=fs.readFileSync(path.join(projectRoot,'public','index.html'),'utf8');
  const platformFingerprint=[
    sourceIndex,
    fs.readFileSync(path.join(platformRoot,'crazygames-adapter.js'),'utf8'),
    fs.readFileSync(path.join(platformRoot,'crazygames-controls.js'),'utf8'),
    fs.readFileSync(path.join(platformRoot,'crazygames.css'),'utf8'),
    fs.readFileSync(__filename,'utf8'),
  ].join('\n');
  const version=buildVersion(packageJson.version,platformFingerprint);
  const transformed=externalizeGameScript(transformIndex(sourceIndex));
  // Uploaded assets are addressed by their exact bundle filenames. Avoid query
  // strings here because some portal preview resolvers do not map a versioned
  // request back to the uploaded file.
  const index=transformed.html.replaceAll('="./','="');

  let adapter=fs.readFileSync(path.join(platformRoot,'crazygames-adapter.js'),'utf8');
  adapter=adapter
    .replaceAll('__ARENA_SERVER_URL__',serverUrl)
    .replaceAll('__ARENA_BUILD_VERSION__',version);

  const files=new Map([
    ['index.html',Buffer.from(index)],
    ['arena-game.js',Buffer.from(transformed.script)],
    ['crazygames-adapter.js',Buffer.from(adapter)],
    ['crazygames-controls.js',fs.readFileSync(path.join(platformRoot,'crazygames-controls.js'))],
    ['crazygames.css',fs.readFileSync(path.join(platformRoot,'crazygames.css'))],
    ['socket.io.min.js',fs.readFileSync(path.join(projectRoot,'node_modules','socket.io','client-dist','socket.io.min.js'))],
  ]);
  const result=validateBuild(files);

  fs.rmSync(outputRoot,{recursive:true,force:true});
  fs.mkdirSync(outputRoot,{recursive:true});
  for(const [name,data] of files)fs.writeFileSync(path.join(outputRoot,name),data);

  const report={
    ok:true,
    platform:'crazygames',
    buildVersion:version,
    generatedAt:new Date().toISOString(),
    serverUrl,
    sourceIndexSha256:crypto.createHash('sha256').update(sourceIndex).digest('hex'),
    fileCount:result.fileCount,
    totalBytes:result.totalBytes,
    totalSize:formatBytes(result.totalBytes),
    settings:{
      guestOnly:true,
      chat:false,
      accounts:false,
      externalShop:false,
      pwa:false,
      parties:true,
      inviteLinks:true,
      instantMultiplayer:true,
    },
  };
  fs.writeFileSync(path.join(outputRoot,'build-report.json'),`${JSON.stringify(report,null,2)}\n`);

  const archiveName=String(config.archiveName||'ArenaIO-CrazyGames-Upload.zip')
    .replace(/[^a-z0-9._-]/gi,'-');
  const archivePath=path.join(projectRoot,'builds',archiveName);
  fs.mkdirSync(path.dirname(archivePath),{recursive:true});
  createZip([...files.entries()],archivePath);

  console.log('CrazyGames build completed successfully.');
  console.log(`Build:   ${version}`);
  console.log(`Server:  ${serverUrl}`);
  console.log(`Files:   ${result.fileCount}`);
  console.log(`Size:    ${formatBytes(result.totalBytes)}`);
  console.log(`Folder:  ${path.relative(projectRoot,outputRoot)}`);
  console.log(`Upload:  ${path.relative(projectRoot,archivePath)}`);
}

if(require.main===module){
  try{run();}
  catch(error){
    console.error(error.message||error);
    process.exitCode=1;
  }
}

module.exports={
  buildVersion,
  createZip,
  externalizeGameScript,
  transformIndex,
  validateBuild,
  validateServerUrl,
};
