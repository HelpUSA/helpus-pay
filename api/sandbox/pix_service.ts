/**
 * HelpUS Pay - Backend Mock de PIX Sandbox (Ordem 007 - Remediação G2)
 * Contrato Serverless Vercel / Node compatível com validações financeiras e blindagem criptográfica.
 */
import crypto from 'crypto';

export interface PixChargeRequest {
  tenantId: string;
  orderId: string;
  amount: number;
  customerPhone: string;
}

export interface PixChargeResponse {
  txid: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED' | 'CANCELLED';
  amount: number;
  pixCopiaECola: string;
  qrCodeMock: string;
  expiresAt: string;
  createdAt: string;
}

// Isolamento de segredos com guard de ambiente produtivo (P0-B)
const MOCK_SECRET = process.env.SANDBOX_PAYMENT_SECRET || 'test_only_mock_secret_not_for_prod_2026_safe';

export function assertSandboxAllowed(): void {
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_SANDBOX_MOCKS) {
    throw new Error('SECURITY_VIOLATION: Endpoints mock de sandbox são terminantemente proibidos em ambiente de produção.');
  }
}

/**
 * Criação de cobrança PIX Mock com validações de finitude e sanitização
 */
export function createSandboxPixCharge(req: PixChargeRequest): PixChargeResponse {
  assertSandboxAllowed();

  if (!req || typeof req !== 'object') {
    throw new Error('INVALID_PAYLOAD: O corpo da requisição é obrigatório.');
  }

  const { tenantId, orderId, amount, customerPhone } = req;

  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
    throw new Error('INVALID_TENANT: tenantId é obrigatório.');
  }

  if (!orderId || typeof orderId !== 'string' || orderId.trim().length === 0) {
    throw new Error('INVALID_ORDER_ID: orderId é obrigatório.');
  }

  if (!customerPhone || typeof customerPhone !== 'string' || customerPhone.trim().length < 8) {
    throw new Error('INVALID_PHONE: customerPhone inválido.');
  }

  // Validação estrita de valor financeiro (finito, positivo e com limite de sanidade)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) {
    throw new Error('INVALID_AMOUNT: O valor deve ser um número finito, positivo e menor que 100.000.');
  }

  const txid = `tx_mock_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    txid,
    status: 'PENDING',
    amount: parseFloat(amount.toFixed(2)),
    pixCopiaECola: `00020126580014br.gov.bcb.pix0136${txid}520400005303986540${amount.toFixed(2)}5802BR5913HELPUS_PAY6009JOAO_PESSOA62070503***6304MOCK`,
    qrCodeMock: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><text x="10" y="100" fill="black">PIX_MOCK_${txid.slice(0, 10)}</text></svg>`,
    expiresAt,
    createdAt: new Date().toISOString()
  };
}

/**
 * Validação segura de assinatura HMAC (P0-C):
 * Rejeita assinaturas nulas, vazias, malformadas ou com tamanho incorreto sem lançar exceções não tratadas.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | undefined | null): boolean {
  try {
    assertSandboxAllowed();

    if (!rawBody || typeof rawBody !== 'string') {
      return false;
    }

    if (!signature || typeof signature !== 'string') {
      return false;
    }

    // Hash SHA-256 em hexadecimal tem exatamente 64 caracteres [0-9a-fA-F]
    const hexSha256Regex = /^[0-9a-fA-F]{64}$/;
    const cleanSig = signature.trim();

    if (!hexSha256Regex.test(cleanSig)) {
      return false;
    }

    const hmac = crypto.createHmac('sha256', MOCK_SECRET);
    hmac.update(rawBody);
    const calculated = hmac.digest('hex');

    const expectedBuffer = Buffer.from(cleanSig.toLowerCase(), 'hex');
    const calculatedBuffer = Buffer.from(calculated, 'hex');

    if (expectedBuffer.length !== calculatedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedBuffer, calculatedBuffer);
  } catch (_e) {
    // Fail-closed absoluto: qualquer erro de parsing ou buffer retorna false graciosamente
    return false;
  }
}
