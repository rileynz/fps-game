# Arena.io itch.io Build

## Build the upload

From the Arena.io project folder:

```bash
npm install
npm run build:itch
```

`npm install` is only needed the first time, or after dependencies change.

The command creates:

- `builds/ArenaIO-itch.io-Upload.zip` — upload this file to itch.io.
- `builds/itch/` — the unpacked files for local inspection.
- `builds/itch/build-report.json` — build version and validation details.

Do not zip the `builds/itch` folder yourself. The build command already makes
the correct ZIP with `index.html` at its root.

## itch.io page settings

1. Create or edit the Arena.io project on itch.io.
2. Set **Kind of project** to **HTML**.
3. Upload `builds/ArenaIO-itch.io-Upload.zip`.
4. Mark the file as **This file will be played in the browser**.
5. Use a viewport around **1280 × 720**.
6. Enable the itch.io fullscreen button.
7. Enable mobile support if itch.io offers that option for the page.
8. Save the page and test it in both the embedded view and fullscreen.

The build has a branded connection screen for Render cold starts. Players on
itch.io connect to the same multiplayer rooms as website, PWA, Microsoft Store,
and CrazyGames players.

## Updating the game

For every update:

1. Update and deploy the normal root game to Render.
2. Wait until the Render deployment reports healthy.
3. Run `npm run build:itch`.
4. Upload the newly generated ZIP to the existing itch.io project.
5. Test Play, Settings, Social/party codes, each public mode, and fullscreen.

The builder always reads the current `public/index.html`, so gameplay, weapons,
maps, balance, UI, and fixes stay in one main codebase.

## Portal safety

The itch.io package intentionally runs as a guest portal build:

- account sign-in is disabled;
- Stripe and Microsoft Store purchases are disabled;
- chat is disabled;
- PWA installation and service workers are disabled; and
- controls, gameplay, settings, social parties, and cross-play remain enabled.

Those restrictions apply only inside the itch.io build. The normal website,
PWA, Microsoft Store, and CrazyGames versions are not changed.

To point an itch build at a different server without editing the config:

```bash
ARENA_ITCH_SERVER_URL=https://your-server.example npm run build:itch
```

The server URL must be a plain HTTPS origin.
