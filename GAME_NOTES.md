# Arena.io Maintenance Notes

## Team Deathmatch is intentionally excluded

Team Deathmatch (TDM) is deliberately excluded from the public game-mode
selector and public matchmaking. Its missing menu button is **not a bug**.

The old TDM implementation remains in the codebase only for compatibility with
historical analytics, player data, achievements, and a possible future return.
Routine bug fixes, audits, refactors, and UI updates must not:

- add a TDM button back to the main menu;
- allow a client to enter a TDM room by sending a custom Socket.IO payload;
- generate daily challenges that require playing or winning TDM; or
- describe TDM as a currently supported public mode.

Only restore TDM when Riley explicitly asks for it to return.

## Ricochet combat is a core Arena.io mechanic

All projectiles now reflect from map obstacles and the arena boundary. Pistol,
SMG, and Shotgun projectiles can reflect once; Sniper projectiles can reflect
twice. The server is authoritative for every reflection and awards 150 points
for a one-bank elimination or 225 points for a two-bank elimination. Direct
eliminations remain worth 100 points.

The client keeps the existing Arena.io presentation and controls. It adds only
a restrained first-reflection aim trace, map-coloured impact sparks, a short
reflection sound, and a compact bank-shot message. Do not turn this into a
separate mode or add high-rate ricochet data to normal state snapshots; the
small viewport-filtered, volatile `bulletBounce` event exists to keep bandwidth
and latency stable. Periodic authoritative projectile snapshots correct any
visual bounce event that is dropped under congestion.

## Current public modes

- Free For All
- Ranked
- Last Stand

## Friends, parties, and match menu

The compact Social control opens account-backed friends, friend requests,
presence, privacy controls, and four-player parties without adding another
main-menu tool tile. Parties use six-character codes and invite links; the
leader starts the selected public mode and members are routed into the same
room. CrazyGames guests use the same party flow and report joinable room data
through the CrazyGames SDK.

Friend relationships persist on the existing rank/account record. Party state
is intentionally lightweight and in memory. Never expose account email
addresses in social payloads. Keep request throttling, block/remove controls,
appear-offline, invite-only joining, and the deliberate absence of private
messages.

The itch.io build is produced with `npm run build:itch`. Like the initial
CrazyGames portal build, it is guest-only with accounts, purchases, chat, PWA
installation, and service workers disabled. It still uses the live Render
Socket.IO server, public modes, controls, settings, party codes/invite URLs,
and cross-play. Keep these restrictions isolated to the generated portal build;
never remove those features from the normal web/PWA/Microsoft Store client.

Recent Players is a bounded account feature inside the Friends view. Record
only signed-in human players after a completed round, never bots or guests.
Keep at most 20 deduplicated entries for seven days. This data is saved with
the existing account record and sent only when the Social Hub is requested;
never add it to presence pushes, room metadata, movement snapshots, or another
realtime loop.

The in-game hamburger button is the single home for Resume, Social, controls,
audio, invite copying, and confirmed Leave Match. Opening a menu releases held
movement/fire input but does not pause the online match.

## Announcements

Published announcements appear in the **Announcements** tab on the main menu.
Create, edit, publish, unpublish, pin, mark important, or delete them from
`/admin` using the Announcements section. Important announcements use a slim
top-of-screen banner. Players also get an unread count, compact menu preview,
one-time new-post popup, and an in-game notification for announcements posted
while they are connected. Announcements persist in MongoDB when `MONGODB_URI`
is configured. Without MongoDB, they work in memory but reset when the server
restarts.

## Account and Premium Shop flow

The compact account control shares the player-name row so account access stays
visible without adding another main-menu tile. New players may create a PIN
account before playing or explicitly continue as a guest. Existing names
automatically open the correct PIN or password login.

PIN accounts can later add a verified email and password. A secured account no
longer has a PIN, so Premium Shop checks must treat `account.secured` as a valid
account even when `account.hasPin` is false. Keep browser-cookie and Socket.IO
session state synchronized on sign-in, reconnect, account upgrades, password
resets, and sign-out.

The Stripe webhook endpoint is:

`/api/shop/stripe-webhook`

