import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { G3BPlusPgStore } from './pg_store.mjs';
import { createG3BPlusPgHttpApp } from './pg_jwt_http.mjs';

process.env.HELPUS_G3BPLUS_LOCAL_ONLY = '1';
const authDir = process.env.AUTH_REPO_PATH;
if (typeof authDir !== 'string' || !path.isAbsolute(authDir)) throw Error('AUTH_FIXTURE_CHECKOUT_REQUIRED');
const { createG3BPlusAuthLab } = await import(pathToFileURL(path.join(authDir, 'sandbox/g3bplus_jwt_auth.mjs')).href);
const bootstrapSecret = crypto.randomBytes(32).toString('hex');
const auth = createG3BPlusAuthLab({ bootstrapSecret });
const aa = await auth.listen();
const store = new G3BPlusPgStore({
  database: process.env.G3BPLUS_PG_DB || 'g3bplus_lab',
  user: process.env.G3BPLUS_PG_USER || 'g3bplus_lab',
  password: process.env.G3BPLUS_PG_PASSWORD || 'g3bplus_local_test_only_password'
});
const payApp = await createG3BPlusPgHttpApp({ store, authBaseUrl: aa.baseUrl });
const pa = await payApp.listen();
const tenant = 'tenant_barbearia';
const x = () => crypto.randomUUID().replaceAll('-', '');
const config = { tenantId: tenant, clientId: 'zap-pro', scope: ['pay:create', 'pay:read', 'pay:cancel'] };
async function request(url, method, payload = null, headers = {}) {
  const resp = await fetch(url, { method,
    headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(payload ? { body: JSON.stringify(payload) } : {}) });
  return { status: resp.status, body: await resp.json() };
}
async function getToken(tenantId = tenant, clientId = 'zap-pro', scopes = config.scope) {
  const result = await request(aa.baseUrl + '/sandbox/g3bplus/token', 'POST',
    { tenantId, clientId, scope: scopes },
    { 'x-lab-bootstrap-secret': bootstrapSecret });
  assert.equal(result.status, 200);
  return result.body.access_token;
}
async function pay(method, endpoint, token, tenantId = tenant, payload = null, extra = {}) {
  return request(pa.baseUrl + '/sandbox/g3bplus/' + endpoint, method, payload, {
    'authorization': 'Bearer ' + token, 'x-tenant-id': tenantId, ...extra
  });
}
const token = await getToken(), bankToken = await getToken(tenant, 'pay', ['callback:send']);
async function createCharge() {
  const orderId = 'order_' + x(), key = 'idem_' + x();
  const r = await pay('POST', 'charges', token, tenant,
    { orderId, customerPhone: '5583999000001', amount: 45 }, { 'x-idempotency-key': key });
  assert.equal(r.status, 201);
  return { ...r.body, key };
}
try {
  await test('JWT-protected Pay PG service binds independent localhost port', async () => {
    assert.notEqual(new URL(aa.baseUrl).port, new URL(pa.baseUrl).port);
    assert.equal((await request(pa.baseUrl + '/sandbox/g3bplus/health', 'GET')).body.ok, true);
  });
  await test('no JWT and tampered JWT cannot create charges', async () => {
    const orderId = 'order_' + x();
    const input = { orderId, amount: 45, customerPhone: '5583999000001' };
    assert.equal((await pay('POST', 'charges', '', tenant, input, { 'x-idempotency-key': 'idem_' + x() })).status, 401);
    const modified = token.slice(0, -3) + 'abc';
    assert.equal((await pay('POST', 'charges', modified, tenant, input, { 'x-idempotency-key': 'idem_' + x() })).status, 401);
  });
  await test('Ed25519 token from REAL independent auth HTTP issues a PostgreSQL-backed charge', async () => {
    const c = await createCharge();
    const r = await pay('GET', 'charges/' + c.txid, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.amount, 45);
    assert.equal(r.body.orderId, c.orderId);
  });
  await test('signed JWT cannot cross tenant or exceed scoped access', async () => {
    const c = await createCharge();
    assert.equal((await pay('GET', 'charges/' + c.txid, token, 'tenant_pizzaria')).status, 401);
    const otherToken = await getToken('tenant_pizzaria');
    assert.equal((await pay('GET', 'charges/' + c.txid, otherToken, 'tenant_pizzaria')).status, 404);
    const readonly = await getToken(tenant, 'zap-pro', ['pay:read']);
    assert.equal((await pay('POST', 'charges/' + c.txid + '/cancel', readonly)).status, 403);
  });
  await test('only restricted synthetic bank service token may settle', async () => {
    const c = await createCharge();
    const eventId = 'evt_' + x(), req = { txid: c.txid, eventId, paidAmount: 45 };
    assert.equal((await pay('POST', 'settle', token, tenant, req)).status, 401);
    assert.equal((await pay('POST', 'settle', bankToken, tenant, req)).status, 200);
    assert.equal((await pay('GET', 'charges/' + c.txid, token)).body.status, 'PAID');
    const replay = await pay('POST', 'settle', bankToken, tenant, req);
    assert.equal(replay.body.replay, true);
  });
  await test('real transactional cancel prevents normal bank settlement', async () => {
    const c = await createCharge();
    const cancelled = await pay('POST', 'charges/' + c.txid + '/cancel', token);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'CANCELLED');
    assert.equal((await pay('POST', 'settle', bankToken, tenant,
      { txid: c.txid, eventId: 'evt_' + x(), paidAmount: 45 })).status, 409);
  });
  await test('unexpected manual reconciliation is pending for human review, no automatic refund', async () => {
    const c = await createCharge();
    await pay('POST', 'charges/' + c.txid + '/cancel', token);
    const ev = 'evt_' + x();
    const late = await pay('POST', 'settle', bankToken, tenant,
      { txid: c.txid, eventId: ev, paidAmount: 45, allowLateBankEvent: true });
    assert.equal(late.status, 202);
    assert.equal(late.body.success, false);
    assert.equal(late.body.action, 'REQUIRES_MANUAL_REVIEW');
    assert.ok((await store.outbox()).some(x => x.eventId === ev && x.kind === 'MANUAL_REVIEW' && x.status === 'PENDING'));
  });
  await test('a separate database connection can read the JWT-created charge after web handlers exit', async () => {
    const c = await createCharge();
    const secondary = new G3BPlusPgStore({
      database: process.env.G3BPLUS_PG_DB || 'g3bplus_lab',
      user: process.env.G3BPLUS_PG_USER || 'g3bplus_lab',
      password: process.env.G3BPLUS_PG_PASSWORD || 'g3bplus_local_test_only_password'
    });
    assert.equal((await secondary.get(tenant, c.txid)).orderId, c.orderId);
    await secondary.close();
  });
} finally {
  await pa.close();
  await aa.close();
  await store.close();
}
