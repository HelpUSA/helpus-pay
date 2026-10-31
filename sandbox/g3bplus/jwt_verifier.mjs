/** Verify G3-B+ lab JWT against Ed25519 JWKS over localhost only. */
import crypto from 'node:crypto';

const ISSUER = 'https://auth.invalid/helpus-g3bplus-lab';
const AUDIENCE = 'helpus-g3bplus-s2s';
function deny(code = 'INVALID_LAB_JWT') {
  const e = new Error(code); e.status = 401; return e;
}
function segment(s) {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(s)) throw deny();
  const b = Buffer.from(s, 'base64url');
  if (b.toString('base64url') !== s) throw deny();
  try { return JSON.parse(b.toString('utf8')); }
  catch { throw deny(); }
}
export async function createG3BPlusJwtVerifier(authBaseUrl) {
  if (process.env.HELPUS_G3BPLUS_LOCAL_ONLY !== '1' || process.env.NODE_ENV === 'production') throw deny('SANDBOX_ONLY');
  if (typeof authBaseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(authBaseUrl)) throw deny('AUTH_HOST_NOT_LOOPBACK');
  const r = await fetch(authBaseUrl + '/sandbox/g3bplus/jwks', { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw deny('JWKS_UNAVAILABLE');
  const doc = await r.json();
  if (!Array.isArray(doc.keys) || doc.keys.length !== 1) throw deny('JWKS_UNTRUSTED');
  const jwk = doc.keys[0];
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || jwk.alg !== 'EdDSA' ||
      jwk.use !== 'sig' || typeof jwk.kid !== 'string' || jwk.d ||
      !/^[A-Za-z0-9_-]{30,}$/.test(jwk.x)) throw deny('JWKS_UNTRUSTED');
  const publicKey = crypto.createPublicKey({ format: 'jwk', key: jwk });
  return function verify(token, { tenantId, scope, clientId = 'zap-pro' }) {
    if (process.env.HELPUS_G3BPLUS_LOCAL_ONLY !== '1' || process.env.NODE_ENV === 'production') throw deny('SANDBOX_ONLY');
    if (typeof token !== 'string' || token.length > 8192) throw deny();
    const parts = token.split('.');
    if (parts.length !== 3) throw deny();
    const h = segment(parts[0]), p = segment(parts[1]);
    if (h.alg !== 'EdDSA' || h.typ !== 'JWT' || h.kid !== jwk.kid ||
        !/^[A-Za-z0-9_-]+$/.test(parts[2])) throw deny();
    const sig = Buffer.from(parts[2], 'base64url');
    if (sig.length !== 64 || sig.toString('base64url') !== parts[2] ||
        !crypto.verify(null, Buffer.from(parts[0] + '.' + parts[1]), publicKey, sig)) throw deny();
    const now = Math.floor(Date.now() / 1000);
    if (p.iss !== ISSUER || p.aud !== AUDIENCE || p.sub !== 'svc:' + clientId ||
        typeof p.nbf !== 'number' || p.nbf > now ||
        typeof p.exp !== 'number' || p.exp <= now || p.exp > now + 120 ||
        typeof p.scope !== 'string' || p.tenant_id !== tenantId) throw deny('INVALID_LAB_CLAIMS');
    if (typeof scope !== 'string' || !p.scope.split(' ').includes(scope)) {
      const e = deny('LAB_SCOPE_FORBIDDEN'); e.status = 403; throw e;
    }
    return p;
  };
}
