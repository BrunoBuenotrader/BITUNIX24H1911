/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  TrendingUp, 
  BarChart3, 
  Search, 
  LayoutDashboard, 
  Watch, 
  Settings, 
  Bell,
  ChevronRight,
  Plus,
  ArrowUpRight,
  ArrowDownRight,
  RefreshCw,
  Loader2,
  Wallet,
  Target,
  Activity,
  LineChart,
  ArrowRight,
  X,
  XCircle,
  Clock,
  Info,
  Terminal,
  ChevronDown,
  ChevronUp,
  ClipboardPaste,
  Zap,
  Users,
  Check,
  Key,
  FolderArchive
} from 'lucide-react';
import { 
  ResponsiveContainer, 
  ComposedChart, 
  Area, 
  Bar, 
  XAxis, 
  YAxis, 
  Tooltip, 
  ReferenceDot,
  CartesianGrid,
  Cell
} from 'recharts';
import TradingViewWidget from './components/TradingViewWidget';
import SignalTrader, { SavedBitunixAccountItem } from './components/SignalTrader';
import { CopyTradeDashboard } from './components/CopyTradeDashboard';
import { MultiAccountManager } from './components/MultiAccountManager';
import { SystemBackupModal } from './components/SystemBackupModal';

interface WatchlistItem {
  symbol: string;
  name: string;
  price: string;
  change: string;
  up: boolean;
}

const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { symbol: 'BITUNIX:BTCUSDT.P', name: 'Bitcoin', price: '-', change: '-', up: true },
  { symbol: 'BITUNIX:ETHUSDT.P', name: 'Ethereum', price: '-', change: '-', up: true },
  { symbol: 'BITUNIX:SOLUSDT.P', name: 'Solana', price: '-', change: '-', up: true },
];

