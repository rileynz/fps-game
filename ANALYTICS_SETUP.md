# Arena.io Admin Dashboard

## Setup

The dashboard uses the existing MongoDB connection and does not need another
database. Add a permanent admin key to the Render service:

```text
ADMIN_KEY=use-a-long-random-value-here
```

Optional: set the bandwidth allowance shown by the Performance tab. It defaults
to 5 GB when this variable is missing:

```text
RENDER_BANDWIDTH_LIMIT_GB=5
```

Deploy normally, open `https://your-render-address.onrender.com/admin`, and
enter `ADMIN_KEY`. The key is kept only in that browser tab's session storage.

## Dashboard tabs

- **Overview** — players online, peak online since deploy, DAU, sessions,
  player-hours, completed matches, daily trends, and every live room.
- **Players** — unique players, saved and secured accounts, verified emails,
  day-1/day-7 retention, platforms, active hours, and session exit reasons.
- **Gameplay** — mode joins and completions, average room size and duration,
  map popularity, shard spending, and cosmetic purchases.
- **Revenue** — durable Stripe purchase totals by currency, net revenue,
  refunds, receipt-email status, daily revenue, shop activity, purchase funnel,
  and top products.
- **Performance** — estimated realtime and HTTP traffic, projected monthly
  bandwidth, traffic by mode, server physics/broadcast time, event-loop lag,
  and client ping/FPS samples split by platform.
- **Announcements** — create drafts, publish, pin, mark as Important, edit, and
  delete announcements shown in the game.

## Tracking behaviour

- A session begins only after a player successfully joins a match and ends when
  they leave, disconnect, switch account, sign out, or delete their account.
- The first round created for a room is recorded, not only later rounds.
- Platform is recorded as Website, PWA, Microsoft Store, or CrazyGames.
- Stripe revenue uses the durable `purchases` collection rather than relying
  only on analytics events, so a server restart does not erase purchase history.
- Client performance samples are sent about every 30 seconds while playing.
- Network totals are measured from the current server deployment. Render's own
  usage page remains the final source of truth for billable bandwidth.

## Notes

- Analytics history can only exist from the point where each event began being
  recorded. New measurements such as platform, retention cohorts, and proper
  session duration become more accurate as this version runs.
- If MongoDB is unavailable, gameplay analytics use an in-memory fallback that
  resets on restart. The source badge at the top clearly shows this state.
- Revenue values stay separated by currency rather than being incorrectly added
  together.
- Empty datasets display a clear message and cannot prevent the remaining cards
  and tables from rendering.
