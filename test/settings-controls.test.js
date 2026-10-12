'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const client=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');

test('settings stays outside the compact four-tile main menu',()=>{
  assert.match(client,/id="settings-menu-btn"[\s\S]*?class="menu-logo"/);
  assert.equal((client.match(/class="menu-tools"/g)||[]).length,1);
  assert.doesNotMatch(client,/class="menu-tools"[\s\S]{0,500}id="settings-menu-btn"/);
});

test('control binds load safely, persist locally and can reset',()=>{
  assert.match(client,/const DEFAULT_CONTROL_BINDS=Object\.freeze\(\{/);
  assert.match(client,/safeStorage\.get\('arena_control_binds'\)/);
  assert.match(client,/safeStorage\.set\('arena_control_binds',JSON\.stringify\(controlBinds\)\)/);
  assert.match(client,/controlBinds=\{\.\.\.DEFAULT_CONTROL_BINDS\}/);
  assert.match(client,/if\(code&&used\.has\(code\)\)return\{\.\.\.DEFAULT_CONTROL_BINDS\}/);
});

test('movement, keyboard aim, fire and chat use configurable controls',()=>{
  assert.match(client,/controlPressed\('up'\)/);
  assert.match(client,/controlPressed\('aimRight'\)/);
  assert.match(client,/controlPressed\('fire'\)/);
  assert.match(client,/e\.code===controlBinds\.chat/);
  assert.match(client,/const LEGACY_MOVE_BINDS=\{up:'ArrowUp'/);
});

test('bind capture handles conflicts and optional unbinding safely',()=>{
  assert.match(client,/Swapped with \$\{CONTROL_BIND_NAMES\[conflict\]\}/);
  assert.match(client,/OPTIONAL_CONTROL_BINDS\.has\(settingsCaptureAction\)/);
  assert.match(client,/Mouse buttons can only be assigned to Fire Weapon/);
  assert.match(client,/Use a single normal key without Ctrl, Alt or Command/);
});

test('settings and chat release held inputs while the compact menu remains available on mobile',()=>{
  assert.match(client,/window\.openSettings=function\(\)\{\s*releaseAllInputs\(\)/);
  assert.match(client,/function openChat\(teamOnly\)\{[\s\S]*?releaseAllInputs\(\)/);
  assert.doesNotMatch(client,/if\(isMobile\)document\.getElementById\('settings-menu-btn'\)\.style\.display='none'/);
  assert.match(client,/id="game-menu-btn"/);
  assert.match(client,/mobileShoot\|\|aimDragShoot/);
});
