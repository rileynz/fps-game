# Arena.io payments and publishing checklist

This release contains a web payment system built around Stripe Checkout, MongoDB
purchase records, verified-email accounts, signed webhook fulfillment, refunds,
and opaque login sessions.

## Important: an adult must manage the money accounts

Because the game owner is under 18, a parent or legal guardian must be the adult
representative for Stripe and should own or manage the bank, tax, payout, Render,
domain, and Microsoft Partner Center details. Do not enter false age or identity
information. Stripe's current terms require an adult representative when the
user or representative is not yet 18:

https://stripe.com/legal/ssa

## 1. Deploy the web game first

Keep the game client and API on the same public HTTPS origin. The included client
currently points to:

`https://arena-io-0hn9.onrender.com`

On Render, use a Node Web Service with:

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/announcements`
- Node version: set `NODE_VERSION` to a supported fixed major/version instead of
  silently following the newest major.

Connect the GitHub repository to Render, replace its files with this release,
commit, push, and deploy. Render's Node/Express instructions are here:

https://render.com/docs/deploy-node-express-app

## 2. Add the required Render environment variables

Keep every secret in Render's Environment page. Never commit these values.

| Variable | Value |
| --- | --- |
| `MONGODB_URI` | Production MongoDB connection string |
| `PUBLIC_BASE_URL` | Exact HTTPS game origin, with no final slash |
| `ADMIN_KEY` | Long random analytics-dashboard key |
| `STRIPE_SECRET_KEY` | Stripe sandbox secret key first (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret from the Stripe webhook (`whsec_...`) |
| `STRIPE_PRICE_SHARDS_500` | Stripe Price ID for 500 Shards |
| `STRIPE_PRICE_SHARDS_1200` | Stripe Price ID for 1,200 Shards |
| `STRIPE_PRICE_SHARDS_2500` | Stripe Price ID for 2,500 Shards |
| `STRIPE_PRICE_SUPPORTER` | Stripe Price ID for Supporter Pack |
| `STRIPE_PRICE_ELITE` | Stripe Price ID for Arena Elite Pack |
| `RESEND_API_KEY` | Resend API key |
| `EMAIL_FROM` | Sender on the verified domain, such as `Arena.io <accounts@example.com>` |
| `PURCHASE_EMAIL_FROM` | Purchase sender: `Arena.io Purchases <purchases@mail.rileybylsma.tech>` |
| `STRIPE_AUTOMATIC_TAX` | Optional: `true` only after configuring Stripe Tax |

The code deliberately refuses paid checkout until MongoDB, Stripe, the webhook,
the public URL, and the selected Price ID are configured.

## 3. Configure account email

1. Use a domain controlled by the parent/guardian or business.
2. In Resend, add the domain and copy the required DNS records to the domain's
   DNS provider.
3. Wait until Resend shows the domain as verified.
4. Create a sending API key and set `RESEND_API_KEY`.
5. Set `EMAIL_FROM` to an address on that verified domain.

Resend requires a verified domain:

https://resend.com/docs/dashboard/domains/introduction

Players keep their existing PIN account until they choose **Shop → Secure**.
The upgrade verifies email and changes future login to a password. Raw PINs and
passwords are not stored in browser storage.

## 4. Create Stripe sandbox products

In Stripe sandbox/test mode, create five one-time prices in NZD:

| Product | Price | Render Price variable |
| --- | ---: | --- |
| 500 Shards | NZ$2.99 | `STRIPE_PRICE_SHARDS_500` |
| 1,200 Shards | NZ$5.49 | `STRIPE_PRICE_SHARDS_1200` |
| 2,500 Shards | NZ$9.99 | `STRIPE_PRICE_SHARDS_2500` |
| Supporter Pack | NZ$5.99 | `STRIPE_PRICE_SUPPORTER` |
| Arena Elite Pack | NZ$9.99 | `STRIPE_PRICE_ELITE` |

Copy each `price_...` ID into Render. Never put a Price ID, secret key, or grant
amount in client-side code as the authority; this release validates the selected
Price and grants entirely on the server.

## 5. Add the Stripe webhook

Create a Stripe webhook endpoint:

`https://YOUR-GAME-DOMAIN/api/shop/stripe-webhook`

Subscribe it to:

- `checkout.session.completed`
- `checkout.session.async_payment_succeeded`
- `charge.refunded`