## Last Stand performance

Last Stand deliberately uses a lightweight storm renderer. Do not restore the
old full-screen even-odd canvas cut-out or large dashed circles on every frame;
they caused frame drops on weaker devices that also made the displayed ping
look higher.

State broadcasts must iterate only the sockets in their room. Eliminated Last
Stand spectators receive bullets around the player they are watching rather
than every bullet on the map. The minimap is intentionally capped below the
main render frame rate, and the storm timer only updates the DOM when its
visible text changes.

Realtime state snapshots intentionally use volatile delivery and monotonically
increasing sequence numbers: a new snapshot replaces an old one instead of
letting stale movement queue during a connection spike. Movement input packets
are also sequenced, but the transition to no movement remains reliable so a
dropped packet cannot leave someone sliding. Keep adaptive interpolation,
bounded prediction/extrapolation, frame-rate-independent camera easing, and
low-FPS trail scaling in future networking or rendering changes.

## Visual identity must stay consistent

Riley likes the current Arena.io visual style. Feature, UI, map, audio, and
effects work must preserve it rather than redesigning the game.

Keep:

- the current dark neon/glass palette and typography;
- simple circular players, clear projectiles, and flat readable geometry;
- compact `.io`-style menus and HUD; and
- the existing overall layout, visual density, and visual language.

New effects should look native to the existing style. Improve clarity,
feedback, accessibility, performance, and polish without replacing the theme,
reorganizing the whole interface, adding realistic or cinematic visuals, or
making the game resemble another title. Only change the overall style if Riley
explicitly asks.

Storm visibility improvements should use the game's existing colours, simple
neon strokes, restrained glow, compact warnings, minimap cues, and lightweight
audio. Avoid photorealistic clouds, heavy screen effects, or a separate Last
Stand introduction screen.

The old on-screen `SAFE ZONE` direction arrow is intentionally removed. Keep
the storm boundary, minimap circles, top warning, and danger tint, but do not
restore that arrow unless Riley explicitly asks for it.

Each current map has its own Arena.io environment theme: Arena uses tournament
blue, Desert uses sand/stone, Castle uses dark masonry, Maze uses teal overgrown
stone, and Industrial uses metal/hazard details. Floor art, grid lines, scenery,
and obstacle surfaces are baked into the existing offscreen map canvas when a
round loads. Do not move themed scenery into the per-frame render loop.

## Kill streak rewards

Streak rewards are authoritative on the server and unlock once per life at 3,
5, 8, and 12 eliminations. Recon Pulse, Guard, Overdrive, and Arena Core replace
one another rather than stacking. Temporary shields absorb damage before HP;
movement and weapon-cooldown boosts are calculated by the server. Last Stand
converts the late speed rewards to reduced Guard rewards to avoid an endgame
snowball. Reset every streak state on defeat and at the next round.

Streak visuals use rare Socket.IO events, a compact HUD chip, and a short toast.
Never add streak fields to the 20 Hz movement snapshot or permanent large HUD
panels. Arena Core is deliberately visible to opponents on the minimap.

## Challenge and bot systems

The existing Challenges menu button contains both Daily and Weekly tabs so the
main menu stays compact. Daily challenges include one reroll per player per day.
Challenge definitions must only use the public FFA, Ranked, and Last Stand
modes. Partial progress must be persisted, not only completed challenges.

Bot eliminations award reduced challenge credit. Ranked always awards normal
SR, including bot-only competition. Bots count in
placement order and bot eliminations receive full SR kill credit so a small
player base can still make progression.

Bots use varied names, personalities, weapon preferences, reaction delays,
imperfect aim, obstacle steering, target spreading, and Last Stand safe-zone
awareness. Keep perception checks below the physics frame rate so smarter bots
do not create server or apparent ping spikes.

Bot display names intentionally use short, lowercase arena-style names with an
occasional number or underscore. Keep them readable and name-like; do not
restore novelty food, animal, or joke names.

Populate the bot roster synchronously before sending a joining player the
initial game state. A first player entering an empty public room must immediately
receive the full roster and leaderboard instead of seeing them empty for a
second.

## Last Stand storm movement and spawning

