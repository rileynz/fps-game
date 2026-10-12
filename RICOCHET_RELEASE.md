# Arena.io: Ricochet — v2.1.0

## What changed

- Ricochet combat is now part of every match and uses the existing movement,
  weapons, maps, modes, menus, and Arena.io visual style.
- Pistol, SMG, and Shotgun projectiles can bank once. Sniper projectiles can
  bank twice.
- Direct eliminations remain worth 100 points. A one-bank elimination earns
  150 points and a two-bank elimination earns 225 points.
- A faint aim trace previews only the first reflection. Map-coloured sparks, a
  short impact sound, the kill feed, and a brief local callout confirm banks
  without crowding the HUD.
- Wall edges have subtle baked ricochet rails that match each map theme and add
  no per-frame rendering cost.
- Daily and weekly bank-shot challenges were added. Match analytics also record
  ricochet eliminations and the best bank count.
- Projectile collision is swept and server-authoritative, including arena
  borders and shots fired while pressed against a wall.
- Bounce updates use a small viewport-filtered lifecycle event instead of
  expanding 20 Hz movement snapshots.

## CrazyGames readiness

- Portal title: `Arena.io: Ricochet`
- Current SDK v3 loading start/stop and gameplay start/stop calls
- `isInstantMultiplayer` party-leader launch flow
- Room updates and join-room listener
- CrazyGames invite links and invite button
- Platform mute support
- Portal chat, external accounts, and the external premium shop stay disabled
- Six-file upload package, 431.1 KB uncompressed

## Verification

- 155 automated tests passed.
- The dedicated 300 ms RTT movement and reconciliation test passed.
- CrazyGames build validation passed with no inline scripts, root-relative
  assets, PWA service worker, external login, or external commerce code.

## Deploy and submit

1. Replace the files in the existing GitHub repository with this source update,
   commit, and push it.
2. Wait for Render to deploy successfully.
3. Open `https://arena-io-0hn9.onrender.com/api/health` and confirm it returns
   `"ok": true`.
4. Test at least one full round on the live website.
5. Upload `ArenaIO-CrazyGames-Upload.zip` to the CrazyGames tester.
6. Use `Arena.io: Ricochet` as the submitted game name.
7. Test normal launch, instant multiplayer, a two-browser invite join, platform
   mute, fullscreen, keyboard controls, and mobile controls.
8. Record new gameplay and update the description/screenshots so ricochet shots
   are the first feature reviewers see. Do not resubmit using the old trailer
   that presents it as only a standard arena shooter.

CrazyGames acceptance is still decided by its review team. This update directly
addresses the previous “too close to existing titles” feedback by changing the
core combat loop rather than adding a temporary side mode.
