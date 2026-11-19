import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Wallet,
  Target,
  TrendingUp,
  TrendingDown,
  RefreshCw,
  Copy,
  Check,
  Shield,
  Award,
  Zap,
  Percent,
  ExternalLink,
  ChevronRight,
  Sparkles,
  Info,
  Clock,
  ArrowUpRight,
  HelpCircle,
  MessageSquare
} from 'lucide-react';

interface CopyTradeDashboardProps {
  apiKey?: string;
  apiSecret?: string;
  accountType?: 'USDT' | 'VST';
  onSelectSymbolForChart?: (symbol: string) => void;
}

interface TraderDetail {
  contractType?: string;
  traderId?: string;
  status?: string;
  accountLevel?: string;
  ratio?: string;
  accountAssets?: string;
  copierProfit?: string;
  copiersNum?: string;
  riskLevel?: string;
  winRatio?: string;
  tradeNum?: number;
  winNum?: number;
  loseNum?: number;
  averageProfit?: string;
  averageLosses?: string;
  pnlRatio?: string;
  averageTime?: string;
  marginMedian?: string;
  leverageMedian?: string;
  tradeFrequency?: string;
  tradeDays?: string;
  lastTrade?: number;
}

interface ProfitSummary {
  contractType?: string;
  earn?: string;
  settled?: string;
  profitRatio?: number;
}

interface OpenPosition {
  symbol: string;
  cleanSymbol?: string;
  positionSide: 'LONG' | 'SHORT';
  leverage: number;
  entryPrice: number;
  markPrice: number;
  unrealizedProfit: number;
  pnlPercent: number;
  margin: number;
  notional: number;
  stopLoss?: number | null;
  takeProfit?: number | null;
}

