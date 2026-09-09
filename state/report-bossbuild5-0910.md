# REPORT bossbuild5 — meshdvm sprint-5: edge QA final (BOSS Battle)

Lane: BOSS Battle sprint-5, QA terakhir sebelum submit window. Tanggal: 2026-09-10/11. Deadline hackathon: 2026-10-05T18:29Z.
Status: **DONE** — (1) 4 edge case di-QA, 26 test baru (total **64/64 pass**), (2) 3 bug ketemu + difix (race ledger/balance, oversized echo, malformed content silent drop) + 1 behavior fix (bid 0 + token), (3) bot restart ke build baru, live health + E2E 3 job P2PK + 2 edge live test di 4 relay, (4) commit `11c5760` pushed, (5) report + journal.

## 1. Edge QA — 4 edge, 26 test baru (test/edge.test.js)

### (a) Koncurrent job handling — BUG KETEMU + DIFIX
- **Bug**: `makeJobHandler` async tanpa serialisasi. Dua job paralel bisa interleave: job B redeem → push ke `escrow.balance` di antara snapshot job A dan assignment `escrow.balance = c.keep` → proof B hilang dari balance in-memory (ledger tetap benar, refund berikutnya bisa fail "send failed"). Paralel juga bikin urutan `jobs`/`payments` row gak terjamin.
- **Fix** (src/index.js): job queue promise-chain — `tail.then(() => handleJobEvent(...))`, error ditelan ke log biar chain gak mati, handler tetap reject ke caller. Strict sequential, gak ada refactor besar.
- **Test** (6): 2 job paralel → 2 result + ledger 2 paid; 2 job overpaid paralel → change token disjoint (secrets unik, cek via getTokenMetadata), balance = keep gabungan, earned 10 sat bukan dobel; event sama dikirim 2x paralel → diproses 1x; paid+unpaid+bad-params paralel → masing-masing outcome sendiri; publish job 1 throw → job 2 tetap keluar result; urutan redeem strict sesuai arrival (receive di-order dengan jeda 5ms).

### (b) Oversized query param — BUG KETEMU + DIFIX
- **Bug**: filter 60KB lewat `content` JSON di-echo utuh ke feedback `invalid params: [{"param":"site","value":"AAA…"}]` → feedback event bisa MB-an; relay pasti reject, buyer gak dapet error.
- **Fix** (src/provider.js): `MAX_PARAM_LEN = 512`; `validateParams` reject value kepanjangan dgn pesan bounded yang nyebut panjang, bukan isinya. Cek known-value (site/sensor) di-skip untuk param yang udah kena too-long biar gak dobel.
- Clamp `limit`/`offset` ekstrem sudah aman dari week-1 (dicek ulang + dikunci test): `limit=99999999999999999999` → clamp 100, `limit=-5`/`1e999` → default 20, `offset` negatif/garbage → 0, sample endpoint `?limit=999…` → 100.
- **Test** (7): site 60KB → error bounded <1000 char, zero echo; 6 param lain sama; limit raksasa clamp; limit negatif/Infinity default; offset negatif/garbage clamp; sample endpoint cap; content 1MB garbage → error JSON bounded.

### (c) Malformed event content — BUG KETEMU + DIFIX
- **Bug**: content `{broken` (kelihatan JSON, parse fail) di-silent-ignore — buyer typo gak pernah dapet feedback apa pun.
- **Fix** (src/nip90.js + src/index.js): `parseRequestEvent` return `contentJsonError` saat content berawalan `{` tapi parse gagal (param tags + token tetap diekstrak); handler kirim feedback `error` "malformed event content: … (raw content ignored, param tags still apply)" + status ledger `error_params`. Content plain-text (gak berawalan `{`) tetap lolos seperti sebelumnya.
- **Test** (6): broken JSON → error feedback eksplisit + gak ada result; flag di parse layer; plain-text content gak error; JSON valid dgn key asing 5KB gak leak ke feedback; `cashu: 123` (bukan string) → dianggap gak ada token, gak crash; param JSON tipe salah (object/array) → `invalid params` readable; bid non-numerik → dianggap tanpa bid (bukan NaN poisoning).

