import React, { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ClipboardPaste,
  Zap,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
  ArrowRight,
  ShieldAlert,
  Play,
  RotateCcw,
  Sparkles,
  RefreshCw,
  Clock,
  ExternalLink,
  Target,
  Sliders,
  Wallet,
  XCircle,
  Copy,
  Info,
  ChevronRight,
  ChevronDown,
  Layers,
  Pencil,
  Key,
  Eye,
  EyeOff,
  Check,
  Settings,
  X,
  Calculator,
  Shield,
  ShieldCheck,
  Lock,
  Edit3,
  PlusCircle,
  Trash2,
  Plus,
  Percent,
  DollarSign,
  Coins,
  FileText,
  User,
  Users,
  Cloud,
  Send,
  Bot,
  Camera,
  Image as ImageIcon,
  Loader2,
  FolderArchive
} from 'lucide-react';
import { parseTradingSignal, ParsedSignal, SAMPLE_SIGNALS, formatVipSignalMessage, calculateFeeViability, FeeViabilityResult } from '../utils/signalParser';
import {
  subscribeToSharedSettings,
  saveSharedSettingsToCloud,
  subscribeToSharedOrders,
  saveOrderToCloud,
  updateOrderInCloud,
  logPartnerActivity,
  subscribeToActivityLogs
} from '../services/cloudSync';
import { SharedSettings, DEFAULT_SHARED_SETTINGS, ActivityLogItem } from '../types/cloudSync';
import SafetyLocksConfigModal from './SafetyLocksConfigModal';
import TelegramBotGuideModal from './TelegramBotGuideModal';
import { TelegramBotSettingsModal } from './TelegramBotSettingsModal';
import { SystemBackupModal } from './SystemBackupModal';
import { TelegramBotConfig, DEFAULT_TELEGRAM_BOT_CONFIG } from '../types/cloudSync';

export interface SignalOrderLog {
  id: string;
  symbol: string;
  apiSymbol: string;
  direction: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  entryPrice: string;
  leverage: number;
  margin: number;
  positionValue: number;
  stopLoss: number | null;
  takeProfits: number[];
  trailingStop?: {
    enabled: boolean;
    mode?: 'TARGET_STEP' | 'MATCH_SL' | 'CUSTOM';
    multiplier?: number; // Multiplicador do Stop Loss (ex: 1.0 = 1:1, 0.5 = 0.5x SL, 2.0 = 2x SL)
    targetPreset?: 'TARGET_2_ENTRY_THEN_PREV' | 'TARGET_1_ENTRY_THEN_PREV' | 'LOCK_BE_ONLY' | 'STEP_BY_STEP' | 'CUSTOM';
    breakEvenTarget?: number; // 0 = desativado, 1 = TP1, 2 = TP2, 3 = TP3...
    stepDistance?: number;    // 1 = 1 alvo atrás, 2 = 2 alvos atrás
    stepFrequency?: number;   // 1 = a cada 1 alvo, 2 = a cada 2 alvos, 0 = apenas travar no BE
    callbackRate?: number;    // e.g. 0.33 (%)
    activationPrice?: number | null;
    currentDynamicSL?: number | null;
    lastReachedTargetIdx?: number; // -1 if none, 0 TP1, 1 TP2, 2 TP3...
    currentStepDesc?: string;
  };
  status: 'PENDING' | 'EXECUTED' | 'FAILED' | 'CLOSED';
  executedAt: string;
  orderIdBinX?: string;
  trailingOrderIdBinX?: string;
  pnlCash?: number;
  pnlPercent?: number;
  errorMessage?: string;
  mode: 'api_real' | 'simulation';
  accountType: 'USDT' | 'VST';
  operator?: string;
  syncedAt?: string;
}

