import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createG3BPayApp, makeSandboxServiceSignature } from '../sandbox/g3b_http_pay_server.mjs';

process.env.HELPUS_G3B_LOCAL_ONLY = '1';
const secret = crypto.randomBytes(32).toString('hex');
const callbackSecret = crypto.randomBytes(32).toString('hex');
let tests = 0;
async function test(name, fn) {
  await fn();
  tests++;
  console.log('[PASS] ' + name);
}
const app = createG3BPayApp({ secret, callbackSecret });
const { baseUrl, close } = await app.listen();

async function call(method, path, tenant, body = null, moreHeaders = {}, signer = secret) {
  const raw = body === null ? '' : JSON.stringify(body);
  const headers = {
    'x-tenant-id': tenant,
    'x-sandbox-service-signature': makeSandboxServiceSignature(signer, method, path, tenant, raw),
    ...moreHeaders
  };
  if (raw) headers['content-type'] = 'application/json';
  const res = await fetch(baseUrl + path, { method, headers, ...(raw ? { body: raw } : {}) });
  return { status: res.status, data: await res.json() };
}

try {
  const createPath = '/api/v1/charges/pix';
  const body = { orderId: 'ord_mock_01', amount: 45, customerPhone: '5583999000001' };
  const tenant = 'tenant_barbearia';
  let charge;

  await test('synthetic create uses the real pay mock in an independent HTTP server', async () => {
    const res = await call('POST', createPath, tenant, body, { 'x-idempotency-key': 'test-idem-0001' });
    assert.equal(res.status, 201);
    assert.equal(res.data.status, 'PENDING');
    assert.equal(res.data.amount, 45);
    assert.equal(res.data.tenantId, tenant);
    assert.match(res.data.txid, /^tx_mock_/);
    charge = res.data;
  });
  await test('identical retry keeps same charge', async () => {
    const res = await call('POST', createPath, tenant, body, { 'x-idempotency-key': 'test-idem-0001' });
    assert.equal(res.status, 200);
    assert.equal(res.data.txid, charge.txid);
    assert.equal(res.data.idempotent, true);
  });
  await test('same key with altered amount is rejected', async () => {
    const res = await call('POST', createPath, tenant, { ...body, amount: 40 }, { 'x-idempotency-key': 'test-idem-0001' });
    assert.equal(res.status, 409);
  });
  await test('invalid HMAC never authenticates service', async () => {
    const res = await call('GET', '/api/v1/charges/pix/' + charge.txid, tenant, null, {}, 'wrong-secret');
    assert.equal(res.status, 401);
  });
  await test('cross-tenant GET and CANCEL both fail closed', async () => {
    const path = '/api/v1/charges/pix/' + charge.txid;
    assert.equal((await call('GET', path, 'tenant_pizzaria')).status, 404);
    assert.equal((await call('POST', path + '/cancel', 'tenant_pizzaria')).status, 404);
    assert.equal((await call('GET', path, tenant)).status, 200);
  });
  await test('finite money and cents are validated', async () => {
    for (const amount of [-1, 10001, 0, 42.001]) {
      assert.equal((await call('POST', createPath, tenant, { ...body, orderId: 'ord_bad_' + amount, amount },
        { 'x-idempotency-key': crypto.randomUUID() })).status, 422);
    }
  });
  await test('cancel is atomic and idempotent, never settles', async () => {
    const path = '/api/v1/charges/pix/' + charge.txid;
    assert.equal((await call('POST', path + '/cancel', tenant)).data.status, 'CANCELLED');
    assert.equal((await call('POST', path + '/cancel', tenant)).data.idempotent, true);
    assert.equal((await call('POST', '/api/v1/sandbox/g3b/settle', tenant, { txid: charge.txid })).status, 409);
    assert.equal((await call('GET', path, tenant)).data.status, 'CANCELLED');
  });
  await test('production and missing opt-in cannot instantiate the server', async () => {
    const before = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => createG3BPayApp({ secret, callbackSecret }), /SECURITY_VIOLATION/);
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
    }
    delete process.env.HELPUS_G3B_LOCAL_ONLY;
    assert.throws(() => createG3BPayApp({ secret, callbackSecret }), /G3B_LOCAL_ONLY_REQUIRED/);
    process.env.HELPUS_G3B_LOCAL_ONLY = '1';
  });
  await test('callback URL must be loopback and fixed', async () => {
    assert.throws(() => createG3BPayApp({
      secret, callbackSecret, callbackUrl: 'https://example.com/webhook'
    }), /CALLBACK_MUST_BE_LOOPBACK/);
  });
} finally {
  await close();
}
console.log('G3B_HELPUS_PAY_HTTP_TESTS_PASSED=' + tests);
