// meshdvm — NIP-90 Data Vending Machine for SensorMesh data, paid in Cashu ecash.
// One process, two surfaces:
//   1. Nostr listener: subscribes kind 5050 job requests on the configured relays,
//      replies with kind 7000 feedback and kind 6050 results.
//   2. HTTP sample endpoint: free preview of the dataset (default :8795).
import http from "node:http";
import { finalizeEvent, getPublicKey, generateSecretKey, nip19, SimplePool } from "nostr-tools";

import { KIND_REQUEST, KIND_RESULT, KIND_FEEDBACK, parseRequestEvent, buildResultEvent, buildFeedbackEvent } from "./nip90.js";
import * as query from "./query.js";
import { buildDataPayload, validateParams, PRICE_MSAT, PRICE_SATS } from "./provider.js";
import { CashuEscrow, DEFAULT_MINT_URL } from "./cashu.js";
import { Ledger } from "./ledger.js";
import { calcChange, buildRefundToken, MIN_CHANGE_SATS } from "./refund.js";

const RELAYS = (process.env.MESH_RELAYS || "wss://nos.lol,wss://relay.primal.net,wss://offchain.pub")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const HTTP_PORT = Number(process.env.MESH_HTTP_PORT || 8795);

// ---------------------------------------------------------------- nostr side
export function makeJobHandler({ escrow, ledger = null, privkey, log = console.log }) {
  const botPubkey = getPublicKey(privkey);
  return async function handleJobEvent(ev, publish) {
    const t0 = Date.now();
    // Dedup on the raw event id, marked before any processing: relays replay
    // events and a restart re-delivers recent ones, so the second copy of a
    // job must never verify or redeem its token again.
    if (ledger && !ledger.markSeen(ev.id)) {
      log(`[job] ${ev.id?.slice(0, 8)} duplicate, skipped`);
      return;
    }
    const req = parseRequestEvent(ev);
    if (!req.ok) {
      log(`[job] ${ev.id?.slice(0, 8)} rejected: ${req.error}`);
      return;
    }
    ledger?.recordJob({ requestId: req.requestId, requester: req.requester, params: req.params, budgetMsat: req.budgetMsat, status: "received" });
    log(`[job] ${req.requestId.slice(0, 8)} from ${req.requester.slice(0, 8)} params=${JSON.stringify(req.params)}`);

    const feedback = (status, extra) =>
      publish(finalizeEvent(buildFeedbackEvent(req, status, { mintUrl: escrow.mintUrl, ...extra }), privkey));

    const problems = validateParams(query, req.params);
    if (problems.length) {
      log(`[job] ${req.requestId.slice(0, 8)} bad params: ${JSON.stringify(problems)}`);
      ledger?.updateJobStatus(req.requestId, "error_params");
      return feedback("error", { message: `invalid params: ${JSON.stringify(problems)}` });
    }
    if (req.budgetMsat !== null && req.budgetMsat < PRICE_MSAT) {
      ledger?.updateJobStatus(req.requestId, "payment_required_low_budget");
      return feedback("payment_required", {
        amountMsat: PRICE_MSAT,
        message: `price ${PRICE_MSAT} msat per call, budget ${req.budgetMsat} msat too low`,
      });
    }

    if (!req.token) {
      const { quote } = await escrow.getQuote(PRICE_SATS).catch(() => ({ quote: null }));
      ledger?.updateJobStatus(req.requestId, "payment_required_no_token");
      return feedback("payment_required", {
        amountMsat: PRICE_MSAT,
        message: quote
          ? `send a cashu token of at least ${PRICE_SATS} sat minted at ${escrow.mintUrl} (quote ${quote}, put it in content {"cashu":"cashu..."} or a cashu tag)`
          : `send a cashu token of at least ${PRICE_SATS} sat minted at ${escrow.mintUrl} (content {"cashu":"cashu..."} or a cashu tag)`,
      });
    }

    await feedback("processing", { message: "token received, verifying" });
    const v = await escrow.verifyToken(req.token);
    if (!v.ok) {
      log(`[job] ${req.requestId.slice(0, 8)} token invalid: ${v.reason}`);
      ledger?.updateJobStatus(req.requestId, "error_payment_rejected");
      return feedback("error", { message: `payment rejected: ${v.reason}` });
    }
    if (v.amountSats < PRICE_SATS) {
      ledger?.updateJobStatus(req.requestId, "payment_required_underpaid");
      return feedback("payment_required", {
        amountMsat: PRICE_MSAT,
        message: `token worth ${v.amountSats} sat, need ${PRICE_SATS} sat`,
      });
    }

    const r = await escrow.redeemToken(req.token);
    log(`[job] ${req.requestId.slice(0, 8)} redeem ${r.ok ? `ok ${r.amountSats} sat` : `failed: ${r.reason}`}`);
    if (!r.ok) {
      ledger?.updateJobStatus(req.requestId, "error_redeem_failed");
      return feedback("error", { message: `could not redeem token: ${r.reason}` });
    }
    const overpaySats = calcChange(r.amountSats, PRICE_SATS);
    ledger?.recordPayment({ requestId: req.requestId, token: req.token, amountSats: r.amountSats, overpaymentSats: overpaySats, proofs: r.proofs });

    // Overpayment goes back to the requester as a fresh token split off the
    // bot's balance. Below MIN_CHANGE_SATS the split costs more in keyset fees
    // than it is worth, so it is reported as a tip instead.
    let refund = { sent: false, sats: overpaySats, note: overpaySats > 0 ? `below ${MIN_CHANGE_SATS} sat change threshold, kept as tip` : null };
    if (overpaySats >= MIN_CHANGE_SATS) {
      const c = await buildRefundToken(escrow.wallet, overpaySats, escrow.balance);
      if (c.ok) {
        refund = { sent: true, sats: c.amountSats, token: c.token };
        if (c.keep) escrow.balance = c.keep; // spent proofs out, keep-side swap proofs in
        log(`[job] ${req.requestId.slice(0, 8)} refund ${c.amountSats} sat prepared`);
      } else {
        refund = { sent: false, sats: overpaySats, note: `change send failed: ${c.reason}` };
        log(`[job] ${req.requestId.slice(0, 8)} refund failed: ${c.reason}`);
      }
      ledger?.recordRefund({ requestId: req.requestId, amountSats: refund.sent ? c.amountSats : overpaySats, token: refund.token || null, state: refund.sent ? "sent" : refund.sent === false && refund.note?.startsWith("change send failed") ? "failed" : "kept" });
    }

    const payload = await buildDataPayload(query, req.params);
    payload.payment = {
      method: "cashu",
      amount_sats: PRICE_SATS,
      overpayment_sats: overpaySats,
      change: refund.sent ? "see payment.change_token" : refund.note || null,
      change_token: refund.token || null,
      mint: escrow.mintUrl,
      state: "redeemed",
    };

    const result = finalizeEvent(buildResultEvent(req, payload, { amountMsat: PRICE_MSAT, mintUrl: escrow.mintUrl, botPubkey }), privkey);
    await publish(result);
    ledger?.updateJobStatus(req.requestId, "paid", result.id);
    log(`[job] ${req.requestId.slice(0, 8)} result ${result.id.slice(0, 8)} published in ${Date.now() - t0}ms`);
    return result;
  };
}