Copy the endpoint signing secret into `STRIPE_WEBHOOK_SECRET`, then redeploy.
The server verifies the Stripe signature against the raw request body and keeps
an idempotent event/purchase record before granting permanent items.

Stripe webhook and fulfillment references:

- https://docs.stripe.com/webhooks
- https://docs.stripe.com/checkout/fulfillment

## 6. Test before taking real money

1. Keep Stripe in sandbox/test mode.
2. Create a normal player PIN by playing once.
3. Open Shop, choose **Secure**, verify the email, and log in.
4. Buy each product and confirm the exact Shards/cosmetics appear only once.
5. Refresh and log in again; the purchase must still be owned.
6. Refund a test purchase in Stripe; confirm exclusive items are revoked and any
   already-spent refunded Shards become Shard debt.
7. Test a cancelled Checkout and an incorrect password/reset code.
8. Check Stripe's webhook page: every delivery should return HTTP 200.

Stripe's standard sandbox success card is `4242 4242 4242 4242`, with any future
expiry and any three-digit CVC:

https://docs.stripe.com/testing

## 7. Move Stripe to live mode

The parent/guardian completes Stripe business verification, bank details, tax
details, support details, statement descriptor, and refund/dispute settings.
Then:

1. Recreate or activate the five products in Stripe live mode.
2. Replace every `sk_test_...` and test `price_...` with the live values.
3. Create a separate live webhook and replace the test `whsec_...`.
4. Make one small real purchase and refund with the adult account manager.
5. Confirm the purchase, refund, email recovery, MongoDB record, and server logs.

Before public launch, the adult operator should publish real Privacy, Terms,
Support, and Refund pages using their correct name/business and contact details.
The game now stores verified email addresses and purchase records, so generic or
copied legal pages are not enough.

## 8. Microsoft Store publishing

Do not submit the Stripe purchase surface as in-game commerce for the Microsoft
Store version. Current Microsoft Store policy 10.8.1 requires games selling
digital goods to use Microsoft Store in-product purchase APIs. This build detects
the Microsoft Store PWA commerce context using Windows platform, installed-app
display mode, and Digital Goods API support, then hides the web Premium purchase
tab; previously owned cosmetics still work.

Digital Goods API support alone is not treated as Microsoft Store detection,
because Chromebook Chrome can expose the same API. The Stripe Premium tab stays
available on Chromebook, macOS, Linux, mobile, and normal Windows browsers.

To sell Shards inside the Microsoft Store version, implement Microsoft's Digital
Goods API/Payment Request API and create matching Store add-ons first:

- https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/digital-goods-api
- https://learn.microsoft.com/en-us/windows/apps/publish/store-policies

For a free Store update without Store purchases:

1. Deploy and fully test the HTTPS web version.
2. In Partner Center, use the adult-managed publisher account.
3. Reserve/select Arena.io and package the deployed PWA with PWABuilder.
4. Upload the new package; do not reuse the old bundle if its package identity,
   manifest, or hosted URL differs.
5. Declare accounts, multiplayer/chat, data collection, and purchases accurately.
6. Provide a working privacy-policy URL and reviewer test instructions.
7. Test the package on Windows before submission.

Microsoft's PWA publishing guide:

https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/microsoft-store

## Product behavior added in this release

- Paid products live inside the existing Shop; no new main-menu button.
- Supporter and Elite packs include permanent exclusive cosmetics plus Shards.
- Checkout uses Stripe's hosted page; card details never pass through Arena.io.
- Successful fulfillment sends an idempotent purchase confirmation to the
  account's verified email from `purchases@mail.rileybylsma.tech`.
- Fulfillment checks account ID, product metadata, server Price ID, payment state,
  and event/session idempotency.
- Refunds revoke pack cosmetics and subtract granted Shards safely.
- Secure accounts use verified email, scrypt password hashing, lockouts, recovery
  codes, opaque HttpOnly cookies, and one-use Socket.IO login handoff codes.
- Ranked always awards full SR in bot-only matches, with bots included in placement.
- Players can permanently delete their account from the existing Account panel
  after confirming their name and current password/PIN. Game progress,
  entitlements, sessions, leaderboard entries, and player analytics are removed.
  Stripe transaction records are retained only for refunds and financial
  recordkeeping and are marked with the account deletion date; purchases do not
  return if the same player name is recreated.
