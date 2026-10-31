/**
 * G3-B LOCAL ONLY: HTTP adapter wrapping the existing HelpUS Pay PIX mock.
 * No PSP, no real QR, no deployment, no production configuration.
 * Import with: npx tsx sandbox/g3b_http_pay_server.mjs
 */
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxPixCharge, assertSandboxAllowed } from '../api/sandbox/pix_service.ts';

const BODY_LIMIT = 64 * 1024;
const NAME = 'G3B_LOCAL_MOCK_ONLY';

export function assertG3BLocalOnly() {
  assertSandboxAllowed();
  if (process.env.HELPUS_G3B_LOCAL_ONLY !== '1') {
    throw new Error('G3B_LOCAL_ONLY_REQUIRED: export HELPUS_G3B_LOCAL_ONLY=1 explicitly');
  }
}

function reply(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function rawBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const err = new Error('PAYLOAD_TOO_LARGE');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function makeSandboxServiceSignature(secret, method, pathname, tenant, raw = '') {
  return crypto.createHmac('sha256', secret)
    .update([method.toUpperCase(), pathname, tenant, raw].join('\n')).digest('hex');
}

function signatureValid(expected, provided) {
  if (typeof provided !== 'string' || !/^[0-9a-fA-F]{64}$/.test(provided)) return false;
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(provided, 'hex'));
}

function validName(v) {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(v);
}

function statusRefresh(charge) {
  if (charge.status === 'PENDING' && Date.now() > Date.parse(charge.expiresAt)) charge.status = 'EXPIRED';
  return charge;
}