export function startNostrListener({ escrow, ledger = null, privkey, relays = RELAYS, log = console.log }) {
  // enableReconnect: relay sockets idle out after 20s by default; without
  // reconnect the bot goes deaf on quiet relays and misses jobs.
  const pool = new SimplePool({ enableReconnect: true });
  const publish = async (event) => {
    const res = await Promise.allSettled(pool.publish(relays, event));
    res.forEach((r, i) => {
      if (r.status === "rejected") log(`[relay] ${relays[i]} publish rejected: ${r.reason?.message || r.reason}`);
    });
    return event;
  };
  const handleJobEvent = makeJobHandler({ escrow, ledger, privkey, log });

  const sub = pool.subscribeMany(
    relays,
    { kinds: [KIND_REQUEST], since: Math.floor(Date.now() / 1000) - 60 },
    {
      onevent: (ev) => handleJobEvent(ev, publish).catch((e) => log(`[job] handler error: ${e.message}`)),
      onclose: (reasons) => {
        log(`[relay] subscription closed: ${JSON.stringify(reasons)}`);
        // idle close without reconnect would leave the bot deaf; re-subscribe
        if (pool.relays.size === 0 || !pool.relays.size) return;
      },
    }
  );
  log(`[nostr] listening kind ${KIND_REQUEST} on ${relays.join(" ")}`);
  return { pool, sub, relays, publish };
}

