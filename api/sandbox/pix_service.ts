/**
 * HelpUS Pay - Backend Mock de PIX Sandbox (Ordem 005)
 * Contrato Serverless Vercel / Node compatível.
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

const MOCK_SECRET = 'helpus_pay_sandbox_hmac_secret_2026_safe';

export function createSandboxPixCharge(req: PixChargeRequest): PixChargeResponse {
  if (!req.amount || req.amount <= 0) {
    throw new Error('INVALID_AMOUNT: Valor deve ser positivo.');
  }

  const txid = `tx_mock_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

  return {
    txid,
    status: 'PENDING',
    amount: parseFloat(req.amount.toFixed(2)),
    pixCopiaECola: `00020126580014br.gov.bcb.pix0136${txid}520400005303986540${req.amount.toFixed(2)}5802BR5913HELPUS_PAY6009JOAO_PESSOA62070503***6304MOCK`,
    qrCodeMock: `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><text x="10" y="100" fill="black">PIX_MOCK_${txid.slice(0, 10)}</text></svg>`,
    expiresAt,
    createdAt: new Date().toISOString()
  };
}

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const hmac = crypto.createHmac('sha256', MOCK_SECRET);
  hmac.update(rawBody);
  const calculated = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(calculated, 'hex'));
}