### (d) Budget 0 / negatif — BEHAVIOR FIX
- **Bug**: bid `0`/`-2000` + token cukup → `payment_required` padahal uang sudah diterima (bid dicek sebelum token). Kontrak: token = pembayaran; bid cuma sinyal kalau gak ada token.
- **Fix** (src/index.js): gate bid cuma jalan saat `req.token === null`. Bid 0/negatif/below-price tanpa token tetap `payment_required` (back-compat dengan smoke test lama, tetap pass).
- **Test** (6): bid 0 tanpa token → payment_required nyebut budget; bid -2000/-1 sama; bid below-price tetap payment_required; bid 0 + token 2 sat → paid penuh; bid -999 + token → paid; token 1 sat + bid 0 → payment_required dari amount check (`token worth 1 sat, need 2 sat`).

## 2. Verifikasi
- `npm test`: **64/64 pass** (38 lama + 26 baru), 0 fail.
- Live E2E di build baru (pid 3750635):
  - 1 job tunggal P2PK 5 sat → redeem 4 + refund 3 → result `p2pk_locked: true` (client exit 0).
  - 2 client paralel ditembak bareng → dua-duanya paid, result diterima keduanya (ledger 16 jobs), queue sequential jalan.
  - Oversized live: job dgn `site` 60KB via content JSON → feedback `bad params: value too long: 60000 chars, max 512` di log bot (job `003d2974`).
  - Malformed live: job `bd5fba5d` dgn token valid + content `{"site": "metro-core"` (parse fail) → bot balas `7000 error "malformed event content: content looks like JSON but failed to parse"`; token refund-able (bot gak redeem, sesuai desain fail-closed). (1 DVM lain juga jawab — normal di relay publik.)
  - Bid 0 live: job `c0d8a278` bid 0 + token 2 sat → `processing` → `6050` result penuh. Fix kebukti live.
- `/health`: 5 relay, ledger akumulasi 19 seen / 17 paid / 90 sat earned / 20 refunded (termasuk 1 `error_params` malformed + 1 `error_params` oversized yang benar tercatat).

## 3. Uptime check
- Bot lama (pid 3352002, sejak 09-09 06:54, uptime 6060s saat cek) hidup di 5 relay, port 8795, ledger 12/79. Proses systemd hanya sensormesh-api (bukan meshdvm); meshdvm jalan nohup.
- Bot di-restart ke build sprint-5 (pindah kode wajib): kill 3352002 → nohup `node --env-file-if-exists=.env src/index.js` → pid **3750635**, boot log bersih (npub sama, p2pk lock 80307aaf…, 5 relay, ledger restored 12/79/17), `/health` OK, E2E 3 job sukses di atasnya.

## 4. Commit push
- `11c5760` sprint 5: 4 file (src/index.js +30, src/nip90.js +18, src/provider.js +19, test/edge.test.js +453). Push `9bf15d3..11c5760` → github.com/jayjex/meshdvm VERIFIED.

## Gotcha lane
1. cashu-ts v4: `getDecodedToken()` butuh keyset/struktur penuh (throw di token fake); pakai `getTokenMetadata()` untuk decode di test.
2. Proof `secret` di token v4 harus hex — nama test `c-1` mentah bikin `hexToBytes` RangeError; helper test hex-encode secret.
3. `jsonBuffer` gak dipakai (malformed via `contentJsonError`); `rows` placeholder di test hampir ke-commit — dihapus.
4. Skenario "publish throw" awalnya assert `paid_jobs 1` — salah: uang job 1 sudah redeem sebelum result publish gagal; itu kegagalan publish seam, bukan buku. Assert diganti 2 dengan komentar.
5. Testnet buyers: DVM lain (Jeletor) juga jawab job di relay publik — feedback dobel dari non-bot normal, jangan dianggap bug.

## Biaya
$0 (testnet ecash + relay publik + GitHub free).

## Next (submission window, gate parent)
1. Devfolio draft tetap 100% terisi, status draft, Publish = gate parent (state `tmp/devboss1/df-state.json`).
2. Opsional: tambah "64 tests" di draft (sekarang bilang 38) + catatan edge QA sebelum klik Publish.
3. Backlog tetap: multi-mint, NIP-89 announce.
