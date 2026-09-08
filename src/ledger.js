// Job ledger on better-sqlite3. One file (default data/meshdvm.sqlite3) holds
// everything the bot needs to survive a restart: which events were already
// processed (dedup against relay replays), what jobs came in, what was paid,
// and what change was refunded. Synchronous API on purpose — the job handler
// is single-threaded per event and a restart mid-write is not a scenario here.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hashToken(token) {
  return createHash("sha256").update(String(token)).digest("hex");
}

export class Ledger {
  constructor(dbPath = process.env.MESH_DB || "data/meshdvm.sqlite3") {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        request_id TEXT PRIMARY KEY,
        requester TEXT NOT NULL,
        params_json TEXT,
        budget_msat INTEGER,
        status TEXT NOT NULL,
        result_event_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payments (
        request_id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL,
        amount_sats INTEGER NOT NULL,
        overpayment_sats INTEGER NOT NULL,
        proofs_json TEXT,
        redeemed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS refunds (
        request_id TEXT PRIMARY KEY,
        amount_sats INTEGER NOT NULL,
        token TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS seen_events (
        event_id TEXT PRIMARY KEY,
        seen_at INTEGER NOT NULL
      );
    `);
    this._stmts = {
      seen: this.db.prepare("SELECT event_id FROM seen_events WHERE event_id = ?"),
      mark: this.db.prepare("INSERT OR IGNORE INTO seen_events (event_id, seen_at) VALUES (?, ?)"),
      job: this.db.prepare(
        "INSERT OR REPLACE INTO jobs (request_id, requester, params_json, budget_msat, status, result_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      ),
      jobStatus: this.db.prepare("UPDATE jobs SET status = ?, result_event_id = ?, updated_at = ? WHERE request_id = ?"),
      payment: this.db.prepare(
        "INSERT OR REPLACE INTO payments (request_id, token_hash, amount_sats, overpayment_sats, proofs_json, redeemed_at) VALUES (?, ?, ?, ?, ?, ?)"
      ),
      refund: this.db.prepare(
        "INSERT OR REPLACE INTO refunds (request_id, amount_sats, token, state, created_at) VALUES (?, ?, ?, ?, ?)"
      ),
      stats: {
        jobs: this.db.prepare("SELECT COUNT(*) AS n FROM jobs"),
        paid: this.db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(amount_sats), 0) AS sats FROM payments"),
        refunds: this.db.prepare("SELECT COALESCE(SUM(amount_sats), 0) AS sats FROM refunds WHERE state = 'sent'"),
        seen: this.db.prepare("SELECT COUNT(*) AS n FROM seen_events"),
      },
    };
  }

  isSeen(eventId) {
    return !!this._stmts.seen.get(eventId);
  }

  /** Mark an event as processed. Returns true only for the first call, so a
   *  relay replay (or two relays delivering the same event) hits the DB once. */
  markSeen(eventId) {
    return this._stmts.mark.run(eventId, Date.now()).changes > 0;
  }

  recordJob({ requestId, requester, params, budgetMsat, status }) {
    const now = Date.now();
    this._stmts.job.run(requestId, requester, JSON.stringify(params || {}), budgetMsat, status, null, now, now);
  }

  updateJobStatus(requestId, status, resultEventId = null) {
    this._stmts.jobStatus.run(status, resultEventId, Date.now(), requestId);
  }

  recordPayment({ requestId, token, amountSats, overpaymentSats, proofs }) {
    this._stmts.payment.run(requestId, hashToken(token), amountSats, overpaymentSats, JSON.stringify(proofs || []), Date.now());
  }

  recordRefund({ requestId, amountSats, token = null, state }) {
    this._stmts.refund.run(requestId, amountSats, token, state, Date.now());
  }

  stats() {
    const jobs = this._stmts.stats.jobs.get().n;
    const paid = this._stmts.stats.paid.get();
    const refunded = this._stmts.stats.refunds.get().sats;
    return {
      jobs,
      paid_jobs: paid.n,
      earned_sats: paid.sats,
      refunded_sats: refunded,
      seen_events: this._stmts.stats.seen.get().n,
    };
  }

  close() {
    this.db.close();
  }
}
