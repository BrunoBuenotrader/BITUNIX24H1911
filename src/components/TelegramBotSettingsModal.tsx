import React, { useState, useEffect } from 'react';
import { TelegramBotConfig, DEFAULT_TELEGRAM_BOT_CONFIG } from '../types/cloudSync';
import { 
  ShieldAlert, 
  DollarSign, 
  Zap, 
  Crosshair, 
  CheckCircle2, 
  X, 
  TrendingUp, 
  RotateCcw,
  Sparkles,
  Bot,
  Layers,
  ShieldCheck,
  Percent,
  SlidersHorizontal,
  ChevronRight,
  Globe,
  Radio,
  Copy,
  Check,
  Server,
  Activity,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Clock,
  RefreshCw,
  Key,
  Eye,
  EyeOff,
  Lock,
  AlertCircle,
  Save
} from 'lucide-react';

interface TelegramBotSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: TelegramBotConfig;
  onSave: (newConfig: TelegramBotConfig) => void;
  activeOperator?: string;
  isMaster?: boolean;
  apiKey?: string;
  setApiKey?: (key: string) => void;
  apiSecret?: string;
  setApiSecret?: (secret: string) => void;
}

export const TelegramBotSettingsModal: React.FC<TelegramBotSettingsModalProps> = ({
  isOpen,
  onClose,
  config: initialConfig,
  onSave,
  activeOperator = 'Bruno',
  isMaster = true,
  apiKey: initialApiKey = '',
  setApiKey,
  apiSecret: initialApiSecret = '',
  setApiSecret
}) => {
  const [config, setConfig] = useState<TelegramBotConfig>({
    ...DEFAULT_TELEGRAM_BOT_CONFIG,
    ...initialConfig
  });

  const [hasSaved, setHasSaved] = useState(false);
  const [botInfo, setBotInfo] = useState<any>(null);
  const [loadingBot, setLoadingBot] = useState(false);
  const [copiedKeepAlive, setCopiedKeepAlive] = useState(false);

  // Credentials State
  const [telegramToken, setTelegramToken] = useState<string>('');
  const [apiKeyVal, setApiKeyVal] = useState<string>(initialApiKey || '');
  const [apiSecretVal, setApiSecretVal] = useState<string>(initialApiSecret || '');
  const [showTelegramToken, setShowTelegramToken] = useState<boolean>(false);
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [showApiSecret, setShowApiSecret] = useState<boolean>(false);
  const [isTestingTelegram, setIsTestingTelegram] = useState<boolean>(false);
  const [telegramFeedback, setTelegramFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isTestingBitunix, setIsTestingBitunix] = useState<boolean>(false);
  const [bitunixFeedback, setBitunixFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isSavingCreds, setIsSavingCreds] = useState<boolean>(false);
  const [credsSaveSuccess, setCredsSaveSuccess] = useState<boolean>(false);
  const [showUptimeGuide, setShowUptimeGuide] = useState<boolean>(false);
  const [testingPing, setTestingPing] = useState<boolean>(false);
  const [pingResult, setPingResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const testUptimePing = async () => {
    try {
      setTestingPing(true);
      setPingResult(null);
      const res = await fetch('/health');
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        setPingResult({
          ok: true,
          msg: `Endpoint 200 OK! Bot @${data.botUsername || 'BHBtradebitunix_bot'} online (Batimento: ${data.secondsSinceHeartbeat ?? 0}s | Conexão blindada 24/7 sem conflitos)`
        });
      } else {
        setPingResult({ ok: false, msg: `Resposta inesperada: ${res.status}` });
      }
    } catch (e: any) {
      setPingResult({ ok: false, msg: `Erro de conexão: ${e.message}` });
    } finally {
      setTestingPing(false);
    }
  };

  const fetchBotStatus = async () => {
    try {
      setLoadingBot(true);
      const res = await fetch('/api/telegram-bot-info');
      const data = await res.json();
      if (data.ok) {
        setBotInfo(data);
      }
    } catch (e) {
      // ignore
    } finally {
      setLoadingBot(false);
    }
  };

  const fetchCredentials = async () => {
    try {
      const res = await fetch('/api/credentials');
      const data = await res.json();
      if (data.ok) {
        if (data.telegramToken) setTelegramToken(data.telegramToken);
        if (data.apiKey) setApiKeyVal(data.apiKey);
        if (data.apiSecret) setApiSecretVal(data.apiSecret);
      }
    } catch (e) {
      // ignore
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchBotStatus();
      fetchCredentials();
    }
  }, [isOpen]);

  const testTelegramToken = async () => {
    if (!telegramToken.trim()) {
      setTelegramFeedback({ ok: false, msg: 'Por favor, insira o Token do Bot do Telegram antes de testar.' });
      return;
    }
    try {
      setIsTestingTelegram(true);
      setTelegramFeedback(null);
      const res = await fetch('/api/test-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'telegram', telegramToken: telegramToken.trim() })
      });
      const data = await res.json();
      if (data.ok) {
        setTelegramFeedback({ ok: true, msg: data.message });
        fetchBotStatus();
      } else {
        setTelegramFeedback({ ok: false, msg: data.error || 'Token inválido no Telegram.' });
      }
    } catch (e: any) {
      setTelegramFeedback({ ok: false, msg: e?.message || 'Erro de comunicação ao testar token.' });
    } finally {
      setIsTestingTelegram(false);
    }
  };

  const testBitunixConnection = async () => {
    if (!apiKeyVal.trim() || !apiSecretVal.trim()) {
      setBitunixFeedback({ ok: false, msg: 'Informe a API Key e o API Secret da Bitunix antes de testar.' });
      return;
    }
    try {
      setIsTestingBitunix(true);
      setBitunixFeedback(null);
      const res = await fetch('/api/test-credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'bitunix', apiKey: apiKeyVal.trim(), apiSecret: apiSecretVal.trim() })
      });
      const data = await res.json();
      if (data.ok) {
        setBitunixFeedback({ ok: true, msg: data.message });
      } else {
        setBitunixFeedback({ ok: false, msg: data.error || 'Falha de autenticação na Bitunix.' });
      }
    } catch (e: any) {
      setBitunixFeedback({ ok: false, msg: e?.message || 'Erro ao testar chaves Bitunix.' });
    } finally {
      setIsTestingBitunix(false);
    }
  };

  const handleSaveCredentialsOnly = async () => {
    try {
      setIsSavingCreds(true);
      const res = await fetch('/api/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: apiKeyVal.trim(),
          apiSecret: apiSecretVal.trim(),
          telegramToken: telegramToken.trim()
        })
      });
      const data = await res.json();
      if (data.ok) {
        if (setApiKey) setApiKey(apiKeyVal.trim());
        if (setApiSecret) setApiSecret(apiSecretVal.trim());
        setCredsSaveSuccess(true);
        setTimeout(() => setCredsSaveSuccess(false), 3000);
        fetchBotStatus();
      }
    } catch (e) {
      // ignore
    } finally {
      setIsSavingCreds(false);
    }
  };

  const copyKeepAliveUrl = () => {
    const keepAliveUrl = `${window.location.origin}/health`;
    navigator.clipboard.writeText(keepAliveUrl);
    setCopiedKeepAlive(true);
    setTimeout(() => setCopiedKeepAlive(false), 2500);
  };

  if (!isOpen) return null;

  const handleSave = async () => {
    // Save credentials to backend and firestore
    if (apiKeyVal || apiSecretVal || telegramToken) {
      try {
        await fetch('/api/credentials', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            apiKey: apiKeyVal.trim(),
            apiSecret: apiSecretVal.trim(),
            telegramToken: telegramToken.trim()
          })
        });
        if (setApiKey) setApiKey(apiKeyVal.trim());
        if (setApiSecret) setApiSecret(apiSecretVal.trim());
      } catch (e) {}
    }

    const updatedConfig = { ...config, telegramBotToken: telegramToken.trim() };
    onSave(updatedConfig);

    // Also sync to backend API
    fetch('/api/telegram-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedConfig)
    }).catch(() => {});

    setHasSaved(true);
    setTimeout(() => {
      setHasSaved(false);
      onClose();
    }, 800);
  };

  const handleResetDefaults = () => {
    setConfig(DEFAULT_TELEGRAM_BOT_CONFIG);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/85 backdrop-blur-md overflow-y-auto">
      <div className="bg-[#10141e] border border-slate-700/80 rounded-2xl w-full max-w-2xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-[#141926]">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-sky-500/20 text-sky-400 rounded-xl border border-sky-500/30 flex items-center justify-center shrink-0">
              <Bot className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold text-white">
                  Configurações do Bot Telegram
                </h2>
                <span className="text-[11px] font-mono font-bold px-2 py-0.5 rounded-full bg-sky-500/15 text-sky-300 border border-sky-500/30">
                  @{botInfo?.bot?.username || 'Crypptooo_bot'}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Defina como o robô calcula risco, margem, alavancagem e executa ordens na Bitunix.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body Content */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-5 flex-1 text-sm text-slate-300 custom-scrollbar">
          
          {/* Card 0: Funcionamento 24h com UptimeRobot (Fiel ao print do usuário) */}
          <div className="bg-slate-900/90 border border-emerald-500/40 rounded-xl p-4 sm:p-5 space-y-3.5 shadow-lg relative overflow-hidden">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
                <h3 className="text-sm font-bold text-white flex items-center gap-2">
                  Funcionamento 24h com UptimeRobot
                </h3>
                <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 uppercase tracking-wide">
                  ENDPOINT ATIVO
                </span>
              </div>

              <div className="flex items-center gap-2 text-xs">
                <span className="text-[11px] text-slate-400">
                  Bot: <b className="text-sky-300">@{botInfo?.bot?.username || 'BHBtradebitunix_bot'}</b>
                </span>
                <button
                  type="button"
                  onClick={fetchBotStatus}
                  disabled={loadingBot}
                  className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
                  title="Atualizar status"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingBot ? 'animate-spin text-sky-400' : ''}`} />
                </button>
              </div>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Para o bot responder no Telegram 24 horas por dia sem parar (mesmo com esta aba do navegador fechada), adicione a URL de saúde abaixo no seu <strong>UptimeRobot</strong> com monitor do tipo <strong>HTTP(s)</strong> a cada <strong>5 minutos</strong>.
            </p>

            {/* URL do Monitor e Botão Copiar */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 bg-[#0b0e14] border border-slate-700/80 rounded-xl p-2.5">
              <div className="flex items-center gap-2 flex-1 min-w-0 px-1.5 overflow-hidden">
                <span className="text-xs text-slate-400 font-medium shrink-0">URL do Monitor:</span>
                <span className="text-xs font-mono text-emerald-400 select-all truncate font-semibold">
                  {typeof window !== 'undefined' ? `${window.location.origin}/health` : '/health'}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={testUptimePing}
                  disabled={testingPing}
                  className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 rounded-lg text-xs font-semibold transition-all flex items-center justify-center gap-1.5"
                  title="Testar resposta do endpoint de saúde"
                >
                  <Activity className={`w-3.5 h-3.5 text-emerald-400 ${testingPing ? 'animate-spin' : ''}`} />
                  <span>{testingPing ? 'Testando...' : 'Testar Ping'}</span>
                </button>
                <button
                  type="button"
                  onClick={copyKeepAliveUrl}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-md shadow-emerald-950/40"
                >
                  {copiedKeepAlive ? (
                    <>
                      <Check className="w-4 h-4 text-white" />
                      <span>URL Copiada!</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-4 h-4" />
                      <span>Copiar URL para UptimeRobot</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {pingResult && (
              <div className={`p-2.5 rounded-lg text-xs flex items-center gap-2 ${
                pingResult.ok 
                  ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300' 
                  : 'bg-red-500/15 border border-red-500/30 text-red-300'
              }`}>
                {pingResult.ok ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" /> : <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />}
                <span>{pingResult.msg}</span>
              </div>
            )}

            {/* Rodapé com os 3 bullets verdes exatamente como no print */}
            <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-slate-300 font-medium">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
                Mantém o servidor ativo sem dormir
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
                Reinicia polling automaticamente se houver oscilação
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"></span>
                Funciona com navegador fechado
              </span>
            </div>

            {/* Passo a Passo Colapsável */}
            <div className="pt-1">
              <button
                type="button"
                onClick={() => setShowUptimeGuide(!showUptimeGuide)}
                className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 font-semibold transition-colors"
              >
                <span>{showUptimeGuide ? 'Ocultar passo a passo' : 'Ver como adicionar no painel do UptimeRobot (100% Gratuito)'}</span>
                {showUptimeGuide ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </button>

              {showUptimeGuide && (
                <div className="mt-2.5 p-3.5 bg-[#0b0e14] border border-slate-800 rounded-xl space-y-2 text-xs text-slate-300 animate-in fade-in duration-200">
                  <div className="font-bold text-white flex items-center gap-1.5">
                    <ExternalLink className="w-3.5 h-3.5 text-sky-400" />
                    Como configurar no UptimeRobot:
                  </div>
                  <ol className="list-decimal list-inside space-y-1 text-slate-300 text-[11px] pl-1">
                    <li>Acesse <a href="https://uptimerobot.com" target="_blank" rel="noreferrer" className="text-sky-400 underline font-semibold">uptimerobot.com</a> e entre na sua conta (ou crie grátis).</li>
                    <li>Clique no botão <strong>+ Add New Monitor</strong>.</li>
                    <li><strong>Monitor Type:</strong> Escolha <strong>HTTP(s)</strong>.</li>
                    <li><strong>Friendly Name:</strong> Digite <strong>Bot Telegram Bitunix</strong>.</li>
                    <li><strong>URL (or IP):</strong> Cole a URL copiada acima (<span className="font-mono text-emerald-400">{typeof window !== 'undefined' ? `${window.location.origin}/health` : '/health'}</span>).</li>
                    <li><strong>Monitoring Interval:</strong> Selecione <strong>5 minutes</strong> (ou 1 minute se disponível).</li>
                    <li>Clique em <strong>Create Monitor</strong>. Pronto! O bot nunca mais dorme!</li>
                  </ol>
                </div>
              )}
            </div>
          </div>

          {/* Card Especial: Trocar Chaves API Bitunix & Token do Bot Telegram */}
          <div className="bg-[#151b2b] border-2 border-amber-500/40 rounded-xl p-4 sm:p-5 space-y-4 shadow-xl relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-3xl pointer-events-none"></div>

            {/* Cabeçalho da Seção de Credenciais */}
            <div className="flex items-center justify-between flex-wrap gap-2 pb-3 border-b border-slate-800">
              <div className="flex items-center space-x-3">
                <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center shrink-0">
                  <Key className="w-5 h-5" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-bold text-white tracking-wide">
                      Trocar Chaves API & Token do Telegram
                    </h3>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/40">
                      Sincronização Ativa
                    </span>
                  </div>
                  <p className="text-xs text-slate-400">
                    Altere o Token do seu Bot e as credenciais da Bitunix sem sair da tela.
                  </p>
                </div>
              </div>

              {credsSaveSuccess && (
                <span className="flex items-center gap-1 text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2.5 py-1 rounded-lg border border-emerald-500/30 animate-pulse">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Salvo com sucesso!
                </span>
              )}
            </div>

            {/* Campo 1: Token do Bot Telegram */}
            <div className="space-y-1.5 bg-slate-900/70 p-3 rounded-xl border border-slate-800">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                  <Bot className="w-3.5 h-3.5 text-sky-400" />
                  Token do Bot Telegram (@BotFather)
                </label>
                <a 
                  href="https://t.me/BotFather" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="text-[11px] text-sky-400 hover:text-sky-300 hover:underline flex items-center gap-1"
                >
                  Criar bot no @BotFather <ExternalLink className="w-3 h-3" />
                </a>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <input
                    type={showTelegramToken ? "text" : "password"}
                    value={telegramToken}
                    onChange={(e) => setTelegramToken(e.target.value)}
                    placeholder="Ex: 7927456499:AAGEwavDdQNPnsovTok-eeVi..."
                    className="w-full bg-[#0d111a] border border-slate-700 rounded-lg px-3 py-2 pr-9 text-xs font-mono text-sky-300 placeholder:text-slate-600 focus:outline-none focus:border-sky-500 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTelegramToken(!showTelegramToken)}
                    className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300 transition-colors"
                    title={showTelegramToken ? "Ocultar" : "Mostrar"}
                  >
                    {showTelegramToken ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={testTelegramToken}
                  disabled={isTestingTelegram || !telegramToken}
                  className="px-3 py-2 bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 border border-sky-500/40 rounded-lg text-xs font-bold transition-all disabled:opacity-40 flex items-center gap-1.5 shrink-0"
                >
                  {isTestingTelegram ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Testando...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Testar Token</span>
                    </>
                  )}
                </button>
              </div>

              {telegramFeedback && (
                <div className={`p-2 rounded-lg text-xs flex items-center gap-1.5 ${
                  telegramFeedback.ok 
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold' 
                    : 'bg-red-500/15 border border-red-500/30 text-red-300'
                }`}>
                  {telegramFeedback.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />}
                  <span>{telegramFeedback.msg}</span>
                </div>
              )}
            </div>

            {/* Campo 2 & 3: Bitunix API Key e Secret Key */}
            <div className="space-y-3 bg-slate-900/70 p-3 rounded-xl border border-slate-800">
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-amber-400" />
                  Credenciais da Conta Bitunix (Futuros Perpétuos)
                </span>
                <span className="text-[10px] text-slate-400">Opera em Conta Real USDT</span>
              </div>

              {/* API Key */}
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 font-semibold">Bitunix API Key (Chave Pública):</label>
                <div className="relative">
                  <input
                    type={showApiKey ? "text" : "password"}
                    value={apiKeyVal}
                    onChange={(e) => setApiKeyVal(e.target.value)}
                    placeholder="Cole sua Bitunix API Key..."
                    className="w-full bg-[#0d111a] border border-slate-700 rounded-lg px-3 py-2 pr-9 text-xs font-mono text-amber-300 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showApiKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Secret Key */}
              <div className="space-y-1">
                <label className="text-[11px] text-slate-400 font-semibold">Bitunix Secret Key (Chave Secreta):</label>
                <div className="relative">
                  <input
                    type={showApiSecret ? "text" : "password"}
                    value={apiSecretVal}
                    onChange={(e) => setApiSecretVal(e.target.value)}
                    placeholder="Cole seu Bitunix Secret Key..."
                    className="w-full bg-[#0d111a] border border-slate-700 rounded-lg px-3 py-2 pr-9 text-xs font-mono text-amber-300 placeholder:text-slate-600 focus:outline-none focus:border-amber-500 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiSecret(!showApiSecret)}
                    className="absolute right-2.5 top-2.5 text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showApiSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              {/* Botão Testar Bitunix */}
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  onClick={testBitunixConnection}
                  disabled={isTestingBitunix || !apiKeyVal || !apiSecretVal}
                  className="px-3 py-1.5 bg-amber-500/20 hover:bg-amber-500/30 text-amber-300 border border-amber-500/40 rounded-lg text-xs font-bold transition-all disabled:opacity-40 flex items-center gap-1.5"
                >
                  {isTestingBitunix ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Verificando Saldo...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Testar Conexão Bitunix</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={handleSaveCredentialsOnly}
                  disabled={isSavingCreds}
                  className="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 shadow-sm"
                >
                  {isSavingCreds ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Salvando...</span>
                    </>
                  ) : (
                    <>
                      <Save className="w-3.5 h-3.5" />
                      <span>Salvar Chaves</span>
                    </>
                  )}
                </button>
              </div>

              {bitunixFeedback && (
                <div className={`p-2 rounded-lg text-xs flex items-center gap-1.5 ${
                  bitunixFeedback.ok 
                    ? 'bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-semibold' 
                    : 'bg-red-500/15 border border-red-500/30 text-red-300'
                }`}>
                  {bitunixFeedback.ok ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 text-emerald-400" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0 text-red-400" />}
                  <span>{bitunixFeedback.msg}</span>
                </div>
              )}
            </div>
          </div>

          {/* Card 1: Modo de Disparo do Sinal */}
          <div className="bg-[#161b29] border border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex items-center gap-2 text-white font-semibold text-sm">
              <Zap className="w-4 h-4 text-amber-400" />
              <span>Modo de Disparo do Sinal</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setConfig(prev => ({ ...prev, autoExecuteWithoutPrompt: false }))}
                className={`p-3.5 rounded-xl border text-left flex flex-col justify-between transition-all ${
                  !config.autoExecuteWithoutPrompt
                    ? 'bg-sky-500/15 border-sky-500 text-white shadow-lg shadow-sky-500/10'
                    : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-xs sm:text-sm text-sky-400">1-Toque com Confirmação</span>
                  {!config.autoExecuteWithoutPrompt && <CheckCircle2 className="w-4 h-4 text-sky-400 shrink-0" />}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Envia o resumo completo com o botão <b className="text-sky-300">[Executar na Bitunix]</b> para você aprovar no Telegram.
                </p>
              </button>

              <button
                type="button"
                onClick={() => setConfig(prev => ({ ...prev, autoExecuteWithoutPrompt: true }))}
                className={`p-3.5 rounded-xl border text-left flex flex-col justify-between transition-all ${
                  config.autoExecuteWithoutPrompt
                    ? 'bg-emerald-500/15 border-emerald-500 text-white shadow-lg shadow-emerald-500/10'
                    : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-bold text-xs sm:text-sm text-emerald-400">⚡ Auto-Execução Instantânea</span>
                  {config.autoExecuteWithoutPrompt && <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />}
                </div>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Ao encaminhar o sinal, o bot abre a ordem na Bitunix no mesmo segundo e envia o comprovante no chat.
                </p>
              </button>
            </div>
          </div>

          {/* Card 2: Gestão de Risco & Cálculo de Margem */}
          <div className="bg-[#161b29] border border-slate-800 rounded-xl p-4 space-y-4">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 text-white font-semibold text-sm">
                <ShieldAlert className="w-4 h-4 text-rose-400" />
                <span>Gestão de Risco por Operação</span>
              </div>
              <div className="flex items-center bg-slate-900 rounded-lg p-1 border border-slate-800 text-xs">
                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, riskMode: 'PERCENT' }))}
                  className={`px-3 py-1 rounded-md font-semibold transition-all ${
                    config.riskMode === 'PERCENT'
                      ? 'bg-rose-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  % da Conta
                </button>
                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, riskMode: 'FIXED_USD' }))}
                  className={`px-3 py-1 rounded-md font-semibold transition-all ${
                    config.riskMode === 'FIXED_USD'
                      ? 'bg-rose-500 text-white shadow-sm'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  $ Fixo USD
                </button>
              </div>
            </div>

            {config.riskMode === 'PERCENT' ? (
              <div className="space-y-3 bg-slate-900/70 p-3.5 rounded-xl border border-slate-800/80">
                <div className="flex justify-between items-center">
                  <span className="text-xs text-slate-400">Risco por Trade (% do saldo total):</span>
                  <span className="text-base font-bold text-rose-400 font-mono bg-rose-500/10 px-2 py-0.5 rounded border border-rose-500/20">
                    {config.riskPercent.toFixed(1)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.5"
                  max="10"
                  step="0.5"
                  value={config.riskPercent}
                  onChange={(e) => setConfig(prev => ({ ...prev, riskPercent: parseFloat(e.target.value) }))}
                  className="w-full h-2 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-rose-500"
                />
                <div className="flex justify-between items-center gap-1.5 pt-1">
                  {[0.5, 1.0, 2.0, 3.0, 5.0].map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => setConfig(prev => ({ ...prev, riskPercent: val }))}
                      className={`flex-1 py-1 rounded-lg text-xs font-mono font-semibold transition-all border ${
                        config.riskPercent === val
                          ? 'bg-rose-500/20 border-rose-500 text-rose-300'
                          : 'bg-slate-800/50 border-slate-700/60 text-slate-400 hover:text-white'
                      }`}
                    >
                      {val}% {val === 2.0 ? '🛡️' : ''}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-2 bg-slate-900/70 p-3.5 rounded-xl border border-slate-800/80">
                <label className="text-xs text-slate-400">Perda Máxima Fixa em Dólar ($):</label>
                <div className="relative">
                  <DollarSign className="absolute left-3 top-2.5 w-4 h-4 text-slate-500" />
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={config.riskFixedUsd}
                    onChange={(e) => setConfig(prev => ({ ...prev, riskFixedUsd: Math.max(1, parseFloat(e.target.value) || 1) }))}
                    className="w-full bg-slate-800 border border-slate-700 rounded-lg py-2 pl-9 pr-3 text-white font-mono text-sm focus:outline-none focus:border-rose-500"
                    placeholder="Ex: 10"
                  />
                </div>
              </div>
            )}

            <div className="pt-2 border-t border-slate-800 flex items-center justify-between">
              <div>
                <span className="text-xs font-semibold text-slate-300">Embutir Taxas de Corretagem (0.10%)</span>
                <p className="text-[11px] text-slate-400">Desconta as taxas de abertura e fechamento para nunca passar do risco estipulado.</p>
              </div>
              <input
                type="checkbox"
                checked={config.includeFeesInRisk}
                onChange={(e) => setConfig(prev => ({ ...prev, includeFeesInRisk: e.target.checked }))}
                className="w-4 h-4 rounded text-rose-500 focus:ring-rose-500 border-slate-700 bg-slate-800 cursor-pointer"
              />
            </div>
          </div>

          {/* Card 3: Conta Destino & Alavancagem */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            
            {/* Conta */}
            <div className="bg-[#161b29] border border-slate-800 rounded-xl p-4 space-y-3 flex flex-col justify-between">
              <div>
                <div className="flex items-center gap-2 text-white font-semibold text-sm mb-1">
                  <Layers className="w-4 h-4 text-emerald-400" />
                  <span>Conta de Destino</span>
                </div>
                <p className="text-xs text-slate-400">Escolha onde o bot enviará as ordens.</p>
              </div>
              
              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, accountType: 'USDT' }))}
                  className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                    config.accountType === 'USDT'
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-md shadow-emerald-500/10'
                      : 'bg-slate-900/70 border-slate-800 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-emerald-400" />
                  <span>USDT Real</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, accountType: 'VST' }))}
                  className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                    config.accountType === 'VST'
                      ? 'bg-amber-500/20 border-amber-500 text-amber-300 shadow-md shadow-amber-500/10'
                      : 'bg-slate-900/70 border-slate-800 text-slate-400 hover:bg-slate-800'
                  }`}
                >
                  <span className="w-2 h-2 rounded-full bg-amber-400" />
                  <span>VST Simulação</span>
                </button>
              </div>
            </div>

            {/* Alavancagem */}
            <div className="bg-[#161b29] border border-slate-800 rounded-xl p-4 space-y-3">
              <div className="flex items-center gap-2 text-white font-semibold text-sm">
                <TrendingUp className="w-4 h-4 text-sky-400" />
                <span>Regra de Alavancagem</span>
              </div>

              <select
                value={config.defaultLeverageMode}
                onChange={(e: any) => setConfig(prev => ({ ...prev, defaultLeverageMode: e.target.value }))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-sky-500"
              >
                <option value="SIGNAL_LEVERAGE">Usar Alavancagem do Sinal (com Teto)</option>
                <option value="FIXED_LEVERAGE">Forçar Alavancagem Fixa</option>
              </select>

              {config.defaultLeverageMode === 'FIXED_LEVERAGE' ? (
                <div className="flex items-center justify-between bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">Valor Fixo Forçado:</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="1"
                      max="1000"
                      value={config.fixedLeverageValue}
                      onChange={(e) => setConfig(prev => ({ ...prev, fixedLeverageValue: parseInt(e.target.value) || 20 }))}
                      className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono text-center"
                    />
                    <span className="text-xs text-slate-400 font-bold">x</span>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between bg-slate-900/70 p-2 rounded-lg border border-slate-800">
                  <span className="text-xs text-slate-400">Teto Máximo de Segurança:</span>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="5"
                      max="1000"
                      value={config.maxLeverageCap}
                      onChange={(e) => setConfig(prev => ({ ...prev, maxLeverageCap: parseInt(e.target.value) || 1000 }))}
                      className="w-16 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs text-white font-mono text-center"
                    />
                    <span className="text-xs text-slate-400 font-bold">x</span>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Card 4: Trailing Stop & Take Profit (TOTALMENTE REDESENHADO E DESBUGADO) */}
          <div className="bg-[#161b29] border border-slate-800 rounded-xl p-4 space-y-4">
            <div className="flex items-center gap-2 text-white font-semibold text-sm">
              <Crosshair className="w-4 h-4 text-purple-400" />
              <span>Trailing Stop & Alvo de Lucro (Bitunix)</span>
            </div>

            {/* Trailing Stop Subsection */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">Trailing Stop (Stop Móvel)</span>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-semibold ${
                      config.trailingStopEnabled 
                        ? 'bg-purple-500/20 text-purple-300 border border-purple-500/30'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {config.trailingStopEnabled ? 'Ativado' : 'Desativado'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Acompanha a subida do preço e garante o lucro sem ser estopado no 0 a 0 cedo demais.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, trailingStopEnabled: !prev.trailingStopEnabled }))}
                  className={`w-12 h-6 flex items-center rounded-full p-1 transition-colors duration-200 cursor-pointer shrink-0 ${
                    config.trailingStopEnabled ? 'bg-purple-600' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                      config.trailingStopEnabled ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {config.trailingStopEnabled && (
                <div className="pt-2 border-t border-slate-800/80 space-y-2">
                  <label className="text-xs text-slate-400 block font-medium">
                    Distância do Trailing Stop (em relação ao Stop Loss):
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    {[
                      { val: 0.75, label: '0.75x (Mais Justo)' },
                      { val: 1.0, label: '1.0x (1:1 Padrão)' },
                      { val: 1.5, label: '1.5x (Intermediário)' },
                      { val: 2.0, label: '2.0x (Mais Folgado)' }
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setConfig(prev => ({ ...prev, trailingMultiplier: opt.val }))}
                        className={`py-2 px-2 rounded-lg border text-xs font-semibold transition-all ${
                          config.trailingMultiplier === opt.val
                            ? 'bg-purple-500/20 border-purple-500 text-purple-300 shadow-sm'
                            : 'bg-slate-800/50 border-slate-700/60 text-slate-400 hover:text-white'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Take Profit Target Subsection */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-2">
              <label className="text-xs font-bold text-white block">
                Alvo Principal de Take Profit (TP na Bitunix):
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {[
                  { id: 'TP1', label: '🎯 TP 1', desc: 'Conservador' },
                  { id: 'TP2', label: '🎯 TP 2', desc: 'Moderado' },
                  { id: 'TP3', label: '🎯 TP 3', desc: 'Agressivo' },
                  { id: 'LAST_TP', label: '🎯 Último TP', desc: 'Alvo Final' }
                ].map((tp) => (
                  <button
                    key={tp.id}
                    type="button"
                    onClick={() => setConfig(prev => ({ ...prev, takeProfitSelection: tp.id as any }))}
                    className={`p-2 rounded-xl border text-center transition-all flex flex-col items-center justify-center ${
                      config.takeProfitSelection === tp.id
                        ? 'bg-purple-500/20 border-purple-500 text-purple-300 shadow-sm'
                        : 'bg-slate-800/50 border-slate-700/60 text-slate-400 hover:text-white'
                    }`}
                  >
                    <span className="text-xs font-bold">{tp.label}</span>
                    <span className="text-[10px] text-slate-400 mt-0.5">{tp.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Emergency Stop Loss */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 flex items-center justify-between flex-wrap gap-2">
              <div>
                <span className="text-xs font-bold text-slate-300">Stop Loss de Emergência</span>
                <p className="text-[11px] text-slate-400">Aplicado automaticamente se o sinal vier sem valor de Stop Loss.</p>
              </div>
              <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
                <input
                  type="number"
                  min="0.5"
                  max="10"
                  step="0.5"
                  value={config.emergencyStopPercent}
                  onChange={(e) => setConfig(prev => ({ ...prev, emergencyStopPercent: parseFloat(e.target.value) || 2.0 }))}
                  className="w-12 bg-transparent text-xs text-white font-mono text-center font-bold focus:outline-none"
                />
                <span className="text-xs text-rose-400 font-bold">%</span>
              </div>
            </div>

            {/* Smart Cross Margin Anti-Liquidation */}
            <div className="bg-slate-900/80 border border-emerald-500/30 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold text-white">Margem Cruzada Inteligente (Anti-Liquidação)</span>
                    <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-semibold ${
                      config.autoCrossMarginEnabled !== false 
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-slate-800 text-slate-400'
                    }`}>
                      {config.autoCrossMarginEnabled !== false ? 'Ativado' : 'Desativado'}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-400 mt-0.5">
                    Muda automaticamente para Margem Cruzada se a perda com alavancagem for ≥ {config.autoCrossMarginThreshold || 25}% (ou em alavancagem ≥ 20x), evitando ser liquidado pela Bitunix antes do Stop Loss.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setConfig(prev => ({ ...prev, autoCrossMarginEnabled: prev.autoCrossMarginEnabled === false ? true : false }))}
                  className={`w-12 h-6 flex items-center rounded-full p-1 transition-colors duration-200 cursor-pointer shrink-0 ${
                    config.autoCrossMarginEnabled !== false ? 'bg-emerald-600' : 'bg-slate-700'
                  }`}
                >
                  <div
                    className={`bg-white w-4 h-4 rounded-full shadow-md transform transition-transform duration-200 ${
                      config.autoCrossMarginEnabled !== false ? 'translate-x-6' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              {config.autoCrossMarginEnabled !== false && (
                <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-xs text-slate-400">Gatilho de Ativação (SL Alavancado):</span>
                  <div className="flex items-center gap-1.5 bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
                    <input
                      type="number"
                      min="15"
                      max="95"
                      step="5"
                      value={config.autoCrossMarginThreshold || 25}
                      onChange={(e) => setConfig(prev => ({ ...prev, autoCrossMarginThreshold: parseFloat(e.target.value) || 25 }))}
                      className="w-12 bg-transparent text-xs text-white font-mono text-center font-bold focus:outline-none"
                    />
                    <span className="text-xs text-emerald-400 font-bold">%</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-800 bg-[#141926]">
          <button
            type="button"
            onClick={handleResetDefaults}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restaurar Padrões</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
            >
              Fechar
            </button>
            <button
              type="button"
              onClick={handleSave}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold transition-all shadow-lg ${
                hasSaved
                  ? 'bg-emerald-600 text-white'
                  : 'bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-400 hover:to-blue-500 text-white shadow-sky-500/20 active:scale-95'
              }`}
            >
              {hasSaved ? (
                <>
                  <CheckCircle2 className="w-4 h-4 text-white" />
                  <span>Salvo com Sucesso!</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4 text-sky-200" />
                  <span>Salvar Preferências</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};

export default TelegramBotSettingsModal;