// ---------------------------------------------------------------- http sample side
export function buildSampleResponse(q, limitRaw = "20") {
  const limit = Math.min(Math.max(1, Number(limitRaw) || 20), query.MAX_ROWS_PER_CALL);
  return {
    dataset: "sensormesh-sample",
    note: "free preview, first page of rows. Full queries via NIP-90 kind 5050 jobs paid in cashu.",
    sha256: q.sha256,
    total_rows_in_file: q.total_rows_in_file,
    returned: q.page.length,
    page: q.page,
    buy: { nostr_kind: KIND_REQUEST, mint: DEFAULT_MINT_URL, price_sats: PRICE_SATS },
  };
}

export function startHttpSampleServer({ log = console.log, port = HTTP_PORT, ledger = null } = {}) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost");
    try {
      if (u.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({
          ok: true,
          relays: RELAYS,
          mint: DEFAULT_MINT_URL,
          price_sats: PRICE_SATS,
          uptime_s: Math.round(process.uptime()),
          ...(ledger ? { ledger: ledger.stats() } : {}),
        }));
      }
      if (u.pathname === "/v1/sensormesh/sample") {
        const data = await query.loadData();
        const page = await query.queryReadings({}, Number(u.searchParams.get("limit") || 20), 0);
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify(buildSampleResponse({ ...page, sha256: data.sha256 }, u.searchParams.get("limit") || "20")));
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not found", routes: ["/health", "/v1/sensormesh/sample?limit=20"] }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  server.listen(port, () => log(`[http] sample endpoint on :${port}`));
  return server;
}

// ---------------------------------------------------------------- entry
export async function main({ privkey, relays, port, dbPath } = {}) {
  let key = privkey;
  if (!key && process.env.MESH_NSEC) key = new Uint8Array(nip19.decode(process.env.MESH_NSEC).data);
  if (!key) {
    const { generateSecretKey } = await import("nostr-tools");
    key = generateSecretKey();
    console.log(`[keys] no MESH_NSEC set, ephemeral dev key: ${nip19.npubEncode(getPublicKey(key))} (proofs will not persist)`);
  }
  const escrow = await CashuEscrow.create();
  const ledger = new Ledger(dbPath);
  const npub = nip19.npubEncode(getPublicKey(key));
  console.log(`[meshdvm] npub ${npub}`);
  console.log(`[meshdvm] mint ${DEFAULT_MINT_URL}, price ${PRICE_SATS} sat/call, result kind ${KIND_RESULT}, feedback kind ${KIND_FEEDBACK}`);
  console.log(`[meshdvm] ledger ${dbPath || process.env.MESH_DB || "data/meshdvm.sqlite3"} ${JSON.stringify(ledger.stats())}`);
  const listener = startNostrListener({ escrow, ledger, privkey: key, ...(relays ? { relays } : {}) });
  const httpServer = startHttpSampleServer({ ...(port ? { port } : {}), ledger });
  return { listener, httpServer, escrow, ledger, npub };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  // relay sockets come and go; a failed connect must not kill the bot
  process.on("uncaughtException", (e) => console.error(`[uncaught] ${e.stack || e.message}`));
  process.on("unhandledRejection", (e) => console.error(`[unhandled] ${e && e.message ? e.message : e}`));
  main().catch((e) => {
    console.error(`[meshdvm] fatal: ${e.message}`);
    process.exit(1);
  });
}
