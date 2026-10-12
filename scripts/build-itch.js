#!/usr/bin/env node
'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const vm=require('vm');
const {createZip}=require('./build-crazygames');

const projectRoot=path.resolve(__dirname,'..');
const platformRoot=path.join(projectRoot,'platform','itch');
const outputRoot=path.join(projectRoot,'builds','itch');
const configPath=path.join(platformRoot,'config.json');
const packagePath=path.join(projectRoot,'package.json');

function replaceRequired(source,search,replacement,label){
  if(!source.includes(search)){
    throw new Error(`Could not prepare itch.io build: ${label} was not found in public/index.html.`);
  }
  return source.replace(search,replacement);
}

function validateServerUrl(value){
  const parsed=new URL(String(value||''));
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.pathname!=='/'){
    throw new Error('platform/itch/config.json serverUrl must be a plain HTTPS origin.');
  }
  return parsed.origin;
}

function transformIndex(source){
  let output=replaceRequired(
    source,
    '<html lang="en">',
    '<html lang="en" data-platform="itch">',
    'the root HTML element',
  );

  output=output
    .replace(/^[ \t]*<link rel="manifest"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link rel="apple-touch-icon"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link rel="preconnect" href="https:\/\/fonts\.[^"]+"[^>]*>\r?\n/gm,'')
    .replace(/^[ \t]*<link href="https:\/\/fonts\.googleapis\.com[^"]+"[^>]*>\r?\n/gm,'');

  output=replaceRequired(
    output,
    '</head>',
    [
      '<link rel="stylesheet" href="./itch.css">',
      '<script src="./itch-adapter.js"></script>',
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
    '<script src="./arena-game.js"></script>\n<script src="./itch-controls.js"></script>\n</body>',
  );

  // Portal iframes commonly block inline handlers under their content security
  // policy, so controls are bound by the external itch-controls.js file.
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

function buildVersion(packageVersion,fingerprint){
  const date=new Date().toISOString().slice(0,10).replaceAll('-','');
  const hash=crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0,8);
  return `${packageVersion}-itch.${date}.${hash}`;
}

function validateBuild(files){
  const failures=[];
  const index=files.get('index.html')?.toString('utf8')||'';
  const adapter=files.get('itch-adapter.js')?.toString('utf8')||'';

  if(!index.startsWith('<!DOCTYPE html>'))failures.push('index.html is missing its HTML5 doctype');
  if(!index.includes('data-platform="itch"'))failures.push('itch.io platform marker is missing');
  if(!index.includes('./socket.io.min.js'))failures.push('local Socket.IO client is missing');
  if(!index.includes('./itch-adapter.js'))failures.push('platform adapter is missing');
  if(!index.includes('./itch.css'))failures.push('platform stylesheet is missing');
  if(!index.includes('./arena-game.js'))failures.push('external game script is missing');
  if(!index.includes('./itch-controls.js'))failures.push('external controls script is missing');
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
  if(!/id:'itch'/.test(adapter))failures.push('itch platform identity is missing');
  if(!/chatEnabled:false/.test(adapter))failures.push('chat is not disabled');
  if(!/accountsEnabled:false/.test(adapter))failures.push('external accounts are not disabled');
  if(!/shopEnabled:false/.test(adapter))failures.push('external shop is not disabled');

  for(const [fileName,data] of files){
    if(Buffer.byteLength(fileName,'utf8')>240)failures.push(`${fileName} exceeds the path-length limit`);
    if(data.length>200*1024*1024)failures.push(`${fileName} exceeds itch.io's 200 MB per-file limit`);
  }
  for(const fileName of ['arena-game.js','itch-adapter.js','itch-controls.js']){
    const code=files.get(fileName)?.toString('utf8');
    if(!code){
      failures.push(`${fileName} is missing`);
      continue;
    }
    try{new vm.Script(code,{filename:fileName});}
    catch(error){failures.push(`${fileName} has invalid JavaScript: ${error.message}`);}
  }

  const totalBytes=[...files.values()].reduce((total,file)=>total+file.length,0);
  if(files.size>1000)failures.push(`file count ${files.size} exceeds itch.io's 1000-file limit`);
  if(totalBytes>500*1024*1024)failures.push(`extracted package size ${totalBytes} exceeds 500 MB`);
  if(failures.length)throw new Error(`itch.io validation failed:\n- ${failures.join('\n- ')}`);
  return {fileCount:files.size,totalBytes};
}

function formatBytes(bytes){
  if(bytes<1024)return `${bytes} B`;
  if(bytes<1024*1024)return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(2)} MB`;
}

function run(){
  const config=JSON.parse(fs.readFileSync(configPath,'utf8'));
  const packageJson=JSON.parse(fs.readFileSync(packagePath,'utf8'));
  const serverUrl=validateServerUrl(process.env.ARENA_ITCH_SERVER_URL||config.serverUrl);
  const sourceIndex=fs.readFileSync(path.join(projectRoot,'public','index.html'),'utf8');
  const fingerprint=[
    sourceIndex,
    fs.readFileSync(path.join(platformRoot,'itch-adapter.js'),'utf8'),
    fs.readFileSync(path.join(platformRoot,'itch-controls.js'),'utf8'),
    fs.readFileSync(path.join(platformRoot,'itch.css'),'utf8'),
    fs.readFileSync(__filename,'utf8'),
  ].join('\n');
  const version=buildVersion(packageJson.version,fingerprint);
  const transformed=externalizeGameScript(transformIndex(sourceIndex));

  let adapter=fs.readFileSync(path.join(platformRoot,'itch-adapter.js'),'utf8');
  adapter=adapter
    .replaceAll('__ARENA_SERVER_URL__',serverUrl)
    .replaceAll('__ARENA_BUILD_VERSION__',version);

  const files=new Map([
    ['index.html',Buffer.from(transformed.html)],
    ['arena-game.js',Buffer.from(transformed.script)],
    ['itch-adapter.js',Buffer.from(adapter)],
    ['itch-controls.js',fs.readFileSync(path.join(platformRoot,'itch-controls.js'))],
    ['itch.css',fs.readFileSync(path.join(platformRoot,'itch.css'))],
    ['socket.io.min.js',fs.readFileSync(path.join(projectRoot,'node_modules','socket.io','client-dist','socket.io.min.js'))],
  ]);
  const result=validateBuild(files);

  fs.rmSync(outputRoot,{recursive:true,force:true});
  fs.mkdirSync(outputRoot,{recursive:true});
  for(const [name,data] of files)fs.writeFileSync(path.join(outputRoot,name),data);

  const report={
    ok:true,
    platform:'itch',
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
      crossPlay:true,
      parties:true,
      serverWakeScreen:true,
    },
  };
  fs.writeFileSync(path.join(outputRoot,'build-report.json'),`${JSON.stringify(report,null,2)}\n`);

  const archiveName=String(config.archiveName||'ArenaIO-itch.io-Upload.zip')
    .replace(/[^a-z0-9._-]/gi,'-');
  const archivePath=path.join(projectRoot,'builds',archiveName);
  fs.mkdirSync(path.dirname(archivePath),{recursive:true});
  createZip([...files.entries()],archivePath);

  console.log('itch.io build completed successfully.');
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
  externalizeGameScript,
  transformIndex,
  validateBuild,
  validateServerUrl,
};
