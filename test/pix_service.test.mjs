import assert from 'assert';
import crypto from 'crypto';
import { createSandboxPixCharge, verifyWebhookSignature, assertSandboxAllowed } from '../api/sandbox/pix_service.ts';

console.log('--- TESTES UNITÁRIOS HELPUS-PAY (SANDBOX G2) ---');

// Teste 1: Criação válida de cobrança
const charge = createSandboxPixCharge({
  tenantId: 'tenant_barbearia',
  orderId: 'ord_12345',
  amount: 45.50,
  customerPhone: '5583999991111'
});

assert.strictEqual(charge.status, 'PENDING');
assert.strictEqual(charge.amount, 45.50);
assert.ok(charge.txid.startsWith('tx_mock_'));
assert.ok(charge.expiresAt > new Date().toISOString());
console.log('  [PASS] 1. Criação de cobrança válida com TTL');

// Teste 2: Rejeição de valores inválidos (finitude)
assert.throws(() => {
  createSandboxPixCharge({ tenantId: 't1', orderId: 'o1', amount: -10, customerPhone: '5583999990000' });
}, /INVALID_AMOUNT/);

assert.throws(() => {
  createSandboxPixCharge({ tenantId: 't1', orderId: 'o1', amount: Infinity, customerPhone: '5583999990000' });
}, /INVALID_AMOUNT/);

assert.throws(() => {
  createSandboxPixCharge({ tenantId: 't1', orderId: 'o1', amount: NaN, customerPhone: '5583999990000' });
}, /INVALID_AMOUNT/);
console.log('  [PASS] 2. Rejeição de valores infinitos, negativos e NaN');

// Teste 3: Validação robusta de assinatura HMAC
const rawBody = JSON.stringify({ event: 'PAID', txid: charge.txid });
const hmac = crypto.createHmac('sha256', 'test_only_mock_secret_not_for_prod_2026_safe');
hmac.update(rawBody);
const validSig = hmac.digest('hex');

assert.strictEqual(verifyWebhookSignature(rawBody, validSig), true);
assert.strictEqual(verifyWebhookSignature(rawBody, 'invalid'), false, 'Assinatura curta ou malformada deve retornar false sem exceção');
assert.strictEqual(verifyWebhookSignature(rawBody, null), false, 'Assinatura nula deve retornar false');
assert.strictEqual(verifyWebhookSignature(rawBody, ''), false, 'Assinatura vazia deve retornar false');
assert.strictEqual(verifyWebhookSignature(rawBody, '1234567890abcdef'.repeat(4)), false, 'Hash adulterado deve retornar false');
console.log('  [PASS] 3. Verificação de assinatura HMAC segura sem exceções');

// Teste 4: Bloqueio incondicional de sandbox em produção (P0-4)
const origNodeEnv = process.env.NODE_ENV;
try {
  process.env.NODE_ENV = 'production';
  assert.throws(() => {
    assertSandboxAllowed();
  }, /SECURITY_VIOLATION/);

  assert.throws(() => {
    createSandboxPixCharge({ tenantId: 't1', orderId: 'o1', amount: 50, customerPhone: '5583999990000' });
  }, /SECURITY_VIOLATION/);
  console.log('  [PASS] 4. Bloqueio incondicional de endpoints sandbox em ambiente de produção');
} finally {
  process.env.NODE_ENV = origNodeEnv;
}

console.log('--- SUITE DE TESTES HELPUS-PAY: 4/4 TESTES APROVADOS COM SUCESSO ---');
