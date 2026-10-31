import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { G3BPlusPgStore } from './pg_store.mjs';

process.env.HELPUS_G3BPLUS_LOCAL_ONLY = '1';
// A port must be explicitly supplied by the disposable database fixture; never fall back to host 5432.
const credentials = {
  host: '127.0.0.1', port: Number(process.env.G3BPLUS_PG_PORT),
  database: process.env.G3BPLUS_PG_DB || 'g3bplus_lab',
  user: process.env.G3BPLUS_PG_USER || 'g3bplus_lab',
  password: process.env.G3BPLUS_PG_PASSWORD || 'g3bplus_local_test_only_password'
};
const tenant = 'tenant_barbearia';
const phone = '5583999000001';
const id = () => crypto.randomUUID().replaceAll('-', '');
const store = new G3BPlusPgStore(credentials);
await store.initSchema();
const make = (amount = 45) => ({ tenantId: tenant, orderId: 'order_' + id(),
  customerPhone: phone, amount, idempotencyKey: 'idem_' + id() });
try {
  await test('commit create survives new PostgreSQL connection/restart simulation', async () => {
    const args = make();
    const created = await store.createCharge(args);
    assert.equal(created.status, 'PENDING');
    const second = new G3BPlusPgStore(credentials);
    assert.equal((await second.get(tenant, created.txid)).orderId, created.orderId);
    assert.equal((await second.getOrder(tenant, created.orderId)).status, 'WAITING_PAYMENT');
    await second.close();
  });
  await test('repeated create with same key is idempotent and persists across connections', async () => {
    const args = make();
    const charge = await store.createCharge(args);
    const again = await store.createCharge(args);
    assert.equal(again.txid, charge.txid);
    assert.equal(again.idempotent, true);
    await assert.rejects(store.createCharge({ ...args, amount: 44 }), /IDEMPOTENCY_KEY_COLLISION/);
  });
  await test('parallel identical checkout creates exactly one charge', async () => {
    const args = make();
    const results = await Promise.all(Array.from({ length: 8 }, () => store.createCharge(args)));
    assert.equal(new Set(results.map(x => x.txid)).size, 1);
  });
  await test('cross tenant charge reads and cancellation do not leak', async () => {
    const c = await store.createCharge(make());
    assert.equal(await store.get('tenant_pizzaria', c.txid), null);
    await assert.rejects(store.cancel('tenant_pizzaria', c.txid), /CHARGE_NOT_FOUND/);
    assert.equal((await store.get(tenant, c.txid)).status, 'PENDING');
  });
  await test('strict cents, names and order scope are fail closed', async () => {
    for (const amount of [0, -1, 42.001, Infinity, 10000.01]) {
      await assert.rejects(store.createCharge(make(amount)), /INVALID_SYNTHETIC_AMOUNT/);
    }
    await assert.rejects(store.createCharge({ ...make(), tenantId: 'outside' }), /INVALID_SYNTHETIC_TENANT/);
  });
  await test('single transaction sets order+charge paid and durable callback outbox', async () => {
    const args = make();
    const c = await store.createCharge(args);
    const ev = 'evt_' + id();
    const paid = await store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 45 });
    assert.equal(paid.success, true);
    const again = await store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 45 });
    assert.equal(again.replay, true);
    assert.equal((await store.getOrder(tenant, args.orderId)).status, 'PAID');
    assert.equal((await store.get(tenant, c.txid)).status, 'PAID');
    assert.ok((await store.outbox()).some(x => x.eventId === ev && x.kind === 'CALLBACK'));
    await assert.rejects(store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 46 }), /EVENT_ID_PAYLOAD_MISMATCH/);
  });
  await test('cancelled order cannot settle normally; late bank notification enters manual review', async () => {
    const args = make();
    const c = await store.createCharge(args);
    assert.equal((await store.cancel(tenant, c.txid)).status, 'CANCELLED');
    assert.equal((await store.cancel(tenant, c.txid)).idempotent, true);
    await assert.rejects(store.settle({ tenantId: tenant, txid: c.txid, eventId: 'evt_' + id(), paidAmount: 45 }), /CANNOT_SETTLE_CANCELLED/);
    const ev = 'evt_' + id();
    const result = await store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 45, allowLateBankEvent: true });
    assert.equal(result.success, false);
    assert.equal(result.action, 'REQUIRES_MANUAL_REVIEW');
    assert.equal((await store.getOrder(tenant, args.orderId)).status, 'CANCELLED');
    const retry = await store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 45, allowLateBankEvent: true });
    assert.equal(retry.success, false);
    assert.equal(retry.replay, true);
    assert.equal((await store.outbox()).filter(x => x.eventId === ev).length, 1);
    assert.equal(await store.acknowledgeManualReview(ev), true);
    assert.equal(await store.acknowledgeManualReview(ev), false);
  });
  await test('eight cancel versus settle concurrent races maintain consistent order/charge', async () => {
    for (let n = 0; n < 8; n++) {
      const args = make();
      const c = await store.createCharge(args);
      const ev = 'evt_' + id();
      const outcomes = await Promise.allSettled([
        store.cancel(tenant, c.txid),
        store.settle({ tenantId: tenant, txid: c.txid, eventId: ev, paidAmount: 45 })
      ]);
      const order = await store.getOrder(tenant, args.orderId);
      const charge = await store.get(tenant, c.txid);
      assert.equal(order.status === 'PAID' ? 'PAID' : 'CANCELLED', charge.status);
      assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
    }
  });
  await test('durable outbox retries simulated callback then marks delivered without duplication', async () => {
    // Earlier tests inserted pending callback rows. FIFO pending is correct.
    const first = await store.drainSyntheticCallbackOnce(async () => false);
    assert.equal(first.handled, true);
    assert.equal(first.delivered, false);
    assert.ok((await store.outbox()).some(x => x.eventId === first.eventId && x.status === 'PENDING' && x.attempts >= 1));
    const second = await store.drainSyntheticCallbackOnce(async () => true);
    assert.equal(second.eventId, first.eventId);
    assert.equal(second.delivered, true);
    const rows = await store.outbox();
    assert.equal(rows.filter(x => x.eventId === first.eventId).length, 1);
    assert.equal(rows.find(x => x.eventId === first.eventId).status, 'DELIVERED');
  });
  await test('expired TTL is durably applied on query and cancel, never becomes PAID', async () => {
    const a=make(), ch=await store.createCharge(a);
    await store.pool.query("UPDATE g3lab_charges SET expires_at=now() - interval '1 second' WHERE txid=$1", [ch.txid]);
    const expired=await store.get(tenant,ch.txid);
    assert.equal(expired.status,'EXPIRED');
    assert.equal((await store.getOrder(tenant,a.orderId)).status,'EXPIRED');
    await assert.rejects(store.cancel(tenant,ch.txid),/CANNOT_CANCEL_EXPIRED/);
    await assert.rejects(store.settle({tenantId:tenant,txid:ch.txid,eventId:'evt_'+id(),paidAmount:45}),/CANNOT_SETTLE_EXPIRED/);
    const other=make(), second=await store.createCharge(other);
    await store.pool.query("UPDATE g3lab_charges SET expires_at=now() - interval '1 second' WHERE txid=$1", [second.txid]);
    assert.deepEqual(await store.cancel(tenant,second.txid),{status:'EXPIRED',cannotCancel:true});
    assert.equal((await store.getOrder(tenant,other.orderId)).status,'EXPIRED');
  });
  await test('durable callback outbox stores immutable paidAt across duplicate attempts', async () => {
    const args=make(), charge=await store.createCharge(args), ev='evt_'+id();
    await store.settle({tenantId:tenant,txid:charge.txid,eventId:ev,paidAmount:45});
    const r=await store.pool.query('SELECT payload FROM g3lab_outbox WHERE event_id=$1',[ev]);
    assert.ok(/^\d{4}-\d\d-\d\dT/.test(r.rows[0].payload.paidAt));
    assert.equal(r.rows[0].payload.eventId,ev);
  });
  await test('database host, user, name, and explicit sandbox mode enforced', async () => {
    assert.throws(() => new G3BPlusPgStore({ ...credentials, host: 'db.example.com' }), /DISPOSABLE_LOCAL_POSTGRES_REQUIRED/);
    assert.throws(() => new G3BPlusPgStore({ ...credentials, database: 'production' }), /DISPOSABLE_LOCAL_POSTGRES_REQUIRED/);
    const old = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await assert.rejects(store.get(tenant, 'tx_mock_' + id()), /G3BPLUS_LOCAL_ONLY_REQUIRED/);
    } finally {
      if (old === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = old;
    }
  });
} finally {
  await store.close();
}
