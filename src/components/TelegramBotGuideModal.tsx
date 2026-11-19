import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Send,
  Bot,
  ShieldCheck,
  Zap,
  Smartphone,
  CheckCircle2,
  Copy,
  Check,
  ArrowRight,
  ExternalLink,
  Lock,
  Sparkles,
  Info,
  X,
  MessageSquare,
  AlertTriangle,
  Layers,
  Percent
} from 'lucide-react';
import { parseTradingSignal } from '../utils/signalParser';

interface TelegramBotGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeOperator: string;
  maxRiskPercent?: number;
  maxRiskUsd?: number;
  maxLeverage?: number;
  requireStopLoss?: boolean;
}

export default function TelegramBotGuideModal({
  isOpen,
  onClose,
  activeOperator,
  maxRiskPercent = 2,
  maxRiskUsd = 10,
  maxLeverage = 50,
  requireStopLoss = true
}: TelegramBotGuideModalProps) {
  const [copiedStep, setCopiedStep] = useState<number | null>(null);
  const [botInfo, setBotInfo] = useState<any>(null);
  const [testSignal, setTestSignal] = useState(
    '#BTCUSDT COMPRA LONG\nEntrada: Mercado ou 95500\nAlvos: 96500, 97500, 99000\nStop Loss: 94200\nAlavancagem: 50x (Isolada)'
  );
  const [parsedPreview, setParsedPreview] = useState<any>(() => parseTradingSignal(testSignal));

  React.useEffect(() => {
    if (isOpen) {
      fetch('/api/telegram-bot-info')
        .then(res => res.json())
        .then(data => {
          if (data.ok) {
            setBotInfo(data);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  const botUsername = botInfo?.bot?.username || 'Crypptooo_bot';

  const handleCopy = (text: string, index: number) => {
    navigator.clipboard.writeText(text);
    setCopiedStep(index);
    setTimeout(() => setCopiedStep(null), 2000);
  };

  const handleTestChange = (text: string) => {
    setTestSignal(text);
    setParsedPreview(parseTradingSignal(text));
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        className="relative w-full max-w-3xl bg-[#131722] border border-[#2a2e39] rounded-2xl shadow-2xl overflow-hidden my-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 sm:px-6 sm:py-5 border-b border-[#2a2e39] bg-gradient-to-r from-blue-950/40 via-[#131722] to-[#131722]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600/20 border border-blue-500/30 flex items-center justify-center text-blue-400 shrink-0">
              <Bot className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-white">Integração Bot Telegram & Mobilidade</h3>
                <span className="px-2 py-0.5 text-[10px] sm:text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20 rounded-full">
                  Bruno & Leo
                </span>
              </div>
              <p className="text-xs text-gray-400">
                Encaminhe sinais do celular direto para o bot sem risco de erro operacional.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 sm:p-2 text-gray-400 hover:text-white hover:bg-gray-800/60 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-4 sm:p-6 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
          
          {/* Active Bot Status Card */}
          <div className="p-3.5 rounded-xl bg-gradient-to-r from-blue-900/30 to-emerald-900/20 border border-blue-500/30 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30 shrink-0">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-white">Bot Oficial Vinculado:</span>
                  <span className="text-xs font-mono font-bold text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20">
                    @{botUsername}
                  </span>
                  <span className="text-[9px] font-bold text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                    🟢 Online
                  </span>
                </div>
                <p className="text-[11px] text-gray-300 mt-0.5">
                  Pronto para receber mensagens e sinais de Bruno e Leo no Telegram.
                </p>
              </div>
            </div>

            <a
              href={`https://t.me/${botUsername}`}
              target="_blank"
              rel="noreferrer"
              className="px-3.5 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 shadow-lg shadow-blue-600/20"
            >
              <Send className="w-3.5 h-3.5" />
              <span>Abrir @{botUsername}</span>
            </a>
          </div>

          {/* Visual Step-by-Step Flow */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-blue-600/30 text-blue-400 flex items-center justify-center text-xs font-bold">1</span>
                  <Smartphone className="w-4 h-4 text-blue-400" />
                </div>
                <h4 className="text-xs sm:text-sm font-bold text-white mb-1">Encaminhe o Sinal</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Quando Bruno estiver off, Leo recebe o sinal no Telegram VIP e só precisa encaminhar para o bot.
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-[#2a2e39]/60 text-[11px] text-blue-400 font-mono">
                📱 Direto do Celular
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-emerald-600/30 text-emerald-400 flex items-center justify-center text-xs font-bold">2</span>
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                </div>
                <h4 className="text-xs sm:text-sm font-bold text-white mb-1">Travas de Bruno Aplicadas</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Perda fixada em <strong>2%</strong> da conta, Stop Loss obrigatório e Trailing Stop 1x ativado automaticamente.
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-[#2a2e39]/60 text-[11px] text-emerald-400 font-mono">
                🛡️ Risco 2% Fixado
              </div>
            </div>

            <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="w-6 h-6 rounded-full bg-purple-600/30 text-purple-400 flex items-center justify-center text-xs font-bold">3</span>
                  <Zap className="w-4 h-4 text-purple-400" />
                </div>
                <h4 className="text-xs sm:text-sm font-bold text-white mb-1">Execução Bitunix</h4>
                <p className="text-xs text-gray-400 leading-relaxed">
                  Ordem aberta em milissegundos na Bitunix. Bruno e Leo recebem recibo e acompanham em tempo real.
                </p>
              </div>
              <div className="mt-3 pt-2 border-t border-[#2a2e39]/60 text-[11px] text-purple-400 font-mono">
                ⚡ Resposta Instantânea
              </div>
            </div>
          </div>

          {/* Interactive Simulation / Demonstration */}
          <div className="p-4 rounded-xl bg-[#181b24] border border-[#2a2e39] space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-xs sm:text-sm font-bold text-white">
                <MessageSquare className="w-4 h-4 text-blue-400" />
                <span>Simulação: Tradução e Blindagem da Mensagem</span>
              </div>
              <span className="text-[11px] text-gray-400">Edite para simular</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Input text */}
              <div>
                <label className="block text-[11px] font-bold text-gray-400 mb-1.5">
                  Mensagem recebida no Telegram:
                </label>
                <textarea
                  value={testSignal}
                  onChange={(e) => handleTestChange(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#111319] border border-[#2a2e39] rounded-lg text-gray-200 focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>

              {/* Parsed & Guarded result */}
              <div className="p-3 rounded-lg bg-[#111319] border border-[#2a2e39] space-y-2">
                <div className="text-xs font-bold text-gray-300 flex items-center justify-between">
                  <span>Tradução c/ Travas do Bruno</span>
                  <span className="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">
                    Blindado
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] font-mono">
                  <div className="p-1.5 rounded bg-[#1e222d] border border-[#2a2e39]/60">
                    <span className="text-gray-500 block text-[9px] uppercase">Símbolo / Lado</span>
                    <span className="text-white font-bold">{parsedPreview.symbol || 'BTCUSDT'}</span>{' '}
                    <span className={parsedPreview.direction === 'LONG' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                      {parsedPreview.direction}
                    </span>
                  </div>

                  <div className="p-1.5 rounded bg-[#1e222d] border border-[#2a2e39]/60">
                    <span className="text-gray-500 block text-[9px] uppercase">Alavancagem</span>
                    <span className="text-amber-400 font-bold">
                      {parsedPreview.leverage || 50}x (Livre)
                    </span>
                  </div>

                  <div className="p-1.5 rounded bg-[#1e222d] border border-[#2a2e39]/60">
                    <span className="text-gray-500 block text-[9px] uppercase">Stop Loss</span>
                    <span className="text-red-400 font-bold">
                      {parsedPreview.stopLoss ? `$${parsedPreview.stopLoss}` : '2.0% Emergência'}
                    </span>
                  </div>

                  <div className="p-1.5 rounded bg-[#1e222d] border border-[#2a2e39]/60">
                    <span className="text-gray-500 block text-[9px] uppercase">Perda Fixada</span>
                    <span className="text-emerald-400 font-bold">2.0% da Conta</span>
                  </div>
                </div>

                <div className="text-[10px] text-gray-400 flex items-center gap-1.5 pt-1">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Trailing Stop 1:1 travado e margem auto-dimensionada para 2%</span>
                </div>
              </div>
            </div>
          </div>

          {/* Practical Benefits for Business Partners */}
          <div className="space-y-2.5">
            <h4 className="text-xs font-bold text-gray-300 uppercase tracking-wider">
              Vantagens para a parceria Bruno & Leo
            </h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#1e222d]/60 border border-[#2a2e39]">
                <div className="w-5 h-5 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0 mt-0.5 font-bold">
                  ✓
                </div>
                <div>
                  <span className="font-bold text-white block">Zero Risco de Alavancagem Desenfreada</span>
                  <span className="text-gray-400">Mesmo com alavancagem alta do sinal, a margem em USD é comprimida para respeitar os 2% de risco.</span>
                </div>
              </div>

              <div className="flex items-start gap-2.5 p-3 rounded-lg bg-[#1e222d]/60 border border-[#2a2e39]">
                <div className="w-5 h-5 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center shrink-0 mt-0.5 font-bold">
                  ✓
                </div>
                <div>
                  <span className="font-bold text-white block">Sincronização Nuvem Firestore</span>
                  <span className="text-gray-400">Bruno monitora remotamente todas as execuções e histórico de ordens com assinatura do operador.</span>
                </div>
              </div>
            </div>
          </div>

        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 sm:px-6 border-t border-[#2a2e39] bg-[#111319]">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span>Operador Atual: <strong className="text-white">{activeOperator}</strong></span>
          </div>
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold text-white bg-blue-600 hover:bg-blue-500 rounded-lg transition-colors"
          >
            Entendido, Fechar Guia
          </button>
        </div>
      </motion.div>
    </div>
  );
}