export function createG3BPayApp({ secret, callbackSecret, callbackUrl } = {}) {
  assertG3BLocalOnly();
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('MISSING_TEST_S2S_SECRET');
  if (typeof callbackSecret !== 'string' || callbackSecret.length < 32) throw new Error('MISSING_TEST_WEBHOOK_SECRET');
  if (callbackUrl && (!/^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/webhooks\/payment$/.test(callbackUrl))) {
    throw new Error('CALLBACK_MUST_BE_LOOPBACK');
  }

  const charges = new Map();
  const requestKeys = new Map();

  async function route(req, res) {
    assertG3BLocalOnly();
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const method = req.method || 'GET';

    if (method === 'GET' && pathname === '/api/v1/sandbox/g3b/health') {
      return reply(res, 200, { ok: true, mode: NAME });
    }

    const raw = await rawBody(req);
    const tenant = req.headers['x-tenant-id'];
    if (!validName(tenant)) return reply(res, 401, { ok: false, code: 'MISSING_TEST_TENANT' });
    const expect = makeSandboxServiceSignature(secret, method, pathname, tenant, raw);
    if (!signatureValid(expect, req.headers['x-sandbox-service-signature'])) {
      return reply(res, 401, { ok: false, code: 'INVALID_TEST_S2S_SIGNATURE' });
    }

    let data = {};
    if (raw.length) {
      try { data = JSON.parse(raw); }
      catch { return reply(res, 400, { ok: false, code: 'INVALID_JSON' }); }
    }

    if (method === 'POST' && pathname === '/api/v1/charges/pix') {
      const key = req.headers['x-idempotency-key'];
      if (!validName(key) || key.length < 8) {
        return reply(res, 400, { ok: false, code: 'INVALID_IDEMPOTENCY_KEY' });
      }
      if (typeof data !== 'object' || !data || !validName(data.orderId) ||
          typeof data.customerPhone !== 'string' || !/^[0-9]{10,15}$/.test(data.customerPhone) ||
          typeof data.amount !== 'number' || !Number.isFinite(data.amount) ||
          data.amount < 0.01 || data.amount > 10000 ||
          Math.abs(Math.round(data.amount * 100) - data.amount * 100) > 1e-7) {
        return reply(res, 422, { ok: false, code: 'INVALID_SYNTHETIC_CHARGE' });
      }
      const idKey = tenant + ':' + key;
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        tenant, orderId: data.orderId, customerPhone: data.customerPhone, amount: data.amount
      })).digest('hex');
      const previous = requestKeys.get(idKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) return reply(res, 409, { ok: false, code: 'IDEMPOTENCY_PAYLOAD_CONFLICT' });
        return reply(res, 200, { ...statusRefresh(charges.get(previous.txid)), idempotent: true });
      }
      for (const c of charges.values()) {
        if (c.tenantId === tenant && c.orderId === data.orderId) {
          return reply(res, 409, { ok: false, code: 'ORDER_ALREADY_HAS_CHARGE' });
        }
      }
      const pix = createSandboxPixCharge({
        tenantId: tenant, orderId: data.orderId, amount: data.amount, customerPhone: data.customerPhone
      });
      const charge = { ...pix, tenantId: tenant, orderId: data.orderId, customerPhone: data.customerPhone,
        qrCodeUrl: pix.qrCodeMock };
      charges.set(charge.txid, charge);
      requestKeys.set(idKey, { fingerprint, txid: charge.txid });
      return reply(res, 201, charge);
    }

    const match = pathname.match(/^\/api\/v1\/charges\/pix\/([a-zA-Z0-9_-]{1,128})(\/cancel)?$/);
    if (match && ((method === 'GET' && !match[2]) || (method === 'POST' && match[2]))) {
      const charge = charges.get(match[1]);
      if (!charge || charge.tenantId !== tenant) return reply(res, 404, { ok: false, code: 'CHARGE_NOT_FOUND' });
      statusRefresh(charge);
      if (method === 'GET') return reply(res, 200, charge);
      if (charge.status === 'CANCELLED') return reply(res, 200, { txid: charge.txid, status: 'CANCELLED', idempotent: true });
      if (charge.status !== 'PENDING') return reply(res, 409, { ok: false, code: 'CANNOT_CANCEL_CHARGE_' + charge.status });
      charge.status = 'CANCELLED';
      charge.cancelledAt = new Date().toISOString();
      return reply(res, 200, { txid: charge.txid, status: charge.status, cancelledAt: charge.cancelledAt });
    }

    // Deliberate test-only settlement trigger, not part of the planned external PSP API.
    if (method === 'POST' && pathname === '/api/v1/sandbox/g3b/settle') {
      const charge = charges.get(data.txid);
      if (!charge || charge.tenantId !== tenant) return reply(res, 404, { ok: false, code: 'CHARGE_NOT_FOUND' });
      statusRefresh(charge);
      if (charge.status !== 'PENDING') return reply(res, 409, { ok: false, code: 'CANNOT_SETTLE_' + charge.status });
      if (!callbackUrl) return reply(res, 503, { ok: false, code: 'NO_LOCAL_WEBHOOK_CALLBACK' });
      charge.status = 'PAID';
      charge.paidAt = new Date().toISOString();
      const event = {
        event: 'PIX_RECEIVED',
        eventId: 'evt_mock_' + crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        data: { txid: charge.txid, tenantId: charge.tenantId, orderId: charge.orderId,
          amount: charge.amount, status: 'PAID', paidAt: charge.paidAt }
      };
      const payload = JSON.stringify(event);
      const signature = crypto.createHmac('sha256', callbackSecret).update(payload).digest('hex');
      try {
        const callbackResponse = await fetch(callbackUrl, {
          method: 'POST', headers: { 'content-type': 'application/json',
            'x-signature-sha256': signature },
          body: payload, signal: AbortSignal.timeout(3000)
        });
        return reply(res, callbackResponse.ok ? 200 : 202, {
          ok: callbackResponse.ok, settled: true, txid: charge.txid, callbackStatus: callbackResponse.status
        });
      } catch {
        // The synthetic bank status remains PAID; no false rollback of external funds.
        return reply(res, 202, { ok: false, settled: true, txid: charge.txid, code: 'CALLBACK_PENDING_RETRY' });
      }
    }
    return reply(res, 404, { ok: false, code: 'NOT_FOUND' });
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch(err => {
      if (!res.headersSent) reply(res, err.status || 500, { ok: false, code: err.status ? 'PAYLOAD_TOO_LARGE' : 'SANDBOX_ERROR' });
    });
  });
  return {
    charges,
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve({ baseUrl: 'http://127.0.0.1:' + server.address().port,
          port: server.address().port, close: () => new Promise(r => server.close(r)) });
      });
    })
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const app = createG3BPayApp({
      secret: process.env.HELPUS_G3B_MOCK_S2S_SECRET,
      callbackSecret: process.env.HELPUS_G3B_MOCK_WEBHOOK_SECRET,
      callbackUrl: process.env.HELPUS_G3B_LOCAL_CALLBACK
    });
    const addr = await app.listen();
    process.stdout.write('G3B_PAY_READY ' + JSON.stringify({ baseUrl: addr.baseUrl, mode: NAME }) + '\n');
  } catch (e) {
    process.stderr.write('G3B_PAY_START_BLOCKED ' + e.message + '\n');
    process.exitCode = 1;
  }
}