export const CopyTradeDashboard: React.FC<CopyTradeDashboardProps> = ({
  apiKey = '',
  apiSecret = '',
  accountType = 'USDT',
  onSelectSymbolForChart
}) => {
  const [loading, setLoading] = useState(false);
  const [traderDetail, setTraderDetail] = useState<TraderDetail | null>(null);
  const [profitSummary, setProfitSummary] = useState<ProfitSummary | null>(null);
  const [openPositions, setOpenPositions] = useState<OpenPosition[]>([]);
  const [lastSync, setLastSync] = useState<Date | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState(false);
  const [activeTab, setActiveTab] = useState<'positions' | 'guide' | 'performance'>('positions');

  const fetchOverview = useCallback(async () => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const q = new URLSearchParams({
        accountType: accountType || 'USDT',
        ...(apiKey ? { apiKey } : {}),
        ...(apiSecret ? { apiSecret } : {})
      });
      const res = await fetch(`/api/copytrade/overview?${q.toString()}`);
      const data = await res.json();
      if (data.success) {
        if (data.traderDetail) setTraderDetail(data.traderDetail);
        if (data.profitSummary) setProfitSummary(data.profitSummary);
        if (Array.isArray(data.openPositions)) setOpenPositions(data.openPositions);
        setLastSync(new Date());
      } else {
        setErrorMsg(data.error || 'Não foi possível carregar os dados do Copy Trade.');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Erro de conexão ao buscar dados de Copy Trade.');
    } finally {
      setLoading(false);
    }
  }, [apiKey, apiSecret, accountType]);

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 15000);
    return () => clearInterval(interval);
  }, [fetchOverview]);

  const copyTraderId = (id: string) => {
    navigator.clipboard.writeText(id);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 2000);
  };

  const traderId = traderDetail?.traderId || '35812519';
  const level = traderDetail?.accountLevel || 'Bronze';
  const copiersNum = parseInt(traderDetail?.copiersNum || '0', 10);
  const assets = parseFloat(traderDetail?.accountAssets || '0');
  const copierProfit = parseFloat(traderDetail?.copierProfit || '0');
  const winRatioStr = traderDetail?.winRatio || '0%';
  const winNum = traderDetail?.winNum || 0;
  const loseNum = traderDetail?.loseNum || 0;
  const tradeNum = traderDetail?.tradeNum || (winNum + loseNum);
  const profitSharePct = Math.round((profitSummary?.profitRatio ?? 0.1) * 100);
  const riskLevel = traderDetail?.riskLevel || '3';
  const leverageMedian = traderDetail?.leverageMedian || '25X';
  const marginMedian = traderDetail?.marginMedian || '1.55';
  const tradeFrequency = traderDetail?.tradeFrequency || '12.5';
  const tradeDays = traderDetail?.tradeDays || '10';

  const isCopierProfitPositive = copierProfit >= 0;

  return (
    <div id="copytrade-dashboard-container" className="flex-1 flex flex-col h-full bg-brand-bg text-brand-text overflow-y-auto p-3 sm:p-5 space-y-4">
      {/* Top Banner / Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 bg-brand-surface border border-brand-border rounded-xl p-4 sm:p-5">
        <div className="flex items-center space-x-3.5">
          <div className="w-11 h-11 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
            <Users className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <div className="flex items-center space-x-2.5 flex-wrap">
              <h1 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                Painel Copy Trade (Trader Líder)
              </h1>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
                Bitunix Swap 2.0
              </span>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                Líder Ativo
              </span>
            </div>
            <p className="text-xs text-brand-text/60 mt-0.5">
              Gerencie seus seguidores, acompanhe o lucro gerado e compartilhe seu Trader ID na Bitunix
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2.5 self-end md:self-auto">
          {lastSync && (
            <span className="text-[11px] text-brand-text/40 hidden sm:inline-block">
              Sincronizado: {lastSync.toLocaleTimeString('pt-BR')}
            </span>
          )}
          <button
            onClick={fetchOverview}
            disabled={loading}
            className="flex items-center space-x-1.5 px-3 py-1.5 bg-brand-bg hover:bg-brand-border/60 border border-brand-border text-xs text-brand-text rounded-lg transition-all"
            title="Atualizar dados do Copy Trade"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-brand-accent' : 'text-brand-text/70'}`} />
            <span>{loading ? 'Atualizando...' : 'Atualizar'}</span>
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="p-3.5 bg-amber-500/10 border border-amber-500/20 rounded-xl text-amber-300 text-xs flex items-center space-x-2">
          <Info className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Primary Key Metrics Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Metric 1: Seguidores Ativos */}
        <div className="bg-brand-surface border border-brand-border rounded-xl p-3.5 sm:p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-brand-text/60 font-medium">Seguidores Ativos</span>
            <div className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Users className="w-4 h-4 text-blue-400" />
            </div>
          </div>
          <div className="mt-2.5">
            <span className="text-2xl sm:text-3xl font-extrabold text-white font-mono">
              {copiersNum}
            </span>
            <p className="text-[11px] text-brand-text/50 mt-0.5">
              usuários copiando suas ordens
            </p>
          </div>
        </div>

        {/* Metric 2: Lucro dos Copiadores */}
        <div className="bg-brand-surface border border-brand-border rounded-xl p-3.5 sm:p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-brand-text/60 font-medium">Lucro dos Copiadores</span>
            <div className={`w-7 h-7 rounded-lg ${isCopierProfitPositive ? 'bg-emerald-500/10' : 'bg-red-500/10'} flex items-center justify-center`}>
              {isCopierProfitPositive ? (
                <TrendingUp className="w-4 h-4 text-emerald-400" />
              ) : (
                <TrendingDown className="w-4 h-4 text-red-400" />
              )}
            </div>
          </div>
          <div className="mt-2.5">
            <span className={`text-2xl sm:text-3xl font-extrabold font-mono ${isCopierProfitPositive ? 'text-emerald-400' : 'text-red-400'}`}>
              {isCopierProfitPositive ? '+' : ''}{copierProfit.toFixed(2)} <span className="text-xs font-normal text-brand-text/50">USDT</span>
            </span>
            <p className="text-[11px] text-brand-text/50 mt-0.5">
              PnL acumulado dos seguidores
            </p>
          </div>
        </div>

        {/* Metric 3: Win Rate */}
        <div className="bg-brand-surface border border-brand-border rounded-xl p-3.5 sm:p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-brand-text/60 font-medium">Taxa de Acerto</span>
            <div className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <Target className="w-4 h-4 text-amber-400" />
            </div>
          </div>
          <div className="mt-2.5">
            <span className="text-2xl sm:text-3xl font-extrabold text-white font-mono">
              {winRatioStr}
            </span>
            <p className="text-[11px] text-brand-text/50 mt-0.5">
              {winNum}V / {loseNum}D ({tradeNum} trades)
            </p>
          </div>
        </div>

        {/* Metric 4: Sua Comissão (Profit Share) */}
        <div className="bg-brand-surface border border-brand-border rounded-xl p-3.5 sm:p-4 flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs text-brand-text/60 font-medium">Sua Comissão (Profit Share)</span>
            <div className="w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <Percent className="w-4 h-4 text-emerald-400" />
            </div>
          </div>
          <div className="mt-2.5">
            <span className="text-2xl sm:text-3xl font-extrabold text-emerald-400 font-mono">
              {profitSharePct}%
            </span>
            <p className="text-[11px] text-brand-text/50 mt-0.5">
              do lucro dos copiadores para você
            </p>
          </div>
        </div>
      </div>

      {/* Leader Profile & Operational Details Bar */}
      <div className="bg-brand-surface border border-brand-border rounded-xl p-4">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          {/* Trader ID Box */}
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex items-center justify-center shrink-0">
              <Award className="w-5 h-5 text-yellow-400" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="text-xs font-semibold text-white uppercase tracking-wider">
                  Nível: {level}
                </span>
                <span className="text-[10px] bg-brand-bg px-2 py-0.5 rounded text-brand-text/60 border border-brand-border">
                  Risco Bitunix: {riskLevel}/5
                </span>
              </div>
              <div className="flex items-center space-x-2 mt-0.5">
                <span className="text-xs text-brand-text/50">Trader ID:</span>
                <code className="text-xs font-mono font-bold text-white bg-brand-bg px-2 py-0.5 rounded border border-brand-border">
                  {traderId}
                </code>
                <button
                  onClick={() => copyTraderId(traderId)}
                  className="p-1 text-brand-text/60 hover:text-brand-accent transition-colors"
                  title="Copiar Trader ID"
                >
                  {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* Quick Metrics Pills */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-brand-bg p-2 rounded-lg border border-brand-border">
              <span className="text-[10px] text-brand-text/50 block">Ativos da Conta</span>
              <span className="font-mono font-bold text-white">${assets.toFixed(2)} USDT</span>
            </div>
            <div className="bg-brand-bg p-2 rounded-lg border border-brand-border">
              <span className="text-[10px] text-brand-text/50 block">Alavancagem Média</span>
              <span className="font-mono font-bold text-white">{leverageMedian}</span>
            </div>
            <div className="bg-brand-bg p-2 rounded-lg border border-brand-border">
              <span className="text-[10px] text-brand-text/50 block">Margem Média</span>
              <span className="font-mono font-bold text-white">${marginMedian} USDT</span>
            </div>
            <div className="bg-brand-bg p-2 rounded-lg border border-brand-border">
              <span className="text-[10px] text-brand-text/50 block">Frequência / Dia</span>
              <span className="font-mono font-bold text-white">{tradeFrequency} trades</span>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs Header */}
      <div className="flex border-b border-brand-border space-x-4">
        <button
          onClick={() => setActiveTab('positions')}
          className={`pb-2 text-xs font-semibold transition-all border-b-2 ${
            activeTab === 'positions'
              ? 'border-brand-accent text-white'
              : 'border-transparent text-brand-text/50 hover:text-brand-text'
          }`}
        >
          Posições Copiadas Ativas ({openPositions.length})
        </button>
        <button
          onClick={() => setActiveTab('guide')}
          className={`pb-2 text-xs font-semibold transition-all border-b-2 ${
            activeTab === 'guide'
              ? 'border-brand-accent text-white'
              : 'border-transparent text-brand-text/50 hover:text-brand-text'
          }`}
        >
          Como Convidar Seguidores & Compartilhar
        </button>
        <button
          onClick={() => setActiveTab('performance')}
          className={`pb-2 text-xs font-semibold transition-all border-b-2 ${
            activeTab === 'performance'
              ? 'border-brand-accent text-white'
              : 'border-transparent text-brand-text/50 hover:text-brand-text'
          }`}
        >
          Comissões & Regras do Trader Líder
        </button>
      </div>

      {/* Tab 1: Posições Ativas Copiadas */}
      {activeTab === 'positions' && (
        <div className="space-y-3">
          {openPositions.length === 0 ? (
            <div className="bg-brand-surface border border-brand-border rounded-xl p-8 text-center">
              <Zap className="w-8 h-8 text-brand-text/30 mx-auto mb-2" />
              <h3 className="text-sm font-semibold text-white">Nenhuma posição aberta no momento</h3>
              <p className="text-xs text-brand-text/50 max-w-md mx-auto mt-1">
                Quando você ou seu robô abre uma ordem de futuros na Bitunix, ela é espelhada instantaneamente para todos os seus {copiersNum} seguidores.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {openPositions.map((pos, idx) => {
                const isLong = pos.positionSide === 'LONG';
                const isGain = pos.unrealizedProfit >= 0;
                return (
                  <div key={idx} className="bg-brand-surface border border-brand-border rounded-xl p-4 flex flex-col justify-between">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isLong ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                          {isLong ? 'LONG' : 'SHORT'} {pos.leverage}x
                        </span>
                        <span className="font-bold text-white text-sm">{pos.symbol}</span>
                      </div>
                      <div className={`font-mono font-bold text-sm ${isGain ? 'text-emerald-400' : 'text-red-400'}`}>
                        {isGain ? '+' : ''}{pos.unrealizedProfit.toFixed(2)} USDT ({isGain ? '+' : ''}{pos.pnlPercent.toFixed(2)}%)
                      </div>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-[11px] bg-brand-bg p-2.5 rounded-lg border border-brand-border">
                      <div>
                        <span className="text-brand-text/40 block">Entrada</span>
                        <span className="font-mono text-white">${pos.entryPrice}</span>
                      </div>
                      <div>
                        <span className="text-brand-text/40 block">Atual</span>
                        <span className="font-mono text-white">${pos.markPrice}</span>
                      </div>
                      <div>
                        <span className="text-brand-text/40 block">Margem</span>
                        <span className="font-mono text-white">${pos.margin.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="text-brand-text/40 block">Stop Loss</span>
                        <span className="font-mono text-red-400">{pos.stopLoss ? `$${pos.stopLoss}` : 'Nenhum'}</span>
                      </div>
                    </div>

                    <div className="mt-3 pt-2.5 border-t border-brand-border/60 flex items-center justify-between text-[11px]">
                      <span className="text-blue-400 flex items-center space-x-1">
                        <Users className="w-3 h-3" />
                        <span>Espelhando para {copiersNum} seguidores</span>
                      </span>
                      {onSelectSymbolForChart && (
                        <button
                          onClick={() => onSelectSymbolForChart(pos.symbol)}
                          className="text-brand-text/60 hover:text-brand-accent flex items-center space-x-1 transition-colors"
                        >
                          <span>Ver Gráfico</span>
                          <ArrowUpRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: Guia de Compartilhamento */}
      {activeTab === 'guide' && (
        <div className="bg-brand-surface border border-brand-border rounded-xl p-5 space-y-4">
          <div className="flex items-center space-x-2 text-white font-semibold text-sm">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Como Novos Seguidores Podem Começar a Te Copiar</span>
          </div>

          <p className="text-xs text-brand-text/70 leading-relaxed">
            Como você já está cadastrado como <b>Trader Líder na Bitunix</b> com o ID <b>{traderId}</b>, qualquer pessoa no mundo pode copiar suas operações diretamente pelo app ou site da Bitunix.
          </p>

          <div className="space-y-3 mt-3">
            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5 flex items-start space-x-3">
              <span className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                1
              </span>
              <div className="text-xs">
                <span className="font-semibold text-white block">Envie seu Trader ID</span>
                <p className="text-brand-text/60 mt-0.5">
                  Compartilhe seu Trader ID <code className="text-white font-mono bg-brand-surface px-1.5 py-0.5 rounded border border-brand-border">{traderId}</code> com seus contatos ou comunidade.
                </p>
              </div>
            </div>

            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5 flex items-start space-x-3">
              <span className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                2
              </span>
              <div className="text-xs">
                <span className="font-semibold text-white block">Buscar no Menu Copy Trading da Bitunix</span>
                <p className="text-brand-text/60 mt-0.5">
                  O seguidor abre o app da Bitunix, toca em <b>Copy Trading</b>, clica na lupa de pesquisa e digita seu ID: <b>{traderId}</b>.
                </p>
              </div>
            </div>

            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5 flex items-start space-x-3">
              <span className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                3
              </span>
              <div className="text-xs">
                <span className="font-semibold text-white block">Configurar Margem e Confirmar Cópia</span>
                <p className="text-brand-text/60 mt-0.5">
                  Ele escolhe a quantia que deseja alocar (ex: $10, $50 ou $100 por ordem) e clica em <b>Copiar Agora</b>.
                </p>
              </div>
            </div>

            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5 flex items-start space-x-3">
              <span className="w-5 h-5 rounded-full bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold text-xs shrink-0 mt-0.5">
                4
              </span>
              <div className="text-xs">
                <span className="font-semibold text-white block">Lucro Compartilhado Automático (Profit Share)</span>
                <p className="text-brand-text/60 mt-0.5">
                  Toda vez que você tiver lucro em uma operação, a Bitunix credita automaticamente <b>{profitSharePct}% de comissão</b> na sua conta de futuros!
                </p>
              </div>
            </div>
          </div>

          <div className="pt-2 flex flex-wrap gap-2">
            <button
              onClick={() => copyTraderId(traderId)}
              className="px-3.5 py-2 bg-brand-accent hover:bg-brand-accent/80 text-white rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-all"
            >
              {copiedId ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              <span>{copiedId ? 'Copiado com sucesso!' : `Copiar Trader ID (${traderId})`}</span>
            </button>
          </div>
        </div>
      )}

      {/* Tab 3: Comissões & Regras */}
      {activeTab === 'performance' && (
        <div className="bg-brand-surface border border-brand-border rounded-xl p-5 space-y-4">
          <div className="flex items-center space-x-2 text-white font-semibold text-sm">
            <Award className="w-4 h-4 text-yellow-400" />
            <span>Regras de Comissões e Níveis Bitunix Copy Trade</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5">
              <span className="text-xs text-brand-text/50 block">Seu Nível Atual</span>
              <span className="text-lg font-bold text-yellow-400 mt-1 block">{level}</span>
              <p className="text-[11px] text-brand-text/60 mt-1">
                Comissão base: 10% de Profit Share
              </p>
            </div>

            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5">
              <span className="text-xs text-brand-text/50 block">Próximo Nível (Prata)</span>
              <span className="text-lg font-bold text-gray-300 mt-1 block">Prata (Silver)</span>
              <p className="text-[11px] text-brand-text/60 mt-1">
                Comissão sobe para até 16% de Profit Share
              </p>
            </div>

            <div className="bg-brand-bg border border-brand-border rounded-xl p-3.5">
              <span className="text-xs text-brand-text/50 block">Nível Ouro (Gold)</span>
              <span className="text-lg font-bold text-amber-300 mt-1 block">Ouro (Gold)</span>
              <p className="text-[11px] text-brand-text/60 mt-1">
                Comissão sobe para até 20% de Profit Share
              </p>
            </div>
          </div>

          <div className="bg-brand-bg border border-brand-border rounded-xl p-4 text-xs space-y-2 text-brand-text/70">
            <span className="font-semibold text-white block">Como funciona a liquidação dos lucros:</span>
            <p>
              • A Bitunix calcula o lucro líquido de cada seguidor e realiza a liquidação das comissões diretamente para a sua carteira USDT de futuros.
            </p>
            <p>
              • O sistema respeita o High Watermark da corretora (você recebe comissão sobre os lucros novos gerados para cada seguidor).
            </p>
            <p>
              • Todas as ordens enviadas por este sistema (seja via Robô, Sinal de Telegram ou Clique Rápido) são executadas na conta líder e replicadas automaticamente para a carteira de todos os {copiersNum} seguidores.
            </p>
          </div>
        </div>
      )}

      {/* Bottom Info: Telegram Command Reminder */}
      <div className="bg-brand-surface/70 border border-brand-border rounded-xl p-3.5 flex items-center justify-between text-xs">
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center shrink-0">
            <MessageSquare className="w-4 h-4 text-blue-400" />
          </div>
          <div>
            <span className="text-white font-medium">Acesso Rápido no Telegram:</span>
            <p className="text-brand-text/50 text-[11px]">
              Envie <code>/copy</code> para o bot no Telegram para receber este resumo atualizado a qualquer momento no celular!
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
