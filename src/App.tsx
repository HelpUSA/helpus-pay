import { useState } from 'react';
import {
  CreditCard,
  QrCode,
  ShieldCheck,
  CheckCircle2,
  Globe,
  Copy,
  Check,
  Building2,
  Scissors,
  Volume2,
  Bot,
  ArrowRight,
  Download,
  Zap
} from 'lucide-react';

interface Plan {
  id: string;
  name: string;
  subdomain: string;
  price: number;
  icon: any;
  period: string;
}

export default function App() {
  const [selectedPlanId, setSelectedPlanId] = useState('agent-studio');
  const [paymentMethod, setPaymentMethod] = useState<'pix' | 'card'>('pix');
  const [isPaid, setIsPaid] = useState(false);
  const [copiedPix, setCopiedPix] = useState(false);

  const plans: Plan[] = [
    { id: 'agent-studio', name: 'HelpUS AI Agent Studio', subdomain: 'agent.helpusbr.com', price: 349, icon: Bot, period: 'mensal' },
    { id: 'imoveis-pro', name: 'HelpUS Imóveis Pro', subdomain: 'realestate.helpusbr.com', price: 299, icon: Building2, period: 'mensal' },
    { id: 'voice-saas', name: 'HelpUS Voice SaaS', subdomain: 'voice.helpusbr.com', price: 199, icon: Volume2, period: 'mensal' },
    { id: 'barber-hub', name: 'HelpUS Barber & Salon', subdomain: 'barber.helpusbr.com', price: 149, icon: Scissors, period: 'mensal' }
  ];

  const selectedPlan = plans.find(p => p.id === selectedPlanId) || plans[0];
  const pixCode = `00020126580014br.gov.bcb.pix0136helpus-pay-${selectedPlan.id}-20265204000053039865405${selectedPlan.price}.005802BR5925HELPUS TECHNOLOGY SOLUTIONS6009JOAO PESSOA62070503***6304E8A2`;

  const copyPix = () => {
    navigator.clipboard.writeText(pixCode);
    setCopiedPix(true);
    setTimeout(() => setCopiedPix(false), 2000);
  };

  const handleSimulatePayment = () => {
    setIsPaid(true);
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-500 to-green-600 flex items-center justify-center text-white shadow-lg shadow-emerald-500/20">
              <Zap className="w-6 h-6 stroke-[2.5]" />
            </div>
            <div>
              <span className="font-extrabold text-lg tracking-tight text-white flex items-center gap-2">
                HelpUS <span className="text-emerald-400">Pay</span>
              </span>
              <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest block">
                Gateway & Cobrança Recorrente PIX
              </span>
            </div>
          </div>

          <a
            href="https://hub.helpusbr.com"
            className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs font-bold text-slate-200 border border-slate-700 flex items-center gap-2 transition-all"
          >
            <Globe className="w-4 h-4 text-emerald-400" />
            <span>Voltar ao Hub</span>
          </a>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10 w-full space-y-8">
        <div className="text-center space-y-3 max-w-2xl mx-auto">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-extrabold tracking-wide uppercase">
            <ShieldCheck className="w-4 h-4" /> Pagamento Seguro TLS 1.3
          </div>
          <h1 className="text-3xl sm:text-4xl font-extrabold text-white">
            Assinatura & Checkout do Ecossistema
          </h1>
          <p className="text-slate-400 text-xs sm:text-sm font-medium">
            Selecione o plano desejado e efetue o pagamento instantâneo via PIX com baixa automática em segundos.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* Plan Selector Column */}
          <div className="space-y-4">
            <h3 className="text-xs font-extrabold uppercase tracking-wider text-slate-400">
              1. Selecione o Módulo / Plano
            </h3>

            <div className="space-y-3">
              {plans.map((p) => {
                const IconComp = p.icon;
                const isSelected = selectedPlanId === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => { setSelectedPlanId(p.id); setIsPaid(false); }}
                    className={`w-full p-4 rounded-2xl border text-left transition-all flex items-center justify-between ${
                      isSelected
                        ? 'bg-emerald-950/40 border-emerald-500 shadow-md ring-2 ring-emerald-500/20'
                        : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl bg-slate-950 text-emerald-400 border border-slate-800">
                        <IconComp className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="font-extrabold text-sm text-white">{p.name}</h4>
                        <span className="text-[11px] text-slate-400 font-mono">{p.subdomain}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <span className="font-extrabold text-base text-emerald-400">R$ {p.price}</span>
                      <span className="text-[10px] text-slate-500 block">/mês</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Payment Method & QR Code Column */}
          <div className="lg:col-span-2 bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 space-y-6">
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <div>
                <h2 className="text-lg font-extrabold text-white">Resumo & Pagamento</h2>
                <span className="text-xs text-slate-400">{selectedPlan.name} — R$ {selectedPlan.price}/mês</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setPaymentMethod('pix')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 border transition-all ${
                    paymentMethod === 'pix'
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-slate-950 text-slate-400 border-slate-800'
                  }`}
                >
                  <QrCode className="w-4 h-4" />
                  <span>PIX Instantâneo</span>
                </button>
                <button
                  onClick={() => setPaymentMethod('card')}
                  className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center gap-2 border transition-all ${
                    paymentMethod === 'card'
                      ? 'bg-emerald-600 text-white border-emerald-500'
                      : 'bg-slate-950 text-slate-400 border-slate-800'
                  }`}
                >
                  <CreditCard className="w-4 h-4" />
                  <span>Cartão</span>
                </button>
              </div>
            </div>

            {isPaid ? (
              <div className="bg-emerald-950/60 border border-emerald-500/40 rounded-3xl p-8 text-center space-y-4">
                <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center mx-auto text-3xl">
                  ✓
                </div>
                <h3 className="text-2xl font-extrabold text-white">Pagamento Confirmado com Sucesso!</h3>
                <p className="text-xs text-slate-300 max-w-md mx-auto">
                  A assinatura do módulo <strong className="text-emerald-400">{selectedPlan.name}</strong> foi ativada instantaneamente para sua conta HelpUS.
                </p>
                <a
                  href={`https://${selectedPlan.subdomain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-lg"
                >
                  <span>Acessar Plataforma ({selectedPlan.subdomain})</span>
                  <ArrowRight className="w-4 h-4" />
                </a>
              </div>
            ) : paymentMethod === 'pix' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
                {/* QR Code Container */}
                <div className="bg-white p-6 rounded-2xl text-center space-y-3 shadow-xl inline-block max-w-xs mx-auto">
                  <div className="w-48 h-48 bg-slate-950 rounded-xl p-2 flex items-center justify-center text-white mx-auto border-4 border-emerald-500">
                    <QrCode className="w-36 h-36 text-emerald-400" />
                  </div>
                  <span className="text-[11px] font-bold text-slate-800 uppercase tracking-wider block">
                    Escaneie com o app do seu Banco
                  </span>
                </div>

                {/* PIX Payload Copy Paste */}
                <div className="space-y-4">
                  <div className="space-y-1">
                    <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">PIX Copia e Cola</span>
                    <p className="text-xs text-slate-400 leading-relaxed">
                      Utilize a chave de pagamento instantâneo abaixo no aplicativo do seu banco:
                    </p>
                  </div>

                  <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 font-mono text-[10px] text-emerald-400 break-all">
                    {pixCode}
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      onClick={copyPix}
                      className="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-xs flex items-center gap-2 border border-slate-700"
                    >
                      {copiedPix ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                      <span>{copiedPix ? 'Copiado!' : 'Copiar Chave PIX'}</span>
                    </button>

                    <button
                      onClick={handleSimulatePayment}
                      className="px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs shadow-md shadow-emerald-600/30 flex items-center gap-2"
                    >
                      <span>Simular Baixa PIX</span>
                      <CheckCircle2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              /* Card Form */
              <div className="space-y-4 max-w-md">
                <div>
                  <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Número do Cartão</label>
                  <input type="text" placeholder="4532 •••• •••• 8891" className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm" />
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">Validade</label>
                    <input type="text" placeholder="12/28" className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-1">CVV</label>
                    <input type="text" placeholder="882" className="w-full p-3 rounded-xl bg-slate-950 border border-slate-800 text-white text-sm" />
                  </div>
                </div>
                <button
                  onClick={handleSimulatePayment}
                  className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-sm shadow-md"
                >
                  Pagar R$ {selectedPlan.price}
                </button>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800 py-8 bg-slate-900 text-center text-xs text-slate-500 font-medium">
        © 2026 HelpUS Technology Solutions — Gateway & Pay Engine.
      </footer>
    </div>
  );
}
