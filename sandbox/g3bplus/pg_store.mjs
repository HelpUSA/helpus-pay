/**
 * G3-B+ PostgreSQL adapter: disposable loopback database ONLY, synthetic order/charge/outbox.
 * Not imported by deployed Pay. No real PIX, PSP, bank refunds or production credentials.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { Pool } from 'pg';

function guard() {
  if (process.env.NODE_ENV === 'production' || process.env.HELPUS_G3BPLUS_LOCAL_ONLY !== '1')
    throw Error('G3BPLUS_LOCAL_ONLY_REQUIRED');
}
function validTenant(v) { if (typeof v !== 'string' || !/^tenant_[a-zA-Z0-9_]{1,56}$/.test(v)) throw Error('INVALID_SYNTHETIC_TENANT'); }
function validId(v) { if (typeof v !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(v)) throw Error('INVALID_SYNTHETIC_ID'); }
function value(v) {
  if (!Number.isFinite(v) || v <= 0 || v > 10000 || Math.abs(Math.round(v * 100) - v * 100) > 1e-7)
    throw Error('INVALID_SYNTHETIC_AMOUNT');
  return Number(v.toFixed(2));
}
function fingerprint(v) { return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex'); }
async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally { client.release(); }
}
async function lock(c, key) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
}
function shape(r) {
  return r ? { tenantId: r.tenant_id, orderId: r.order_id, txid: r.txid, amount: Number(r.amount),
    status: r.status, expiresAt: r.expires_at.toISOString(), paidAt: r.paid_at?.toISOString() || null } : null;
}
export class G3BPlusPgStore {
  constructor({ host = '127.0.0.1', port = 5432, database, user, password } = {}) {
    guard();
    if (host !== '127.0.0.1' || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof database !== 'string' || !/^g3bplus_[a-z0-9_]{1,40}$/.test(database) ||
      typeof user !== 'string' || !/^g3bplus_[a-z0-9_]{1,40}$/.test(user) ||
      typeof password !== 'string' || password.length < 20) throw Error('DISPOSABLE_LOCAL_POSTGRES_REQUIRED');
    this.pool = new Pool({ host, port, database, user, password, max: 8,
      connectionTimeoutMillis: 3000, statement_timeout: 4500, ssl: false,
      application_name: 'g3bplus-fixture-only' });
  }
  async initSchema() {
    guard();
    const sql = await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.pool.query(sql);
  }
  async get(tenantId, txid) {
    guard(); validTenant(tenantId); validId(txid);
    return transaction(this.pool, async conn => {
      const r = await conn.query('SELECT * FROM g3lab_charges WHERE tenant_id=$1 AND txid=$2 FOR UPDATE', [tenantId, txid]);
      const ch = r.rows[0];
      if (!ch) return null;
      if (ch.status === 'PENDING' && ch.expires_at.getTime() <= Date.now()) {
        await conn.query("UPDATE g3lab_charges SET status='EXPIRED' WHERE txid=$1", [txid]);
        await conn.query("UPDATE g3lab_orders SET status='EXPIRED' WHERE tenant_id=$1 AND order_id=$2 AND status='WAITING_PAYMENT'",
          [tenantId, ch.order_id]);
        ch.status = 'EXPIRED';
      }
      return shape(ch);
    });
  }
  async getOrder(tenantId, orderId) {
    guard(); validTenant(tenantId); validId(orderId);
    const r = await this.pool.query('SELECT tenant_id,order_id,status,amount FROM g3lab_orders WHERE tenant_id=$1 AND order_id=$2', [tenantId, orderId]);
    return r.rows[0] ? { tenantId, orderId, status: r.rows[0].status, amount: Number(r.rows[0].amount) } : null;
  }
  async createCharge({ tenantId, orderId, customerPhone, amount, idempotencyKey }) {
    guard(); validTenant(tenantId); validId(orderId); validId(idempotencyKey);
    const money = value(amount);
    if (typeof customerPhone !== 'string' || !/^[0-9]{10,15}$/.test(customerPhone)) throw Error('INVALID_SYNTHETIC_PHONE');
    const hash = fingerprint({ tenantId, orderId, customerPhone, amount: money });
    return transaction(this.pool, async c => {
      await lock(c, 'request:' + tenantId + ':' + idempotencyKey);
      await lock(c, 'order:' + tenantId + ':' + orderId);
      const key = await c.query('SELECT * FROM g3lab_keys WHERE tenant_id=$1 AND request_key=$2', [tenantId, idempotencyKey]);
      if (key.rowCount) {
        if (key.rows[0].payload_sha256 !== hash) throw Error('IDEMPOTENCY_KEY_COLLISION');
        const r = await c.query('SELECT * FROM g3lab_charges WHERE tenant_id=$1 AND txid=$2', [tenantId, key.rows[0].txid]);
        if (!r.rowCount) throw Error('BROKEN_IDEMPOTENCY_FK');
        return { ...shape(r.rows[0]), idempotent: true };
      }
      const old = await c.query('SELECT 1 FROM g3lab_orders WHERE tenant_id=$1 AND order_id=$2', [tenantId, orderId]);
      if (old.rowCount) throw Error('ORDER_ALREADY_EXISTS');
      const txid = 'tx_mock_' + crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 900_000);
      await c.query('INSERT INTO g3lab_orders(tenant_id,order_id,customer_phone,amount,status) VALUES($1,$2,$3,$4,$5)',
        [tenantId, orderId, customerPhone, money, 'WAITING_PAYMENT']);
      await c.query('INSERT INTO g3lab_charges(txid,tenant_id,order_id,amount,status,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [txid, tenantId, orderId, money, 'PENDING', expiresAt]);
      await c.query('INSERT INTO g3lab_keys(tenant_id,request_key,payload_sha256,txid) VALUES($1,$2,$3,$4)',
        [tenantId, idempotencyKey, hash, txid]);
      return { tenantId, orderId, txid, amount: money, status: 'PENDING',
        expiresAt: expiresAt.toISOString(), idempotent: false };
    });
  }
  async cancel(tenantId, txid) {
    guard(); validTenant(tenantId); validId(txid);
    return transaction(this.pool, async c => {
      const r = await c.query('SELECT * FROM g3lab_charges WHERE tenant_id=$1 AND txid=$2 FOR UPDATE', [tenantId, txid]);
      if (!r.rowCount) throw Error('CHARGE_NOT_FOUND');
      const ch = r.rows[0];
      await c.query('SELECT 1 FROM g3lab_orders WHERE tenant_id=$1 AND order_id=$2 FOR UPDATE', [tenantId, ch.order_id]);
      if (ch.status === 'CANCELLED') return { status: 'CANCELLED', idempotent: true };
      if (ch.status === 'PENDING' && ch.expires_at.getTime() <= Date.now()) {
        await c.query("UPDATE g3lab_charges SET status='EXPIRED' WHERE txid=$1", [txid]);
        await c.query("UPDATE g3lab_orders SET status='EXPIRED' WHERE tenant_id=$1 AND order_id=$2 AND status='WAITING_PAYMENT'",
          [tenantId, ch.order_id]);
        return { status: 'EXPIRED', cannotCancel: true };
      }
      if (ch.status !== 'PENDING') throw Error('CANNOT_CANCEL_' + ch.status);
      await c.query("UPDATE g3lab_charges SET status='CANCELLED' WHERE txid=$1", [txid]);
      await c.query("UPDATE g3lab_orders SET status='CANCELLED' WHERE tenant_id=$1 AND order_id=$2", [tenantId, ch.order_id]);
      return { status: 'CANCELLED', idempotent: false };
    });
  }
  async settle({ tenantId, txid, eventId, paidAmount, allowLateBankEvent = false }) {
    guard(); validTenant(tenantId); validId(txid); validId(eventId);
    if (typeof allowLateBankEvent !== 'boolean') throw Error('INVALID_EVENT_FLAG');
    const money = value(paidAmount);
    const hash = fingerprint({ tenantId, txid, eventId, paidAmount: money, allowLateBankEvent });
    return transaction(this.pool, async c => {
      await lock(c, 'event:' + eventId);
      const previous = await c.query('SELECT * FROM g3lab_events WHERE event_id=$1', [eventId]);
      if (previous.rowCount) {
        if (previous.rows[0].payload_sha256 !== hash) throw Error('EVENT_ID_PAYLOAD_MISMATCH');
        return { ...previous.rows[0].outcome, replay: true };
      }
      const r = await c.query('SELECT * FROM g3lab_charges WHERE tenant_id=$1 AND txid=$2 FOR UPDATE', [tenantId, txid]);
      if (!r.rowCount) throw Error('CHARGE_NOT_FOUND');
      const ch = r.rows[0];
      await c.query('SELECT 1 FROM g3lab_orders WHERE tenant_id=$1 AND order_id=$2 FOR UPDATE', [tenantId, ch.order_id]);
      if (Number(ch.amount) !== money) throw Error('AMOUNT_MISMATCH');
      const expired = ch.expires_at.getTime() <= Date.now();
      let outcome, kind;
      if (ch.status === 'PENDING' && !expired) {
        const paidAt = new Date().toISOString();
        await c.query("UPDATE g3lab_charges SET status='PAID',paid_at=$2 WHERE txid=$1", [txid, paidAt]);
        await c.query("UPDATE g3lab_orders SET status='PAID',paid_at=$3 WHERE tenant_id=$1 AND order_id=$2",
          [tenantId, ch.order_id, paidAt]);
        kind = 'CALLBACK';
        outcome = { success: true, action: 'PAID', tenantId, orderId: ch.order_id, txid, paidAt };
      } else if (allowLateBankEvent && (ch.status === 'CANCELLED' || ch.status === 'EXPIRED' || expired)) {
        // Synthetic report of an after-cancel bank event; NEVER marks order PAID and NEVER issues a refund.
        if (ch.status === 'PENDING' && expired) {
          await c.query("UPDATE g3lab_charges SET status='EXPIRED' WHERE txid=$1", [txid]);
          await c.query("UPDATE g3lab_orders SET status='EXPIRED' WHERE tenant_id=$1 AND order_id=$2 AND status='WAITING_PAYMENT'",
            [tenantId, ch.order_id]);
        }
        kind = 'MANUAL_REVIEW';
        outcome = { success: false, action: 'REQUIRES_MANUAL_REVIEW', tenantId, orderId: ch.order_id, txid };
      } else {
        throw Error('CANNOT_SETTLE_' + (expired && ch.status === 'PENDING' ? 'EXPIRED' : ch.status));
      }
      await c.query('INSERT INTO g3lab_events(event_id,payload_sha256,status,outcome) VALUES($1,$2,$3,$4)',
        [eventId, hash, kind === 'CALLBACK' ? 'SUCCESS' : 'REQUIRES_MANUAL_REVIEW', JSON.stringify(outcome)]);
      await c.query('INSERT INTO g3lab_outbox(event_id,tenant_id,order_id,txid,kind,payload) VALUES($1,$2,$3,$4,$5,$6)',
        [eventId, tenantId, ch.order_id, txid, kind, JSON.stringify({ ...outcome, eventId, paidAmount: money })]);
      return outcome;
    });
  }
  async outbox() {
    guard();
    const q = await this.pool.query('SELECT event_id,tenant_id,kind,status,attempts FROM g3lab_outbox ORDER BY id');
    return q.rows.map(r => ({ eventId: r.event_id, tenantId: r.tenant_id, kind: r.kind,
      status: r.status, attempts: r.attempts }));
  }
  async drainSyntheticCallbackOnce(send) {
    guard();
    if (typeof send !== 'function') throw Error('INVALID_SYNTHETIC_CALLBACK');
    let row;
    await transaction(this.pool, async c => {
      const r = await c.query("SELECT * FROM g3lab_outbox WHERE kind='CALLBACK' AND (status='PENDING' OR (status='IN_PROGRESS' AND claimed_at < now() - interval '30 seconds')) ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1");
      if (!r.rowCount) return;
      row = r.rows[0];
      await c.query("UPDATE g3lab_outbox SET status='IN_PROGRESS',attempts=attempts+1,claimed_at=now() WHERE id=$1", [row.id]);
    });
    if (!row) return { handled: false };
    let ok = false;
    try { ok = (await send(row.payload)) === true; } catch { /* retryable */ }
    await this.pool.query('UPDATE g3lab_outbox SET status=$1,last_error_code=$2 WHERE id=$3',
      [ok ? 'DELIVERED' : 'PENDING', ok ? null : 'SYNTHETIC_CALLBACK_FAILED', row.id]);
    return { handled: true, delivered: ok, eventId: row.event_id };
  }
  async acknowledgeManualReview(eventId) {
    guard(); validId(eventId);
    const r = await this.pool.query("UPDATE g3lab_outbox SET status='MANUAL_REVIEW' WHERE event_id=$1 AND kind='MANUAL_REVIEW' AND status='PENDING' RETURNING id", [eventId]);
    return r.rowCount === 1;
  }
  async close() { await this.pool.end(); }
}
