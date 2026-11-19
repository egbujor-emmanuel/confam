# Confam: Devpost submission text

**Tagline:** Pay airtime, data and electricity with Bitcoin. If it doesn't arrive, you were never charged.

**Links**
- Live app: https://confam-qxdh.onrender.com (English / Français, phone-first)
- Code (MIT): https://github.com/egbujor-emmanuel/confam
- Live metrics: https://confam-qxdh.onrender.com/api/stats?days=30
- Demo video: (link added at upload)

## Try it in 2 minutes (no account, test money only)
1. Open the live app, tap **⚡ Connect wallet**, then **Get a free test wallet** (25,000 test sats).
2. Pick a country and a product. In Nigeria, tap **Use test number** / **Use test meter**.
3. Pay with **Pay with my Confam wallet** and watch: *Payment locked → Buying it for you → Provider confirmed delivery → Payment completed*, then a Nostr-signed receipt your browser verifies.

| Country | Airtime | Data | Electricity |
|---|---|---|---|
| Nigeria | `08011111111` delivered · `201000000000` stays pending (released at 90 s) · any other number fails (released at once) | same numbers | Ikeja Electric prepaid meter `1111111111111` |
| Senegal | any number delivered · `201000000000` pending | any number · `201000000000` pending | Woyofal: any meter number (test token) |
| Côte d'Ivoire, Ghana, Mali, Burkina Faso, Benin, Togo, Guinea, Uganda, South Africa, Zambia, Malawi | any number · `201000000000` pending | any number · `201000000000` pending | not offered |
| Kenya, Cameroon, Tanzania, Rwanda, Ethiopia, Mozambique | any number · `201000000000` pending | not offered | not offered |

## Inspiration
Every Nigerian knows the message: debited, not credited. You pay for airtime or an electricity token, the
money leaves, the product never comes, and the refund takes days or weeks. The money moves first and the
product comes later, so all the risk sits with the customer.

## What it does
Confam lets you pay for airtime (19 African countries), data bundles (13) and prepaid electricity
(Nigeria's distribution companies and Senegal's Woyofal) with Bitcoin over Lightning. Your payment is a
**hold invoice**: the sats are locked in the Lightning network, not sent. Confam buys the product from the
provider, and only when the provider confirms delivery does it settle the invoice. If delivery fails, or
nobody confirms within 90 seconds, the lock opens and the sats never left your wallet. No refund to chase.

## How we built it
- **Lightning:** hold invoices over Nostr Wallet Connect (`make_hold_invoice`, `settle_hold_invoice`,
  `cancel_hold_invoice`); the merchant wallet can issue and settle invoices but never send funds.
- **Providers:** VTpass (Nigeria and international airtime/data, Nigerian electricity) and DEXPAY (Dakar)
  for Senegal's Woyofal electricity. Every purchase carries the order reference as its idempotency key.
- **Order engine:** a state machine (awaiting payment → locked → buying → delivered → completed, or
  released). It buys at most once, settles only on a confirmed delivery, recovers lost provider replies by
  our own reference, and releases on failure or at the deadline.
- **Receipts:** Nostr-signed events (kind 30078), verified in the browser.
- **Stack:** Node 24, Fastify, SQLite with a Turso copy every 5 seconds (a restart never loses a locked
  payment), React 19 + Vite, GSAP, a three.js lock that loads after the page and falls back to a still
  image on 2G or data-saver. About 94 KB of JavaScript on first load (gzipped).
- **Tests:** 122 unit and API tests, plus live tests against real NWC wallets and Turso.

## Challenges
- Provider sandboxes behave differently from their docs: VTpass's live catalogue sometimes answers with
  an empty list, and DEXPAY's sandbox occasionally hangs and returns a Cloudflare 520. Confam now keeps
  the last good catalogue, and tells the customer "the lookup isn't answering, try again" instead of
  "meter not found".
- "Not found" at the provider is not proof of non-delivery. Releasing early could hand out free airtime,
  so unclear replies stay pending until the deadline, and late confirmations are recorded for
  reconciliation.

## Accomplishments
- The guarantee is measured in public: `chargedWithoutDelivery` on `/api/stats` must always be 0.
- One app, two markets, two languages: Lagos airtime in naira and Dakar electricity in CFA, in French.
- Judges in any of 19 countries can test with their own country's numbers.

## What we learned
Escrow on Lightning needs no custody: a hold invoice is enough when the merchant never holds the money
until the product exists.

## What's next
1. Real money: an Alby Hub node issuing hold invoices, funded live provider accounts, and float alerts.
2. More bills: TV (DStv, GOtv, StarTimes) through VTpass; Senelec postpaid and SenEau water through DEXPAY.
3. "Keep my meter topped up": recurring orders from an NWC budget, each settled only after delivery.
4. Agents: a reseller mode so street airtime vendors can accept sats with the same guarantee.

## Built with
bitcoin · lightning · hold-invoices · nostr · nostr-wallet-connect · node.js · fastify · typescript ·
react · vite · gsap · three.js · sqlite · turso · vtpass · dexpay · render
