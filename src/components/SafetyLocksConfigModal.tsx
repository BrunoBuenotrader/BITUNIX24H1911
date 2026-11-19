import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Lock,
  Unlock,
  DollarSign,
  Percent,
  Layers,
  AlertTriangle,
  CheckCircle2,
  X,
  User,
  Users,
  Save,
  RotateCcw,
  Cloud,
  Check,
  Zap,
  TrendingDown,
  KeyRound,
  Sliders,
  Sparkles,
  ToggleLeft,
  ToggleRight,
  Eye,
  Settings2,
  HelpCircle
} from 'lucide-react';
import { SharedSettings, PartnerPermissions, DEFAULT_PARTNER_PERMISSIONS } from '../types/cloudSync';

interface SafetyLocksConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  settings: SharedSettings;
  onSave: (newSettings: Partial<SharedSettings>) => Promise<void>;
  activeOperator: string;
  onSwitchOperator: (name: string) => void;
  todayLossUsd: number;
}

type TabType = 'risk_rules' | 'partner_permissions' | 'presets';

export default function SafetyLocksConfigModal({
  isOpen,
  onClose,
  settings,
  onSave,
  activeOperator,
  onSwitchOperator,
  todayLossUsd
}: SafetyLocksConfigModalProps) {
  const [form, setForm] = useState<SharedSettings>(() => ({
    ...settings,
    partnerPermissions: {
      ...DEFAULT_PARTNER_PERMISSIONS,
      ...(settings.partnerPermissions || {})
    }
  }));
  const [activeTab, setActiveTab] = useState<TabType>('risk_rules');
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  if (!isOpen) return null;

  const isBruno = activeOperator === 'Bruno';
  const isLockedForLeo = Boolean(form.isMasterLocked && !isBruno);

  const handleSave = async () => {
    if (isLockedForLeo) {
      alert('Atenção: As travas foram definidas pelo Bruno (Master). Apenas o Bruno tem permissão para alterar as regras.');
      return;
    }
    setIsSaving(true);
    await onSave({
      ...form,
      updatedBy: activeOperator,
      updatedAt: new Date().toISOString()
    });
    setIsSaving(false);
    setSaveSuccess(true);
    setTimeout(() => {
      setSaveSuccess(false);
      onClose();
    }, 1200);
  };

  // Presets configuráveis pelo Bruno com 1 clique
  const applyPreset = (type: 'bruno_conservative' | 'moderate' | 'demo_only') => {
    if (isLockedForLeo) return;

    if (type === 'bruno_conservative') {
      setForm((prev) => ({
        ...prev,
        isMasterLocked: true,
        maxRiskPercent: 2.0,
        riskCalculationMode: 'PERCENT',
        allowFreeLeverage: true,
        maxLeverageCap: 50,
        requireStopLoss: true,
        emergencyStopPercent: 2.0,
        dailyLossLimitPercent: 6,
        dailyLossLimitUsd: 50,
        lockTrailingStop1x: true,
        trailingStopMultiplier: 1.0,
        trailingStopMode: 'MATCH_SL',
        autoBreakEvenTarget: 1,
        partnerPermissions: {
          canEditRisk: false,
          canEditLeverage: true,
          canDisableStopLoss: false,
          canEditTrailingStop: false,
          canExecuteRealTrading: true,
          canEditApiKeys: false,
          canClearLogsOrHistory: false,
          canOverrideTakeProfits: true
        }
      }));
    } else if (type === 'moderate') {
      setForm((prev) => ({
        ...prev,
        isMasterLocked: true,
        maxRiskPercent: 3.0,
        riskCalculationMode: 'PERCENT',
        allowFreeLeverage: true,
        maxLeverageCap: 50,
        requireStopLoss: true,
        emergencyStopPercent: 2.5,
        dailyLossLimitPercent: 8,
        dailyLossLimitUsd: 75,
        lockTrailingStop1x: true,
        trailingStopMultiplier: 1.0,
        trailingStopMode: 'MATCH_SL',
        autoBreakEvenTarget: 1,
        partnerPermissions: {
          canEditRisk: false,
          canEditLeverage: true,
          canDisableStopLoss: false,
          canEditTrailingStop: false,
          canExecuteRealTrading: true,
          canEditApiKeys: false,
          canClearLogsOrHistory: false,
          canOverrideTakeProfits: true
        }
      }));
    } else if (type === 'demo_only') {
      setForm((prev) => ({
        ...prev,
        isMasterLocked: true,
        executionMode: 'simulation',
        accountType: 'VST',
        maxRiskPercent: 2.0,
        riskCalculationMode: 'PERCENT',
        allowFreeLeverage: true,
        requireStopLoss: true,
        lockTrailingStop1x: true,
        partnerPermissions: {
          canEditRisk: false,
          canEditLeverage: true,
          canDisableStopLoss: false,
          canEditTrailingStop: false,
          canExecuteRealTrading: false, // Bloqueia conta Real para o Leo
          canEditApiKeys: false,
          canClearLogsOrHistory: false,
          canOverrideTakeProfits: true
        }
      }));
    }
  };

  const updatePermission = (key: keyof PartnerPermissions, value: boolean) => {
    if (isLockedForLeo) return;
    setForm((prev) => ({
      ...prev,
      partnerPermissions: {
        ...prev.partnerPermissions,
        [key]: value
      }
    }));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        className="relative w-full max-w-3xl bg-[#131722] border border-[#2a2e39] rounded-2xl shadow-2xl overflow-hidden my-auto flex flex-col max-h-[92vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-[#2a2e39] bg-gradient-to-r from-emerald-950/40 via-[#131722] to-blue-950/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600/20 border border-emerald-500/30 flex items-center justify-center text-emerald-400 shrink-0">
              <ShieldCheck className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base sm:text-lg font-bold text-white">Central de Travas & Permissões</h3>
                <span className="px-2 py-0.5 text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 rounded-full flex items-center gap-1">
                  <Cloud className="w-3 h-3" /> Sincronizado
                </span>
              </div>
              <p className="text-xs text-gray-400">
                {isBruno
                  ? 'Você está logado como Bruno (Master). Configure exatamente o que o Leo pode ou não fazer.'
                  : 'Você está logado como Leo (Sócio). Suas permissões e travas estão fixadas pelo Bruno.'}
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

        {/* Master Lock Banner */}
        <div className={`px-4 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 border-b shrink-0 ${
          isBruno
            ? form.isMasterLocked
              ? 'bg-blue-950/40 border-blue-900/50 text-blue-300'
              : 'bg-yellow-950/30 border-yellow-900/40 text-yellow-300'
            : 'bg-amber-950/40 border-amber-900/50 text-amber-300'
        }`}>
          <div className="flex items-center gap-2 text-xs font-medium">
            {form.isMasterLocked ? <Lock className="w-4 h-4 text-amber-400 shrink-0" /> : <Unlock className="w-4 h-4 text-yellow-400 shrink-0" />}
            <span>
              {isBruno
                ? form.isMasterLocked
                  ? 'Trava Master do Bruno ATIVA: Leo não pode alterar as regras de segurança.'
                  : 'Trava Master DESATIVADA: Leo tem permissão para editar.'
                : '🔒 Parâmetros e permissões controlados pelo Bruno. Visualização em modo leitura.'}
            </span>
          </div>

          {isBruno && (
            <button
              type="button"
              onClick={() => setForm((prev) => ({ ...prev, isMasterLocked: !prev.isMasterLocked }))}
              className={`px-2.5 py-1 rounded-md text-[11px] font-bold flex items-center gap-1 transition-all ${
                form.isMasterLocked
                  ? 'bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 border border-blue-500/40'
                  : 'bg-yellow-600/30 hover:bg-yellow-600/50 text-yellow-200 border border-yellow-500/40'
              }`}
            >
              {form.isMasterLocked ? <Unlock className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
              <span>{form.isMasterLocked ? 'Desativar Trava Master' : 'Ativar Trava Master'}</span>
            </button>
          )}
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-4 sm:px-6 pt-3 border-b border-[#2a2e39] bg-[#111319] shrink-0">
          <button
            type="button"
            onClick={() => setActiveTab('risk_rules')}
            className={`px-3.5 py-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'risk_rules'
                ? 'border-emerald-500 text-emerald-400 bg-emerald-500/5'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>1. Regras de Risco & Execução</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('partner_permissions')}
            className={`px-3.5 py-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'partner_permissions'
                ? 'border-blue-500 text-blue-400 bg-blue-500/5'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>2. Permissões do Leo (Sócio)</span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('presets')}
            className={`px-3.5 py-2 text-xs font-bold border-b-2 transition-all flex items-center gap-1.5 ${
              activeTab === 'presets'
                ? 'border-purple-500 text-purple-400 bg-purple-500/5'
                : 'border-transparent text-gray-400 hover:text-gray-200'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>3. Presets Rápidos</span>
          </button>
        </div>

        {/* Tab Content Area */}
        <div className="p-4 sm:p-6 space-y-5 overflow-y-auto flex-1 custom-scrollbar">
          
          {/* TAB 1: REGRAS DE RISCO & EXECUÇÃO */}
          {activeTab === 'risk_rules' && (
            <div className="space-y-4">
              
              {/* Operator Switcher in Modal */}
              <div className="p-3.5 rounded-xl bg-[#1e222d] border border-[#2a2e39] flex flex-wrap items-center justify-between gap-3">
                <div>
                  <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider block">Operador Atual</span>
                  <span className="text-sm font-bold text-white flex items-center gap-1.5">
                    <User className="w-4 h-4 text-blue-400" />
                    {activeOperator} {isBruno ? '(Master / Dono)' : '(Sócio / Operador)'}
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onSwitchOperator('Bruno');
                      setForm((prev) => ({ ...prev, activeOperator: 'Bruno' }));
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeOperator === 'Bruno'
                        ? 'bg-blue-600 text-white shadow-md shadow-blue-600/30'
                        : 'bg-[#131722] text-gray-400 hover:text-white border border-[#2a2e39]'
                    }`}
                  >
                    Bruno (Master)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSwitchOperator('Leo');
                      setForm((prev) => ({ ...prev, activeOperator: 'Leo' }));
                    }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                      activeOperator === 'Leo'
                        ? 'bg-purple-600 text-white shadow-md shadow-purple-600/30'
                        : 'bg-[#131722] text-gray-400 hover:text-white border border-[#2a2e39]'
                    }`}
                  >
                    Leo (Sócio)
                  </button>
                </div>
              </div>

              {/* Grid de Regras de Segurança */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* 1. Risco Fixado em % */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Percent className="w-4 h-4 text-emerald-400" />
                      <span>Risco Máximo p/ Trade (% Conta)</span>
                    </label>
                    <span className="text-[10px] text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded font-mono font-bold border border-emerald-500/20">
                      {form.maxRiskPercent}% Fixado
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    A margem em USD é calculada para que se bater no Stop Loss, a perda seja de exatamente <strong>{form.maxRiskPercent}% da conta</strong>.
                  </p>
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <input
                        type="number"
                        step="0.5"
                        min="0.5"
                        max="10"
                        disabled={isLockedForLeo}
                        value={form.maxRiskPercent}
                        onChange={(e) =>
                          setForm((prev) => ({
                            ...prev,
                            maxRiskPercent: Math.max(0.5, parseFloat(e.target.value) || 2),
                            riskCalculationMode: 'PERCENT'
                          }))
                        }
                        className="w-full pl-3 pr-8 py-2 text-sm font-black bg-[#131722] border border-[#2a2e39] rounded-lg text-emerald-400 focus:outline-none focus:border-emerald-500 disabled:opacity-60"
                      />
                      <span className="absolute right-3 top-2.5 text-xs text-gray-400 font-bold">%</span>
                    </div>
                    <div className="px-3 py-2 bg-[#131722] border border-[#2a2e39] rounded-lg text-[11px] text-gray-300 font-mono">
                      Perda: ${(form.maxRiskPercent * 5).toFixed(2)} ($500)
                    </div>
                  </div>
                </div>

                {/* 2. Alavancagem Livre vs Teto */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Layers className="w-4 h-4 text-amber-400" />
                      <span>Alavancagem Livre do Sinal</span>
                    </label>
                    <button
                      type="button"
                      disabled={isLockedForLeo}
                      onClick={() => setForm((prev) => ({ ...prev, allowFreeLeverage: !prev.allowFreeLeverage }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        form.allowFreeLeverage ? 'bg-amber-500' : 'bg-gray-700'
                      } ${isLockedForLeo ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          form.allowFreeLeverage ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    {form.allowFreeLeverage
                      ? 'Livre: Usa a alavancagem do sinal (20x, 50x) pois a margem é calculada matematicamente pelo risco de 2%.'
                      : `Limitado: Bloqueia alavancagens acima de ${form.maxLeverageCap}x.`}
                  </p>
                  {!form.allowFreeLeverage && (
                    <div className="flex items-center gap-2 pt-1">
                      <span className="text-xs text-gray-400">Teto máximo:</span>
                      <div className="grid grid-cols-4 gap-1.5 flex-1">
                        {[10, 20, 30, 50].map((lev) => (
                          <button
                            key={lev}
                            type="button"
                            disabled={isLockedForLeo}
                            onClick={() => setForm((prev) => ({ ...prev, maxLeverageCap: lev }))}
                            className={`py-1 rounded text-xs font-bold transition-all ${
                              form.maxLeverageCap === lev
                                ? 'bg-amber-500/20 text-amber-400 border border-amber-500/50'
                                : 'bg-[#131722] text-gray-400 border border-[#2a2e39]'
                            }`}
                          >
                            {lev}x
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* 3. Trailing Stop 1:1 Travado */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <Zap className="w-4 h-4 text-cyan-400" />
                      <span>Trailing Stop 1:1 Travado (1x SL)</span>
                    </label>
                    <button
                      type="button"
                      disabled={isLockedForLeo}
                      onClick={() => setForm((prev) => ({ ...prev, lockTrailingStop1x: !prev.lockTrailingStop1x }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        form.lockTrailingStop1x ? 'bg-cyan-500' : 'bg-gray-700'
                      } ${isLockedForLeo ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          form.lockTrailingStop1x ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    Ativa automaticamente o Trailing Stop com callback de 1.0x (100% da distância do SL), acompanhando a alta e travando lucros.
                  </p>
                  <div className="p-2 rounded bg-[#131722] border border-[#2a2e39] flex items-center justify-between text-xs">
                    <span className="text-gray-300">Multiplicador:</span>
                    <span className="font-mono font-bold text-cyan-400">1.0x (Igual ao Stop Loss)</span>
                  </div>
                </div>

                {/* 4. Stop Loss Obrigatório */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <ShieldAlert className="w-4 h-4 text-red-400" />
                      <span>Stop Loss Obrigatório</span>
                    </label>
                    <button
                      type="button"
                      disabled={isLockedForLeo}
                      onClick={() => setForm((prev) => ({ ...prev, requireStopLoss: !prev.requireStopLoss }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        form.requireStopLoss ? 'bg-red-500' : 'bg-gray-700'
                      } ${isLockedForLeo ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          form.requireStopLoss ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    Se o sinal colado não tiver SL, insere automaticamente um Stop de emergência padrão.
                  </p>
                  <div className="flex items-center justify-between p-2 rounded bg-[#131722] border border-[#2a2e39] text-xs">
                    <span className="text-gray-300">SL de emergência:</span>
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        step="0.5"
                        min="1"
                        max="5"
                        disabled={isLockedForLeo}
                        value={form.emergencyStopPercent}
                        onChange={(e) => setForm((prev) => ({ ...prev, emergencyStopPercent: parseFloat(e.target.value) || 2 }))}
                        className="w-12 px-1.5 py-0.5 bg-[#1e222d] border border-[#2a2e39] rounded text-center text-red-400 font-bold"
                      />
                      <span className="text-gray-400">%</span>
                    </div>
                  </div>
                </div>

                {/* 5. Margem Cruzada Inteligente Anti-Liquidação */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5 md:col-span-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-white flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span>Margem Cruzada Inteligente (Anti-Liquidação Precoce)</span>
                    </label>
                    <button
                      type="button"
                      disabled={isLockedForLeo}
                      onClick={() => setForm((prev) => ({ ...prev, autoCrossMarginEnabled: !prev.autoCrossMarginEnabled }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        form.autoCrossMarginEnabled !== false ? 'bg-emerald-500' : 'bg-gray-700'
                      } ${isLockedForLeo ? 'opacity-60 cursor-not-allowed' : ''}`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          form.autoCrossMarginEnabled !== false ? 'translate-x-4' : 'translate-x-1'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="text-[11px] text-gray-400">
                    Quando o Stop Loss com alavancagem for amplo (≥ {form.autoCrossMarginThreshold || 25}%) ou em alavancagem elevada (≥ 20x), entra automaticamente em <strong>Margem Cruzada (Cross)</strong> na Bitunix. Isso evita que a corretora liquide a posição antes do preço atingir o seu Stop Loss planejado.
                  </p>
                  <div className="flex items-center justify-between p-2 rounded bg-[#131722] border border-[#2a2e39] text-xs">
                    <span className="text-gray-300">Gatilho de Mudança para Cruzada (SL Alavancado):</span>
                    <div className="flex items-center gap-1.5">
                      <input
                        type="number"
                        step="5"
                        min="15"
                        max="95"
                        disabled={isLockedForLeo || form.autoCrossMarginEnabled === false}
                        value={form.autoCrossMarginThreshold || 25}
                        onChange={(e) => setForm((prev) => ({ ...prev, autoCrossMarginThreshold: parseFloat(e.target.value) || 25 }))}
                        className="w-14 px-2 py-0.5 bg-[#1e222d] border border-[#2a2e39] rounded text-center text-emerald-400 font-bold disabled:opacity-50"
                      />
                      <span className="text-emerald-400 font-bold">%</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* Limite Diário (Stop Diário da Parceria) */}
              <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingDown className="w-4 h-4 text-orange-400" />
                    <span className="text-xs font-bold text-white">Trava de Perda Diária Global (Daily Drawdown)</span>
                  </div>
                  <span className="text-xs font-mono font-bold text-orange-400">
                    Máx: ${form.dailyLossLimitUsd} USD ({form.dailyLossLimitPercent}%)
                  </span>
                </div>
                <p className="text-[11px] text-gray-400">
                  Se o somatório de perdas de hoje atingir este valor, o sistema bloqueia novas execuções até a virada do dia para proteger o capital.
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">Limite em $:</span>
                    <input
                      type="number"
                      min="10"
                      max="1000"
                      disabled={isLockedForLeo}
                      value={form.dailyLossLimitUsd}
                      onChange={(e) => setForm((prev) => ({ ...prev, dailyLossLimitUsd: parseFloat(e.target.value) || 50 }))}
                      className="w-full px-3 py-1.5 bg-[#131722] border border-[#2a2e39] rounded-lg text-xs font-bold text-orange-400 focus:outline-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400">Perda hoje:</span>
                    <span className={`text-xs font-bold font-mono px-3 py-1.5 bg-[#131722] border border-[#2a2e39] rounded-lg flex-1 ${
                      todayLossUsd > 0 ? 'text-red-400' : 'text-emerald-400'
                    }`}>
                      ${todayLossUsd.toFixed(2)} USD
                    </span>
                  </div>
                </div>
              </div>

            </div>
          )}

          {/* TAB 2: PERMISSÕES GRANULARES DO LEO */}
          {activeTab === 'partner_permissions' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-blue-950/30 border border-blue-900/40">
                <h4 className="text-xs font-bold text-white flex items-center gap-1.5 mb-1">
                  <KeyRound className="w-4 h-4 text-blue-400" />
                  <span>Controle Granular de Acesso para o Leo</span>
                </h4>
                <p className="text-xs text-gray-300">
                  Ative ou desative exatamente o que o Leo pode alterar quando ele assumir o turno dos sinais:
                </p>
              </div>

              {/* Lista de Permissões com Switches Interativos */}
              <div className="space-y-2.5">
                {[
                  {
                    key: 'canEditRisk' as keyof PartnerPermissions,
                    title: 'Pode alterar o Risco por Operação (% ou $)',
                    desc: 'Se desativado, o risco fica fixado em 2% e o Leo não pode alterar a margem.',
                    recommended: false
                  },
                  {
                    key: 'canEditLeverage' as keyof PartnerPermissions,
                    title: 'Pode alterar a Alavancagem da Ordem',
                    desc: 'Permite usar a alavancagem livre do sinal de copy trade.',
                    recommended: true
                  },
                  {
                    key: 'canDisableStopLoss' as keyof PartnerPermissions,
                    title: 'Pode remover ou desativar o Stop Loss',
                    desc: 'Se desativado, toda ordem enviada pelo Leo OBRIGATORIAMENTE terá Stop Loss.',
                    recommended: false
                  },
                  {
                    key: 'canEditTrailingStop' as keyof PartnerPermissions,
                    title: 'Pode alterar ou desativar o Trailing Stop 1x',
                    desc: 'Se desativado, o Trailing Stop 1:1 é forçado em todas as ordens.',
                    recommended: false
                  },
                  {
                    key: 'canExecuteRealTrading' as keyof PartnerPermissions,
                    title: 'Pode executar ordens em Conta Real (USDT)',
                    desc: 'Se desativado, o Leo é forçado a operar apenas em Simulação (VST).',
                    recommended: true
                  },
                  {
                    key: 'canOverrideTakeProfits' as keyof PartnerPermissions,
                    title: 'Pode selecionar e customizar Alvos de Take Profit (TP1, TP2, etc.)',
                    desc: 'Permite ao Leo escolher qual alvo de saída utilizar.',
                    recommended: true
                  },
                  {
                    key: 'canEditApiKeys' as keyof PartnerPermissions,
                    title: 'Pode visualizar ou alterar Chaves de API Bitunix',
                    desc: 'Protege suas chaves de API secretas da corretora contra alterações.',
                    recommended: false
                  },
                  {
                    key: 'canClearLogsOrHistory' as keyof PartnerPermissions,
                    title: 'Pode apagar Histórico de Ordens e Logs de Auditoria',
                    desc: 'Garante que Bruno possa auditar todas as ações realizadas.',
                    recommended: false
                  }
                ].map((item) => {
                  const isAllowed = form.partnerPermissions[item.key];
                  return (
                    <div
                      key={item.key}
                      className="p-3.5 rounded-xl bg-[#1e222d] border border-[#2a2e39] flex items-center justify-between gap-4 transition-colors hover:border-[#3a3f4d]"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-white">{item.title}</span>
                          {item.recommended ? (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 bg-emerald-500/10 text-emerald-400 rounded">Recomendado Permitir</span>
                          ) : (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 bg-red-500/10 text-red-400 rounded">Recomendado Bloquear</span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400">{item.desc}</p>
                      </div>

                      <button
                        type="button"
                        disabled={isLockedForLeo}
                        onClick={() => updatePermission(item.key, !isAllowed)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 ${
                          isAllowed ? 'bg-blue-600' : 'bg-gray-700'
                        } ${isLockedForLeo ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                            isAllowed ? 'translate-x-6' : 'translate-x-1'
                          }`}
                        />
                      </button>
                    </div>
                  );
                })}
              </div>

            </div>
          )}

          {/* TAB 3: PRESETS RÁPIDOS */}
          {activeTab === 'presets' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-300">
                Selecione um preset pré-configurado com 1 clique para carregar as travas ideais:
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {/* Preset 1: Conservador Bruno */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-emerald-500/40 hover:border-emerald-500 flex flex-col justify-between space-y-3 transition-all">
                  <div>
                    <div className="w-8 h-8 rounded-lg bg-emerald-600/20 text-emerald-400 flex items-center justify-center font-bold mb-2">
                      🛡️
                    </div>
                    <h4 className="text-xs font-bold text-white">Conservador do Bruno (Recomendado)</h4>
                    <p className="text-[11px] text-gray-400 mt-1">
                      Perda travada em 2%, Trailing Stop 1x forçado, Alavancagem livre e Stop Loss obrigatório.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isLockedForLeo}
                    onClick={() => applyPreset('bruno_conservative')}
                    className="w-full py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    Aplicar Preset 2%
                  </button>
                </div>

                {/* Preset 2: Moderado 3% */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] hover:border-blue-500 flex flex-col justify-between space-y-3 transition-all">
                  <div>
                    <div className="w-8 h-8 rounded-lg bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold mb-2">
                      ⚖️
                    </div>
                    <h4 className="text-xs font-bold text-white">Moderado (3% de Risco)</h4>
                    <p className="text-[11px] text-gray-400 mt-1">
                      Risco de 3% por trade, Daily Loss em 8%, Trailing 1x e Alavancagem livre.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isLockedForLeo}
                    onClick={() => applyPreset('moderate')}
                    className="w-full py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    Aplicar Preset 3%
                  </button>
                </div>

                {/* Preset 3: Treinamento Demo */}
                <div className="p-4 rounded-xl bg-[#1e222d] border border-[#2a2e39] hover:border-purple-500 flex flex-col justify-between space-y-3 transition-all">
                  <div>
                    <div className="w-8 h-8 rounded-lg bg-purple-600/20 text-purple-400 flex items-center justify-center font-bold mb-2">
                      🧪
                    </div>
                    <h4 className="text-xs font-bold text-white">Modo Treinamento (Demo VST)</h4>
                    <p className="text-[11px] text-gray-400 mt-1">
                      Leo só pode operar em conta demo VST, sem risco de perder dinheiro real.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isLockedForLeo}
                    onClick={() => applyPreset('demo_only')}
                    className="w-full py-2 bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-colors"
                  >
                    Aplicar Modo Demo
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Resumo Dinâmico em Tempo Real "O que o Leo pode fazer agora" */}
          <div className="p-4 rounded-xl bg-[#181b24] border border-[#2a2e39] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-gray-300 flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-blue-400" />
                Resumo em Tempo Real para o Turno do Leo:
              </span>
              <span className="text-[10px] text-gray-400 font-mono">Status das Travas</span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
              <div className="p-2 rounded bg-[#131722] border border-[#2a2e39]">
                <span className="text-gray-500 block text-[9px]">RISCO POR TRADE</span>
                <span className="text-emerald-400 font-bold">{form.maxRiskPercent}% Fixo</span>
              </div>

              <div className="p-2 rounded bg-[#131722] border border-[#2a2e39]">
                <span className="text-gray-500 block text-[9px]">ALAVANCAGEM</span>
                <span className="text-amber-400 font-bold">{form.allowFreeLeverage ? 'Livre (Sinal)' : `${form.maxLeverageCap}x Teto`}</span>
              </div>

              <div className="p-2 rounded bg-[#131722] border border-[#2a2e39]">
                <span className="text-gray-500 block text-[9px]">TRAILING STOP</span>
                <span className="text-cyan-400 font-bold">{form.lockTrailingStop1x ? '1.0x Forçado' : 'Custom'}</span>
              </div>

              <div className="p-2 rounded bg-[#131722] border border-[#2a2e39]">
                <span className="text-gray-500 block text-[9px]">CONTA REAL</span>
                <span className={form.partnerPermissions.canExecuteRealTrading ? 'text-emerald-400 font-bold' : 'text-purple-400 font-bold'}>
                  {form.partnerPermissions.canExecuteRealTrading ? 'Autorizada' : 'Somente Demo'}
                </span>
              </div>
            </div>
          </div>

        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between px-4 sm:px-6 py-3.5 border-t border-[#2a2e39] bg-[#111319] shrink-0">
          <button
            type="button"
            disabled={isLockedForLeo}
            onClick={() => applyPreset('bruno_conservative')}
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-40"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Padrão Bruno (2% + Trailing 1x)</span>
          </button>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-gray-400 hover:text-white transition-colors"
            >
              Fechar
            </button>

            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isLockedForLeo}
              className={`px-5 py-2 text-xs font-bold text-white rounded-lg flex items-center gap-1.5 transition-all shadow-lg ${
                isLockedForLeo
                  ? 'bg-gray-700 opacity-60 cursor-not-allowed'
                  : 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-600/25'
              }`}
            >
              {isSaving ? (
                <span>Salvando na Nuvem...</span>
              ) : saveSuccess ? (
                <>
                  <Check className="w-4 h-4 text-white" />
                  <span>Configuração Salva!</span>
                </>
              ) : isLockedForLeo ? (
                <>
                  <Lock className="w-4 h-4" />
                  <span>Travado pelo Bruno</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" />
                  <span>Salvar Regras na Nuvem</span>
                </>
              )}
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
