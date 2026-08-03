# Arena.io CrazyGames workflow

## Ricochet update submission

Use **Arena.io: Ricochet** as the CrazyGames game name. The portal build uses
that exact browser title, while the game keeps the existing Arena.io logo and
shows `RICOCHET COMBAT · EVERY WALL IS A WEAPON` directly beneath it.

This build supports CrazyGames `isInstantMultiplayer`, join-room listeners,
room updates, platform invite links and the platform invite button. A portal
instant-multiplayer launch creates a real Arena.io party and starts its leader
in a joinable room; friends who join through the invite stay with that party
between rounds.

For every update:

1. Deploy the root project to Render first and wait until `/api/health` returns
   `ok: true`.
2. Run `npm install` once if dependencies are not installed.
3. Run `npm run build:crazygames` from the project folder.
4. Upload only `builds/ArenaIO-CrazyGames-Upload.zip` to CrazyGames.
5. In the tester, verify a normal launch, `isInstantMultiplayer`, an invite-link
   join with two browser sessions, audio muting, fullscreen, and mobile input.

The new gameplay hook is permanent ricochet combat rather than a temporary
mode: Pistol, SMG and Shotgun shots bank once, while Sniper shots bank twice.
Bank eliminations award bonus score and have daily/weekly challenges.

The main Render/PWA/MS Store game remains the source of truth. Never manually edit
`builds/crazygames/index.html`; it is regenerated from `public/index.html`.

## After each Arena.io update

1. Update the normal game files and test them locally.
2. Commit/push the update and let Render deploy it.
3. Wait until the Render deployment reports **Live**.
4. From the project root, install dependencies if needed:

   ```bash
   npm install
   ```

5. Generate and validate the CrazyGames package:

   ```bash
   npm run build:crazygames
   ```

6. Upload this generated file in the CrazyGames Developer Portal:

   ```text
   builds/ArenaIO-CrazyGames-Upload.zip
   ```

The ZIP has `index.html` at its root and contains only the six files required by
the portal build. Do not upload the full source-project ZIP as the game build.

## What the generator changes

Only the generated CrazyGames copy receives these changes:

- Uses a bundled Socket.IO client and relative file paths.
- Moves the main game code and button bindings into external JavaScript files
  so they run under the CrazyGames preview security policy.
- Connects to the shared Render multiplayer server.
- Adds the CrazyGames v3 SDK and gameplay start/stop events.
- Shows a custom Render wake/reconnect screen with real elapsed time.
- Starts players as guests without an email/PIN prompt.
- Disables chat for the initial launch.
- Hides accounts, Stripe/MS Store commerce and the shop.
- Disables the PWA manifest, service worker behaviour and custom fullscreen.
- Keeps the normal Arena.io gameplay and visual theme.

The command stops with an error instead of producing a bad ZIP if required files
or platform settings are missing, if a root-relative asset is present, or if the
package exceeds the 20 MB mobile-home target.

## Changing the Render address

Edit `platform/crazygames/config.json`, or create one build with:

```bash
ARENA_CRAZYGAMES_SERVER_URL=https://your-service.onrender.com npm run build:crazygames
```

On Windows PowerShell:

```powershell
$env:ARENA_CRAZYGAMES_SERVER_URL="https://your-service.onrender.com"
npm run build:crazygames
Remove-Item Env:ARENA_CRAZYGAMES_SERVER_URL
```

Never put Stripe, MongoDB, Resend or admin secrets in the CrazyGames folder or ZIP.

## Initial submission settings

- Submit as an HTML5 game.
- Start with desktop/Chromebook support.
- Keep external login and monetization disabled during Basic Launch.
- Set multiplayer to supported; bots ensure a new player is not left in an empty match.
- Use landscape orientation.
- Test the ZIP in the Developer Portal QA preview before submitting.
- Check browser console output and test several modes, reconnecting, settings,
  the leaderboard and a complete round.

CrazyGames documentation:

- Requirements: <https://docs.crazygames.com/requirements/intro/>
- Technical requirements: <https://docs.crazygames.com/requirements/technical/>
- Gameplay requirements: <https://docs.crazygames.com/requirements/gameplay/>
- Basic Launch metrics: <https://docs.crazygames.com/resources/basic-launch-metrics/>

## Render sleeping plan

The loading screen makes a cold start understandable and retries automatically,
but it cannot make the server wake faster. CrazyGames evaluates how quickly players
reach gameplay, so an always-on Render plan is strongly recommended before the
review and two-week Basic Launch test.
