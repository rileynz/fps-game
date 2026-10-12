# Arena.io Ricochet Hotfix — v2.1.1

This hotfix preserves the v2.1.0 gameplay, movement feel, map style, modes and
menus while correcting projectile presentation and congestion-related latency.

## Fixed

- Projectiles now leave the visible end of the cannon instead of spawning under
  or beside it.
- The local player sees an immediate cosmetic projectile at high ping while the
  server remains fully authoritative for collisions, damage and scoring.
- Human turret direction is updated by the accepted shot, preventing reliable
  shot messages from visually overtaking disposable aim updates.
- Bots smoothly face their intended target and only fire once the turret is
  inside a difficulty-based aim tolerance.
- Ricochet collision checks no longer allocate temporary arrays and objects on
  every wall test, reducing garbage-collection pauses in busy rooms.
- Bounce effects use disposable viewport-filtered messages so congestion cannot
  queue cosmetic effects ahead of movement and ping traffic.
- The ping/prediction system uses a three-sample median so one delayed response
  cannot make a normal connection appear to jump from about 120 ms to 400 ms or
  cause excessive movement correction.
- Bounce events arriving before a projectile spawn packet no longer make that
  projectile temporarily invisible.
- Exact corner impacts now count as one diagonal bounce rather than consuming
  two bounces.
- Muzzle-inside-wall shots, new-round cleanup and malformed bounce rows are
  handled safely.

## Unchanged

- Server physics still run at 60 Hz and room state updates remain at 20 Hz.
- Movement speed, controls, damage, weapon fire rates and weapon balance are
  unchanged.
- Team Deathmatch remains intentionally excluded; see `GAME_NOTES.md`.