export default function App() {
  const [currentSymbol, setCurrentSymbol] = useState('BITUNIX:BTCUSDT.P');
  const [chartInterval, setChartInterval] = useState('15');
  const [coinSearchInput, setCoinSearchInput] = useState('');
  const [showCoinDropdown, setShowCoinDropdown] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>(DEFAULT_WATCHLIST);
  const [loading, setLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [activeView, setActiveView] = useState<'signals' | 'dashboard' | 'charts' | 'watchlist' | 'notifications' | 'bot' | 'copytrade' | 'accounts'>('signals');
  const [botActive, setBotActive] = useState(false);
  const [isBackupModalOpen, setIsBackupModalOpen] = useState(false);
  
  interface BotTrade {
    id: string;
    symbol: string;
    type: 'LONG' | 'SHORT';
    entry: string;
    exit: string;
    leverage: string;
    margin: string;
    marginNum: number;
    value: string;
    pnl: string;
    pnlCash: string;
    pnlCashNum?: number;
    volume: string;
    fees: string;
    duration: string;
    status: 'OPEN' | 'CLOSED';
    time: string;
    livePnL?: string;
    livePnLCash?: string;
    strategy: string;
    slPrice?: number;
    tpPrice?: number;
    targetCash?: number; // Valor em $ para Take Profit e Stop Loss (1:1)
  }
  
  const [trades, setTrades] = useState<BotTrade[]>([]);
  
  const [unrealizedPnL, setUnrealizedPnL] = useState(0);
  const [unrealizedPnLCash, setUnrealizedPnLCash] = useState(0);

  const closedPnLSum = useMemo(() => {
    return trades
      .filter(t => t.status === 'CLOSED')
      .reduce((sum, t) => sum + (t.pnlCashNum || 0), 0);
  }, [trades]);

  const closedTrades = useMemo(() => trades.filter(t => t.status === 'CLOSED'), [trades]);
  
  // Bot Settings
  const [initialBalance, setInitialBalance] = useState(100);
  const [sessionStartBalance, setSessionStartBalance] = useState<number | null>(null);
  const [isEditingBalance, setIsEditingBalance] = useState(false);
  const [dailyStopLoss, setDailyStopLoss] = useState(5); // %
  const [dailyTakeProfit, setDailyTakeProfit] = useState(10); // %
  const [marginPerEntry, setMarginPerEntry] = useState(2); // %
  const [dailyPnL, setDailyPnL] = useState(0); // Acumulado do dia em %
  const [leverage, setLeverage] = useState(10);
  const [monthlyPnL, setMonthlyPnL] = useState(0); // Valor em $
  const [isCompounding, setIsCompounding] = useState(false);
  const [includeFees, setIncludeFees] = useState(true);
  const [feeRate, setFeeRate] = useState(0.05); // % por operação (entrada/saída)
  const [selectedStrategy, setSelectedStrategy] = useState<'moving_averages' | 'smart_pro' | 'pullback_medias' | 'bhb_trader'>('bhb_trader');
  const [maxLossPerTrade, setMaxLossPerTrade] = useState(5); // Risco ideal em $ por operação (PDF)
  const [useAutoLeverage, setUseAutoLeverage] = useState(true); // Alavancagem Ideal automática (PDF)

  // Volume and Fees tracking
  const [dailyVolume, setDailyVolume] = useState(0);
  const [dailyFees, setDailyFees] = useState(0);
  const [monthlyVolume, setMonthlyVolume] = useState(0);
  const [monthlyFees, setMonthlyFees] = useState(0);
  const [operationFrequency, setOperationFrequency] = useState(5); // Retornado para 5s para estabilidade de API
  const [timeframe, setTimeframe] = useState<'1m' | '5m' | '15m'>('1m');
  const [highLiquidityOnly, setHighLiquidityOnly] = useState(true);
  const [executionMode, setExecutionMode] = useState<'simulation' | 'api_real'>('api_real');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [accountType, setAccountType] = useState<'USDT' | 'VST'>('USDT');
  const [credentialsSavedFeedback, setCredentialsSavedFeedback] = useState(false);
  const [savedAccounts, setSavedAccounts] = useState<SavedBitunixAccountItem[]>([]);
  const [activeAccountId, setActiveAccountId] = useState<string>('');
  const [activeAccountLabel, setActiveAccountLabel] = useState<string>('Bitunix Futuros USDT');
  const [isSwitchingAccount, setIsSwitchingAccount] = useState<boolean>(false);

  const refreshCredentialsFromServer = React.useCallback(async () => {
    try {
      const r = await fetch('/api/credentials');
      const d = await r.json();
      if (d.ok) {
        if (d.apiKey) setApiKey(d.apiKey);
        if (d.apiSecret) setApiSecret(d.apiSecret);
        if (d.telegramToken) setTelegramBotToken(d.telegramToken);
        if (Array.isArray(d.savedAccounts)) setSavedAccounts(d.savedAccounts);
        if (d.activeAccountId) setActiveAccountId(d.activeAccountId);
        if (d.activeAccountLabel) setActiveAccountLabel(d.activeAccountLabel);
      }
    } catch {}
  }, []);

  useEffect(() => {
    refreshCredentialsFromServer();

    // KeepAlive heartbeat: keeps backend session alive and wakes polling on tab focus/visibility
    const pingHealth = () => {
      fetch('/api/health').catch(() => {});
    };
    const hbInterval = setInterval(pingHealth, 15000);
    const onWakeUp = () => {
      if (document.visibilityState === 'visible') {
        pingHealth();
      }
    };
    document.addEventListener('visibilitychange', onWakeUp);
    window.addEventListener('focus', pingHealth);
    return () => {
      clearInterval(hbInterval);
      document.removeEventListener('visibilitychange', onWakeUp);
      window.removeEventListener('focus', pingHealth);
    };
  }, [refreshCredentialsFromServer]);
  const isExecutingRef = useRef(false);
  const [isExecuting, setIsExecuting] = useState(false); // Keep state for UI feedback if needed
  
  const setExecution = (val: boolean) => {
    isExecutingRef.current = val;
    setIsExecuting(val);
  };

  const simRsiRef = useRef(50);

  // Real-time PnL simulation for open trades
  useEffect(() => {
    if (!botActive) return;
    
    // Function to fetch real PnL from API
    const syncRealPnL = async () => {
      if (executionMode !== 'api_real' || !apiKey || !apiSecret) return;

      try {
        const isVST = accountType === 'VST';
        const res = await fetch('/api/bitunix-proxy', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: '/openApi/swap/v2/user/positions',
            method: 'GET',
            params: {}, // Get all positions
            apiKey: apiKey.trim(),
            apiSecret: apiSecret.trim(),
            isDemo: isVST
          })
        });

        const resTxt = await res.text();
        let data;
        try {
          data = JSON.parse(resTxt);
        } catch (e) {
          // Igura erros silenciosamente no poll de PnL para não poluir logs se o servidor oscilar
          return;
        }

        if (data.code === 0 && data.data) {
          const positions = data.data;
          let totalUnPnL = 0;
          let totalUnPnLCash = 0;
          
          setTrades(prevTrades => prevTrades.map(trade => {
            if (trade.status === 'OPEN') {
              // Find matching position from API
              const apiPos = positions.find((p: any) => 
                (p.symbol?.replace('-', '') === trade.symbol) && 
                p.positionSide === trade.type
              );

              if (apiPos) {
                const unrealizedPnLVal = parseFloat(apiPos.unrealizedProfit);
                const margin = parseFloat(apiPos.margin) || trade.marginNum;
                const pnlPercentage = (unrealizedPnLVal / margin) * 100;

                // Monitoramento Automático para Pullback e BHBTrader (Alvo FINANCEIRO Baseado em Dólar)
                if ((trade.strategy === 'pullback_medias' || trade.strategy === 'bhb_trader') && trade.targetCash) {
                  const targetCashVal = trade.targetCash;
                  if (unrealizedPnLVal >= targetCashVal || unrealizedPnLVal <= -targetCashVal) {
                    // Close the real position immediately
                    const closeSide = trade.type === 'LONG' ? 'SELL' : 'BUY';
                    const isVST = accountType === 'VST';
                    let apiSymbol = trade.symbol.includes('-') ? trade.symbol : trade.symbol.replace('USDT', '-USDT');
                    const entryPriceReal = parseFloat(trade.entry);
                    const marginAmount = trade.marginNum;
                    const tradeLeverage = parseFloat(trade.leverage) || leverage;
                    const quantity = ((marginAmount * tradeLeverage) / entryPriceReal).toFixed(3);

                    fetch('/api/bitunix-proxy', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        endpoint: '/openApi/swap/v2/trade/order',
                        method: 'POST',
                        params: { symbol: apiSymbol, side: closeSide, positionSide: trade.type, type: "MARKET", quantity: quantity.toString() },
                        apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), isDemo: isVST
                      })
                    }).then(async (res) => {
                      const d = await res.json();
                      if (d.code === 0) {
                        const strategyLabel = trade.strategy === 'bhb_trader' ? 'BHBTrader' : 'Pullback';
                        addLog(`[${strategyLabel}] Alvo/Stop financeiro atingido ($${unrealizedPnLVal.toFixed(2)}). Posição encerrada total!`, unrealizedPnLVal > 0 ? 'success' : 'warning');
                        setTimeout(syncApiBalance, 2000);
                      }
                    }).catch(() => {});
                  }
                }

                return {
                  ...trade,
                  livePnL: (pnlPercentage >= 0 ? '+' : '') + pnlPercentage.toFixed(2) + '%',
                  livePnLCash: (unrealizedPnLVal >= 0 ? '+' : '-') + '$' + Math.abs(unrealizedPnLVal).toFixed(2)
                };
              } else {
                return {
                  ...trade,
                  status: 'CLOSED',
                  exit: 'EXT-CLOSE',
                  pnl: trade.livePnL || '0.00%',
                  pnlCash: trade.livePnLCash || '$0.00',
                  pnlCashNum: parseFloat((trade.livePnLCash || '0').replace(/[$\+]/g, '')),
                  duration: 'EXCHANGE'
                };
              }
            }
            return trade;
          }));
        }
      } catch (err) {
        console.error("Erro ao sincronizar PnL real:", err);
      }
    };

    const interval = setInterval(() => {
      if (executionMode === 'api_real') {
        syncRealPnL();
      } else {
            // Simulation mode
            setTrades(prevTrades => {
              const nextTrades = [...prevTrades];
              let tradesUpdated = false;

              for (let i = 0; i < nextTrades.length; i++) {
                const trade = nextTrades[i];
                if (trade.status === 'OPEN') {
                  const fluctuation = (Math.random() * 1.0 - 0.5);
                  const currentPnLStr = trade.livePnL || '0.00%';
                  const currentPnLPercent = parseFloat(currentPnLStr.replace('%', '').replace('+', ''));
                  let nextPnLPercent = currentPnLPercent + fluctuation;
                  
                  const margin = trade.marginNum;
                  const nextPnLCash = margin * (nextPnLPercent / 100);

                  // Technical Close for Pullback and BHBTrader (Simulation) - Based on CASH ($)
                  if (trade.strategy === 'pullback_medias' || trade.strategy === 'bhb_trader') {
                    // Valor do alvo financeiro definido na abertura (15% da margem simulada ou o valor do risco em dólar do BHBTrader)
                    const simulatedRiskAmount = trade.targetCash || (margin * 0.15); 
                    const currentCashValue = nextPnLCash;
                    
                    if (currentCashValue >= simulatedRiskAmount || currentCashValue <= -simulatedRiskAmount) {
                      const finalPnL = (currentCashValue / margin) * 100;
                      const tradeLeverage = parseFloat(trade.leverage) || leverage;
                      const fees = (margin * tradeLeverage * 2) * (feeRate / 100);
                      const pnlWithFees = currentCashValue - (includeFees ? fees : 0);
                      
                      nextTrades[i] = {
                        ...trade,
                        status: 'CLOSED',
                        exit: (trade.type === 'LONG' 
                          ? parseFloat(trade.entry) * (1 + (finalPnL / 100) / tradeLeverage) 
                          : parseFloat(trade.entry) * (1 - (finalPnL / 100) / tradeLeverage)).toFixed(4),
                        pnl: (finalPnL >= 0 ? '+' : '') + finalPnL.toFixed(2) + '%',
                        pnlCash: (pnlWithFees >= 0 ? '+' : '-') + '$' + Math.abs(pnlWithFees).toFixed(2),
                        pnlCashNum: pnlWithFees,
                        duration: 'ALVO FINANCEIRO',
                      };
                      
                      if ((executionMode as string) !== 'api_real') {
                         setInitialBalance(prev => prev + pnlWithFees);
                      }
                      
                      const isWin = currentCashValue >= simulatedRiskAmount;
                      const strategyLabel = trade.strategy === 'bhb_trader' ? 'BHBTrader' : 'Pullback';
                      addLog(`[${strategyLabel}] Saída ${isWin ? 'TAKE' : 'STOP'}: Alvo em dólar atingido ($${simulatedRiskAmount.toFixed(2)}).`, isWin ? 'success' : 'warning');
                      tradesUpdated = true;
                      continue;
                    }
                  }

                  nextTrades[i] = {
                    ...trade,
                    livePnL: (nextPnLPercent >= 0 ? '+' : '') + nextPnLPercent.toFixed(2) + '%',
                    livePnLCash: (nextPnLCash >= 0 ? '+' : '-') + '$' + Math.abs(nextPnLCash).toFixed(2)
                  };
                  tradesUpdated = true;
                }
              }
              return tradesUpdated ? nextTrades : prevTrades;
            });
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [botActive, executionMode, apiKey, apiSecret, accountType]);

  // Derived state for unrealized total - calculates from current trades state
  useEffect(() => {
    const openTradesForPnL = trades.filter(t => t.status === 'OPEN');
    const totalCash = openTradesForPnL.reduce((sum, t) => {
      const val = parseFloat(t.livePnLCash?.replace(/[$\+]/g, '') || '0');
      return sum + val;
    }, 0);
    
    setUnrealizedPnLCash(totalCash);
    if (sessionStartBalance && sessionStartBalance > 0) {
      setUnrealizedPnL((totalCash / sessionStartBalance) * 100);
    } else {
      setUnrealizedPnL(0);
    }
  }, [trades, sessionStartBalance]);

  const [systemLogs, setSystemLogs] = useState<{id: string, time: string, msg: string, type: 'info' | 'success' | 'error' | 'warning'}[]>([]);
  const [isLogsExpanded, setIsLogsExpanded] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<BotTrade | null>(null);
  const [sessionStartTime, setSessionStartTime] = useState<number | null>(null);
  const [sessionElapsed, setSessionElapsed] = useState(0);

  const closeAllPositions = async () => {
    setBotActive(false);
    addLog(`[SISTEMA] Solicitando fechamento TOTAL de operações...`, 'warning');
    
    // 1. Snapshot of open trades from state
    const openTradesToClose = trades.filter(t => t.status === 'OPEN');
    
    // 2. Clear simulation trades immediately in state
    setTrades(prev => prev.map(t => {
      if (t.status === 'OPEN') {
        return { 
          ...t, 
          status: 'CLOSED', 
          duration: 'STOP',
          pnlCashNum: parseFloat(t.livePnLCash?.replace(/[$\+]/g, '') || '0')
        };
      }
      return t;
    }));

    // 3. Real API Close - Total Emergency Clean
    if (executionMode === 'api_real' && apiKey && apiSecret) {
      try {
        const isVST = accountType === 'VST';
        const cleanKey = apiKey.trim();
        const cleanSecret = apiSecret.trim();
        
        // Fetch current active positions directly from exchange
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

        const text = await posRes.text();
        let posData;
        try {
          posData = JSON.parse(text);
        } catch (e) {
          addLog(`[API-ERRO] Resposta inválida da exchange ao buscar posições.`, 'error');
          return;
        }

        // Cancel all pending orders on Bitunix for each symbol first
        const symbolsToCancel = new Set<string>();
        if (posData.code === 0 && posData.data) {
          const apiPositions = Array.isArray(posData.data) ? posData.data.filter((p: any) => parseFloat(p.positionAmt) !== 0) : [];
          apiPositions.forEach((pos: any) => symbolsToCancel.add(pos.symbol));
        }
        openTradesToClose.forEach((trade) => {
          let s = trade.symbol.includes('-') ? trade.symbol : trade.symbol.replace('USDT', '-USDT');
          if (!s.endsWith('-USDT') && s.endsWith('USDT')) s = s.replace('USDT', '-USDT');
          symbolsToCancel.add(s);
        });

        symbolsToCancel.forEach(sym => {
          fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/allOpenOrders',
              method: 'DELETE',
              params: { symbol: sym },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          }).catch(() => {});
        });

        const closePromises: Promise<any>[] = [];

        if (posData.code === 0 && posData.data) {
          const apiPositions = Array.isArray(posData.data) ? posData.data.filter((p: any) => parseFloat(p.positionAmt) !== 0) : [];
          
          if (apiPositions.length === 0) {
            addLog(`[API] Nenhuma posição aberta encontrada na exchange.`, 'info');
          }

          apiPositions.forEach((pos: any) => {
            const amt = parseFloat(pos.positionAmt);
            const side = amt > 0 ? 'SELL' : 'BUY';
            const quantity = Math.abs(amt).toString();
            
            const promise = fetch('/api/bitunix-proxy', {
               method: 'POST',
               headers: { 'Content-Type': 'application/json' },
               body: JSON.stringify({
                 endpoint: '/openApi/swap/v2/trade/order',
                 method: 'POST',
                 params: { 
                   symbol: pos.symbol, 
                   side, 
                   positionSide: pos.positionSide, 
                   type: "MARKET", 
                   quantity
                 },
                 apiKey: cleanKey, 
                 apiSecret: cleanSecret, 
                 isDemo: isVST
               })
            }).then(async r => {
              const d = await r.json();
              if (d.code === 0) {
                addLog(`[API] Fechado com sucesso: ${pos.symbol} (${pos.positionSide})`, 'success');
              } else {
                addLog(`[API-ERRO] Falha ao fechar ${pos.symbol}: ${d.msg}`, 'error');
              }
            }).catch(() => {});
            closePromises.push(promise);
          });
        }

        // Safety Net: Also check state trades
        openTradesToClose.forEach((trade) => {
          let tradeSymbol = trade.symbol.includes('-') ? trade.symbol : trade.symbol.replace('USDT', '-USDT');
          if (!tradeSymbol.endsWith('-USDT') && tradeSymbol.endsWith('USDT')) {
            tradeSymbol = tradeSymbol.replace('USDT', '-USDT');
          }
          
          const closeSide = trade.type === 'LONG' ? 'SELL' : 'BUY';
          const posSide = trade.type === 'LONG' ? 'LONG' : 'SHORT';
          const entryPrice = parseFloat(trade.entry) || 1;
          const posVal = trade.marginNum ? (trade.marginNum * (parseFloat(trade.leverage) || 10)) : 10;
          const fallbackQty = (posVal / entryPrice).toFixed(4);
          
          const promise = fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/order',
              method: 'POST',
              params: { 
                symbol: tradeSymbol, 
                side: closeSide, 
                positionSide: posSide, 
                type: "MARKET",
                quantity: fallbackQty
              },
              apiKey: cleanKey, 
              apiSecret: cleanSecret, 
              isDemo: isVST
            })
          }).catch(() => {});
          closePromises.push(promise);
        });

        await Promise.allSettled(closePromises);
        setTimeout(syncApiBalance, 2000);
        addLog(`[API] Varredura de fechamento e cancelamento concluída.`, 'info');
      } catch (err) {
        addLog(`[API-ERRO] Erro crítico na rotina de parada.`, 'error');
      }
    }
  };

  const handleCloseSingleTrade = async (trade: BotTrade, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    addLog(`[AÇÃO] Solicitando fechamento de posição e cancelamento de ordens para ${trade.symbol}...`, 'warning');

    setTrades(prev => prev.map(t => {
      if (t.id === trade.id) {
        return {
          ...t,
          status: 'CLOSED',
          duration: 'MANUAL',
          exit: 'MANUAL-CLOSE',
          pnlCashNum: parseFloat(t.livePnLCash?.replace(/[$\+]/g, '') || '0')
        };
      }
      return t;
    }));

    if (selectedTrade?.id === trade.id) {
      setSelectedTrade(prev => prev ? { ...prev, status: 'CLOSED', duration: 'MANUAL', exit: 'MANUAL-CLOSE' } : null);
    }

    if (executionMode === 'api_real' && apiKey && apiSecret) {
      try {
        const isVST = accountType === 'VST';
        const cleanKey = apiKey.trim();
        const cleanSecret = apiSecret.trim();
        let apiSymbol = trade.symbol.includes('-') ? trade.symbol : trade.symbol.replace('USDT', '-USDT');
        if (!apiSymbol.endsWith('-USDT') && apiSymbol.endsWith('USDT')) {
          apiSymbol = apiSymbol.replace('USDT', '-USDT');
        }

        // 1. Fechamento Imediato e Garantido via close_all_position na Bitunix
        try {
          const directCloseRes = await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/api/v1/futures/trade/close_all_position',
              method: 'POST',
              params: { symbol: apiSymbol, action: 'CLOSE_ALL' },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
          const directData = await directCloseRes.json();
          if (directData.code === 0) {
            addLog(`[API] Posição em ${apiSymbol} encerrada a mercado na Bitunix!`, 'success');
          }
        } catch (e) {
          console.warn('Tentativa direta close_all_position:', e);
        }

        // 2. Cancelamento de TODAS as ordens pendentes, gatilhos, Stop Loss e Take Profit
        try {
          await fetch('/api/bitunix-proxy', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              endpoint: '/openApi/swap/v2/trade/allOpenOrders',
              method: 'DELETE',
              params: { symbol: apiSymbol },
              apiKey: cleanKey,
              apiSecret: cleanSecret,
              isDemo: isVST
            })
          });
        } catch (e) {
          console.warn('Erro ao cancelar ordens:', e);
        }

        // 3. Verificação de posição ativa para fechamento por lote/quantidade caso ainda reste resíduo
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
            const cleanSym = apiSymbol.replace('-', '').toUpperCase();
            const activePositions = positions.filter((p: any) => 
              p.symbol && p.symbol.replace('-', '').toUpperCase() === cleanSym && Math.abs(parseFloat(p.positionAmt || '0')) > 0
            );

            for (const pos of activePositions) {
              const amt = Math.abs(parseFloat(pos.positionAmt));
              if (amt > 0) {
                const isLong = pos.positionSide === 'LONG' || parseFloat(pos.positionAmt) > 0;
                const side = isLong ? 'SELL' : 'BUY';
                await fetch('/api/bitunix-proxy', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    endpoint: '/openApi/swap/v2/trade/order',
                    method: 'POST',
                    params: {
                      symbol: pos.symbol,
                      side: side,
                      positionSide: isLong ? 'LONG' : 'SHORT',
                      type: "MARKET",
                      quantity: amt.toString(),
                      tradeSide: 'CLOSE',
                      action: 'CLOSE_ALL',
                      reduceOnly: true
                    },
                    apiKey: cleanKey,
                    apiSecret: cleanSecret,
                    isDemo: isVST
                  })
                });
              }
            }
          }
        } catch (e: any) {
          console.warn('Erro ao varrer posições residuais:', e);
        }

        setTimeout(syncApiBalance, 1000);
        setTimeout(syncApiBalance, 3000);
      } catch (err: any) {
        addLog(`[API-ERRO] Erro ao encerrar operação: ${err.message}`, 'error');
      }
    } else {
      addLog(`[SIMULAÇÃO] Operação ${trade.symbol} fechada e ordens canceladas.`, 'info');
    }
  };

  const toggleBot = () => {
    if (botActive) {
      closeAllPositions();
    } else {
      setBotActive(true);
    }
  };

  const syncApiBalance = async (overrideAccountType?: 'USDT' | 'VST', overrideKeys?: { apiKey: string; apiSecret: string }) => {
    const targetType = overrideAccountType || accountType;
    const cleanKey = (overrideKeys?.apiKey ?? apiKey).trim();
    const cleanSecret = (overrideKeys?.apiSecret ?? apiSecret).trim();
    if (!cleanKey || !cleanSecret || executionMode === 'simulation') return;

    try {
      addLog(`[API] Sincronizando saldo da conta ${targetType} LIVE...`, 'info');
      let foundBalance: number | null = null;
      const response = await fetch('/api/bitunix-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          endpoint: '/openApi/swap/v2/user/balance',
          method: 'GET',
          params: {},
          apiKey: cleanKey,
          apiSecret: cleanSecret,
          isDemo: targetType === 'VST'
        })
      });
      
      const resText = await response.text();
      let result;
      try {
        result = JSON.parse(resText);
      } catch (e) {
        addLog(`[API-ERRO] Resposta inesperada do servidor (HTML). Tentando novamente...`, 'warning');
        return;
      }
      
      if (response.ok && result && result.code === 0) {
        // Bitunix response can have balance in multiple places depending on account type
        let balanceArray: any[] | null = null;

        if (Array.isArray(result.data)) {
          balanceArray = result.data;
        } else if (result.data && Array.isArray(result.data.balance)) {
          balanceArray = result.data.balance;
        } else if (result.data && Array.isArray(result.data.assets)) {
          balanceArray = result.data.assets;
        }

          if (balanceArray) {
            // Look for selected asset (USDT or VST)
            const account = balanceArray.find((b: any) => (b.asset === targetType || b.currency === targetType)) ||
                            balanceArray.find((b: any) => targetType === 'VST' ? (b.asset === 'VST' || b.currency === 'VST') : (b.asset === 'USDT' || b.currency === 'USDT')) ||
                            balanceArray[0];
            if (account) {
              const assetName = account.asset || account.currency || targetType;
              foundBalance = parseFloat(account.equity || account.balance || account.amount || account.availableMargin || "0");
              setInitialBalance(foundBalance);
              
              if (sessionStartBalance === null) setSessionStartBalance(foundBalance);
              
              if (sessionStartBalance && sessionStartBalance > 0) {
                const realPnLPercent = ((foundBalance - sessionStartBalance) / sessionStartBalance) * 100;
                setDailyPnL(realPnLPercent);
              }

              addLog(`[API] Sucesso! Saldo Atual: ${assetName} ${foundBalance.toFixed(2)}`, 'success');
            } else {
              addLog(`[API-AVISO] Não encontramos saldo em ${targetType}. Verifique se você possui fundos nesta moeda.`, 'warning');
            }
          } else if (result.data) {
            const target = result.data.balance || result.data;
            if (target) {
              const assetName = target.asset || target.currency || targetType;
              foundBalance = parseFloat(target.equity || target.balance || target.availableMargin || target.amount || "0");
              setInitialBalance(foundBalance);
              
              if (sessionStartBalance === null) setSessionStartBalance(foundBalance);
              
              if (sessionStartBalance && sessionStartBalance > 0) {
                const realPnLPercent = ((foundBalance - sessionStartBalance) / sessionStartBalance) * 100;
                setDailyPnL(realPnLPercent);
              }
              addLog(`[API] Sucesso! Saldo Atual: ${assetName} ${foundBalance.toFixed(2)}`, 'success');
            }
          }
      } else if (result) {
        // More detailed error parsing for Bitunix codes
        let errorMsg = result.msg || result.error || result.message;
        
        if (result.code === 0 && foundBalance === null) {
          errorMsg = `Não foi possível encontrar saldo ${targetType}. Tente as chaves em uma conta com fundos.`;
        } else if (!errorMsg) {
          errorMsg = `Erro Desconhecido (Status: ${response.status}, Code: ${result.code})`;
        }
        
        if (result.code === 100413) {
          errorMsg = "Chave API Incorreta ou Inválida.";
        } else if (result.code === 100001) {
          errorMsg = "Assinatura Inválida. Verifique seu API Secret.";
        } else if (result.code === 80012) {
          errorMsg = "IP não autorizado. Verifique as configurações da sua chave API.";
        }

        addLog(`[API-FALHA] ${errorMsg}`, 'error');
        if (result.code !== 0) addLog(`[DICA] Código Bitunix: ${result.code}`, 'warning');
      }
    } catch (err: any) {
      addLog(`[API] Erro de Rede: ${err.message}`, 'error');
    }
  };

  const handleSwitchSavedAccount = async (targetAccountId: string) => {
    if (!targetAccountId || isSwitchingAccount) return;
    setIsSwitchingAccount(true);
    try {
      const res = await fetch('/api/credentials/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: targetAccountId })
      });
      const d = await res.json();
      if (d.ok) {
        if (d.apiKey) setApiKey(d.apiKey);
        if (d.apiSecret) setApiSecret(d.apiSecret);
        if (d.activeAccountId) setActiveAccountId(d.activeAccountId);
        if (d.activeAccountLabel) setActiveAccountLabel(d.activeAccountLabel);
        if (Array.isArray(d.savedAccounts)) setSavedAccounts(d.savedAccounts);
        if (typeof d.balance === 'number' && d.balance >= 0) {
          setInitialBalance(d.balance);
          setSessionStartBalance(d.balance);
        }
        addLog(`[CONTA] Conta Bitunix alterada para "${d.activeAccountLabel}"!`, 'success');
        if (d.apiKey && d.apiSecret) {
          await syncApiBalance(undefined, { apiKey: d.apiKey, apiSecret: d.apiSecret });
        }
      } else {
        addLog(`[CONTA-ERRO] ${d.error || 'Falha ao alternar conta Bitunix.'}`, 'error');
      }
    } catch (err: any) {
      addLog(`[CONTA-ERRO] ${err?.message || 'Erro de rede ao alternar conta.'}`, 'error');
    } finally {
      setIsSwitchingAccount(false);
    }
  };

  useEffect(() => {
    if (executionMode === 'api_real' && apiKey.length > 20 && apiSecret.length > 20) {
      const timer = setTimeout(syncApiBalance, 1500);
      return () => clearTimeout(timer);
    }
  }, [apiKey, apiSecret, executionMode]);

  const addLog = (msg: string, type: 'info' | 'success' | 'error' | 'warning' = 'info') => {
    const newLog = {
      id: Math.random().toString(36).substr(2, 9),
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      msg,
      type
    };
    setSystemLogs(prev => [newLog, ...prev].slice(0, 50));
  };

  // Helper to generate simulated candlestick data for a trade
  const tradeChartData = useMemo(() => {
    if (!selectedTrade) return [];
    
    const entry = parseFloat(selectedTrade.entry) || 0;
    const exit = parseFloat(selectedTrade.exit) || 0;
    const dataPoints = 15;
    const data = [];
    
    if (entry === 0) return [];
    
    let lastClose = entry;
    const volatility = entry * 0.006;

    for (let i = 0; i < dataPoints; i++) {
        const progress = i / (dataPoints - 1);
        // Linear path from entry to exit as a baseline
        const baseline = entry + (exit - entry) * progress;
        
        const open = lastClose;
        // Last candle must end at exit price
        let close = i === dataPoints - 1 ? exit : baseline + (Math.random() - 0.5) * volatility;
        
        // Ensure some movement even if entry/exit are close
        if (i < dataPoints - 1 && Math.abs(close - open) < entry * 0.001) {
            close += (Math.random() > 0.5 ? 1 : -1) * entry * 0.002;
        }

        const high = Math.max(open, close) + Math.random() * (volatility * 0.5);
        const low = Math.min(open, close) - Math.random() * (volatility * 0.5);
        
        data.push({
            time: i,
            open,
            close,
            high,
            low,
            wick: [low, high],
            body: [open, close]
        });
        lastClose = close;
    }
    return data;
  }, [selectedTrade]);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    let timerInterval: NodeJS.Timeout;

    if (botActive) {
      if (!sessionStartTime) {
        const start = Date.now();
        setSessionStartTime(start);
        if (sessionStartBalance === null) {
          setSessionStartBalance(initialBalance);
        }
      }

      timerInterval = setInterval(() => {
        if (sessionStartTime) {
          setSessionElapsed(Math.floor((Date.now() - sessionStartTime) / 1000));
        }
      }, 1000);

      const runBotLogic = async () => {
        if (isExecutingRef.current) return;
        isExecutingRef.current = true;

        try {
          // 1. Sync Balance first to ensure we are using real data
          if (executionMode === 'api_real' && apiKey && apiSecret) {
            await syncApiBalance();
          }

          // Check Daily Limits
          if (dailyPnL >= dailyTakeProfit || dailyPnL <= -dailyStopLoss) {
            addLog(dailyPnL >= dailyTakeProfit ? "Meta diária atingida. Pausando..." : "Stop Loss diário atingido. Pausando...", 'warning');
            setBotActive(false);
            return;
          }

          // 1. Scan for signal
          const modeLabel = executionMode === 'api_real' ? '[API-LIVE]' : '[SIM]';
          const strategyLabel = selectedStrategy === 'smart_pro' ? 'SMARTPRO (RSI 2)' : 'MÉDIAS MÓVEIS';
          
          // Selection of pair to scan this tick
          const randomPair = watchlist[Math.floor(Math.random() * watchlist.length)];
          if (!randomPair) {
             isExecutingRef.current = false;
             setExecution(false);
             return;
          }

          // Strategy-specific signal detection
          let signalFound = false;
          let suggestedSide: 'LONG' | 'SHORT' = 'LONG';
          let strategyLog = '';
          const trendBullish = Math.random() > 0.45; // Simulated major trend

          const currentRsi = simRsiRef.current;
          const nextRsi = Math.max(2, Math.min(98, currentRsi + (Math.random() * 60 - 30)));
          const isRising = nextRsi > currentRsi;
          const isFalling = nextRsi < currentRsi;
          const crossedUp70 = currentRsi < 70 && nextRsi >= 70;
          const crossedDown30 = currentRsi > 30 && nextRsi <= 30;
          simRsiRef.current = nextRsi;

          // Check if we have an open trade for the CURRENT strategy and symbol that needs reversal check
          const activeTrade = trades.find(t => t.status === 'OPEN' && t.strategy === selectedStrategy && t.symbol === randomPair.symbol.split(':')[1]);
          const openTradesMargin = trades.filter(t => t.status === 'OPEN').reduce((sum, t) => sum + t.marginNum, 0);
          const availableMargin = initialBalance - openTradesMargin;
          const requiredMargin = initialBalance * marginPerEntry / 100;

          if (selectedStrategy === 'smart_pro') {
            if (activeTrade) {
              // Reversal check for SmartPro (RSI 2)
              if (activeTrade.type === 'LONG') {
                if (isFalling && crossedDown30) {
                   signalFound = true;
                   suggestedSide = 'SHORT';
                   strategyLog = `[SmartPro] REVERSÃO: RSI(2) cruzou 30 (${nextRsi.toFixed(1)}). Fechando COMPRA e abrindo VENDA.`;
                } else {
                   strategyLog = `[SmartPro] Mantendo COMPRA | RSI(2): ${nextRsi.toFixed(1)}...`;
                }
              } else { // SHORT
                if (isRising && crossedUp70) {
                   signalFound = true;
                   suggestedSide = 'LONG';
                   strategyLog = `[SmartPro] REVERSÃO: RSI(2) cruzou 70 (${nextRsi.toFixed(1)}). Fechando VENDA e abrindo COMPRA.`;
                } else {
                   strategyLog = `[SmartPro] Mantendo VENDA | RSI(2): ${nextRsi.toFixed(1)}...`;
                }
              }
            } else {
              // Standard Entry SmartPro
              if (isRising && crossedUp70) {
                if (trendBullish) {
                  signalFound = true;
                  suggestedSide = 'LONG';
                  strategyLog = `[SmartPro] Trend Confirmado + RSI(2) High (${nextRsi.toFixed(1)}). Abrindo COMPRA sustentada.`;
                } else {
                  strategyLog = `[SmartPro] RSI(2) em 70, mas Tendência Principal é de BAIXA. Ignorando sinal curto.`;
                }
              } else if (isFalling && crossedDown30) {
                if (!trendBullish) {
                  signalFound = true;
                  suggestedSide = 'SHORT';
                  strategyLog = `[SmartPro] Trend Confirmado + RSI(2) Low (${nextRsi.toFixed(1)}). Abrindo VENDA sustentada.`;
                } else {
                  strategyLog = `[SmartPro] RSI(2) em 30, mas Tendência Principal é de ALTA. Ignorando sinal curto.`;
                }
              } else {
                strategyLog = `[SmartPro] Dashboard: RSI(2) ${nextRsi.toFixed(1)} | Trend: ${trendBullish ? 'BULL' : 'BEAR'}`;
              }
            }
          } else if (selectedStrategy === 'pullback_medias') {
            // ESTRATÉGIA: PULLBACK NAS MÉDIAS (OPERACIONAL MANUAL)
            // Filtro: Médias Direcionais (SMA 20 > EMA 50 > SMA 200 para Alta)
            // Gatilho: Correção de 2-5 candles + Rompimento da Máxima (Long) ou Mínima (Short) do candle que tocou a média.
            
            const isTrendConsistent = Math.random() > 0.4; // Simula médias direcionais vs laterais
            const isBullishTrend = trendBullish; 
            const isCorrecting = Math.random() > 0.6; // Simula o preço voltando na média
            
            if (activeTrade) {
              strategyLog = `[Pullback] Em operação. Buscando alvo técnico 1:1...`;
            } else if (!isTrendConsistent) {
              strategyLog = `[Pullback] Scanner: Médias LATERAIS ou emboladas. Operação bloqueada.`;
            } else if (isCorrecting) {
              // Simulação do Gatilho: Rompimento da extremidade correta
              const priceAction = Math.random(); // 0-1
              
              if (isBullishTrend) {
                // Em tendência de ALTA, só aceitamos rompimento de MÁXIMA
                if (priceAction > 0.7) { // Rompeu a máxima
                  signalFound = true;
                  suggestedSide = 'LONG';
                  strategyLog = `[Pullback] COMPRA: Tendência de ALTA. Máxima do candle de sinal rompida após correção na SMA 20!`;
                } else if (priceAction < 0.3) { // Rompeu a mínima (ERRO QUE VOCÊ VIU)
                  strategyLog = `[Pullback] SINAL INVÁLIDO: Tendência de ALTA, mas rompeu mínima. Aguardando novo setup...`;
                } else {
                  strategyLog = `[Pullback] Scanner: Preço testando a média SMA 20. Aguardando rompimento da máxima...`;
                }
              } else {
                // Em tendência de BAIXA, só aceitamos rompimento de MÍNIMA
                if (priceAction > 0.7) { // Rompeu a mínima
                  signalFound = true;
                  suggestedSide = 'SHORT';
                  strategyLog = `[Pullback] VENDA: Tendência de BAIXA. Mínima do candle de sinal rompida após correção na EMA 50!`;
                } else if (priceAction < 0.3) { // Rompeu a máxima (Inverso)
                  strategyLog = `[Pullback] SINAL INVÁLIDO: Tendência de BAIXA, mas rompeu máxima. Aguardando novo setup...`;
                } else {
                  strategyLog = `[Pullback] Scanner: Preço testando a média EMA 50. Aguardando rompimento da mínima...`;
                }
              }
            } else {
              strategyLog = `[Pullback] Scanner: Tendência ${isBullishTrend ? 'ALTA' : 'BAIXA'}. Aguardando correção de 2-5 candles...`;
            }
          } else if (selectedStrategy === 'bhb_trader') {
            // ESTRATÉGIA: BHBTraderr (CONFLUÊNCIA SMART PRO + RSI PRO) - De Acordo com o PDF do Usuário
            const isTrendConsistent = Math.random() > 0.35; // Tendência clara em 30m ou 1h
            const isCorrecting = Math.random() > 0.45; // Em correção (2 a 6 candles)
            const hasSRConfirmation = Math.random() > 0.4; // Pullback acontece em suporte (verde) para longa, ou resistência (vermelha) para short
            const isRsiProConfirmed = Math.random() > 0.3; // MACD sobrevendido/sobrecomprado + painel probabilidade alto 80%+

            if (activeTrade) {
              strategyLog = `[BHBTrader] Em operação. Monitorando stop técnico e alvo financeiro de $${activeTrade.targetCash || maxLossPerTrade} (PDF)...`;
            } else if (!isTrendConsistent) {
              strategyLog = `[BHBTrader] Scanner TV 30m/1H: Médias cruzando ou sem inclinação direção. Impedindo entrada...`;
            } else if (isCorrecting) {
              if (hasSRConfirmation && isRsiProConfirmed) {
                const triggerAction = Math.random();
                const corrCandles = Math.floor(Math.random() * 5 + 2); // 2 a 6 candles de correção de retração

                if (trendBullish) {
                  if (triggerAction > 0.55) {
                    signalFound = true;
                    suggestedSide = 'LONG';
                    strategyLog = `[BHBTrader] TAG "COMPRA" PLATADA! Pullback de ${corrCandles} candles no suporte (caixa verde). MACD sobrevendido + Painel RSI PRO 90% Alta. Entrando...`;
                  } else {
                    strategyLog = `[BHBTrader] Scanner: Preço corrigindo em Suporte (${corrCandles} candles). RSI PRO favorável. Esperando romper máxima...`;
                  }
                } else {
                  if (triggerAction > 0.55) {
                    signalFound = true;
                    suggestedSide = 'SHORT';
                    strategyLog = `[BHBTrader] TAG "VENDA" PLATADA! Pullback de ${corrCandles} candles na resistência (caixa vermelha). MACD sobrecomprado + Painel RSI PRO 85% Baixa. Entrando...`;
                  } else {
                    strategyLog = `[BHBTrader] Scanner: Preço corrigindo em Resistência (${corrCandles} candles). RSI PRO favorável. Esperando romper mínima...`;
                  }
                }
              } else {
                strategyLog = `[BHBTrader] Preço corrigindo na média, mas falta confluência técnica (Risco S/R ou RSI PRO no painel desfavorável. No PDF: precisa de suporte/resistência + MACD correto).`;
              }
            } else {
              strategyLog = `[BHBTrader] Scanner: Tendência ${trendBullish ? 'ALTA' : 'BAIXA'}. Aguardando pullback de 2 a 6 candles...`;
            }
          } else {
            // ESTRATÉGIA ORIGINAL: SCALPING AGRESSIVO (ALTA FREQUÊNCIA)
            const chance = Math.random();
            if (chance > 0.3) { // 70% de chance de sinal a cada 3s (Metralhadora de ordens)
              signalFound = true;
              suggestedSide = Math.random() > 0.5 ? 'LONG' : 'SHORT';
              strategyLog = `[Médias] Scalper AGRESSIVO: Cruzamento detectado! Ordem enviada imediatamente.`;
            } else {
              strategyLog = `[Médias] Scanner: Aguardando próxima micro-oscilação...`;
            }
          }

          addLog(`${modeLabel} ${strategyLog}`, 'info');

          // Gerenciamento de saída específico para Pullback de Médias e BHBTrader (1:1 Fixado)
          let tradeDuration = timeframe === '1m' ? 12000 : (timeframe === '5m' ? 25000 : 45000);

          if (selectedStrategy === 'pullback_medias' || selectedStrategy === 'bhb_trader') {
             // Pullback e BHBTrader usam 1:1 baseado no candle de sinal (simulado com tempos intermediários)
             tradeDuration = timeframe === '1m' ? 45000 : (timeframe === '5m' ? 120000 : 240000);
          }
          
          if (selectedStrategy === 'smart_pro') {
            // Smart Pro ainda usa tendência/reversão longa
            tradeDuration = timeframe === '1m' ? 60000 : (timeframe === '5m' ? 180000 : 360000);
          }

          if (signalFound) {
            // Margin Guard: Avoid opening too many positions if funds are low
            if (!activeTrade && availableMargin < requiredMargin) {
               addLog(`[SISTEMA] Margem Insuficiente ($${availableMargin.toFixed(2)} disponível). Aguardando fechamento de ordens.`, 'warning');
               isExecutingRef.current = false;
               setExecution(false);
               return;
            }

            // 0. If reversal, close the previous trade first
            if (activeTrade) {
               addLog(`[SISTEMA] Revertendo posição (${activeTrade.strategy})...`, 'info');
               
               if (executionMode === 'api_real' && apiKey && apiSecret) {
                  // Real API close
                  const rawSymbol = activeTrade.symbol;
                  const isVST = accountType === 'VST';
                  let apiSymbol = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');
                  const closeSide = activeTrade.type === 'LONG' ? 'SELL' : 'BUY';
                  const positionSide = activeTrade.type;
                  
                  const entryPriceReal = parseFloat(activeTrade.entry);
                  const marginAmount = activeTrade.marginNum;
                  const quantity = ((marginAmount * leverage) / entryPriceReal).toFixed(3);

                  fetch('/api/bitunix-proxy', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      endpoint: '/openApi/swap/v2/trade/order',
                      method: 'POST',
                      params: { symbol: apiSymbol, side: closeSide, positionSide, type: "MARKET", quantity: quantity.toString() },
                      apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), isDemo: isVST
                    })
                  }).then(res => res.json()).then(data => {
                    if (data.code === 0) {
                       addLog(`[API] Operação anterior encerrada com sucesso.`, 'success');
                       syncApiBalance();
                    }
                  });
               }

               // Simulation exit for the reversal
               const entryPrice = parseFloat(activeTrade.entry);
               const tradeId = activeTrade.id;
               const marginAmount = activeTrade.marginNum;
               
               // Reversal calculation
               const simulatedReversalPnL = 1.8 + (Math.random() * 3); 
               
               setTrades(prev => prev.map(t => t.id === tradeId ? {
                  ...t,
                  exit: (t.type === 'LONG' ? entryPrice * (1 + (simulatedReversalPnL / 100) / leverage) : entryPrice * (1 - (simulatedReversalPnL / 100) / leverage)).toFixed(4),
                  pnl: '+' + simulatedReversalPnL.toFixed(2) + '%',
                  pnlCash: '+' + '$' + (marginAmount * (simulatedReversalPnL / 100)).toFixed(2),
                  pnlCashNum: marginAmount * (simulatedReversalPnL / 100),
                  status: 'CLOSED',
                  duration: 'REVERSÃO'
               } : t));
               
               if (executionMode !== 'api_real') {
                  const profitVal = marginAmount * (simulatedReversalPnL / 100);
                  setInitialBalance(prev => prev + profitVal);
                  setDailyPnL(prev => prev + (profitVal / initialBalance * 100));
               }
            }

            const rawPrice = randomPair.price.replace(/[^0-9.]/g, '');
            const currentPrice = parseFloat(rawPrice) || 0;
            
            if (currentPrice === 0) return;

            setExecution(true);
            addLog(`${modeLabel} Sinal validado: ${randomPair.symbol.split(':')[1]} @ $${currentPrice.toFixed(2)} (TF: ${timeframe})`, 'success');
            
            if (executionMode === 'api_real') {
              const isLong = suggestedSide === 'LONG';
              const side = isLong ? 'BUY' : 'SELL';
              const positionSide = isLong ? 'LONG' : 'SHORT';
              
              const rawSymbol = randomPair.symbol.split(':')[1];
              // Use explicitly selected currency (USDT or VST)
              const isVST = accountType === 'VST'; 
              let apiSymbol = rawSymbol.includes('-') ? rawSymbol : rawSymbol.replace('USDT', '-USDT');

              const marginAmount = initialBalance * marginPerEntry / 100;
              // Alavancagem ideal/automática e dados do operacional do PDF
              let finalLeverage = leverage;
              if (selectedStrategy === 'bhb_trader' && useAutoLeverage) {
                const simulatedStopPercent = 1.5 + (Math.random() * 1.5); // ex: 1.5% a 3% distância do stop
                // No gerenciamento de risco do PDF: L = Perda Dólar / (Margem * Stop%)
                finalLeverage = Math.max(2, Math.min(50, Math.round(maxLossPerTrade / (marginAmount * (simulatedStopPercent / 100)))));
                addLog(`[BHBTrader] Alavancagem Ideal: ${finalLeverage}x (Risco: $${maxLossPerTrade}, Stop: ${simulatedStopPercent.toFixed(2)}%)`, 'success');
              }
              const quantity = ((marginAmount * finalLeverage) / currentPrice).toFixed(3);

              addLog(`[API] Abrindo ${positionSide} em ${apiSymbol} (Qtd: ${quantity}, Lav: ${finalLeverage}x)...`, 'info');

              try {
                // Set Leverage
                await fetch('/api/bitunix-proxy', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    endpoint: '/openApi/swap/v2/trade/leverage',
                    method: 'POST',
                    params: { symbol: apiSymbol, leverage: finalLeverage.toString(), side: positionSide },
                    apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), isDemo: isVST
                  })
                });

                const orderRes = await fetch('/api/bitunix-proxy', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    endpoint: '/openApi/swap/v2/trade/order',
                    method: 'POST',
                    params: { symbol: apiSymbol, side, positionSide, type: "MARKET", quantity: quantity.toString() },
                    apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), isDemo: isVST
                  })
                });
                
                const orderData = await orderRes.json();
                
                if (orderData.code === 0 && orderData.data) {
                  // Fallback for different order structures
                  const orderObj = orderData.data.order || orderData.data;
                  const realOrderId = (orderObj.orderId || orderObj.id || Math.random().toString(36).substr(2, 9)).toString();
                  const entryPriceReal = parseFloat(orderObj.avgPrice || orderObj.price || currentPrice.toString());
                  
                  addLog(`[API] ENTRADA Executada! ID: ${realOrderId} @ $${entryPriceReal.toFixed(2)}`, 'success');

                  // Create initial open trade
                  const openTrade: BotTrade = {
                    id: realOrderId,
                    symbol: rawSymbol,
                    type: positionSide,
                    entry: entryPriceReal.toFixed(4),
                    exit: '-',
                    leverage: finalLeverage.toString(),
                    margin: marginAmount.toFixed(2),
                    marginNum: marginAmount,
                    value: `$${(marginAmount * finalLeverage).toFixed(2)}`,
                    pnl: '0.00%',
                    pnlCash: '$0.00',
                    volume: `$${(marginAmount * finalLeverage).toFixed(2)}`,
                    fees: `$${(marginAmount * finalLeverage * (feeRate / 100)).toFixed(2)}`,
                    duration: 'OPEN',
                    status: 'OPEN',
                    livePnL: '0.00%',
                    livePnLCash: '$0.00',
                    strategy: selectedStrategy,
                    targetCash: (selectedStrategy === 'bhb_trader' || selectedStrategy === 'pullback_medias')
                      ? (selectedStrategy === 'bhb_trader' ? maxLossPerTrade : (marginAmount * 0.15))
                      : undefined,
                    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  };
                  setTrades(prev => [openTrade, ...prev]);

                  // Para estratégias de curto prazo (Médias), fechamos por tempo
                  // Pullback (Sinal Técnico) NÃO fecha por tempo
                  if (selectedStrategy !== 'smart_pro' && selectedStrategy !== 'pullback_medias' && selectedStrategy !== 'bhb_trader') {
                    setTimeout(async () => {
                      try {
                        const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
                        const closeRes = await fetch('/api/bitunix-proxy', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({
                            endpoint: '/openApi/swap/v2/trade/order',
                            method: 'POST',
                            params: { symbol: apiSymbol, side: closeSide, positionSide, type: "MARKET", quantity: quantity.toString() },
                            apiKey: apiKey.trim(), apiSecret: apiSecret.trim(), isDemo: isVST
                          })
                        });
                        
                        const closeData = await closeRes.json();
                        if (closeData.code === 0 && closeData.data) {
                          const closeObj = closeData.data.order || closeData.data;
                          const exitPriceReal = parseFloat(closeObj.avgPrice || closeObj.price || (entryPriceReal * (1 + (Math.random() * 0.002 - 0.001))).toString());
                          
                          addLog(`[API] SAÍDA em ${apiSymbol} @ $${exitPriceReal.toFixed(2)}.`, 'success');
                          
                          const priceChange = (exitPriceReal - entryPriceReal) / entryPriceReal;
                          const grossPnLPercent = (isLong ? priceChange : -priceChange) * leverage * 100;
                          const tradeVolume = marginAmount * leverage * 2;
                          const feesTotal = tradeVolume * (feeRate / 100);
                          const pnlCashReal = (marginAmount * (grossPnLPercent / 100)) - (includeFees ? feesTotal : 0);
                          const netPnLPercent = (pnlCashReal / marginAmount) * 100;
  
                          setTrades(prev => prev.map(t => t.id === realOrderId ? {
                            ...t,
                            exit: exitPriceReal.toFixed(4),
                            pnl: (netPnLPercent >= 0 ? '+' : '') + netPnLPercent.toFixed(2) + '%',
                            pnlCash: (pnlCashReal >= 0 ? '+' : '-') + '$' + Math.abs(pnlCashReal).toFixed(2),
                            pnlCashNum: pnlCashReal,
                            volume: `$${tradeVolume.toFixed(2)}`,
                            fees: `$${feesTotal.toFixed(2)}`,
                            duration: `${Math.floor(tradeDuration/1000)}s`,
                            status: 'CLOSED'
                          } : t));
  
                          setDailyVolume(prev => prev + tradeVolume);
                          setDailyFees(prev => prev + feesTotal);
  
                          // Wait 2 seconds for exchange to process, then sync balance
                          setTimeout(syncApiBalance, 2000);
                        }
                      } catch (err) {
                        addLog(`[API-ERRO] Falha ao fechar trade real.`, 'error');
                      }
                    }, tradeDuration); 
                  }
                } else {
                  addLog(`[API-ERRO] Falha ao abrir trade: ${orderData.msg || 'Erro'}`, 'error');
                }
              } catch (err: any) {
                addLog(`[API-ERRO] Rede: ${err.message}`, 'error');
              }
              return; // Exit here for real mode, we handled history in setTimeout
            }

            // SIMULATION MODE ONLY BELOW - Biased to be positive for the DEMO
            let finalLeverageSim = leverage;
            const simulatedMargin = initialBalance * marginPerEntry / 100;

            if (selectedStrategy === 'bhb_trader' && useAutoLeverage) {
              const simulatedStopPercent = 1.5 + (Math.random() * 1.5);
              // Alavancagem Ideal do PDF: L = Perda Máxima / (Margem * Stop%)
              finalLeverageSim = Math.max(2, Math.min(50, Math.round(maxLossPerTrade / (simulatedMargin * (simulatedStopPercent / 100)))));
              addLog(`[BHBTrader] [SIM] Alavancagem Ideal Calculada: ${finalLeverageSim}x (Risco: $${maxLossPerTrade}, Stop: ${simulatedStopPercent.toFixed(2)}%)`, 'success');
            }

            const tradePnLValue = (Math.random() * 4.5 - 0.5); // Mean is ~2.0% leveraged profit
            const tradeVolumeSim = simulatedMargin * finalLeverageSim * 2;
            const feesTotalSim = tradeVolumeSim * (feeRate / 100);
            
            // tradePnLValue is the gross leveraged result in %
            const simulatedPnLGross = simulatedMargin * (tradePnLValue / 100);
            const simulatedPnLNet = simulatedPnLGross - feesTotalSim;
            const netPnLPercentSim = (simulatedPnLNet / simulatedMargin) * 100;
            
            const tempSimId = Math.random().toString(36).substr(2, 9).toUpperCase();
            const simType: 'LONG' | 'SHORT' = suggestedSide; 

            // Create initial open trade for simulation
            const openSimTrade: BotTrade = {
              id: tempSimId,
              symbol: randomPair.symbol.split(':')[1],
              type: simType,
              entry: currentPrice.toFixed(4),
              exit: '-',
              leverage: finalLeverageSim.toString(),
              margin: simulatedMargin.toFixed(2),
              marginNum: simulatedMargin,
              value: `$${(simulatedMargin * finalLeverageSim).toFixed(2)}`,
              pnl: '0.00%',
              pnlCash: '$0.00',
              volume: `$${(simulatedMargin * finalLeverageSim).toFixed(2)}`,
              fees: `$${(simulatedMargin * finalLeverageSim * (feeRate / 100)).toFixed(2)}`,
              duration: 'OPEN',
              status: 'OPEN',
              livePnL: '0.00%',
              livePnLCash: '$0.00',
              strategy: selectedStrategy,
              targetCash: (selectedStrategy === 'bhb_trader' || selectedStrategy === 'pullback_medias')
                ? (selectedStrategy === 'bhb_trader' ? maxLossPerTrade : (simulatedMargin * 0.15))
                : undefined,
              time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            };

            setTrades(prev => [openSimTrade, ...prev]);

            // Médias (Scalping) fechamos por tempo
            // Pullback (Sinal Técnico) e BHBTrader só fecham no Alvo ou Stop
            if (selectedStrategy !== 'smart_pro' && selectedStrategy !== 'pullback_medias' && selectedStrategy !== 'bhb_trader') {
              setTimeout(() => {
                setTrades(prev => prev.map(t => t.id === tempSimId ? {
                  ...t,
                  // Exit price based on whether it was LONG or SHORT to match the PnL
                  exit: (simType === 'LONG' 
                    ? currentPrice * (1 + (tradePnLValue / 100) / leverage) 
                    : currentPrice * (1 - (tradePnLValue / 100) / leverage)).toFixed(4),
                  pnl: (netPnLPercentSim >= 0 ? '+' : '') + netPnLPercentSim.toFixed(2) + '%',
                  pnlCash: (simulatedPnLNet >= 0 ? '+' : '-') + '$' + Math.abs(simulatedPnLNet).toFixed(2),
                  pnlCashNum: simulatedPnLNet,
                  volume: `$${tradeVolumeSim.toFixed(2)}`,
                  fees: `$${feesTotalSim.toFixed(2)}`,
                  duration: `${Math.floor(tradeDuration/1000)}s`,
                  status: 'CLOSED'
                } : t));

                if ((executionMode as string) !== 'api_real') {
                  const profitPercentage = (simulatedPnLNet / initialBalance) * 100;
                  setDailyPnL(prev => prev + profitPercentage);
                  setDailyVolume(prev => prev + tradeVolumeSim);
                  setDailyFees(prev => prev + feesTotalSim);
                  setInitialBalance(prev => prev + simulatedPnLNet); // Update balance in simulation
                }
                
                addLog(`[SISTEMA] Operação simulada finalizada. Resultado: ${netPnLPercentSim.toFixed(2)}%`, netPnLPercentSim >= 0 ? 'success' : 'warning');
              }, tradeDuration);
            }

          } else {
            addLog(`Busca concluída. Sem sinais claros.`, 'info');
          }
        } catch (err: any) {
          addLog(`[SISTEMA-ERRO] ${err.message}`, 'error');
        } finally {
          isExecutingRef.current = false;
          setExecution(false);
        }
      };


      interval = setInterval(runBotLogic, operationFrequency * 1000);
      runBotLogic(); // Initial run
    } else {
      if (sessionStartTime) addLog("Operação pausada pelo usuário.", 'warning');
    }
    return () => {
      clearInterval(interval);
      clearInterval(timerInterval);
    };
  }, [botActive, watchlist, dailyPnL, dailyStopLoss, dailyTakeProfit, marginPerEntry, initialBalance, leverage, isCompounding, includeFees, feeRate, sessionStartTime, operationFrequency, timeframe, highLiquidityOnly, executionMode]);

  const fetchSymbols = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/bitunix-symbols');
      const data = await response.json();
      if (Array.isArray(data)) {
        setWatchlist(data);
      }
    } catch (error) {
      console.error('Failed to fetch symbols:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSymbols();
  }, []);

  const filteredWatchlist = watchlist.filter(item => 
    item.symbol.toLowerCase().includes(searchTerm.toLowerCase()) || 
    item.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="flex flex-col md:flex-row h-screen w-full bg-brand-bg text-brand-text overflow-hidden font-sans">
      {/* Sidebar Navigation - Desktop */}
      <aside className="hidden md:flex w-16 flex-col items-center py-6 border-r border-brand-border bg-brand-surface space-y-8 z-20 shrink-0">
        <nav className="flex flex-col space-y-6">
          <button 
            onClick={() => setActiveView('signals')}
            title="Copia e Cola Sinais Telegram/WhatsApp"
            className={`p-2 rounded-lg transition-all ${activeView === 'signals' ? 'text-emerald-400 bg-emerald-500/10' : 'text-brand-text/50 hover:text-brand-text hover:bg-brand-bg'}`}
          >
            <ClipboardPaste className="w-6 h-6" />
          </button>
          <button 
            onClick={() => setActiveView('copytrade')}
            title="Painel Copy Trade Bitunix (Trader Líder)"
            className={`p-2 rounded-lg transition-all ${activeView === 'copytrade' ? 'text-blue-400 bg-blue-500/10' : 'text-brand-text/50 hover:text-brand-text hover:bg-brand-bg'}`}
          >
            <Users className="w-6 h-6" />
          </button>
          <button 
            onClick={() => setActiveView('accounts')}
            title="Multi-Contas & Gestão de Operadores Isolados"
            className={`p-2 rounded-lg transition-all ${activeView === 'accounts' ? 'text-purple-400 bg-purple-500/10' : 'text-brand-text/50 hover:text-brand-text hover:bg-brand-bg'}`}
          >
            <Key className="w-6 h-6" />
          </button>
          <button 
            onClick={() => setActiveView('charts')}
            title="Gráficos"
            className={`p-2 rounded-lg transition-all ${activeView === 'charts' ? 'text-brand-accent bg-brand-accent/10' : 'text-brand-text/50 hover:text-brand-text hover:bg-brand-bg'}`}
          >
            <BarChart3 className="w-6 h-6" />
          </button>
          <button 
            onClick={() => setIsBackupModalOpen(true)}
            title="Central de Cópia & Backup do Sistema"
            className={`p-2 rounded-lg transition-all ${isBackupModalOpen ? 'text-cyan-400 bg-cyan-500/15' : 'text-brand-text/50 hover:text-cyan-400 hover:bg-brand-bg'}`}
          >
            <FolderArchive className="w-6 h-6" />
          </button>
        </nav>
      </aside>

      {/* Bottom Navigation Bar - Mobile */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-brand-surface border-t border-brand-border flex items-center justify-around z-50 px-2 shadow-2xl">
        <button 
          onClick={() => setActiveView('signals')}
          className={`flex items-center space-x-1 px-2.5 py-2 rounded-xl transition-all ${
            activeView === 'signals' ? 'text-emerald-400 bg-emerald-500/10 font-bold' : 'text-brand-text/50'
          }`}
        >
          <ClipboardPaste className="w-5 h-5" />
          <span className="text-xs">Sinais</span>
        </button>
        <button 
          onClick={() => setActiveView('copytrade')}
          className={`flex items-center space-x-1 px-2.5 py-2 rounded-xl transition-all ${
            activeView === 'copytrade' ? 'text-blue-400 bg-blue-500/10 font-bold' : 'text-brand-text/50'
          }`}
        >
          <Users className="w-5 h-5" />
          <span className="text-xs">Copy</span>
        </button>
        <button 
          onClick={() => setActiveView('accounts')}
          className={`flex items-center space-x-1 px-2.5 py-2 rounded-xl transition-all ${
            activeView === 'accounts' ? 'text-purple-400 bg-purple-500/10 font-bold' : 'text-brand-text/50'
          }`}
        >
          <Key className="w-5 h-5" />
          <span className="text-xs">Contas</span>
        </button>
        <button 
          onClick={() => setIsBackupModalOpen(true)}
          className="flex items-center space-x-1 px-2.5 py-2 rounded-xl transition-all text-brand-text/50 hover:text-cyan-400"
          title="Cópia & Backup"
        >
          <FolderArchive className="w-5 h-5" />
          <span className="text-xs">Cópia</span>
        </button>
        <button 
          onClick={() => setActiveView('charts')}
          className={`flex items-center space-x-1 px-2.5 py-2 rounded-xl transition-all ${
            activeView === 'charts' ? 'text-brand-accent bg-brand-accent/10 font-bold' : 'text-brand-text/50'
          }`}
        >
          <BarChart3 className="w-5 h-5" />
          <span className="text-xs">Gráficos</span>
        </button>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col min-w-0 pb-14 md:pb-0 overflow-hidden">
        {/* Dashboard Grid */}
        <div className="flex-1 flex p-1 sm:p-4 gap-2 sm:gap-4 overflow-hidden bg-brand-bg/50">
          {/* Main View Area */}
          <div className="flex-1 flex flex-col gap-4 min-w-0">
            <div className={activeView === 'signals' ? 'flex-1 flex flex-col gap-4 min-w-0 h-full overflow-hidden' : 'hidden'}>
              <SignalTrader 
                apiKey={apiKey}
                setApiKey={setApiKey}
                apiSecret={apiSecret}
                setApiSecret={setApiSecret}
                executionMode={executionMode}
                setExecutionMode={setExecutionMode}
                accountType={accountType}
                setAccountType={setAccountType}
                initialBalance={initialBalance}
                setInitialBalance={setInitialBalance}
                onSyncBalance={syncApiBalance}
                addLog={addLog}
                onSelectSymbolForChart={(symbol) => {
                  let sym = symbol;
                  if (!sym.includes(':')) sym = `BITUNIX:${sym}`;
                  if (!sym.endsWith('.P')) sym = `${sym}.P`;
                  setCurrentSymbol(sym);
                  setActiveView('charts');
                }}
                onOpenCopyTrade={() => setActiveView('copytrade')}
                onOpenBackupModal={() => setIsBackupModalOpen(true)}
                savedAccounts={savedAccounts}
                activeAccountId={activeAccountId}
                activeAccountLabel={activeAccountLabel}
                isSwitchingAccount={isSwitchingAccount}
                onSwitchSavedAccount={handleSwitchSavedAccount}
                onRefreshCredentials={refreshCredentialsFromServer}
              />
            </div>
            <div className={activeView === 'copytrade' ? 'flex-1 flex flex-col gap-4 min-w-0 h-full overflow-hidden' : 'hidden'}>
              <CopyTradeDashboard 
                apiKey={apiKey}
                apiSecret={apiSecret}
                accountType={accountType}
                onSelectSymbolForChart={(symbol) => {
                  let sym = symbol;
                  if (!sym.includes(':')) sym = `BITUNIX:${sym}`;
                  if (!sym.endsWith('.P')) sym = `${sym}.P`;
                  setCurrentSymbol(sym);
                  setActiveView('charts');
                }}
              />
            </div>
            <div className={activeView === 'accounts' ? 'flex-1 flex flex-col gap-4 min-w-0 h-full overflow-y-auto' : 'hidden'}>
              <MultiAccountManager />
            </div>
            <div className={activeView === 'charts' ? 'flex-1 flex flex-col gap-4 min-w-0 h-full' : 'hidden'}>
              {/* Symbol Context Toolbar */}
              <div className="h-12 bg-brand-surface border border-brand-border rounded-xl px-4 flex items-center justify-between shrink-0 shadow-sm relative z-30">
                <div className="flex items-center space-x-4">
                  {/* Coin Search Input with Lupa */}
                  <div className="relative">
                    <div className="flex items-center bg-brand-bg border border-brand-border/80 rounded-lg px-2.5 py-1 focus-within:border-brand-accent transition-all">
                      <Search className="w-3.5 h-3.5 text-brand-accent shrink-0 mr-1.5" />
                      <input
                        type="text"
                        placeholder="Buscar moeda (ex: BTC, SOL)..."
                        value={coinSearchInput}
                        onChange={(e) => {
                          setCoinSearchInput(e.target.value.toUpperCase());
                          setShowCoinDropdown(true);
                        }}
                        onFocus={() => setShowCoinDropdown(true)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && coinSearchInput.trim()) {
                            let clean = coinSearchInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                            if (!clean.includes('USDT')) clean += 'USDT';
                            const formatted = `BITUNIX:${clean}.P`;
                            setCurrentSymbol(formatted);
                            setShowCoinDropdown(false);
                          }
                        }}
                        className="bg-transparent border-none outline-none text-xs font-mono font-bold text-white w-44 placeholder:text-brand-text/30"
                      />
                      <span className="text-[10px] font-mono text-brand-accent font-bold bg-brand-accent/10 px-1.5 py-0.5 rounded ml-1 flex items-center gap-1">
                        <span>{currentSymbol.split(':')[1] || currentSymbol}</span>
                        <span className="text-[8px] bg-brand-accent text-white px-1 rounded font-sans">PERP</span>
                      </span>
                    </div>

                    {/* Dropdown suggestions */}
                    {showCoinDropdown && (
                      <>
                        <div 
                          className="fixed inset-0 z-40" 
                          onClick={() => setShowCoinDropdown(false)} 
                        />
                        <div className="absolute left-0 top-full mt-1.5 w-72 bg-brand-surface border border-brand-border rounded-xl shadow-2xl p-2 z-50 max-h-72 overflow-y-auto">
                          {(() => {
                            const rawInput = coinSearchInput.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                            const cleanTyped = rawInput.replace(/USDT$/, '').replace(/\.P$/, '');
                            
                            const POPULAR_COINS = [
                              'BTC', 'ETH', 'SOL', 'IOTA', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'SUI',
                              'LINK', 'PEPE', 'NEAR', 'SHIB', 'WIF', 'FET', 'LTC', 'APT', 'AR', 'RENDER',
                              'NOT', 'GALA', 'POL', 'MATIC', 'FIL', 'TIA', 'TRX', 'STX', 'AAVE', 'PENDLE',
                              'ATOM', 'DOT', 'JUP', 'SEI', 'BONK', 'FLOKI', 'INJ', 'OP', 'ARB', 'RUNE',
                              'KAS', 'FTM', 'JASMY', 'TON', 'LDO', 'ICP', 'BLUR', 'ORDI', 'MEME', 'WLD',
                              'PYTH', 'MOODENG', 'GOAT', 'PNUT', 'RAY', 'POPCAT', 'SATS', 'NEIRO', 'ENA',
                              'ONDO', 'IMX', 'CHZ', 'SAND', 'MANA', 'CRV', 'UNI', 'ETC', 'XLM', 'ALGO'
                            ];

                            const matches = POPULAR_COINS.filter(coin => 
                              !cleanTyped || coin.includes(cleanTyped) || `${coin}USDT`.includes(cleanTyped)
                            );

                            return (
                              <>
                                {cleanTyped && (
                                  <button
                                    onClick={() => {
                                      setCurrentSymbol(`BITUNIX:${cleanTyped}USDT.P`);
                                      setCoinSearchInput('');
                                      setShowCoinDropdown(false);
                                    }}
                                    className="w-full text-left px-2.5 py-2 mb-2 rounded-lg text-xs font-mono font-bold flex items-center justify-between bg-brand-accent/20 hover:bg-brand-accent/30 text-brand-accent border border-brand-accent/40 transition-colors shadow-sm"
                                  >
                                    <div className="flex items-center space-x-1.5">
                                      <Search className="w-3.5 h-3.5 shrink-0" />
                                      <span>Carregar {cleanTyped}/USDT (Futuros Perpétuos)</span>
                                    </div>
                                    <span className="text-[9px] uppercase bg-brand-accent text-white px-1.5 py-0.5 rounded font-sans font-bold">
                                      Enter ↵
                                    </span>
                                  </button>
                                )}

                                <div className="text-[9px] font-bold text-brand-text/40 px-2 py-1 uppercase tracking-wider">
                                  {cleanTyped ? 'Futuros Perpétuos Encontrados:' : 'Futuros Perpétuos Bitunix:'}
                                </div>

                                {matches.length > 0 ? (
                                  matches.map(coin => {
                                    const fullSym = `BITUNIX:${coin}USDT.P`;
                                    return (
                                      <button
                                        key={coin}
                                        onClick={() => {
                                          setCurrentSymbol(fullSym);
                                          setCoinSearchInput('');
                                          setShowCoinDropdown(false);
                                        }}
                                        className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs font-mono font-bold flex items-center justify-between hover:bg-brand-bg transition-colors ${currentSymbol === fullSym ? 'bg-brand-accent/20 text-brand-accent' : 'text-white/80'}`}
                                      >
                                        <span>{coin}/USDT</span>
                                        <span className="text-[9px] text-brand-accent font-bold bg-brand-accent/10 px-1 py-0.5 rounded">FUTUROS</span>
                                      </button>
                                    );
                                  })
                                ) : (
                                  !cleanTyped && (
                                    <div className="text-xs text-brand-text/30 italic p-2">Nenhuma moeda encontrada</div>
                                  )
                                )}
                              </>
                            );
                          })()}
                        </div>
                      </>
                    )}
                  </div>

                  {/* Timeframe selector */}
                  <div className="flex space-x-1">
                    {[
                      { label: '1M', value: '1' },
                      { label: '5M', value: '5' },
                      { label: '15M', value: '15' },
                      { label: '1H', value: '60' },
                      { label: '4H', value: '240' },
                      { label: '1D', value: 'D' },
                      { label: '1W', value: 'W' }
                    ].map(tf => (
                      <button
                        key={tf.label}
                        onClick={() => setChartInterval(tf.value)}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
                          chartInterval === tf.value
                            ? 'bg-brand-accent text-white shadow-sm'
                            : 'hover:bg-brand-bg text-brand-text/50'
                        }`}
                      >
                        {tf.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center space-x-3">
                  <div className="flex items-center space-x-1 px-2 py-1 bg-brand-success/10 border border-brand-success/20 rounded text-brand-success text-[10px] font-bold">
                      <div className="w-1 h-1 bg-brand-success rounded-full animate-pulse" />
                      <span>LIVE</span>
                  </div>
                  <button 
                    onClick={() => setIsSidebarOpen(!isSidebarOpen)}
                    className="p-1 hover:bg-brand-bg rounded text-brand-text/50 ml-2"
                  >
                    <ChevronRight className={`w-4 h-4 transition-transform ${isSidebarOpen ? '' : 'rotate-180'}`} />
                  </button>
                </div>
              </div>

              {/* TradingView Widget Container */}
              <div className="flex-1 relative min-h-[500px]">
                <TradingViewWidget symbol={currentSymbol} interval={chartInterval} />
              </div>
            </div>

            <div className={activeView === 'bot' ? 'flex-1 flex gap-4 min-w-0 h-full overflow-hidden' : 'hidden'}>
                <div className="flex-1 flex flex-col bg-brand-surface border border-brand-border rounded-xl p-6 space-y-6 overflow-y-auto">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-2xl font-bold">Bitunix Trading Bot</h3>
                      <p className="text-brand-text/40 text-sm">
                        Estratégia Ativa: <span className="text-brand-accent font-bold uppercase">{selectedStrategy === 'smart_pro' ? 'SmartPro (RSI 2)' : 'Scalping Médias'}</span>
                      </p>
                    </div>
                    <div className="flex gap-2 items-center">
                      {botActive && (
                        <div className="flex items-center space-x-2 mr-4 px-3 py-1.5 bg-brand-success/10 border border-brand-success/20 rounded-xl">
                          <Clock className="w-4 h-4 text-brand-success" />
                          <div className="flex flex-col">
                            <span className="text-[10px] text-brand-success/60 font-bold uppercase leading-none">Bot Ativo</span>
                            <span className="text-sm font-mono font-bold text-brand-success leading-none">
                              {Math.floor(sessionElapsed / 60).toString().padStart(2, '0')}:{(sessionElapsed % 60).toString().padStart(2, '0')}
                            </span>
                          </div>
                        </div>
                      )}
                      <button 
                        onClick={() => {
                          setTrades([]);
                          setDailyPnL(0);
                          setSessionStartBalance(null);
                          setInitialBalance(100);
                          setMonthlyPnL(0);
                          setDailyVolume(0);
                          setDailyFees(0);
                          setMonthlyVolume(0);
                          setMonthlyFees(0);
                          setBotActive(false);
                          setSessionStartTime(null);
                          setSessionElapsed(0);
                        }}
                        className="px-4 py-3 rounded-xl font-bold bg-brand-surface border border-brand-border hover:bg-brand-bg transition-all text-xs"
                      >
                        RESETE TOTAL
                      </button>
                      <button 
                        onClick={toggleBot}
                        className={`px-8 py-3 rounded-xl font-bold transition-all shadow-lg ${botActive ? 'bg-brand-danger hover:bg-red-600 shadow-brand-danger/20' : 'bg-brand-success hover:bg-emerald-600 shadow-brand-success/20'}`}
                      >
                        {botActive ? 'PARAR ROBÔ' : 'INICIAR ROBÔ'}
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                    {/* Card 1: Saldo */}
                    <div className="bg-[#0a0a0a] border border-white/5 p-6 rounded-2xl flex flex-col justify-between h-32 relative group">
                      <div className="flex justify-between items-start">
                        <span className="text-brand-text/40 text-xs font-medium">Saldo Atual</span>
                        <Wallet className="w-5 h-5 text-yellow-500/80" />
                      </div>
                      <div>
                          <div className="text-3xl font-bold tracking-tight text-white">
                            ${initialBalance.toFixed(2)}
                          </div>
                          <div className="flex flex-col space-y-0.5 mt-1">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-brand-text/30 font-bold uppercase">Disponível:</span>
                              <span className={`text-[10px] font-bold ${
                                (initialBalance - trades.filter(t => t.status === 'OPEN').reduce((sum, t) => sum + t.marginNum, 0)) < (initialBalance * marginPerEntry / 100) 
                                ? 'text-brand-danger' 
                                : 'text-brand-success'
                              }`}>
                                ${(initialBalance - trades.filter(t => t.status === 'OPEN').reduce((sum, t) => sum + t.marginNum, 0)).toFixed(2)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-brand-text/30 font-bold uppercase">Inicial Sessão:</span>
                              <span className="text-[10px] text-brand-text/40 font-bold">
                                ${(sessionStartBalance || initialBalance).toFixed(2)}
                              </span>
                            </div>
                          </div>
                      </div>
                    </div>

                    {/* Card 2: PnL Realizado + Não Realizado */}
                    <div className="bg-[#0a0a0a] border border-white/5 p-6 rounded-2xl flex flex-col justify-between h-32">
                      <div className="flex justify-between items-start">
                        <span className="text-brand-text/40 text-[9px] font-bold uppercase tracking-wider">LUCRO TOTAL SESSÃO (NET)</span>
                        <TrendingUp className={`w-5 h-5 ${(closedPnLSum + unrealizedPnLCash) >= 0 ? 'text-brand-success' : 'text-brand-danger'} opacity-80`} />
                      </div>
                      <div>
                        {(() => {
                           const realizedPnLPercent = sessionStartBalance && sessionStartBalance > 0 
                             ? (closedPnLSum / sessionStartBalance) * 100
                             : dailyPnL;
                           
                           const totalPnLPercent = realizedPnLPercent + unrealizedPnL;
                           const totalPnLCash = closedPnLSum + unrealizedPnLCash;
                           const isGainValue = totalPnLCash >= 0;

                           return (
                             <>
                               <div className="flex flex-col">
                                 <span className={`text-2xl font-bold tracking-tight ${isGainValue ? 'text-brand-success' : 'text-brand-danger'}`}>
                                   {isGainValue ? '+' : ''}{totalPnLPercent.toFixed(2)}%
                                 </span>
                                 <div className="flex items-center space-x-3 mt-1.5 pt-1.5 border-t border-white/5">
                                   <div className="flex flex-col">
                                     <span className="text-[7px] text-brand-text/30 font-extrabold uppercase tracking-widest">REALIZADO (PÓS TAXAS)</span>
                                     <span className={`text-[10px] font-bold ${closedPnLSum >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                                       {closedPnLSum >= 0 ? '+' : '-'}${Math.abs(closedPnLSum).toFixed(2)}
                                     </span>
                                   </div>
                                   <div className="w-px h-5 bg-white/10" />
                                   <div className="flex flex-col">
                                     <span className="text-[7px] text-yellow-500/50 font-extrabold uppercase tracking-widest">Não Realizado</span>
                                     <span className={`text-[10px] font-bold ${unrealizedPnLCash >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                                       {unrealizedPnLCash >= 0 ? '+' : '-'}${Math.abs(unrealizedPnLCash).toFixed(2)}
                                     </span>
                                   </div>
                                 </div>
                               </div>
                             </>
                           );
                        })()}
                      </div>
                    </div>

                    {/* Card 3: Win Rate */}
                    <div className="bg-[#0a0a0a] border border-white/5 p-6 rounded-2xl flex flex-col justify-between h-32">
                      <div className="flex justify-between items-start">
                        <span className="text-brand-text/40 text-xs font-medium">Taxa de Acerto</span>
                        <Target className="w-5 h-5 text-blue-500/80" />
                      </div>
                      <div>
                        <div className="text-3xl font-bold tracking-tight text-white">
                          {closedTrades.length > 0 ? (closedTrades.filter(t => t.pnl && t.pnl.includes('+')).length / closedTrades.length * 100).toFixed(1) : '0.0'}%
                        </div>
                        <div className="text-[10px] text-brand-text/30 font-bold mt-1 uppercase">
                          {closedTrades.filter(t => t.pnl && t.pnl.includes('+')).length} Vitórias / {closedTrades.length} Trades
                        </div>
                      </div>
                    </div>

                    {/* Card 4: Operações Ativas */}
                    <div className="bg-[#0a0a0a] border border-white/5 p-6 rounded-2xl flex flex-col justify-between h-32">
                      <div className="flex justify-between items-start">
                        <span className="text-brand-text/40 text-xs font-medium">Operações Ativas</span>
                        <Activity className="w-5 h-5 text-blue-500/80" />
                      </div>
                      <div className="text-3xl font-bold tracking-tight text-white">
                        {trades.filter(t => t.status === 'OPEN').length}
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 border border-brand-border rounded-xl overflow-hidden flex flex-col">
                    <div className="bg-[#0a0a0a] p-3 border-b border-brand-border flex items-center justify-between">
                       <div className="flex items-center space-x-2">
                         <div className="w-2 h-2 bg-brand-success rounded-full animate-pulse" />
                         <span className="text-[10px] font-bold uppercase tracking-widest text-brand-text/50">Fluxo de Operações Detalhado</span>
                       </div>
                       <button onClick={() => {
                         setTrades([]); 
                         setDailyPnL(0);
                         setSessionStartBalance(null);
                         setDailyVolume(0);
                         setDailyFees(0);
                       }} className="text-[10px] font-bold text-brand-text/30 hover:text-brand-text transition-colors">LIMPAR HISTÓRICO</button>
                    </div>
                    <div className="flex-1 bg-brand-bg/10 overflow-y-auto relative">
                      {/* Realistic API Execution Feedback Overlay */}
                      {isExecuting && (
                        <div className="sticky top-0 z-20 bg-brand-accent/10 backdrop-blur-[2px] border-b border-brand-accent/30 py-2 px-4 flex items-center justify-center space-x-3 transition-all">
                          <motion.div 
                            animate={{ rotate: 360 }}
                            transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
                            className="text-brand-accent"
                          >
                            <RefreshCw className="w-3 h-3" />
                          </motion.div>
                          <span className="text-[10px] font-bold text-brand-accent uppercase tracking-[0.2em] animate-pulse">
                            Comunicando com Bitunix API... Processando Ordem
                          </span>
                        </div>
                      )}
                      <table className="w-full text-left border-collapse">
                        <thead className="bg-[#0a0a0a] sticky top-0 z-10 border-b border-brand-border">
                          <tr>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30">Horário</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30">Par</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30">Tipo</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">Margem / Alav.</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">Volume</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">Valor</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-center">Entrada / Saída</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-center">Tempo</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">PnL %</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">PnL Realizado</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">Taxas</th>
                            <th className="p-3 text-[9px] uppercase font-bold text-brand-text/30 text-right">Ação</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {trades.length === 0 ? (
                            <tr key="empty-trades">
                              <td colSpan={12} className="p-20 text-center text-brand-text/10 italic text-sm">
                                Aguardando sinais de entrada para simular operações...
                              </td>
                            </tr>
                          ) : (
                            trades.map(trade => (
                              <tr 
                                key={trade.id} 
                                className="hover:bg-brand-surface/30 transition-colors cursor-pointer group/row"
                                onClick={() => setSelectedTrade(trade)}
                              >
                                <td className="p-3 text-[10px] font-mono text-brand-text/30 group-hover/row:text-brand-text/50">{trade.time}</td>
                                <td className="p-3 text-[11px] font-bold">
                                  <div className="flex items-center space-x-2">
                                    <span>{trade.symbol}</span>
                                    <ArrowRight className="w-2 h-2 opacity-0 group-hover/row:opacity-100 transition-opacity text-brand-accent" />
                                  </div>
                                </td>
                                <td className="p-3">
                                  <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${trade.type === 'LONG' ? 'bg-brand-success/10 text-brand-success outline outline-1 outline-brand-success/20' : 'bg-brand-danger/10 text-brand-danger outline outline-1 outline-brand-danger/20'}`}>
                                    {trade.type}
                                  </span>
                                </td>
                                <td className="p-3 text-[11px] font-mono text-right opacity-70">${trade.margin}/{trade.leverage}x</td>
                                <td className="p-3 text-[11px] font-mono text-right opacity-60 text-white/50">{trade.volume}</td>
                                <td className="p-3 text-[11px] font-mono text-right font-bold text-white/90">{trade.value}</td>
                                <td className="p-3 text-center">
                                  <div className="flex flex-col items-center justify-center space-y-1">
                                    <div className="flex items-center space-x-1">
                                      <span className="text-[7px] text-brand-text/40 font-bold uppercase">ENT</span>
                                      <span className="text-[10px] font-mono text-white/60 font-bold">${trade.entry}</span>
                                    </div>
                                    <div className="h-px w-6 bg-brand-border/30" />
                                    <div className="flex items-center space-x-1">
                                      <span className="text-[7px] text-brand-text/40 font-bold uppercase">SAI</span>
                                      <span className={`text-[10px] font-mono font-bold ${trade.status === 'OPEN' ? 'text-brand-text/20' : (trade.pnl.includes('-') ? 'text-brand-danger' : 'text-brand-success')}`}>
                                        {trade.exit !== '-' ? `$${trade.exit}` : trade.exit}
                                      </span>
                                    </div>
                                  </div>
                                </td>
                                <td className="p-3 text-[10px] font-mono text-center text-brand-text/40">
                                  {trade.status === 'OPEN' ? (
                                    <span className="flex items-center justify-center space-x-1 animate-pulse text-brand-accent">
                                      <RefreshCw className="w-2 h-2 animate-spin" />
                                      <span>OPEN</span>
                                    </span>
                                  ) : trade.duration}
                                </td>
                                <td className={`p-3 text-[11px] font-bold text-right ${trade.status === 'OPEN' ? ((parseFloat(trade.livePnL?.replace('%','') || '0') >= 0) ? 'text-brand-success' : 'text-brand-danger') + ' animate-pulse' : (trade.pnl.includes('-') ? 'text-brand-danger' : 'text-brand-success')}`}>
                                  {trade.status === 'OPEN' ? trade.livePnL || '0.00%' : trade.pnl}
                                </td>
                                <td className={`p-3 text-[12px] font-bold text-right ${trade.status === 'OPEN' ? ((parseFloat(trade.livePnL?.replace('%','') || '0') >= 0) ? 'text-brand-success' : 'text-brand-danger') + ' animate-pulse' : (trade.pnlCash.includes('-') ? 'text-brand-danger' : 'text-brand-success')}`}>
                                  {trade.status === 'OPEN' ? trade.livePnLCash || '$0.00' : trade.pnlCash}
                                </td>
                                <td className="p-3 text-[11px] font-mono text-right text-brand-danger/60">{trade.fees}</td>
                                <td className="p-3 text-right">
                                  {trade.status === 'OPEN' && (
                                    <button
                                      onClick={(e) => handleCloseSingleTrade(trade, e)}
                                      className="px-2 py-1 bg-brand-danger/20 hover:bg-brand-danger text-brand-danger hover:text-white rounded-lg text-[9px] font-bold transition-all border border-brand-danger/30 flex items-center space-x-1 ml-auto"
                                      title="Cancela ordens pendentes/gatilhos e fecha a posição na Bitunix"
                                    >
                                      <XCircle className="w-3 h-3" />
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

                    {/* System Log Panel - Simulating terminal output */}
                    <div className="bg-black border-t border-brand-border/20 overflow-hidden">
                      <button 
                        onClick={() => setIsLogsExpanded(!isLogsExpanded)}
                        className="w-full p-2 flex items-center justify-between hover:bg-white/5 transition-colors group"
                      >
                        <div className="flex items-center space-x-2">
                          <Terminal className="w-3 h-3 text-brand-text/40" />
                          <span className="text-[9px] font-bold text-brand-text/30 uppercase tracking-widest">LOGS DE EXECUÇÃO (SIMULADOR API)</span>
                        </div>
                        <div className="flex items-center space-x-3">
                          <div className="flex items-center space-x-1.5">
                            <div className={`w-1 h-1 rounded-full ${botActive ? 'bg-brand-success animate-pulse' : 'bg-brand-danger'}`} />
                            <span className={`text-[8px] font-bold ${botActive ? 'text-brand-success' : 'text-brand-danger'}`}>
                              {botActive ? 'CONECTADO' : 'OFFLINE'}
                            </span>
                          </div>
                          {isLogsExpanded ? <ChevronDown className="w-3 h-3 text-brand-text/30" /> : <ChevronUp className="w-3 h-3 text-brand-text/30" />}
                        </div>
                      </button>
                      
                      <motion.div 
                        initial={false}
                        animate={{ height: isLogsExpanded ? '120px' : '0px' }}
                        className="overflow-hidden"
                      >
                        <div className="h-full overflow-y-auto font-mono text-[10px] space-y-1 pr-2 custom-scrollbar bg-[#050505] p-2 mx-2 mb-2 rounded border border-white/5">
                          {systemLogs.length === 0 ? (
                            <div className="h-full flex items-center justify-center py-4">
                              <span className="text-brand-text/10 italic">Inicie o robô para visualizar o log técnico...</span>
                            </div>
                          ) : (
                            systemLogs.map(log => (
                              <div key={log.id} className="flex items-start space-x-2 leading-relaxed border-l border-white/5 pl-2">
                                <span className="text-brand-text/20 whitespace-nowrap">[{log.time}]</span>
                                <span className={`
                                  ${log.type === 'success' ? 'text-emerald-400' : ''}
                                  ${log.type === 'warning' ? 'text-amber-400' : ''}
                                  ${log.type === 'error' ? 'text-rose-500' : ''}
                                  ${log.type === 'info' ? 'text-brand-text/40' : ''}
                                  break-all
                                `}>
                                  {log.msg}
                                </span>
                              </div>
                            ))
                          )}
                        </div>
                      </motion.div>
                    </div>
                  </div>
                </div>

                <div className="w-80 bg-brand-surface border border-brand-border rounded-xl p-4 flex flex-col space-y-6 overflow-y-auto custom-scrollbar">
                   {/* API Configuration Section */}
                   <div className="p-4 bg-brand-accent/5 rounded-2xl border border-brand-accent/20 space-y-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center space-x-2">
                            <div className="p-1.5 bg-brand-accent/20 rounded-lg">
                              <RefreshCw className="w-3 h-3 text-brand-accent" />
                            </div>
                            <span className="text-[10px] font-bold uppercase tracking-wider text-brand-accent">Conexão da Corretora</span>
                          </div>
                          <div className="flex bg-brand-bg rounded-lg p-0.5 border border-brand-border">
                            <button 
                              onClick={() => setExecutionMode('simulation')}
                              className={`px-3 py-1 text-[8px] font-bold rounded-md transition-all ${executionMode === 'simulation' ? 'bg-brand-accent text-white shadow-lg' : 'text-brand-text/30'}`}
                            >
                              SIMULAÇÃO
                            </button>
                            <button 
                              onClick={() => setExecutionMode('api_real')}
                              className={`px-3 py-1 text-[8px] font-bold rounded-md transition-all ${executionMode === 'api_real' ? 'bg-brand-accent text-white shadow-lg' : 'text-brand-text/30'}`}
                            >
                              CONTA REAL (LIVE)
                            </button>
                          </div>
                        </div>

                        {executionMode === 'api_real' && (
                          <motion.div 
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="space-y-3 pt-2"
                          >
                            <div className="flex items-center justify-between px-1">
                              <span className="text-[9px] font-bold text-brand-text/30 uppercase">Status da Conta LIVE</span>
                              <button 
                                onClick={() => { syncApiBalance(); }}
                                className="flex items-center space-x-1 text-[8px] font-bold text-brand-accent hover:opacity-80 transition-opacity"
                              >
                                <RefreshCw className="w-2.5 h-2.5" />
                                <span>SINCRONIZAR AGORA</span>
                              </button>
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[9px] font-bold text-brand-text/30 uppercase ml-1">Contas Bitunix Salvas (Alternar)</label>
                              {savedAccounts.length > 0 ? (
                                <div className="space-y-1.5">
                                  {savedAccounts.map(acc => (
                                    <button
                                      key={acc.id}
                                      type="button"
                                      disabled={isSwitchingAccount}
                                      onClick={() => !acc.isActive && handleSwitchSavedAccount(acc.id)}
                                      className={`w-full px-2.5 py-2 rounded-xl border text-left flex items-center justify-between gap-2 transition-all ${
                                        acc.isActive
                                          ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                                          : 'bg-brand-bg/60 border-brand-border/60 text-brand-text/75 hover:border-brand-accent/60 hover:text-white'
                                      }`}
                                    >
                                      <div className="min-w-0">
                                        <span className="text-[10px] font-bold block truncate">{acc.label}</span>
                                        <span className="text-[9px] font-mono text-brand-text/45 block">{acc.apiKeyMasked}</span>
                                      </div>
                                      <span className={`text-[9px] font-bold px-2 py-0.5 rounded-md shrink-0 ${
                                        acc.isActive ? 'bg-emerald-500/20 text-emerald-300' : 'bg-brand-accent/15 text-brand-accent'
                                      }`}>
                                        {acc.isActive ? 'Ativa' : 'Usar'}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <div className="flex bg-emerald-500/10 rounded-xl p-2 border border-emerald-500/30 items-center justify-center gap-2">
                                  <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                                  <span className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
                                    Bitunix Futuros Perpétuos (USDT Real)
                                  </span>
                                </div>
                              )}
                            </div>

                            <div className="space-y-1.5">
                              <label className="text-[9px] font-bold text-brand-text/30 uppercase ml-1">Bitunix API Key (Live)</label>
                              <input 
                                type="password"
                                placeholder="Insira sua Chave de API LIVE..."
                                value={apiKey}
                                onChange={(e) => setApiKey(e.target.value)}
                                className="w-full bg-brand-bg/50 border border-brand-border/50 rounded-xl px-3 py-2 text-[10px] font-mono text-brand-accent placeholder:text-brand-text/10 focus:border-brand-accent/50 outline-none transition-all"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[9px] font-bold text-brand-text/30 uppercase ml-1">Bitunix Secret Key (Live)</label>
                              <input 
                                type="password"
                                placeholder="Insira sua Secret Key LIVE..."
                                value={apiSecret}
                                onChange={(e) => setApiSecret(e.target.value)}
                                className="w-full bg-brand-bg/50 border border-brand-border/50 rounded-xl px-3 py-2 text-[10px] font-mono text-brand-accent placeholder:text-brand-text/10 focus:border-brand-accent/50 outline-none transition-all"
                              />
                            </div>
                            <div className="space-y-1.5">
                              <label className="text-[9px] font-bold text-sky-400 uppercase ml-1 flex items-center justify-between">
                                <span>Token do Bot Telegram</span>
                                <span className="text-[8px] text-brand-text/40">@BotFather</span>
                              </label>
                              <input 
                                type="password"
                                placeholder="Token do Telegram (ex: 792745...)"
                                value={telegramBotToken}
                                onChange={(e) => setTelegramBotToken(e.target.value)}
                                className="w-full bg-brand-bg/50 border border-brand-border/50 rounded-xl px-3 py-2 text-[10px] font-mono text-sky-300 placeholder:text-brand-text/10 focus:border-sky-500/50 outline-none transition-all"
                              />
                            </div>
                            <button
                              type="button"
                              onClick={async () => {
                                try {
                                  await fetch('/api/credentials', {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                      apiKey: apiKey.trim(),
                                      apiSecret: apiSecret.trim(),
                                      telegramToken: telegramBotToken.trim()
                                    })
                                  });
                                  await refreshCredentialsFromServer();
                                  setCredentialsSavedFeedback(true);
                                  setTimeout(() => setCredentialsSavedFeedback(false), 2500);
                                  syncApiBalance();
                                } catch (e) {}
                              }}
                              className="w-full py-2 bg-brand-accent hover:bg-blue-600 text-white rounded-xl text-[10px] font-bold transition-all flex items-center justify-center space-x-1.5 shadow-sm"
                            >
                              {credentialsSavedFeedback ? (
                                <>
                                  <Check className="w-3.5 h-3.5 text-emerald-400" />
                                  <span>Salvo com Sucesso!</span>
                                </>
                              ) : (
                                <>
                                  <Key className="w-3.5 h-3.5" />
                                  <span>Salvar Chaves & Token</span>
                                </>
                              )}
                            </button>
                            <div className="flex items-center space-x-2 p-2 bg-red-500/10 rounded-lg border border-red-500/20">
                              <Info className="w-3 h-3 text-red-500 shrink-0" />
                              <p className="text-[8px] text-red-200/60 leading-tight font-bold whitespace-normal">
                                ATENÇÃO: O modo LIVE opera com dinheiro REAL. As ordens serão enviadas diretamente para a sua conta Bitunix.
                              </p>
                            </div>
                          </motion.div>
                        )}
                      </div>

                   <h4 className="text-xs font-bold uppercase tracking-widest text-brand-text/50">Gerenciamento de Risco</h4>
                   
                   <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] font-bold">
                          <label className="text-brand-text/30 uppercase">Take Profit Diário</label>
                          <span className="text-brand-success">{dailyTakeProfit}%</span>
                        </div>
                        <input 
                          type="range" min="1" max="50" step="1" 
                          value={dailyTakeProfit} 
                          onChange={(e) => setDailyTakeProfit(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer accent-brand-accent"
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] font-bold">
                          <label className="text-brand-text/30 uppercase">Stop Loss Diário</label>
                          <span className="text-brand-danger">{dailyStopLoss}%</span>
                        </div>
                        <input 
                          type="range" min="1" max="30" step="1" 
                          value={dailyStopLoss} 
                          onChange={(e) => setDailyStopLoss(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer accent-brand-danger"
                        />
                      </div>

                      <div className="space-y-2">
                        <div className="flex justify-between text-[10px] font-bold">
                          <label className="text-brand-text/30 uppercase">Margem por Entrada</label>
                          <span className="text-brand-accent">{marginPerEntry}%</span>
                        </div>
                        <input 
                          type="range" min="1" max="20" step="1" 
                          value={marginPerEntry} 
                          onChange={(e) => setMarginPerEntry(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer accent-brand-accent"
                        />
                      </div>

                      <div className="space-y-4">
                        <div className="space-y-2">
                          <label className="text-[10px] text-brand-text/30 font-bold uppercase block">Tempo Gráfico (Timeframe)</label>
                          <div className="grid grid-cols-3 gap-2">
                            {(['1m', '5m', '15m'] as const).map((tf) => (
                              <button
                                key={tf}
                                onClick={() => setTimeframe(tf)}
                                className={`py-2 rounded-lg text-[10px] font-bold border transition-all ${
                                  timeframe === tf 
                                    ? 'bg-brand-accent/20 border-brand-accent text-brand-accent' 
                                    : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/40 hover:border-brand-border'
                                }`}
                              >
                                {tf}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <div className="flex justify-between text-[10px] font-bold">
                            <label className="text-brand-text/30 uppercase">Frequência de Verificação</label>
                            <span className="text-brand-accent">{operationFrequency}s</span>
                          </div>
                        <input 
                          type="range" min="3" max="60" step="1" 
                          value={operationFrequency} 
                          onChange={(e) => setOperationFrequency(parseInt(e.target.value))}
                          className="w-full h-1.5 bg-brand-bg rounded-lg appearance-none cursor-pointer accent-brand-accent"
                        />
                      </div>
                    </div>

                      <div className="flex items-center justify-between p-3 bg-brand-bg/30 rounded-xl border border-brand-border/50 transition-all hover:bg-brand-bg/50">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-brand-text/50">Alta Liquidez Apenas</span>
                          <span className="text-[8px] text-brand-text/30 font-medium tracking-tight text-wrap max-w-[120px]">Filtra moedas com baixo volume para evitar slippage</span>
                        </div>
                        <button 
                          onClick={() => setHighLiquidityOnly(!highLiquidityOnly)}
                          className={`relative w-10 h-5 rounded-full transition-colors ${highLiquidityOnly ? 'bg-brand-accent' : 'bg-brand-border'}`}
                        >
                          <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${highLiquidityOnly ? 'left-6' : 'left-1'}`} />
                        </button>
                      </div>

                      <div className="flex items-center justify-between p-3 bg-brand-bg/30 rounded-xl border border-brand-border/50 transition-all hover:bg-brand-bg/50">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold uppercase text-brand-text/50">Juros Compostos</span>
                          <span className="text-[8px] text-brand-text/30 font-medium tracking-tight">Cálculo sobre Saldo Atual</span>
                        </div>
                        <button 
                          onClick={() => setIsCompounding(!isCompounding)}
                          className={`relative w-10 h-5 rounded-full transition-colors ${isCompounding ? 'bg-brand-success' : 'bg-brand-border'}`}
                        >
                          <div className={`absolute top-1 w-3 h-3 bg-white rounded-full transition-all ${isCompounding ? 'left-6' : 'left-1'}`} />
                        </button>
                      </div>

                      <div className="space-y-3 p-3 bg-brand-bg/30 rounded-xl border border-brand-border/50 transition-all hover:bg-brand-bg/50">
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold uppercase text-brand-text/50">Incluir Taxas</span>
                            <span className="text-[8px] text-brand-text/30 font-medium tracking-tight">Entrada (0.05%) + Saída (0.05%)</span>
                          </div>
                          <button 
                            onClick={() => setIncludeFees(!includeFees)}
                            className={`relative w-8 h-4 rounded-full transition-colors ${includeFees ? 'bg-brand-accent' : 'bg-brand-border'}`}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${includeFees ? 'left-4.5' : 'left-0.5'}`} />
                          </button>
                        </div>
                        
                        {includeFees && (
                          <div className="space-y-1 pt-1 border-t border-brand-border/20">
                            <div className="flex justify-between text-[8px] font-bold">
                              <label className="text-brand-text/30 uppercase">Valor da Taxa (%)</label>
                              <span className="text-brand-accent">{feeRate}%</span>
                            </div>
                            <input 
                              type="range" min="0.01" max="0.2" step="0.01" 
                              value={feeRate} 
                              onChange={(e) => setFeeRate(parseFloat(e.target.value))}
                              className="w-full h-1 bg-brand-bg rounded-lg appearance-none cursor-pointer accent-brand-accent"
                            />
                          </div>
                        )}
                      </div>

                      {/* Configurações do Operacional BHBTrader (Gerenciamento PDF) */}
                      <div className="space-y-3 p-3 bg-brand-bg/30 rounded-xl border border-brand-border/50 transition-all hover:bg-brand-bg/50">
                        <div className="flex items-center justify-between">
                          <div className="flex flex-col">
                            <span className="text-[10px] font-bold uppercase text-brand-text/50">Alavancagem Ideal (BHBTrader)</span>
                            <span className="text-[8px] text-brand-text/30 font-medium tracking-tight">Cálculo de alavancagem com base no Risco/Stop do PDF</span>
                          </div>
                          <button 
                            type="button"
                            onClick={() => setUseAutoLeverage(!useAutoLeverage)}
                            className={`relative w-8 h-4 rounded-full transition-colors ${useAutoLeverage ? 'bg-brand-accent' : 'bg-brand-border'}`}
                          >
                            <div className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-all ${useAutoLeverage ? 'left-4.5' : 'left-0.5'}`} />
                          </button>
                        </div>
                        
                        <div className="space-y-1.5 pt-2 border-t border-brand-border/10">
                          <div className="flex justify-between text-[10px] font-bold">
                            <label className="text-brand-text/30 uppercase">Perda Aceitável por Trade ($)</label>
                            <span className="text-brand-success">${maxLossPerTrade} USD</span>
                          </div>
                          <input 
                            type="number" 
                            min="1" 
                            max="500" 
                            value={maxLossPerTrade} 
                            onChange={(e) => setMaxLossPerTrade(parseFloat(e.target.value) || 0)}
                            className="w-full bg-brand-bg/40 border border-brand-border/40 rounded px-2 py-1 text-xs text-white/90 outline-none focus:border-brand-accent"
                          />
                          <span className="text-[8px] text-brand-text/30 block font-medium">Conta Exemplo $100: Risco de $5 por operação (10% conta dividido por 2 ordens)</span>
                        </div>
                      </div>
                    </div>

                    <div className="space-y-4 pt-4 border-t border-brand-border">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-brand-text/50">Estratégia de Operação</h4>
                      <div className="grid grid-cols-1 gap-2">
                        <button
                          onClick={() => setSelectedStrategy('bhb_trader')}
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            selectedStrategy === 'bhb_trader' 
                              ? 'bg-brand-success/10 border-brand-success text-brand-success shadow-[0_0_15px_rgba(34,197,94,0.1)] font-bold' 
                              : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/40 hover:border-brand-border'
                          }`}
                        >
                          <div className="flex flex-col items-start text-left">
                            <span className="text-[10px] font-extrabold uppercase tracking-wide text-brand-success">BHBTraderr Estratégia</span>
                            <span className="text-[8px] opacity-75 font-medium">Auto-Leverage + Confluência S/R & RSI PRO</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {selectedStrategy === 'bhb_trader' && <div className="w-2 h-2 rounded-full bg-brand-success animate-pulse" />}
                            <span className="text-[7.5px] px-1 bg-brand-success/20 rounded text-brand-success font-bold">PDF</span>
                          </div>
                        </button>

                        <button
                          onClick={() => setSelectedStrategy('pullback_medias')}
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            selectedStrategy === 'pullback_medias' 
                              ? 'bg-brand-accent/10 border-brand-accent text-brand-accent shadow-[0_0_15px_rgba(59,130,246,0.1)]' 
                              : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/40 hover:border-brand-border'
                          }`}
                        >
                          <div className="flex flex-col items-start text-left">
                            <span className="text-[10px] font-bold uppercase text-brand-success">Pullback nas Médias</span>
                            <span className="text-[8px] opacity-60">Filtro SMA 200 + Scalp 1:1</span>
                          </div>
                          {selectedStrategy === 'pullback_medias' && <div className="w-1.5 h-1.5 rounded-full bg-brand-success animate-pulse" />}
                        </button>

                        <button
                          onClick={() => setSelectedStrategy('moving_averages')}
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            selectedStrategy === 'moving_averages' 
                              ? 'bg-brand-accent/10 border-brand-accent text-brand-accent shadow-[0_0_15px_rgba(59,130,246,0.1)]' 
                              : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/40 hover:border-brand-border'
                          }`}
                        >
                          <div className="flex flex-col items-start text-left">
                            <span className="text-[10px] font-bold uppercase">Operação Média</span>
                            <span className="text-[8px] opacity-60">Tendência EMA 20/50/200</span>
                          </div>
                          {selectedStrategy === 'moving_averages' && <div className="w-1.5 h-1.5 rounded-full bg-brand-accent animate-pulse" />}
                        </button>
                        
                        <button
                          onClick={() => setSelectedStrategy('smart_pro')}
                          className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                            selectedStrategy === 'smart_pro' 
                              ? 'bg-brand-accent/10 border-brand-accent text-brand-accent shadow-[0_0_15px_rgba(59,130,246,0.1)]' 
                              : 'bg-brand-bg/50 border-brand-border/30 text-brand-text/40 hover:border-brand-border'
                          }`}
                        >
                          <div className="flex flex-col items-start text-left">
                            <span className="text-[10px] font-bold uppercase text-brand-accent">SmartPro RSI(2)</span>
                            <span className="text-[8px] opacity-60">Operações Longas (Convicção)</span>
                          </div>
                          {selectedStrategy === 'smart_pro' && <div className="w-1.5 h-1.5 rounded-full bg-brand-accent animate-pulse" />}
                        </button>
                      </div>
                    </div>

                    <div className="space-y-4 pt-4 border-t border-brand-border">
                     <h4 className="text-xs font-bold uppercase tracking-widest text-brand-text/50">Configurações Técnicas</h4>
                     <div className="space-y-1">
                       <label className="text-[10px] font-bold text-brand-text/30">ALAVANCAGEM</label>
                       <select 
                         value={leverage}
                         onChange={(e) => setLeverage(parseInt(e.target.value))}
                         className="w-full bg-brand-bg border border-brand-border rounded p-2 text-xs focus:outline-none focus:border-brand-accent"
                       >
                         <option value="5">5x (Conservador)</option>
                         <option value="10">10x (Moderado)</option>
                         <option value="20">20x (Agressivo)</option>
                         <option value="50">50x (Extremo)</option>
                       </select>
                     </div>
                     <div className="p-4 bg-brand-accent/5 border border-brand-accent/20 rounded-xl text-[10px] leading-relaxed text-brand-text/60">
                         <strong>MODO BITUNIX:</strong> O robô utiliza a API oficial para execução em tempo real. O saldo inicial é usado como referência para cálculo de PnL Diário.
                      </div>
                    </div>

                    {/* Performance Report Sidebar Card */}
                <div className="bg-[#0a0a0a] border border-white/5 rounded-xl p-4 flex flex-col space-y-4">
                   <div className="flex items-center space-x-2 border-b border-brand-border pb-2">
                      <LineChart className="w-3 h-3 text-brand-accent" />
                      <h4 className="text-[10px] font-bold uppercase tracking-widest text-brand-text/50">Relatório de Performance</h4>
                   </div>
                   
                   <div className="space-y-3">
                      <div className="flex justify-between items-center p-2 bg-brand-bg/50 rounded-lg border border-brand-border/30">
                        <span className="text-[10px] text-brand-text/40 font-bold uppercase">Resultado Diário</span>
                        <div className={`text-xs font-mono font-bold ${dailyPnL >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                          {dailyPnL >= 0 ? '+' : '-'}${ Math.abs(initialBalance * dailyPnL / 100).toFixed(2) }
                        </div>
                      </div>

                      <div className="flex justify-between items-center p-2 bg-brand-bg/50 rounded-lg border border-brand-border/30">
                        <span className="text-[10px] text-brand-text/40 font-bold uppercase">Meta do Dia</span>
                        <div className="text-[10px] font-mono text-brand-accent">
                          {(dailyPnL / dailyTakeProfit * 100).toFixed(0)}% Concluído
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2">
                        <div className="p-2 bg-brand-bg/30 rounded-lg border border-brand-border/20 flex flex-col">
                          <span className="text-[8px] text-brand-text/30 font-bold uppercase">Volume Total</span>
                          <span className="text-[10px] font-mono text-white/70">${dailyVolume.toFixed(2)}</span>
                        </div>
                        <div className="p-2 bg-brand-bg/30 rounded-lg border border-brand-border/20 flex flex-col">
                          <span className="text-[8px] text-brand-text/30 font-bold uppercase">Taxas Pagas</span>
                          <span className="text-[10px] font-mono text-brand-danger/70">-${dailyFees.toFixed(2)}</span>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-brand-border/20">
                        <div className="flex justify-between items-center px-1">
                          <span className="text-[10px] text-brand-text/40 font-bold uppercase">Acumulado Mensal</span>
                          <span className={`text-xs font-mono font-bold ${monthlyPnL >= 0 ? 'text-brand-success' : 'text-brand-danger'}`}>
                            {monthlyPnL >= 0 ? '+' : '-'}${Math.abs(monthlyPnL).toFixed(2)}
                          </span>
                        </div>
                        <div className="mt-2 h-1 w-full bg-brand-bg rounded-full overflow-hidden">
                           <div className={`h-full bg-brand-success transition-all duration-1000`} style={{ width: `${Math.min(100, Math.max(0, (monthlyPnL / 500) * 100))}%` }} />
                        </div>
                        <div className="mt-1 flex justify-between text-[8px] text-brand-text/20 font-bold px-1 uppercase tracking-tight">
                            <div className="flex flex-col">
                              <span>Volume Mensal</span>
                              <span className="text-white/40">${monthlyVolume.toFixed(2)}</span>
                            </div>
                            <div className="flex flex-col items-end">
                              <span>Taxas Mensais</span>
                              <span className="text-brand-danger/40">-${monthlyFees.toFixed(2)}</span>
                            </div>
                         </div>
                         <div className="mt-2 flex justify-between text-[8px] text-brand-text/20 font-bold px-1 border-t border-brand-border/10 pt-1">
                            <div className="flex items-center space-x-1">
                              <span>PROJEÇÃO MENSAL</span>
                              <div className="group relative cursor-help">
                                <Info className="w-2.5 h-2.5 opacity-20" />
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-2 bg-brand-surface border border-brand-border rounded-lg shadow-xl w-48 hidden group-hover:block z-50 text-[10px] normal-case text-brand-text font-medium leading-relaxed">
                                  Cálculo estimado do resultado final do mês baseado na performance atual (estimativa linear simples).
                                </div>
                              </div>
                            </div>
                            <span className={monthlyPnL >= 0 ? 'text-brand-success' : 'text-brand-danger'}>
                              ${ (monthlyPnL * 1.25).toFixed(2) }
                            </span>
                         </div>
                      </div>
                   </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Trade Detail Modal */}
      <AnimatePresence>
        {selectedTrade && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedTrade(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="relative w-full max-w-2xl bg-brand-surface border border-brand-border rounded-2xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-brand-border flex items-center justify-between bg-brand-bg/20">
                <div className="flex items-center space-x-4">
                  <div className={`p-3 rounded-xl ${selectedTrade.type === 'LONG' ? 'bg-brand-success/10 text-brand-success' : 'bg-brand-danger/10 text-brand-danger'}`}>
                    <Activity className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-xl font-bold flex items-center space-x-2">
                      <span>{selectedTrade.symbol}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${selectedTrade.type === 'LONG' ? 'bg-brand-success/20 text-brand-success' : 'bg-brand-danger/20 text-brand-danger'}`}>
                        {selectedTrade.type}
                      </span>
                    </h3>
                    <p className="text-brand-text/40 text-[10px] flex items-center space-x-1 mt-0.5">
                      <Clock className="w-3 h-3" />
                      <span>Executado em: {selectedTrade.time}</span>
                      <span className="mx-2">•</span>
                      <span>ID: {selectedTrade.id}</span>
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedTrade(null)}
                  className="p-2 hover:bg-brand-bg rounded-lg transition-colors text-brand-text/30"
                >
                  <X className="w-6 h-6" />
                </button>
              </div>

              <div className="p-6 space-y-6">
                <div className="grid grid-cols-3 md:grid-cols-7 gap-3">
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Entrada</span>
                    <span className="text-sm font-mono font-bold">${selectedTrade.entry}</span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Saída</span>
                    <span className="text-sm font-mono font-bold text-brand-accent">${selectedTrade.exit}</span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Volume</span>
                    <span className="text-sm font-mono font-bold text-white/70">{selectedTrade.volume}</span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Taxas</span>
                    <span className="text-sm font-mono font-bold text-brand-danger/70">{selectedTrade.fees}</span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Tempo</span>
                    <span className="text-sm font-mono font-bold text-white/50">{selectedTrade.duration}</span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Pnl %</span>
                    <span className={`text-sm font-mono font-bold ${selectedTrade.pnl.includes('-') ? 'text-brand-danger' : 'text-brand-success'}`}>
                      {selectedTrade.pnl}
                    </span>
                  </div>
                  <div className="p-3 bg-brand-bg/30 rounded-xl border border-brand-border/30">
                    <span className="text-[10px] text-brand-text/30 font-bold uppercase block mb-1">Líquido</span>
                    <span className={`text-sm font-mono font-bold ${selectedTrade.pnlCash.includes('-') ? 'text-brand-danger' : 'text-brand-success'}`}>
                      {selectedTrade.pnlCash}
                    </span>
                  </div>
                </div>

                <div className="bg-[#080808] border border-brand-border rounded-xl p-4 h-72 relative">
                  <div className="absolute top-4 left-4 z-10">
                    <span className="text-[10px] font-bold text-brand-text/30 uppercase tracking-widest">Análise de Velas (OHLC)</span>
                  </div>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={tradeChartData} margin={{ top: 40, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#1f2937" opacity={0.5} />
                      <XAxis hide dataKey="time" />
                      <YAxis 
                        hide 
                        domain={['dataMin - 0.2', 'dataMax + 0.2']} 
                      />
                      <Tooltip 
                        content={({ active, payload }) => {
                          if (active && payload && payload.length) {
                            const data = payload[0].payload;
                            return (
                              <div className="bg-brand-surface border border-brand-border p-2 rounded-lg shadow-xl text-[10px] font-mono">
                                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                                  <span className="text-brand-text/40">O:</span> <span className="text-white">${data.open.toFixed(2)}</span>
                                  <span className="text-brand-text/40">H:</span> <span className="text-white">${data.high.toFixed(2)}</span>
                                  <span className="text-brand-text/40">L:</span> <span className="text-white">${data.low.toFixed(2)}</span>
                                  <span className="text-brand-text/40">C:</span> <span className="text-white">${data.close.toFixed(2)}</span>
                                </div>
                              </div>
                            );
                          }
                          return null;
                        }}
                      />
                      
                      {/* Wicks */}
                      <Bar dataKey="wick" barSize={1}>
                        {tradeChartData.map((entry, index) => (
                          <Cell key={`wick-${index}`} fill={entry.close >= entry.open ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>
                      
                      {/* Bodies */}
                      <Bar dataKey="body" barSize={12}>
                        {tradeChartData.map((entry, index) => (
                          <Cell key={`body-${index}`} fill={entry.close >= entry.open ? '#10b981' : '#ef4444'} />
                        ))}
                      </Bar>

                      {/* Entry line */}
                      <ReferenceDot 
                        x={0} 
                        y={parseFloat(selectedTrade.entry)} 
                        r={4} 
                        fill="#10b981" 
                        stroke="white" 
                        strokeWidth={1.5}
                      />
                      
                      {/* Exit line */}
                      <ReferenceDot 
                        x={14} 
                        y={parseFloat(selectedTrade.exit)} 
                        r={4} 
                        fill="#3b82f6" 
                        stroke="white" 
                        strokeWidth={1.5}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>

                <div className="flex justify-between items-center text-[10px] text-brand-text/30 font-bold uppercase">
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-white border border-brand-success" />
                    <span>Entrada (Spot / Futuros)</span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <div className="w-2 h-2 rounded-full bg-white border border-brand-accent" />
                    <span>Saída (Fechamento)</span>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-brand-bg/20 border-t border-brand-border flex items-center justify-between">
                {selectedTrade.status === 'OPEN' ? (
                  <button 
                    onClick={(e) => handleCloseSingleTrade(selectedTrade, e)}
                    className="px-4 py-2 bg-brand-danger hover:bg-red-600 text-white rounded-xl font-bold transition-all shadow-md text-xs flex items-center space-x-1.5"
                  >
                    <XCircle className="w-4 h-4" />
                    <span>Fechar Posição & Cancelar Ordens</span>
                  </button>
                ) : <div />}
                <button 
                  onClick={() => setSelectedTrade(null)}
                  className="px-6 py-2 bg-brand-bg hover:bg-brand-surface rounded-xl font-bold transition-all border border-brand-border shadow-sm text-sm"
                >
                  Fechar Detalhes
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Central de Cópia & Backup Modal */}
      <SystemBackupModal
        isOpen={isBackupModalOpen}
        onClose={() => setIsBackupModalOpen(false)}
        onNavigateToView={(view) => setActiveView(view)}
      />

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(0, 0, 0, 0.2);
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}

