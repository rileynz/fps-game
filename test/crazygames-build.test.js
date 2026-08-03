'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {
  externalizeGameScript,
  transformIndex,
  validateBuild,
  validateServerUrl,
}=require('../scripts/build-crazygames');

const root=path.resolve(__dirname,'..');

test('CrazyGames transform produces portal-safe HTML paths',()=>{
  const source=fs.readFileSync(path.join(root,'public','index.html'),'utf8');
  const transformed=externalizeGameScript(transformIndex(source));
  const output=transformed.html;
  assert.match(output,/data-platform="crazygames"/);
  assert.match(output,/src="\.\/socket\.io\.min\.js"/);
  assert.match(output,/src="\.\/crazygames-adapter\.js"/);
  assert.match(output,/href="\.\/crazygames\.css"/);
  assert.match(output,/src="\.\/arena-game\.js"/);
  assert.match(output,/src="\.\/crazygames-controls\.js"/);
  assert.doesNotMatch(output,/(?:src|href)=["']\/(?!\/)/);
  assert.doesNotMatch(output,/<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(output,/\son[a-z]+\s*=/);
  assert.doesNotMatch(output,/rel="manifest"/);
  assert.doesNotMatch(output,/platform-commerce\.js/);
  assert.match(output,/<span hidden><b id="menu-chat-hint">Enter<\/b> opens player chat<\/span>/);
  assert.match(transformed.script,/function attemptPlay\(\)/);
});

test('CrazyGames server URL must be a plain HTTPS origin',()=>{
  assert.equal(
    validateServerUrl('https://arena-io-0hn9.onrender.com'),
    'https://arena-io-0hn9.onrender.com',
  );
  assert.throws(()=>validateServerUrl('http://example.com'));
  assert.throws(()=>validateServerUrl('https://user:pass@example.com'));
  assert.throws(()=>validateServerUrl('https://example.com/game'));
});

test('CrazyGames validation requires disabled portal-only features',()=>{
  const transformed=externalizeGameScript(
    transformIndex(fs.readFileSync(path.join(root,'public','index.html'),'utf8')),
  );
  const adapter=fs.readFileSync(path.join(root,'platform','crazygames','crazygames-adapter.js'),'utf8')
    .replaceAll('__ARENA_SERVER_URL__','https://arena-io-0hn9.onrender.com')
    .replaceAll('__ARENA_BUILD_VERSION__','test');
  const result=validateBuild(new Map([
    ['index.html',Buffer.from(transformed.html)],
    ['arena-game.js',Buffer.from(transformed.script)],
    ['crazygames-adapter.js',Buffer.from(adapter)],
    ['crazygames-controls.js',fs.readFileSync(path.join(root,'platform','crazygames','crazygames-controls.js'))],
    ['crazygames.css',Buffer.from('body{}')],
    ['socket.io.min.js',Buffer.from('/* socket.io */')],
  ]));
  assert.equal(result.fileCount,6);
  assert.ok(result.totalBytes>0);
});
