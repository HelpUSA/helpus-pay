/**
 * Strictly local G3-B+ mock HTTP API using PostgreSQL + Ed25519 lab JWT.
 * Not connected to deployed serverless API, Meta, PIX, PSP or production identities.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { createG3BPlusJwtVerifier } from './jwt_verifier.mjs';

function guard() {
  if (process.env.HELPUS_G3BPLUS_LOCAL_ONLY !== '1' || process.env.NODE_ENV === 'production')
    throw Error('G3BPLUS_LOCAL_ONLY_REQUIRED');
}
function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(obj));
}
async function body(req) {
  const a = []; let length = 0;
  for await (const x of req) {
    length += x.byteLength;
    if (length > 64 * 1024) { const e = Error('BODY_TOO_LARGE'); e.status = 413; throw e; }
    a.push(x);
  }
  if (!a.length) return {};
  try { return JSON.parse(Buffer.concat(a).toString('utf8')); }
  catch { const e = Error('INVALID_JSON'); e.status = 400; throw e; }
}
function code(e) {
  const c = e.message || 'UNEXPECTED_ERROR';
  if (/^CHARGE_NOT_FOUND/.test(c)) return 404;
  if (/MISMATCH|COLLISION|ALREADY|CANNOT_/.test(c)) return 409;
  if (/INVALID_|REQUIRED/.test(c)) return 422;
  return 500;
}
function tenantHeader(v) { return typeof v === 'string' && /^tenant_[a-zA-Z0-9_]{1,56}$/.test(v); }
function callbackLoopback(v) {
  return v == null || (typeof v === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/webhooks\/payment$/.test(v));
}

export async function createG3BPlusPgHttpApp({ store, authBaseUrl, callbackUrl = null,
  mockCallbackSecret = null } = {}) {
  guard();
  if (!store || typeof store.createCharge !== 'function' || !callbackLoopback(callbackUrl))
    throw Error('LAB_STORE_OR_CALLBACK_INVALID');
  if (callbackUrl && (typeof mockCallbackSecret !== 'string' || mockCallbackSecret.length < 32))
    throw Error('RANDOM_LAB_CALLBACK_SECRET_REQUIRED');
  const verify = await createG3BPlusJwtVerifier(authBaseUrl);
  const server = http.createServer(async (req, res) => {
    try {
      guard();
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (req.method === 'GET' && pathname === '/sandbox/g3bplus/health') {
        return send(res, 200, { ok: true, mode: 'LOCAL_PG_JWT_SYNTHETIC_ONLY' });
      }
      const tenantId = req.headers['x-tenant-id'];
      if (!tenantHeader(tenantId)) return send(res, 401, { code: 'TENANT_REQUIRED' });
      const auth = req.headers.authorization;
      if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
        return send(res, 401, { code: 'AUTH_REQUIRED' });
      }
      const token = auth.slice(7);
      const chargeRoute = pathname.match(/^\/sandbox\/g3bplus\/charges\/([a-zA-Z0-9_-]{8,100})(\/cancel)?$/);
      let action = null;
      if (req.method === 'POST' && pathname === '/sandbox/g3bplus/charges') action = 'create';
      else if (req.method === 'GET' && chargeRoute && !chargeRoute[2]) action = 'read';
      else if (req.method === 'POST' && chargeRoute && chargeRoute[2]) action = 'cancel';
      else if (req.method === 'POST' && pathname === '/sandbox/g3bplus/settle') action = 'settle';
      else if (req.method === 'POST' && pathname === '/sandbox/g3bplus/drain') action = 'drain';
      else return send(res, 404, { code: 'NOT_FOUND' });
      verify(token, { tenantId, scope: action === 'create' ? 'pay:create' :
        action === 'read' ? 'pay:read' : action === 'cancel' ? 'pay:cancel' : 'callback:send',
        clientId: action === 'settle' || action === 'drain' ? 'pay' : 'zap-pro' });
      const input = req.method === 'POST' ? await body(req) : {};
      if (action === 'create') {
        const out = await store.createCharge({ ...input, tenantId,
          idempotencyKey: req.headers['x-idempotency-key'] });
        return send(res, out.idempotent ? 200 : 201, out);
      }
      if (action === 'read') {
        const out = await store.get(tenantId, chargeRoute[1]);
        return send(res, out ? 200 : 404, out || { code: 'CHARGE_NOT_FOUND' });
      }
      if (action === 'cancel') {
        const out = await store.cancel(tenantId, chargeRoute[1]);
        return send(res, 200, out);
      }
      if (action === 'settle') {
        const out = await store.settle({ tenantId, txid: input.txid,
          eventId: input.eventId, paidAmount: input.paidAmount,
          allowLateBankEvent: input.allowLateBankEvent || false });
        return send(res, out.success ? 200 : 202, out);
      }
      if (action === 'drain') {
        // In-memory callback implementation is forbidden: PG outbox always decides delivery.
        const out = await store.drainSyntheticCallbackOnce(async payload => {
          if (!callbackUrl) return false;
          const data = {
            event: 'PIX_RECEIVED', eventId: payload.eventId,
            data: { tenantId: payload.tenantId, orderId: payload.orderId,
              txid: payload.txid, amount: payload.paidAmount, status: 'PAID',
              paidAt: new Date().toISOString() }
          };
          const raw = JSON.stringify(data);
          const sig = crypto.createHmac('sha256', mockCallbackSecret).update(raw).digest('hex');
          try {
            const response = await fetch(callbackUrl, { method: 'POST',
              headers: { 'content-type': 'application/json', 'x-signature-sha256': sig },
              body: raw, signal: AbortSignal.timeout(2500) });
            return response.ok;
          } catch { return false; }
        });
        return send(res, 200, out);
      }
    } catch (e) {
      const status = e.status || code(e);
      return send(res, status, { ok: false,
        code: status >= 500 ? 'LAB_INTERNAL_ERROR' : e.message });
    }
  });
  return {
    server,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const port = server.address().port;
        resolve({ baseUrl: 'http://127.0.0.1:' + port,
          close: () => new Promise(r => server.close(r)) });
      });
    })
  };
}