Every storm-closing phase may relocate the safe-zone centre as well as reducing
its radius. The upcoming gold preview ring must be drawn at `nextCx`/`nextCy` on
both the world view and minimap, while the red ring continues to show the active
boundary. The next circle must remain contained within the previous circle and
inside the map.

Players and bots must always spawn with a safety margin inside the active Last
Stand circle and outside map obstacles. Bots should pre-position toward the
upcoming circle rather than waiting for storm damage.

## Deep-audit invariants

Shard bundles are repeatable purchases. Do not display them as permanently
owned, and track fulfillment and refunds by Stripe checkout-session ID so each
purchase can be independently and idempotently refunded. Exclusive cosmetic
packs remain one-time entitlements.

Account checks include a client request ID. Ignore stale replies so changing a
name or account while a request is in flight cannot open the wrong login flow.
Do not queue Play/account requests while the socket is disconnected, and always
reset the game shell when a join is rejected.

At each new round, clear server movement keys and client interpolation/effect
buffers, send every real player a reliable authoritative spawn, and immediately
broadcast the rebuilt leaderboard. Departing players must be removed from all
render-state buffers. When the final real player leaves, cancel the room's
pending player-count timer before deleting the room.

Damage challenges use the victim's actual remaining health, not raw weapon
damage. No-death elimination challenges use the best streak achieved during the
round even if the player is defeated later.

## Custom controls

Desktop control bindings are stored locally under `arena_control_binds`. The
small settings gear remains outside the four main-menu tool tiles so the menu
does not become more crowded. Players can rebind movement, firing, chat, and
optional keyboard aim directions; mouse movement remains the default aiming
method.

Keep duplicate-bind handling, safe validation of stored values, input release
when opening chat/settings, reset-to-default support, and the original arrow-key
movement aliases. Mobile twin-stick movement, aim-drag firing, and the dedicated
shoot button are intentionally unchanged.

## Purchase confirmations

After a verified Stripe webhook successfully fulfills a purchase, send a plain
purchase confirmation to the player's verified secure-account email. The sender
is configured by `PURCHASE_EMAIL_FROM` and should be
`Arena.io Purchases <purchases@mail.rileybylsma.tech>`.

Use the Stripe Checkout ID as the Resend idempotency key and store
`receiptEmailSentAt` on the purchase record. Resend failure must never revoke or
double-grant the purchase; the webhook should fail so Stripe can safely retry
the unsent confirmation. Do not describe the email as a tax invoice.

## Account deletion

Account deletion lives inside the existing Account panel and must not add
another main-menu tile. Require the signed-in player to type their player name
and re-enter their current password or PIN before deletion.

Deletion removes the rank, Shards, cosmetics, challenge progress, leaderboard
entries, account login, sessions, and player analytics. If the player is in a
match, remove them cleanly and return the client to the menu. Retain only the
minimum Stripe purchase records needed for refunds and financial recordkeeping,
marked with `accountDeletedAt`; recreating the same player name must never
restore paid items or other deleted progress.

## Menu performance

The arena renderer must return before drawing the map, bullets, players,
effects, HUD, or minimap whenever the player is outside a match. During active
menu/list scrolling, briefly prioritize scroll input over any covered game
rendering and pause decorative CSS motion until scrolling settles.

Keep the existing menu design, colours, glass panels, layout, and animations.
Use paint containment and compositor isolation for long settings, challenge,
shop, announcement, ranking, and account lists rather than removing the visual
style.

## Premium platform detection

Do not use Digital Goods API presence by itself to identify the Microsoft Store
PWA. ChromeOS and other platforms may expose the same browser API. Hide Stripe
Premium purchases only when all three signals are present: Windows, an
installed-app display mode, and `getDigitalGoodsService`.

Premium must remain visible in normal Chromebook, macOS, Windows, Linux, and
mobile web browsers. Previously owned cosmetics remain usable everywhere.

## Announcement opening behavior

Loading or receiving an unread announcement must never open the full News panel
automatically. Unread announcements remain visible through the NEW counter,
Latest News preview, and important top banner. Only an explicit click or tap on
one of those announcement controls may open the full panel.
