# Architecture

One Node process, three layers. Data flows Nostr → escrow → query engine → Nostr, with the sample endpoint branching off the query engine directly.

```
                 kind 5050 (job request)
 relay pool ──▶  nip90.parseRequestEvent      params / bid / cashu token
                 │
                 ▼
                 index.makeJobHandler
                 │  validateParams (provider)     bad params → kind 7000 "error"
                 │  budget < price                → kind 7000 "payment_required"
                 │  no token                      → kind 7000 "payment_required" (+ quote)
                 ▼
                 cashu.CashuEscrow
                 │  verifyToken: decode, mint match, NUT-07 checkstate
                 │  redeemToken:  wallet.receive (swap into bot keyset)
                 ▼
                 query.queryReadings / getStats   (vendored SensorMesh engine)
                 │  filters, pagination, sha256 pin
                 ▼
                 kind 6050 result (data JSON) + kind 7000 "processing" along the way

 http :8795 ──▶  /v1/sensormesh/sample   free first page + dataset hash
                 /health                 relays, mint, price, uptime
```

## Modules

- `src/nip90.js` — protocol only, pure functions: parse kind 5050 requests (`param` tags, JSON content override, `bid` budget, `relays` hint, embedded token), build kind 6050 results and kind 7000 feedback. Unit-tested with no I/O.
- `src/cashu.js` — escrow seam. `CashuEscrow` wraps a cashu-ts `Mint` + `Wallet`; both are injectable, so tests run against fakes. Quote (NUT-04), token verify (NUT-07 checkstate, mint allow-list, spent rejection), redeem (swap into the bot's proofs). Price is flat per call in week 1.
- `src/provider.js` — maps NIP-90 params onto the query engine, validates filter values against known sites/sensors, prices the call.
- `src/query.js` — the SensorMesh query engine vendored from `money-mission/sensormesh/mcp/lib/query.js`. Loads the CSV once, pins it to a SHA-256, answers filters/pagination/stats from memory. Kept verbatim apart from the data path default.
- `src/index.js` — wiring: SimplePool subscription + publish, job handler state machine, HTTP sample server, env config.

## Kind mapping

Requests 5050, results 6050, feedback 7000. NIP-90 defines requests in 5000-5999, results as request kind + 1000 (6000-6999), feedback at 7000. A 5050 result kind would not round-trip through other NIP-90 clients, so the +1000 rule wins.

## Money path

testnut.cashu.space is a public testnet mint (FakeWallet: invoices auto-confirm), so the full mint → token → verify → swap loop runs without real sats. The bot treats the mint as the only trusted third party: proofs are checked for spend state at the mint and swapped on accept, meaning a replayed token fails checkstate. Change for overpayments is computed and reported in the result payload; pushing it back as a new token is sprint-2 work. Bot proof balance lives in the process for now; persistence is also sprint 2.

## Data

`data/sensormesh-sample.csv`, 1,296 readings from 3 sites (metro-core, riverside-park, north-industrial), 3 sensor types (air_quality, temperature, noise), timestamps 2026-09-08. The hash in every result and in the sample endpoint refers to this file.