export interface SavedBitunixAccountItem {
  id: string;
  label: string;
  apiKey: string;
  apiKeyMasked: string;
  apiSecretMasked: string;
  accountType: 'USDT' | 'VST';
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface SignalTraderProps {
  apiKey: string;
  setApiKey?: (val: string) => void;
  apiSecret: string;
  setApiSecret?: (val: string) => void;
  executionMode: 'simulation' | 'api_real';
  setExecutionMode?: (mode: 'simulation' | 'api_real') => void;
  accountType: 'USDT' | 'VST';
  setAccountType?: (type: 'USDT' | 'VST') => void;
  initialBalance: number;
  setInitialBalance?: (val: number | ((prev: number) => number)) => void;
  onSyncBalance: (overrideType?: 'USDT' | 'VST') => Promise<void>;
  addLog: (msg: string, type?: 'info' | 'success' | 'error' | 'warning') => void;
  onSelectSymbolForChart: (symbol: string) => void;
  onOpenCopyTrade?: () => void;
  onOpenBackupModal?: () => void;
  savedAccounts?: SavedBitunixAccountItem[];
  activeAccountId?: string;
  activeAccountLabel?: string;
  isSwitchingAccount?: boolean;
  onSwitchSavedAccount?: (accountId: string) => Promise<void>;
  onRefreshCredentials?: () => Promise<void>;
}

export function calculateTargetTrailingSL(
  reachedIdx: number, // 0 for TP1, 1 for TP2, 2 for TP3...
  tps: (number | string)[],
  entryPrice: number | null,
  initialSL: number | null,
  beTarget: number = 2, // 1 = TP1, 2 = TP2 (default), 3 = TP3, 0 = Desativado
  stepDist: number = 1, // 1 = 1 alvo atrás (TP N-1), 2 = 2 alvos atrás (TP N-2)
  stepFreq: number = 1  // 1 = a cada 1 alvo, 2 = a cada 2 alvos, 0 = apenas travar no 0x0
) {
  const targetNum = reachedIdx + 1;
  const parsedTPs = tps.map(t => (typeof t === 'string' ? parseFloat(t) : t)).filter(t => !isNaN(t));

  // If before BreakEven target
  if (beTarget > 0 && targetNum < beTarget) {
    return {
      newSL: initialSL,
      label: initialSL ? `SL Inicial ($${initialSL})` : 'SL Inicial',
      actionDesc: 'Mantém SL Inicial',
      isHighlight: false,
      isBreakEven: false
    };
  }

  // Exactly at BreakEven target
  if (beTarget > 0 && targetNum === beTarget) {
    return {
      newSL: entryPrice,
      label: entryPrice ? `Preço de Entrada ($${entryPrice})` : 'Preço de Entrada (0x0)',
      actionDesc: 'Move Stop p/ ENTRADA (0x0 / Break-Even)',
      isHighlight: true,
      isBreakEven: true
    };
  }

  // Targets reached after BreakEven
  if (beTarget > 0 && targetNum > beTarget) {
    if (stepFreq === 0) {
      return {
        newSL: entryPrice,
        label: entryPrice ? `Preço de Entrada ($${entryPrice})` : 'Preço de Entrada (0x0)',
        actionDesc: 'Mantém no 0x0 (Break-Even Travado)',
        isHighlight: true,
        isBreakEven: true
      };
    }

    const diff = targetNum - beTarget;
    const multiplier = Math.floor(diff / (stepFreq > 0 ? stepFreq : 1));
    const effectiveTargetAdvanced = beTarget + (multiplier * (stepFreq > 0 ? stepFreq : 1));
    const targetToProtect = effectiveTargetAdvanced - stepDist;
    const destTpIndex = targetToProtect - 1; // 0-based

    if (destTpIndex >= 0 && destTpIndex < parsedTPs.length) {
      const destPrice = parsedTPs[destTpIndex];
      return {
        newSL: destPrice,
        label: `Alvo ${destTpIndex + 1} (TP${destTpIndex + 1}: $${destPrice})`,
        actionDesc: `Move Stop p/ Alvo ${destTpIndex + 1} (TP${destTpIndex + 1})`,
        isHighlight: true,
        isBreakEven: false
      };
    } else {
      return {
        newSL: entryPrice,
        label: entryPrice ? `Preço de Entrada ($${entryPrice})` : 'Preço de Entrada (0x0)',
        actionDesc: 'Move Stop p/ ENTRADA (0x0 / Break-Even)',
        isHighlight: true,
        isBreakEven: true
      };
    }
  }

  // If BreakEven is disabled (beTarget === 0) -> pure step by step
  if (beTarget === 0) {
    const targetToProtect = targetNum - stepDist;
    const destTpIndex = targetToProtect - 1;

    if (destTpIndex >= 0 && destTpIndex < parsedTPs.length) {
      const destPrice = parsedTPs[destTpIndex];
      return {
        newSL: destPrice,
        label: `Alvo ${destTpIndex + 1} (TP${destTpIndex + 1}: $${destPrice})`,
        actionDesc: `Move Stop p/ Alvo ${destTpIndex + 1} (TP${destTpIndex + 1})`,
        isHighlight: true,
        isBreakEven: false
      };
    } else {
      return {
        newSL: initialSL,
        label: initialSL ? `SL Inicial ($${initialSL})` : 'SL Inicial',
        actionDesc: 'Mantém SL Inicial',
        isHighlight: false,
        isBreakEven: false
      };
    }
  }

  return {
    newSL: initialSL,
    label: initialSL ? `SL Inicial ($${initialSL})` : 'SL Inicial',
    actionDesc: 'Mantém SL Inicial',
    isHighlight: false,
    isBreakEven: false
  };
}

export default function SignalTrader({
  apiKey,
  setApiKey,
  apiSecret,
  setApiSecret,
  executionMode,
  setExecutionMode,
  accountType,
  setAccountType,
  initialBalance,
  setInitialBalance,
  onSyncBalance,
  addLog,
  onSelectSymbolForChart,
  onOpenCopyTrade,
  onOpenBackupModal,
  savedAccounts = [],
  activeAccountId,
  activeAccountLabel,
  isSwitchingAccount = false,
  onSwitchSavedAccount,
  onRefreshCredentials
}: SignalTraderProps) {
  const [inputText, setInputText] = useState('');
  const [inputMode, setInputMode] = useState<'paste' | 'manual'>('paste');
  const [parsed, setParsed] = useState<ParsedSignal | null>(null);
  const [isLoadingPrice, setIsLoadingPrice] = useState<boolean>(false);
  const [manualTpInputText, setManualTpInputText] = useState<string>('');
  const [internalBackupModalOpen, setInternalBackupModalOpen] = useState(false);

  // Balance sync & edit state
  const [isSyncingBalance, setIsSyncingBalance] = useState(false);
  const [isEditingBalance, setIsEditingBalance] = useState(false);
  const [tempBalanceInput, setTempBalanceInput] = useState(initialBalance.toString());

  // API Keys & Saved Account Switcher state
  const [showApiConfig, setShowApiConfig] = useState<boolean>(false);
  const [showSecret, setShowSecret] = useState<boolean>(false);
  const [showAccountDropdown, setShowAccountDropdown] = useState<boolean>(false);
  const [showAddAccountForm, setShowAddAccountForm] = useState<boolean>(false);
  const [newAccountLabel, setNewAccountLabel] = useState<string>('');
  const [newAccountKey, setNewAccountKey] = useState<string>('');
  const [newAccountSecret, setNewAccountSecret] = useState<string>('');
  const [isSavingNewAccount, setIsSavingNewAccount] = useState<boolean>(false);
  const [localSavedAccounts, setLocalSavedAccounts] = useState<SavedBitunixAccountItem[]>([]);
  const desktopSwitcherRef = React.useRef<HTMLDivElement>(null);
  const mobileSwitcherRef = React.useRef<HTMLDivElement>(null);

  const effectiveSavedAccounts = savedAccounts.length > 0 ? savedAccounts : localSavedAccounts;
  const currentActiveAccount = useMemo(() => {
    return effectiveSavedAccounts.find(a => a.id === activeAccountId || a.isActive) ||
           effectiveSavedAccounts.find(a => apiKey && a.apiKey === apiKey.trim()) ||
           effectiveSavedAccounts[0];
  }, [effectiveSavedAccounts, activeAccountId, apiKey]);
  const displayAccountName = currentActiveAccount?.label || activeAccountLabel || 'Bitunix Futuros USDT';
  const displayMaskedKey = currentActiveAccount?.apiKeyMasked || (apiKey ? `${apiKey.slice(0, 4)}••${apiKey.slice(-4)}` : '');

  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        desktopSwitcherRef.current && !desktopSwitcherRef.current.contains(target) &&
        mobileSwitcherRef.current && !mobileSwitcherRef.current.contains(target)
      ) {
        setShowAccountDropdown(false);
      }
    };
    if (showAccountDropdown) {
      document.addEventListener('mousedown', handleOutsideClick);
    }
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [showAccountDropdown]);

  // Fine-tuning states for the current parsed signal
  const [isAnalyzingImage, setIsAnalyzingImage] = useState<boolean>(false);
  const [imageAnalysisError, setImageAnalysisError] = useState<string | null>(null);
  const [copiedVip, setCopiedVip] = useState<boolean>(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const handleChartImageUpload = async (file: File) => {
    if (!file || !file.type.startsWith('image/')) {
      alert('Por favor, selecione uma imagem válida (PNG ou JPEG).');
      return;
    }
    setIsAnalyzingImage(true);
    setImageAnalysisError(null);
    try {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64Data = (reader.result as string) || '';
          const response = await fetch('/api/parse-chart-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageBase64: base64Data,
              mimeType: file.type
            })
          });
          const data = await response.json();
          if (data.success && data.parsed) {
            const p = data.parsed;
            const vipText = data.vipFormattedMessage || formatVipSignalMessage(p);
            setInputText(vipText);
            setCustomSymbol(p.apiSymbol);
            setCustomDirection(p.direction);
            setCustomOrderType('LIMIT');
            setCustomEntryPrice(p.entryPrice.toString());
            setCustomSL(p.stopLoss.toString());
            setCustomTPs(p.takeProfits.map((tp: number) => tp.toString()));
            setCustomLeverage(p.leverage);
            addLog?.(`📸 Gráfico analisado por IA: ${p.apiSymbol} ${p.direction} (Entrada: ${p.entryPrice}, SL: ${p.stopLoss}, ${p.takeProfits?.length || 1} Alvos)`, 'info');
          } else {
            setImageAnalysisError(data.error || 'Não foi possível extrair parâmetros deste gráfico.');
          }
        } catch (err: any) {
          setImageAnalysisError(err?.message || 'Erro ao conectar ao serviço de visão.');
        } finally {
          setIsAnalyzingImage(false);
        }
      };
      reader.readAsDataURL(file);
    } catch (e: any) {
      setImageAnalysisError(e.message);
      setIsAnalyzingImage(false);
    }
  };
  const [customMargin, setCustomMargin] = useState<number>(20); // USD
  const [marginType, setMarginType] = useState<'USD' | 'PERCENT' | 'RISK_USD' | 'RISK_PERCENT'>('RISK_USD');
  const [customMarginPercent, setCustomMarginPercent] = useState<number>(5); // %
  const [customRiskUSD, setCustomRiskUSD] = useState<number>(50); // $ Perda máxima financeira se bater no Stop Loss
  const [customRiskPercent, setCustomRiskPercent] = useState<number>(2); // % Perda máxima financeira da conta se bater no Stop Loss
  const [includeFeesInRisk, setIncludeFeesInRisk] = useState<boolean>(true); // Considerar taxas de trading (entrada + saída no SL)
  const [tradingFeeRate, setTradingFeeRate] = useState<number>(0.05); // % taxa por perna (0.05% padrão perpétuos Bitunix)
  const [customLeverage, setCustomLeverage] = useState<number>(10);
  const [customEntryPrice, setCustomEntryPrice] = useState<string>('');
  const [entryRangeChoice, setEntryRangeChoice] = useState<'FIRST' | 'AVERAGE' | 'SECOND' | 'CUSTOM'>('FIRST');
  const [customOrderType, setCustomOrderType] = useState<'MARKET' | 'LIMIT'>('MARKET');
  const [customDirection, setCustomDirection] = useState<'LONG' | 'SHORT'>('LONG');
  const [customSymbol, setCustomSymbol] = useState<string>('');
  const [customSL, setCustomSL] = useState<string>('');
  const [customTPs, setCustomTPs] = useState<string[]>([]);
  const [selectedTpIndex, setSelectedTpIndex] = useState<number | null>(null);

  // Cálculo de Viabilidade e Armadilha de Taxas
  const feeViability = useMemo<FeeViabilityResult | null>(() => {
    const entry = parseFloat(customEntryPrice) || (parsed?.entryPrice ? parsed.entryPrice : 0);
    const tps = customTPs
      .map(t => parseFloat(t.replace(',', '.')))
      .filter(t => !isNaN(t) && t > 0);

    if (entry > 0 && tps.length > 0) {
      return calculateFeeViability(entry, tps, customDirection, (tradingFeeRate * 2) || 0.10);
    }
    return null;
  }, [customEntryPrice, parsed?.entryPrice, customTPs, customDirection, tradingFeeRate]);

  const handleDiscardSignal = () => {
    setInputText('');
    setParsed(null);
    setCustomSymbol('');
    setCustomEntryPrice('');
    setCustomSL('');
    setCustomTPs([]);
    setSelectedTpIndex(null);
    addLog('[SISTEMA] Sinal descartado com sucesso (Armadilha de Taxas evitada).', 'warning');
  };

  // Trailing Stop (Stop Móvel) states - Ativado por padrão com modo Igual SL
  const [useTrailingStop, setUseTrailingStop] = useState<boolean>(true);
  const [trailingMode, setTrailingMode] = useState<'MATCH_SL' | 'CUSTOM'>('MATCH_SL');
  const [trailingMultiplier, setTrailingMultiplier] = useState<number>(1.0); // Multiplicador de vezes do SL (1.0x = 1:1, 0.5x = 50%, 2.0x = 2x, etc.)
  const [customTrailingMultiplier, setCustomTrailingMultiplier] = useState<string>('1.0');
  const [trailingCallbackRate, setTrailingCallbackRate] = useState<number>(1.0); // % de recuo manual (Callback Rate)
  const [trailingActivationPrice, setTrailingActivationPrice] = useState<string>(''); // Preço de ativação opcional
  const [activationMultiplierChoice, setActivationMultiplierChoice] = useState<number | 'IMMEDIATE' | 'CUSTOM'>(1.0);

  // Cloud Sync & Safety Locks states
  const [sharedSettings, setSharedSettings] = useState<SharedSettings>(DEFAULT_SHARED_SETTINGS);
  const [telegramBotConfig, setTelegramBotConfig] = useState<TelegramBotConfig>(DEFAULT_TELEGRAM_BOT_CONFIG);
  
  const safeTgConfig = useMemo<TelegramBotConfig>(() => {
    return {
      ...DEFAULT_TELEGRAM_BOT_CONFIG,
      ...(telegramBotConfig || {})
    };
  }, [telegramBotConfig]);

  const [isSafetyModalOpen, setIsSafetyModalOpen] = useState<boolean>(false);
  const [isTelegramGuideOpen, setIsTelegramGuideOpen] = useState<boolean>(false);
  const [isTelegramSettingsOpen, setIsTelegramSettingsOpen] = useState<boolean>(false);
  const [isCloudConnected, setIsCloudConnected] = useState<boolean>(true);
  const [activeOperator, setActiveOperator] = useState<string>(() => {
    try {
      return localStorage.getItem('signal_active_operator') || 'Bruno';
    } catch {
      return 'Bruno';
    }
  });
  const [activityLogs, setActivityLogs] = useState<ActivityLogItem[]>([]);

  // Credentials & Telegram Bot Token & Gemini Key for API Modal
  const [apiTelegramToken, setApiTelegramToken] = useState<string>('');
  const [showTelegramTokenInApiModal, setShowTelegramTokenInApiModal] = useState<boolean>(false);
  const [geminiApiKey, setGeminiApiKey] = useState<string>('');
  const [showGeminiKeyInApiModal, setShowGeminiKeyInApiModal] = useState<boolean>(false);

  useEffect(() => {
    if (showApiConfig) {
      fetch('/api/credentials')
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            if (d.telegramToken) setApiTelegramToken(d.telegramToken);
            if (d.geminiApiKey) setGeminiApiKey(d.geminiApiKey);
            if (d.apiKey && !apiKey && setApiKey) setApiKey(d.apiKey);
            if (d.apiSecret && !apiSecret && setApiSecret) setApiSecret(d.apiSecret);
            if (Array.isArray(d.savedAccounts)) setLocalSavedAccounts(d.savedAccounts);
          }
        })
        .catch(() => {});
    }
  }, [showApiConfig]);

  // Execution state
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionStep, setExecutionStep] = useState<string>('');
  const [history, setHistory] = useState<SignalOrderLog[]>(() => {
    try {
      const saved = localStorage.getItem('signal_trader_history');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  const [selectedHistoryItem, setSelectedHistoryItem] = useState<SignalOrderLog | null>(null);

  // Live Positions from Bitunix state & management
  const [liveBitunixPositions, setLiveBitunixPositions] = useState<any[]>([]);
  const [isLoadingLivePositions, setIsLoadingLivePositions] = useState<boolean>(false);
  const [positionsTab, setPositionsTab] = useState<'LIVE' | 'HISTORY'>('LIVE');
  const [editingPosition, setEditingPosition] = useState<any | null>(null);
  const [editSLInput, setEditSLInput] = useState<string>('');
  const [editTPInput, setEditTPInput] = useState<string>('');
  const [isSubmittingEdit, setIsSubmittingEdit] = useState<boolean>(false);

  // Calculate today's closed losses to enforce Daily Stop Loss
  const todayLossUsd = useMemo(() => {
    return history
      .filter(h => h.status === 'CLOSED' && (h.pnlCash || 0) < 0)
      .reduce((sum, h) => sum + Math.abs(h.pnlCash || 0), 0);
  }, [history]);

  // Realtime Cloud Subscriptions (Settings, Orders, Activity)
  useEffect(() => {
    const unsubSettings = subscribeToSharedSettings((cloudSet) => {
      setSharedSettings(cloudSet);
      setIsCloudConnected(true);
      if (cloudSet.maxRiskPerTradeUsd) setCustomRiskUSD(cloudSet.maxRiskPerTradeUsd);
      if (cloudSet.maxRiskPercent) setCustomRiskPercent(cloudSet.maxRiskPercent);
      if (cloudSet.telegramBotConfig?.riskFixedUsd) setCustomRiskUSD(cloudSet.telegramBotConfig.riskFixedUsd);
      if (cloudSet.telegramBotConfig?.riskMode === 'FIXED_USD' || cloudSet.riskCalculationMode === 'USD') {
        setMarginType('RISK_USD');
      } else if (cloudSet.telegramBotConfig?.riskMode === 'PERCENT' || cloudSet.riskCalculationMode === 'PERCENT') {
        setMarginType('RISK_PERCENT');
      }
      if (cloudSet.accountType && setAccountType && cloudSet.accountType !== accountType) {
        setAccountType(cloudSet.accountType);
      }
      if (cloudSet.executionMode && setExecutionMode && cloudSet.executionMode !== executionMode) {
        setExecutionMode(cloudSet.executionMode);
      }
      if (cloudSet.telegramBotConfig) {
        setTelegramBotConfig(prev => ({
          ...prev,
          ...cloudSet.telegramBotConfig
        }));
      }
    });

    const unsubOrders = subscribeToSharedOrders((cloudOrders) => {
      if (cloudOrders && cloudOrders.length > 0) {
        setHistory(cloudOrders);
      }
    });

    const unsubLogs = subscribeToActivityLogs((logs) => {
      setActivityLogs(logs);
    });

    return () => {
      unsubSettings();
      unsubOrders();
      unsubLogs();
    };
  }, []);

  // Telegram Bot Incoming Signals Live Poller
  const [telegramSignals, setTelegramSignals] = useState<Array<{ id: string; text: string; sender: string; receivedAt: string }>>([]);

  useEffect(() => {
    let isMounted = true;
    const fetchTelegramSignals = async () => {
      try {
        const res = await fetch('/api/telegram-signals');
        if (res.ok) {
          const data = await res.json();
          if (isMounted && data.signals) {
            setTelegramSignals(data.signals);
          }
        }
      } catch {}
    };

    fetchTelegramSignals();
    const interval = setInterval(fetchTelegramSignals, 3500);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  const handleSwitchOperator = (name: string) => {
    setActiveOperator(name);
    try {
      localStorage.setItem('signal_active_operator', name);
    } catch {}
    saveSharedSettingsToCloud({ activeOperator: name }, name);
    logPartnerActivity(name, 'Troca de Turno', `Operador ativo alterado para ${name}`, 'info');
    addLog(`[TURNO] Operador ativo agora é: ${name}`, 'info');
  };

  const handleSaveSafetySettings = async (newSettings: Partial<SharedSettings>) => {
    setSharedSettings(prev => ({ ...prev, ...newSettings }));
    if (newSettings.maxRiskPerTradeUsd) setCustomRiskUSD(newSettings.maxRiskPerTradeUsd);
    if (newSettings.maxRiskPercent) setCustomRiskPercent(newSettings.maxRiskPercent);
    await saveSharedSettingsToCloud(newSettings, activeOperator);
    logPartnerActivity(activeOperator, 'Atualizou Travas de Segurança', `Risco Máx: $${newSettings.maxRiskPerTradeUsd || sharedSettings.maxRiskPerTradeUsd} | Alav: ${newSettings.maxLeverageCap || sharedSettings.maxLeverageCap}x`, 'info');
    addLog(`[TRAVAS] Travas de segurança e gestão de risco sincronizadas na nuvem com o sócio!`, 'success');
  };

  const handleSaveTelegramBotConfig = async (newConfig: TelegramBotConfig) => {
    setTelegramBotConfig(newConfig);
    setSharedSettings(prev => ({ ...prev, telegramBotConfig: newConfig }));
    await saveSharedSettingsToCloud({ telegramBotConfig: newConfig }, activeOperator);
    try {
      await fetch('/api/telegram-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newConfig)
      });
    } catch {}
    logPartnerActivity(activeOperator, 'Configurou Bot Telegram', `Risco: ${newConfig.riskMode === 'PERCENT' ? `${newConfig.riskPercent}%` : `$${newConfig.riskFixedUsd}`} | Trailing: ${newConfig.trailingMultiplier}x`, 'info');
    addLog(`[BOT TELEGRAM] Configurações de risco e execução do bot salvas e sincronizadas!`, 'success');
  };

  // Carrega configurações do Bot Telegram do servidor
  useEffect(() => {
    fetch('/api/telegram-config')
      .then(res => res.json())
      .then(data => {
        if (data.ok && data.config) {
          setTelegramBotConfig(data.config);
        }
      })
      .catch(() => {});
  }, []);

  // Busca posições abertas na Bitunix ao vivo
  const fetchLiveBitunixPositions = React.useCallback(async (showLoader = false) => {
    if (showLoader) setIsLoadingLivePositions(true);
    try {
      const res = await fetch(`/api/open-positions?accountType=${accountType}&apiKey=${encodeURIComponent(apiKey || '')}&apiSecret=${encodeURIComponent(apiSecret || '')}`);
      const data = await res.json();
      if (data.success && Array.isArray(data.positions)) {
        setLiveBitunixPositions(data.positions);
      }
    } catch (e) {
      console.error('Erro ao sincronizar posições abertas da Bitunix:', e);
    } finally {
      if (showLoader) setIsLoadingLivePositions(false);
    }
  }, [accountType, apiKey, apiSecret]);

  // Polling automático a cada 6 segundos para posições ao vivo
  useEffect(() => {
    fetchLiveBitunixPositions(true);
    const interval = setInterval(() => {
      fetchLiveBitunixPositions(false);
    }, 6000);
    return () => clearInterval(interval);
  }, [fetchLiveBitunixPositions]);

  // Fechar posição ao vivo a mercado
  const handleCloseLivePosition = async (pos: any) => {
    const symbolClean = pos.symbol.replace('-USDT', '').replace('USDT', '');
    if (!window.confirm(`Tem certeza que deseja fechar a mercado a posição em ${symbolClean} (${pos.positionSide})?`)) {
      return;
    }
    addLog(`[BITUNIX] Fechando a mercado posição em ${pos.symbol}...`, 'info');
    try {
      const res = await fetch('/api/close-position', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: pos.symbol,
          positionSide: pos.positionSide,
          accountType,
          apiKey,
          apiSecret
        })
      });
      const data = await res.json();
      if (data.success) {
        addLog(`[BITUNIX] Posição em ${pos.symbol} fechada a mercado com sucesso!`, 'success');
        logPartnerActivity(activeOperator, 'Fechou Posição a Mercado', `${pos.symbol} (${pos.positionSide})`, 'warning');
        fetchLiveBitunixPositions(true);
        onSyncBalance();
      } else {
        addLog(`[BITUNIX-ERRO] Falha ao fechar posição: ${data.error || 'Erro desconhecido'}`, 'error');
      }
    } catch (e: any) {
      addLog(`[BITUNIX-ERRO] Erro de comunicação: ${e.message}`, 'error');
    }
  };

  // Mover Stop Loss para Breakeven (0 a 0)
  const handleSetBreakevenLive = async (pos: any) => {
    addLog(`[BITUNIX] Movendo Stop Loss de ${pos.symbol} para o Preço de Entrada (0x0 / Breakeven)...`, 'info');
    try {
      const res = await fetch('/api/set-breakeven', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: pos.symbol,
          positionSide: pos.positionSide,
          accountType,
          apiKey,
          apiSecret
        })
      });
      const data = await res.json();
      if (data.success) {
        addLog(`[BITUNIX] Stop Loss em ${pos.symbol} movido para $${data.entryPrice} (Breakeven 0x0)!`, 'success');
        logPartnerActivity(activeOperator, 'Definiu Breakeven (0x0)', `${pos.symbol} @ $${data.entryPrice}`, 'info');
        fetchLiveBitunixPositions(true);
      } else {
        addLog(`[BITUNIX-ERRO] Falha ao mover para Breakeven: ${data.error || 'Erro desconhecido'}`, 'error');
      }
    } catch (e: any) {
      addLog(`[BITUNIX-ERRO] Erro ao mover Breakeven: ${e.message}`, 'error');
    }
  };

  // Abrir modal de edição de SL/TP para uma posição
  const handleOpenEditPositionModal = (pos: any) => {
    setEditingPosition(pos);
    setEditSLInput(pos.stopLoss ? pos.stopLoss.toString() : '');
    setEditTPInput(pos.takeProfit ? pos.takeProfit.toString() : '');
  };

  // Salvar novo SL e TP na Bitunix
  const handleSaveEditedSLTP = async () => {
    if (!editingPosition) return;
    setIsSubmittingEdit(true);
    addLog(`[BITUNIX] Atualizando SL/TP para ${editingPosition.symbol}...`, 'info');
    try {
      const res = await fetch('/api/update-sltp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: editingPosition.symbol,
          positionSide: editingPosition.positionSide,
          newStopLoss: editSLInput ? parseFloat(editSLInput) : null,
          newTakeProfit: editTPInput ? parseFloat(editTPInput) : null,
          accountType,
          apiKey,
          apiSecret
        })
      });
      const data = await res.json();
      if (data.success) {
        if (data.recalculatedMargin && data.riskUsd) {
          addLog(`[BITUNIX] Nova ordem criada com Take, Stop e Trailing Stop para ${editingPosition.symbol}! Margem: $${data.recalculatedMargin} USDT | Risco: -$${data.riskUsd} USDT (${data.effectiveRiskPct || '2.0'}%)`, 'success');
        } else {
          addLog(`[BITUNIX] SL/TP atualizados com sucesso para ${editingPosition.symbol}!`, 'success');
        }
        logPartnerActivity(activeOperator, 'Editou SL/TP', `${editingPosition.symbol} | SL: ${editSLInput || 'Nenhum'} | TP: ${editTPInput || 'Nenhum'}`, 'info');
        setEditingPosition(null);
        fetchLiveBitunixPositions(true);
      } else {
        addLog(`[BITUNIX-ERRO] Falha ao atualizar SL/TP: ${data.error || 'Erro desconhecido'}`, 'error');
      }
    } catch (e: any) {
      addLog(`[BITUNIX-ERRO] Erro ao atualizar SL/TP: ${e.message}`, 'error');
    } finally {
      setIsSubmittingEdit(false);
    }
  };

  // Detect if signal or user has a range of entry prices (e.g. 605.60 - 605.15)
  const detectedEntryRange = useMemo(() => {
    if (parsed?.entryRange) {
      return parsed.entryRange;
    }
    if (parsed?.entryPrices && parsed.entryPrices.length >= 2) {
      const p1 = parsed.entryPrices[0];
      const p2 = parsed.entryPrices[1];
      const avg = (p1 + p2) / 2;
      const decimals = avg < 1 ? 6 : avg < 100 ? 4 : 2;
      return {
        first: p1,
        second: p2,
        average: parseFloat(avg.toFixed(decimals))
      };
    }
    if (customEntryPrice) {
      const numbers = customEntryPrice.replace(/,/g, '.').match(/\d+\.?\d*/g);
      if (numbers && numbers.length >= 2) {
        const p1 = parseFloat(numbers[0]);
        const p2 = parseFloat(numbers[1]);
        if (!isNaN(p1) && !isNaN(p2) && p1 > 0 && p2 > 0) {
          const avg = (p1 + p2) / 2;
          const decimals = avg < 1 ? 6 : avg < 100 ? 4 : 2;
          return {
            first: p1,
            second: p2,
            average: parseFloat(avg.toFixed(decimals))
          };
        }
      }
    }
    return null;
  }, [parsed, customEntryPrice]);

  const handleSelectEntryPriceOption = (choice: 'FIRST' | 'AVERAGE' | 'SECOND') => {
    if (!detectedEntryRange) return;
    setEntryRangeChoice(choice);
    setCustomOrderType('LIMIT');
    let newEntry = '';
    if (choice === 'FIRST') {
      newEntry = detectedEntryRange.first.toString();
    } else if (choice === 'AVERAGE') {
      newEntry = detectedEntryRange.average.toString();
    } else if (choice === 'SECOND') {
      newEntry = detectedEntryRange.second.toString();
    }
    setCustomEntryPrice(newEntry);

    // Se o multiplicador de ativação estiver ativo, recalcula o preço de ativação automaticamente
    if (typeof activationMultiplierChoice === 'number') {
      const ent = parseFloat(newEntry);
      const slVal = parseFloat(customSL);
      if (ent > 0 && slVal > 0) {
        const dist = Math.abs(ent - slVal);
        const dir = parsed?.direction || customDirection || 'LONG';
        const target = dir === 'LONG' ? ent + (dist * activationMultiplierChoice) : ent - (dist * activationMultiplierChoice);
        const decimals = newEntry.includes('.') ? newEntry.split('.')[1].length : (ent < 1 ? 6 : ent < 100 ? 4 : 2);
        setTrailingActivationPrice(target.toFixed(Math.max(decimals, 2)));
      }
    }
  };

  const getActivationPriceForMult = (mult: number): number | null => {
    const entry = parseFloat(customEntryPrice) || (parsed?.entryPrice ? parsed.entryPrice : 0);
    const sl = parseFloat(customSL) || (parsed?.stopLoss ? parsed.stopLoss : 0);
    if (!entry || !sl || isNaN(entry) || isNaN(sl) || entry <= 0 || sl <= 0) return null;
    const dist = Math.abs(entry - sl);
    const dir = parsed?.direction || customDirection || 'LONG';
    const target = dir === 'LONG' ? entry + (dist * mult) : entry - (dist * mult);
    const decimals = entry.toString().includes('.') ? entry.toString().split('.')[1].length : (entry < 1 ? 6 : entry < 100 ? 4 : 2);
    return parseFloat(target.toFixed(Math.max(decimals, 2)));
  };

  useEffect(() => {
    try {
      localStorage.setItem('signal_trader_history', JSON.stringify(history));
    } catch (e) {
      console.error('Error saving signal history:', e);
    }
  }, [history]);

  const handleAccountSwitch = async (type: 'USDT' | 'VST') => {
    if (setAccountType) setAccountType(type);
    setIsSyncingBalance(true);
    try {
      await onSyncBalance(type);
      await saveSharedSettingsToCloud({ accountType: type }, activeOperator);
      fetch('/api/telegram-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountType: type })
      }).catch(() => {});
    } catch (e) {
      // handled
    } finally {
      setIsSyncingBalance(false);
    }
  };

  const handleSyncClick = async () => {
    setIsSyncingBalance(true);
    try {
      await onSyncBalance(accountType);
    } catch (e) {
      // handled
    } finally {
      setIsSyncingBalance(false);
    }
  };

  // Live Market Price Fetcher com resolução de símbolos inteligente
  const handleFetchCurrentPrice = async (targetSymbol?: string) => {
    const sym = targetSymbol || customSymbol || 'BTC';
    setIsLoadingPrice(true);
    try {
      // 1. Resolução do símbolo via backend
      let apiSym = sym.includes('-') ? sym : `${sym.toUpperCase().replace(/[^A-Z0-9]/g, '').replace('USDT', '')}-USDT`;
      let coin = sym;
      try {
        const resolveRes = await fetch(`/api/resolve-symbol?symbol=${encodeURIComponent(sym)}`);
        const resolveData = await resolveRes.json();
        if (resolveData.success && resolveData.apiSymbol) {
          apiSym = resolveData.apiSymbol;
          coin = resolveData.displayName || resolveData.cleanSymbol || sym;
        }
      } catch {}

      let price: number | null = null;
      if (apiKey && apiSecret) {
        const res = await fetch('/api/bitunix-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: '/openApi/swap/v2/quote/ticker',
            method: 'GET',
            params: { symbol: apiSym },
            apiKey: apiKey.trim(),
            apiSecret: apiSecret.trim(),
            isDemo: accountType === 'VST'
          })
        });
        const data = await res.json();
        if (data.code === 0 && data.data) {
          const p = parseFloat(data.data.lastPrice || data.data.price || '0');
          if (p > 0) price = p;
        }
      }

      if (!price) {
        const pubRes = await fetch('/api/bitunix-symbols');
        const pubData = await pubRes.json();
        const cleanNoDash = apiSym.replace('-', '');
        const found = pubData.find((s: any) => 
          s.symbol.replace(/[-:]/g, '') === cleanNoDash || 
          s.name === coin ||
          s.symbol.includes(cleanNoDash)
        );
        if (found && found.price) {
          const p = parseFloat(found.price.replace(/[$,]/g, ''));
          if (p > 0) price = p;
        }
      }

      if (price) {
        setCustomEntryPrice(price.toString());
        addLog(`[MERCADO] Preço atual de ${coin} (${apiSym}): $${price}`, 'success');
      } else {
        addLog(`[MERCADO] Não foi possível obter o preço em tempo real para ${coin} (${apiSym}).`, 'warning');
      }
    } catch (e) {
      console.warn('Erro ao obter preço:', e);
      addLog(`[MERCADO] Erro ao consultar preço de mercado.`, 'warning');
    } finally {
      setIsLoadingPrice(false);
    }
  };

  const handleSelectCoinChip = (coin: string) => {
    const formatted = `${coin}USDT`;
    setCustomSymbol(formatted);
    handleFetchCurrentPrice(formatted);
  };

  const handleAddManualTp = (price?: string) => {
    const val = price !== undefined ? price.trim() : '';
    setCustomTPs(prev => {
      const next = [...prev, val];
      if (selectedTpIndex === null) setSelectedTpIndex(next.length - 1);
      return next;
    });
  };

  const handleRemoveManualTp = (index: number) => {
    setCustomTPs(prev => {
      const next = prev.filter((_, i) => i !== index);
      if (selectedTpIndex !== null) {
        if (selectedTpIndex === index) {
          setSelectedTpIndex(next.length > 0 ? next.length - 1 : null);
        } else if (selectedTpIndex > index) {
          setSelectedTpIndex(selectedTpIndex - 1);
        }
      }
      return next;
    });
  };

  const handleUpdateManualTp = (index: number, val: string) => {
    setCustomTPs(prev => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  const handleApplyQuickSLPercent = (percent: number) => {
    const entry = parseFloat(customEntryPrice);
    if (!entry || isNaN(entry) || entry <= 0) {
      addLog(`[STOP LOSS] Digite um Preço de Entrada primeiro para calcular o Stop Loss automático.`, 'warning');
      return;
    }
    const isLong = customDirection === 'LONG';
    const slPrice = isLong ? entry * (1 - percent / 100) : entry * (1 + percent / 100);
    const decimals = entry < 1 ? 6 : entry < 100 ? 4 : 2;
    const formatted = parseFloat(slPrice.toFixed(decimals)).toString();
    setCustomSL(formatted);
    addLog(`[STOP LOSS] Stop Loss configurado para $${formatted} (${isLong ? '-' : '+'}${percent}%)`, 'info');
  };

  const handleApplyQuickTPPercent = (percent: number) => {
    const entry = parseFloat(customEntryPrice);
    if (!entry || isNaN(entry) || entry <= 0) {
      addLog(`[TAKE PROFIT] Digite um Preço de Entrada primeiro para calcular o Take Profit automático.`, 'warning');
      return;
    }
    const isLong = customDirection === 'LONG';
    const tpPrice = isLong ? entry * (1 + percent / 100) : entry * (1 - percent / 100);
    const decimals = entry < 1 ? 6 : entry < 100 ? 4 : 2;
    const formatted = parseFloat(tpPrice.toFixed(decimals)).toString();
    setCustomTPs([formatted]);
    setSelectedTpIndex(0);
    addLog(`[TAKE PROFIT] Take Profit configurado para $${formatted} (${isLong ? '+' : '-'}${percent}% lucro)`, 'info');
  };

  const handleApplyCommaSeparatedTPs = (text: string) => {
    if (!text.trim()) return;
    const parts = text.split(/[,;\n\s]+/).map(s => s.trim().replace('$', '')).filter(s => /^\d+(\.\d+)?$/.test(s));
    if (parts.length > 0) {
      setCustomTPs(parts);
      setSelectedTpIndex(parts.length - 1);
      setManualTpInputText('');
      addLog(`[TAKE PROFIT] ${parts.length} alvos adicionados via texto rápido.`, 'success');
    }
  };

  const handleClearForm = () => {
    setInputText('');
    setCustomSymbol('');
    setCustomEntryPrice('');
    setCustomSL('');
    setCustomTPs([]);
    setSelectedTpIndex(null);
    setUseTrailingStop(false);
    setTrailingActivationPrice('');
  };

  // Parse whenever input text changes (in paste mode)
  useEffect(() => {
    if (inputMode !== 'paste') return;

    if (!inputText.trim()) {
      setParsed(null);
      setCustomSymbol('');
      setCustomEntryPrice('');
      setCustomSL('');
      setCustomTPs([]);
      setSelectedTpIndex(null);
      setUseTrailingStop(true);
      setTrailingMode('MATCH_SL');
      setTrailingActivationPrice('');
      return;
    }
    const result = parseTradingSignal(inputText);
    setParsed(result);

    // Populate fine-tuning controls
    if (result.isValid) {
      setCustomSymbol(result.symbol);
      setCustomDirection(result.direction);
      
      // Alavancagem: Livre conforme solicitado por Bruno (margem auto-calculada por risco de 2%) ou teto se fixado
      const effectiveLeverage = sharedSettings.allowFreeLeverage
        ? (result.leverage || 20)
        : Math.min(result.leverage || 10, sharedSettings.maxLeverageCap || 20);
      setCustomLeverage(effectiveLeverage);
      if (!sharedSettings.allowFreeLeverage && result.leverage > (sharedSettings.maxLeverageCap || 20)) {
        addLog(`[TRAVA DE RISCO] Alavancagem do sinal (${result.leverage}x) limitada ao teto de ${sharedSettings.maxLeverageCap}x`, 'warning');
      }

      setCustomOrderType(result.orderType);
      let calculatedEntryVal = '';
      if (result.entryRange) {
        const isShort = result.direction === 'SHORT';
        // SHORT -> Menor preço por padrão; LONG -> Maior preço por padrão
        const chosenValue = isShort
          ? Math.min(result.entryRange.first, result.entryRange.second)
          : Math.max(result.entryRange.first, result.entryRange.second);
        const chosenChoice = chosenValue === result.entryRange.first ? 'FIRST' : 'SECOND';

        setEntryRangeChoice(chosenChoice);
        calculatedEntryVal = chosenValue.toString();
        setCustomEntryPrice(calculatedEntryVal);
      } else {
        setEntryRangeChoice('CUSTOM');
        calculatedEntryVal = result.entryPrice ? result.entryPrice.toString() : '';
        setCustomEntryPrice(calculatedEntryVal);
      }

      // Trava de Stop Loss Obrigatório
      let finalSL = result.stopLoss ? result.stopLoss.toString() : '';
      if (!finalSL && sharedSettings.requireStopLoss && calculatedEntryVal) {
        const entNum = parseFloat(calculatedEntryVal);
        if (entNum > 0) {
          const emergencyDist = sharedSettings.emergencyStopPercent || 2.0;
          const isShort = result.direction === 'SHORT';
          const autoSlPrice = isShort ? entNum * (1 + emergencyDist / 100) : entNum * (1 - emergencyDist / 100);
          const decimals = entNum < 1 ? 6 : entNum < 100 ? 4 : 2;
          finalSL = autoSlPrice.toFixed(decimals);
          addLog(`[TRAVA DE RISCO] Stop Loss de Emergência (${emergencyDist}%) aplicado automaticamente ($${finalSL})`, 'info');
        }
      }
      setCustomSL(finalSL);

      // Trava de Risco conforme modo configurado (USD fixo ou %)
      if (sharedSettings.riskCalculationMode === 'USD' && sharedSettings.maxRiskPerTradeUsd) {
        setMarginType('RISK_USD');
      } else if (sharedSettings.maxRiskPercent) {
        setMarginType('RISK_PERCENT');
        setCustomRiskPercent(sharedSettings.maxRiskPercent);
      }

      const parsedTPs = result.takeProfits.map(tp => tp.toString());
      setCustomTPs(parsedTPs);
      setSelectedTpIndex(parsedTPs.length > 0 ? parsedTPs.length - 1 : null);

      // Trava de Trailing Stop 1:1 Travado
      if (sharedSettings.lockTrailingStop1x) {
        setUseTrailingStop(true);
        setTrailingMode('MATCH_SL');
        setTrailingMultiplier(1.0);
      } else if (result.trailingMode && (result.trailingMode === 'MATCH_SL' || result.trailingMode === 'CUSTOM')) {
        setUseTrailingStop(true);
        setTrailingMode(result.trailingMode);
      }
      if (result.trailingCallback) {
        setUseTrailingStop(true);
        setTrailingCallbackRate(result.trailingCallback);
      }
      if (result.trailingActivation) {
        setTrailingActivationPrice(result.trailingActivation.toString());
        setActivationMultiplierChoice('CUSTOM');
      } else {
        let ent = 0;
        if (result.entryRange) {
          ent = result.direction === 'SHORT'
            ? Math.min(result.entryRange.first, result.entryRange.second)
            : Math.max(result.entryRange.first, result.entryRange.second);
        } else {
          ent = result.entryPrice || 0;
        }
        const slVal = result.stopLoss || 0;
        if (ent > 0 && slVal > 0) {
          const dist = Math.abs(ent - slVal);
          const dir = result.direction || 'LONG';
          const target = dir === 'LONG' ? ent + dist : ent - dist;
          const decimals = ent.toString().includes('.') ? ent.toString().split('.')[1].length : (ent < 1 ? 6 : ent < 100 ? 4 : 2);
          setTrailingActivationPrice(target.toFixed(Math.max(decimals, 2)));
        } else {
          setTrailingActivationPrice('');
        }
        setActivationMultiplierChoice(1.0);
      }
    }
  }, [inputText, inputMode]);

  // Live Monitor for Target-based Trailing Stops
  useEffect(() => {
    const activeOrders = history.filter(h => h.status === 'EXECUTED' && h.trailingStop?.enabled && h.trailingStop.mode === 'TARGET_STEP');
    if (activeOrders.length === 0) return;

    const interval = setInterval(async () => {
      for (const order of activeOrders) {
        try {
          let currentPrice = 0;
          const isVST = (order.accountType || accountType) === 'VST';

          if (order.mode === 'api_real' && apiKey && apiSecret) {
            const tickerRes = await fetch('/api/bitunix-proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: '/openApi/swap/v2/quote/ticker',
                method: 'GET',
                params: { symbol: order.apiSymbol },
                apiKey: apiKey.trim(),
                apiSecret: apiSecret.trim(),
                isDemo: isVST
              })
            });
            const tickerData = await tickerRes.json();
            if (tickerData.code === 0 && tickerData.data) {
              currentPrice = parseFloat(tickerData.data.lastPrice || tickerData.data.price || '0');
            }
          }

          // Fallback to public symbols price if needed or in simulation
          if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) {
            try {
              const pubRes = await fetch('/api/bitunix-symbols');
              const pubData = await pubRes.json();
              const found = pubData.find((s: any) => s.symbol.replace(/[-:]/g, '') === order.symbol.replace(/[-:]/g, ''));
              if (found && found.price) {
                currentPrice = parseFloat(found.price.replace(/[$,]/g, ''));
              }
            } catch (e) {
              // fallback
            }
          }

          if (!currentPrice || isNaN(currentPrice) || currentPrice <= 0) continue;

          const isLong = order.direction === 'LONG';
          const entryPrice = parseFloat(order.entryPrice) || 0;
          const currentSL = order.trailingStop?.currentDynamicSL ?? order.stopLoss;
          const lastHitIdx = order.trailingStop?.lastReachedTargetIdx ?? -1;
          const beTarget = order.trailingStop?.breakEvenTarget ?? 2;
          const stepDist = order.trailingStop?.stepDistance ?? 1;
          const stepFreq = order.trailingStop?.stepFrequency ?? 1;
          const tps = order.takeProfits || [];

          // 1. Check which highest target has been reached
          let highestReachedIdx = -1;
          for (let i = 0; i < tps.length; i++) {
            const tpPrice = tps[i];
            const isReached = isLong ? (currentPrice >= tpPrice) : (currentPrice <= tpPrice);
            if (isReached) {
              highestReachedIdx = i;
            }
          }

          if (highestReachedIdx > lastHitIdx) {
            // Compute dynamic Stop Loss with precise custom rule
            const calc = calculateTargetTrailingSL(
              highestReachedIdx,
              tps,
              entryPrice,
              order.stopLoss,
              beTarget,
              stepDist,
              stepFreq
            );

            const newSL = calc.newSL;
            const label = calc.label;

            if (newSL !== null && newSL > 0 && newSL !== currentSL) {
              if (order.mode === 'api_real' && apiKey && apiSecret) {
                const stopSide = order.direction === 'LONG' ? 'SELL' : 'BUY';
                try {
                  const stopRes = await fetch('/api/bitunix-proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      endpoint: '/openApi/swap/v2/trade/order',
                      method: 'POST',
                      params: {
                        symbol: order.apiSymbol,
                        side: stopSide,
                        positionSide: order.direction,
                        type: 'STOP_MARKET',
                        stopPrice: newSL.toString()
                      },
                      apiKey: apiKey.trim(),
                      apiSecret: apiSecret.trim(),
                      isDemo: isVST
                    })
                  });
                  const stopData = await stopRes.json();
                  if (stopData.code === 0) {
                    addLog(`🎯 [TRAILING POR ALVO] ${order.apiSymbol}: Alvo ${highestReachedIdx + 1} ($${tps[highestReachedIdx]}) atingido! Stop Loss atualizado na Bitunix para ${label}`, 'success');
                  } else {
                    addLog(`🎯 [TRAILING POR ALVO] ${order.apiSymbol}: Alvo ${highestReachedIdx + 1} ($${tps[highestReachedIdx]}) atingido! Stop Loss movido localmente para ${label}`, 'info');
                  }
                } catch (err) {
                  console.warn('Erro ao atualizar stop na Bitunix:', err);
                }
              } else {
                addLog(`🎯 [SIMULAÇÃO TRAILING ALVO] ${order.apiSymbol}: Alvo ${highestReachedIdx + 1} ($${tps[highestReachedIdx]}) atingido! Stop Loss movido para ${label}`, 'success');
              }

              // Update state & history
              setHistory(prev => prev.map(item => {
                if (item.id === order.id) {
                  return {
                    ...item,
                    trailingStop: {
                      ...item.trailingStop!,
                      currentDynamicSL: newSL!,
                      lastReachedTargetIdx: highestReachedIdx,
                      currentStepDesc: `Alvo ${highestReachedIdx + 1} ($${tps[highestReachedIdx]}) Atingido ➔ Stop em ${label}`
                    }
                  };
                }
                return item;
              }));
            }
          }
        } catch (err) {
          // ignore loop error
        }
      }
    }, 3500);

    return () => clearInterval(interval);
  }, [history, apiKey, apiSecret, accountType]);

  // Handle paste from clipboard
  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        setInputText(text);
        addLog(`[SINAL] Texto colado da área de transferência com sucesso.`, 'info');
      }
    } catch (err) {
      addLog(`[SINAL] Não foi possível ler a área de transferência. Cole manualmente no campo.`, 'warning');
    }
  };

  // Master vs Operator Permissions helpers
  const isBruno = activeOperator === 'Bruno';
  const isLeo = activeOperator === 'Leo';
  const partnerPerms = sharedSettings.partnerPermissions || {
    canEditRisk: false,
    canEditLeverage: true,
    canDisableStopLoss: false,
    canEditTrailingStop: false,
    canExecuteRealTrading: true,
    canEditApiKeys: false,
    canClearLogsOrHistory: false,
    canOverrideTakeProfits: true
  };
  const canEditRisk = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canEditRisk);
  const canEditLeverage = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canEditLeverage);
  const canDisableStopLoss = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canDisableStopLoss);
  const canEditTrailingStop = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canEditTrailingStop);
  const canExecuteRealTrading = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canExecuteRealTrading);
  const canEditApiKeys = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canEditApiKeys);
  const canOverrideTakeProfits = isBruno || (!sharedSettings.isMasterLocked || partnerPerms.canOverrideTakeProfits);

  // Stop Loss & Entry calculations for Financial Risk Management ($ and % Max Loss)
  const parsedEntry = customEntryPrice ? parseFloat(customEntryPrice) : (parsed?.entryPrice || 0);
  const parsedSL = customSL ? parseFloat(customSL) : (parsed?.stopLoss || 0);

  // SL Distance % = |Entry - SL| / Entry
  let slDistancePercent = 0;
  if (parsedEntry > 0 && parsedSL > 0) {
    slDistancePercent = Math.abs(parsedEntry - parsedSL) / parsedEntry;
  }

  // Round-trip fee rate (entry fee + exit fee on Stop Loss)
  const totalFeeRate = includeFeesInRisk ? (tradingFeeRate * 2) / 100 : 0;
  const totalRiskRate = slDistancePercent + totalFeeRate;

  // Margin calculation based on financial loss ($ or % of balance):
  // RequiredMargin = TargetMaxLossUSD / (totalRiskRate * Leverage)
  const targetRiskUSD = marginType === 'RISK_PERCENT'
    ? (initialBalance * (customRiskPercent / 100))
    : customRiskUSD;

  let calculatedRiskMargin = 0;
  if (totalRiskRate > 0 && customLeverage > 0) {
    calculatedRiskMargin = targetRiskUSD / (totalRiskRate * customLeverage);
  } else {
    calculatedRiskMargin = customMargin;
  }

  // Calculate position margin in USD
  const effectiveMarginUSD = marginType === 'USD'
    ? customMargin
    : marginType === 'PERCENT'
      ? (initialBalance * (customMarginPercent / 100))
      : calculatedRiskMargin;

  const totalPositionValue = effectiveMarginUSD * customLeverage;

  // Detailed breakdown of losses & fees
  const estimatedPriceLoss = totalPositionValue * slDistancePercent;
  const standardFeeRate = ((tradingFeeRate > 0 ? tradingFeeRate : 0.05) * 2) / 100;
  const estimatedFeesCost = totalPositionValue * standardFeeRate;
  const estimatedTotalLoss = estimatedPriceLoss + (includeFeesInRisk ? estimatedFeesCost : 0);

  // Execute Signal on Bitunix
  const handleExecuteSignal = async () => {
    if (!customSymbol) {
      addLog(`[ERRO] Símbolo inválido. Verifique o sinal colado.`, 'error');
      return;
    }

    // Save values for execution before clearing UI
    const targetSymbol = customSymbol;
    const targetDirection = customDirection;
    const targetOrderType = customOrderType;
    const targetEntryPrice = customEntryPrice;
    const targetLeverage = customLeverage;
    const targetSL = customSL;
    const targetTPs = [...customTPs];
    const targetTpIndex = selectedTpIndex;
    const targetUseTrailing = useTrailingStop;
    const targetTrailingMode = trailingMode;
    const targetTrailingMultiplier = trailingMultiplier;
    const targetTrailingRate = trailingCallbackRate;
    const targetTrailingActivation = trailingActivationPrice;

    // Limpa o campo de texto do sinal e limpa os campos de parâmetro imediatamente ao executar
    setInputText('');
    setParsed(null);
    setCustomSymbol('');
    setCustomEntryPrice('');
    setCustomSL('');
    setCustomTPs([]);
    setSelectedTpIndex(null);
    setUseTrailingStop(true); // Mantém ativado por padrão para as próximas operações
    setTrailingMode('MATCH_SL');
    setTrailingActivationPrice('');

    setIsExecuting(true);
    setExecutionStep('Iniciando envio de ordem para a Bitunix...');

    // Trava de Execução em Conta Real para Sócio (Permissão do Bruno)
    if (!canExecuteRealTrading && accountType === 'USDT' && executionMode === 'api_real') {
      addLog(`[TRAVA DO BRUNO] O operador ${activeOperator} está configurado para operar exclusivamente em Simulação / VST. Operação em USDT Real bloqueada!`, 'error');
      logPartnerActivity(activeOperator, 'Bloqueio Conta Real', `Tentou operar em USDT Real, mas Bruno restringiu para Simulação VST.`, 'warning');
      setIsExecuting(false);
      return;
    }

    // Trava de Stop Loss Obrigatório para Sócio
    if ((!canDisableStopLoss || sharedSettings.requireStopLoss) && !targetSL) {
      addLog(`[TRAVA DO BRUNO] Stop Loss é 100% OBRIGATÓRIO pelo Master Bruno. Insira um Stop Loss para executar a ordem.`, 'error');
      logPartnerActivity(activeOperator, 'Bloqueio Sem SL', `Tentou enviar ordem em ${targetSymbol} sem Stop Loss.`, 'warning');
      setIsExecuting(false);
      return;
    }

    // Trava de Limite de Perda Diária (Daily Stop Loss Guardrail)
    if (sharedSettings.dailyLossLimitUsd && todayLossUsd >= sharedSettings.dailyLossLimitUsd) {
      addLog(`[TRAVA ATIVADA] Limite diário de perda atingido (-$${todayLossUsd.toFixed(2)} / Máx -$${sharedSettings.dailyLossLimitUsd.toFixed(2)}). Operação bloqueada para preservar o capital!`, 'error');
      logPartnerActivity(activeOperator, 'Bloqueio de Stop Diário', `Tentou operar ${targetSymbol} mas o Stop Diário de -$${sharedSettings.dailyLossLimitUsd} foi atingido.`, 'warning');
      setIsExecuting(false);
      return;
    }

    let cleanSymbol = targetSymbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
    let coinName = cleanSymbol.replace('USDT', '');
    let apiSymbolFormatted = `${coinName}-USDT`;

    // Resolução dinâmica do par na Bitunix via API
    try {
      const resSym = await fetch(`/api/resolve-symbol?symbol=${encodeURIComponent(targetSymbol)}`);
      const dataSym = await resSym.json();
      if (dataSym.success && dataSym.apiSymbol) {
        apiSymbolFormatted = dataSym.apiSymbol;
        cleanSymbol = dataSym.apiSymbol.replace('-', '');
        coinName = dataSym.cleanSymbol || dataSym.displayName || coinName;
      }
    } catch {}

    const fullSymbol = `BITUNIX:${cleanSymbol}`;

    const newLogId = Math.random().toString(36).substring(2, 9).toUpperCase();

    addLog(`[SINAL] Executando ${targetDirection} em ${apiSymbolFormatted} | Operador: ${activeOperator} | Alav: ${targetLeverage}x | Margem: $${effectiveMarginUSD.toFixed(2)}`, 'info');

    if (executionMode === 'api_real') {
      if (!apiKey || !apiSecret) {
        addLog(`[API-ERRO] Configure suas chaves de API Bitunix para executar ordens reais.`, 'error');
        setIsExecuting(false);
        return;
      }

      try {
        const isVST = accountType === 'VST';
        const cleanKey = apiKey.trim();
        const cleanSecret = apiSecret.trim();

        // Step 1: Set Leverage
        setExecutionStep(`1/3 Configurando Alavancagem ${targetLeverage}x na Bitunix...`);
        try {
          const levRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/leverage',
              method: 'POST',
              params: {
                symbol: apiSymbolFormatted,
                side: targetDirection,
                leverage: targetLeverage.toString()
              },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });

          const levData = await levRes.json();
          if (levData.code === 0) {
            addLog(`[API] Alavancagem ajustada para ${targetLeverage}x (${targetDirection}) em ${apiSymbolFormatted}`, 'success');
          } else {
            // Tenta modo One-Way (BOTH) caso o modo de posição seja unidirecional
            const levBothRes = await fetch('/api/bitunix-proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: '/openApi/swap/v2/trade/leverage',
                method: 'POST',
                params: {
                  symbol: apiSymbolFormatted,
                  side: "BOTH",
                  leverage: targetLeverage.toString()
                },
                apiKey: cleanKey,
                apiSecret: cleanSecret,
                isDemo: isVST
              })
            });
            const levBothData = await levBothRes.json();
            if (levBothData.code === 0) {
              addLog(`[API] Alavancagem ajustada para ${targetLeverage}x (One-Way) em ${apiSymbolFormatted}`, 'success');
            } else {
              addLog(`[API-AVISO] Ajuste de alavancagem: ${levData.msg || levBothData.msg || 'OK'}`, 'info');
            }
          }
        } catch (e: any) {
          addLog(`[API-AVISO] Não foi possível alterar a alavancagem: ${e.message}`, 'warning');
        }

        // Step 2: Fetch current market price
        setExecutionStep(`2/3 Obtendo preço de mercado atual...`);
        let marketPrice = 0;

        try {
          const tickerRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/quote/ticker',
              method: 'GET',
              params: { symbol: apiSymbolFormatted },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
          const tickerData = await tickerRes.json();
          if (tickerData.code === 0 && tickerData.data) {
            marketPrice = parseFloat(tickerData.data.lastPrice || tickerData.data.price || '0');
          }
        } catch (e) {
          // ignore ticker fetch error
        }

        const entryPriceNum = parseFloat(targetEntryPrice);
        const refPrice = (!isNaN(entryPriceNum) && entryPriceNum > 0) ? entryPriceNum : (marketPrice || 65000);

        // Determine if this should be a LIMIT or MARKET order
        let effectiveOrderType: 'MARKET' | 'LIMIT' = targetOrderType;
        if (!isNaN(entryPriceNum) && entryPriceNum > 0) {
          // If custom entry price is provided and different from market price, enforce LIMIT order
          if (marketPrice <= 0 || Math.abs(marketPrice - entryPriceNum) / marketPrice > 0.0005) {
            effectiveOrderType = 'LIMIT';
          }
        }

        // Obter especificações do contrato (precisão de preço e quantidade)
        let pricePrecision = 4;
        let quantityPrecision = 1;
        let minQty = 1;
        try {
          const resSymInfo = await fetch(`/api/resolve-symbol?symbol=${encodeURIComponent(apiSymbolFormatted)}`);
          const dataSymInfo = await resSymInfo.json();
          if (dataSymInfo.success && dataSymInfo.contract) {
            pricePrecision = dataSymInfo.contract.pricePrecision ?? 4;
            quantityPrecision = dataSymInfo.contract.quantityPrecision ?? 1;
            minQty = parseFloat(dataSymInfo.contract.tradeMinQuantity) || 1;
          }
        } catch {}

        // Calculate quantity respecting precision
        const rawQty = (totalPositionValue / refPrice);
        let qtyFormatted = quantityPrecision === 0
          ? Math.max(minQty, Math.round(rawQty)).toString()
          : Math.max(minQty, parseFloat(rawQty.toFixed(quantityPrecision))).toFixed(quantityPrecision);

        if (parseFloat(qtyFormatted) <= 0) {
          qtyFormatted = minQty.toString();
        }

        // Configure Margin Mode: Crossed (Cross) anti-liquidation when leveraged SL >= 25% or high leverage (>= 20x), else Isolated
        const slPriceNum = parseFloat(targetSL);
        const slDistPct = (!isNaN(slPriceNum) && slPriceNum > 0 && refPrice > 0)
          ? (Math.abs(refPrice - slPriceNum) / refPrice * 100)
          : (sharedSettings.emergencyStopPercent || 5);
        const slLeveragedPct = slDistPct * targetLeverage;
        const crossThreshold = sharedSettings.autoCrossMarginThreshold || 25;
        const shouldCross = (sharedSettings.autoCrossMarginEnabled !== false) && (
          slLeveragedPct >= crossThreshold ||
          (targetLeverage >= 20 && slLeveragedPct >= 20) ||
          (targetLeverage >= 35 && slLeveragedPct >= 15)
        );
        const targetMarginType = shouldCross ? 'CROSSED' : 'ISOLATED';

        try {
          await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/marginType',
              method: 'POST',
              params: {
                symbol: apiSymbolFormatted,
                marginType: targetMarginType
              },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
          addLog(`[API] Margem ajustada para ${targetMarginType} (${shouldCross ? `Anti-Liquidação: ${targetLeverage}x c/ SL -${slLeveragedPct.toFixed(1)}%` : 'Isolada Padrão'})`, 'info');
        } catch (e) {}

        // Step 3: Send Order
        setExecutionStep(`3/3 Enviando Ordem ${targetDirection} (${effectiveOrderType}) para Bitunix...`);

        const orderSide = targetDirection === 'LONG' ? 'BUY' : 'SELL';
        const positionSideParam = targetDirection;

        const orderParams: any = {
          symbol: apiSymbolFormatted,
          side: orderSide,
          positionSide: positionSideParam,
          type: effectiveOrderType,
          quantity: qtyFormatted
        };

        if (effectiveOrderType === 'LIMIT' && entryPriceNum > 0) {
          orderParams.price = entryPriceNum.toString();
        }

        if (targetSL && parseFloat(targetSL) > 0) {
          orderParams.stopLoss = JSON.stringify({
            type: "STOP_MARKET",
            stopPrice: parseFloat(targetSL)
          });
        }

        // Determine active TP price to send (defaults to last TP in list)
        const activeTpIdx = (targetTpIndex !== null && targetTpIndex >= 0 && targetTpIndex < targetTPs.length)
          ? targetTpIndex
          : (targetTPs.length > 0 ? targetTPs.length - 1 : -1);

        const targetTP = activeTpIdx >= 0 ? targetTPs[activeTpIdx] : '';

        if (targetTP && parseFloat(targetTP) > 0) {
          orderParams.takeProfit = JSON.stringify({
            type: "TAKE_PROFIT_MARKET",
            stopPrice: parseFloat(targetTP)
          });
        }

        let orderRes = await fetch('/api/bitunix-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: '/openApi/swap/v2/trade/order',
            method: 'POST',
            params: orderParams,
            apiKey: cleanKey,
            apiSecret: cleanSecret,
            isDemo: isVST
          })
        });

        let orderData = await orderRes.json();

        // If combined order failed and had SL/TP params, retry clean order without SL/TP
        if (orderData.code !== 0 && (orderParams.stopLoss || orderParams.takeProfit)) {
          addLog(`[API-AVISO] Re-enviando ordem sem SL/TP direto para evitar rejeição da Bitunix...`, 'warning');
          delete orderParams.stopLoss;
          delete orderParams.takeProfit;

          orderRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/order',
              method: 'POST',
              params: orderParams,
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
          orderData = await orderRes.json();
        }

        if (orderData.code === 0 && orderData.data) {
          const orderObj = orderData.data.order || orderData.data;
          const realOrderId = orderObj.orderId || newLogId;
          const execPrice = parseFloat(orderObj.price || orderObj.avgPrice || refPrice.toString());

          addLog(`[API-SUCESSO] Ordem ${effectiveOrderType} #${realOrderId} criada com sucesso na Bitunix ($${execPrice})!`, 'success');

          // If Trailing Stop is requested, submit trailing stop order to Bitunix
          let trailingOrderId: string | undefined = undefined;
          let calculatedEffectiveRate = targetTrailingRate;

          if (targetUseTrailing) {
            if (targetTrailingMode === 'MATCH_SL') {
              if (targetSL && parseFloat(targetSL) > 0 && execPrice > 0) {
                const slDist = (Math.abs(execPrice - parseFloat(targetSL)) / execPrice) * 100;
                if (slDist > 0) {
                  calculatedEffectiveRate = parseFloat((slDist * targetTrailingMultiplier).toFixed(3));
                }
              } else if (slDistancePercent > 0) {
                calculatedEffectiveRate = parseFloat((slDistancePercent * 100 * targetTrailingMultiplier).toFixed(3));
              }
            }

            if (calculatedEffectiveRate > 0) {
              try {
                const trailingSide = targetDirection === 'LONG' ? 'SELL' : 'BUY';

                if (targetOrderType === 'LIMIT') {
                  // 🛡️ OPÇÃO 1 (PROTEÇÃO TOTAL): Ordem limite no livro!
                  // Não coloca o Trailing Stop no livro da Bitunix antes da hora para não disparar prematuramente no gráfico.
                  // Agenda para ativação automática pós-execução quando a ordem limite for preenchida!
                  await fetch('/api/register-pending-trailing', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      orderId: realOrderId,
                      symbol: apiSymbolFormatted,
                      positionSide: targetDirection,
                      closeSide: trailingSide,
                      quantity: qtyFormatted,
                      effectiveRate: calculatedEffectiveRate,
                      activationPrice: targetTrailingActivation,
                      stopLossPrice: targetSL,
                      entryPrice: execPrice
                    })
                  });
                  addLog(`[PROTEÇÃO ATIVA] 🛡️ Trailing Stop (${calculatedEffectiveRate}%) agendado para ativação PÓS-EXECUÇÃO assim que a ordem limite for preenchida! (Protegido contra disparo prematuro)`, 'success');
                } else {
                  // Ordem MARKET (posição preenchida de imediato): ativa diretamente
                  const trailingParams: any = {
                    symbol: apiSymbolFormatted,
                    side: trailingSide,
                    positionSide: targetDirection,
                    type: "TRAILING_STOP_MARKET",
                    quantity: qtyFormatted,
                    priceRate: (calculatedEffectiveRate / 100).toString(),
                    callbackRate: (calculatedEffectiveRate / 100).toString(),
                    entryPrice: execPrice,
                    stopLoss: targetSL
                  };
                  if (targetTrailingActivation && parseFloat(targetTrailingActivation) > 0) {
                    trailingParams.activationPrice = parseFloat(targetTrailingActivation).toString();
                  }

                  const tsRes = await fetch('/api/bitunix-proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      endpoint: '/openApi/swap/v2/trade/order',
                      method: 'POST',
                      params: trailingParams,
                      apiKey: cleanKey,
                      apiSecret: cleanSecret,
                      isDemo: isVST
                    })
                  });
                  const tsData = await tsRes.json();
                  if (tsData.code === 0 && tsData.data) {
                    const tsOrderObj = tsData.data.order || tsData.data;
                    trailingOrderId = tsOrderObj.orderId?.toString();
                    if (targetTrailingMode === 'MATCH_SL') {
                      addLog(`[API-SUCESSO] Trailing Stop Móvel (${targetTrailingMultiplier}x do SL = ${calculatedEffectiveRate}%) ativado com sucesso na Bitunix! (Ordem #${trailingOrderId || ''})`, 'success');
                    } else {
                      addLog(`[API-SUCESSO] Trailing Stop Móvel (${calculatedEffectiveRate}%) ativado com sucesso na Bitunix! (Ordem #${trailingOrderId || ''})`, 'success');
                    }
                  } else {
                    addLog(`[API-AVISO] Trailing Stop Móvel (${calculatedEffectiveRate}%): ${tsData.msg || 'Registrado'}`, 'info');
                  }
                }
              } catch (e: any) {
                console.warn('Erro ao configurar Trailing Stop na Bitunix:', e);
              }
            }
          }

          const newOrderLog: SignalOrderLog = {
            id: newLogId,
            symbol: fullSymbol,
            apiSymbol: apiSymbolFormatted,
            direction: targetDirection,
            orderType: effectiveOrderType,
            entryPrice: execPrice.toFixed(4),
            leverage: targetLeverage,
            margin: effectiveMarginUSD,
            positionValue: totalPositionValue,
            stopLoss: targetSL ? parseFloat(targetSL) : null,
            takeProfits: targetTPs.map(tp => parseFloat(tp)).filter(tp => !isNaN(tp)),
            trailingStop: targetUseTrailing ? {
              enabled: true,
              mode: targetTrailingMode,
              multiplier: targetTrailingMultiplier,
              callbackRate: calculatedEffectiveRate,
              activationPrice: targetTrailingActivation && parseFloat(targetTrailingActivation) > 0 ? parseFloat(targetTrailingActivation) : null,
              currentDynamicSL: targetSL ? parseFloat(targetSL) : null,
              lastReachedTargetIdx: -1,
            } : undefined,
            trailingOrderIdBinX: trailingOrderId,
            status: 'EXECUTED',
            executedAt: new Date().toLocaleTimeString(),
            orderIdBinX: realOrderId.toString(),
            mode: 'api_real',
            accountType,
            operator: activeOperator,
            syncedAt: new Date().toISOString()
          };

          setHistory(prev => [newOrderLog, ...prev]);
          saveOrderToCloud(newOrderLog);
          logPartnerActivity(activeOperator, 'Executou Sinal (Real)', `${targetDirection} em ${apiSymbolFormatted} | Margem: $${effectiveMarginUSD.toFixed(2)} | Alav: ${targetLeverage}x`, 'success');
          setTimeout(onSyncBalance, 2000);
        } else {
          const msg = orderData.msg || (orderData.code ? `Código de Erro Bitunix: ${orderData.code}` : 'Erro ao enviar ordem para a exchange');
          addLog(`[API-ERRO] Falha na Bitunix: ${msg}`, 'error');

          const failedLog: SignalOrderLog = {
            id: newLogId,
            symbol: fullSymbol,
            apiSymbol: apiSymbolFormatted,
            direction: targetDirection,
            orderType: effectiveOrderType,
            entryPrice: targetEntryPrice || (marketPrice ? marketPrice.toString() : 'A MERCADO'),
            leverage: targetLeverage,
            margin: effectiveMarginUSD,
            positionValue: totalPositionValue,
            stopLoss: targetSL ? parseFloat(targetSL) : null,
            takeProfits: targetTPs.map(tp => parseFloat(tp)).filter(tp => !isNaN(tp)),
            status: 'FAILED',
            executedAt: new Date().toLocaleTimeString(),
            errorMessage: msg,
            mode: 'api_real',
            accountType,
            operator: activeOperator,
            syncedAt: new Date().toISOString()
          };

          setHistory(prev => [failedLog, ...prev]);
          saveOrderToCloud(failedLog);
          logPartnerActivity(activeOperator, 'Falha na Execução', `${targetDirection} em ${apiSymbolFormatted}: ${msg}`, 'error');
        }
      } catch (err: any) {
        addLog(`[API-ERRO] Erro de comunicação: ${err.message}`, 'error');
      }
    } else {
      // Simulation Mode
      setExecutionStep('Simulando envio de ordem...');
      await new Promise(r => setTimeout(r, 800));

      const simPrice = parseFloat(targetEntryPrice) || (targetSymbol.includes('BTC') ? 96500 : 2650);

      let simCalculatedRate = targetTrailingRate;
      if (targetUseTrailing && targetTrailingMode === 'MATCH_SL') {
        if (targetSL && parseFloat(targetSL) > 0 && simPrice > 0) {
          const slDist = (Math.abs(simPrice - parseFloat(targetSL)) / simPrice) * 100;
          if (slDist > 0) {
            simCalculatedRate = parseFloat((slDist * targetTrailingMultiplier).toFixed(3));
          }
        } else if (slDistancePercent > 0) {
          simCalculatedRate = parseFloat((slDistancePercent * 100 * targetTrailingMultiplier).toFixed(3));
        }
      }

      const simOrderLog: SignalOrderLog = {
        id: newLogId,
        symbol: fullSymbol,
        apiSymbol: apiSymbolFormatted,
        direction: targetDirection,
        orderType: targetOrderType,
        entryPrice: simPrice.toFixed(4),
        leverage: targetLeverage,
        margin: effectiveMarginUSD,
        positionValue: totalPositionValue,
        stopLoss: targetSL ? parseFloat(targetSL) : null,
        takeProfits: targetTPs.map(tp => parseFloat(tp)).filter(tp => !isNaN(tp)),
        trailingStop: targetUseTrailing ? {
          enabled: true,
          mode: targetTrailingMode,
          multiplier: targetTrailingMultiplier,
          callbackRate: simCalculatedRate,
          activationPrice: targetTrailingActivation && parseFloat(targetTrailingActivation) > 0 ? parseFloat(targetTrailingActivation) : null,
          currentDynamicSL: targetSL ? parseFloat(targetSL) : null,
          lastReachedTargetIdx: -1,
        } : undefined,
        status: 'EXECUTED',
        executedAt: new Date().toLocaleTimeString(),
        orderIdBinX: `SIM-${Math.floor(Math.random() * 899999 + 100000)}`,
        pnlCash: 0,
        pnlPercent: 0,
        mode: 'simulation',
        accountType,
        operator: activeOperator,
        syncedAt: new Date().toISOString()
      };

      setHistory(prev => [simOrderLog, ...prev]);
      saveOrderToCloud(simOrderLog);
      logPartnerActivity(activeOperator, 'Executou Sinal (Simulação)', `${targetDirection} em ${apiSymbolFormatted} | Margem: $${effectiveMarginUSD.toFixed(2)} | Alav: ${targetLeverage}x`, 'info');
      if (targetUseTrailing) {
        if (targetTrailingMode === 'MATCH_SL') {
          addLog(`[SIMULAÇÃO] Sinal executado em ${apiSymbolFormatted} ($${totalPositionValue.toFixed(2)}) com Trailing Stop 1:1 vinculado ao Stop (${simCalculatedRate}%)!`, 'success');
        } else {
          addLog(`[SIMULAÇÃO] Sinal executado em ${apiSymbolFormatted} ($${totalPositionValue.toFixed(2)}) com Trailing Stop de ${simCalculatedRate}% ativado!`, 'success');
        }
      } else {
        addLog(`[SIMULAÇÃO] Sinal executado em ${apiSymbolFormatted} no valor de $${totalPositionValue.toFixed(2)}`, 'success');
      }
    }

    setIsExecuting(false);
    setExecutionStep('');
  };

  // Close specific position or cancel pending order
  const handleClosePosition = async (log: SignalOrderLog) => {
    addLog(`[SINAL] Solicitando cancelamento de ordens e fechamento de posição para ${log.apiSymbol}...`, 'info');

    if (executionMode === 'api_real' && apiKey && apiSecret) {
      try {
        const isVST = accountType === 'VST';
        const cleanKey = apiKey.trim();
        const cleanSecret = apiSecret.trim();

        // Step 1: Cancel all open/pending orders and triggers for this symbol
        try {
          if (log.orderIdBinX) {
            await fetch('/api/bitunix-proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                endpoint: '/openApi/swap/v2/trade/order',
                method: 'DELETE',
                params: {
                  symbol: log.apiSymbol,
                  orderId: log.orderIdBinX
                },
                apiKey: cleanKey,
                apiSecret: cleanSecret,
                isDemo: isVST
              })
            }).catch(() => {});
          }

          const cancelRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/allOpenOrders',
              method: 'DELETE',
              params: {
                symbol: log.apiSymbol
              },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
          const cancelData = await cancelRes.json();
          if (cancelData.code === 0) {
            addLog(`[API] Ordens pendentes/gatilhos em ${log.apiSymbol} cancelados com sucesso!`, 'info');
          }
        } catch (e) {
          console.warn('Erro ao cancelar ordens:', e);
        }

        // Step 2: Fetch active positions from Bitunix to get exact positionAmt (quantity)
        let positionClosed = false;
        try {
          const posRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/user/positions',
              method: 'GET',
              params: {},
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });

          const posData = await posRes.json();
          if (posData.code === 0 && posData.data) {
            const positions = Array.isArray(posData.data) ? posData.data : [posData.data];
            const activePositions = positions.filter((p: any) => 
              p.symbol && p.symbol.replace('-', '') === log.apiSymbol.replace('-', '') && parseFloat(p.positionAmt) !== 0
            );

            for (const pos of activePositions) {
              const amt = Math.abs(parseFloat(pos.positionAmt));
              if (amt > 0) {
                const side = pos.positionSide === 'LONG' ? 'SELL' : (pos.positionSide === 'SHORT' ? 'BUY' : (parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY'));
                const closeRes = await fetch('/api/bitunix-proxy', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    endpoint: '/openApi/swap/v2/trade/order',
                    method: 'POST',
                    params: {
                      symbol: pos.symbol,
                      side: side,
                      positionSide: pos.positionSide || log.direction,
                      type: "MARKET",
                      quantity: amt.toString()
                    },
                    apiKey: cleanKey,
                    apiSecret: cleanSecret,
                    isDemo: isVST
                  })
                });

                const d = await closeRes.json();
                if (d.code === 0) {
                  addLog(`[API] Posição em ${pos.symbol} (${pos.positionSide}) de qtd ${amt} encerrada a mercado na Bitunix!`, 'success');
                  positionClosed = true;
                } else {
                  addLog(`[API-ERRO] Erro ao fechar posição ${pos.symbol}: ${d.msg}`, 'error');
                }
              }
            }
          }
        } catch (e: any) {
          console.warn('Erro ao buscar posições ativas:', e);
        }

        // Step 3: Fallback close order with calculated quantity if position was not found in user/positions
        if (!positionClosed) {
          const entryPrice = parseFloat(log.entryPrice) || 1;
          const fallbackQty = (log.positionValue / entryPrice).toFixed(4);
          const closeSide = log.direction === 'LONG' ? 'SELL' : 'BUY';

          const fbRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/order',
              method: 'POST',
              params: {
                symbol: log.apiSymbol,
                side: closeSide,
                positionSide: log.direction,
                type: "MARKET",
                quantity: fallbackQty
              },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });

          const fbData = await fbRes.json();
          if (fbData.code === 0) {
            addLog(`[API] Posição em ${log.apiSymbol} encerrada com sucesso na Bitunix!`, 'success');
          } else {
            addLog(`[API] Operação/Ordens em ${log.apiSymbol} finalizadas (${fbData.msg || 'Concluído'})`, 'info');
          }
        }

        setHistory(prev => prev.map(h => h.id === log.id ? { ...h, status: 'CLOSED' } : h));
        updateOrderInCloud(log.id, { status: 'CLOSED' });
        logPartnerActivity(activeOperator, 'Encerrou Posição', `Fechou posição em ${log.apiSymbol} (${log.direction})`, 'info');
        setTimeout(onSyncBalance, 2000);
      } catch (e: any) {
        addLog(`[API-ERRO] Erro ao fechar posição/cancelar ordem: ${e.message}`, 'error');
        setHistory(prev => prev.map(h => h.id === log.id ? { ...h, status: 'CLOSED' } : h));
        updateOrderInCloud(log.id, { status: 'CLOSED' });
      }
    } else {
      setHistory(prev => prev.map(h => h.id === log.id ? { ...h, status: 'CLOSED' } : h));
      updateOrderInCloud(log.id, { status: 'CLOSED' });
      logPartnerActivity(activeOperator, 'Encerrou Posição (Simulação)', `Fechou posição em ${log.apiSymbol}`, 'info');
      addLog(`[SIMULAÇÃO] Posição/Ordem em ${log.apiSymbol} fechada e cancelada.`, 'success');
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-3 sm:gap-5 overflow-y-auto p-2 sm:p-4 md:p-6 pb-24 sm:pb-6 custom-scrollbar">
      {/* Mobile Top Header (sm:hidden) */}
      <div className="sm:hidden bg-gradient-to-r from-brand-surface via-brand-surface/95 to-brand-bg border border-brand-border rounded-2xl p-2.5 shadow-xl space-y-2">
        {/* Row 1: Title Badge + Operator Switcher + API Config */}
        <div className="flex items-center justify-between gap-1.5">
          {/* Title Badge "COPIA E COLA INTELIGENTE" */}
          <div className="h-8 px-2.5 bg-brand-accent/15 border border-brand-accent/40 rounded-xl text-brand-accent text-[11px] font-extrabold uppercase tracking-wide flex items-center gap-1.5 shrink-0 shadow-sm">
            <Sparkles className="w-3.5 h-3.5 text-brand-accent shrink-0" />
            <span>Copia e Cola Inteligente</span>
          </div>

          {/* Right Controls: Operator Pill + Settings */}
          <div className="flex items-center gap-1.5 shrink-0">
            {/* Operator Switcher Pill */}
            <button
              type="button"
              onClick={() => handleSwitchOperator(activeOperator === 'Bruno' ? 'Leo' : 'Bruno')}
              className={`h-8 px-2.5 rounded-xl border text-[10px] font-extrabold flex items-center gap-1 transition-all shadow-sm ${
                activeOperator === 'Bruno'
                  ? 'bg-blue-600 text-white border-blue-500 shadow-blue-500/20'
                  : 'bg-purple-600 text-white border-purple-500 shadow-purple-500/20'
              }`}
              title="Alternar Operador (Toque para alternar)"
            >
              <User className="w-3 h-3" />
              <span>{activeOperator === 'Bruno' ? 'Bruno' : 'Leo'}</span>
            </button>

            {/* Chaves API Settings Button */}
            {canEditApiKeys && (
              <button
                type="button"
                onClick={() => setShowApiConfig(!showApiConfig)}
                className={`h-8 w-8 rounded-xl border text-[10px] font-bold flex items-center justify-center transition-all ${
                  showApiConfig
                    ? 'bg-brand-accent text-white border-brand-accent'
                    : apiKey && apiSecret
                    ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : 'bg-yellow-500/20 border-yellow-500/40 text-yellow-300 animate-pulse'
                }`}
                title="Configurar Chaves API"
              >
                <Settings className={`w-3.5 h-3.5 ${showApiConfig ? 'rotate-90' : ''} transition-transform`} />
              </button>
            )}
          </div>
        </div>

        {/* Row 2: Account Switcher Badge + Saldo + Bot Telegram evenly distributed */}
        <div className="grid grid-cols-12 gap-1.5 items-center">
          {/* 1. Interactive Saved Account Switcher (Mobile) */}
          <div className="col-span-5 relative" ref={mobileSwitcherRef}>
            <button
              type="button"
              onClick={() => setShowAccountDropdown(prev => !prev)}
              className="w-full h-8 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/35 px-2 rounded-xl flex items-center justify-between gap-1 text-emerald-400 transition-all"
              title="Alternar Conta Bitunix Salva"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                {isSwitchingAccount ? (
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-400 shrink-0" />
                ) : (
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                )}
                <span className="text-[10px] font-black uppercase tracking-tight truncate">
                  {displayAccountName}
                </span>
              </div>
              <ChevronDown className={`w-3 h-3 shrink-0 transition-transform ${showAccountDropdown ? 'rotate-180' : ''}`} />
            </button>

            {showAccountDropdown && (
              <div className="absolute left-0 top-9 z-50 w-64 bg-brand-surface border border-brand-border rounded-2xl shadow-2xl p-2 space-y-1.5">
                <div className="px-2 py-1 text-[9px] font-bold uppercase tracking-wider text-brand-text/50 flex items-center justify-between">
                  <span>Contas Bitunix Salvas</span>
                  <span>{effectiveSavedAccounts.length}</span>
                </div>
                {effectiveSavedAccounts.map(acc => (
                  <button
                    key={acc.id}
                    type="button"
                    disabled={isSwitchingAccount}
                    onClick={async () => {
                      setShowAccountDropdown(false);
                      if (!acc.isActive && onSwitchSavedAccount) {
                        await onSwitchSavedAccount(acc.id);
                        setTimeout(() => fetchLiveBitunixPositions(true), 400);
                      }
                    }}
                    className={`w-full text-left px-2.5 py-2 rounded-xl border transition-all flex items-center justify-between gap-2 ${
                      acc.isActive
                        ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                        : 'bg-brand-bg/60 border-brand-border/60 text-brand-text/80 hover:border-brand-accent/50 hover:text-white'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] font-bold truncate">{acc.label}</div>
                      <div className="text-[9px] font-mono text-brand-text/45">{acc.apiKeyMasked}</div>
                    </div>
                    {acc.isActive ? (
                      <span className="px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 text-[9px] font-bold shrink-0">Ativa</span>
                    ) : (
                      <span className="text-[9px] font-bold text-brand-accent shrink-0">Usar</span>
                    )}
                  </button>
                ))}
                {canEditApiKeys && (
                  <button
                    type="button"
                    onClick={() => {
                      setShowAccountDropdown(false);
                      setShowApiConfig(true);
                    }}
                    className="w-full py-1.5 px-2.5 rounded-xl bg-brand-accent/15 hover:bg-brand-accent/25 text-brand-accent text-[10px] font-bold flex items-center justify-center gap-1 transition-all"
                  >
                    <Key className="w-3 h-3" />
                    <span>Gerenciar / Nova Chave</span>
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 2. Saldo Display & Sync */}
          <div className="col-span-4 h-8 bg-brand-bg border border-brand-border px-2 rounded-xl flex items-center justify-between">
            <div className="flex items-center gap-1 min-w-0">
              <Wallet className="w-3 h-3 text-emerald-400 shrink-0" />
              <span className="text-[11px] font-mono font-black text-white truncate">
                ${initialBalance.toFixed(2)}
              </span>
            </div>
            <button
              type="button"
              onClick={handleSyncClick}
              disabled={isSyncingBalance}
              className="p-0.5 text-brand-text/40 hover:text-brand-accent transition-colors shrink-0"
              title="Sincronizar Saldo"
            >
              <RefreshCw className={`w-2.5 h-2.5 ${isSyncingBalance ? 'animate-spin text-brand-accent' : ''}`} />
            </button>
          </div>

          {/* 3. Bot Telegram */}
          <div className="col-span-3 h-8">
            <button
              type="button"
              onClick={() => setIsTelegramSettingsOpen(true)}
              className="w-full h-full px-2 bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-200 rounded-xl font-bold flex items-center justify-center gap-1.5 text-[11px] active:scale-95 whitespace-nowrap shadow-sm"
              title="Configurar Bot Telegram"
            >
              <Bot className="w-3.5 h-3.5 text-sky-400 shrink-0" />
              <span>Bot</span>
            </button>
          </div>
        </div>
      </div>

      {/* Desktop Top Main Toolbar Banner (hidden sm:block) */}
      <div className="hidden sm:block bg-gradient-to-r from-brand-surface via-brand-surface/90 to-brand-bg border border-brand-border rounded-2xl p-4 sm:p-5 shadow-xl space-y-3 sm:space-y-4">
        
        {/* Row 1: Controls Cluster - Uniform Height & Responsive Compact Alignment */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* Left Group: Copia e Cola Inteligente + Chaves API side-by-side */}
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0 max-w-full">
            <span className="h-9 sm:h-10 px-2.5 sm:px-3.5 bg-brand-accent/20 border border-brand-accent/40 rounded-xl text-brand-accent text-[10px] sm:text-xs font-extrabold tracking-normal sm:tracking-wider uppercase flex items-center gap-1.5 shrink-0 shadow-sm whitespace-nowrap">
              <Sparkles className="w-3.5 h-3.5 shrink-0" />
              <span>Copia e Cola Inteligente</span>
            </span>

            {/* Engrenagem (Gear Icon ⚙️) for API Keys - Apenas visível para quem tem permissão */}
            {canEditApiKeys && (
              <button
                onClick={() => setShowApiConfig(!showApiConfig)}
                className={`h-9 sm:h-10 px-2.5 sm:px-3.5 rounded-xl border transition-all flex items-center space-x-1.5 sm:space-x-2 text-[10px] sm:text-xs font-bold shadow-md shrink-0 whitespace-nowrap ${
                  showApiConfig
                    ? 'bg-brand-accent text-white border-brand-accent shadow-brand-accent/20'
                    : apiKey && apiSecret
                    ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/20'
                    : 'bg-yellow-500/20 border-yellow-500/60 text-yellow-300 hover:bg-yellow-500/30 animate-pulse'
                }`}
                title="Configurar Chaves API Bitunix (Engrenagem)"
              >
                <Settings className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${showApiConfig ? 'rotate-90' : ''} transition-transform duration-300 shrink-0`} />
                <span>Chaves API</span>
              </button>
            )}

            {/* Botão de Acesso Rápido ao Copy Trade (Trader Líder) */}
            {onOpenCopyTrade && (
              <button
                type="button"
                onClick={onOpenCopyTrade}
                className="h-9 sm:h-10 px-2.5 sm:px-3.5 bg-blue-500/10 hover:bg-blue-500/20 border border-blue-500/40 rounded-xl text-blue-400 text-[10px] sm:text-xs font-bold transition-all flex items-center space-x-1.5 sm:space-x-2 shadow-md shrink-0 whitespace-nowrap"
                title="Abrir Painel Copy Trade (Trader Líder)"
              >
                <Users className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-blue-400 shrink-0" />
                <span>Copy Trade Líder</span>
              </button>
            )}
          </div>

          {/* Right Group: Account Switcher + Balance */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 shrink-0 max-w-full">
            
            {/* 1. Interactive Saved Account Switcher (Desktop) */}
            <div className="relative shrink-0" ref={desktopSwitcherRef}>
              <button
                type="button"
                onClick={() => setShowAccountDropdown(prev => !prev)}
                className="h-9 sm:h-10 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/35 px-3 rounded-xl flex items-center space-x-2 shadow-inner transition-all"
                title="Clique para alternar entre as contas Bitunix salvas"
              >
                {isSwitchingAccount ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 shrink-0" />
                ) : (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.6)] shrink-0" />
                )}
                <div className="flex flex-col items-start leading-none text-left">
                  <span className="text-[10px] sm:text-[11px] font-black text-emerald-400 uppercase tracking-wide max-w-[165px] truncate">
                    {displayAccountName}
                  </span>
                  {displayMaskedKey && (
                    <span className="text-[8.5px] font-mono text-emerald-300/60 mt-0.5">
                      {displayMaskedKey}
                    </span>
                  )}
                </div>
                <ChevronDown className={`w-3.5 h-3.5 text-emerald-400/80 transition-transform ${showAccountDropdown ? 'rotate-180' : ''}`} />
              </button>

              {showAccountDropdown && (
                <div className="absolute right-0 top-11 z-50 w-72 bg-brand-surface border border-brand-border rounded-2xl shadow-2xl p-2.5 space-y-1.5">
                  <div className="px-2 py-1 text-[10px] font-extrabold uppercase tracking-wider text-brand-text/50 flex items-center justify-between border-b border-brand-border/50 pb-1.5">
                    <span>Alternar Conta Bitunix</span>
                    <span className="text-emerald-400 font-mono">{effectiveSavedAccounts.length} salvas</span>
                  </div>
                  <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar">
                    {effectiveSavedAccounts.map(acc => (
                      <button
                        key={acc.id}
                        type="button"
                        disabled={isSwitchingAccount}
                        onClick={async () => {
                          setShowAccountDropdown(false);
                          if (!acc.isActive && onSwitchSavedAccount) {
                            await onSwitchSavedAccount(acc.id);
                            setTimeout(() => fetchLiveBitunixPositions(true), 400);
                          }
                        }}
                        className={`w-full text-left px-3 py-2 rounded-xl border transition-all flex items-center justify-between gap-2 ${
                          acc.isActive
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                            : 'bg-brand-bg/60 border-brand-border/60 text-brand-text/80 hover:border-brand-accent/60 hover:text-white'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-bold truncate">{acc.label}</div>
                          <div className="text-[10px] font-mono text-brand-text/50">{acc.apiKeyMasked}</div>
                        </div>
                        {acc.isActive ? (
                          <span className="px-2 py-0.5 rounded-md bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[9px] font-black shrink-0 flex items-center gap-1">
                            <Check className="w-2.5 h-2.5" /> ATIVA
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded-md bg-brand-accent/15 text-brand-accent text-[9px] font-bold shrink-0">
                            Ativar
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {canEditApiKeys && (
                    <button
                      type="button"
                      onClick={() => {
                        setShowAccountDropdown(false);
                        setShowApiConfig(true);
                      }}
                      className="w-full py-2 px-3 rounded-xl bg-brand-accent/15 hover:bg-brand-accent/25 text-brand-accent text-[11px] font-bold flex items-center justify-center gap-1.5 transition-all border border-brand-accent/30"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Gerenciar / Adicionar Chaves</span>
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 2. Saldo Display & Sync Box */}
            <div className="h-9 sm:h-10 bg-brand-bg border border-brand-border/80 px-2 sm:px-2.5 rounded-xl flex items-center justify-between space-x-2 shadow-md shrink-0">
              <div className="flex items-center space-x-1.5 sm:space-x-2">
                <div className={`p-1 rounded-lg ${accountType === 'USDT' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-purple-500/20 text-purple-400'}`}>
                  <Wallet className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                </div>
                <div className="flex flex-col justify-center leading-none">
                  <span className="text-[7.5px] sm:text-[8.5px] font-extrabold uppercase text-brand-text/40 tracking-wider">
                    Saldo {accountType}
                  </span>

                  {isEditingBalance ? (
                    <div className="flex items-center space-x-1 mt-0.5">
                      <span className="text-[10px] sm:text-xs font-mono font-bold text-white">$</span>
                      <input
                        type="number"
                        value={tempBalanceInput}
                        onChange={(e) => setTempBalanceInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            const val = parseFloat(tempBalanceInput);
                            if (!isNaN(val) && val >= 0 && setInitialBalance) {
                              setInitialBalance(val);
                              addLog(`[SALDO] Saldo ajustado para $${val.toFixed(2)} ${accountType}`, 'info');
                            }
                            setIsEditingBalance(false);
                          }
                        }}
                        onBlur={() => {
                          const val = parseFloat(tempBalanceInput);
                          if (!isNaN(val) && val >= 0 && setInitialBalance) {
                            setInitialBalance(val);
                          }
                          setIsEditingBalance(false);
                        }}
                        className="w-14 bg-brand-surface border border-brand-accent rounded px-1 text-[10px] sm:text-xs font-mono font-bold text-white outline-none"
                        autoFocus
                      />
                    </div>
                  ) : (
                    <div className="flex items-center space-x-1 mt-0.5">
                      <span className="text-[11px] sm:text-xs font-mono font-black text-white leading-none">
                        ${initialBalance.toFixed(2)}
                      </span>
                      {setInitialBalance && (
                        <button
                          onClick={() => {
                            setTempBalanceInput(initialBalance.toString());
                            setIsEditingBalance(true);
                          }}
                          className="p-0.5 hover:bg-brand-surface rounded text-brand-text/30 hover:text-white transition-colors"
                          title="Editar Saldo Manualmente"
                        >
                          <Pencil className="w-2 h-2 sm:w-2.5 sm:h-2.5" />
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Sync Balance Button */}
              <button
                onClick={handleSyncClick}
                disabled={isSyncingBalance}
                className="p-1 bg-brand-surface hover:bg-brand-accent/20 text-brand-text/60 hover:text-brand-accent rounded-lg border border-brand-border/60 transition-all disabled:opacity-50 shrink-0"
                title="Sincronizar Saldo na Bitunix"
              >
                <RefreshCw className={`w-3 h-3 sm:w-3.5 sm:h-3.5 ${isSyncingBalance ? 'animate-spin text-brand-accent' : ''}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Row 2: Shared Cloud Sync & Conservative Safety Locks Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-brand-border/40">
          
          {/* Operator Switcher (Turno Bruno Master / Leo Sócio) */}
          <div className="flex items-center gap-1.5 bg-brand-bg/80 border border-brand-border/70 p-1 rounded-xl shrink-0">
            <span className="text-[10px] font-bold text-brand-text/50 uppercase px-1.5 flex items-center gap-1">
              <Users className="w-3 h-3 text-brand-accent" />
              <span>Operador:</span>
            </span>
            <button
              onClick={() => handleSwitchOperator('Bruno')}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold transition-all flex items-center gap-1 ${
                activeOperator === 'Bruno'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
              }`}
            >
              <User className="w-2.5 h-2.5" />
              <span>Bruno (Master)</span>
            </button>
            <button
              onClick={() => handleSwitchOperator('Leo')}
              className={`px-2.5 py-1 rounded-lg text-[10px] font-extrabold transition-all flex items-center gap-1 ${
                activeOperator === 'Leo'
                  ? 'bg-purple-600 text-white shadow-sm'
                  : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
              }`}
            >
              <User className="w-2.5 h-2.5" />
              <span>Leo (Sócio)</span>
            </button>
          </div>

          {/* Center/Right Action Buttons: Safety Locks & Telegram Guide */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Travas de Segurança (Safety Locks) */}
            <button
              onClick={() => setIsSafetyModalOpen(true)}
              className="h-8 sm:h-9 px-3 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 rounded-xl text-[10px] sm:text-xs font-black transition-all flex items-center gap-1.5 shadow-sm"
              title="Configurar Travas de Segurança Master do Bruno"
            >
              <Shield className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span>Travas do Bruno</span>
              <span className="bg-emerald-500/20 text-emerald-200 px-1.5 py-0.5 rounded text-[9px] font-mono">
                Risco: {sharedSettings.maxRiskPercent}% | Trailing 1x | Alav. Livre
              </span>
            </button>

            {/* Bot Telegram Controls (Ajustes + Guia) */}
            <div className="flex items-center gap-1 bg-sky-950/40 border border-sky-500/30 p-0.5 rounded-xl">
              <button
                onClick={() => setIsTelegramSettingsOpen(true)}
                className="h-7 sm:h-8 px-2.5 bg-sky-500/20 hover:bg-sky-500/30 text-sky-200 rounded-lg text-[10px] sm:text-xs font-black transition-all flex items-center gap-1.5 shadow-sm"
                title="Configurar Risco, Margem, Alavancagem e Trailing Stop do Bot Telegram"
              >
                <Bot className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>Config Bot Telegram</span>
                <span className="bg-sky-500/30 text-sky-100 px-1.5 py-0.5 rounded text-[8.5px] font-mono">
                  {safeTgConfig.riskMode === 'PERCENT' ? `${safeTgConfig.riskPercent ?? 2}%` : `$${safeTgConfig.riskFixedUsd ?? 50}`} | {safeTgConfig.trailingStopEnabled ? `${safeTgConfig.trailingMultiplier ?? 1}x SL` : 'Off'}
                </span>
              </button>

              <button
                onClick={() => setIsTelegramGuideOpen(true)}
                className="h-7 sm:h-8 px-2 hover:bg-sky-500/20 text-sky-400 hover:text-sky-200 rounded-lg text-[10px] font-bold transition-all flex items-center gap-1"
                title="Como usar o Bot no Telegram"
              >
                <span>Guia</span>
              </button>
            </div>

            {/* Cloud Sync Status */}
            <div className="h-8 sm:h-9 px-2.5 bg-brand-bg/90 border border-brand-border/60 rounded-xl flex items-center gap-1.5 text-[10px] font-bold text-brand-text/70">
              <span className={`w-2 h-2 rounded-full ${isCloudConnected ? 'bg-emerald-400 animate-pulse' : 'bg-yellow-400'}`} />
              <Cloud className="w-3 h-3 text-brand-accent shrink-0" />
              <span className="hidden sm:inline">Nuvem Sincronizada</span>
            </div>

            {/* Central de Cópia & Backup */}
            <button
              onClick={() => {
                if (onOpenBackupModal) {
                  onOpenBackupModal();
                } else {
                  setInternalBackupModalOpen(true);
                }
              }}
              className="h-8 sm:h-9 px-2.5 sm:px-3 bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent border border-brand-accent/40 rounded-xl text-[10px] sm:text-xs font-black transition-all flex items-center gap-1.5 shadow-sm hover:scale-[1.02]"
              title="Fazer Cópia / Backup Completo do Sistema ou Configurar Copy Trade"
            >
              <FolderArchive className="w-3.5 h-3.5 shrink-0" />
              <span>Cópia & Backup</span>
            </button>
          </div>
        </div>
      </div>

      {/* Modal / Popup for API Keys Config */}
      <AnimatePresence>
        {showApiConfig && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-brand-surface border border-brand-border rounded-2xl max-w-lg w-full p-4 sm:p-6 shadow-2xl space-y-4 relative font-mono text-xs my-auto"
            >
              {/* Header */}
              <div className="flex items-center justify-between pb-3 border-b border-brand-border">
                <div className="flex items-center space-x-2.5">
                  <div className="p-2 bg-yellow-500/20 text-yellow-400 border border-yellow-500/40 rounded-xl">
                    <Key className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase tracking-wider flex items-center gap-2">
                      Alterar Chaves API Bitunix
                    </h3>
                    <p className="text-[10px] text-brand-text/50 font-sans">
                      Troque suas credenciais da API Bitunix (Futuros Perpétuos)
                    </p>
                  </div>
                </div>

                <button
                  onClick={() => setShowApiConfig(false)}
                  className="p-1.5 text-brand-text/40 hover:text-white hover:bg-brand-bg rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Active Status Badge */}
              <div className="flex items-center justify-between p-2.5 bg-brand-bg rounded-xl border border-brand-border/60">
                <div className="min-w-0">
                  <span className="text-[10px] uppercase font-bold text-brand-text/50 block">Conta Bitunix Ativa</span>
                  <span className="text-xs font-extrabold text-white truncate block">{displayAccountName}</span>
                </div>
                {apiKey && apiSecret ? (
                  <span className="text-[10px] px-2.5 py-0.5 bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 rounded-full font-mono font-bold flex items-center gap-1 shrink-0">
                    <Check className="w-3 h-3" />
                    Conectada
                  </span>
                ) : (
                  <span className="text-[10px] px-2.5 py-0.5 bg-yellow-500/20 text-yellow-300 border border-yellow-500/40 rounded-full font-mono font-bold shrink-0">
                    ⚠️ Nenhuma Chave Definida
                  </span>
                )}
              </div>

              {/* Saved Accounts Quick Switcher & Multi-Key Vault */}
              <div className="p-3 bg-brand-bg/70 border border-brand-border rounded-xl space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                    <Users className="w-3.5 h-3.5" />
                    <span>Contas Salvas ({effectiveSavedAccounts.length}) — Troca Rápida</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setShowAddAccountForm(prev => !prev)}
                    className="px-2 py-1 rounded-lg bg-brand-accent/15 hover:bg-brand-accent/25 text-brand-accent border border-brand-accent/30 text-[10px] font-bold flex items-center gap-1 transition-all"
                  >
                    <Plus className="w-3 h-3" />
                    <span>{showAddAccountForm ? 'Fechar' : 'Nova Conta'}</span>
                  </button>
                </div>

                <div className="space-y-1.5 max-h-40 overflow-y-auto custom-scrollbar">
                  {effectiveSavedAccounts.map(acc => (
                    <div
                      key={acc.id}
                      className={`p-2 rounded-xl border flex items-center justify-between gap-2 transition-all ${
                        acc.isActive
                          ? 'bg-emerald-500/10 border-emerald-500/40'
                          : 'bg-brand-surface/70 border-brand-border/60'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${acc.isActive ? 'bg-emerald-400 animate-pulse' : 'bg-brand-text/30'}`} />
                          <span className="text-[11px] font-bold text-white truncate">{acc.label}</span>
                        </div>
                        <span className="text-[10px] font-mono text-brand-text/50 block pl-3">
                          Key: {acc.apiKeyMasked}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {acc.isActive ? (
                          <span className="px-2 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-[10px] font-black">
                            ATIVA
                          </span>
                        ) : (
                          <button
                            type="button"
                            disabled={isSwitchingAccount}
                            onClick={async () => {
                              if (onSwitchSavedAccount) {
                                await onSwitchSavedAccount(acc.id);
                              } else {
                                const res = await fetch('/api/credentials/switch', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ accountId: acc.id })
                                });
                                const d = await res.json();
                                if (d.ok) {
                                  if (setApiKey) setApiKey(d.apiKey);
                                  if (setApiSecret) setApiSecret(d.apiSecret);
                                  if (Array.isArray(d.savedAccounts)) setLocalSavedAccounts(d.savedAccounts);
                                  await handleSyncClick();
                                }
                              }
                              await onRefreshCredentials?.();
                              setTimeout(() => fetchLiveBitunixPositions(true), 400);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-brand-accent hover:bg-blue-600 text-white text-[10px] font-bold transition-all disabled:opacity-50"
                          >
                            {isSwitchingAccount ? 'Trocando...' : 'Usar Esta'}
                          </button>
                        )}
                        {effectiveSavedAccounts.length > 1 && (
                          <button
                            type="button"
                            title="Remover conta salva"
                            onClick={async () => {
                              try {
                                const res = await fetch(`/api/credentials/accounts/${encodeURIComponent(acc.id)}`, {
                                  method: 'DELETE'
                                });
                                const d = await res.json();
                                if (d.ok) {
                                  if (Array.isArray(d.savedAccounts)) setLocalSavedAccounts(d.savedAccounts);
                                  if (d.apiKey && setApiKey) setApiKey(d.apiKey);
                                  if (d.apiSecret && setApiSecret) setApiSecret(d.apiSecret);
                                  await onRefreshCredentials?.();
                                  addLog(`[CONTA] Conta "${acc.label}" removida da lista salva.`, 'warning');
                                }
                              } catch {}
                            }}
                            className="p-1 text-red-400/60 hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                {showAddAccountForm && (
                  <div className="pt-2 border-t border-brand-border/60 space-y-2">
                    <input
                      type="text"
                      value={newAccountLabel}
                      onChange={(e) => setNewAccountLabel(e.target.value)}
                      placeholder="Nome da Conta (ex: Bitunix Real 2)"
                      className="w-full bg-brand-surface border border-brand-border rounded-lg px-2.5 py-1.5 text-[11px] text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent"
                    />
                    <input
                      type="text"
                      value={newAccountKey}
                      onChange={(e) => setNewAccountKey(e.target.value)}
                      placeholder="Nova API Key Bitunix..."
                      className="w-full bg-brand-surface border border-brand-border rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent"
                    />
                    <input
                      type="password"
                      value={newAccountSecret}
                      onChange={(e) => setNewAccountSecret(e.target.value)}
                      placeholder="Nova Secret Key Bitunix..."
                      className="w-full bg-brand-surface border border-brand-border rounded-lg px-2.5 py-1.5 text-[11px] font-mono text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent"
                    />
                    <button
                      type="button"
                      disabled={isSavingNewAccount || !newAccountLabel.trim() || !newAccountKey.trim() || !newAccountSecret.trim()}
                      onClick={async () => {
                        setIsSavingNewAccount(true);
                        try {
                          const res = await fetch('/api/credentials/accounts', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                              label: newAccountLabel.trim(),
                              apiKey: newAccountKey.trim(),
                              apiSecret: newAccountSecret.trim(),
                              activate: true
                            })
                          });
                          const d = await res.json();
                          if (d.ok) {
                            if (Array.isArray(d.savedAccounts)) setLocalSavedAccounts(d.savedAccounts);
                            if (d.apiKey && setApiKey) setApiKey(d.apiKey);
                            if (d.apiSecret && setApiSecret) setApiSecret(d.apiSecret);
                            await onRefreshCredentials?.();
                            await handleSyncClick();
                            setNewAccountLabel('');
                            setNewAccountKey('');
                            setNewAccountSecret('');
                            setShowAddAccountForm(false);
                            addLog(`[CONTA] Nova conta "${d.activeAccountLabel}" salva e ativada!`, 'success');
                          }
                        } catch {}
                        setIsSavingNewAccount(false);
                      }}
                      className="w-full py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-[11px] font-bold disabled:opacity-40 transition-all"
                    >
                      {isSavingNewAccount ? 'Salvando...' : 'Salvar & Ativar Nova Conta'}
                    </button>
                  </div>
                )}
              </div>

              {/* Form Inputs */}
              <div className="space-y-3.5">
                {/* API Key Input */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-text/60 uppercase tracking-wider flex items-center justify-between">
                    <span>Bitunix API Key</span>
                    <span className="text-[9px] text-brand-text/40 font-normal">Requerido</span>
                  </label>
                  <input
                    type="text"
                    value={apiKey}
                    onChange={(e) => setApiKey && setApiKey(e.target.value)}
                    placeholder="Cole a nova API Key aqui..."
                    className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2.5 text-xs font-mono text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent transition-all"
                  />
                </div>

                {/* API Secret Input */}
                <div className="space-y-1">
                  <label className="text-[10px] font-bold text-brand-text/60 uppercase tracking-wider flex items-center justify-between">
                    <span>Bitunix Secret Key</span>
                    <span className="text-[9px] text-brand-text/40 font-normal">Requerido</span>
                  </label>
                  <div className="relative">
                    <input
                      type={showSecret ? "text" : "password"}
                      value={apiSecret}
                      onChange={(e) => setApiSecret && setApiSecret(e.target.value)}
                      placeholder="Cole a nova Secret Key aqui..."
                      className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2.5 pr-10 text-xs font-mono text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-3 top-3 text-brand-text/40 hover:text-white transition-colors"
                    >
                      {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Telegram Bot Token Input */}
                <div className="space-y-1 pt-2 border-t border-brand-border/40">
                  <label className="text-[10px] font-bold text-sky-400 uppercase tracking-wider flex items-center justify-between">
                    <span className="flex items-center gap-1.5">
                      <Bot className="w-3.5 h-3.5" />
                      <span>Token do Bot Telegram (@BotFather)</span>
                    </span>
                    <a 
                      href="https://t.me/BotFather" 
                      target="_blank" 
                      rel="noreferrer" 
                      className="text-[9px] text-sky-400/80 hover:underline flex items-center gap-0.5"
                    >
                      @BotFather <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </label>
                  <div className="relative">
                    <input
                      type={showTelegramTokenInApiModal ? "text" : "password"}
                      value={apiTelegramToken}
                      onChange={(e) => setApiTelegramToken(e.target.value)}
                      placeholder="Cole o token do Telegram (ex: 792745...)"
                      className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2.5 pr-10 text-xs font-mono text-sky-300 placeholder:text-brand-text/30 outline-none focus:border-sky-500 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowTelegramTokenInApiModal(!showTelegramTokenInApiModal)}
                      className="absolute right-3 top-3 text-brand-text/40 hover:text-white transition-colors"
                    >
                      {showTelegramTokenInApiModal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {/* Google Gemini Vision API Key */}
                <div className="space-y-1.5">
                  <label className="flex items-center justify-between text-xs font-bold text-brand-text/80">
                    <span className="flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-indigo-400"></span>
                      Chave Google Gemini Vision (Leitura de Gráficos/Prints)
                    </span>
                    <a 
                      href="https://aistudio.google.com/app/apikey" 
                      target="_blank" 
                      rel="noreferrer" 
                      className="text-[9px] text-indigo-400/80 hover:underline flex items-center gap-0.5"
                    >
                      Obter Chave Gratuita <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  </label>
                  <div className="relative">
                    <input
                      type={showGeminiKeyInApiModal ? "text" : "password"}
                      value={geminiApiKey}
                      onChange={(e) => setGeminiApiKey(e.target.value)}
                      placeholder="Cole sua API Key do Google AI Studio (ex: AIzaSy...)"
                      className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2.5 pr-10 text-xs font-mono text-indigo-300 placeholder:text-brand-text/30 outline-none focus:border-indigo-500 transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => setShowGeminiKeyInApiModal(!showGeminiKeyInApiModal)}
                      className="absolute right-3 top-3 text-brand-text/40 hover:text-white transition-colors"
                    >
                      {showGeminiKeyInApiModal ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              <div className="p-2.5 bg-brand-bg/50 border border-brand-border/40 rounded-xl flex items-start space-x-2 text-[10px] text-brand-text/50 font-sans">
                <Info className="w-4 h-4 text-brand-accent shrink-0 mt-0.5" />
                <span>
                  As chaves e o token são sincronizados com o servidor e salvos de forma segura para execução contínua de sinais e leitura de imagens.
                </span>
              </div>

              {/* Action buttons */}
              <div className="pt-2 flex flex-col sm:flex-row items-center justify-end gap-2">
                {apiKey || apiSecret || apiTelegramToken || geminiApiKey ? (
                  <button
                    onClick={() => {
                      if (setApiKey) setApiKey('');
                      if (setApiSecret) setApiSecret('');
                      setApiTelegramToken('');
                      setGeminiApiKey('');
                      addLog('[API] Chaves API e token limpos localmente.', 'warning');
                    }}
                    className="w-full sm:w-auto px-3.5 py-2.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 rounded-xl font-bold text-xs transition-all"
                  >
                    Limpar
                  </button>
                ) : null}

                <button
                  onClick={() => setShowApiConfig(false)}
                  className="w-full sm:w-auto px-4 py-2.5 bg-brand-bg hover:bg-brand-border text-brand-text/70 hover:text-white rounded-xl font-bold text-xs border border-brand-border transition-all"
                >
                  Cancelar
                </button>

                <button
                  onClick={async () => {
                    addLog(`[API] Salvando novas chaves e token...`, 'info');
                    try {
                      const res = await fetch('/api/credentials', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                          apiKey: apiKey?.trim() || '',
                          apiSecret: apiSecret?.trim() || '',
                          telegramToken: apiTelegramToken?.trim() || '',
                          geminiApiKey: geminiApiKey?.trim() || ''
                        })
                      });
                      const d = await res.json();
                      if (d.ok && Array.isArray(d.savedAccounts)) {
                        setLocalSavedAccounts(d.savedAccounts);
                      }
                      await onRefreshCredentials?.();
                    } catch (e) {}

                    if (apiKey && apiSecret) {
                      await handleSyncClick();
                    }
                    setShowApiConfig(false);
                    addLog(`[API] Credenciais atualizadas com sucesso!`, 'success');
                  }}
                  disabled={isSyncingBalance}
                  className="w-full sm:w-auto px-5 py-2.5 bg-brand-accent hover:bg-blue-600 text-white rounded-xl font-bold text-xs shadow-lg shadow-brand-accent/20 transition-all flex items-center justify-center space-x-1.5 disabled:opacity-50"
                >
                  <Check className="w-4 h-4" />
                  <span>Salvar & Sincronizar</span>
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Main Grid: Left = Paste & Parser / Manual Input | Right = Parsed Order Card */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6">
        {/* Left Column: Tabbed Input (Colar Sinal vs Digitar Manualmente) */}
        <div className="lg:col-span-7 flex flex-col space-y-4">
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-4 sm:p-5 space-y-4 shadow-lg">
            {/* Mode Switcher Header */}
            <div className="flex items-center justify-between border-b border-brand-border/60 pb-3">
              <div className="grid grid-cols-2 gap-1.5 p-1 bg-brand-bg rounded-xl border border-brand-border w-full">
                <button
                  type="button"
                  onClick={() => setInputMode('paste')}
                  className={`py-2 px-2 sm:px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                    inputMode === 'paste'
                      ? 'bg-brand-accent text-white shadow-md shadow-brand-accent/20'
                      : 'text-brand-text/50 hover:text-white'
                  }`}
                >
                  <ClipboardPaste className="w-3.5 h-3.5" />
                  <span className="truncate">Colar Sinal</span>
                </button>
                <button
                  type="button"
                  onClick={() => setInputMode('manual')}
                  className={`py-2 px-2 sm:px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                    inputMode === 'manual'
                      ? 'bg-brand-accent text-white shadow-md shadow-brand-accent/20'
                      : 'text-brand-text/50 hover:text-white'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span className="truncate">Digitar Ordem</span>
                </button>
              </div>
            </div>

            {/* TAB 1: PASTE SIGNAL TEXT */}
            {inputMode === 'paste' && (
              <div className="space-y-3">
                {/* Incoming Telegram Signal Notification Banner */}
                {telegramSignals.length > 0 && (
                  <div className="p-2 sm:p-2.5 rounded-xl bg-blue-950/40 border border-blue-500/40 flex items-center justify-between gap-2 shadow-md animate-pulse">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center border border-blue-500/30 shrink-0">
                        <Send className="w-3.5 h-3.5" />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[11px] font-bold text-white">📱 Sinal Telegram</span>
                          <span className="text-[9px] px-1.5 py-0.2 rounded bg-blue-500/20 text-blue-300 font-mono truncate max-w-[110px]">
                            {telegramSignals[0].sender}
                          </span>
                        </div>
                        <span className="text-[10px] text-gray-300 font-mono block truncate max-w-[180px] sm:max-w-xs">
                          {telegramSignals[0].text.replace(/\n/g, ' ').substring(0, 50)}...
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          setInputText(telegramSignals[0].text);
                          addLog(`[TELEGRAM] Sinal recebido de ${telegramSignals[0].sender} carregado no painel!`, 'info');
                        }}
                        className="px-2 sm:px-2.5 py-1 sm:py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold rounded-lg transition-colors whitespace-nowrap shadow"
                      >
                        Carregar
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          await fetch('/api/telegram-signals/clear', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ id: telegramSignals[0].id })
                          });
                          setTelegramSignals(prev => prev.filter(s => s.id !== telegramSignals[0].id));
                        }}
                        className="p-1 sm:p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-gray-800/40"
                        title="Dispensar"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                )}

                {/* Hidden File Input for Chart Screenshot */}
                <input
                  type="file"
                  ref={fileInputRef}
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      handleChartImageUpload(file);
                    }
                    e.target.value = '';
                  }}
                />

                {/* Chart Vision Upload Banner */}
                <div className="flex items-center justify-between gap-2 p-2 sm:p-2.5 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-indigo-500/10 border border-blue-500/20 rounded-xl text-xs">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="p-1.5 bg-blue-500/20 rounded-lg text-blue-400 shrink-0">
                      <Camera className="w-4 h-4" />
                    </div>
                    <div className="truncate">
                      <span className="font-semibold text-white block truncate text-xs">Analisar Print com IA</span>
                      <span className="hidden sm:block text-[10px] text-brand-text/60 truncate">Print com Entrada, Stop, Direção e Alvos</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {inputText && (
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(inputText);
                          setCopiedVip(true);
                          setTimeout(() => setCopiedVip(false), 2000);
                        }}
                        className="px-2.5 py-1.5 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400 rounded-lg font-medium text-xs flex items-center gap-1.5 transition-all shadow-sm active:scale-95"
                        title="Copiar texto formatado do sinal para seu Grupo VIP"
                      >
                        {copiedVip ? (
                          <>
                            <Check className="w-3.5 h-3.5" />
                            <span>Copiado p/ VIP!</span>
                          </>
                        ) : (
                          <>
                            <Copy className="w-3.5 h-3.5" />
                            <span>Copiar VIP</span>
                          </>
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={isAnalyzingImage}
                      className="px-2.5 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg font-medium text-xs flex items-center gap-1.5 transition-all shadow-sm active:scale-95"
                    >
                      {isAnalyzingImage ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          <span>Lendo...</span>
                        </>
                      ) : (
                        <>
                          <ImageIcon className="w-3.5 h-3.5" />
                          <span>Carregar Foto</span>
                        </>
                      )}
                    </button>
                  </div>
                </div>

                {imageAnalysisError && (
                  <div className="p-2 bg-rose-500/15 border border-rose-500/30 rounded-xl text-xs text-rose-400 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <span className="flex-1">{imageAnalysisError}</span>
                    <button type="button" onClick={() => setImageAnalysisError(null)} className="p-1 hover:text-white">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                )}

                <div className="relative">
                  <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onPaste={async (e) => {
                      const items = e.clipboardData?.items;
                      if (items) {
                        for (let i = 0; i < items.length; i++) {
                          if (items[i].type.indexOf('image') !== -1) {
                            const file = items[i].getAsFile();
                            if (file) {
                              e.preventDefault();
                              handleChartImageUpload(file);
                              return;
                            }
                          }
                        }
                      }
                    }}
                    placeholder={`Cole o texto do sinal ou dê Ctrl+V em um print do gráfico aqui:

🟢 COMPRA / LONG
MOEDA: BTC/USDT
ALAVANCAGEM: 20X
ENTRADA: 96500
ALVO 1: 98000
STOP LOSS: 94100`}
                    className="w-full h-32 sm:h-44 bg-brand-bg/90 border border-brand-border rounded-xl p-3 sm:p-3.5 text-xs font-mono text-white placeholder:text-brand-text/25 focus:outline-none focus:border-brand-accent transition-all resize-none leading-relaxed"
                  />

                  {parsed && parsed.isValid && (
                    <div 
                      title={`Sinal Reconhecido (${parsed.confidence}% precisão)`}
                      className="absolute bottom-2.5 right-2.5 p-1 bg-emerald-500/20 border border-emerald-500/40 rounded-full text-emerald-400 flex items-center justify-center backdrop-blur-md shadow-md hover:bg-emerald-500/30 transition-all cursor-help"
                    >
                      <Check className="w-3.5 h-3.5 text-emerald-400" />
                    </div>
                  )}
                </div>

                {/* Entry Price Options (1º valor, Preço Médio, 2º valor) */}
                {detectedEntryRange && (
                  <div className="p-2.5 bg-brand-bg/80 border border-brand-border/60 rounded-xl space-y-1.5 shadow-sm">
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 text-[11px] font-bold text-brand-accent">
                        <Target className="w-3.5 h-3.5 text-brand-accent" />
                        <span>Faixa de Entrada:</span>
                      </div>
                      <span className="text-[9.5px] font-mono text-brand-text/60 bg-brand-surface px-1.5 py-0.5 rounded border border-brand-border/50">
                        ${detectedEntryRange.first} ➔ ${detectedEntryRange.second}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('FIRST')}
                        className={`py-1.5 px-2 rounded-lg border transition-all flex flex-col items-center justify-center text-center ${
                          customEntryPrice === detectedEntryRange.first.toString()
                            ? 'bg-brand-accent text-white border-brand-accent shadow-sm font-bold ring-1 ring-white/20'
                            : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/70 hover:text-white hover:border-brand-accent/40'
                        }`}
                      >
                        <span className="text-[8px] uppercase tracking-wide opacity-75 font-sans">1º (Início)</span>
                        <span className="font-mono text-xs font-bold">${detectedEntryRange.first}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('AVERAGE')}
                        className={`py-1.5 px-2 rounded-lg border transition-all flex flex-col items-center justify-center text-center ${
                          customEntryPrice === detectedEntryRange.average.toString()
                            ? 'bg-emerald-600 text-white border-emerald-500 shadow-sm font-bold ring-1 ring-white/20'
                            : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/70 hover:text-white hover:border-emerald-500/40'
                        }`}
                      >
                        <span className="text-[8px] uppercase tracking-wide opacity-75 font-sans">Média</span>
                        <span className="font-mono text-xs font-bold">${detectedEntryRange.average}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('SECOND')}
                        className={`py-1.5 px-2 rounded-lg border transition-all flex flex-col items-center justify-center text-center ${
                          customEntryPrice === detectedEntryRange.second.toString()
                            ? 'bg-brand-accent text-white border-brand-accent shadow-sm font-bold ring-1 ring-white/20'
                            : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/70 hover:text-white hover:border-brand-accent/40'
                        }`}
                      >
                        <span className="text-[8px] uppercase tracking-wide opacity-75 font-sans">2º (Fim)</span>
                        <span className="font-mono text-xs font-bold">${detectedEntryRange.second}</span>
                      </button>
                    </div>
                  </div>
                )}

                {/* Bloco de Alerta de Viabilidade: Armadilha de Taxas */}
                {feeViability && (
                  <div className={`p-3.5 sm:p-4 rounded-xl border transition-all ${
                    feeViability.isTrap
                      ? 'bg-red-950/40 border-red-500/60 shadow-lg shadow-red-950/30 text-white'
                      : feeViability.verdict === 'ATENÇÃO'
                      ? 'bg-amber-950/30 border-amber-500/50 text-white'
                      : 'bg-emerald-950/20 border-emerald-500/30 text-white'
                  }`}>
                    {/* Header */}
                    <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                      <div className="flex items-center gap-2">
                        {feeViability.isTrap ? (
                          <div className="w-7 h-7 rounded-lg bg-red-500/20 text-red-400 flex items-center justify-center border border-red-500/40 shrink-0">
                            <ShieldAlert className="w-4 h-4 text-red-400" />
                          </div>
                        ) : feeViability.verdict === 'ATENÇÃO' ? (
                          <div className="w-7 h-7 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/40 shrink-0">
                            <AlertCircle className="w-4 h-4 text-amber-400" />
                          </div>
                        ) : (
                          <div className="w-7 h-7 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center border border-emerald-500/40 shrink-0">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          </div>
                        )}
                        <div>
                          <h4 className={`text-xs font-black uppercase tracking-wider ${
                            feeViability.isTrap ? 'text-red-400' : feeViability.verdict === 'ATENÇÃO' ? 'text-amber-400' : 'text-emerald-400'
                          }`}>
                            {feeViability.isTrap ? '⚠️ ALERTA DE VIABILIDADE: ARMADILHA DE TAXAS!' : 'ANÁLISE DE VIABILIDADE DE TAXAS'}
                          </h4>
                          <span className="text-[10px] text-gray-300 font-bold">
                            Veredito: <span className={feeViability.isTrap ? 'text-red-300 font-black' : 'text-emerald-300 font-black'}>{feeViability.verdictLabel}</span>
                          </span>
                        </div>
                      </div>

                      {feeViability.isTrap && (
                        <span className="px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider bg-red-500/30 text-red-300 border border-red-500/40">
                          Risco Alto
                        </span>
                      )}
                    </div>

                    {/* Linhas de Análise detalhada */}
                    <div className="pt-2.5 space-y-1.5 text-[11px] font-mono">
                      <div className="flex items-center justify-between text-gray-300">
                        <span>• Taxa Bitunix Estimada:</span>
                        <span className="font-bold text-amber-400">~{feeViability.roundTripFeePct.toFixed(2)}% sobre o volume</span>
                      </div>
                      <div className="flex items-center justify-between text-gray-300">
                        <span>• Alvo 1 (TP 1):</span>
                        <span className={`font-bold ${feeViability.tp1NetGainPct < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                          +{feeViability.tp1RawPct.toFixed(3)}% {feeViability.tp1NetGainPct < 0 ? `❌ Prejuízo Líquido (${feeViability.tp1NetGainPct.toFixed(3)}% pós-taxas)` : '✅ Lucro Real'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-gray-300">
                        <span>• Ponto de Equilíbrio (Zero a Zero):</span>
                        <span className="font-bold text-yellow-300">
                          {feeViability.breakevenTpIndex !== -1
                            ? `Só a partir de ${feeViability.breakevenPrice} (TP ${feeViability.breakevenTpIndex})`
                            : '❌ NENHUM alvo paga as taxas!'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-gray-300">
                        <span>• Último Alvo (TP {feeViability.targets.length}):</span>
                        <span className="font-bold text-amber-300">
                          +{feeViability.finalTpRawPct.toFixed(3)}% {feeViability.isTrap ? `⚠️ ~${feeViability.feeEatenPercent.toFixed(0)}% do lucro vai para a corretora` : ''}
                        </span>
                      </div>
                      <div className="mt-2 p-2 bg-black/40 rounded-lg border border-white/10 text-[10.5px] text-gray-200 font-sans leading-relaxed">
                        💡 {feeViability.explanation}
                      </div>
                    </div>

                    {feeViability.isTrap && (
                      <div className="mt-3 pt-2.5 border-t border-red-500/20 flex items-center justify-between gap-2">
                        <span className="text-[10px] text-red-300/80 italic">
                          Deseja ignorar este sinal para poupar sua banca?
                        </span>
                        <button
                          type="button"
                          onClick={handleDiscardSignal}
                          className="px-3 py-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-bold text-[11px] transition-all flex items-center gap-1.5 shadow"
                        >
                          <XCircle className="w-3.5 h-3.5" />
                          <span>Descartar Sinal</span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* TAB 2: MANUAL INPUT OF ORDER PARAMETERS */}
            {inputMode === 'manual' && (
              <div className="space-y-4 font-mono">
                {/* 1. Nome da Moeda / Par */}
                <div className="space-y-2 bg-brand-bg/40 p-3 sm:p-3.5 rounded-xl border border-brand-border/60">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5">
                    <label className="text-[10px] font-bold text-brand-text/60 uppercase flex items-center gap-1.5">
                      <Coins className="w-3.5 h-3.5 text-brand-accent" />
                      <span>Nome da Moeda / Par na Bitunix</span>
                    </label>
                    <span className="text-[9px] text-brand-text/40">Aceita BTC, SOL, ETH, BTCUSDT...</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type="text"
                        placeholder="Ex: BTC, SOL, ETH, DOGE, XRP..."
                        value={customSymbol}
                        onChange={(e) => setCustomSymbol(e.target.value.toUpperCase().replace(/\s+/g, ''))}
                        className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2.5 text-xs sm:text-sm font-bold text-white outline-none focus:border-brand-accent placeholder:text-brand-text/25 uppercase"
                      />
                      {customSymbol && (
                        <button
                          onClick={() => setCustomSymbol('')}
                          className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 text-brand-text/40 hover:text-white"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={() => handleFetchCurrentPrice()}
                      disabled={isLoadingPrice || !customSymbol}
                      className="px-3.5 py-2.5 bg-brand-accent/20 hover:bg-brand-accent text-brand-accent hover:text-white border border-brand-accent/40 rounded-xl text-xs font-bold transition-all flex items-center gap-1.5 shrink-0 disabled:opacity-40"
                      title="Buscar cotação em tempo real na Bitunix"
                    >
                      <RefreshCw className={`w-3.5 h-3.5 ${isLoadingPrice ? 'animate-spin' : ''}`} />
                      <span>{isLoadingPrice ? 'Buscando...' : 'Preço Atual'}</span>
                    </button>
                  </div>
                </div>

                {/* 2. Direção & Alavancagem */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Direção */}
                  <div className="space-y-1.5 bg-brand-bg/40 p-3 rounded-xl border border-brand-border/60">
                    <label className="text-[10px] font-bold text-brand-text/60 uppercase block">Direção da Operação</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setCustomDirection('LONG')}
                        className={`py-2.5 px-3 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 ${
                          customDirection === 'LONG'
                            ? 'bg-brand-success text-white shadow-lg shadow-brand-success/20 border border-brand-success'
                            : 'bg-brand-bg text-brand-text/50 border border-brand-border hover:text-white'
                        }`}
                      >
                        <TrendingUp className="w-4 h-4" />
                        <span>LONG (Compra)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setCustomDirection('SHORT')}
                        className={`py-2.5 px-3 rounded-xl font-black text-xs transition-all flex items-center justify-center gap-1.5 ${
                          customDirection === 'SHORT'
                            ? 'bg-brand-danger text-white shadow-lg shadow-brand-danger/20 border border-brand-danger'
                            : 'bg-brand-bg text-brand-text/50 border border-brand-border hover:text-white'
                        }`}
                      >
                        <TrendingDown className="w-4 h-4" />
                        <span>SHORT (Venda)</span>
                      </button>
                    </div>
                  </div>

                  {/* Alavancagem */}
                  <div className="space-y-1.5 bg-brand-bg/40 p-3 rounded-xl border border-brand-border/60">
                    <div className="flex items-center justify-between">
                      <label className="text-[10px] font-bold text-brand-text/60 uppercase">Alavancagem (1x a 125x)</label>
                      <div className="flex items-center gap-1">
                        <input
                          type="number"
                          min="1"
                          max="125"
                          value={customLeverage}
                          onChange={(e) => setCustomLeverage(Math.max(1, Math.min(125, parseInt(e.target.value) || 1)))}
                          className="w-16 bg-brand-bg border border-brand-accent rounded-lg px-2 py-0.5 text-xs font-bold text-brand-accent text-center outline-none"
                        />
                        <span className="text-xs font-bold text-brand-accent">x</span>
                      </div>
                    </div>

                    <div className="grid grid-cols-5 gap-1 pt-1">
                      {[5, 10, 20, 25, 50, 75, 100].map((lev) => (
                        <button
                          key={lev}
                          type="button"
                          onClick={() => setCustomLeverage(lev)}
                          className={`py-1 rounded-lg text-[9.5px] font-bold border transition-all ${
                            customLeverage === lev
                              ? 'bg-brand-accent text-white border-brand-accent shadow'
                              : 'bg-brand-bg border-brand-border/50 text-brand-text/50 hover:text-white'
                          }`}
                        >
                          {lev}x
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* 3. Tipo de Ordem & Preço de Entrada */}
                <div className="space-y-2 bg-brand-bg/40 p-3 sm:p-3.5 rounded-xl border border-brand-border/60">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-brand-text/60 uppercase">Preço de Entrada & Tipo</label>
                    <div className="flex bg-brand-bg p-0.5 rounded-lg border border-brand-border">
                      <button
                        type="button"
                        onClick={() => setCustomOrderType('MARKET')}
                        className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all ${
                          customOrderType === 'MARKET' ? 'bg-brand-accent text-white shadow' : 'text-brand-text/40 hover:text-white'
                        }`}
                      >
                        A MERCADO
                      </button>
                      <button
                        type="button"
                        onClick={() => setCustomOrderType('LIMIT')}
                        className={`px-2.5 py-1 text-[10px] font-bold rounded-md transition-all ${
                          customOrderType === 'LIMIT' ? 'bg-brand-accent text-white shadow' : 'text-brand-text/40 hover:text-white'
                        }`}
                      >
                        ORDEM LIMITE
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-1">
                    <div className="sm:col-span-8 relative">
                      <input
                        type="text"
                        placeholder={customOrderType === 'MARKET' ? 'Execução a Mercado (Preço Atual)' : 'Ex: 96500 ou 605.60 - 605.15'}
                        value={customEntryPrice}
                        onChange={(e) => setCustomEntryPrice(e.target.value)}
                        className="w-full bg-brand-bg border border-brand-border rounded-xl px-3.5 py-2 text-xs font-bold text-white outline-none focus:border-brand-accent placeholder:text-brand-text/30"
                      />
                    </div>
                    <div className="sm:col-span-4">
                      <button
                        type="button"
                        onClick={() => handleFetchCurrentPrice()}
                        disabled={isLoadingPrice || !customSymbol}
                        className="w-full h-full py-2 px-3 bg-brand-bg hover:bg-brand-surface border border-brand-border rounded-xl text-xs font-bold text-brand-text/70 hover:text-white transition-all flex items-center justify-center gap-1.5 disabled:opacity-40"
                      >
                        <RefreshCw className={`w-3 h-3 ${isLoadingPrice ? 'animate-spin' : ''}`} />
                        <span>Usar Preço Atual</span>
                      </button>
                    </div>
                  </div>

                  {/* Multi-entry / Range options in Manual Mode */}
                  {detectedEntryRange && (
                    <div className="pt-2 border-t border-brand-border/40 space-y-1.5">
                      <div className="flex items-center justify-between text-[9px]">
                        <span className="font-bold text-brand-accent flex items-center gap-1">
                          <Target className="w-3 h-3" />
                          <span>Opções da Zona de Entrada:</span>
                        </span>
                        <span className="text-brand-text/50 font-mono">
                          ${detectedEntryRange.first} ➔ ${detectedEntryRange.second}
                        </span>
                      </div>

                      <div className="grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleSelectEntryPriceOption('FIRST')}
                          className={`py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all text-center ${
                            customEntryPrice === detectedEntryRange.first.toString()
                              ? 'bg-brand-accent text-white border-brand-accent shadow'
                              : 'bg-brand-bg/80 border-brand-border/60 text-brand-text/60 hover:text-white'
                          }`}
                        >
                          <span className="block text-[8px] opacity-70">1º Valor</span>
                          <span className="font-mono font-bold">${detectedEntryRange.first}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSelectEntryPriceOption('AVERAGE')}
                          className={`py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all text-center relative ${
                            customEntryPrice === detectedEntryRange.average.toString()
                              ? 'bg-emerald-600 text-white border-emerald-500 shadow'
                              : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:text-emerald-300'
                          }`}
                        >
                          <span className="block text-[8px] opacity-80 font-black">Preço Médio</span>
                          <span className="font-mono font-bold">${detectedEntryRange.average}</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => handleSelectEntryPriceOption('SECOND')}
                          className={`py-1.5 px-2 rounded-lg text-[10px] font-bold border transition-all text-center ${
                            customEntryPrice === detectedEntryRange.second.toString()
                              ? 'bg-brand-accent text-white border-brand-accent shadow'
                              : 'bg-brand-bg/80 border-brand-border/60 text-brand-text/60 hover:text-white'
                          }`}
                        >
                          <span className="block text-[8px] opacity-70">2º Valor</span>
                          <span className="font-mono font-bold">${detectedEntryRange.second}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* 4. Stop Loss (SL) */}
                <div className="space-y-2 bg-brand-bg/40 p-3 sm:p-3.5 rounded-xl border border-brand-border/60">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-brand-danger uppercase flex items-center gap-1.5">
                      <Shield className="w-3.5 h-3.5" />
                      <span>Stop Loss (Stop de Proteção)</span>
                    </label>
                    {customSL && customEntryPrice && parseFloat(customEntryPrice) > 0 && (
                      <span className="text-[9px] font-bold text-brand-danger px-2 py-0.5 bg-brand-danger/10 border border-brand-danger/30 rounded-lg">
                        {((Math.abs(parseFloat(customSL) - parseFloat(customEntryPrice)) / parseFloat(customEntryPrice)) * 100).toFixed(2)}% de distância
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Ex: 94100 (Preço do Stop Loss)"
                      value={customSL}
                      onChange={(e) => setCustomSL(e.target.value)}
                      className="flex-1 bg-brand-bg border border-brand-danger/40 focus:border-brand-danger rounded-xl px-3.5 py-2 text-xs font-bold text-brand-danger outline-none placeholder:text-brand-text/25"
                    />
                    {customSL && (
                      <button
                        type="button"
                        onClick={() => setCustomSL('')}
                        className="p-2 text-brand-text/40 hover:text-brand-danger rounded-lg"
                        title="Limpar Stop Loss"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Quick SL Percent Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[9px] font-bold text-brand-text/40 uppercase mr-1">Calcular SL:</span>
                    {[1, 2, 3, 5, 10].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => handleApplyQuickSLPercent(pct)}
                        className="px-2.5 py-1 bg-brand-danger/10 hover:bg-brand-danger/25 text-brand-danger border border-brand-danger/30 rounded-lg text-[9.5px] font-bold transition-colors"
                      >
                        -{pct}%
                      </button>
                    ))}
                  </div>
                </div>

                {/* 5. Take Profit (TP) */}
                <div className="space-y-2 bg-brand-bg/40 p-3 sm:p-3.5 rounded-xl border border-brand-border/60">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-brand-success uppercase flex items-center gap-1.5">
                      <Target className="w-3.5 h-3.5" />
                      <span>Take Profit (Alvo de Lucro)</span>
                    </label>
                    {customTPs.length > 0 && customTPs[0] && customEntryPrice && parseFloat(customEntryPrice) > 0 && (
                      <span className="text-[9px] font-bold text-brand-success px-2 py-0.5 bg-brand-success/10 border border-brand-success/30 rounded-lg">
                        +{((Math.abs(parseFloat(customTPs[0]) - parseFloat(customEntryPrice)) / parseFloat(customEntryPrice)) * 100).toFixed(2)}% de lucro
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="Ex: 98000 (Preço do Take Profit)"
                      value={customTPs[0] || ''}
                      onChange={(e) => {
                        const val = e.target.value;
                        setCustomTPs(val ? [val] : []);
                        setSelectedTpIndex(0);
                      }}
                      className="flex-1 bg-brand-bg border border-brand-success/40 focus:border-brand-success rounded-xl px-3.5 py-2 text-xs font-bold text-brand-success outline-none placeholder:text-brand-text/25"
                    />
                    {customTPs.length > 0 && customTPs[0] && (
                      <button
                        type="button"
                        onClick={() => {
                          setCustomTPs([]);
                          setSelectedTpIndex(null);
                        }}
                        className="p-2 text-brand-text/40 hover:text-brand-success rounded-lg"
                        title="Limpar Take Profit"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>

                  {/* Quick TP Percent Buttons */}
                  <div className="flex flex-wrap items-center gap-1.5 pt-1">
                    <span className="text-[9px] font-bold text-brand-text/40 uppercase mr-1">Calcular TP:</span>
                    {[1, 2, 3, 5, 10].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => handleApplyQuickTPPercent(pct)}
                        className="px-2.5 py-1 bg-brand-success/10 hover:bg-brand-success/25 text-brand-success border border-brand-success/30 rounded-lg text-[9.5px] font-bold transition-colors"
                      >
                        +{pct}%
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Signal Preview Card & One-Click Execution */}
        <div className="lg:col-span-5 flex flex-col">
          <div className="bg-brand-surface border border-brand-border rounded-2xl p-3.5 sm:p-5 space-y-4 sm:space-y-5 shadow-xl relative overflow-hidden flex-1 flex flex-col justify-between">
            <div className="space-y-3 sm:space-y-4">
              <div className="flex items-center justify-between pb-3 border-b border-brand-border">
                <div className="flex items-center space-x-2">
                  <div className="p-1.5 bg-yellow-500/20 rounded-lg text-yellow-500">
                    <Zap className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-bold uppercase tracking-wider text-white">
                    Parâmetros para Execução
                  </span>
                </div>
                <span className="text-[10px] px-2 py-0.5 rounded font-mono font-bold bg-brand-bg text-brand-text/50">
                  {parsed?.parsedAt || 'Aguardando'}
                </span>
              </div>

              {/* Symbol & Direction Selection */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-brand-text/40 uppercase">Par na Bitunix</label>
                  <input
                    type="text"
                    placeholder="Aguardando sinal..."
                    value={customSymbol}
                    onChange={(e) => setCustomSymbol(e.target.value.toUpperCase())}
                    className="w-full bg-brand-bg border border-brand-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-white outline-none focus:border-brand-accent placeholder:text-brand-text/30"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-brand-text/40 uppercase">Direção</label>
                  <div className="grid grid-cols-2 gap-1 bg-brand-bg p-1 rounded-xl border border-brand-border">
                    <button
                      onClick={() => setCustomDirection('LONG')}
                      className={`py-1.5 text-[10px] font-black rounded-lg transition-all flex items-center justify-center space-x-1 ${customDirection === 'LONG' ? 'bg-brand-success text-white shadow-lg' : 'text-brand-text/40'}`}
                    >
                      <TrendingUp className="w-3 h-3" />
                      <span>LONG</span>
                    </button>
                    <button
                      onClick={() => setCustomDirection('SHORT')}
                      className={`py-1.5 text-[10px] font-black rounded-lg transition-all flex items-center justify-center space-x-1 ${customDirection === 'SHORT' ? 'bg-brand-danger text-white shadow-lg' : 'text-brand-text/40'}`}
                    >
                      <TrendingDown className="w-3 h-3" />
                      <span>SHORT</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* Order Type & Entry Price */}
              <div className="space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-brand-text/40 uppercase">Tipo de Ordem</label>
                    <div className="grid grid-cols-2 gap-1 bg-brand-bg p-1 rounded-xl border border-brand-border">
                      <button
                        onClick={() => setCustomOrderType('MARKET')}
                        className={`py-1.5 text-[9px] font-bold rounded-lg transition-all ${customOrderType === 'MARKET' ? 'bg-brand-accent text-white' : 'text-brand-text/40'}`}
                      >
                        MERCADO
                      </button>
                      <button
                        onClick={() => setCustomOrderType('LIMIT')}
                        className={`py-1.5 text-[9px] font-bold rounded-lg transition-all ${customOrderType === 'LIMIT' ? 'bg-brand-accent text-white' : 'text-brand-text/40'}`}
                      >
                        LIMITE
                      </button>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <label className="text-[9px] font-bold text-brand-text/40 uppercase">
                        {customOrderType === 'MARKET' ? 'Preço Estimado' : 'Preço Limite'}
                      </label>
                      {detectedEntryRange && customOrderType === 'LIMIT' && (
                        <span className="text-[8.5px] font-bold text-brand-accent font-mono">
                          Faixa: {detectedEntryRange.first} - {detectedEntryRange.second}
                        </span>
                      )}
                    </div>
                    <input
                      type="text"
                      placeholder={customOrderType === 'MARKET' ? 'A Mercado' : 'Ex: 65200'}
                      value={customEntryPrice}
                      onChange={(e) => setCustomEntryPrice(e.target.value)}
                      disabled={customOrderType === 'MARKET'}
                      className="w-full bg-brand-bg border border-brand-border rounded-xl px-3 py-2 text-xs font-mono font-bold text-white outline-none focus:border-brand-accent disabled:opacity-50"
                    />
                  </div>
                </div>

                {/* Quick entry selection strip if range exists */}
                {detectedEntryRange && customOrderType === 'LIMIT' && (
                  <div className="p-2 bg-brand-bg/60 border border-brand-border/60 rounded-xl space-y-1">
                    <div className="flex items-center justify-between text-[8.5px] font-bold text-brand-text/50">
                      <span>Escolher Valor da Entrada:</span>
                      <span className="text-emerald-400">Média: ${detectedEntryRange.average}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('FIRST')}
                        className={`py-1.5 px-1 rounded-lg text-[9px] font-bold border transition-all text-center truncate ${
                          customEntryPrice === detectedEntryRange.first.toString()
                            ? 'bg-brand-accent text-white border-brand-accent shadow'
                            : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/60 hover:text-white'
                        }`}
                        title={`1º Valor: ${detectedEntryRange.first}`}
                      >
                        <span className="opacity-70">1º:</span> ${detectedEntryRange.first}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('AVERAGE')}
                        className={`py-1.5 px-1 rounded-lg text-[9px] font-bold border transition-all text-center truncate ${
                          customEntryPrice === detectedEntryRange.average.toString()
                            ? 'bg-emerald-600 text-white border-emerald-500 shadow'
                            : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400 hover:text-emerald-300'
                        }`}
                        title={`Preço Médio: ${detectedEntryRange.average}`}
                      >
                        <span className="opacity-80">Médio:</span> ${detectedEntryRange.average}
                      </button>

                      <button
                        type="button"
                        onClick={() => handleSelectEntryPriceOption('SECOND')}
                        className={`py-1.5 px-1 rounded-lg text-[9px] font-bold border transition-all text-center truncate ${
                          customEntryPrice === detectedEntryRange.second.toString()
                            ? 'bg-brand-accent text-white border-brand-accent shadow'
                            : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/60 hover:text-white'
                        }`}
                        title={`2º Valor: ${detectedEntryRange.second}`}
                      >
                        <span className="opacity-70">2º:</span> ${detectedEntryRange.second}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Leverage Selector */}
              <div className="space-y-1.5">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-1.5">
                    <label className="text-[9px] font-bold text-brand-text/40 uppercase">Alavancagem</label>
                    {!canEditLeverage && (
                      <span className="text-[9px] font-bold text-amber-400 bg-amber-500/10 px-1.5 py-0.2 rounded border border-amber-500/20 flex items-center gap-0.5">
                        <Lock className="w-2.5 h-2.5" /> Fixada do Sinal
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      min="1"
                      max="125"
                      disabled={!canEditLeverage}
                      value={customLeverage}
                      onChange={(e) => setCustomLeverage(Math.max(1, Math.min(125, parseInt(e.target.value) || 1)))}
                      className="w-14 bg-brand-bg border border-brand-accent rounded-lg px-1.5 py-0.5 text-xs font-mono font-bold text-brand-accent text-center outline-none disabled:opacity-80"
                    />
                    <span className="text-xs font-mono font-bold text-brand-accent">x</span>
                  </div>
                </div>
                {canEditLeverage && (
                  <div className="grid grid-cols-6 gap-1">
                    {[5, 10, 20, 25, 50, 75].map((lev) => (
                      <button
                        key={lev}
                        onClick={() => setCustomLeverage(lev)}
                        className={`py-1 rounded-lg text-[10px] font-bold border transition-all ${
                          customLeverage === lev
                            ? 'bg-brand-accent/20 border-brand-accent text-brand-accent'
                            : 'bg-brand-bg/50 border-brand-border/40 text-brand-text/40'
                        }`}
                      >
                        {lev}x
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Position Margin Selector */}
              <div className="space-y-2.5 bg-brand-bg/40 p-3 rounded-xl border border-brand-border/40">
                {!canEditRisk ? (
                  /* Modo Simplificado para o Leo: Sem sobreposição, discreto e estruturado */
                  <div className="p-3 rounded-xl bg-emerald-950/20 border border-emerald-500/25 space-y-2">
                    <div className="flex items-center justify-between gap-2 border-b border-emerald-500/15 pb-2">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-md bg-emerald-500/15 text-emerald-400 flex items-center justify-center border border-emerald-500/20 shrink-0">
                          <ShieldCheck className="w-3.5 h-3.5" />
                        </div>
                        <span className="text-xs font-bold text-gray-200">
                          Risco: <span className="text-emerald-400">{sharedSettings.maxRiskPercent}% da conta</span>
                        </span>
                      </div>

                      <div className="text-right">
                        <span className="text-[10px] font-bold text-gray-400 mr-1.5 uppercase">Margem:</span>
                        <span className="text-sm font-black font-mono text-emerald-400">
                          ${calculatedRiskMargin > 0 ? calculatedRiskMargin.toFixed(2) : (initialBalance * (sharedSettings.maxRiskPercent / 100)).toFixed(2)}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-[10px] font-mono text-gray-400 pt-0.5">
                      <span>Perda no Stop: <strong className="text-red-400 font-bold">-${(initialBalance * (sharedSettings.maxRiskPercent / 100)).toFixed(2)} USD</strong></span>
                      {customSL && <span>Stop: <strong className="text-gray-300 font-bold">${customSL}</strong></span>}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[10px] font-bold uppercase text-brand-text/60 flex items-center gap-1.5">
                          <Sliders className="w-3.5 h-3.5 text-brand-accent" />
                          <span>Margem / Gestão de Risco</span>
                        </span>
                      </div>
                      <div className="flex bg-brand-bg p-0.5 rounded-lg border border-brand-border/60 overflow-x-auto custom-scrollbar">
                        <button
                          type="button"
                          onClick={() => setMarginType('USD')}
                          className={`px-2 py-1 text-[9px] font-bold rounded-md transition-all whitespace-nowrap ${
                            marginType === 'USD' ? 'bg-brand-accent text-white shadow' : 'text-brand-text/50 hover:text-white'
                          }`}
                          title="Margem fixa em Dólares (USD)"
                        >
                          $ Margem
                        </button>
                        <button
                          type="button"
                          onClick={() => setMarginType('PERCENT')}
                          className={`px-2 py-1 text-[9px] font-bold rounded-md transition-all whitespace-nowrap ${
                            marginType === 'PERCENT' ? 'bg-brand-accent text-white shadow' : 'text-brand-text/50 hover:text-white'
                          }`}
                          title="Margem fixa em % da Conta"
                        >
                          % Margem
                        </button>
                        <button
                          type="button"
                          onClick={() => setMarginType('RISK_USD')}
                          className={`px-2 py-1 text-[9px] font-bold rounded-md transition-all whitespace-nowrap flex items-center gap-1 ${
                            marginType === 'RISK_USD' ? 'bg-red-500/20 text-red-400 border border-red-500/40 shadow' : 'text-brand-text/50 hover:text-red-400'
                          }`}
                          title="Calcular margem baseada na perda máxima em dólares ($) se bater o Stop Loss"
                        >
                          <Shield className="w-2.5 h-2.5" />
                          <span>$ Perda</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setMarginType('RISK_PERCENT')}
                          className={`px-2 py-1 text-[9px] font-bold rounded-md transition-all whitespace-nowrap flex items-center gap-1 ${
                            marginType === 'RISK_PERCENT' ? 'bg-red-500/20 text-red-400 border border-red-500/40 shadow' : 'text-brand-text/50 hover:text-red-400'
                          }`}
                          title="Calcular margem baseada na perda máxima em % da sua conta se bater o Stop Loss"
                        >
                          <Shield className="w-2.5 h-2.5" />
                          <span>% Perda</span>
                        </button>
                      </div>
                    </div>

                {marginType === 'USD' && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-5 gap-1">
                      {[10, 20, 50, 100, 200].map((amount) => (
                        <button
                          key={amount}
                          type="button"
                          onClick={() => setCustomMargin(amount)}
                          className={`py-1 text-[10px] font-bold rounded-lg border transition-all ${customMargin === amount ? 'bg-brand-accent/20 border-brand-accent text-brand-accent' : 'bg-brand-bg border-brand-border/40 text-brand-text/40'}`}
                        >
                          ${amount}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center space-x-2">
                      <span className="text-[9px] text-brand-text/40">Personalizado ($):</span>
                      <input
                        type="number"
                        min="1"
                        max="10000"
                        value={customMargin}
                        onChange={(e) => setCustomMargin(parseFloat(e.target.value) || 0)}
                        className="flex-1 bg-brand-bg border border-brand-border rounded-lg px-2 py-1 text-xs font-mono font-bold text-white outline-none focus:border-brand-accent"
                      />
                    </div>
                  </div>
                )}

                {marginType === 'PERCENT' && (
                  <div className="space-y-2">
                    <div className="grid grid-cols-4 gap-1">
                      {[2, 5, 10, 20].map((pct) => (
                        <button
                          key={pct}
                          type="button"
                          onClick={() => setCustomMarginPercent(pct)}
                          className={`py-1 text-[10px] font-bold rounded-lg border transition-all ${customMarginPercent === pct ? 'bg-brand-accent/20 border-brand-accent text-brand-accent' : 'bg-brand-bg border-brand-border/40 text-brand-text/40'}`}
                        >
                          {pct}%
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {marginType === 'RISK_USD' && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-red-400 uppercase flex items-center gap-1">
                        <Shield className="w-3 h-3 text-red-400" />
                        Perda Financeira Fixa se Bater Stop Loss:
                      </span>
                      <span className="text-xs font-mono font-bold text-red-400">-${customRiskUSD.toFixed(2)} USD</span>
                    </div>

                    <div className="grid grid-cols-5 gap-1">
                      {[5, 10, 20, 50, 100].map((riskVal) => (
                        <button
                          key={riskVal}
                          type="button"
                          onClick={() => setCustomRiskUSD(riskVal)}
                          className={`py-1 text-[10px] font-bold rounded-lg border transition-all ${customRiskUSD === riskVal ? 'bg-red-500/20 border-red-500/60 text-red-400' : 'bg-brand-bg border-brand-border/40 text-brand-text/40 hover:text-white'}`}
                        >
                          ${riskVal}
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center space-x-2">
                      <span className="text-[9px] text-brand-text/40">Definir Perda ($):</span>
                      <input
                        type="number"
                        min="1"
                        max="5000"
                        step="1"
                        value={customRiskUSD}
                        onChange={(e) => setCustomRiskUSD(parseFloat(e.target.value) || 0)}
                        placeholder="Ex: 10"
                        className="flex-1 bg-brand-bg border border-brand-border rounded-lg px-2 py-1 text-xs font-mono font-bold text-white outline-none focus:border-red-400"
                      />
                    </div>

                    {/* Fees Consideration Toggle */}
                    <div className="p-2 bg-brand-bg/60 rounded-xl border border-brand-border/40 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-1.5 cursor-pointer text-[9px] font-bold text-brand-text/70 hover:text-white select-none">
                          <input
                            type="checkbox"
                            checked={includeFeesInRisk}
                            onChange={(e) => setIncludeFeesInRisk(e.target.checked)}
                            className="rounded border-brand-border text-brand-accent focus:ring-0 w-3.5 h-3.5 bg-brand-bg"
                          />
                          <span>Incluir Taxas de Trading na Perda Máxima</span>
                        </label>
                        <span className="text-[8px] font-mono text-brand-accent bg-brand-accent/10 px-1.5 py-0.5 rounded border border-brand-accent/20">
                          {includeFeesInRisk ? `Taxa Total: ${(tradingFeeRate * 2).toFixed(2)}%` : 'Sem taxas'}
                        </span>
                      </div>

                      {includeFeesInRisk && (
                        <div className="flex items-center justify-between pt-1 border-t border-brand-border/30 text-[9px] text-brand-text/50">
                          <span>Taxa Bitunix por ordem (Entrada + Stop):</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0.01"
                              max="1"
                              step="0.01"
                              value={tradingFeeRate}
                              onChange={(e) => setTradingFeeRate(parseFloat(e.target.value) || 0)}
                              className="w-14 bg-brand-bg border border-brand-border rounded px-1.5 py-0.5 text-[9px] font-mono text-white text-right outline-none focus:border-brand-accent"
                            />
                            <span className="font-mono text-white">% perna</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Risk calculation feedback */}
                    {slDistancePercent > 0 ? (
                      <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl space-y-1.5 font-mono text-[10px]">
                        <div className="flex justify-between items-center text-emerald-400 font-bold">
                          <span>Margem Calculada ({customLeverage}x):</span>
                          <span className="text-xs px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/40 rounded-lg">
                            ${calculatedRiskMargin.toFixed(2)} USD
                          </span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px] pt-1 border-t border-brand-border/30">
                          <span>Distância até o Stop Loss:</span>
                          <span className="text-red-400 font-bold">{(slDistancePercent * 100).toFixed(2)}%</span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px]">
                          <span>Perda pelo Preço (PnL):</span>
                          <span className="text-red-400">-${estimatedPriceLoss.toFixed(2)} USD</span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px]">
                          <span>Custo de Taxas (Entrada + Stop):</span>
                          <span className="text-yellow-400">-${estimatedFeesCost.toFixed(2)} USD</span>
                        </div>
                        <div className="flex justify-between text-white font-bold text-[9px] pt-1 border-t border-brand-border/30">
                          <span>Perda Total Real no Stop (Preço + Taxas):</span>
                          <span className="text-red-400 font-bold">-${(estimatedPriceLoss + estimatedFeesCost).toFixed(2)} USD</span>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-[9px] text-yellow-300 flex items-start gap-1.5">
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-yellow-400" />
                        <span>
                          Para calcular a margem baseada na perda exata em $, certifique-se que o sinal possui Preço de Entrada e Stop Loss definidos abaixo.
                        </span>
                      </div>
                    )}
                  </div>
                )}

                {marginType === 'RISK_PERCENT' && (
                  <div className="space-y-2.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[9px] font-bold text-red-400 uppercase flex items-center gap-1">
                        <Shield className="w-3 h-3 text-red-400" />
                        Perda (% da Conta) se Bater Stop Loss:
                      </span>
                      <span className="text-xs font-mono font-bold text-red-400">
                        {customRiskPercent}% (-${targetRiskUSD.toFixed(2)} USD)
                      </span>
                    </div>

                    <div className="grid grid-cols-5 gap-1">
                      {[0.5, 1, 2, 3, 5].map((riskPct) => (
                        <button
                          key={riskPct}
                          type="button"
                          onClick={() => setCustomRiskPercent(riskPct)}
                          className={`py-1 text-[10px] font-bold rounded-lg border transition-all ${customRiskPercent === riskPct ? 'bg-red-500/20 border-red-500/60 text-red-400' : 'bg-brand-bg border-brand-border/40 text-brand-text/40 hover:text-white'}`}
                        >
                          {riskPct}%
                        </button>
                      ))}
                    </div>

                    <div className="flex items-center space-x-2">
                      <span className="text-[9px] text-brand-text/40">Definir Perda (% da Conta):</span>
                      <input
                        type="number"
                        min="0.1"
                        max="100"
                        step="0.5"
                        value={customRiskPercent}
                        onChange={(e) => setCustomRiskPercent(parseFloat(e.target.value) || 0)}
                        placeholder="Ex: 2"
                        className="flex-1 bg-brand-bg border border-brand-border rounded-lg px-2 py-1 text-xs font-mono font-bold text-white outline-none focus:border-red-400"
                      />
                    </div>

                    {/* Fees Consideration Toggle */}
                    <div className="p-2 bg-brand-bg/60 rounded-xl border border-brand-border/40 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-1.5 cursor-pointer text-[9px] font-bold text-brand-text/70 hover:text-white select-none">
                          <input
                            type="checkbox"
                            checked={includeFeesInRisk}
                            onChange={(e) => setIncludeFeesInRisk(e.target.checked)}
                            className="rounded border-brand-border text-brand-accent focus:ring-0 w-3.5 h-3.5 bg-brand-bg"
                          />
                          <span>Incluir Taxas de Trading na Perda Máxima</span>
                        </label>
                        <span className="text-[8px] font-mono text-brand-accent bg-brand-accent/10 px-1.5 py-0.5 rounded border border-brand-accent/20">
                          {includeFeesInRisk ? `Taxa Total: ${(tradingFeeRate * 2).toFixed(2)}%` : 'Sem taxas'}
                        </span>
                      </div>

                      {includeFeesInRisk && (
                        <div className="flex items-center justify-between pt-1 border-t border-brand-border/30 text-[9px] text-brand-text/50">
                          <span>Taxa Bitunix por ordem (Entrada + Stop):</span>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              min="0.01"
                              max="1"
                              step="0.01"
                              value={tradingFeeRate}
                              onChange={(e) => setTradingFeeRate(parseFloat(e.target.value) || 0)}
                              className="w-14 bg-brand-bg border border-brand-border rounded px-1.5 py-0.5 text-[9px] font-mono text-white text-right outline-none focus:border-brand-accent"
                            />
                            <span className="font-mono text-white">% perna</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Risk calculation feedback */}
                    {slDistancePercent > 0 ? (
                      <div className="p-2.5 bg-red-500/10 border border-red-500/30 rounded-xl space-y-1.5 font-mono text-[10px]">
                        <div className="flex justify-between items-center text-emerald-400 font-bold">
                          <span>Margem Calculada ({customLeverage}x):</span>
                          <span className="text-xs px-2 py-0.5 bg-emerald-500/20 border border-emerald-500/40 rounded-lg">
                            ${calculatedRiskMargin.toFixed(2)} USD
                          </span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px] pt-1 border-t border-brand-border/30">
                          <span>Distância até o Stop Loss:</span>
                          <span className="text-red-400 font-bold">{(slDistancePercent * 100).toFixed(2)}%</span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px]">
                          <span>Perda pelo Preço (PnL):</span>
                          <span className="text-red-400">-${estimatedPriceLoss.toFixed(2)} USD</span>
                        </div>
                        <div className="flex justify-between text-brand-text/60 text-[9px]">
                          <span>Custo de Taxas (Entrada + Stop):</span>
                          <span className="text-yellow-400">-${estimatedFeesCost.toFixed(2)} USD</span>
                        </div>
                        <div className="flex justify-between text-white font-bold text-[9px] pt-1 border-t border-brand-border/30">
                          <span>Perda Total Real no Stop (Preço + Taxas):</span>
                          <span className="text-red-400 font-bold">
                            -${(estimatedPriceLoss + estimatedFeesCost).toFixed(2)} USD
                            <span className="text-brand-text/60 font-normal text-[8px] ml-1">
                              ({customRiskPercent}% da conta)
                            </span>
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2 bg-yellow-500/10 border border-yellow-500/30 rounded-xl text-[9px] text-yellow-300 flex items-start gap-1.5">
                        <Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-yellow-400" />
                        <span>
                          Para calcular a margem baseada na perda exata em %, certifique-se que o sinal possui Preço de Entrada e Stop Loss definidos abaixo.
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}

                {canEditRisk && (
                  <div className="flex justify-between items-center text-[10px] pt-1 border-t border-brand-border/20 font-mono">
                    <span className="text-brand-text/40">
                      {marginType === 'RISK_USD' || marginType === 'RISK_PERCENT' ? 'Margem Efetiva / Posição Total:' : `Valor Total Posição (${customLeverage}x):`}
                    </span>
                    <span className="text-white font-bold">
                      ${effectiveMarginUSD.toFixed(2)} margem · ${totalPositionValue.toFixed(2)} total
                    </span>
                  </div>
                )}
              </div>

              {/* TP & SL Parsed Summary */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/40 space-y-1.5 min-h-[80px] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-bold text-brand-success uppercase">Alvo de Lucro (TP)</span>
                    <button
                      type="button"
                      onClick={() => handleAddManualTp()}
                      className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-brand-success/20 hover:bg-brand-success text-brand-success hover:text-white font-bold transition-colors flex items-center gap-0.5"
                      title="Adicionar novo Take Profit"
                    >
                      <Plus className="w-2.5 h-2.5" />
                      <span>+ Alvo</span>
                    </button>
                  </div>
                  {customTPs.length === 0 ? (
                    <div className="space-y-1">
                      <span className="text-[10px] text-brand-text/30 italic block py-0.5">--- (Sem TP definido)</span>
                      <button
                        type="button"
                        onClick={() => handleAddManualTp()}
                        className="w-full py-1 text-[9px] font-bold text-brand-success bg-brand-success/10 border border-brand-success/30 rounded-lg hover:bg-brand-success/20 transition-colors flex items-center justify-center gap-1"
                      >
                        <Plus className="w-3 h-3" />
                        <span>Adicionar Alvo</span>
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-1 max-h-32 overflow-y-auto font-mono text-[10px] pr-0.5">
                      {customTPs.map((tp, i) => {
                        const isLast = i === customTPs.length - 1;
                        const isSelected = selectedTpIndex === i || (selectedTpIndex === null && isLast);
                        return (
                          <div
                            key={i}
                            className={`px-1.5 py-1 rounded-lg transition-all border flex items-center justify-between gap-1.5 ${
                              isSelected
                                ? 'bg-brand-success/20 border-brand-success text-brand-success font-bold shadow-sm shadow-brand-success/20'
                                : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/50 hover:text-white'
                            }`}
                          >
                            <button
                              type="button"
                              onClick={() => setSelectedTpIndex(i)}
                              className="text-left flex-1 truncate"
                              title="Clique para selecionar este alvo principal na Bitunix"
                            >
                              <span>TP{i + 1}{isSelected ? '★' : ''}:</span>
                            </button>

                            {feeViability?.targets?.[i] && (
                              <span
                                title={feeViability.targets[i].statusLabel}
                                className={`text-[8px] font-mono px-1 py-0.5 rounded font-bold whitespace-nowrap shrink-0 ${
                                  feeViability.targets[i].status === 'LOSS_AFTER_FEES'
                                    ? 'bg-red-500/25 text-red-400 border border-red-500/40'
                                    : feeViability.targets[i].status === 'BREAKEVEN'
                                    ? 'bg-amber-500/25 text-amber-300 border border-amber-500/40'
                                    : 'bg-emerald-500/25 text-emerald-400 border border-emerald-500/40'
                                }`}
                              >
                                {feeViability.targets[i].status === 'LOSS_AFTER_FEES'
                                  ? `❌ Negativo (${feeViability.targets[i].netPct.toFixed(2)}%)`
                                  : feeViability.targets[i].status === 'BREAKEVEN'
                                  ? '⚖️ Empate'
                                  : `+${feeViability.targets[i].netPct.toFixed(2)}% líq.`}
                              </span>
                            )}

                            <input
                              type="text"
                              value={tp}
                              onChange={(e) => handleUpdateManualTp(i, e.target.value)}
                              className="w-20 bg-brand-bg/80 border border-brand-border/40 rounded px-1 text-right text-[10px] text-brand-success font-mono font-bold outline-none focus:border-brand-success"
                            />
                            <button
                              type="button"
                              onClick={() => handleRemoveManualTp(i)}
                              className="p-0.5 text-brand-text/30 hover:text-brand-danger rounded transition-colors"
                              title="Remover este alvo"
                            >
                              <Trash2 className="w-3 h-3" />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/40 space-y-1 min-h-[80px] flex flex-col justify-between">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] font-bold text-brand-danger uppercase block">Stop Loss</span>
                    {customSL && (
                      <span className="text-[8px] font-mono px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 font-bold">
                        Proteção
                      </span>
                    )}
                  </div>
                  <div className="space-y-1">
                    <input
                      type="text"
                      placeholder="Ex: 94100"
                      value={customSL}
                      onChange={(e) => setCustomSL(e.target.value)}
                      className="w-full bg-brand-bg border border-brand-border/60 rounded-lg px-2 py-1 text-xs font-mono font-bold text-brand-danger outline-none focus:border-red-400"
                    />
                  </div>
                </div>
              </div>

              {/* Trailing Stop (Stop Móvel) Section */}
              <div className={`p-3 rounded-xl border transition-all space-y-2.5 ${
                useTrailingStop
                  ? 'bg-brand-accent/10 border-brand-accent/50 shadow-sm'
                  : 'bg-brand-bg/30 border-brand-border/40'
              }`}>
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      disabled={!canEditTrailingStop}
                      checked={useTrailingStop}
                      onChange={(e) => setUseTrailingStop(e.target.checked)}
                      className="rounded border-brand-border text-brand-accent focus:ring-0 w-4 h-4 bg-brand-bg cursor-pointer disabled:opacity-60"
                    />
                    <span className="text-[10px] font-black uppercase tracking-wider text-white flex items-center gap-1.5">
                      <TrendingUp className="w-3.5 h-3.5 text-brand-accent" />
                      <span>Trailing Stop (Stop Móvel)</span>
                    </span>
                  </label>

                  <div className="flex items-center gap-1.5">
                    {!canEditTrailingStop && (
                      <span className="text-[9px] font-bold text-cyan-400 bg-cyan-500/10 px-1.5 py-0.5 rounded border border-cyan-500/20 flex items-center gap-1">
                        <Lock className="w-2.5 h-2.5" /> 1x Fixo por Bruno
                      </span>
                    )}
                    <span className={`text-[8.5px] font-mono px-2 py-0.5 rounded-full font-bold uppercase ${
                      useTrailingStop
                        ? 'bg-brand-accent text-white shadow'
                        : 'bg-brand-bg text-brand-text/40'
                    }`}>
                      {useTrailingStop ? 'Ativado' : 'Desativado'}
                    </span>
                  </div>
                </div>

                {useTrailingStop && (
                  <div className="space-y-3 pt-1 border-t border-brand-border/40 font-mono">
                    {/* Mode Selector */}
                    {canEditTrailingStop && (
                      <div className="grid grid-cols-2 gap-1.5 p-1 bg-brand-bg/80 rounded-xl border border-brand-border/60">
                        <button
                          type="button"
                          onClick={() => setTrailingMode('MATCH_SL')}
                          className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                            trailingMode === 'MATCH_SL'
                              ? 'bg-brand-accent text-white shadow-md'
                              : 'text-brand-text/50 hover:text-white hover:bg-brand-surface'
                          }`}
                        >
                          <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                          <span className="truncate">Igual SL ({trailingMultiplier}x)</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => setTrailingMode('CUSTOM')}
                          className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 ${
                            trailingMode === 'CUSTOM'
                              ? 'bg-brand-accent text-white shadow-md'
                              : 'text-brand-text/50 hover:text-white hover:bg-brand-surface'
                          }`}
                        >
                          <Settings className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">% Recuo Fixo</span>
                        </button>
                      </div>
                    )}

                    {/* Mode 1: MATCH_SL (Igual ao SL com Múltiplos) */}
                    {trailingMode === 'MATCH_SL' && (
                      <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-accent/30 space-y-2.5">
                        <div className="flex items-center justify-between">
                          <span className="text-[9px] text-brand-text/60 uppercase font-bold">Distância Base do Stop (1x):</span>
                          <span className="text-xs font-mono font-bold text-brand-text/80 px-2 py-0.5 rounded bg-brand-surface border border-brand-border/50">
                            {slDistancePercent > 0 ? `${(slDistancePercent * 100).toFixed(2)}%` : 'Calculado na Entrada'}
                          </span>
                        </div>

                        {/* Multiplier / Quantidade de Vezes do SL */}
                        {canEditTrailingStop && (
                          <div className="space-y-1.5 pt-1 border-t border-brand-border/30">
                            <div className="flex items-center justify-between">
                              <label className="text-[9px] font-bold text-amber-400 uppercase flex items-center gap-1">
                                <span>Vezes o Stop Loss (Multiplicador):</span>
                              </label>
                              <span className="text-[10px] font-mono font-bold text-white bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded">
                                {trailingMultiplier}x {trailingMultiplier === 1 ? '(1:1)' : ''}
                              </span>
                            </div>

                            <div className="grid grid-cols-6 gap-1">
                              {[0.5, 0.75, 1.0, 1.5, 2.0, 3.0].map((mult) => {
                                const isSelected = trailingMultiplier === mult;
                                return (
                                  <button
                                    key={mult}
                                    type="button"
                                    onClick={() => {
                                      setTrailingMultiplier(mult);
                                      setCustomTrailingMultiplier(mult.toString());
                                      // Sincroniza simultaneamente o Ativar Trailing Stop
                                      setActivationMultiplierChoice(mult);
                                      const calcPrice = getActivationPriceForMult(mult);
                                      if (calcPrice !== null) {
                                        setTrailingActivationPrice(calcPrice.toString());
                                      }
                                    }}
                                    className={`py-1 rounded-lg text-[9.5px] font-bold border transition-all text-center ${
                                      isSelected
                                        ? 'bg-amber-500 text-brand-bg border-amber-400 shadow font-black'
                                        : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/60 hover:text-white hover:border-brand-accent/40'
                                    }`}
                                    title={`${mult}x a distância do Stop Loss`}
                                  >
                                    {mult}x
                                  </button>
                                );
                              })}
                            </div>

                            {/* Custom Multiplier Input */}
                            <div className="flex items-center gap-2 pt-1">
                              <span className="text-[8.5px] text-brand-text/40 shrink-0">Personalizado:</span>
                              <div className="relative flex-1">
                                <input
                                  type="number"
                                  step="0.1"
                                  min="0.1"
                                  max="10"
                                  placeholder="Ex: 1.25"
                                  value={customTrailingMultiplier}
                                  onChange={(e) => {
                                    setCustomTrailingMultiplier(e.target.value);
                                    const val = parseFloat(e.target.value);
                                    if (!isNaN(val) && val > 0) {
                                      setTrailingMultiplier(val);
                                      // Sincroniza simultaneamente o Ativar Trailing Stop
                                      setActivationMultiplierChoice(val);
                                      const calcPrice = getActivationPriceForMult(val);
                                      if (calcPrice !== null) {
                                        setTrailingActivationPrice(calcPrice.toString());
                                      }
                                    }
                                  }}
                                  className="w-full bg-brand-bg border border-brand-border/60 rounded-lg px-2 py-0.5 text-[10px] font-mono font-bold text-white outline-none focus:border-brand-accent text-right pr-6"
                                />
                                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-bold text-brand-text/40 pointer-events-none">
                                  x
                                </span>
                              </div>
                            </div>
                          </div>
                        )}

                        {/* Highlight Calculated Final Recoil Distance */}
                        <div className="flex items-center justify-between p-2 bg-amber-500/10 border border-amber-500/30 rounded-lg font-mono">
                          <span className="text-[9px] text-amber-300 font-bold uppercase">Recuo Efetivo do Trailing:</span>
                          <span className="text-xs font-black text-amber-300">
                            {slDistancePercent > 0
                              ? `${(slDistancePercent * 100 * trailingMultiplier).toFixed(2)}%`
                              : `${trailingMultiplier}x do Stop`}
                          </span>
                        </div>

                        <div className="bg-brand-surface/70 p-2.5 rounded-lg border border-brand-border/40 space-y-1.5 text-[9px] font-sans">
                          <div className="font-bold text-white flex items-center justify-between">
                            <div className="flex items-center gap-1">
                              <TrendingUp className="w-3 h-3 text-brand-accent" />
                              <span>Dinâmica Passo-a-Passo ({trailingMultiplier}x):</span>
                            </div>
                            <span className="text-[8px] text-brand-text/40 font-mono">
                              Passo: {slDistancePercent > 0 ? `${(slDistancePercent * 100 * trailingMultiplier).toFixed(2)}%` : 'Dinâmico'}
                            </span>
                          </div>
                          <div className="space-y-1 text-brand-text/70 font-mono text-[8.5px]">
                            <div className="flex items-center gap-1.5 text-emerald-400">
                              <span>• Preço andou +{slDistancePercent > 0 ? (slDistancePercent * 100 * trailingMultiplier).toFixed(2) : (0.33 * trailingMultiplier).toFixed(2)}%</span>
                              <span className="text-white">➔</span>
                              <span>Stop move p/ Entrada (0.00% / Break-Even)</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-emerald-400">
                              <span>• Preço andou +{slDistancePercent > 0 ? (slDistancePercent * 200 * trailingMultiplier).toFixed(2) : (0.66 * trailingMultiplier).toFixed(2)}%</span>
                              <span className="text-white">➔</span>
                              <span>Stop move p/ +{slDistancePercent > 0 ? (slDistancePercent * 100 * trailingMultiplier).toFixed(2) : (0.33 * trailingMultiplier).toFixed(2)}% lucro</span>
                            </div>
                            <div className="flex items-center gap-1.5 text-emerald-400">
                              <span>• Preço andou +{slDistancePercent > 0 ? (slDistancePercent * 300 * trailingMultiplier).toFixed(2) : (0.99 * trailingMultiplier).toFixed(2)}%</span>
                              <span className="text-white">➔</span>
                              <span>Stop move p/ +{slDistancePercent > 0 ? (slDistancePercent * 200 * trailingMultiplier).toFixed(2) : (0.66 * trailingMultiplier).toFixed(2)}% lucro</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Mode 3: CUSTOM (Recuo Fixo) */}
                    {trailingMode === 'CUSTOM' && (
                      <div className="space-y-1">
                        <div className="flex justify-between items-center text-[9px]">
                          <span className="text-brand-text/50 uppercase font-bold">Distância de Recuo Manual (Callback):</span>
                          <span className="text-brand-accent font-bold text-xs">{trailingCallbackRate}%</span>
                        </div>
                        <div className="grid grid-cols-6 gap-1">
                          {[0.5, 1.0, 1.5, 2.0, 3.0, 5.0].map((rate) => (
                            <button
                              key={rate}
                              type="button"
                              onClick={() => setTrailingCallbackRate(rate)}
                              className={`py-1 rounded-lg text-[10px] font-bold border transition-all ${
                                trailingCallbackRate === rate
                                  ? 'bg-brand-accent text-white border-brand-accent shadow-sm'
                                  : 'bg-brand-bg/80 border-brand-border/40 text-brand-text/50 hover:text-white'
                              }`}
                            >
                              {rate}%
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Preço de Ativação (Ponto de Início do Trailing Stop) */}
                    <div className="space-y-1.5 pt-2 border-t border-brand-border/30">
                      <div className="flex items-center justify-between">
                        <label className="text-[9px] font-bold text-amber-400 uppercase flex items-center gap-1">
                          <Target className="w-3 h-3 text-amber-400" />
                          <span>Ativar Trailing Stop a partir de:</span>
                        </label>
                        <span className="text-[10px] font-mono font-bold text-white bg-amber-500/20 text-amber-300 border border-amber-500/40 px-1.5 py-0.2 rounded">
                          {trailingActivationPrice ? (
                            activationMultiplierChoice !== 'CUSTOM' && activationMultiplierChoice !== 'IMMEDIATE' ? (
                              `${activationMultiplierChoice}x ($${trailingActivationPrice})`
                            ) : customTPs.indexOf(trailingActivationPrice) !== -1 ? (
                              `TP${customTPs.indexOf(trailingActivationPrice) + 1} ($${trailingActivationPrice})`
                            ) : (
                              `$${trailingActivationPrice}`
                            )
                          ) : (
                            '0x (Imediato)'
                          )}
                        </span>
                      </div>

                      {/* Quick Selection Multiplier Buttons: 0.5x, 0.75x, 1x, 1.5x, 2x, 3x - Apenas Bruno pode editar */}
                      {canEditTrailingStop && (
                        <>
                          <div className="grid grid-cols-7 gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setTrailingActivationPrice('');
                                setActivationMultiplierChoice('IMMEDIATE');
                              }}
                              className={`py-1 rounded-lg text-[9px] font-bold border transition-all text-center ${
                                !trailingActivationPrice || activationMultiplierChoice === 'IMMEDIATE'
                                  ? 'bg-amber-500 text-brand-bg border-amber-400 shadow font-black'
                                  : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/60 hover:text-white hover:border-brand-accent/40'
                              }`}
                              title="Ativar Trailing Stop imediatamente na entrada (0x)"
                            >
                              Imed.
                            </button>

                            {[0.5, 0.75, 1.0, 1.5, 2.0, 3.0].map((mult) => {
                              const calcPrice = getActivationPriceForMult(mult);
                              const isSelected = trailingActivationPrice !== '' && (
                                activationMultiplierChoice === mult ||
                                (calcPrice !== null && Math.abs(parseFloat(trailingActivationPrice) - calcPrice) < 0.0001)
                              );
                              return (
                                <button
                                  key={mult}
                                  type="button"
                                  onClick={() => {
                                    setActivationMultiplierChoice(mult);
                                    if (calcPrice !== null) {
                                      setTrailingActivationPrice(calcPrice.toString());
                                    }
                                  }}
                                  className={`py-1 rounded-lg text-[9.5px] font-bold border transition-all text-center ${
                                    isSelected
                                      ? 'bg-amber-500 text-brand-bg border-amber-400 shadow font-black'
                                      : 'bg-brand-surface/70 border-brand-border/50 text-brand-text/60 hover:text-white hover:border-brand-accent/40'
                                  }`}
                                  title={calcPrice ? `Ativar no preço $${calcPrice} (${mult}x a distância do Stop Loss)` : `${mult}x a distância do Stop Loss`}
                                >
                                  {mult}x
                                </button>
                              );
                            })}
                          </div>

                          {/* Custom Price Input */}
                          <div className="flex items-center gap-2 pt-1">
                            <span className="text-[8.5px] text-brand-text/40 shrink-0">Personalizado:</span>
                            <div className="relative flex-1">
                              <input
                                type="text"
                                placeholder="Ex: 606.67 ou deixe vazio p/ imediato"
                                value={trailingActivationPrice}
                                onChange={(e) => {
                                  setActivationMultiplierChoice('CUSTOM');
                                  setTrailingActivationPrice(e.target.value);
                                }}
                                className="w-full bg-brand-bg border border-brand-border/60 rounded-lg px-2 py-0.5 text-[10px] font-mono font-bold text-white outline-none focus:border-brand-accent text-right pr-6 placeholder:text-brand-text/30"
                              />
                              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[9px] font-bold text-brand-text/40 pointer-events-none">
                                $
                              </span>
                            </div>
                            {trailingActivationPrice && (
                              <button
                                type="button"
                                onClick={() => {
                                  setActivationMultiplierChoice('IMMEDIATE');
                                  setTrailingActivationPrice('');
                                }}
                                className="p-1 hover:bg-brand-bg text-brand-text/40 hover:text-brand-danger rounded transition-colors"
                                title="Limpar para ativação imediata"
                              >
                                <X className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </>
                      )}

                      {/* Dynamic explanation banner based on chosen activation price */}
                      <div className={`p-2 rounded-lg border text-[8.5px] font-sans leading-tight flex items-start gap-1.5 ${
                        trailingActivationPrice
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                          : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
                      }`}>
                        {trailingActivationPrice ? (
                          <>
                            <Target className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                            <span>
                              <strong>Ativação Programada:</strong> Seu Stop Loss fixo em <strong>${customSL || '---'}</strong> protege a operação inicialmente. O Trailing Stop começará a mover o stop no lucro a partir de <strong>${trailingActivationPrice}</strong>.
                            </span>
                          </>
                        ) : (
                          <>
                            <Zap className="w-3 h-3 text-blue-400 shrink-0 mt-0.5" />
                            <span>
                              <strong>Ativação Imediata (0x):</strong> O Trailing Stop começará a rastrear o preço logo na abertura da ordem.
                            </span>
                          </>
                        )}
                      </div>
                    </div>

                    <div className="p-2 bg-brand-bg/50 rounded-lg border border-brand-border/30 text-[8.5px] text-brand-text/50 font-sans leading-tight flex items-start gap-1.5">
                      <Info className="w-3 h-3 text-brand-accent shrink-0 mt-0.5" />
                      <span>
                        {trailingMode === 'MATCH_SL'
                          ? `O Trailing Stop acompanha o preço no lucro com recuo de exatos ${slDistancePercent > 0 ? (slDistancePercent * 100 * trailingMultiplier).toFixed(2) + '%' : '1x da distância do Stop Loss'}, protegendo o lucro a cada passo equivalente ao risco.`
                          : `O Trailing Stop acompanha o preço no lucro e executa fechamento a mercado caso o preço recue ${trailingCallbackRate}% do pico favorável.`}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Execute Button */}
            <div className="pt-3 sm:pt-4 space-y-2">
              {isExecuting && (
                <div className="p-3 bg-brand-accent/10 border border-brand-accent/30 rounded-xl flex items-center space-x-3 text-brand-accent text-xs font-bold animate-pulse">
                  <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                  <span className="break-words">{executionStep}</span>
                </div>
              )}

              {/* Viability Warning right before execution if isTrap */}
              {feeViability && feeViability.isTrap && (
                <div className="p-3 sm:p-3.5 rounded-xl bg-red-950/50 border-2 border-red-500/80 shadow-lg text-white space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-5 h-5 text-red-400 shrink-0" />
                    <div>
                      <div className="text-xs font-black text-red-300 uppercase tracking-wide">
                        ⚠️ ARMADILHA DE TAXAS DETECTADA!
                      </div>
                      <div className="text-[10px] text-gray-300">
                        {feeViability.explanation} TP 1 dá prejuízo líquido ({feeViability.tp1NetGainPct.toFixed(3)}% pós-taxas).
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-red-500/30 text-[11px] font-mono">
                    <span className="text-gray-300">Ponto de Equilíbrio:</span>
                    <span className="font-bold text-yellow-300">
                      {feeViability.breakevenTpIndex !== -1 ? `Só no TP ${feeViability.breakevenTpIndex} (${feeViability.breakevenPrice})` : 'Nenhum alvo cobre as taxas'}
                    </span>
                  </div>
                </div>
              )}

              {feeViability && feeViability.isTrap ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    onClick={handleExecuteSignal}
                    disabled={isExecuting || !customSymbol}
                    className="w-full py-3.5 px-3 rounded-xl font-black text-xs sm:text-sm tracking-wider uppercase transition-all shadow-xl flex items-center justify-center space-x-2 bg-amber-600 hover:bg-amber-700 shadow-amber-600/20 text-white disabled:opacity-50"
                  >
                    <ShieldAlert className="w-4 h-4 shrink-0 text-amber-200" />
                    <span className="text-center">⚠️ EXECUTAR MESMO ASSIM</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleDiscardSignal}
                    className="w-full py-3.5 px-3 rounded-xl font-black text-xs sm:text-sm tracking-wider uppercase transition-all shadow-xl flex items-center justify-center space-x-2 bg-red-600/90 hover:bg-red-700 shadow-red-600/20 text-white"
                  >
                    <XCircle className="w-4 h-4 shrink-0 text-red-200" />
                    <span className="text-center">❌ DESCARTAR SINAL</span>
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleExecuteSignal}
                  disabled={isExecuting || !customSymbol}
                  className={`w-full py-3.5 sm:py-4 px-3 rounded-xl font-black text-xs sm:text-sm tracking-wider uppercase transition-all shadow-xl flex items-center justify-center space-x-2 ${
                    !customSymbol
                      ? 'bg-brand-border/30 text-brand-text/30 cursor-not-allowed border border-brand-border/40'
                      : customDirection === 'LONG'
                      ? 'bg-brand-success hover:bg-emerald-600 shadow-brand-success/20 text-white'
                      : 'bg-brand-danger hover:bg-red-600 shadow-brand-danger/20 text-white'
                  } disabled:opacity-50`}
                >
                  <Zap className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
                  <span className="text-center">
                    {customSymbol
                      ? `EXECUTAR ${customDirection} ${customSymbol} (${accountType === 'USDT' ? 'USDT Real' : 'VST Demo'})`
                      : 'AGUARDANDO SINAL PARA EXECUÇÃO'}
                  </span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Dual Tab: Live Open Positions vs Full Execution History */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-3.5 sm:p-5 space-y-3 sm:space-y-4 shadow-xl">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-brand-border pb-3">
          <div className="flex items-center space-x-2">
            <div className="flex bg-brand-bg p-1 rounded-xl border border-brand-border/60">
              <button
                type="button"
                onClick={() => setPositionsTab('LIVE')}
                className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all flex items-center space-x-2 ${
                  positionsTab === 'LIVE'
                    ? 'bg-amber-500 text-brand-bg shadow-lg shadow-amber-500/20'
                    : 'text-brand-text/50 hover:text-white'
                }`}
              >
                <Zap className="w-3.5 h-3.5 shrink-0" />
                <span>Posições Abertas ({liveBitunixPositions.length})</span>
                {liveBitunixPositions.length > 0 && (
                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                )}
              </button>

              <button
                type="button"
                onClick={() => setPositionsTab('HISTORY')}
                className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all flex items-center space-x-2 ${
                  positionsTab === 'HISTORY'
                    ? 'bg-brand-accent text-white shadow-lg shadow-brand-accent/20'
                    : 'text-brand-text/50 hover:text-white'
                }`}
              >
                <Layers className="w-3.5 h-3.5 shrink-0" />
                <span>Histórico de Sinais ({history.length})</span>
              </button>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <button
              onClick={() => fetchLiveBitunixPositions(true)}
              disabled={isLoadingLivePositions}
              className="px-2.5 py-1.5 bg-brand-bg hover:bg-brand-border border border-brand-border rounded-xl text-[10px] font-bold text-brand-text/60 hover:text-white transition-all flex items-center space-x-1.5"
              title="Atualizar posições abertas e saldo agora"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoadingLivePositions ? 'animate-spin text-amber-400' : ''}`} />
              <span>Sincronizar Bitunix</span>
            </button>
            <span className="text-[10px] text-brand-text/40 font-mono font-bold">
              Conta: <strong className="text-purple-400">{accountType}</strong>
            </span>
          </div>
        </div>

        {/* TAB 1: POSIÇÕES ABERTAS NA BITUNIX (AO VIVO) */}
        {positionsTab === 'LIVE' && (
          <div>
            {liveBitunixPositions.length === 0 ? (
              <div className="p-8 sm:p-12 text-center space-y-2 border border-dashed border-brand-border/60 rounded-xl bg-brand-bg/40">
                <div className="w-10 h-10 mx-auto rounded-xl bg-brand-surface border border-brand-border flex items-center justify-center text-brand-text/30">
                  <Coins className="w-5 h-5" />
                </div>
                <p className="text-xs font-mono text-brand-text/50">
                  Nenhuma ordem ou posição aberta no momento na conta <strong className="text-purple-400">{accountType}</strong> da Bitunix.
                </p>
                <p className="text-[10px] text-brand-text/30">
                  Quando um sinal for executado pelo app ou bot do Telegram, a posição aparecerá aqui em tempo real com opções de fechar, mover stop para 0 a 0 ou editar SL/TP.
                </p>
              </div>
            ) : (
              <div className="space-y-3">
                {/* Desktop View */}
                <div className="hidden sm:block overflow-x-auto custom-scrollbar">
                  <table className="w-full text-left border-collapse min-w-[720px]">
                    <thead className="bg-brand-bg/80 border-b border-brand-border text-[9px] uppercase font-bold text-brand-text/40">
                      <tr>
                        <th className="p-3">Par</th>
                        <th className="p-3">Lado</th>
                        <th className="p-3 text-right">Margem / Alav.</th>
                        <th className="p-3 text-right">Preço Entrada</th>
                        <th className="p-3 text-right">Preço Atual</th>
                        <th className="p-3 text-right">PnL (Lucro/Prejuízo)</th>
                        <th className="p-3 text-center">Stop Loss</th>
                        <th className="p-3 text-center">Take Profit</th>
                        <th className="p-3 text-right">Gerenciar / Ações</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-brand-border/40 font-mono text-xs">
                      {liveBitunixPositions.map((pos, idx) => {
                        const cleanSym = pos.symbol.replace('-USDT', '').replace('USDT', '');
                        const isProfit = (pos.unrealizedProfit || 0) >= 0;
                        const isLong = pos.positionSide === 'LONG';
                        return (
                          <tr key={pos.positionId || `${pos.symbol}-${idx}`} className="hover:bg-brand-bg/40 transition-colors">
                            <td className="p-3 font-bold text-white">
                              <div className="flex items-center space-x-1.5">
                                <span className="text-sm font-black">{cleanSym}</span>
                                <span className="text-[9px] text-brand-text/40 font-normal">USDT</span>
                              </div>
                            </td>
                            <td className="p-3">
                              <span className={`px-2 py-0.5 rounded text-[9px] font-black ${
                                isLong ? 'bg-brand-success/20 text-brand-success border border-brand-success/30' : 'bg-brand-danger/20 text-brand-danger border border-brand-danger/30'
                              }`}>
                                {pos.positionSide}
                              </span>
                            </td>
                            <td className="p-3 text-right text-brand-text/80">
                              <div className="font-bold">${parseFloat(pos.margin || 0).toFixed(2)}</div>
                              <div className="text-[9px] text-brand-text/40">{pos.leverage || 10}x</div>
                            </td>
                            <td className="p-3 text-right text-brand-text/80">
                              ${parseFloat(pos.avgPrice || pos.entryPrice || 0).toFixed(4)}
                            </td>
                            <td className="p-3 text-right font-bold text-white">
                              ${parseFloat(pos.markPrice || 0).toFixed(4)}
                            </td>
                            <td className="p-3 text-right">
                              <div className={`font-black text-xs ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                                {isProfit ? '+' : ''}${parseFloat(pos.unrealizedProfit || 0).toFixed(2)}
                              </div>
                              <div className={`text-[9px] font-bold ${isProfit ? 'text-emerald-400/80' : 'text-red-400/80'}`}>
                                {isProfit ? '+' : ''}{parseFloat(pos.pnlRatio || 0).toFixed(2)}%
                              </div>
                            </td>
                            <td className="p-3 text-center">
                              {pos.stopLoss ? (
                                <span className="px-2 py-0.5 bg-red-500/15 border border-red-500/30 text-red-400 rounded text-[10px] font-bold">
                                  ${pos.stopLoss}
                                </span>
                              ) : (
                                <span className="text-brand-text/30 text-[10px]">Sem SL</span>
                              )}
                            </td>
                            <td className="p-3 text-center">
                              {pos.takeProfit ? (
                                <span className="px-2 py-0.5 bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded text-[10px] font-bold">
                                  ${pos.takeProfit}
                                </span>
                              ) : (
                                <span className="text-brand-text/30 text-[10px]">Sem TP</span>
                              )}
                            </td>
                            <td className="p-3 text-right">
                              <div className="flex items-center justify-end space-x-1.5">
                                <button
                                  type="button"
                                  onClick={() => handleSetBreakevenLive(pos)}
                                  className="px-2 py-1 bg-amber-500/15 hover:bg-amber-500 text-amber-400 hover:text-brand-bg rounded-lg text-[9.5px] font-bold transition-all border border-amber-500/30 flex items-center space-x-1"
                                  title="Puxar Stop Loss para o preço de entrada (0 a 0 / Breakeven)"
                                >
                                  <Shield className="w-3 h-3 shrink-0" />
                                  <span>0x0</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleOpenEditPositionModal(pos)}
                                  className="px-2 py-1 bg-brand-accent/20 hover:bg-brand-accent text-brand-accent hover:text-white rounded-lg text-[9.5px] font-bold transition-all border border-brand-accent/40 flex items-center space-x-1"
                                  title="Editar Stop Loss e Take Profit na Bitunix"
                                >
                                  <Edit3 className="w-3 h-3 shrink-0" />
                                  <span>Editar</span>
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleCloseLivePosition(pos)}
                                  className="px-2.5 py-1 bg-brand-danger/20 hover:bg-brand-danger text-brand-danger hover:text-white rounded-lg text-[9.5px] font-bold transition-all border border-brand-danger/40 flex items-center space-x-1"
                                  title="Fechar posição imediatamente a mercado"
                                >
                                  <XCircle className="w-3 h-3 shrink-0" />
                                  <span>Fechar</span>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Mobile View for Open Positions */}
                <div className="sm:hidden space-y-2.5">
                  {liveBitunixPositions.map((pos, idx) => {
                    const cleanSym = pos.symbol.replace('-USDT', '').replace('USDT', '');
                    const isProfit = (pos.unrealizedProfit || 0) >= 0;
                    const isLong = pos.positionSide === 'LONG';
                    return (
                      <div
                        key={pos.positionId || `${pos.symbol}-${idx}`}
                        className="p-3 bg-brand-bg/90 border border-brand-border/80 rounded-xl space-y-2.5 font-mono text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <span className="font-black text-sm text-white">{cleanSym}</span>
                            <span className={`px-2 py-0.5 rounded text-[9px] font-black ${
                              isLong ? 'bg-brand-success/20 text-brand-success border border-brand-success/30' : 'bg-brand-danger/20 text-brand-danger border border-brand-danger/30'
                            }`}>
                              {pos.positionSide}
                            </span>
                          </div>

                          <div className="text-right">
                            <span className={`text-xs font-black ${isProfit ? 'text-emerald-400' : 'text-red-400'}`}>
                              {isProfit ? '+' : ''}${parseFloat(pos.unrealizedProfit || 0).toFixed(2)} ({isProfit ? '+' : ''}{parseFloat(pos.pnlRatio || 0).toFixed(1)}%)
                            </span>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 text-[10px] text-brand-text/60 bg-brand-surface/60 p-2 rounded-lg border border-brand-border/40">
                          <div>Entrada: <strong className="text-white">${parseFloat(pos.avgPrice || pos.entryPrice || 0).toFixed(4)}</strong></div>
                          <div>Atual: <strong className="text-white">${parseFloat(pos.markPrice || 0).toFixed(4)}</strong></div>
                          <div>Margem: <strong className="text-white">${parseFloat(pos.margin || 0).toFixed(2)} ({pos.leverage}x)</strong></div>
                          <div>Stop: <strong className={pos.stopLoss ? 'text-red-400' : 'text-brand-text/40'}>{pos.stopLoss ? `$${pos.stopLoss}` : 'Sem SL'}</strong></div>
                        </div>

                        {/* Action Buttons Strip */}
                        <div className="grid grid-cols-3 gap-1.5 pt-1">
                          <button
                            type="button"
                            onClick={() => handleSetBreakevenLive(pos)}
                            className="py-1.5 px-2 bg-amber-500/15 text-amber-400 border border-amber-500/30 rounded-lg text-[10px] font-bold flex items-center justify-center space-x-1"
                          >
                            <Shield className="w-3 h-3" />
                            <span>0x0 BE</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleOpenEditPositionModal(pos)}
                            className="py-1.5 px-2 bg-brand-accent/20 text-brand-accent border border-brand-accent/40 rounded-lg text-[10px] font-bold flex items-center justify-center space-x-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>Editar</span>
                          </button>

                          <button
                            type="button"
                            onClick={() => handleCloseLivePosition(pos)}
                            className="py-1.5 px-2 bg-brand-danger/20 text-brand-danger border border-brand-danger/40 rounded-lg text-[10px] font-bold flex items-center justify-center space-x-1"
                          >
                            <XCircle className="w-3 h-3" />
                            <span>Fechar</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 2: HISTÓRICO DE SINAIS EXECUTADOS */}
        {positionsTab === 'HISTORY' && (
          <div>
            {/* Desktop Table View */}
            <div className="hidden sm:block overflow-x-auto custom-scrollbar">
              <table className="w-full text-left border-collapse min-w-[650px]">
                <thead className="bg-brand-bg/80 border-b border-brand-border">
                  <tr>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40">Horário</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40">Par</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40">Direção</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-right">Margem / Alav.</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-right">Valor Posição</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-center">Entrada</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-center">SL / TPs</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-center">Status</th>
                    <th className="p-3 text-[9px] uppercase font-bold text-brand-text/40 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-brand-border/40 font-mono text-xs">
                  {history.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-12 text-center text-brand-text/30 italic">
                        Nenhum sinal executado ainda. Cole um sinal acima e clique em "Executar Sinal na Bitunix".
                      </td>
                    </tr>
                  ) : (
                    history.map((item) => (
                      <tr key={item.id} className="hover:bg-brand-bg/40 transition-colors">
                        <td className="p-3 text-[10px] text-brand-text/40">{item.executedAt}</td>
                        <td className="p-3 font-bold text-white">
                          <button
                            onClick={() => setSelectedHistoryItem(item)}
                            className="hover:text-brand-accent transition-colors flex items-center space-x-1"
                            title="Abrir caixinha com detalhes"
                          >
                            <span>{item.symbol.split(':')[1] || item.symbol}</span>
                            <ExternalLink className="w-2.5 h-2.5 opacity-50" />
                          </button>
                        </td>
                        <td className="p-3">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-black ${item.direction === 'LONG' ? 'bg-brand-success/20 text-brand-success' : 'bg-brand-danger/20 text-brand-danger'}`}>
                            {item.direction}
                          </span>
                        </td>
                        <td className="p-3 text-right text-brand-text/60">
                          ${item.margin.toFixed(2)} / {item.leverage}x
                        </td>
                        <td className="p-3 text-right font-bold text-white">
                          ${item.positionValue.toFixed(2)}
                        </td>
                        <td className="p-3 text-center text-brand-text/80">
                          ${item.entryPrice}
                        </td>
                        <td className="p-3 text-center text-[10px]">
                          <div className="flex flex-col items-center">
                            <span className="text-brand-danger">SL: {item.stopLoss ? `$${item.stopLoss}` : '-'}</span>
                            <span className="text-brand-success">TPs: {item.takeProfits.length} alvos</span>
                            {item.trailingStop?.enabled && (
                              <span
                                className="text-[8.5px] font-bold text-brand-accent px-1.5 py-0.2 rounded bg-brand-accent/15 mt-0.5"
                                title={
                                  item.trailingStop.mode === 'TARGET_STEP'
                                    ? `Trailing por Alvo: ${item.trailingStop.currentStepDesc || 'Alvo 2 ➔ Entrada, Alvo 3+ ➔ Alvo Anterior'}`
                                    : `Trailing Stop: ${item.trailingStop.callbackRate}%`
                                }
                              >
                                {item.trailingStop.mode === 'TARGET_STEP'
                                  ? `TS: Alvo a Alvo${item.trailingStop.currentDynamicSL ? ` ($${item.trailingStop.currentDynamicSL})` : ''}`
                                  : `TS: ${item.trailingStop.callbackRate}%`}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 text-center">
                          <div className="flex flex-col items-center gap-0.5">
                            <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                              item.status === 'EXECUTED' ? 'bg-emerald-500/20 text-emerald-400' :
                              item.status === 'CLOSED' ? 'bg-brand-bg text-brand-text/40' :
                              'bg-red-500/20 text-red-400'
                            }`}>
                              {item.status}
                            </span>
                            {item.errorMessage && (
                              <span className="text-[8px] font-mono text-red-400/90 max-w-[130px] truncate" title={item.errorMessage}>
                                {item.errorMessage}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="p-3 text-right">
                          {(item.status === 'EXECUTED' || item.status === 'PENDING') && (
                            <button
                              onClick={() => handleClosePosition(item)}
                              className="px-2.5 py-1 bg-brand-danger/20 hover:bg-brand-danger text-brand-danger hover:text-white rounded-lg text-[10px] font-bold transition-all border border-brand-danger/30 flex items-center space-x-1 ml-auto"
                              title="Cancela ordens pendentes/gatilhos e fecha a posição de mercado na Bitunix"
                            >
                              <XCircle className="w-3.5 h-3.5" />
                              <span>Fechar / Cancelar</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {/* Mobile View */}
            <div className="sm:hidden space-y-2">
              {history.length === 0 ? (
                <div className="p-6 text-center text-brand-text/30 text-xs italic">
                  Nenhum sinal executado ainda. Cole um sinal acima e clique em "Executar Sinal na Bitunix".
                </div>
              ) : (
                history.map((item) => {
                  const cleanSymbol = item.symbol.split(':')[1] || item.symbol;
                  return (
                    <div
                      key={item.id}
                      className="p-3 bg-brand-bg/90 border border-brand-border/80 rounded-xl space-y-2.5 text-xs font-mono"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10px] text-brand-text/40">{item.executedAt}</span>
                        <span className={`px-2 py-0.5 rounded text-[9px] font-black ${item.direction === 'LONG' ? 'bg-brand-success/20 text-brand-success' : 'bg-brand-danger/20 text-brand-danger'}`}>
                          {item.direction}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <button
                          onClick={() => setSelectedHistoryItem(item)}
                          className="px-2.5 py-1.5 bg-brand-accent/20 hover:bg-brand-accent/30 border border-brand-accent/50 rounded-lg text-brand-accent font-black text-xs flex items-center gap-1.5 active:scale-95 transition-all"
                          title="Toque para abrir a caixinha de fechamento e detalhes"
                        >
                          <span>{cleanSymbol}</span>
                          <ExternalLink className="w-3 h-3 shrink-0" />
                        </button>

                        <div className="text-right">
                          <div className="text-white font-bold">${item.positionValue.toFixed(2)}</div>
                          <div className="text-[10px] text-brand-text/50">${item.margin.toFixed(2)} / {item.leverage}x</div>
                        </div>
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-brand-border/40 text-[10px]">
                        <span className={`px-1.5 py-0.5 rounded font-bold ${
                          item.status === 'EXECUTED' ? 'bg-emerald-500/20 text-emerald-400' :
                          item.status === 'CLOSED' ? 'bg-brand-bg text-brand-text/40' :
                          'bg-red-500/20 text-red-400'
                        }`}>
                          {item.status}
                        </span>

                        <button
                          onClick={() => setSelectedHistoryItem(item)}
                          className="px-2.5 py-1 bg-brand-accent/15 hover:bg-brand-accent/30 text-brand-accent rounded border border-brand-accent/30 text-[10px] font-bold flex items-center gap-1"
                        >
                          <Info className="w-3 h-3" />
                          <span>Abrir Caixinha</span>
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        )}
      </div>

      {/* Modal de Edição de SL e TP para Posições Abertas */}
      <AnimatePresence>
        {editingPosition && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-brand-surface border border-brand-border rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 font-mono text-xs relative my-auto"
            >
              <div className="flex items-center justify-between border-b border-brand-border pb-3">
                <div className="flex items-center space-x-2">
                  <div className="p-1.5 bg-brand-accent/20 rounded-lg text-brand-accent">
                    <Edit3 className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-sm font-black text-white uppercase">
                      Editar SL / TP na Bitunix
                    </h3>
                    <span className="text-[10px] text-brand-text/50">
                      {editingPosition.symbol} ({editingPosition.positionSide})
                    </span>
                  </div>
                </div>

                <button
                  onClick={() => setEditingPosition(null)}
                  className="p-1.5 text-brand-text/40 hover:text-white hover:bg-brand-bg rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Position Summary Strip */}
              <div className="grid grid-cols-3 gap-2 p-2.5 bg-brand-bg/80 border border-brand-border/60 rounded-xl text-[10px]">
                <div>
                  <span className="text-brand-text/40 block">Entrada</span>
                  <span className="text-white font-bold">${parseFloat(editingPosition.avgPrice || editingPosition.entryPrice || 0).toFixed(4)}</span>
                </div>
                <div>
                  <span className="text-brand-text/40 block">Preço Atual</span>
                  <span className="text-white font-bold">${parseFloat(editingPosition.markPrice || 0).toFixed(4)}</span>
                </div>
                <div>
                  <span className="text-brand-text/40 block">PnL</span>
                  <span className={`font-black ${(editingPosition.unrealizedProfit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    ${parseFloat(editingPosition.unrealizedProfit || 0).toFixed(2)}
                  </span>
                </div>
              </div>

              {/* Stop Loss Input */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-red-400 uppercase flex items-center justify-between">
                  <span>Preço do Stop Loss (SL):</span>
                  <button
                    type="button"
                    onClick={() => {
                      const entry = parseFloat(editingPosition.avgPrice || editingPosition.entryPrice || 0);
                      if (entry > 0) setEditSLInput(entry.toString());
                    }}
                    className="text-[9px] text-amber-400 hover:underline flex items-center gap-1"
                  >
                    <Shield className="w-2.5 h-2.5" />
                    <span>Usar Entrada (0x0)</span>
                  </button>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    placeholder="Ex: 605.50 (ou deixe vazio para remover)"
                    value={editSLInput}
                    onChange={(e) => setEditSLInput(e.target.value)}
                    className="w-full bg-brand-bg border border-brand-border rounded-xl px-3 py-2.5 text-xs font-mono font-bold text-white outline-none focus:border-red-400"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-brand-text/40 pointer-events-none">USD</span>
                </div>
              </div>

              {/* Take Profit Input */}
              <div className="space-y-1.5">
                <label className="text-[10px] font-bold text-emerald-400 uppercase">
                  Preço do Take Profit (TP):
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="any"
                    placeholder="Ex: 630.00 (ou deixe vazio para remover)"
                    value={editTPInput}
                    onChange={(e) => setEditTPInput(e.target.value)}
                    className="w-full bg-brand-bg border border-brand-border rounded-xl px-3 py-2.5 text-xs font-mono font-bold text-white outline-none focus:border-emerald-400"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-brand-text/40 pointer-events-none">USD</span>
                </div>
              </div>

              {/* Quick Actions & Save */}
              <div className="pt-2 space-y-2">
                <button
                  type="button"
                  onClick={handleSaveEditedSLTP}
                  disabled={isSubmittingEdit}
                  className="w-full py-3 px-4 bg-brand-accent hover:bg-indigo-600 text-white font-bold rounded-xl text-xs shadow-lg shadow-brand-accent/20 transition-all flex items-center justify-center space-x-2 disabled:opacity-50"
                >
                  {isSubmittingEdit ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                      <span>SALVANDO NA BITUNIX...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-4 h-4 shrink-0" />
                      <span>SALVAR ALTERAÇÕES NA BITUNIX</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => setEditingPosition(null)}
                  className="w-full py-2.5 px-4 bg-brand-bg hover:bg-brand-border text-brand-text/70 hover:text-white font-bold rounded-xl text-xs border border-brand-border transition-all"
                >
                  Cancelar
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Modal "Caixinha" de Detalhes e Gerenciamento */}
      <AnimatePresence>
        {selectedHistoryItem && (
          <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="bg-brand-surface border border-brand-border rounded-2xl max-w-md w-full p-4 sm:p-6 shadow-2xl space-y-4 font-mono text-xs relative my-auto"
            >
              {/* Header */}
              <div className="flex items-center justify-between border-b border-brand-border pb-3">
                <div className="flex items-center space-x-2">
                  <span className={`px-2.5 py-1 rounded-lg text-xs font-black ${
                    selectedHistoryItem.direction === 'LONG'
                      ? 'bg-brand-success/20 text-brand-success border border-brand-success/40'
                      : 'bg-brand-danger/20 text-brand-danger border border-brand-danger/40'
                  }`}>
                    {selectedHistoryItem.direction}
                  </span>
                  <h3 className="text-base font-black text-white">
                    {selectedHistoryItem.symbol.split(':')[1] || selectedHistoryItem.symbol}
                  </h3>
                </div>

                <button
                  onClick={() => setSelectedHistoryItem(null)}
                  className="p-1.5 text-brand-text/40 hover:text-white hover:bg-brand-bg rounded-lg transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Status */}
              <div className="flex items-center justify-between p-2.5 bg-brand-bg rounded-xl border border-brand-border/60">
                <span className="text-[10px] uppercase font-bold text-brand-text/50">Status da Operação</span>
                <span className={`px-2 py-0.5 rounded text-xs font-bold ${
                  selectedHistoryItem.status === 'EXECUTED' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' :
                  selectedHistoryItem.status === 'CLOSED' ? 'bg-brand-surface text-brand-text/60 border border-brand-border' :
                  'bg-red-500/20 text-red-400 border border-red-500/30'
                }`}>
                  {selectedHistoryItem.status}
                </span>
              </div>

              {/* Info Grid */}
              <div className="grid grid-cols-2 gap-2.5">
                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Horário Execução</span>
                  <span className="text-xs font-bold text-white mt-0.5 block">{selectedHistoryItem.executedAt}</span>
                </div>

                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Modo de Conta</span>
                  <span className="text-xs font-bold text-purple-400 mt-0.5 block">{selectedHistoryItem.accountType || accountType}</span>
                </div>

                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Margem / Alav.</span>
                  <span className="text-xs font-bold text-white mt-0.5 block">
                    ${selectedHistoryItem.margin.toFixed(2)} / {selectedHistoryItem.leverage}x
                  </span>
                </div>

                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Valor da Posição</span>
                  <span className="text-xs font-bold text-emerald-400 mt-0.5 block">
                    ${selectedHistoryItem.positionValue.toFixed(2)}
                  </span>
                </div>

                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Preço de Entrada</span>
                  <span className="text-xs font-bold text-white mt-0.5 block">${selectedHistoryItem.entryPrice}</span>
                </div>

                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Stop Loss (SL)</span>
                  <span className="text-xs font-bold text-brand-danger mt-0.5 block">
                    {selectedHistoryItem.stopLoss ? `$${selectedHistoryItem.stopLoss}` : 'Não definido'}
                  </span>
                </div>
              </div>

              {selectedHistoryItem.takeProfits && selectedHistoryItem.takeProfits.length > 0 && (
                <div className="p-2.5 bg-brand-bg/60 rounded-xl border border-brand-border/40 space-y-1">
                  <span className="text-[9px] uppercase text-brand-text/40 block">Alvos de Take Profit (TP)</span>
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {selectedHistoryItem.takeProfits.map((tp, idx) => (
                      <span key={idx} className="px-2 py-0.5 bg-brand-success/10 text-brand-success rounded text-[10px] font-bold border border-brand-success/30">
                        TP{idx + 1}: ${tp}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedHistoryItem.trailingStop?.enabled && (
                <div className="p-2.5 bg-brand-accent/10 rounded-xl border border-brand-accent/30 space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[9px] uppercase text-brand-accent font-bold flex items-center gap-1">
                      <TrendingUp className="w-3 h-3" />
                      Trailing Stop (
                      {selectedHistoryItem.trailingStop.mode === 'TARGET_STEP'
                        ? 'Alvo por Alvo'
                        : selectedHistoryItem.trailingStop.mode === 'MATCH_SL'
                        ? `${selectedHistoryItem.trailingStop.multiplier || 1}x do Stop`
                        : 'Fixo'}
                      )
                    </span>
                    <span className="text-[10px] font-bold text-white bg-brand-accent px-1.5 py-0.5 rounded">
                      {selectedHistoryItem.trailingStop.mode === 'TARGET_STEP'
                        ? 'Alvo a Alvo'
                        : `${selectedHistoryItem.trailingStop.callbackRate}%`}
                    </span>
                  </div>

                  {selectedHistoryItem.trailingStop.mode === 'TARGET_STEP' ? (
                    <div className="text-[10px] text-brand-text/80 space-y-1 font-mono">
                      <div className="flex justify-between items-center bg-brand-bg/60 p-1.5 rounded">
                        <span className="text-brand-text/50">Stop Loss Atual:</span>
                        <span className="text-amber-400 font-bold">
                          {selectedHistoryItem.trailingStop.currentDynamicSL
                            ? `$${selectedHistoryItem.trailingStop.currentDynamicSL}`
                            : selectedHistoryItem.stopLoss
                            ? `$${selectedHistoryItem.stopLoss}`
                            : 'Entrada'}
                        </span>
                      </div>
                      {selectedHistoryItem.trailingStop.currentStepDesc && (
                        <div className="text-[9px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 p-1.5 rounded">
                          {selectedHistoryItem.trailingStop.currentStepDesc}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[10px] text-brand-text/60">
                      {selectedHistoryItem.trailingStop.activationPrice
                        ? `Ativação no preço: $${selectedHistoryItem.trailingStop.activationPrice}`
                        : 'Ativação imediata'}
                      {selectedHistoryItem.trailingOrderIdBinX && (
                        <span className="block text-[9px] text-brand-text/40 mt-0.5">
                          ID Ordem Bitunix: #{selectedHistoryItem.trailingOrderIdBinX}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              {selectedHistoryItem.errorMessage && (
                <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-red-400 text-xs">
                  <span className="font-bold block uppercase text-[9px] mb-1">Erro na Execução:</span>
                  <span>{selectedHistoryItem.errorMessage}</span>
                </div>
              )}

              {/* Action Buttons */}
              <div className="pt-2 space-y-2">
                {(selectedHistoryItem.status === 'EXECUTED' || selectedHistoryItem.status === 'PENDING') && (
                  <button
                    onClick={() => {
                      const itemToClose = selectedHistoryItem;
                      setSelectedHistoryItem(null);
                      handleClosePosition(itemToClose);
                    }}
                    className="w-full py-3 px-4 bg-brand-danger hover:bg-red-600 text-white rounded-xl font-bold text-xs shadow-lg shadow-brand-danger/20 transition-all flex items-center justify-center space-x-2"
                  >
                    <XCircle className="w-4 h-4 shrink-0" />
                    <span>FECHAR POSIÇÃO / CANCELAR ORDEM</span>
                  </button>
                )}

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      onSelectSymbolForChart(selectedHistoryItem.symbol);
                      setSelectedHistoryItem(null);
                    }}
                    className="flex-1 py-2.5 px-3 bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent border border-brand-accent/40 rounded-xl font-bold text-xs transition-all flex items-center justify-center space-x-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Ver Gráfico</span>
                  </button>

                  <button
                    onClick={() => setSelectedHistoryItem(null)}
                    className="py-2.5 px-4 bg-brand-bg hover:bg-brand-border text-brand-text/70 hover:text-white rounded-xl font-bold text-xs border border-brand-border transition-all"
                  >
                    Fechar
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Shared Conservative Safety Locks Modal */}
      <SafetyLocksConfigModal
        isOpen={isSafetyModalOpen}
        onClose={() => setIsSafetyModalOpen(false)}
        settings={sharedSettings}
        onSave={handleSaveSafetySettings}
        activeOperator={activeOperator}
        onSwitchOperator={handleSwitchOperator}
        todayLossUsd={todayLossUsd}
      />

      {/* Telegram Signal Bot Forwarding Guide Modal */}
      <TelegramBotGuideModal
        isOpen={isTelegramGuideOpen}
        onClose={() => setIsTelegramGuideOpen(false)}
        activeOperator={activeOperator}
        maxRiskUsd={sharedSettings.maxRiskPerTradeUsd}
        maxLeverage={sharedSettings.maxLeverageCap}
        requireStopLoss={sharedSettings.requireStopLoss}
      />

      {/* Telegram Signal Bot Settings Modal */}
      <TelegramBotSettingsModal
        isOpen={isTelegramSettingsOpen}
        onClose={() => setIsTelegramSettingsOpen(false)}
        config={safeTgConfig}
        onSave={handleSaveTelegramBotConfig}
        activeOperator={activeOperator}
        isMaster={activeOperator === 'Bruno'}
        apiKey={apiKey}
        setApiKey={setApiKey}
        apiSecret={apiSecret}
        setApiSecret={setApiSecret}
      />

      {/* System Copy & Backup Modal */}
      <SystemBackupModal
        isOpen={internalBackupModalOpen}
        onClose={() => setInternalBackupModalOpen(false)}
        onNavigateToView={(view) => {
          if (view === 'copytrade' && onOpenCopyTrade) {
            onOpenCopyTrade();
          }
        }}
      />
    </div>
  );
}
