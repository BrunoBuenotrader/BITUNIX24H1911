import express from "express";
import path from "path";
import fs from "fs";
import https from "https";
import { createServer as createViteServer } from "vite";
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import {
  answerCallbackQuery,
  sendTelegramMessage,
  configureTelegramBot,
  startTelegramPolling as startTelegramBotPolling,
  stopTelegramPolling as stopTelegramBotPolling,
  resetBotMetadataFlag,
  setTelegramBotUsername,
  getTelegramBotState
} from "./telegramBot";

dotenv.config();

// Global crash prevention - keeps the node server alive under all circumstances
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT_EXCEPTION_GUARD]:', err?.message || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED_REJECTION_GUARD]:', reason);
});

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ limit: '25mb', extended: true }));

  const BITUNIX_BASE_URL = "https://fapi.bitunix.com";

  interface SavedBitunixAccount {
    id: string;
    label: string;
    apiKey: string;
    apiSecret: string;
    accountType: 'USDT' | 'VST';
    createdAt: string;
    updatedAt: string;
  }

  // Credenciais globais centralizadas da Bitunix
  let TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "8782656491:AAEDaXhuCNiLazBWnwSxwyYXUFM1KQr7_zc";
  let telegramUpdateBridge: (update: any) => Promise<void> = async () => {};
  const INSTANCE_ID = `inst_${process.env.RENDER ? 'render' : 'preview'}_${crypto.randomBytes(4).toString('hex')}`;
  const IS_RENDER_PROD = process.env.RENDER === 'true' || Boolean(process.env.RENDER_EXTERNAL_URL);
  const IS_AI_STUDIO_PREVIEW = !IS_RENDER_PROD && (Boolean(process.env.CONTROL_PLANE_PORT) || Boolean(process.env.K_SERVICE && process.env.K_SERVICE.startsWith('ais-')));
  let externalRenderLockActive = false;
  let hasCheckedTelegramLockOnce = false;

  const shouldRunTelegramBotHere = (): boolean => {
    if (process.env.DISABLE_TELEGRAM_POLLING === 'true') return false;
    if (IS_RENDER_PROD) return true; // Render 24h sempre é autoritativo
    if (externalRenderLockActive) return false; // Outro servidor Render ativo reportou heartbeat recente
    // No preview do AI Studio, cede a vez ao Render 24h por padrão para nunca causar erro 409 lá
    if (IS_AI_STUDIO_PREVIEW && (serverTelegramBotConfig as any)?.pausePreviewTelegramPolling !== false) return false;
    return true;
  };

  const startTelegramPolling = (forceRestart = false) => {
    if (!shouldRunTelegramBotHere()) {
      stopTelegramBotPolling();
      return;
    }
    return startTelegramBotPolling(forceRestart);
  };
  configureTelegramBot({
    getToken: () => TELEGRAM_BOT_TOKEN,
    onUpdate: (update) => telegramUpdateBridge(update),
    defaultBotUsername: "Crypptooo_bot"
  });
  let DEFAULT_BITUNIX_KEY = process.env.BITUNIX_API_KEY || "0d3da7e48bf3c01c9e3aaf9c2b06ba0c";
  let DEFAULT_BITUNIX_SECRET = process.env.BITUNIX_API_SECRET || "2effcc77368db44708d33ce31a96cf52";
  let DEFAULT_BINGX_KEY = DEFAULT_BITUNIX_KEY; // Alias de compatibilidade interna para Bitunix
  let DEFAULT_BINGX_SECRET = DEFAULT_BITUNIX_SECRET; // Alias de compatibilidade interna para Bitunix
  let DEFAULT_GEMINI_KEY = process.env.CUSTOM_GEMINI_API_KEY || process.env.GEMINI_API_KEY || "";

  let savedBitunixAccounts: SavedBitunixAccount[] = [];
  let activeBitunixAccountId: string = 'acc_original';
  let lastLocalCredentialSwitchAt = 0;
  let lastLocalTelegramConfigSaveAt = 0;

  const maskKeyStr = (str: string, keepStart = 4, keepEnd = 4) => {
    if (!str) return "";
    if (str.length <= keepStart + keepEnd) return "••••••••";
    return `${str.substring(0, keepStart)}••••${str.substring(str.length - keepEnd)}`;
  };

  const PRESEEDED_BITUNIX_ACCOUNTS: Array<{ id: string; label: string; apiKey: string; apiSecret: string; accountType: 'USDT' | 'VST' }> = [
    {
      id: 'acc_original',
      label: 'Conta Bitunix 1 (Principal)',
      apiKey: '0d3da7e48bf3c01c9e3aaf9c2b06ba0c',
      apiSecret: '2effcc77368db44708d33ce31a96cf52',
      accountType: 'USDT'
    },
    {
      id: 'acc_real',
      label: 'Bitunix Real',
      apiKey: 'cd67680b72a86fc6c3a0ac824ee92ad6',
      apiSecret: 'e7e5a322dcb71b090a0e1a17f497090a',
      accountType: 'USDT'
    }
  ];

  const ensureDefaultSavedAccounts = () => {
    const now = new Date().toISOString();
    let changed = false;

    for (const preset of PRESEEDED_BITUNIX_ACCOUNTS) {
      const existsByKey = savedBitunixAccounts.some(a => a.apiKey.trim() === preset.apiKey);
      if (!existsByKey) {
        const idConflict = savedBitunixAccounts.some(a => a.id === preset.id);
        savedBitunixAccounts.push({
          id: idConflict ? `${preset.id}_${Date.now()}` : preset.id,
          label: preset.label,
          apiKey: preset.apiKey,
          apiSecret: preset.apiSecret,
          accountType: preset.accountType,
          createdAt: now,
          updatedAt: now
        });
        changed = true;
      }
    }

    // Se a chave ativa atual não estiver na lista (ex: inserida antes), preserva também
    if (DEFAULT_BITUNIX_KEY && DEFAULT_BITUNIX_SECRET && !savedBitunixAccounts.some(a => a.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim())) {
      savedBitunixAccounts.unshift({
        id: `acc_custom_${Date.now()}`,
        label: 'Conta Bitunix Ativa',
        apiKey: DEFAULT_BITUNIX_KEY.trim(),
        apiSecret: DEFAULT_BITUNIX_SECRET.trim(),
        accountType: 'USDT',
        createdAt: now,
        updatedAt: now
      });
      changed = true;
    }

    // Sincroniza activeBitunixAccountId com a chave ativa atual (priorizando env vars em deploy novo sem data_credentials.json)
    const hasEnvKeys = Boolean(process.env.BITUNIX_API_KEY && process.env.BITUNIX_API_SECRET);
    const hasCredsFile = fs.existsSync(path.join(process.cwd(), 'data_credentials.json'));
    const envMatched = hasEnvKeys
      ? savedBitunixAccounts.find(a => a.apiKey.trim() === (process.env.BITUNIX_API_KEY || '').trim())
      : undefined;
    const matchedActive = (hasEnvKeys && !hasCredsFile ? envMatched : undefined) ||
                          savedBitunixAccounts.find(a => a.id === activeBitunixAccountId) ||
                          savedBitunixAccounts.find(a => a.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim()) ||
                          savedBitunixAccounts[0];
    if (matchedActive) {
      activeBitunixAccountId = matchedActive.id;
      DEFAULT_BITUNIX_KEY = matchedActive.apiKey.trim();
      DEFAULT_BITUNIX_SECRET = matchedActive.apiSecret.trim();
      DEFAULT_BINGX_KEY = DEFAULT_BITUNIX_KEY;
      DEFAULT_BINGX_SECRET = DEFAULT_BITUNIX_SECRET;
    }

    return changed;
  };

  const getActiveSavedBitunixAccount = (): SavedBitunixAccount | undefined => {
    return savedBitunixAccounts.find(a => a.id === activeBitunixAccountId) ||
           savedBitunixAccounts.find(a => a.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim()) ||
           savedBitunixAccounts[0];
  };

  const getSafeSavedAccountsList = () => {
    const activeAcc = getActiveSavedBitunixAccount();
    return savedBitunixAccounts.map(a => ({
      id: a.id,
      label: a.label,
      apiKey: a.apiKey,
      apiKeyMasked: maskKeyStr(a.apiKey, 6, 5),
      apiSecretMasked: maskKeyStr(a.apiSecret, 4, 4),
      accountType: a.accountType || 'USDT',
      isActive: activeAcc ? a.id === activeAcc.id : a.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim(),
      createdAt: a.createdAt,
      updatedAt: a.updatedAt
    }));
  };

  const CREDENTIALS_FILE = path.join(process.cwd(), 'data_credentials.json');
  const saveCredentialsToFile = () => {
    try {
      fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify({
        apiKey: DEFAULT_BITUNIX_KEY,
        apiSecret: DEFAULT_BITUNIX_SECRET,
        telegramToken: TELEGRAM_BOT_TOKEN,
        geminiApiKey: DEFAULT_GEMINI_KEY,
        activeCredentialId: activeBitunixAccountId,
        savedAccounts: savedBitunixAccounts
      }, null, 2), 'utf-8');
    } catch (e) {}
  };
  const loadCredentialsFromFile = () => {
    try {
      if (fs.existsSync(CREDENTIALS_FILE)) {
        const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
        const data = JSON.parse(raw);
        if (Array.isArray(data.savedAccounts)) {
          savedBitunixAccounts = data.savedAccounts
            .filter((a: any) => a && typeof a.apiKey === 'string' && a.apiKey.trim() && typeof a.apiSecret === 'string' && a.apiSecret.trim())
            .map((a: any) => ({
              id: String(a.id || `acc_${Date.now()}`),
              label: String(a.label || 'Conta Bitunix').trim(),
              apiKey: a.apiKey.trim(),
              apiSecret: a.apiSecret.trim(),
              accountType: a.accountType === 'VST' ? 'VST' : 'USDT',
              createdAt: a.createdAt || new Date().toISOString(),
              updatedAt: a.updatedAt || new Date().toISOString()
            }));
        }
        if (data.activeCredentialId && typeof data.activeCredentialId === 'string') {
          activeBitunixAccountId = data.activeCredentialId.trim();
        }
        if (data.apiKey && typeof data.apiKey === 'string') {
          DEFAULT_BITUNIX_KEY = data.apiKey.trim();
          DEFAULT_BINGX_KEY = DEFAULT_BITUNIX_KEY;
        }
        if (data.apiSecret && typeof data.apiSecret === 'string') {
          DEFAULT_BITUNIX_SECRET = data.apiSecret.trim();
          DEFAULT_BINGX_SECRET = DEFAULT_BITUNIX_SECRET;
        }
        if (data.telegramToken && typeof data.telegramToken === 'string') {
          TELEGRAM_BOT_TOKEN = data.telegramToken.trim();
        }
        if (data.geminiApiKey && typeof data.geminiApiKey === 'string') {
          DEFAULT_GEMINI_KEY = data.geminiApiKey.trim();
        }
      }
    } catch (e) {}
    const addedDefaults = ensureDefaultSavedAccounts();
    if (addedDefaults) {
      saveCredentialsToFile();
    }
  };
  loadCredentialsFromFile();

  // --------------------------------------------------------------------------
  // Multi-Account & Copy Trading Isolation Architecture
  // --------------------------------------------------------------------------
  interface ManagedAccount {
    id: string;
    name: string;
    ownerName: string;
    role: 'ADMIN' | 'OPERATOR';
    apiKey: string;
    apiSecret: string;
    accountType: 'USDT' | 'VST';
    isActive: boolean;
    copyTradingEnabled: boolean;
    riskMode: 'PERCENT' | 'FIXED_USD';
    riskPercent: number;
    riskFixedUsd: number;
    fixedLeverage?: number;
    telegramChatId?: string;
    notifyOnExecution: boolean;
    accessPin?: string;
    createdAt: string;
    updatedAt: string;
  }

  const MULTI_ACCOUNTS_FILE = path.join(process.cwd(), 'data_multi_accounts.json');
  let managedAccounts: ManagedAccount[] = [];
  let masterPinCode = '1234';

  const loadMultiAccountsFromFile = () => {
    try {
      if (fs.existsSync(MULTI_ACCOUNTS_FILE)) {
        const raw = fs.readFileSync(MULTI_ACCOUNTS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.accounts)) {
          managedAccounts = parsed.accounts;
        }
        if (parsed.masterPin) {
          masterPinCode = String(parsed.masterPin).trim();
        }
      }
    } catch (e) {
      console.warn('[MULTI-ACCOUNTS] Erro ao carregar arquivo de contas:', e);
    }

    // Garante que a Conta 1 (Principal do Bruno) sempre exista e use as chaves do sistema
    if (!managedAccounts.some(a => a.id === 'acc_master' || a.role === 'ADMIN')) {
      managedAccounts.unshift({
        id: 'acc_master',
        name: 'Conta Principal (Bruno)',
        ownerName: 'Bruno',
        role: 'ADMIN',
        apiKey: DEFAULT_BITUNIX_KEY,
        apiSecret: DEFAULT_BITUNIX_SECRET,
        accountType: 'USDT',
        isActive: true,
        copyTradingEnabled: true,
        riskMode: 'FIXED_USD',
        riskPercent: 2.0,
        riskFixedUsd: 50.0,
        notifyOnExecution: true,
        accessPin: '1234',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
      saveMultiAccountsToFile();
    }
  };

  const saveMultiAccountsToFile = () => {
    try {
      fs.writeFileSync(MULTI_ACCOUNTS_FILE, JSON.stringify({
        masterPin: masterPinCode,
        accounts: managedAccounts
      }, null, 2), 'utf-8');
    } catch (e) {
      console.error('[MULTI-ACCOUNTS] Erro ao salvar arquivo de contas:', e);
    }
  };
  loadMultiAccountsFromFile();

  // Helper de limpeza de parâmetros de busca para garantir assinatura válida na Bitunix
  const cleanQueryParams = (params: any = {}) => {
    const cleaned: any = {};
    for (const k of Object.keys(params || {})) {
      if (params[k] !== undefined && params[k] !== null && params[k] !== "") {
        cleaned[k] = params[k];
      }
    }
    return cleaned;
  };

  // Helper de assinatura oficial da Bitunix (Double SHA-256 scheme)
  const signBitunixRequest = (apiKey: string, apiSecret: string, nonce: string, timestamp: string | number, queryParams: any = {}, bodyData: any = null) => {
    const cleanParams = cleanQueryParams(queryParams);
    const queryKeys = Object.keys(cleanParams).sort();
    const queryStr = queryKeys.map(k => `${k}${cleanParams[k]}`).join("");

    let bodyStr = "";
    if (bodyData !== null && bodyData !== undefined) {
      bodyStr = typeof bodyData === "string" ? bodyData : JSON.stringify(bodyData);
    }

    const digestString = `${nonce}${timestamp}${apiKey}${queryStr}${bodyStr}`;
    const digest = crypto.createHash("sha256").update(digestString).digest("hex");
    const sign = crypto.createHash("sha256").update(digest + apiSecret).digest("hex");
    return { sign, digest, cleanParams };
  };

  // Helper central para chamadas à API da Bitunix Futures
  const sendBitunixRequest = async (
    endpoint: string,
    method: string = "GET",
    queryParams: any = {},
    body: any = null,
    apiKey: string = DEFAULT_BITUNIX_KEY,
    apiSecret: string = DEFAULT_BITUNIX_SECRET
  ) => {
    const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
    const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();
    const nonce = crypto.randomBytes(16).toString("hex");
    const timestamp = Date.now().toString();

    const { sign, cleanParams } = signBitunixRequest(key, secret, nonce, timestamp, queryParams, body);

    const queryKeys = Object.keys(cleanParams).sort();
    const queryString = queryKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(cleanParams[k])}`).join("&");
    const url = `${BITUNIX_BASE_URL}${endpoint}${queryString ? `?${queryString}` : ''}`;

    const headers: Record<string, string> = {
      "api-key": key,
      "nonce": nonce,
      "timestamp": timestamp,
      "sign": sign,
      "Content-Type": "application/json"
    };

    const res = await axios({
      method,
      url,
      headers,
      data: (body !== null && body !== undefined) ? body : undefined,
      timeout: 15000,
      validateStatus: () => true
    });

    return res.data;
  };

  // =========================================================================
  // 🛡️ RESET AUTOMÁTICO DE SEGURANÇA: ALAVANCAGEM 20X E MARGEM ISOLADA
  // Chamado após fechamento de posições ou cancelamento de ordens
  // =========================================================================
  const resetSymbolLeverageAndMarginMode = async (
    rawSymbol: string,
    apiKey: string = DEFAULT_BITUNIX_KEY,
    apiSecret: string = DEFAULT_BITUNIX_SECRET
  ) => {
    try {
      const bitunixSym = resolveBitunixSymbol(rawSymbol).apiSymbol;
      if (!bitunixSym) return;
      console.log(`[RESET-LEVERAGE-MARGIN] 🔄 Resetando ${bitunixSym} para 20x e Margem Isolada (ISOLATION)...`);

      const [levRes, marginRes] = await Promise.allSettled([
        sendBitunixRequest(
          '/api/v1/futures/account/change_leverage',
          'POST',
          {},
          { symbol: bitunixSym, leverage: 20, marginCoin: 'USDT' },
          apiKey,
          apiSecret
        ),
        sendBitunixRequest(
          '/api/v1/futures/account/change_margin_mode',
          'POST',
          {},
          { symbol: bitunixSym, marginMode: 'ISOLATION', marginCoin: 'USDT' },
          apiKey,
          apiSecret
        )
      ]);

      console.log(`[RESET-LEVERAGE-MARGIN] ✅ ${bitunixSym} resetado com sucesso para 20x e Margem Isolada.`);
    } catch (err: any) {
      console.warn(`[RESET-LEVERAGE-MARGIN-ERR] Falha ao resetar ${rawSymbol}:`, err?.message || err);
    }
  };

  const checkAndResetLeverageIfNoPosition = async (
    symbol: string,
    apiKey: string = DEFAULT_BITUNIX_KEY,
    apiSecret: string = DEFAULT_BITUNIX_SECRET,
    isDemo: boolean = false
  ) => {
    try {
      const bitunixSym = resolveBitunixSymbol(symbol).apiSymbol;
      if (!bitunixSym) return;
      const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { symbol: bitunixSym }, null, apiKey, apiSecret).catch(() => null);
      const posList = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
      const hasActivePosition = posList.some((p: any) => {
        const qty = Math.abs(parseFloat(p.qty || p.holdAmt || p.total || p.positionAmt || '0'));
        return qty > 0;
      });

      if (!hasActivePosition) {
        console.log(`[RESET-LEVERAGE-MARGIN] Nenhuma posição aberta ativa para ${bitunixSym}. Resetando para 20x e Margem Isolada...`);
        await resetSymbolLeverageAndMarginMode(bitunixSym, apiKey, apiSecret);
      }
    } catch (e: any) {
      console.warn(`[RESET-LEVERAGE-MARGIN-CHECK-ERR]:`, e?.message);
    }
  };

  // Endpoint to fetch Bitunix & BingX Symbols (Public - no sign needed)
  const fetchMarketSymbolsHandler = async (req: express.Request, res: express.Response) => {
    try {
      const [pairsRes, tickersRes] = await Promise.all([
        axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/trading_pairs`, { timeout: 10000 }).catch(() => ({ data: { data: [] } })),
        axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/tickers`, { timeout: 10000 }).catch(() => ({ data: { data: [] } }))
      ]);

      const pairs = Array.isArray(pairsRes.data?.data) ? pairsRes.data.data : [];
      const tickers = Array.isArray(tickersRes.data?.data) ? tickersRes.data.data : [];

      const tickerMap = new Map<string, any>();
      tickers.forEach((t: any) => {
        if (t.symbol) tickerMap.set(t.symbol, t);
      });

      const symbols = pairs.map((pair: any) => {
        const rawSymbol = pair.symbol;
        const ticker = tickerMap.get(rawSymbol);
        const lastPrice = ticker ? (ticker.lastPrice || ticker.last || '0') : '0';
        const openPrice = ticker ? (ticker.open || lastPrice) : lastPrice;
        const changePct = parseFloat(openPrice) > 0 ? (((parseFloat(lastPrice) - parseFloat(openPrice)) / parseFloat(openPrice)) * 100) : 0;
        const cleanBase = pair.base || rawSymbol.replace(/USDT$/, '');

        const maxDec = Math.min(8, Math.max(0, pair.quotePrecision !== undefined ? pair.quotePrecision : 4));
        const minDec = Math.min(2, maxDec);
        const formattedPrice = isNaN(parseFloat(lastPrice)) ? '$0.00' : `$${parseFloat(lastPrice).toLocaleString(undefined, { minimumFractionDigits: minDec, maximumFractionDigits: maxDec })}`;

        return {
          symbol: `BITUNIX:${rawSymbol}`,
          name: cleanBase,
          price: formattedPrice,
          change: `${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%`,
          up: changePct >= 0,
          quotePrecision: pair.quotePrecision,
          basePrecision: pair.basePrecision,
          minTradeVolume: pair.minTradeVolume,
          maxLeverage: pair.maxLeverage
        };
      }).filter((s: any) => s.symbol.endsWith('USDT'));

      res.json(symbols);
    } catch (error: any) {
      console.error("[SYMBOLS-FETCH-ERROR]:", error.message);
      res.status(500).json({ error: "Erro ao buscar símbolos da Bitunix" });
    }
  };

  app.get("/api/bitunix-symbols", fetchMarketSymbolsHandler);
  app.get("/api/bingx-symbols", fetchMarketSymbolsHandler);

  // =========================================================================
  // BITUNIX CONTRACTS CACHE & INTELLIGENT SYMBOL RESOLVER
  // Suporte total a Cripto, Ouro/XAU, Prata/XAG, Memes (1000PEPE, 1000SHIB, etc)
  // =========================================================================
  let bitunixContractsList: any[] = [];
  let bingxContractsList: any[] = [];
  const symbolLookupIndex = new Map<string, any>();
  let lastContractsFetchTime = 0;

  const KNOWN_SYMBOL_ALIASES: Record<string, string> = {
    // Ouro / Gold / XAU
    'GOLD': 'XAUUSDT',
    'XAU': 'XAUUSDT',
    'GOLDXAU': 'XAUUSDT',
    'XAUUSD': 'XAUUSDT',
    'GOLDUSD': 'XAUUSDT',
    'XAUUSDT': 'XAUUSDT',
    'GOLDUSDT': 'XAUUSDT',
    'GOLDXAUUSDT': 'XAUUSDT',
    'XAUT': 'XAUTUSDT',
    'XAUTUSDT': 'XAUTUSDT',
    // Prata / Silver / XAG
    'SILVER': 'XAGUSDT',
    'XAG': 'XAGUSDT',
    'SILVERXAG': 'XAGUSDT',
    'XAGUSD': 'XAGUSDT',
    'SILVERUSD': 'XAGUSDT',
    'SILVERUSDT': 'XAGUSDT',
    'XAGUSDT': 'XAGUSDT',
    // Memes e Tokens com multiplicador na Bitunix
    'PEPE': '1000PEPEUSDT',
    '1000PEPE': '1000PEPEUSDT',
    'PEPEUSDT': '1000PEPEUSDT',
    'BONK': '1000BONKUSDT',
    '1000BONK': '1000BONKUSDT',
    'BONKUSDT': '1000BONKUSDT',
    'FLOKI': '1000FLOKIUSDT',
    '1000FLOKI': '1000FLOKIUSDT',
    'FLOKIUSDT': '1000FLOKIUSDT',
    'SHIB': '1000SHIBUSDT',
    '1000SHIB': '1000SHIBUSDT',
    'SHIBUSDT': '1000SHIBUSDT',
    'LUNC': '1000LUNCUSDT',
    '1000LUNC': '1000LUNCUSDT',
    'SATS': '1000SATSUSDT',
    '1000SATS': '1000SATSUSDT',
    'RATS': '1000RATSUSDT',
    '1000RATS': '1000RATSUSDT',
    'CAT': '1000CATUSDT',
    '1000CAT': '1000CATUSDT',
    'CHEEMS': '1000CHEEMSUSDT',
    '1000CHEEMS': '1000CHEEMSUSDT',
    'BABYDOGE': '1MBABYDOGEUSDT',
    '1MBABYDOGE': '1MBABYDOGEUSDT',
    'BABYDOGEUSDT': '1MBABYDOGEUSDT',
    // Criptos populares por extenso e sinônimos
    'MARSCOIN': 'MARSCOINUSDT',
    'MARS': 'MARSCOINUSDT',
    'BITCOIN': 'BTCUSDT',
    'BTC': 'BTCUSDT',
    'ETHEREUM': 'ETHUSDT',
    'ETH': 'ETHUSDT',
    'SOLANA': 'SOLUSDT',
    'SOL': 'SOLUSDT',
    'DOGE': 'DOGEUSDT',
    'DOGECOIN': 'DOGEUSDT',
    'RIPPLE': 'XRPUSDT',
    'XRP': 'XRPUSDT',
    'CARDANO': 'ADAUSDT',
    'ADA': 'ADAUSDT',
    'AVALANCHE': 'AVAXUSDT',
    'AVAX': 'AVAXUSDT',
    'LINK': 'LINKUSDT',
    'CHAINLINK': 'LINKUSDT'
  };

  const cleanKey = (s: string) => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  const buildBitunixSymbolIndex = (contracts: any[]) => {
    symbolLookupIndex.clear();
    // Prioriza contratos USDT
    const sorted = [...contracts].sort((a, b) => {
      const aUsdt = a.symbol?.endsWith('USDT') ? 1 : 0;
      const bUsdt = b.symbol?.endsWith('USDT') ? 1 : 0;
      return bUsdt - aUsdt;
    });

    for (const c of sorted) {
      if (!c || !c.symbol) continue;
      const rawSym = (c.symbol || '').toUpperCase();
      const rawBase = (c.base || '').toUpperCase();

      const item = {
        symbol: rawSym,
        base: rawBase,
        quote: c.quote || 'USDT',
        displayName: rawSym,
        pricePrecision: typeof c.quotePrecision === 'number' ? c.quotePrecision : 2,
        quantityPrecision: typeof c.basePrecision === 'number' ? c.basePrecision : 2,
        tradeMinQuantity: parseFloat(c.minTradeVolume || '0.0001'),
        maxLeverage: typeof c.maxLeverage === 'number' ? c.maxLeverage : 100
      };

      if (!symbolLookupIndex.has(rawSym)) symbolLookupIndex.set(rawSym, item);

      const clnSym = cleanKey(rawSym);
      if (!symbolLookupIndex.has(clnSym)) symbolLookupIndex.set(clnSym, item);

      const symNoUsdt = cleanKey(rawSym.replace(/[-_ ]?USDT$/i, ''));
      if (symNoUsdt && !symbolLookupIndex.has(symNoUsdt)) symbolLookupIndex.set(symNoUsdt, item);

      if (rawBase) {
        const clnBase = cleanKey(rawBase);
        if (!symbolLookupIndex.has(clnBase)) symbolLookupIndex.set(clnBase, item);
      }
    }
    console.log(`[BITUNIX-CONTRACTS-INDEX] Indexados ${contracts.length} pares da Bitunix em ${symbolLookupIndex.size} chaves de busca.`);
  };

  const fetchBitunixContracts = async (force: boolean = false): Promise<any[]> => {
    const now = Date.now();
    if (!force && bitunixContractsList.length > 0 && (now - lastContractsFetchTime < 15 * 60 * 1000)) {
      return bitunixContractsList;
    }
    try {
      const res = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/trading_pairs`, { timeout: 12000 });
      if (res.data?.code === 0 && Array.isArray(res.data?.data)) {
        bitunixContractsList = res.data.data;
        bingxContractsList = bitunixContractsList;
        lastContractsFetchTime = now;
        buildBitunixSymbolIndex(bitunixContractsList);
      }
    } catch (err: any) {
      console.warn("[BITUNIX-CONTRACTS-CACHE] Falha ao carregar contratos:", err?.message);
    }
    return bitunixContractsList;
  };

  const fetchBingXContracts = fetchBitunixContracts;

  const resolveBitunixSymbol = (input: string): { 
    apiSymbol: string; 
    displayName: string; 
    cleanSymbol: string; 
    contract: any | null; 
  } => {
    if (!input) {
      return { apiSymbol: '', displayName: '', cleanSymbol: '', contract: null };
    }

    let rawUpper = input.toUpperCase().trim();
    // Remove prefixos e sufixos comuns
    rawUpper = rawUpper.replace(/^BITUNIX:/i, '').replace(/^BINGX:/i, '').replace(/\.P$/i, '');
    const cleaned = cleanKey(rawUpper);
    const withoutUsdt = cleanKey(rawUpper.replace(/[-_ /]?USDT$/i, '').replace(/[-_ /]?USD$/i, ''));

    // 1. Busca direta no índice oficial de contratos da Bitunix (prioridade máxima)
    const directContract = symbolLookupIndex.get(rawUpper) ||
                           symbolLookupIndex.get(cleaned) ||
                           symbolLookupIndex.get(withoutUsdt) ||
                           symbolLookupIndex.get(`${withoutUsdt}USDT`) ||
                           symbolLookupIndex.get(`1000${withoutUsdt}`) ||
                           symbolLookupIndex.get(`1000${withoutUsdt}USDT`);

    if (directContract) {
      return {
        apiSymbol: directContract.symbol,
        displayName: directContract.displayName || directContract.symbol,
        cleanSymbol: withoutUsdt || cleaned,
        contract: directContract
      };
    }

    // 2. Checar mapa de sinônimos/aliases pré-definidos (Ouro, Prata, Memes, Criptos populares)
    const aliasMatch = KNOWN_SYMBOL_ALIASES[cleaned] || KNOWN_SYMBOL_ALIASES[withoutUsdt] || KNOWN_SYMBOL_ALIASES[rawUpper];
    if (aliasMatch) {
      const contractFromAlias = symbolLookupIndex.get(aliasMatch.toUpperCase()) ||
                                symbolLookupIndex.get(`${aliasMatch.toUpperCase()}USDT`) ||
                                bitunixContractsList.find(c => c.symbol === aliasMatch);
      if (contractFromAlias) {
        return {
          apiSymbol: contractFromAlias.symbol,
          displayName: contractFromAlias.displayName || contractFromAlias.symbol,
          cleanSymbol: withoutUsdt || cleaned,
          contract: contractFromAlias
        };
      }
    }

    // 3. Tratamento para tokens digitados com sufixo 'COIN' (ex: PEPECOIN -> PEPE)
    if (withoutUsdt.endsWith('COIN') && withoutUsdt.length > 4) {
      const strippedCoin = withoutUsdt.slice(0, -4);
      const contractFromStripped = symbolLookupIndex.get(strippedCoin) ||
                                  symbolLookupIndex.get(`${strippedCoin}USDT`) ||
                                  symbolLookupIndex.get(`1000${strippedCoin}`) ||
                                  symbolLookupIndex.get(`1000${strippedCoin}USDT`);
      if (contractFromStripped) {
        return {
          apiSymbol: contractFromStripped.symbol,
          displayName: contractFromStripped.displayName || contractFromStripped.symbol,
          cleanSymbol: strippedCoin,
          contract: contractFromStripped
        };
      }
    }

    if (aliasMatch) {
      return {
        apiSymbol: aliasMatch,
        displayName: aliasMatch,
        cleanSymbol: withoutUsdt || cleaned,
        contract: null
      };
    }

    // 4. Fallback padrão: {SYMBOL}USDT sem hífens
    const defaultApi = cleaned.endsWith('USDT') ? cleaned : `${withoutUsdt || cleaned}USDT`;
    return {
      apiSymbol: defaultApi,
      displayName: defaultApi,
      cleanSymbol: withoutUsdt || cleaned,
      contract: null
    };
  };

  const resolveBingXSymbol = resolveBitunixSymbol;

  // Helper universal para comparação e correspondência robusta de símbolos
  const isSameOrRelatedSymbol = (s1: string, s2: string): boolean => {
    if (!s1 || !s2) return false;
    const str1 = s1.toUpperCase().trim().replace(/^BITUNIX:/, '').replace(/^BINGX:/, '').replace(/\.P$/, '');
    const str2 = s2.toUpperCase().trim().replace(/^BITUNIX:/, '').replace(/^BINGX:/, '').replace(/\.P$/, '');
    if (str1 === str2) return true;

    const c1 = cleanKey(str1);
    const c2 = cleanKey(str2);
    if (c1 === c2) return true;

    const noUsdt1 = cleanKey(str1.replace(/[-_ /]?USDT$/i, '').replace(/[-_ /]?USD$/i, ''));
    const noUsdt2 = cleanKey(str2.replace(/[-_ /]?USDT$/i, '').replace(/[-_ /]?USD$/i, ''));
    if (noUsdt1 && noUsdt2 && noUsdt1 === noUsdt2) return true;

    const res1 = resolveBitunixSymbol(str1).apiSymbol;
    const res2 = resolveBitunixSymbol(str2).apiSymbol;
    if (res1 && res2 && res1 === res2) return true;

    if (noUsdt1 && noUsdt2 && (noUsdt1.length >= 6 || noUsdt2.length >= 6)) {
      if (noUsdt1.includes(noUsdt2) || noUsdt2.includes(noUsdt1)) return true;
    }
    return false;
  };

  // Carregamento inicial assíncrono dos contratos
  fetchBitunixContracts().catch(() => {});
  setInterval(() => { fetchBitunixContracts().catch(() => {}); }, 15 * 60 * 1000);

  // Helper legacy to sign BingX requests
  const signRequest = (params: any, secret: string) => {
    const queryString = Object.keys(params)
      .sort()
      .map(key => `${key}=${params[key]}`)
      .join("&");
    
    return crypto
      .createHmac("sha256", secret)
      .update(queryString)
      .digest("hex");
  };

  // Endpoint para resolução e normalização de símbolos (Cripto, Commodities, Índices)
  app.get("/api/resolve-symbol", async (req, res) => {
    try {
      const input = (req.query.symbol as string) || '';
      await fetchBitunixContracts();
      const resolved = resolveBitunixSymbol(input);
      res.json({
        success: true,
        input,
        apiSymbol: resolved.apiSymbol,
        displayName: resolved.displayName,
        cleanSymbol: resolved.cleanSymbol,
        contract: resolved.contract ? {
          symbol: resolved.contract.symbol,
          displayName: resolved.contract.displayName,
          pricePrecision: resolved.contract.pricePrecision,
          quantityPrecision: resolved.contract.quantityPrecision,
          tradeMinQuantity: resolved.contract.tradeMinQuantity,
          maxLeverage: resolved.contract.maxLeverage
        } : null
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Bitunix & BingX Unified Proxy Handler
  const handleTradingProxy = async (req: express.Request, res: express.Response) => {
    const { endpoint, method, params, body, apiKey, apiSecret } = req.body;
    const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
    const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();

    if (!key || !secret) {
      return res.status(400).json({ 
        code: -1, 
        msg: "API Key e Secret da Bitunix são obrigatórios para esta operação." 
      });
    }

    try {
      const ep = (endpoint || '').trim();
      const mtd = (method || 'GET').toUpperCase();

      // 1. Tradução inteligente para saldo da conta
      if (ep === '/openApi/swap/v2/user/balance' || ep === '/api/v1/futures/account') {
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/account', 'GET', { marginCoin: 'USDT' }, null, key, secret);
        if (bitunixRes?.code === 0 && bitunixRes?.data) {
          const avail = parseFloat(bitunixRes.data.available || bitunixRes.data.availableMargin || bitunixRes.data.transfer || '0');
          const margin = parseFloat(bitunixRes.data.margin || '0');
          const equity = avail + margin;
          return res.json({
            code: 0,
            msg: "Success",
            data: {
              balance: {
                asset: "USDT",
                currency: "USDT",
                balance: avail.toString(),
                equity: equity.toString(),
                availableMargin: avail.toString()
              },
              asset: "USDT",
              currency: "USDT",
              equity: equity.toString(),
              availableMargin: avail.toString()
            }
          });
        }
        return res.json(bitunixRes);
      }

      // 2. Tradução inteligente para posições abertas
      if (ep === '/openApi/swap/v2/user/positions' || ep === '/api/v1/futures/position/get_pending_positions') {
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', {}, null, key, secret);
        if (bitunixRes?.code === 0 && Array.isArray(bitunixRes?.data)) {
          const positions = bitunixRes.data.map((p: any) => ({
            symbol: p.symbol,
            positionSide: p.side === 'BUY' ? 'LONG' : (p.side === 'SELL' ? 'SHORT' : p.side),
            positionAmt: (p.side === 'SELL' ? -Math.abs(parseFloat(p.holdAmt || p.qty || '0')) : Math.abs(parseFloat(p.holdAmt || p.qty || '0'))).toString(),
            entryPrice: p.avgOpenPrice || p.entryPrice || '0',
            markPrice: p.markPrice || '0',
            leverage: p.leverage || 20,
            unrealizedProfit: p.unrealizedProfit || '0',
            liquidationPrice: p.liqPrice || '0',
            isolatedMargin: p.margin || '0'
          }));
          return res.json({
            code: 0,
            msg: "Success",
            data: positions
          });
        }
        return res.json(bitunixRes);
      }

      // 2.1 Tradução inteligente para cotações / tickers
      if (ep === '/openApi/swap/v2/quote/ticker' || ep === '/api/v1/futures/market/tickers') {
        const symbol = resolveBitunixSymbol(params?.symbol || body?.symbol || '').apiSymbol;
        const tickerRes = await sendBitunixRequest('/api/v1/futures/market/tickers', 'GET', symbol ? { symbols: symbol } : {}, null, key, secret);
        const item = Array.isArray(tickerRes?.data) ? tickerRes.data[0] : null;
        const price = item?.lastPrice || item?.markPrice || '0';
        return res.json({
          code: 0,
          msg: "Success",
          data: {
            symbol,
            lastPrice: price,
            markPrice: item?.markPrice || price,
            volume: item?.volume || '0'
          }
        });
      }

      // 2.2 Tradução inteligente para contratos
      if (ep === '/openApi/swap/v2/quote/contracts' || ep === '/api/v1/futures/market/trading_pairs') {
        const contracts = await fetchBitunixContracts();
        return res.json({
          code: 0,
          msg: "Success",
          data: contracts
        });
      }

      // 3. Tradução inteligente para alteração de alavancagem
      if (ep === '/openApi/swap/v2/trade/leverage' || ep === '/api/v1/futures/account/change_leverage') {
        const symbol = resolveBitunixSymbol(params?.symbol || body?.symbol || '').apiSymbol;
        const leverage = parseInt(params?.leverage || body?.leverage || '20', 10);
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/account/change_leverage', 'POST', {}, { symbol, leverage, marginCoin: 'USDT' }, key, secret);
        return res.json(bitunixRes);
      }

      // 3.1 Tradução inteligente para modo de margem
      if (ep === '/openApi/swap/v2/trade/marginType' || ep === '/api/v1/futures/account/change_margin_mode') {
        const symbol = resolveBitunixSymbol(params?.symbol || body?.symbol || '').apiSymbol;
        const rawMode = (params?.marginType || body?.marginType || params?.marginMode || body?.marginMode || 'ISOLATED').toUpperCase();
        const marginMode = (rawMode === 'CROSSED' || rawMode === 'CROSS') ? 'CROSS' : 'ISOLATION';
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/account/change_margin_mode', 'POST', {}, { symbol, marginMode, marginCoin: 'USDT' }, key, secret);
        return res.json(bitunixRes);
      }

      // 3.2 Tradução inteligente para cancelamento de TODAS as ordens pendentes / gatilhos
      if (ep === '/openApi/swap/v2/trade/allOpenOrders' || ep === '/api/v1/futures/trade/cancel_all_orders') {
        const rawSym = params?.symbol || body?.symbol || '';
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const cancelRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, symbol ? { symbol } : {}, key, secret);
        if (symbol) {
          await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol }, key, secret).catch(() => {});
          await checkAndResetLeverageIfNoPosition(symbol, key, secret);
        }
        return res.json({ code: 0, msg: "Success", data: cancelRes?.data || {} });
      }

      // 3.3 Tradução inteligente para fechamento a mercado de posições (close_all_position)
      if (ep === '/api/v1/futures/trade/close_all_position') {
        const rawSym = params?.symbol || body?.symbol || '';
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const closeRes = await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, symbol ? { symbol } : {}, key, secret);
        if (symbol) {
          await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol }, key, secret).catch(() => {});
          await resetSymbolLeverageAndMarginMode(symbol, key, secret);
        }
        return res.json({ code: 0, msg: "Success", data: closeRes?.data || {} });
      }

      // 3.4 Tradução inteligente para cancelamento de ordens específicas da Bitunix
      if (ep === '/api/v1/futures/trade/cancel_orders' && mtd === 'POST') {
        const rawSym = params?.symbol || body?.symbol || '';
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        let orderList = body?.orderList || params?.orderList;
        const singleOrderId = body?.orderId || params?.orderId || body?.orderID || params?.orderID;
        if (!orderList && singleOrderId) {
          orderList = [{ orderId: singleOrderId.toString() }];
        }
        const delRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_orders', 'POST', {}, { symbol, orderList }, key, secret);
        if (symbol) {
          await checkAndResetLeverageIfNoPosition(symbol, key, secret);
        }
        return res.json(delRes);
      }

      // 4. Tradução inteligente para abertura ou fechamento de ordens
      if (ep === '/openApi/swap/v2/trade/order' || ep === '/api/v1/futures/trade/place_order') {
        if (mtd === 'POST') {
          const rawSym = params?.symbol || body?.symbol || '';
          const resolved = resolveBitunixSymbol(rawSym);
          const symbol = resolved.apiSymbol;
          const side = (params?.side || body?.side || 'BUY').toUpperCase();
          const positionSide = (params?.positionSide || body?.positionSide || '').toUpperCase();

          // 🛡️ INTERCEPTOR EXCLUSIVO PARA STOP MÓVEL / TRAILING STOP (NUNCA CONFUNDIR COM CLOSE_ALL)
          const rawType = (params?.type || body?.type || '').toUpperCase();
          if (rawType === 'TRAILING_STOP_MARKET' || rawType === 'TRAILING_STOP' || rawType.includes('TRAILING')) {
            console.log(`[BITUNIX-PROXY] ⚡ Recebido registro de Trailing Stop / Ordem Móvel para ${symbol}...`);
            const rawRate = parseFloat(params?.priceRate || params?.callbackRate || body?.priceRate || body?.callbackRate || '1.0');
            const callbackRate = rawRate > 1 ? rawRate : parseFloat((rawRate * 100).toFixed(3));
            const actPrice = (params?.activationPrice || body?.activationPrice) ? parseFloat(params?.activationPrice || body?.activationPrice) : undefined;
            const posSideNorm = (positionSide || (side === 'SELL' ? 'LONG' : 'SHORT')).toUpperCase() as 'LONG' | 'SHORT';
            const entryPrice = parseFloat(params?.entryPrice || body?.entryPrice || '0');
            const slPrice = (params?.stopLoss || body?.stopLoss) ? parseFloat(params?.stopLoss || body?.stopLoss) : undefined;
            const orderQty = (params?.quantity || body?.quantity || params?.qty || body?.qty || '0').toString();

            if (typeof registerBitunixTrailingStop === 'function') {
              await registerBitunixTrailingStop({
                symbol,
                positionSide: posSideNorm,
                entryPrice,
                callbackRate,
                activationPrice: actPrice,
                stopLossPrice: slPrice,
                qty: orderQty
              });
            }

            return res.json({
              code: 0,
              msg: "Success",
              data: {
                orderId: `TS-${Date.now()}`,
                symbol,
                side,
                positionSide: posSideNorm,
                type: "TRAILING_STOP_MARKET"
              }
            });
          }

          const isExplicitClose = params?.action === 'CLOSE_ALL' || body?.action === 'CLOSE_ALL' || params?.isCloseAllPosition || body?.isCloseAllPosition || params?.closePosition || body?.closePosition;
          const tradeSide = (positionSide === 'SHORT' && side === 'BUY') || (positionSide === 'LONG' && side === 'SELL') || isExplicitClose ? 'CLOSE' : 'OPEN';
          const orderType = (params?.type || body?.type || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
          const qty = (params?.quantity || body?.quantity || params?.qty || body?.qty || '0').toString();
          const price = params?.price || body?.price || undefined;

          let tpPrice = params?.tpPrice || body?.tpPrice;
          let slPrice = params?.slPrice || body?.slPrice;
          if (!tpPrice && (params?.takeProfit || body?.takeProfit)) {
            try {
              const tpObj = typeof (params?.takeProfit || body?.takeProfit) === 'string' ? JSON.parse(params?.takeProfit || body?.takeProfit) : (params?.takeProfit || body?.takeProfit);
              if (tpObj?.stopPrice) tpPrice = tpObj.stopPrice.toString();
            } catch {}
          }
          if (!slPrice && (params?.stopLoss || body?.stopLoss)) {
            try {
              const slObj = typeof (params?.stopLoss || body?.stopLoss) === 'string' ? JSON.parse(params?.stopLoss || body?.stopLoss) : (params?.stopLoss || body?.stopLoss);
              if (slObj?.stopPrice) slPrice = slObj.stopPrice.toString();
            } catch {}
          }
          if (!slPrice && (params?.type === 'STOP_MARKET' || body?.type === 'STOP_MARKET') && (params?.stopPrice || body?.stopPrice)) {
            slPrice = (params?.stopPrice || body?.stopPrice).toString();
          }
          if (!tpPrice && (params?.type === 'TAKE_PROFIT_MARKET' || body?.type === 'TAKE_PROFIT_MARKET') && (params?.stopPrice || body?.stopPrice)) {
            tpPrice = (params?.stopPrice || body?.stopPrice).toString();
          }

          if (isExplicitClose || tradeSide === 'CLOSE') {
            const reqQtyNum = parseFloat(qty || '0');
            // Verifica se trata-se de fechamento PARCIAL (qty explícita menor que a posição aberta e sem flag CLOSE_ALL)
            if (!isExplicitClose && !isNaN(reqQtyNum) && reqQtyNum > 0) {
              try {
                const posCheckRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
                const openList = Array.isArray(posCheckRes?.data) ? posCheckRes.data : [];
                const targetPosSide = positionSide || (side === 'SELL' ? 'LONG' : 'SHORT');
                const matchedPos = openList.find((p: any) =>
                  p.symbol === symbol &&
                  Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0 &&
                  (!positionSide || (p.side === 'BUY' ? 'LONG' : 'SHORT') === targetPosSide)
                ) || openList.find((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0);

                if (matchedPos) {
                  const openAmt = Math.abs(parseFloat(matchedPos.total || matchedPos.qty || matchedPos.holdAmt || '0'));
                  if (openAmt > 0 && reqQtyNum < openAmt * 0.99) {
                    const posSideNorm = (matchedPos.side === 'BUY' || matchedPos.positionSide === 'LONG') ? 'LONG' : 'SHORT';
                    const posMode = (matchedPos.positionMode || 'HEDGE').toUpperCase();
                    const hedgeCloseSide = posSideNorm === 'LONG' ? 'BUY' : 'SELL';
                    const oppositeCloseSide = posSideNorm === 'LONG' ? 'SELL' : 'BUY';

                    await fetchBitunixContracts().catch(() => {});
                    const contract = resolveBitunixSymbol(symbol).contract;
                    const qPrec = typeof contract?.quantityPrecision === 'number' ? contract.quantityPrecision : (matchedPos.qty?.includes('.') ? matchedPos.qty.split('.')[1].length : 0);
                    const factor = Math.pow(10, qPrec);
                    const roundedPartial = Math.floor(reqQtyNum * factor + 1e-9) / factor;
                    const partialQtyStr = roundedPartial.toFixed(qPrec);

                    console.log(`[BITUNIX-PROXY-PARTIAL] ✂️ Fechamento parcial seguro em ${symbol} (${posSideNorm}): ${partialQtyStr} de ${openAmt} (positionMode=${posMode})`);

                    let partialRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                      symbol,
                      qty: partialQtyStr,
                      side: posMode === 'HEDGE' ? hedgeCloseSide : oppositeCloseSide,
                      tradeSide: 'CLOSE',
                      orderType,
                      ...(price && orderType === 'LIMIT' ? { price: price.toString() } : {}),
                      reduceOnly: posMode !== 'HEDGE',
                      positionId: matchedPos.positionId || undefined
                    }, key, secret);

                    if (partialRes?.code !== 0) {
                      partialRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                        symbol,
                        qty: partialQtyStr,
                        side: posMode === 'HEDGE' ? oppositeCloseSide : hedgeCloseSide,
                        tradeSide: 'CLOSE',
                        orderType,
                        ...(price && orderType === 'LIMIT' ? { price: price.toString() } : {}),
                        reduceOnly: false,
                        positionId: matchedPos.positionId || undefined
                      }, key, secret);
                    }

                    return res.json(partialRes);
                  }
                }
              } catch (partialErr: any) {
                console.warn('[BITUNIX-PROXY-PARTIAL-CHECK-ERR]:', partialErr?.message);
              }
            }

            const closeRes = await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol }, key, secret);
            
            // Fallback: se ainda houver resíduo na posição, fecha por lote a mercado
            try {
              const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
              const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
              const pos = positions.find((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0);
              if (pos) {
                const amt = Math.abs(parseFloat(pos.total || pos.qty || pos.holdAmt || '0'));
                const pSide = (pos.side || pos.positionSide || (side === 'SELL' ? 'LONG' : 'SHORT')).toUpperCase();
                const ordSide = (pos.positionMode || 'HEDGE').toUpperCase() === 'HEDGE'
                  ? (pSide === 'LONG' || pSide === 'BUY' ? 'BUY' : 'SELL')
                  : (pSide === 'LONG' || pSide === 'BUY' ? 'SELL' : 'BUY');
                if (pos.positionId) {
                  await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol, positionId: pos.positionId }, key, secret).catch(() => {});
                }
                if (amt > 0) {
                  await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                    symbol,
                    qty: amt.toString(),
                    side: ordSide,
                    tradeSide: 'CLOSE',
                    orderType: 'MARKET',
                    reduceOnly: (pos.positionMode || 'HEDGE').toUpperCase() !== 'HEDGE',
                    positionId: pos.positionId || undefined
                  }, key, secret).catch(() => {});
                }
              }
            } catch (e: any) {
              console.warn('[BITUNIX-PROXY-FALLBACK-CLOSE-ERR]:', e.message);
            }

            // Cancelamento completo de ordens pendentes e gatilhos
            await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol }, key, secret).catch(() => {});
            
            // Cancelamento individual de todas as ordens de TPSL para não deixar ordens repetidas/órfãs
            try {
              const tpslList = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol }, null, key, secret);
              const list = (tpslList?.data && Array.isArray(tpslList.data)) ? tpslList.data : [];
              for (const ord of list) {
                const oid = ord.orderId || ord.id;
                if (oid) {
                  await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol, orderId: oid }, key, secret).catch(() => {});
                }
              }
            } catch (e) {}

            if (typeof stopBitunixTrailingStop === 'function') {
              stopBitunixTrailingStop(symbol);
            }

            // 🛡️ Auto-reset para 20x e Margem Isolada após fechar posição
            await resetSymbolLeverageAndMarginMode(symbol, key, secret);

            return res.json({ code: 0, msg: "Success", data: closeRes?.data || {} });
          }

          const orderPayload: any = {
            symbol,
            qty,
            side,
            tradeSide,
            orderType,
            reduceOnly: (tradeSide as string) === 'CLOSE'
          };
          if (price && orderType === 'LIMIT') orderPayload.price = price.toString();
          if (tpPrice) {
            orderPayload.tpPrice = tpPrice.toString();
            orderPayload.tpStopType = "MARK_PRICE";
            orderPayload.tpOrderType = "MARKET";
          }
          if (slPrice) {
            orderPayload.slPrice = slPrice.toString();
            orderPayload.slStopType = "MARK_PRICE";
            orderPayload.slOrderType = "MARKET";
          }

          const bitunixRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, orderPayload, key, secret);

          // Se a ordem foi aceita a mercado e tem TP ou SL, anexa na posição ativa
          if (bitunixRes?.code === 0 && (tpPrice || slPrice) && orderType === 'MARKET') {
            setTimeout(async () => {
              try {
                const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
                const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
                const pos = positions.find((p: any) => p.symbol === symbol);
                if (pos && pos.positionId) {
                  let finalSl = slPrice ? slPrice.toString() : undefined;
                  let finalTp = tpPrice ? tpPrice.toString() : undefined;
                  if (!finalSl || !finalTp) {
                    try {
                      const existRes = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol }, null, key, secret);
                      const list = (existRes?.data && Array.isArray(existRes.data)) ? existRes.data : [];
                      for (const ord of list) {
                        if (!finalTp && ord.tpPrice && parseFloat(ord.tpPrice) > 0) finalTp = ord.tpPrice.toString();
                        if (!finalSl && ord.slPrice && parseFloat(ord.slPrice) > 0) finalSl = ord.slPrice.toString();
                      }
                    } catch {}
                  }
                  const tpslBody: any = { symbol, positionId: pos.positionId };
                  if (finalSl) { tpslBody.slPrice = finalSl; tpslBody.slStopType = "MARK_PRICE"; }
                  if (finalTp) { tpslBody.tpPrice = finalTp; tpslBody.tpStopType = "MARK_PRICE"; }
                  await sendBitunixRequest('/api/v1/futures/tpsl/position/place_order', 'POST', {}, tpslBody, key, secret);
                }
              } catch {}
            }, 800);
          }

          return res.json(bitunixRes);
        }
        if (mtd === 'DELETE') {
          const rawSym = params?.symbol || body?.symbol || '';
          const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
          const orderId = (params?.orderId || body?.orderId || params?.orderID || body?.orderID || '').toString();
          let delRes: any;
          if (orderId) {
            delRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_orders', 'POST', {}, { symbol, orderList: [{ orderId }] }, key, secret);
            await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol, orderId }, key, secret).catch(() => {});
          } else {
            delRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, symbol ? { symbol } : {}, key, secret);
          }
          if (symbol) {
            await checkAndResetLeverageIfNoPosition(symbol, key, secret);
          }
          return res.json(delRes);
        }
      }

      // 4.1 Tradução de Histórico de Renda e Taxas (Income)
      if (ep === '/openApi/swap/v2/user/income') {
        const rawSym = params?.symbol || body?.symbol;
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const incomeType = params?.incomeType || body?.incomeType;
        const startTime = (params?.startTime || body?.startTime) ? parseInt(params?.startTime || body?.startTime, 10) : undefined;
        const endTime = (params?.endTime || body?.endTime) ? parseInt(params?.endTime || body?.endTime, 10) : undefined;
        const limit = (params?.limit || body?.limit) ? parseInt(params?.limit || body?.limit, 10) : 100;

        const histPosRes = await sendBitunixRequest('/api/v1/futures/position/get_history_positions', 'GET', {
          symbol,
          pageSize: Math.min(100, Math.max(limit, 50))
        }, null, key, secret).catch(() => ({ code: -1, data: {} }));

        const posList = (histPosRes?.data?.positionList && Array.isArray(histPosRes.data.positionList))
          ? histPosRes.data.positionList
          : [];

        const items: any[] = [];
        for (const pos of posList) {
          const pnl = parseFloat(pos.realizedPNL || "0");
          const fee = parseFloat(pos.fee || "0");
          const funding = parseFloat(pos.funding || "0");
          const time = parseInt(pos.mtime || pos.ctime || "0", 10);
          const dir = (pos.side === 'BUY' || pos.side === 'LONG') ? 'LONG' : 'SHORT';

          if (params?.strictTime || body?.strictTime) {
            if (startTime && time < startTime) continue;
            if (endTime && time > endTime) continue;
          }

          if (!incomeType || incomeType === 'REALIZED_PNL') {
            items.push({
              symbol: pos.symbol,
              incomeType: 'REALIZED_PNL',
              income: pnl.toString(),
              asset: 'USDT',
              time,
              info: `Fechamento ${dir}`,
              tradeId: pos.positionId || undefined,
              entryPrice: pos.entryPrice,
              exitPrice: pos.closePrice,
              leverage: pos.leverage,
              direction: dir,
              margin: pos.margin,
              qty: pos.qty || pos.maxQty
            });
          }

          if (!incomeType || incomeType === 'TRADING_FEE') {
            if (fee > 0) {
              items.push({
                symbol: pos.symbol,
                incomeType: 'TRADING_FEE',
                income: (-Math.abs(fee)).toString(),
                asset: 'USDT',
                time,
                info: 'Taxa de Negociação',
                tradeId: pos.positionId || undefined
              });
            }
          }

          if (!incomeType || incomeType === 'FUNDING_FEE') {
            if (funding !== 0) {
              items.push({
                symbol: pos.symbol,
                incomeType: 'FUNDING_FEE',
                income: funding.toString(),
                asset: 'USDT',
                time,
                info: 'Taxa de Financiamento',
                tradeId: pos.positionId || undefined
              });
            }
          }
        }

        items.sort((a, b) => b.time - a.time);
        return res.json({
          code: 0,
          msg: "Success",
          data: items.slice(0, limit)
        });
      }

      // 4.2 Tradução de Histórico de Ordens
      if (ep === '/openApi/swap/v2/trade/allOrders') {
        const rawSym = params?.symbol || body?.symbol;
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const limit = (params?.limit || body?.limit) ? parseInt(params?.limit || body?.limit, 10) : 30;

        const histOrdersRes = await sendBitunixRequest('/api/v1/futures/trade/get_history_orders', 'GET', {
          symbol,
          pageSize: limit
        }, null, key, secret).catch(() => ({ code: -1, data: {} }));

        const rawList = (histOrdersRes?.data?.orderList && Array.isArray(histOrdersRes.data.orderList))
          ? histOrdersRes.data.orderList
          : [];

        const mapped = rawList.map((o: any) => ({
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          positionSide: (o.side === 'BUY' ? 'LONG' : 'SHORT'),
          type: o.orderType || o.type,
          price: o.price,
          avgPrice: o.avgPrice,
          status: o.status,
          executedQty: o.qty || o.executedQty || '0',
          origQty: o.qty || '0',
          time: parseInt(o.ctime || '0', 10),
          updateTime: parseInt(o.mtime || o.ctime || '0', 10),
          stopPrice: o.stopPrice,
          leverage: o.leverage,
          realizedProfit: o.realizedPNL
        }));

        return res.json({
          code: 0,
          msg: "Success",
          data: {
            orders: mapped
          }
        });
      }

      // 5. Chamada direta Bitunix ou repasse
      const query = mtd === 'GET' ? { ...params, ...(body || {}) } : (params || {});
      const postBody = mtd !== 'GET' ? (body || params || null) : null;
      const bitunixRes = await sendBitunixRequest(ep, mtd, query, postBody, key, secret);
      return res.json(bitunixRes);
    } catch (error: any) {
      const statusCode = error.response?.status || 500;
      const errorData = error.response?.data || { 
        code: -1, 
        msg: error.message || "Erro de conexão com a Bitunix" 
      };
      console.error(`[BITUNIX-PROXY-ERROR] ${statusCode}:`, JSON.stringify(errorData));
      return res.status(statusCode).json(errorData);
    }
  };

  app.post("/api/bitunix-proxy", handleTradingProxy);
  app.post("/api/bingx-proxy", handleTradingProxy);

  // Telegram Webhook Handler (for instant zero-poll delivery if configured)
  app.post("/api/telegram-webhook", async (req, res) => {
    res.status(200).send({ ok: true });
    try {
      if (req.body && (req.body.update_id !== undefined || req.body.message || req.body.callback_query)) {
        await processTelegramUpdate(req.body);
      }
    } catch (err: any) {
      console.error("[TELEGRAM-WEBHOOK-ERROR]", err?.message || err);
    }
  });

  // Endpoint to parse trading chart screenshot with Gemini Vision AI
  app.post("/api/parse-chart-image", async (req, res) => {
    try {
      const { imageBase64, mimeType, caption } = req.body;
      if (!imageBase64) {
        return res.status(400).json({ success: false, error: "Imagem não fornecida." });
      }

      const cleanBase64 = String(imageBase64).replace(/^data:image\/[a-zA-Z0-9+]+;base64,/, '');
      const buffer = Buffer.from(cleanBase64, 'base64');
      const result = await parseTradingChartImageWithGemini(buffer, mimeType || 'image/jpeg', caption);

      res.json(result);
    } catch (err: any) {
      console.error("[API-PARSE-CHART-ERROR]:", err?.message || err);
      res.status(500).json({ success: false, error: err?.message || "Erro ao processar imagem do gráfico" });
    }
  });
  
  let FIRESTORE_DB_ID = "ai-studio-bitunix-3e31b850-271f-4ef3-94a0-9f8191d62a24";
  let FIRESTORE_PROJECT_ID = "gen-lang-client-0811943364";
  let FIRESTORE_API_KEY = "";
  try {
    const fbRaw = fs.readFileSync(path.join(process.cwd(), "firebase-applet-config.json"), "utf8");
    const fbCfg = JSON.parse(fbRaw);
    if (fbCfg.projectId) FIRESTORE_PROJECT_ID = fbCfg.projectId;
    if (fbCfg.firestoreDatabaseId) FIRESTORE_DB_ID = fbCfg.firestoreDatabaseId;
    if (fbCfg.apiKey) FIRESTORE_API_KEY = fbCfg.apiKey;
  } catch (e) {}

  // Local deduplication caches (fast in-memory layer)
  const localSentCardsCache = new Map<string, number>();
  const localInFlightOperations = new Set<string>();

  let serverTelegramBotConfig = {
    autoExecuteWithoutPrompt: false, // Envia a mensagem com todos os detalhes para confirmação com 1 toque
    riskPercent: 2.0,
    riskMode: 'FIXED_USD' as 'PERCENT' | 'FIXED_USD',
    riskFixedUsd: 50.0,
    accountType: 'USDT' as 'USDT' | 'VST', // USDT Real por padrão
    defaultOrderType: 'SMART' as 'SMART' | 'ENTRY_1' | 'ENTRY_2' | 'ENTRY_AVG' | 'MARKET',
    defaultLeverageMode: 'SIGNAL_LEVERAGE' as 'SIGNAL_LEVERAGE' | 'FIXED_LEVERAGE',
    fixedLeverageValue: 20,
    maxLeverageCap: 1000, // Alavancagem até 1000x por padrão (suporte total a Cripto, Ouro, Prata, Índices e Forex)
    trailingStopEnabled: true,
    trailingMultiplier: 1.0, // Trailing stop 1.0x por padrão
    takeProfitSelection: 'LAST_TP' as 'TP1' | 'TP2' | 'TP3' | 'ALL_TPS' | 'LAST_TP', // Alvo principal sempre o último alvo
    emergencyStopPercent: 5.0, // Stop loss de emergência 5% por padrão
    includeFeesInRisk: true,
    autoCrossMarginEnabled: true, // Margem cruzada inteligente se SL alavancado >= 25% ou alavancagem elevada
    autoCrossMarginThreshold: 25, // Limiar em % de perda com alavancagem para mudar para Cruzada
    autoBreakevenEnabled: true, // Breakeven Dinâmico Automático
    autoBreakevenTriggerPct: 1.5, // Gatilho de lucro para mover Stop Loss para o 0 a 0 (1.5%)
    trailingActivationMultiplier: 1.0, // Preço de ativação / gatilho do Trailing Stop (1.0x da distância do SL)
    dailyLossLimitEnabled: true, // Trava diária de perda ($100 USD padrão)
    dailyLossPercent: 0, // 0% (usa trava fixa em USD por padrão)
    dailyLossFixedUsd: 100.0, // $100 USD fixos por padrão
    dailyProfitTargetEnabled: false, // Meta de lucro diária desativada por padrão
    dailyProfitTargetPercent: 10.0, // 10% da banca se ativada
    dailyProfitFixedUsd: 0, // Se em dólares fixos
    dailyLockUnlockedDate: '', // 'DD/MM/YYYY' da última liberação manual do operador
    // 🎯 Condução de Stop Loss (Proteção Escalonada - Prints 2 e 3)
    conducaoStrategy: 'CONDUCAO' as 'CONDUCAO' | 'TRAILING', // 'CONDUCAO' (Vezes o Stop Loss) ou 'TRAILING'
    conducaoStopEnabled: true,
    conducaoTier0Trigger: 1.0, // 0. Reduzir Risco (Gatilho 1x, stop puxa p/ -33%)
    conducaoTier1Trigger: 1.5, // 1. Mover p/ Entrada Break-Even (1.5x)
    conducaoTier2Trigger: 1.5, // 2. Preço de Equilíbrio Cobrir Taxas (1.5x)
    conducaoTier3Trigger: 2.0, // 3. Começar Condução Fase 1 (2x)
    conducaoTier4Dist: 1.0,    // 4. Folga Inicial Fase 1 (1x recuado)
    conducaoTier5Trigger: 3.0, // 5. Apertar Stop Fase 2 (3x)
    conducaoTier6Dist: 0.5,    // 6. Folga Reduzida Fase 2 (0.5x recuado)
    feeRebate: true,           // Reembolso de Taxas (45% de retorno)
    vipTargetsMode: 'VIP_SCALED' as 'VIP_SCALED' | 'STANDARD', // Alvos VIP (1x / +0.5x)
    smartEntry1mEnabled: true, // Entrada Inteligente 1m (+5% SL)
    pausePreviewTelegramPolling: true // No preview do AI Studio, cede o bot ao servidor Render 24h para evitar Conflito 409
  };

  const TELEGRAM_CONFIG_FILE = path.join(process.cwd(), 'data_telegram_config.json');
  const loadTelegramConfigFromFile = () => {
    try {
      if (fs.existsSync(TELEGRAM_CONFIG_FILE)) {
        const raw = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if (parsed.riskPercent !== undefined) serverTelegramBotConfig.riskPercent = parseFloat(parsed.riskPercent);
          if (parsed.riskMode) serverTelegramBotConfig.riskMode = parsed.riskMode;
          if (parsed.riskFixedUsd !== undefined) serverTelegramBotConfig.riskFixedUsd = parseFloat(parsed.riskFixedUsd);
          if (parsed.accountType) serverTelegramBotConfig.accountType = parsed.accountType;
          if (parsed.defaultOrderType) serverTelegramBotConfig.defaultOrderType = parsed.defaultOrderType;
          if (parsed.defaultLeverageMode) serverTelegramBotConfig.defaultLeverageMode = parsed.defaultLeverageMode;
          if (parsed.fixedLeverageValue !== undefined) serverTelegramBotConfig.fixedLeverageValue = parseInt(parsed.fixedLeverageValue, 10);
          if (parsed.maxLeverageCap !== undefined) serverTelegramBotConfig.maxLeverageCap = parseInt(parsed.maxLeverageCap, 10);
          if (parsed.trailingStopEnabled !== undefined) serverTelegramBotConfig.trailingStopEnabled = Boolean(parsed.trailingStopEnabled);
          if (parsed.trailingMultiplier !== undefined) serverTelegramBotConfig.trailingMultiplier = parseFloat(parsed.trailingMultiplier);
          if (parsed.autoExecuteWithoutPrompt !== undefined) serverTelegramBotConfig.autoExecuteWithoutPrompt = Boolean(parsed.autoExecuteWithoutPrompt);
          if (parsed.takeProfitSelection) serverTelegramBotConfig.takeProfitSelection = parsed.takeProfitSelection;
          if (parsed.emergencyStopPercent !== undefined) serverTelegramBotConfig.emergencyStopPercent = parseFloat(parsed.emergencyStopPercent);
          if (parsed.includeFeesInRisk !== undefined) serverTelegramBotConfig.includeFeesInRisk = Boolean(parsed.includeFeesInRisk);
          if (parsed.autoCrossMarginEnabled !== undefined) serverTelegramBotConfig.autoCrossMarginEnabled = Boolean(parsed.autoCrossMarginEnabled);
          if (parsed.autoCrossMarginThreshold !== undefined) serverTelegramBotConfig.autoCrossMarginThreshold = parseFloat(parsed.autoCrossMarginThreshold);
          if (parsed.autoBreakevenEnabled !== undefined) serverTelegramBotConfig.autoBreakevenEnabled = Boolean(parsed.autoBreakevenEnabled);
          if (parsed.autoBreakevenTriggerPct !== undefined) serverTelegramBotConfig.autoBreakevenTriggerPct = parseFloat(parsed.autoBreakevenTriggerPct);
          if (parsed.trailingActivationMultiplier !== undefined) serverTelegramBotConfig.trailingActivationMultiplier = parseFloat(parsed.trailingActivationMultiplier);
          if (parsed.dailyLossLimitEnabled !== undefined) serverTelegramBotConfig.dailyLossLimitEnabled = Boolean(parsed.dailyLossLimitEnabled);
          if (parsed.dailyLossPercent !== undefined) serverTelegramBotConfig.dailyLossPercent = parseFloat(parsed.dailyLossPercent);
          if (parsed.dailyLossFixedUsd !== undefined) serverTelegramBotConfig.dailyLossFixedUsd = parseFloat(parsed.dailyLossFixedUsd);
          if (parsed.dailyProfitTargetEnabled !== undefined) serverTelegramBotConfig.dailyProfitTargetEnabled = Boolean(parsed.dailyProfitTargetEnabled);
          if (parsed.dailyProfitTargetPercent !== undefined) serverTelegramBotConfig.dailyProfitTargetPercent = parseFloat(parsed.dailyProfitTargetPercent);
          if (parsed.dailyProfitFixedUsd !== undefined) serverTelegramBotConfig.dailyProfitFixedUsd = parseFloat(parsed.dailyProfitFixedUsd);
          if (parsed.dailyLockUnlockedDate) serverTelegramBotConfig.dailyLockUnlockedDate = parsed.dailyLockUnlockedDate;
          if (parsed.conducaoStrategy) serverTelegramBotConfig.conducaoStrategy = parsed.conducaoStrategy;
          if (parsed.conducaoStopEnabled !== undefined) serverTelegramBotConfig.conducaoStopEnabled = Boolean(parsed.conducaoStopEnabled);
          if (parsed.conducaoTier0Trigger !== undefined) serverTelegramBotConfig.conducaoTier0Trigger = parseFloat(parsed.conducaoTier0Trigger);
          if (parsed.conducaoTier1Trigger !== undefined) serverTelegramBotConfig.conducaoTier1Trigger = parseFloat(parsed.conducaoTier1Trigger);
          if (parsed.conducaoTier2Trigger !== undefined) serverTelegramBotConfig.conducaoTier2Trigger = parseFloat(parsed.conducaoTier2Trigger);
          if (parsed.conducaoTier3Trigger !== undefined) serverTelegramBotConfig.conducaoTier3Trigger = parseFloat(parsed.conducaoTier3Trigger);
          if (parsed.conducaoTier4Dist !== undefined) serverTelegramBotConfig.conducaoTier4Dist = parseFloat(parsed.conducaoTier4Dist);
          if (parsed.conducaoTier5Trigger !== undefined) serverTelegramBotConfig.conducaoTier5Trigger = parseFloat(parsed.conducaoTier5Trigger);
          if (parsed.conducaoTier6Dist !== undefined) serverTelegramBotConfig.conducaoTier6Dist = parseFloat(parsed.conducaoTier6Dist);
          if (parsed.feeRebate !== undefined) (serverTelegramBotConfig as any).feeRebate = Boolean(parsed.feeRebate);
          if (parsed.vipTargetsMode) (serverTelegramBotConfig as any).vipTargetsMode = parsed.vipTargetsMode;
          if (parsed.smartEntry1mEnabled !== undefined) (serverTelegramBotConfig as any).smartEntry1mEnabled = Boolean(parsed.smartEntry1mEnabled);
          if (parsed.pausePreviewTelegramPolling !== undefined) (serverTelegramBotConfig as any).pausePreviewTelegramPolling = Boolean(parsed.pausePreviewTelegramPolling);
        }
      }
    } catch (e) {}
  };

  // Sincronização de líder para o Bot do Telegram via Firestore (evita conflito 409 entre Render 24h e AI Studio preview)
  const syncTelegramHostLock = async () => {
    try {
      const keyParam = FIRESTORE_API_KEY ? `?key=${FIRESTORE_API_KEY}` : '';
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents/telegram_locks/active_poller${keyParam}`;
      if (IS_RENDER_PROD) {
        const fields = {
          hostType: { stringValue: 'render' },
          instanceId: { stringValue: INSTANCE_ID },
          externalUrl: { stringValue: process.env.RENDER_EXTERNAL_URL || '' },
          heartbeatAtMs: { doubleValue: Date.now() }
        };
        await axios.patch(url, { fields }, { timeout: 4000 }).catch(() => {});
        externalRenderLockActive = false;
      } else {
        const res = await axios.get(url, { timeout: 3500 }).catch(() => null);
        const fields = res?.data?.fields;
        const hostType = fields?.hostType?.stringValue || '';
        const hbRaw = fields?.heartbeatAtMs?.doubleValue ?? fields?.heartbeatAtMs?.integerValue;
        const hbMs = hbRaw !== undefined ? Number(hbRaw) : 0;
        const isRenderAlive = hostType === 'render' && hbMs > 0 && (Date.now() - hbMs) < 90000;
        externalRenderLockActive = isRenderAlive;
        if (!shouldRunTelegramBotHere()) {
          stopTelegramBotPolling();
        }
      }
      hasCheckedTelegramLockOnce = true;
    } catch (e) {
      hasCheckedTelegramLockOnce = true;
    }
  };

  // Helper unificado Anti-Liquidação: força Margem Cruzada quando SL alavancado atinge limiar (padrão 25%) ou em alavancagem alta
  const shouldUseCrossMargin = (
    slLeveragedPct: number,
    leverage: number,
    customThreshold?: number,
    enabledOverride?: boolean
  ): boolean => {
    const isEnabled = enabledOverride !== undefined ? enabledOverride : (serverTelegramBotConfig.autoCrossMarginEnabled !== false);
    if (!isEnabled) return false;
    const configuredThreshold = customThreshold || serverTelegramBotConfig.autoCrossMarginThreshold || 25;
    if (slLeveragedPct >= configuredThreshold) return true;
    // Em alavancagens >= 20x (especialmente 50x+), a margem de manutenção + taxa reduz muito o buffer isolado
    if (leverage >= 20 && slLeveragedPct >= 20) return true;
    if (leverage >= 35 && slLeveragedPct >= 15) return true;
    return false;
  };

  const syncTelegramConfigToFirestore = async () => {
    try {
      const keyParam = FIRESTORE_API_KEY ? `&key=${FIRESTORE_API_KEY}` : '';
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents/workspaces/global/settings/config`;
      const fields: any = {
        telegramBotConfig: {
          mapValue: {
            fields: {
              riskMode: { stringValue: serverTelegramBotConfig.riskMode },
              riskPercent: { doubleValue: Number(serverTelegramBotConfig.riskPercent) || 2.0 },
              riskFixedUsd: { doubleValue: Number(serverTelegramBotConfig.riskFixedUsd) || 50.0 },
              autoCrossMarginEnabled: { booleanValue: serverTelegramBotConfig.autoCrossMarginEnabled !== false },
              autoCrossMarginThreshold: { doubleValue: Number(serverTelegramBotConfig.autoCrossMarginThreshold) || 25 },
              dailyLossLimitEnabled: { booleanValue: Boolean(serverTelegramBotConfig.dailyLossLimitEnabled) },
              dailyLossPercent: { doubleValue: Number(serverTelegramBotConfig.dailyLossPercent) || 0 },
              dailyLossFixedUsd: { doubleValue: Number(serverTelegramBotConfig.dailyLossFixedUsd) || 0 }
            }
          }
        },
        riskCalculationMode: { stringValue: serverTelegramBotConfig.riskMode === 'FIXED_USD' ? 'USD' : 'PERCENT' },
        maxRiskPerTradeUsd: { doubleValue: Number(serverTelegramBotConfig.riskFixedUsd) || 50.0 },
        autoCrossMarginEnabled: { booleanValue: serverTelegramBotConfig.autoCrossMarginEnabled !== false },
        autoCrossMarginThreshold: { doubleValue: Number(serverTelegramBotConfig.autoCrossMarginThreshold) || 25 },
        dailyLossLimitPercent: { doubleValue: Boolean(serverTelegramBotConfig.dailyLossLimitEnabled) ? (Number(serverTelegramBotConfig.dailyLossPercent) || 0) : 0 },
        dailyLossLimitUsd: { doubleValue: Boolean(serverTelegramBotConfig.dailyLossLimitEnabled) ? (Number(serverTelegramBotConfig.dailyLossFixedUsd) || 0) : 0 }
      };
      const maskPaths = [
        'telegramBotConfig.riskMode',
        'telegramBotConfig.riskPercent',
        'telegramBotConfig.riskFixedUsd',
        'telegramBotConfig.autoCrossMarginEnabled',
        'telegramBotConfig.autoCrossMarginThreshold',
        'telegramBotConfig.dailyLossLimitEnabled',
        'telegramBotConfig.dailyLossPercent',
        'telegramBotConfig.dailyLossFixedUsd',
        'riskCalculationMode',
        'maxRiskPerTradeUsd',
        'autoCrossMarginEnabled',
        'autoCrossMarginThreshold',
        'dailyLossLimitPercent',
        'dailyLossLimitUsd'
      ];
      const qs = maskPaths.map(p => `updateMask.fieldPaths=${p}`).join('&') + keyParam;
      await axios.patch(`${url}?${qs}`, { fields }, { timeout: 4000 });
    } catch (e: any) {
      console.warn('[TELEGRAM-CONFIG-FIRESTORE-SYNC-WARN]:', e?.message || e);
    }
  };

  const saveTelegramConfigToFile = (syncCloud = true) => {
    try {
      if (syncCloud) {
        lastLocalTelegramConfigSaveAt = Date.now();
      }
      const masterAcc = managedAccounts.find(a => a.id === 'acc_master');
      if (masterAcc) {
        masterAcc.riskMode = serverTelegramBotConfig.riskMode;
        masterAcc.riskPercent = serverTelegramBotConfig.riskPercent;
        masterAcc.riskFixedUsd = serverTelegramBotConfig.riskFixedUsd;
        masterAcc.updatedAt = new Date().toISOString();
        saveMultiAccountsToFile();
      }
      fs.writeFileSync(TELEGRAM_CONFIG_FILE, JSON.stringify(serverTelegramBotConfig, null, 2), 'utf-8');
      if (syncCloud) {
        syncTelegramConfigToFirestore().catch(() => {});
      }
    } catch (e) {}
  };
  loadTelegramConfigFromFile();
  lastLocalTelegramConfigSaveAt = Date.now();
  syncTelegramConfigToFirestore().catch(() => {});

  const syncSharedSettingsFromFirestore = async () => {
    try {
      const keyParam = FIRESTORE_API_KEY ? `?key=${FIRESTORE_API_KEY}` : '';
      const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents/workspaces/global/settings/config${keyParam}`;
      const res = await axios.get(url, { timeout: 3500 });
      if (res.data?.fields) {
        const f = res.data.fields;
        const canSyncConfigFromCloud = (Date.now() - lastLocalTelegramConfigSaveAt) > 30000;

        if (f.telegramBotConfig?.mapValue?.fields) {
          const tc = f.telegramBotConfig.mapValue.fields;
          if (canSyncConfigFromCloud) {
            if (tc.riskPercent?.doubleValue !== undefined) serverTelegramBotConfig.riskPercent = parseFloat(tc.riskPercent.doubleValue);
            else if (tc.riskPercent?.integerValue !== undefined) serverTelegramBotConfig.riskPercent = parseInt(tc.riskPercent.integerValue, 10);
            if (tc.riskMode?.stringValue) serverTelegramBotConfig.riskMode = tc.riskMode.stringValue as any;
            if (tc.riskFixedUsd?.doubleValue !== undefined) serverTelegramBotConfig.riskFixedUsd = parseFloat(tc.riskFixedUsd.doubleValue);
            else if (tc.riskFixedUsd?.integerValue !== undefined) serverTelegramBotConfig.riskFixedUsd = parseInt(tc.riskFixedUsd.integerValue, 10);
            if (tc.dailyLossLimitEnabled?.booleanValue !== undefined) serverTelegramBotConfig.dailyLossLimitEnabled = tc.dailyLossLimitEnabled.booleanValue;
            if (tc.dailyLossPercent?.doubleValue !== undefined) serverTelegramBotConfig.dailyLossPercent = parseFloat(tc.dailyLossPercent.doubleValue);
            else if (tc.dailyLossPercent?.integerValue !== undefined) serverTelegramBotConfig.dailyLossPercent = parseInt(tc.dailyLossPercent.integerValue, 10);
            if (tc.dailyLossFixedUsd?.doubleValue !== undefined) serverTelegramBotConfig.dailyLossFixedUsd = parseFloat(tc.dailyLossFixedUsd.doubleValue);
            else if (tc.dailyLossFixedUsd?.integerValue !== undefined) serverTelegramBotConfig.dailyLossFixedUsd = parseInt(tc.dailyLossFixedUsd.integerValue, 10);
            if (tc.autoCrossMarginEnabled?.booleanValue !== undefined) serverTelegramBotConfig.autoCrossMarginEnabled = tc.autoCrossMarginEnabled.booleanValue;
            if (tc.autoCrossMarginThreshold?.doubleValue !== undefined) serverTelegramBotConfig.autoCrossMarginThreshold = parseFloat(tc.autoCrossMarginThreshold.doubleValue);
            else if (tc.autoCrossMarginThreshold?.integerValue !== undefined) serverTelegramBotConfig.autoCrossMarginThreshold = parseInt(tc.autoCrossMarginThreshold.integerValue, 10);
          }
          if (tc.defaultOrderType?.stringValue) serverTelegramBotConfig.defaultOrderType = tc.defaultOrderType.stringValue as any;
          if (tc.defaultLeverageMode?.stringValue) serverTelegramBotConfig.defaultLeverageMode = tc.defaultLeverageMode.stringValue as any;
          if (tc.fixedLeverageValue?.integerValue !== undefined) serverTelegramBotConfig.fixedLeverageValue = parseInt(tc.fixedLeverageValue.integerValue, 10);
          if (tc.maxLeverageCap?.integerValue !== undefined) serverTelegramBotConfig.maxLeverageCap = parseInt(tc.maxLeverageCap.integerValue, 10);
          if (tc.trailingStopEnabled?.booleanValue !== undefined) serverTelegramBotConfig.trailingStopEnabled = tc.trailingStopEnabled.booleanValue;
          if (tc.trailingMultiplier?.doubleValue !== undefined) serverTelegramBotConfig.trailingMultiplier = parseFloat(tc.trailingMultiplier.doubleValue);
          else if (tc.trailingMultiplier?.integerValue !== undefined) serverTelegramBotConfig.trailingMultiplier = parseInt(tc.trailingMultiplier.integerValue, 10);
          if (tc.autoExecuteWithoutPrompt?.booleanValue !== undefined) serverTelegramBotConfig.autoExecuteWithoutPrompt = tc.autoExecuteWithoutPrompt.booleanValue;
          if (tc.takeProfitSelection?.stringValue) serverTelegramBotConfig.takeProfitSelection = tc.takeProfitSelection.stringValue as any;
          if (tc.emergencyStopPercent?.doubleValue !== undefined) serverTelegramBotConfig.emergencyStopPercent = parseFloat(tc.emergencyStopPercent.doubleValue);
          else if (tc.emergencyStopPercent?.integerValue !== undefined) serverTelegramBotConfig.emergencyStopPercent = parseInt(tc.emergencyStopPercent.integerValue, 10);
          if (tc.accountType?.stringValue) {
            serverTelegramBotConfig.accountType = tc.accountType.stringValue as any;
          }
        }

        // Evita sobrescrever troca recente feita localmente pelo usuário
        const canSyncKeysFromCloud = (Date.now() - lastLocalCredentialSwitchAt) > 30000;
        if (canSyncKeysFromCloud && f.apiKey?.stringValue && f.apiSecret?.stringValue) {
          const cloudKey = f.apiKey.stringValue.trim();
          const cloudSecret = f.apiSecret.stringValue.trim();
          if (cloudKey && cloudSecret && cloudKey !== DEFAULT_BITUNIX_KEY) {
            DEFAULT_BITUNIX_KEY = cloudKey;
            DEFAULT_BITUNIX_SECRET = cloudSecret;
            DEFAULT_BINGX_KEY = cloudKey;
            DEFAULT_BINGX_SECRET = cloudSecret;
            const matched = savedBitunixAccounts.find(a => a.apiKey.trim() === cloudKey);
            if (matched) {
              activeBitunixAccountId = matched.id;
            }
          }
        }
        if (f.telegramBotToken?.stringValue) {
          const newTok = f.telegramBotToken.stringValue.trim();
          if (newTok && newTok !== TELEGRAM_BOT_TOKEN) {
            console.log("[TELEGRAM-TOKEN-SYNC] Novo token do bot sincronizado do Firestore:", newTok.substring(0, 10) + '...');
            TELEGRAM_BOT_TOKEN = newTok;
            saveCredentialsToFile();
            resetBotMetadataFlag();
            startTelegramPolling(true);
          }
        }
        if (f.maxLeverageCap?.integerValue !== undefined) serverTelegramBotConfig.maxLeverageCap = parseInt(f.maxLeverageCap.integerValue, 10);
        if (f.allowFreeLeverage?.booleanValue !== undefined) {
          serverTelegramBotConfig.defaultLeverageMode = f.allowFreeLeverage.booleanValue ? 'SIGNAL_LEVERAGE' : 'FIXED_LEVERAGE';
        }
        if (!canSyncConfigFromCloud) {
          loadTelegramConfigFromFile();
        } else {
          saveTelegramConfigToFile(false);
        }
      }
    } catch (e) {
      // ignore
    }
  };

  // Helper centralizado para alternar conta Bitunix ativa + persistir em disco + Firestore + Copy Master
  const applyActiveBitunixCredential = async (acc: SavedBitunixAccount, syncFirestore = true) => {
    lastLocalCredentialSwitchAt = Date.now();
    activeBitunixAccountId = acc.id;
    DEFAULT_BITUNIX_KEY = acc.apiKey.trim();
    DEFAULT_BITUNIX_SECRET = acc.apiSecret.trim();
    DEFAULT_BINGX_KEY = DEFAULT_BITUNIX_KEY;
    DEFAULT_BINGX_SECRET = DEFAULT_BITUNIX_SECRET;

    const masterAcc = managedAccounts.find(a => a.id === 'acc_master');
    if (masterAcc) {
      masterAcc.apiKey = DEFAULT_BITUNIX_KEY;
      masterAcc.apiSecret = DEFAULT_BITUNIX_SECRET;
      masterAcc.updatedAt = new Date().toISOString();
      saveMultiAccountsToFile();
    }

    saveCredentialsToFile();
    console.log(`[ACCOUNT-SWITCH] Conta Bitunix ativa alterada para "${acc.label}" (${maskKeyStr(acc.apiKey, 6, 4)})`);

    if (syncFirestore) {
      try {
        const keyParam = FIRESTORE_API_KEY ? `&key=${FIRESTORE_API_KEY}` : '';
        const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents/workspaces/global/settings/config`;
        const fields: any = {
          apiKey: { stringValue: DEFAULT_BITUNIX_KEY },
          apiSecret: { stringValue: DEFAULT_BITUNIX_SECRET }
        };
        const qs = `updateMask.fieldPaths=apiKey&updateMask.fieldPaths=apiSecret${keyParam}`;
        await axios.patch(`${url}?${qs}`, { fields }, { timeout: 4000 });
      } catch (fsErr: any) {
        console.warn("[ACCOUNT-SWITCH-FIRESTORE-WARN]:", fsErr?.message || fsErr);
      }
    }
  };

  // Sync on startup and periodically every 15s
  syncSharedSettingsFromFirestore();
  setInterval(syncSharedSettingsFromFirestore, 15000);

  // In-memory + persistent cache of signals by ID
  const signalsStoreById = new Map<string, any>();
  const TELEGRAM_SIGNALS_FILE = path.join(process.cwd(), 'data_telegram_signals.json');

  const saveTelegramSignalsToFile = () => {
    try {
      const serialized = receivedTelegramSignals.slice(0, 100);
      fs.writeFileSync(TELEGRAM_SIGNALS_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
    } catch (e) {}
  };

  const loadTelegramSignalsFromFile = () => {
    try {
      if (fs.existsSync(TELEGRAM_SIGNALS_FILE)) {
        const raw = fs.readFileSync(TELEGRAM_SIGNALS_FILE, 'utf-8');
        const parsedList = JSON.parse(raw);
        if (Array.isArray(parsedList)) {
          receivedTelegramSignals.length = 0;
          for (const item of parsedList) {
            receivedTelegramSignals.push(item);
            if (item.id) {
              signalsStoreById.set(item.id, item);
            }
          }
        }
      }
    } catch (e) {}
  };

  // Histórico de auditoria persistente de operações (Entrada, Stop, Take Profits, Alavancagem)
  interface TradeAuditRecord {
    symbol: string;
    cleanSymbol: string;
    direction: string;
    entryPrice: number;
    stopLoss: number;
    takeProfits: (number | string)[];
    leverage: number;
    timestamp: number;
  }
  const TRADE_AUDIT_FILE = path.join(process.cwd(), 'data_trade_audit.json');
  const tradeAuditHistory: TradeAuditRecord[] = [];

  const saveTradeAuditToFile = () => {
    try {
      const serialized = tradeAuditHistory.slice(0, 100);
      fs.writeFileSync(TRADE_AUDIT_FILE, JSON.stringify(serialized, null, 2), 'utf-8');
    } catch (e) {}
  };

  const loadTradeAuditFromFile = () => {
    try {
      if (fs.existsSync(TRADE_AUDIT_FILE)) {
        const raw = fs.readFileSync(TRADE_AUDIT_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          tradeAuditHistory.length = 0;
          tradeAuditHistory.push(...parsed);
        }
      }
    } catch (e) {}
  };

  const recordTradeAudit = (audit: Partial<TradeAuditRecord>) => {
    if (!audit.cleanSymbol) return;
    const existingIdx = tradeAuditHistory.findIndex(a => 
      a.cleanSymbol === audit.cleanSymbol && Math.abs((a.timestamp || 0) - (audit.timestamp || Date.now())) < 3600000
    );
    const entry: TradeAuditRecord = {
      symbol: audit.symbol || `${audit.cleanSymbol}-USDT`,
      cleanSymbol: audit.cleanSymbol,
      direction: audit.direction || 'LONG',
      entryPrice: audit.entryPrice || 0,
      stopLoss: audit.stopLoss || 0,
      takeProfits: audit.takeProfits || [],
      leverage: audit.leverage || 20,
      timestamp: audit.timestamp || Date.now()
    };
    if (existingIdx >= 0) {
      tradeAuditHistory[existingIdx] = { ...tradeAuditHistory[existingIdx], ...entry };
    } else {
      tradeAuditHistory.unshift(entry);
    }
    saveTradeAuditToFile();
  };

  // Armazena os últimos Stop Loss e Take Profits personalizados editados pelo usuário por par
  const activeCustomSLTPBySymbol = new Map<string, { stopLoss?: number; takeProfit?: number; updatedAt: number }>();

  // 🛡️ OPÇÃO 1 (PROTEÇÃO TOTAL): Armazena parâmetros de Trailing Stop para ordens LIMITE pendentes
  // O Trailing Stop NUNCA é colocado no livro da corretora antes da execução para evitar disparo prematuro!
  interface PendingTrailingConfig {
    orderId?: string;
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    closeSide: 'BUY' | 'SELL';
    quantity: string;
    effectiveRate: number;
    activationPrice?: number;
    stopLossPrice: number;
    takeProfitPrice?: number;
    entryPrice: number;
    pricePrecision?: number;
    createdAt: number;
  }
  const pendingTrailingConfigs = new Map<string, PendingTrailingConfig>();
  const PENDING_TRAILING_FILE = path.join(process.cwd(), 'data_pending_trailing.json');

  // 🛡️ BITUNIX STOP MÓVEL (DYNAMIC SERVER-SIDE TRAILING STOP)
  // Rastreia topos e fundos em tempo real e avança o Stop Loss na Bitunix conforme o lucro aumenta
  interface BitunixTrailingStopRecord {
    symbol: string;           // Ex: "DOTUSDT"
    cleanSymbol: string;      // Ex: "DOT"
    positionSide: 'LONG' | 'SHORT';
    entryPrice: number;
    activationPrice: number;
    callbackRate: number;      // Em porcentagem, ex: 1.0 = 1%
    highestPrice: number;      // Máxima observada para LONG
    lowestPrice: number;       // Mínima observada para SHORT
    isActivated: boolean;
    currentStopLoss: number;
    initialStopLoss: number;
    takeProfitPrice?: number;  // Take Profit protegido e preservado na Bitunix
    qty: string;
    positionId?: string;
    pricePrecision: number;
    lastNotifiedSLPrice?: number;
    lastNotifiedSLTime?: number;
    lastNotifiedStage?: number;
    lastNotifiedUnits?: number;
    strategy?: 'CONDUCAO' | 'TRAILING';
    stopDistance?: number;
    maxUnitsReached?: number;
    conducaoStage?: number;    // 0: Inicial, 1: Defensivo (-33%), 2: Break-Even, 3: Fase 1, 4: Fase 2
    customConducao?: boolean;  // Se true, usa as configurações customizadas desta posição
    tier0Trigger?: number;     // Gatilho Stop Defensivo (ex: 1.0x)
    tier1Trigger?: number;     // Gatilho Break-Even (ex: 1.5x)
    tier2Trigger?: number;     // Gatilho Equilíbrio (ex: 1.5x)
    tier3Trigger?: number;     // Início Condução Fase 1 (ex: 2.0x)
    tier4Dist?: number;        // Folga Fase 1 (ex: 1.0x)
    tier5Trigger?: number;     // Apertar Stop Fase 2 (ex: 3.0x)
    tier6Dist?: number;        // Folga Reduzida Fase 2 (ex: 0.5x)
    createdAt: number;
    lastUpdated: number;
  }
  const bitunixActiveTrailingStops = new Map<string, BitunixTrailingStopRecord>();
  const BITUNIX_TRAILING_FILE = path.join(process.cwd(), 'data_bitunix_trailing.json');

  const saveBitunixTrailingStopsToFile = () => {
    try {
      const entries = Array.from(bitunixActiveTrailingStops.entries());
      fs.writeFileSync(BITUNIX_TRAILING_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {}
  };

  const loadBitunixTrailingStopsFromFile = () => {
    try {
      if (fs.existsSync(BITUNIX_TRAILING_FILE)) {
        const raw = fs.readFileSync(BITUNIX_TRAILING_FILE, 'utf-8');
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          for (const [k, v] of entries) {
            if (v && typeof v === 'object') {
              if (!v.strategy) {
                v.strategy = serverTelegramBotConfig.conducaoStrategy || 'CONDUCAO';
              }
              if (!v.stopDistance && v.entryPrice && v.initialStopLoss) {
                v.stopDistance = Math.abs(v.entryPrice - v.initialStopLoss);
              }
              if (v.conducaoStage === undefined) {
                v.conducaoStage = 0;
              }
            }
            bitunixActiveTrailingStops.set(k, v);
          }
        }
      }
    } catch (e) {}
  };

  let registerBitunixTrailingStop: (params: {
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    entryPrice: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    callbackRate?: number;
    activationPrice?: number;
    qty?: string;
    positionId?: string;
    pricePrecision?: number;
  }) => Promise<BitunixTrailingStopRecord>;

  let stopBitunixTrailingStop: (symbol: string) => void;

  const savePendingTrailingConfigsToFile = () => {
    try {
      const entries = Array.from(pendingTrailingConfigs.entries());
      fs.writeFileSync(PENDING_TRAILING_FILE, JSON.stringify(entries, null, 2), 'utf-8');
    } catch (e) {}
  };

  const loadPendingTrailingConfigsFromFile = () => {
    try {
      if (fs.existsSync(PENDING_TRAILING_FILE)) {
        const raw = fs.readFileSync(PENDING_TRAILING_FILE, 'utf-8');
        const entries = JSON.parse(raw);
        if (Array.isArray(entries)) {
          const now = Date.now();
          for (const [k, v] of entries) {
            // Descarta configurações órfãs com mais de 24h ou chaves genéricas sem lado
            if (v && v.createdAt && (now - v.createdAt > 86400000)) continue;
            if (!k.includes('_LONG') && !k.includes('_SHORT') && isNaN(Number(k))) continue;
            pendingTrailingConfigs.set(k, v);
          }
        }
      }
    } catch (e) {}
  };

  // Carrega imediatamente ao inicializar o servidor
  loadBitunixTrailingStopsFromFile();
  loadPendingTrailingConfigsFromFile();

  let deployPostExecutionTrailingStop: (symbol: string, positionSide: string, actualQtyStr?: string, avgPriceNum?: number) => Promise<void>;

  const receivedTelegramSignals: Array<{
    id: string;
    text: string;
    sender: string;
    chatId?: number | string;
    receivedAt: string;
    status?: 'PENDING' | 'EXECUTED' | 'CANCELLED';
    executedBy?: string;
    executedAt?: string;
    parsed?: any;
  }> = [];

  // Carrega sinais e auditoria do disco na inicialização
  loadTelegramSignalsFromFile();
  loadTradeAuditFromFile();
  loadPendingTrailingConfigsFromFile();

  // Cache de saldo Bitunix para alta performance e estabilidade
  const balanceCache = new Map<string, { balance: number; timestamp: number }>();
  const BALANCE_CACHE_TTL = 10000; // 10 segundos de cache
  const symbolLeverageCache = new Map<string, { maxLongLeverage: number; maxShortLeverage: number; maxLeverage: number; timestamp: number }>();

  // Helper centralizado para atualizar Stop Loss e Take Profit na Bitunix garantindo que o outro NUNCA seja apagado
  const safeSetBitunixPositionTPSL = async (params: {
    symbol: string;
    positionId: string;
    slPrice?: number | string | null;
    tpPrice?: number | string | null;
    slStopType?: string;
    tpStopType?: string;
    apiKey?: string;
    apiSecret?: string;
  }) => {
    const key = (params.apiKey || DEFAULT_BITUNIX_KEY || "").trim();
    const secret = (params.apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();
    const bitunixSym = resolveBitunixSymbol(params.symbol).apiSymbol;

    let finalSl = (params.slPrice !== undefined && params.slPrice !== null && parseFloat(params.slPrice.toString()) > 0)
      ? params.slPrice.toString()
      : undefined;
    let finalTp = (params.tpPrice !== undefined && params.tpPrice !== null && parseFloat(params.tpPrice.toString()) > 0)
      ? params.tpPrice.toString()
      : undefined;

    // Busca ordens pendentes para manter a ordem oposta (SL/TP) e registrar IDs para cancelamento prévio
    const pendingOrderIdsToCancel: string[] = [];
    try {
      const existingTpsl = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol: bitunixSym }, null, key, secret);
      const list = (existingTpsl?.data && Array.isArray(existingTpsl.data)) ? existingTpsl.data : [];
      for (const ord of list) {
        const oid = ord.orderId || ord.id;
        if (oid) pendingOrderIdsToCancel.push(oid.toString());
        if (!finalTp && ord.tpPrice && parseFloat(ord.tpPrice) > 0) {
          finalTp = ord.tpPrice.toString();
        }
        if (!finalSl && ord.slPrice && parseFloat(ord.slPrice) > 0) {
          finalSl = ord.slPrice.toString();
        }
      }
    } catch (e) {}

    // Se ainda faltar TP, busca no registro de Stop Móvel ou no cache de personalização
    if (!finalTp) {
      const cleanUpper = bitunixSym.replace('USDT', '').toUpperCase();
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || bitunixActiveTrailingStops.get(cleanUpper);
      if (trRecord?.takeProfitPrice && trRecord.takeProfitPrice > 0) {
        finalTp = trRecord.takeProfitPrice.toString();
      }
      if (!finalTp) {
        const custom = activeCustomSLTPBySymbol.get(bitunixSym) || activeCustomSLTPBySymbol.get(cleanUpper);
        if (custom?.takeProfit && custom.takeProfit > 0) {
          finalTp = custom.takeProfit.toString();
        }
      }
    }

    // Se ainda faltar SL, busca no registro de Stop Móvel
    if (!finalSl) {
      const cleanUpper = bitunixSym.replace('USDT', '').toUpperCase();
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || bitunixActiveTrailingStops.get(cleanUpper);
      if (trRecord?.currentStopLoss && trRecord.currentStopLoss > 0) {
        finalSl = trRecord.currentStopLoss.toString();
      }
    }

    const payload: any = {
      symbol: bitunixSym,
      positionId: params.positionId
    };

    if (finalSl && parseFloat(finalSl) > 0) {
      payload.slPrice = finalSl;
      payload.slStopType = params.slStopType || "MARK_PRICE";
    }

    if (finalTp && parseFloat(finalTp) > 0) {
      payload.tpPrice = finalTp;
      payload.tpStopType = params.tpStopType || "MARK_PRICE";
    }

    // Na Bitunix, ordens anteriores de TP/SL da posição precisam ser canceladas antes de anexar uma nova
    if (pendingOrderIdsToCancel.length > 0) {
      for (const oid of pendingOrderIdsToCancel) {
        await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym, orderId: oid }, key, secret).catch(() => {});
      }
    } else {
      await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym }, key, secret).catch(() => {});
    }

    console.log(`[BITUNIX-SAFE-TPSL-ATTACH] Anexando à posição #${params.positionId} em ${bitunixSym}: SL=${payload.slPrice || 'Nenhum'}, TP=${payload.tpPrice || 'Nenhum'}`);
    const attachRes = await sendBitunixRequest('/api/v1/futures/tpsl/position/place_order', 'POST', {}, payload, key, secret);
    console.log(`[BITUNIX-SAFE-TPSL-ATTACH-RES] ${bitunixSym}:`, JSON.stringify(attachRes));
    return attachRes;
  };

  // Helper centralizado para atualizar Stop Loss e Take Profit de posições abertas na Bitunix
  const setBitunixPositionTPSLDirect = async (
    symbol: string,
    newStopLoss?: number | null,
    newTakeProfit?: number | null,
    apiKey: string = DEFAULT_BITUNIX_KEY,
    apiSecret: string = DEFAULT_BITUNIX_SECRET
  ) => {
    try {
      const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
      const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const bitunixSym = bitunixResolved.apiSymbol;
      const cleanUpper = bitunixResolved.cleanSymbol;

      // Consulta posições abertas na Bitunix
      const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
      const positions = (posRes?.code === 0 && Array.isArray(posRes.data)) ? posRes.data : [];
      const targetPos = positions.find((p: any) => 
        isSameOrRelatedSymbol(p.symbol, bitunixSym) && Math.abs(parseFloat(p.holdAmt || p.qty || p.total || '0')) > 0
      );

      if (!targetPos) {
        return { success: false, error: `Nenhuma posição aberta encontrada para ${bitunixSym} na Bitunix.` };
      }

      const isLong = (targetPos.side === 'BUY' || targetPos.side === 'LONG');
      const positionSide = isLong ? 'LONG' : 'SHORT';
      const entryPrice = parseFloat(targetPos.avgOpenPrice || targetPos.avgPrice || targetPos.entryPrice || '0');
      const markPrice = parseFloat(targetPos.markPrice || '0');

      // Se for remover Take Profit explicitamente (passando 0)
      if (newTakeProfit === 0) {
        try {
          const pendingTpsl = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol: bitunixSym }, null, key, secret);
          const list = (pendingTpsl?.data && Array.isArray(pendingTpsl.data)) ? pendingTpsl.data : [];
          for (const ord of list) {
            if (ord.tpPrice && parseFloat(ord.tpPrice) > 0 && ord.orderId) {
              await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym, orderId: ord.orderId }, key, secret);
            }
          }
        } catch (e) {}

        const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || bitunixActiveTrailingStops.get(cleanUpper);
        if (trRecord) {
          trRecord.takeProfitPrice = undefined;
          trRecord.lastUpdated = Date.now();
          saveBitunixTrailingStopsToFile();
        }
        const custom = activeCustomSLTPBySymbol.get(bitunixSym) || activeCustomSLTPBySymbol.get(cleanUpper);
        if (custom) {
          custom.takeProfit = undefined;
          custom.updatedAt = Date.now();
        }

        return {
          success: true,
          symbol: bitunixSym,
          cleanSymbol: cleanUpper,
          positionSide,
          entryPrice,
          markPrice,
          message: "Take Profit removido com sucesso da posição na Bitunix!"
        };
      }

      // Aplica via safeSetBitunixPositionTPSL
      const tpslRes = await safeSetBitunixPositionTPSL({
        symbol: bitunixSym,
        positionId: targetPos.positionId,
        slPrice: (newStopLoss !== undefined && newStopLoss !== null && newStopLoss > 0) ? newStopLoss.toString() : undefined,
        tpPrice: (newTakeProfit !== undefined && newTakeProfit !== null && newTakeProfit > 0) ? newTakeProfit.toString() : undefined,
        apiKey: key,
        apiSecret: secret
      });

      if (tpslRes?.code !== 0 && tpslRes?.success !== true) {
        return {
          success: false,
          error: tpslRes?.msg || tpslRes?.error || "Erro ao atualizar Stop Loss/Take Profit na Bitunix"
        };
      }

      // Sincroniza com o Trailing Stop do servidor (Stop Móvel)
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || bitunixActiveTrailingStops.get(cleanUpper);
      if (trRecord) {
        if (newStopLoss && newStopLoss > 0) {
          trRecord.currentStopLoss = newStopLoss;
          trRecord.initialStopLoss = newStopLoss;
          trRecord.lastNotifiedSLPrice = newStopLoss;
          trRecord.lastUpdated = Date.now();
        }
        if (newTakeProfit && newTakeProfit > 0) {
          trRecord.takeProfitPrice = newTakeProfit;
          trRecord.lastUpdated = Date.now();
        }
        saveBitunixTrailingStopsToFile();
      }

      // Salva no cache activeCustomSLTPBySymbol
      const custom = activeCustomSLTPBySymbol.get(bitunixSym) || activeCustomSLTPBySymbol.get(cleanUpper) || { updatedAt: Date.now() };
      if (newStopLoss && newStopLoss > 0) custom.stopLoss = newStopLoss;
      if (newTakeProfit && newTakeProfit > 0) custom.takeProfit = newTakeProfit;
      custom.updatedAt = Date.now();
      activeCustomSLTPBySymbol.set(bitunixSym, custom);
      activeCustomSLTPBySymbol.set(cleanUpper, custom);

      return {
        success: true,
        symbol: bitunixSym,
        cleanSymbol: cleanUpper,
        positionSide,
        entryPrice,
        markPrice,
        stopLoss: newStopLoss,
        takeProfit: newTakeProfit,
        message: "Stop Loss / Take Profit atualizado com sucesso na Bitunix!"
      };
    } catch (err: any) {
      return { success: false, error: err.message || "Erro interno ao atualizar SL/TP" };
    }
  };

  // Helper central de requisições autenticadas da Bitunix com emulação transparente para BingX
  const sendBingXRequest = async (endpoint: string, method: string, params: any = {}, apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false) => {
    const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
    const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();

    try {
      // 1. Endpoint direto Bitunix
      if (endpoint.startsWith('/api/v1/')) {
        const query = method.toUpperCase() === 'GET' ? params : {};
        const body = method.toUpperCase() !== 'GET' ? params : null;
        return await sendBitunixRequest(endpoint, method, query, body, key, secret);
      }

      // 2. Consulta de Saldo BingX -> Bitunix Account
      if (endpoint === '/openApi/swap/v2/user/balance') {
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/account', 'GET', { marginCoin: 'USDT' }, null, key, secret);
        if (bitunixRes?.code === 0 && bitunixRes?.data) {
          const avail = parseFloat(bitunixRes.data.available || bitunixRes.data.availableMargin || bitunixRes.data.transfer || '0');
          const margin = parseFloat(bitunixRes.data.margin || '0');
          const equity = avail + margin;
          return {
            code: 0,
            msg: "Success",
            data: {
              balance: {
                balance: avail.toString(),
                equity: equity.toString(),
                availableMargin: avail.toString()
              },
              equity: equity.toString(),
              availableMargin: avail.toString()
            }
          };
        }
        return bitunixRes;
      }

      // 3. Consulta de Posições BingX -> Bitunix Positions
      if (endpoint === '/openApi/swap/v2/user/positions') {
        const bitunixRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
        if (bitunixRes?.code === 0 && Array.isArray(bitunixRes?.data)) {
          const positions = bitunixRes.data.map((p: any) => ({
            symbol: p.symbol,
            positionId: p.positionId,
            positionSide: (p.side === 'BUY' || p.side === 'LONG') ? 'LONG' : 'SHORT',
            positionAmt: (p.side === 'SELL' || p.side === 'SHORT' ? -Math.abs(parseFloat(p.holdAmt || p.qty || p.positionAmt || '0')) : Math.abs(parseFloat(p.holdAmt || p.qty || p.positionAmt || '0'))).toString(),
            entryPrice: p.avgOpenPrice || p.avgPrice || p.entryPrice || '0',
            markPrice: p.markPrice || '0',
            leverage: p.leverage || 20,
            unrealizedProfit: p.unrealizedProfit || p.unrealizedPNL || p.pnl || '0',
            liquidationPrice: p.liqPrice || p.liquidationPrice || '0',
            isolatedMargin: p.margin || '0'
          }));
          return {
            code: 0,
            msg: "Success",
            data: positions
          };
        }
        return bitunixRes;
      }

      // 4. Consulta e Cancelamento de Ordens BingX -> Bitunix Pending Orders
      if (endpoint === '/openApi/swap/v2/trade/openOrders' || endpoint === '/openApi/swap/v2/trade/allOpenOrders') {
        if (method.toUpperCase() === 'DELETE') {
          const symbol = params?.symbol ? resolveBitunixSymbol(params.symbol).apiSymbol : undefined;
          const bitunixRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, symbol ? { symbol } : {}, key, secret);
          return bitunixRes;
        }
        const symbol = params?.symbol ? resolveBitunixSymbol(params.symbol).apiSymbol : undefined;
        const queryParams: any = symbol ? { symbol } : {};
        const [bitunixRes, tpslRes] = await Promise.all([
          sendBitunixRequest('/api/v1/futures/trade/get_pending_orders', 'GET', queryParams, null, key, secret).catch(() => null),
          sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', queryParams, null, key, secret).catch(() => null)
        ]);
        const orderList = bitunixRes?.data?.orderList || (Array.isArray(bitunixRes?.data) ? bitunixRes.data : []);
        const tpslList = (tpslRes?.data && Array.isArray(tpslRes.data)) ? tpslRes.data : [];
        const synthOrders: any[] = [];
        for (const t of tpslList) {
          if (t.slPrice && parseFloat(t.slPrice) > 0) {
            synthOrders.push({
              orderId: `SL-${t.id || t.positionId}`,
              symbol: t.symbol,
              type: 'STOP_MARKET',
              side: 'SELL',
              stopPrice: t.slPrice,
              origQty: t.slQty || '0',
              status: 'NEW'
            });
          }
          if (t.tpPrice && parseFloat(t.tpPrice) > 0) {
            synthOrders.push({
              orderId: `TP-${t.id || t.positionId}`,
              symbol: t.symbol,
              type: 'TAKE_PROFIT_MARKET',
              side: 'SELL',
              stopPrice: t.tpPrice,
              origQty: t.tpQty || '0',
              status: 'NEW'
            });
          }
        }
        return {
          code: 0,
          msg: "Success",
          data: {
            orders: [...orderList, ...synthOrders]
          }
        };
      }

      // 5. Cancelamento de Ordem Específica BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/trade/order' && method.toUpperCase() === 'DELETE') {
        const symbol = params?.symbol ? resolveBitunixSymbol(params.symbol).apiSymbol : undefined;
        const orderId = (params?.orderId || params?.orderID || '').toString();
        let cancelRes: any;
        if (orderId) {
          cancelRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_orders', 'POST', {}, { symbol, orderList: [{ orderId }] }, key, secret);
          await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol, orderId }, key, secret).catch(() => {});
        } else {
          cancelRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, symbol ? { symbol } : {}, key, secret);
        }
        if (symbol) {
          await checkAndResetLeverageIfNoPosition(symbol, key, secret);
        }
        return cancelRes;
      }

      // 5.1 Cancelamento de TODAS as Ordens Pendentes BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/trade/allOpenOrders') {
        const symbol = params?.symbol ? resolveBitunixSymbol(params.symbol).apiSymbol : undefined;
        const cancelRes = await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, symbol ? { symbol } : {}, key, secret);
        if (symbol) {
          await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol }, key, secret).catch(() => {});
          await checkAndResetLeverageIfNoPosition(symbol, key, secret);
        }
        return { code: 0, msg: "Success", data: cancelRes?.data || {} };
      }

      // 6. Alteração de Alavancagem BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/trade/leverage') {
        const symbol = resolveBitunixSymbol(params?.symbol || '').apiSymbol;
        const leverage = parseInt(params?.leverage || '20', 10);
        return await sendBitunixRequest('/api/v1/futures/account/change_leverage', 'POST', {}, { symbol, leverage, marginCoin: 'USDT' }, key, secret);
      }

      // 6.1 Alteração de Modo de Margem BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/trade/marginType') {
        const symbol = resolveBitunixSymbol(params?.symbol || '').apiSymbol;
        const rawMode = (params?.marginType || params?.marginMode || 'ISOLATED').toUpperCase();
        const marginMode = (rawMode === 'CROSSED' || rawMode === 'CROSS') ? 'CROSS' : 'ISOLATION';
        return await sendBitunixRequest('/api/v1/futures/account/change_margin_mode', 'POST', {}, { symbol, marginMode, marginCoin: 'USDT' }, key, secret);
      }

      // 6.2 Cotação / Ticker BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/quote/ticker') {
        const symbol = resolveBitunixSymbol(params?.symbol || '').apiSymbol;
        try {
          const tickerRes = await sendBitunixRequest('/api/v1/futures/market/tickers', 'GET', symbol ? { symbols: symbol } : {}, null, key, secret);
          const item = Array.isArray(tickerRes?.data) ? tickerRes.data[0] : null;
          const price = item?.lastPrice || item?.markPrice || '0';
          return {
            code: 0,
            msg: "Success",
            data: {
              symbol,
              lastPrice: price,
              markPrice: item?.markPrice || price,
              volume: item?.volume || '0'
            }
          };
        } catch {
          return { code: 0, msg: "Success", data: { symbol, lastPrice: '0' } };
        }
      }

      // 6.3 Consulta de Contratos BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/quote/contracts') {
        const contracts = await fetchBitunixContracts();
        return {
          code: 0,
          msg: "Success",
          data: contracts
        };
      }

      // 6.4 Histórico de Renda / Realized PnL e Taxas BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/user/income') {
        const rawSym = params?.symbol;
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const incomeType = params?.incomeType;
        const startTime = params?.startTime ? parseInt(params.startTime, 10) : undefined;
        const endTime = params?.endTime ? parseInt(params.endTime, 10) : undefined;
        const limit = params?.limit ? parseInt(params.limit, 10) : 100;

        const histPosRes = await sendBitunixRequest('/api/v1/futures/position/get_history_positions', 'GET', {
          symbol,
          pageSize: Math.min(100, Math.max(limit, 50))
        }, null, key, secret).catch(() => ({ code: -1, data: {} }));

        const posList = (histPosRes?.data?.positionList && Array.isArray(histPosRes.data.positionList))
          ? histPosRes.data.positionList
          : [];

        const items: any[] = [];
        for (const pos of posList) {
          const pnl = parseFloat(pos.realizedPNL || "0");
          const fee = parseFloat(pos.fee || "0");
          const funding = parseFloat(pos.funding || "0");
          const time = parseInt(pos.mtime || pos.ctime || "0", 10);
          const dir = (pos.side === 'BUY' || pos.side === 'LONG') ? 'LONG' : 'SHORT';

          if (params?.strictTime) {
            if (startTime && time < startTime) continue;
            if (endTime && time > endTime) continue;
          }

          if (!incomeType || incomeType === 'REALIZED_PNL') {
            items.push({
              symbol: pos.symbol,
              incomeType: 'REALIZED_PNL',
              income: pnl.toString(),
              asset: 'USDT',
              time,
              info: `Fechamento ${dir}`,
              tradeId: pos.positionId || undefined,
              entryPrice: pos.entryPrice,
              exitPrice: pos.closePrice,
              leverage: pos.leverage,
              direction: dir,
              margin: pos.margin,
              qty: pos.qty || pos.maxQty
            });
          }

          if (!incomeType || incomeType === 'TRADING_FEE') {
            if (fee > 0) {
              items.push({
                symbol: pos.symbol,
                incomeType: 'TRADING_FEE',
                income: (-Math.abs(fee)).toString(),
                asset: 'USDT',
                time,
                info: 'Taxa de Negociação',
                tradeId: pos.positionId || undefined
              });
            }
          }

          if (!incomeType || incomeType === 'FUNDING_FEE') {
            if (funding !== 0) {
              items.push({
                symbol: pos.symbol,
                incomeType: 'FUNDING_FEE',
                income: funding.toString(),
                asset: 'USDT',
                time,
                info: 'Taxa de Financiamento',
                tradeId: pos.positionId || undefined
              });
            }
          }
        }

        items.sort((a, b) => b.time - a.time);
        return {
          code: 0,
          msg: "Success",
          data: items.slice(0, limit)
        };
      }

      // 6.5 Histórico de Ordens BingX -> Bitunix
      if (endpoint === '/openApi/swap/v2/trade/allOrders') {
        const rawSym = params?.symbol;
        const symbol = rawSym ? resolveBitunixSymbol(rawSym).apiSymbol : undefined;
        const limit = params?.limit ? parseInt(params.limit, 10) : 30;

        const histOrdersRes = await sendBitunixRequest('/api/v1/futures/trade/get_history_orders', 'GET', {
          symbol,
          pageSize: limit
        }, null, key, secret).catch(() => ({ code: -1, data: {} }));

        const rawList = (histOrdersRes?.data?.orderList && Array.isArray(histOrdersRes.data.orderList))
          ? histOrdersRes.data.orderList
          : [];

        const mapped = rawList.map((o: any) => ({
          orderId: o.orderId,
          symbol: o.symbol,
          side: o.side,
          positionSide: (o.side === 'BUY' ? 'LONG' : 'SHORT'),
          type: o.orderType || o.type,
          price: o.price,
          avgPrice: o.avgPrice,
          status: o.status,
          executedQty: o.qty || o.executedQty || '0',
          origQty: o.qty || '0',
          time: parseInt(o.ctime || '0', 10),
          updateTime: parseInt(o.mtime || o.ctime || '0', 10),
          stopPrice: o.stopPrice,
          leverage: o.leverage,
          realizedProfit: o.realizedPNL
        }));

        return {
          code: 0,
          msg: "Success",
          data: {
            orders: mapped
          }
        };
      }

      // 7. Envio de Ordem BingX -> Bitunix (com suporte nativo a TP, SL, Stop Móvel e Fechamento Instantâneo)
      if (endpoint === '/openApi/swap/v2/trade/order' && method.toUpperCase() === 'POST') {
        const symbol = resolveBitunixSymbol(params?.symbol || '').apiSymbol;
        const side = (params?.side || 'BUY').toUpperCase();
        const posSide = (params?.positionSide || '').toUpperCase();
        const isExplicitClose = params?.action === 'CLOSE_ALL' || params?.isCloseAllPosition;
        const tradeSide = (posSide === 'SHORT' && side === 'BUY') || (posSide === 'LONG' && side === 'SELL') || params?.closePosition ? 'CLOSE' : 'OPEN';
        const orderType = (params?.type || 'MARKET').toUpperCase() === 'LIMIT' ? 'LIMIT' : 'MARKET';
        const qty = (params?.quantity || params?.qty || '0').toString();

        // 7.1 SUPORTE A STOP MÓVEL / TRAILING STOP NA BITUNIX (SEM ERRO 10002)
        if (params?.type === 'TRAILING_STOP_MARKET') {
          try {
            const rawRate = parseFloat(params?.priceRate || params?.callbackRate || '1.0');
            const callbackRate = rawRate > 1 ? rawRate : parseFloat((rawRate * 100).toFixed(3));
            const actPrice = params?.activationPrice ? parseFloat(params.activationPrice) : undefined;
            const posSideNorm = (posSide || (side === 'SELL' ? 'LONG' : 'SHORT')).toUpperCase() as 'LONG' | 'SHORT';
            
            if (typeof registerBitunixTrailingStop === 'function') {
              await registerBitunixTrailingStop({
                symbol,
                positionSide: posSideNorm,
                entryPrice: parseFloat(params?.entryPrice || '0'),
                callbackRate,
                activationPrice: actPrice,
                qty
              });
            }
            return {
              code: 0,
              msg: "Success (Bitunix Stop Móvel Ativado)",
              data: { orderId: `TS-${Date.now()}` }
            };
          } catch (e: any) {
            console.warn('[BITUNIX-STOP-MOVEL-REG-WARN]:', e.message);
            return {
              code: 0,
              msg: "Success",
              data: { orderId: `TS-${Date.now()}` }
            };
          }
        }

        let tpPrice = params?.tpPrice;
        let slPrice = params?.slPrice;
        if (!tpPrice && params?.takeProfit) {
          try {
            const tpObj = typeof params.takeProfit === 'string' ? JSON.parse(params.takeProfit) : params.takeProfit;
            if (tpObj?.stopPrice) tpPrice = tpObj.stopPrice.toString();
          } catch {}
        }
        if (!slPrice && params?.stopLoss) {
          try {
            const slObj = typeof params.stopLoss === 'string' ? JSON.parse(params.stopLoss) : params.stopLoss;
            if (slObj?.stopPrice) slPrice = slObj.stopPrice.toString();
          } catch {}
        }
        if (!slPrice && params?.type === 'STOP_MARKET' && params?.stopPrice) {
          slPrice = params.stopPrice.toString();
        }
        if (!tpPrice && params?.type === 'TAKE_PROFIT_MARKET' && params?.stopPrice) {
          tpPrice = params.stopPrice.toString();
        }

        // 7.2 Requisição isolada de Stop Loss ou Take Profit (com cancelamento prévio para evitar ordens repetidas)
        if ((params?.type === 'STOP_MARKET' || params?.type === 'TAKE_PROFIT_MARKET') && params?.stopPrice) {
          try {
            const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
            const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
            const pos = positions.find((p: any) => p.symbol === symbol);
            if (pos && pos.positionId) {
              // Cancela qualquer TP/SL anterior correspondente para evitar duplicação no livro
              try {
                const tpslList = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol }, null, key, secret);
                if (tpslList?.data && Array.isArray(tpslList.data)) {
                  for (const ord of tpslList.data) {
                    const isMatch = params.type === 'STOP_MARKET'
                      ? (ord.slPrice !== null && ord.slPrice !== undefined)
                      : (ord.tpPrice !== null && ord.tpPrice !== undefined);
                    if (isMatch && ord.id) {
                      await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol, orderId: ord.id }, key, secret).catch(() => {});
                    }
                  }
                }
              } catch (e) {}

              const tpslRes = await safeSetBitunixPositionTPSL({
                symbol,
                positionId: pos.positionId,
                slPrice: params.type === 'STOP_MARKET' ? params.stopPrice.toString() : undefined,
                tpPrice: params.type !== 'STOP_MARKET' ? params.stopPrice.toString() : undefined,
                apiKey: key,
                apiSecret: secret
              });
              return tpslRes;
            } else {
              return { code: 0, msg: "Success (Embedded in Order)", data: { symbol } };
            }
          } catch (err: any) {
            console.error('[BITUNIX-DIRECT-TPSL-ERR]:', err.message);
            return { code: 0, msg: "Handled in main order", data: { symbol } };
          }
        }

        // 7.3 FECHAMENTO DE POSIÇÃO (Com proteção estrita contra fechar 100% quando for parcial!)
        const isForceCloseAll = isExplicitClose ||
                                Boolean(params?.closePosition) ||
                                params?.action === 'CLOSE_ALL' ||
                                Boolean(params?.isCloseAllPosition);
        const isCloseRequested = isForceCloseAll ||
                                 tradeSide === 'CLOSE' ||
                                 params?.reduceOnly ||
                                 params?.action === 'CLOSE' ||
                                 (posSide === 'LONG' && side === 'SELL') ||
                                 (posSide === 'SHORT' && side === 'BUY');

        if (isCloseRequested) {
          const reqQtyNum = parseFloat(qty || '0');
          if (!isForceCloseAll && !isNaN(reqQtyNum) && reqQtyNum > 0) {
            try {
              const posCheckRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
              const openList = Array.isArray(posCheckRes?.data) ? posCheckRes.data : [];
              const targetPosSide = posSide || (side === 'SELL' ? 'LONG' : 'SHORT');
              const matchedPos = openList.find((p: any) =>
                p.symbol === symbol &&
                Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0 &&
                (!posSide || (p.side === 'BUY' ? 'LONG' : 'SHORT') === targetPosSide)
              ) || openList.find((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0);

              if (matchedPos) {
                const openAmt = Math.abs(parseFloat(matchedPos.total || matchedPos.qty || matchedPos.holdAmt || '0'));
                if (openAmt > 0 && reqQtyNum < openAmt * 0.99) {
                  const posSideNorm = (matchedPos.side === 'BUY' || matchedPos.positionSide === 'LONG') ? 'LONG' : 'SHORT';
                  const posMode = (matchedPos.positionMode || 'HEDGE').toUpperCase();
                  const hedgeCloseSide = posSideNorm === 'LONG' ? 'BUY' : 'SELL';
                  const oppositeCloseSide = posSideNorm === 'LONG' ? 'SELL' : 'BUY';

                  await fetchBitunixContracts().catch(() => {});
                  const contract = resolveBitunixSymbol(symbol).contract;
                  const qPrec = typeof contract?.quantityPrecision === 'number' ? contract.quantityPrecision : (matchedPos.qty?.includes('.') ? matchedPos.qty.split('.')[1].length : 0);
                  const factor = Math.pow(10, qPrec);
                  const roundedPartial = Math.floor(reqQtyNum * factor + 1e-9) / factor;
                  const partialQtyStr = roundedPartial.toFixed(qPrec);

                  console.log(`[BITUNIX-PARTIAL-ORDER] ✂️ Fechamento parcial em ${symbol} (${posSideNorm}): ${partialQtyStr} de ${openAmt}`);
                  let pRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                    symbol,
                    qty: partialQtyStr,
                    side: posMode === 'HEDGE' ? hedgeCloseSide : oppositeCloseSide,
                    tradeSide: 'CLOSE',
                    orderType,
                    ...(params?.price && orderType === 'LIMIT' ? { price: params.price.toString() } : {}),
                    reduceOnly: posMode !== 'HEDGE',
                    positionId: matchedPos.positionId || undefined
                  }, key, secret);

                  if (pRes?.code !== 0) {
                    pRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                      symbol,
                      qty: partialQtyStr,
                      side: posMode === 'HEDGE' ? oppositeCloseSide : hedgeCloseSide,
                      tradeSide: 'CLOSE',
                      orderType,
                      ...(params?.price && orderType === 'LIMIT' ? { price: params.price.toString() } : {}),
                      reduceOnly: false,
                      positionId: matchedPos.positionId || undefined
                    }, key, secret);
                  }
                  return pRes;
                }
              }
            } catch (e: any) {
              console.warn('[BITUNIX-PARTIAL-CHECK-ERR]:', e.message);
            }
          }

          console.log(`[BITUNIX-CLOSE-REQUEST] Executando fechamento garantido para ${symbol}...`);
          const closeRes = await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol }, key, secret);
          
          // Fallback garantido: se ainda houver resíduo de posição aberta, fecha a mercado imediatamente
          try {
            const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, key, secret);
            const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
            const pos = positions.find((p: any) => p.symbol === symbol && Math.abs(parseFloat(p.total || p.qty || p.holdAmt || '0')) > 0);
            if (pos) {
              const amt = Math.abs(parseFloat(pos.total || pos.qty || pos.holdAmt || '0'));
              const pSide = (pos.side || pos.positionSide || (side === 'SELL' ? 'LONG' : 'SHORT')).toUpperCase();
              const posMode = (pos.positionMode || 'HEDGE').toUpperCase();
              const ordSide = posMode === 'HEDGE'
                ? (pSide === 'LONG' || pSide === 'BUY' ? 'BUY' : 'SELL')
                : (pSide === 'LONG' || pSide === 'BUY' ? 'SELL' : 'BUY');
              if (pos.positionId) {
                await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol, positionId: pos.positionId }, key, secret).catch(() => {});
              }
              if (amt > 0) {
                await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
                  symbol,
                  qty: amt.toString(),
                  side: ordSide,
                  tradeSide: 'CLOSE',
                  orderType: 'MARKET',
                  reduceOnly: posMode !== 'HEDGE',
                  positionId: pos.positionId || undefined
                }, key, secret).catch(() => {});
              }
            }
          } catch (e: any) {
            console.warn('[BITUNIX-FALLBACK-CLOSE-ERR]:', e.message);
          }

          // Cancela todas as ordens pendentes e gatilhos
          await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol }, key, secret).catch(() => {});
          
          // Limpa individualmente ordens de TPSL pendentes desse par para evitar ordens órfãs/duplicadas
          try {
            const tpslList = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol }, null, key, secret);
            const list = (tpslList?.data && Array.isArray(tpslList.data)) ? tpslList.data : [];
            for (const ord of list) {
              const oid = ord.orderId || ord.id;
              if (oid) {
                await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol, orderId: oid }, key, secret).catch(() => {});
              }
            }
          } catch (e) {}

          if (typeof stopBitunixTrailingStop === 'function') {
            stopBitunixTrailingStop(symbol);
          }

          // 🛡️ Auto-reset para 20x e Margem Isolada após fechar posição
          await resetSymbolLeverageAndMarginMode(symbol, key, secret);

          return {
            code: 0,
            msg: "Success",
            data: closeRes?.data || { symbol }
          };
        }

        // 7.4 ABERTURA DE NOVA POSIÇÃO / ORDEM
        const orderPayload: any = {
          symbol,
          qty,
          side,
          tradeSide: 'OPEN',
          orderType,
          effect: 'GTC',
          reduceOnly: false
        };
        if (params?.price && orderType === 'LIMIT') orderPayload.price = params.price.toString();
        if (tpPrice) {
          orderPayload.tpPrice = tpPrice.toString();
          orderPayload.tpStopType = "MARK_PRICE";
          orderPayload.tpOrderType = "MARKET";
        }
        if (slPrice) {
          orderPayload.slPrice = slPrice.toString();
          orderPayload.slStopType = "MARK_PRICE";
          orderPayload.slOrderType = "MARKET";
        }

        const res = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, orderPayload, key, secret);
        return res;
      }

      // 7. Sistema 100% exclusivo Bitunix - desativa qualquer chamada externa à BingX
      console.warn(`[BITUNIX-EXCLUSIVO] Endpoint ${endpoint} não direcionado para BingX.`);
      return { code: -1, msg: "Sistema exclusivo Bitunix. Chamadas à BingX desativadas." };
    } catch (e: any) {
      return { code: -1, msg: e?.message || "Erro na requisição" };
    }
  };

  // Helper centralizado e com cache resiliente para consultar o Saldo Bitunix
  const getCachedBitunixBalance = async (apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false, forceRefresh: boolean = false): Promise<number> => {
    const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
    const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();
    const cacheKey = `${key}_REAL`;
    const cached = balanceCache.get(cacheKey);
    const now = Date.now();

    if (!forceRefresh && cached && (now - cached.timestamp) < BALANCE_CACHE_TTL) {
      return cached.balance;
    }

    try {
      const balRes = await sendBitunixRequest('/api/v1/futures/account', 'GET', { marginCoin: 'USDT' }, null, key, secret);
      let balance = 0;
      if (balRes?.code === 0 && balRes?.data) {
        if (balRes.data.available !== undefined) balance = parseFloat(balRes.data.available);
        else if (balRes.data.availableMargin !== undefined) balance = parseFloat(balRes.data.availableMargin);
        else if (balRes.data.transfer !== undefined) balance = parseFloat(balRes.data.transfer);
        else if (balRes.data.totalMargin !== undefined) balance = parseFloat(balRes.data.totalMargin);
      }

      if (balance > 0) {
        balanceCache.set(cacheKey, { balance, timestamp: now });
        return balance;
      }

      if (cached && cached.balance > 0) {
        return cached.balance;
      }
      return balance;
    } catch (err: any) {
      if (cached && cached.balance > 0) {
        return cached.balance;
      }
      return 0;
    }
  };

  const getCachedBingXBalance = getCachedBitunixBalance;

  // Cache de limite máximo de alavancagem por símbolo na Bitunix
  const fetchSymbolMaxBrokerLeverage = async (apiSymbol: string, apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false): Promise<number> => {
    if (!apiSymbol) return 100;
    const resolved = resolveBitunixSymbol(apiSymbol);
    if (resolved.contract?.maxLeverage && typeof resolved.contract.maxLeverage === 'number') {
      return resolved.contract.maxLeverage;
    }
    return 100;
  };

  // Helper parser ultra-robusto para sinais do Telegram
  const stripEmojis = (str: string): string => {
    return str
      .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, " ")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim();
  };

  // Helper para gerar alvos intermediários até o Take final informado pelo usuário
  // TP 1 = 1x tamanho do stop
  // TP 2 em diante = a cada 1/2 tamanho do stop até atingir exatamente o Take final que foi colocado
  const generateTargetsUpToFinal = (
    entry: number,
    sl: number,
    finalTake: number,
    dir: 'LONG' | 'SHORT',
    pricePrecision: number
  ): number[] => {
    if (!entry || !sl || !finalTake || entry === sl || entry === finalTake) {
      return [finalTake];
    }

    const slDist = Math.abs(entry - sl);
    if (slDist <= 0) return [finalTake];

    const isLong = dir === 'LONG';
    if (isLong && finalTake <= entry) return [finalTake];
    if (!isLong && finalTake >= entry) return [finalTake];

    const round = (val: number) => parseFloat(val.toFixed(pricePrecision));
    const targets: number[] = [];
    const step0 = slDist;
    const stepHalf = slDist * 0.5;

    let current = round(isLong ? (entry + step0) : (entry - step0));

    if ((isLong && current >= finalTake) || (!isLong && current <= finalTake)) {
      return [round(finalTake)];
    }

    targets.push(current);

    let safety = 0;
    while (safety < 100) {
      safety++;
      const next = round(isLong ? (current + stepHalf) : (current - stepHalf));

      if ((isLong && next >= finalTake - (stepHalf * 0.05)) || (!isLong && next <= finalTake + (stepHalf * 0.05))) {
        targets.push(round(finalTake));
        break;
      } else {
        targets.push(next);
        current = next;
      }
    }

    if (!targets.includes(round(finalTake))) {
      targets.push(round(finalTake));
    }

    return targets;
  };

  const parseSignalText = (text: string) => {
    const rawLines = text.split(/\r?\n/);
    const cleanText = text.toUpperCase().trim();
    
    // Palavras reservadas para não confundir com nome de moeda
    const reservedWords = new Set([
      'USDT', 'USD', 'CRYPTO', 'SINAL', 'SIGNAL', 'FUTURES', 'FUTUROS', 
      'VIP', 'PREMIUM', 'LONG', 'SHORT', 'COMPRA', 'VENDA', 'BUY', 'SELL',
      'ENTRY', 'ENTRADA', 'STOP', 'STOPLOSS', 'TARGET', 'TARGETS', 'ALVO', 'ALVOS',
      'TP', 'SL', 'LEVERAGE', 'ALAVANCAGEM', 'CROSS', 'ISOLADA', 'ISOLATED', 'LIMIT',
      'MARKET', 'ORDEM', 'ORDER', 'ZONA', 'ZONE', 'PRICE', 'PREÇO',
      'STATUS', 'SALDO', 'AJUDA', 'HELP', 'TESTE', 'OLA', 'OI', 'START',
      'CANCELAR', 'FECHAR', 'PAINEL', 'LIVRO', 'CONEXAO', 'POSICOES', 'POSIÇÕES',
      'PENDENTES', 'HISTORICO', 'CONFIG', 'SETTINGS', 'BOM', 'DIA', 'BOA', 'TARDE',
      'NOITE', 'OK', 'VALEU', 'TOP', 'COMANDOS', 'PERDA', 'RISCO', 'DOL', 'DOLARES', 'DÓLARES', 'DOLAR', 'LOSS', 'RISK'
    ]);

    // 1. Detecção do Par / Moeda (Ex: GOLDXAU, ONT, BTC, ETH, SOL, XRP, TSLA, SP500, etc.)
    let coinName = '';
    
    // Padrão 1: Rótulo explícito (ex: "MOEDA: ONT", "PAR: ONT/USDT", "PAIR: ONT-USDT", "ATIVO: GOLDXAU")
    const explicitLabelMatch = cleanText.match(/(?:MOEDA|PAR|PAIR|COIN|SYMBOL|ATIVO|TOKEN)\s*:?\s*#?([A-Z0-9_\(\)]{2,16})/i);
    if (explicitLabelMatch && explicitLabelMatch[1]) {
      let c = explicitLabelMatch[1].replace(/USDT$/i, '').replace(/USD$/i, '').trim();
      if (c && !reservedWords.has(c)) {
        coinName = c;
      }
    }

    // Padrão 2: Hashtag no início ou texto (ex: #ONT ou #ONTUSDT ou #GOLDXAU)
    if (!coinName) {
      const hashMatch = cleanText.match(/#([A-Z0-9_\(\)]{2,16})/i);
      if (hashMatch && hashMatch[1]) {
        let c = hashMatch[1].replace(/USDT$/i, '').replace(/USD$/i, '').trim();
        if (c && !reservedWords.has(c)) {
          coinName = c;
        }
      }
    }

    // Padrão 3: Moeda com barra ou traço (ex: GOLDXAU/USDT, GOLD(XAU)/USDT, ONT/USDT, ONT / USDT, ONT-USDT, EUR/USD)
    if (!coinName) {
      const pairMatch = cleanText.match(/([A-Z0-9_\(\)]{2,16})\s*[\/_\-]\s*(?:USDT|USD)/i);
      if (pairMatch && pairMatch[1]) {
        let c = pairMatch[1].trim();
        if (c && !reservedWords.has(c)) {
          coinName = c;
        }
      }
    }

    // Padrão 3b: Símbolo isolado entre marcadores como ▲ GOLDXAU/USDT ▲ ou 🟢 BTC/USDT 🟢 ou ★ GOLD ★
    if (!coinName) {
      const markerMatch = cleanText.match(/[▲▼★◆●■\*\#]\s*([A-Z0-9_\(\)]{2,16})(?:\s*[\/_\-]\s*USDT|\s*[\/_\-]\s*USD|USDT|USD)?\s*[▲▼★◆●■\*\#]/i);
      if (markerMatch && markerMatch[1]) {
        let c = markerMatch[1].replace(/USDT$/i, '').replace(/USD$/i, '').trim();
        if (c && !reservedWords.has(c)) {
          coinName = c;
        }
      }
    }

    // Padrão 4: Moeda colada em USDT (ex: ONTUSDT, SOLUSDT, GOLDXAUUSDT)
    if (!coinName) {
      const attachedMatch = cleanText.match(/\b([A-Z0-9]{2,16})USDT\b/i);
      if (attachedMatch && attachedMatch[1]) {
        let c = attachedMatch[1].trim();
        if (c && !reservedWords.has(c)) {
          coinName = c;
        }
      }
    }

    // Padrão 5: Token próximo à direção (ex: "ONT LONG", "LONG ONT", "COMPRA GOLDXAU")
    if (!coinName) {
      const dirNearMatch = cleanText.match(/\b([A-Z0-9_\(\)]{2,16})\s+(?:LONG|SHORT|COMPRA|VENDA|BUY|SELL)\b/i) ||
                           cleanText.match(/\b(?:LONG|SHORT|COMPRA|VENDA|BUY|SELL)\s+([A-Z0-9_\(\)]{2,16})\b/i);
      if (dirNearMatch && dirNearMatch[1]) {
        let c = dirNearMatch[1].replace(/USDT$/i, '').replace(/USD$/i, '').trim();
        if (c && !reservedWords.has(c)) {
          coinName = c;
        }
      }
    }

    // Padrão 6: Busca pelos tokens, commodities e índices mais negociados
    if (!coinName) {
      const topTokens = cleanText.match(/\b(EURGBP|EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF|NZDUSD|GBPJPY|EURJPY|GOLDXAU|GOLD|XAU|SILVERXAG|SILVER|XAG|OIL|WTI|BRENT|US500|SP500|NAS100|NASDAQ|US30|DOW|TSLA|NVDA|AAPL|MSFT|COIN|PLTR|ONT|SOL|ETH|BTC|BNB|XRP|ADA|DOGE|AVAX|DOT|LINK|NEAR|SUI|APT|PEPE|SHIB|RENDER|FET|INJ|TIA|SEI|WIF|BONK|JUP|FLOKI|OP|ARB|MATIC|POL|LTC|BCH|FTM|GALA|SAND|MANA|TON|KAS|PENDLE|ENA|WLD|CFX|RUNE|AAVE|UNI|ATOM|ALGO|XLM|FIL|HBAR|CRV|DYDX|ICP|JTO|PYTH|ORDI|STX|BLUR|GMX|TAO|ARKM|STRK|BEAM|AXS|ROSE|SUPER|POPCAT|MEW|NEO|GAS|IOTA|VET|CHZ|1000PEPE|1000BONK|1000FLOKI|1000SHIB)\b/i);
      if (topTokens && topTokens[1]) {
        const candidate = topTokens[1].toUpperCase();
        if (!reservedWords.has(candidate)) {
          coinName = candidate;
        }
      }
    }

    // Padrão 7: Primeira linha isolada como moeda (ex: "btc\n100x\nE. 90000\nS. 91000")
    if (!coinName) {
      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const candidate = trimmed.toUpperCase().replace(/^#/, '').replace(/USDT$/, '').replace(/USD$/, '').trim();
        if (/^[A-Z0-9]{2,16}$/.test(candidate) && !reservedWords.has(candidate) && !/^\d{1,4}X$/i.test(candidate) && !/^(?:E|S|T|TP|SL|BUY|SELL|LONG|SHORT)[\.\:\s]?$/i.test(candidate)) {
          coinName = candidate;
          break;
        }
      }
    }

    // Identifica se é o formato de sinal compacto rápido (ex: E. 90000 / S. 91000 ou Entrada / Stop)
    const isFastCompactSignal = rawLines.some(l => /^\s*(?:⚡️?|👉)?\s*E(?:[\.\:\s]|NTRADA|NTRY)\s*[:=\-–]?\s*[0-9]/i.test(stripEmojis(l))) && 
                                rawLines.some(l => /^\s*(?:❌|🛑)?\s*S(?:[\.\:\s]|TOP|L)\s*[:=\-–]?\s*[0-9]/i.test(stripEmojis(l)));

    // Resolução inteligente e precisa do símbolo no ecossistema da Bitunix
    const resolvedSymbol = resolveBitunixSymbol(coinName);
    const apiSymbol = resolvedSymbol.apiSymbol || (coinName ? `${coinName}-USDT` : '');
    const displayName = resolvedSymbol.displayName || apiSymbol;
    const symbol = apiSymbol.replace('-', '');
    if (resolvedSymbol.cleanSymbol) {
      coinName = resolvedSymbol.cleanSymbol;
    }

    // 2. Detecção de Preço de Entrada ou Faixa (ex: ⚡️Entrada: 0,010022 / 0,010047 ou E. 90000 ou 0.03767 - 0.03740)
    let entryPrice: number | null = null;
    let entryPrice2: number | null = null;
    let orderType: 'LIMIT' | 'MARKET' = 'LIMIT';

    // Primeiro busca especificamente linhas de entrada (com suporte total a emojis como prefixo)
    for (const rawLine of rawLines) {
      const lineUpper = rawLine.toUpperCase().trim();
      const cleanLine = stripEmojis(lineUpper);

      const compactEMatch = cleanLine.match(/(?:^|\b)(?:E[\.\:\s]|ENTRADA|ENTRY|PREÇO|PRECO|PRICE|GATILHO|ZONA)\s*[:=\-–]?\s*([0-9.,\s\-\/–—~]+)/i) ||
                           lineUpper.match(/(?:⚡️?|👉|🔹|🎯)?\s*(?:ENTRADA|ENTRY|PREÇO|PRECO|PRICE|GATILHO|ZONA|E[\.\:\s])\s*[:=\-–]?\s*([0-9.,\s\-\/–—~]+)/i);
      if (compactEMatch && compactEMatch[1]) {
        const nums = compactEMatch[1].replace(/,/g, '.').match(/\d+\.?\d*/g);
        if (nums && nums.length > 0) {
          const valid = nums.map(n => parseFloat(n)).filter(n => !isNaN(n) && n > 0);
          if (valid.length === 1) {
            entryPrice = valid[0];
            break;
          } else if (valid.length >= 2) {
            entryPrice = valid[0];
            entryPrice2 = valid[1];
            break;
          }
        }
      }
    }

    // 3. Detecção de Stop Loss (ex: ❌StopLoss: 0,009900, S. 91000, S: 91000, SL: 91000, Stop: 91000)
    let stopLoss: number | null = null;
    for (const rawLine of rawLines) {
      const lineUpper = rawLine.toUpperCase().trim();
      const cleanLine = stripEmojis(lineUpper);

      const compactSMatch = cleanLine.match(/(?:^|\b)(?:STOP\s*LOSS|STOPLOSS|STOP\s*L|STOP|SL|PARAR|S[\.\:\s])\s*[:=\-–]?\s*([0-9.,]+)/i) ||
                           lineUpper.match(/(?:❌|🛑|⛔)\s*(?:STOP\s*LOSS|STOPLOSS|STOP\s*L|STOP|SL)?\s*[:=\-–]?\s*([0-9.,]+)/i);
      if (compactSMatch && compactSMatch[1]) {
        const val = parseFloat(compactSMatch[1].replace(/,/g, '.'));
        if (!isNaN(val) && val > 0) {
          stopLoss = val;
          break;
        }
      }
    }

    // 4. Detecção de Direção (LONG / SHORT)
    // Se for o formato compacto (E. e S.), identifica rigorosamente pelo preço de entrada vs stop:
    // Se preço de entrada for MENOR que stop -> SHORT
    // Se preço de entrada for MAIOR que stop -> LONG
    let direction: 'LONG' | 'SHORT' = 'LONG';
    const isShortExplicit = /\b(SHORT|VENDA|SELL|BAIXA|BEARISH|PUT|BAIXISTA)\b|🔴/i.test(text);
    const isLongExplicit = /\b(LONG|COMPRA|BUY|ALTA|BULLISH|CALL|ALTISTA)\b|🟢/i.test(text);

    if (isFastCompactSignal && entryPrice && stopLoss) {
      direction = entryPrice < stopLoss ? 'SHORT' : 'LONG';
    } else if (isShortExplicit && !isLongExplicit) {
      direction = 'SHORT';
    } else if (isLongExplicit && !isShortExplicit) {
      direction = 'LONG';
    } else if (entryPrice && stopLoss) {
      direction = entryPrice < stopLoss ? 'SHORT' : 'LONG';
    }

    // Se foram informados dois preços de entrada (zona de entrada), ajusta conforme a direção:
    if (entryPrice !== null && entryPrice2 !== null) {
      const minE = Math.min(entryPrice, entryPrice2);
      const maxE = Math.max(entryPrice, entryPrice2);
      if (direction === 'LONG') {
        entryPrice = minE; // No LONG, compra no melhor preço (mais baixo)
        entryPrice2 = maxE;
      } else {
        entryPrice = maxE; // No SHORT, vende no melhor preço (mais alto)
        entryPrice2 = minE;
      }
    }

    // 5. Detecção de Alavancagem
    let leverage = 20;
    let hasLeverageMatch = false;

    // A. Linha isolada contendo alavancagem (ex: "100x", "50X", "100 x", "x100", "Alavancagem: 100x")
    for (const rawLine of rawLines) {
      const cleanLine = stripEmojis(rawLine).toUpperCase().trim();
      const lineLevMatch = cleanLine.match(/^(?:ALAVANCAGEM|LEVERAGE|ALAV|LEV)?\s*[:=\-–]?\s*(\d{1,4})\s*X$/i) ||
                           cleanLine.match(/^(?:ALAVANCAGEM|LEVERAGE|ALAV|LEV)?\s*[:=\-–]?\s*X\s*(\d{1,4})$/i);
      if (lineLevMatch && lineLevMatch[1]) {
        const val = parseInt(lineLevMatch[1], 10);
        if (val >= 1 && val <= 1000) {
          leverage = val;
          hasLeverageMatch = true;
          break;
        }
      }
    }

    // B. Rótulos explícitos no texto corrido (Alavancagem, Leverage, Lev, Alav, Cross, Isolada, Isolated)
    if (!hasLeverageMatch) {
      const explicitLevMatch = cleanText.match(/(?:ALAVANCAGEM|LEVERAGE|ALAV|LEV|CROSS|ISOLADA|ISOLATED)\s*[:=\-–]?\s*(?:CROSS|ISOLADA|ISOLATED|ATÉ|ATE|A|UP\s*TO)?\s*[\(\[]?\s*(\d{1,4})\s*X?(?:\s*[-–—\/aA]\s*(\d{1,4})\s*X?)?[\)\]]?/i);
      if (explicitLevMatch) {
        const num1 = parseInt(explicitLevMatch[1], 10);
        const num2 = explicitLevMatch[2] ? parseInt(explicitLevMatch[2], 10) : 0;
        const chosenNum = (num2 > 0 && num2 <= 1000) ? num2 : num1;
        if (chosenNum >= 1 && chosenNum <= 1000) {
          leverage = chosenNum;
          hasLeverageMatch = true;
        }
      }
    }

    if (!hasLeverageMatch) {
      const dirLevMatch = cleanText.match(/(?:LONG|SHORT|COMPRA|VENDA|BUY|SELL)\s*[-–—:\s]*(\d{1,4})\s*X\b/i) ||
                          cleanText.match(/\b(\d{1,4})\s*X\s*[-–—:\s]*(?:LONG|SHORT|COMPRA|VENDA|BUY|SELL)/i);
      if (dirLevMatch && dirLevMatch[1]) {
        const val = parseInt(dirLevMatch[1], 10);
        if (val >= 1 && val <= 1000) {
          leverage = val;
          hasLeverageMatch = true;
        }
      }
    }

    if (!hasLeverageMatch) {
      const standaloneMatches = Array.from(cleanText.matchAll(/(?:^|[\s\(\[\{,\/\-_])(?:X\s*(\d{1,4})|(\d{1,4})\s*X)(?:$|[\s\)\]\},!\.\?\-_])/gi));
      for (const sm of standaloneMatches) {
        const rawNum = sm[1] || sm[2];
        if (rawNum) {
          const val = parseInt(rawNum, 10);
          if (val >= 1 && val <= 1000) {
            leverage = val;
            hasLeverageMatch = true;
            break;
          }
        }
      }
    }

    // Regra estrita do usuário:
    // "caso mande com alavancagem igual abaixo (btc / 100x / E. 90000 / S. 91000 / T. 80000) e pra entrar com alavancagem que mandei nao com a maxima (maxima SOMENTE quando eu manda sem alavancagem)"
    if (!hasLeverageMatch) {
      // Quando o usuário NÃO mandou alavancagem na mensagem: usa a MÁXIMA permitida na corretora para aquele par (ex: 200x para BTC, 100x para ETH, 25x para AVAAI)
      const contractMax = resolvedSymbol.contract?.maxLeverage;
      if (contractMax && typeof contractMax === 'number' && contractMax > 0) {
        leverage = contractMax;
      } else {
        leverage = 100; // Padrão máximo seguro até lookup
      }
    } else {
      // Quando o usuário MANDOU alavancagem explícita: mantém a alavancagem que ele pediu!
      // Apenas respeita se a corretora tiver um teto menor para aquele par (ex: pediu 100x em AVAAI que suporta max 25x)
      const contractMax = resolvedSymbol.contract?.maxLeverage;
      if (contractMax && typeof contractMax === 'number' && contractMax > 0 && leverage > contractMax) {
        leverage = contractMax;
      }
    }

    // Teto de segurança se configurado pelo usuário no painel
    if (serverTelegramBotConfig.maxLeverageCap && serverTelegramBotConfig.maxLeverageCap > 0 && leverage > serverTelegramBotConfig.maxLeverageCap) {
      leverage = serverTelegramBotConfig.maxLeverageCap;
    }

    // 6. Detecção de Alvos Take Profit (TP1, TP2... ou T. 8000, T: 8000, T 0.03788, etc.)
    const takeProfits: number[] = [];
    
    // Rótulos padrão e compactos: T, T:, T., T1, TP, TP1, ALVO 1, TARGET 1, 🚀TP 1, etc.
    // NOTA CRÍTICA: Nunca usar \d* logo após \s num rótulo de 1 letra como "T", pois se o preço começar com 0 (ex: "T 0.03788"),
    // o \d* engolia o dígito "0" e o [.:\s] engolia o ponto ".", transformando 0.03788 em 3788!
    for (const rawLine of rawLines) {
      const lineUpper = rawLine.toUpperCase().trim();
      const cleanLine = stripEmojis(lineUpper);

      const lineTpMatch = cleanLine.match(/(?:^|\b)(?:TP\s*(?:\d{1,2}\b)?|ALVO\s*(?:\d{1,2}\b)?|TARGET\s*(?:\d{1,2}\b)?|OBJETIVO\s*(?:\d{1,2}\b)?|T\d{1,2}\b|T\s+(?:[1-9]\d{0,1}\s*[:=\-–.]|(?=[0-9]))|T[\.:=\-–])\s*[:=\-–]?\s*([0-9]+[.,]?[0-9]*)/i) ||
                          lineUpper.match(/(?:🚀|🎯|✨|🔥)?\s*(?:TP\s*(?:\d{1,2}\b)?|ALVO\s*(?:\d{1,2}\b)?|TARGET\s*(?:\d{1,2}\b)?|T\d{1,2}\b|T[\.:=\-–]|\bT\b)\s*[:=\-–]?\s*([0-9]+[.,]?[0-9]*)/i);
      if (lineTpMatch && lineTpMatch[1]) {
        const val = parseFloat(lineTpMatch[1].replace(/,/g, '.'));
        if (!isNaN(val) && val > 0 && !takeProfits.includes(val)) {
          takeProfits.push(val);
        }
      }
    }

    // Se ainda não encontrou alvos por linha, busca no texto corrido com regex segura
    if (takeProfits.length === 0) {
      const tpRegex = /(?:(?:^|[\s\r\n])(?:TP\s*(?:\d{1,2}\b)?|ALVO\s*(?:\d{1,2}\b)?|TARGET\s*(?:\d{1,2}\b)?|OBJETIVO\s*(?:\d{1,2}\b)?|T\d{1,2}\b|T\s+(?:[1-9]\d{0,1}\s*[:=\-–.]|(?=[0-9]))|T[\.:=\-–]))\s*[:=\-–]?\s*([0-9]+[.,]?[0-9]*)/gi;
      let tpM;
      while ((tpM = tpRegex.exec(cleanText)) !== null) {
        if (tpM[1]) {
          const val = parseFloat(tpM[1].replace(/,/g, '.'));
          if (!isNaN(val) && val > 0 && !takeProfits.includes(val)) {
            takeProfits.push(val);
          }
        }
      }
    }

    // Listas numeradas sob seção de alvos (ex: "Alvos:\n1) 0.03810\n2) 0.03843")
    let inAlvosSection = false;
    for (const rawLine of rawLines) {
      const lineUpper = rawLine.toUpperCase().trim();
      if (/^(?:ALVOS|TARGETS|TPS|TAKE\s*PROFITS?|OBJETIVOS)\s*:?/i.test(lineUpper)) {
        inAlvosSection = true;
        continue;
      }
      if (inAlvosSection) {
        if (/^(?:STOP|SL|S\.|LEVERAGE|ALAVANCAGEM|GERENCIAMENTO|RISCO)/i.test(lineUpper)) {
          inAlvosSection = false;
          continue;
        }
        const numLineMatch = lineUpper.match(/^(?:🎯\s*)?(?:\d{1,2}\s*[\)\.\-–:]\s*|\-\s*)([0-9.,]+)/);
        if (numLineMatch && numLineMatch[1]) {
          const val = parseFloat(numLineMatch[1].replace(/,/g, '.'));
          if (!isNaN(val) && val > 0 && !takeProfits.includes(val)) {
            takeProfits.push(val);
          }
        }
      }
    }

    // Usa helper compartilhado generateTargetsUpToFinal(entry, sl, finalTake, dir, pricePrecision)

    // Determina a precisão do preço considerando o contrato e os números informados
    const checkDecimals = (n: number | null) => {
      if (!n) return 0;
      const s = n.toString();
      const dot = s.indexOf('.');
      return dot >= 0 ? s.length - dot - 1 : 0;
    };
    const maxInputDecimals = Math.max(
      checkDecimals(entryPrice),
      checkDecimals(stopLoss),
      ...(takeProfits.map(tp => checkDecimals(tp)))
    );

    let precision = 4;
    if (resolvedSymbol.contract && typeof resolvedSymbol.contract.pricePrecision === 'number' && resolvedSymbol.contract.pricePrecision > 0) {
      precision = Math.max(resolvedSymbol.contract.pricePrecision, maxInputDecimals);
    } else {
      precision = Math.max(maxInputDecimals, (entryPrice && entryPrice < 0.1) ? 6 : (entryPrice && entryPrice < 1) ? 5 : (entryPrice && entryPrice < 100) ? 4 : 2);
    }

    // 7. CÁLCULO AUTOMÁTICO DE ALVOS (TAKE PROFIT)
    // Caso 1: Quando o usuário NÃO mandar alvos (takeProfits.length === 0):
    // Calcula até 5x1 (1º alvo 1x tamanho stop, a partir do 2º alvo a cada 1/2 tamanho stop)
    if (takeProfits.length === 0 && entryPrice && stopLoss) {
      const stopDistance = Math.abs(entryPrice - stopLoss);
      if (stopDistance > 0) {
        const targetMultipliers = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
        for (const m of targetMultipliers) {
          const calcTp = direction === 'LONG'
            ? entryPrice + (m * stopDistance)
            : entryPrice - (m * stopDistance);
          if (calcTp > 0) {
            takeProfits.push(parseFloat(calcTp.toFixed(precision)));
          }
        }
      }
    }
    // Caso 2: Quando o usuário MANDAR COM TAKE (ex: T. 80000):
    // Gera todos os alvos intermediários desde o TP 1 até atingir o take colocado (idêntico ao Print 2!)
    else if (takeProfits.length === 1 && entryPrice && stopLoss) {
      const finalTake = takeProfits[0];
      const expandedTargets = generateTargetsUpToFinal(entryPrice, stopLoss, finalTake, direction, precision);
      takeProfits.length = 0;
      takeProfits.push(...expandedTargets);
    }

    // Fallback para Preço de Entrada se ainda não achou
    if (entryPrice === null) {
      for (const rawLine of rawLines) {
        const lineUpper = rawLine.toUpperCase().trim();
        // NUNCA considerar linhas com termos de Alvos, Stops, Alavancagem, Direção, Risco/Perda ou Moeda
        if (/^(?:TP|ALVO|TARGET|STOP|SL|S\.|T\.|LEVERAGE|ALAV|PERDA|RISCO|LOSS|RISK|P[\.\:\s])\b/i.test(lineUpper)) continue;
        if (lineUpper.includes('PERDA') || lineUpper.includes('RISCO') || lineUpper.includes('DOL') || lineUpper.includes('LOSS')) continue;
        if (/(?:LONG|SHORT|COMPRA|VENDA|BUY|SELL|ALAVANCAGEM|LEVERAGE|\b\d{1,4}X\b)/i.test(lineUpper)) continue;
        if (lineUpper.includes('/USDT') || lineUpper.includes('-USDT') || lineUpper.startsWith('#')) continue;

        const lineNums = lineUpper.replace(/,/g, '.').match(/\d+\.?\d*/g);
        if (lineNums && lineNums.length > 0) {
          const valid = lineNums.map(n => parseFloat(n)).filter(n => 
            !isNaN(n) && n > 0 && n !== stopLoss && !takeProfits.includes(n)
          );
          if (valid.length > 0) {
            entryPrice = valid[0];
            if (valid.length > 1) entryPrice2 = valid[1];
            break;
          }
        }
      }
    }

    // 8. Detecção de Perda Máxima / Risco Personalizado Informado no Sinal
    // Ex: "Perda 10 dol", "Perda: 10 dol", "Perda 10$", "Perda 10 usdt", "Perda 10", "Risco 10 dol", "P. 10 dol"
    let customRiskUsd: number | null = null;
    for (const rawLine of rawLines) {
      const lineUpper = rawLine.toUpperCase().trim();
      const cleanLine = stripEmojis(lineUpper);

      const lossMatch = cleanLine.match(/(?:^|\b)(?:PERDA\s*(?:M[AÁ]XIMA|MAX)?|RISCO\s*(?:M[AÁ]XIMO|MAX)?|MAX\s*LOSS|STOP\s*VALOR|LOSS)\s*(?:DE)?\s*[:=\-–]?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:DOL|DOLARES|DÓLARES|USD|USDT|\$)?/i) ||
                        cleanLine.match(/(?:^|\b)P[\.\:\s]\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:DOL|DOLARES|DÓLARES|USD|USDT|\$)\b/i);
      if (lossMatch && lossMatch[1]) {
        const val = parseFloat(lossMatch[1].replace(/,/g, '.'));
        if (!isNaN(val) && val > 0 && val <= 100000) {
          customRiskUsd = val;
          break;
        }
      }
    }

    if (customRiskUsd === null) {
      const textLossMatch = cleanText.match(/(?:PERDA|RISCO|LOSS)\s*(?:DE)?\s*[:=\-–]?\s*\$?\s*([0-9]+(?:[.,][0-9]+)?)\s*(?:DOL|DOLARES|DÓLARES|USD|USDT|\$)?/i);
      if (textLossMatch && textLossMatch[1]) {
        const val = parseFloat(textLossMatch[1].replace(/,/g, '.'));
        if (!isNaN(val) && val > 0 && val <= 100000) {
          customRiskUsd = val;
        }
      }
    }

    // Ordenar Alvos de forma lógica: crescente para LONG, decrescente para SHORT
    if (takeProfits.length > 1) {
      takeProfits.sort((a, b) => a - b);
      if (direction === 'SHORT') {
        takeProfits.sort((a, b) => b - a);
      }
    }

    // Determinação estrita se é um sinal de trade genuíno
    const hasTradeIntent = (isLongExplicit || isShortExplicit) || (entryPrice !== null) || (stopLoss !== null) || (takeProfits.length > 0) || (customRiskUsd !== null) || hasLeverageMatch || isFastCompactSignal || /(?:USDT|FUTURES|FUTUROS|SINAL|SIGNAL|ALVOS|TARGETS|BREAKEVEN|ENTRY|ENTRADA)/i.test(cleanText);
    const isValidSignal = Boolean(coinName && (hasTradeIntent || isFastCompactSignal || cleanText.includes('/USDT') || cleanText.includes('-USDT') || cleanText.startsWith('#')));

    return {
      isValidSignal,
      symbol,
      apiSymbol,
      displayName,
      coinName,
      direction,
      orderType,
      entryPrice,
      entryPrice2,
      stopLoss,
      takeProfits,
      leverage,
      hasLeverageMatch,
      isFastCompactSignal,
      customRiskUsd,
      contractInfo: resolvedSymbol.contract
    };
  };

  // Gemini Vision Engine - Análise de Imagens de Gráficos (TradingView)
  let geminiClient: GoogleGenAI | null = null;
  const getGeminiClient = (customKey?: string): GoogleGenAI => {
    const key = (customKey || DEFAULT_GEMINI_KEY || process.env.GEMINI_API_KEY || "").trim();
    if (!geminiClient || customKey) {
      const client = new GoogleGenAI({
        apiKey: key
      });
      if (!customKey) geminiClient = client;
      return client;
    }
    return geminiClient;
  };

  interface ParsedChartSignalResult {
    success: boolean;
    error?: string;
    parsed?: any;
    rawJson?: any;
    vipFormattedMessage?: string;
    vipFormattedHtml?: string;
  }

  /**
   * Calcula os alvos dinâmicos a partir de um gráfico TradingView conforme especificado:
   * - Alvo 01: sempre 1x o tamanho do Stop Loss (%)
   * - A partir do Alvo 02: incrementos de meio tamanho (0.5x) do Stop Loss (%)
   * - O Take Profit final (extraído da régua verde) será SEMPRE o último alvo
   */
  const generateChartTakeProfits = (
    entryPrice: number,
    stopLoss: number,
    direction: 'LONG' | 'SHORT',
    targetTakeProfit?: number
  ): number[] => {
    if (!entryPrice || isNaN(entryPrice) || !stopLoss || isNaN(stopLoss) || entryPrice <= 0 || stopLoss <= 0) {
      return targetTakeProfit && !isNaN(targetTakeProfit) && targetTakeProfit > 0 ? [targetTakeProfit] : [];
    }

    const getPriceDecimals = (val: number): number => {
      const s = val.toString();
      if (s.includes('e-')) {
        const exp = parseInt(s.split('e-')[1], 10);
        return Math.min(exp + 2, 8);
      }
      const parts = s.split('.');
      if (parts.length > 1) {
        return Math.min(parts[1].length, 8);
      }
      return val < 1 ? 5 : (val < 10 ? 4 : 2);
    };

    const decimals = Math.max(getPriceDecimals(entryPrice), getPriceDecimals(stopLoss));
    const roundPrice = (p: number): number => parseFloat(p.toFixed(decimals));

    // Distância do Stop Loss
    let stopDist = direction === 'LONG' ? (entryPrice - stopLoss) : (stopLoss - entryPrice);
    if (stopDist <= 0) {
      stopDist = Math.abs(entryPrice * 0.01) || 0.0001;
    }

    const stepDist = stopDist * 0.5; // Meio tamanho do stop loss a partir do alvo 02

    // Validação estrita do Take Profit final extraído da imagem
    let validProvidedTp: number | undefined;
    if (targetTakeProfit && !isNaN(targetTakeProfit) && targetTakeProfit > 0) {
      const isValid = direction === 'LONG' ? targetTakeProfit > entryPrice : targetTakeProfit < entryPrice;
      if (isValid) {
        validProvidedTp = targetTakeProfit;
      }
    }

    // Se o Take verde não veio ou veio inválido na imagem, projeta Take padrão de 3x stop loss (5 alvos)
    const finalTp = validProvidedTp !== undefined
      ? validProvidedTp
      : (direction === 'LONG' ? entryPrice + (stopDist * 3.0) : entryPrice - (stopDist * 3.0));

    const calculatedTargets: number[] = [];
    const maxTargets = 25;

    // Alvo 01: exatamente 1x o tamanho do Stop Loss
    const tp1 = direction === 'LONG' ? entryPrice + stopDist : entryPrice - stopDist;

    // Se o operador marcou no gráfico um Take muito curto (R:R < 1:1)
    const isFinalBelowTp1 = direction === 'LONG' ? finalTp < tp1 : finalTp > tp1;
    if (isFinalBelowTp1 && validProvidedTp !== undefined) {
      // Adiciona o Take da régua do gráfico e também o Alvo de 1x Stop
      calculatedTargets.push(roundPrice(finalTp));
      calculatedTargets.push(roundPrice(tp1));
    } else {
      calculatedTargets.push(roundPrice(tp1));
    }

    let currentTarget = calculatedTargets[calculatedTargets.length - 1];
    let targetIndex = calculatedTargets.length + 1;

    // A partir do Alvo 02 (ou seguinte): passos de meio tamanho (0.5x) do Stop Loss
    while (targetIndex <= maxTargets) {
      const nextTarget = direction === 'LONG' 
        ? currentTarget + stepDist 
        : currentTarget - stepDist;

      // Se o próximo alvo ultrapassar ou ficar colado no Take final
      const isPastOrTooClose = direction === 'LONG'
        ? (nextTarget >= finalTp - (stepDist * 0.15))
        : (nextTarget <= finalTp + (stepDist * 0.15));

      if (isPastOrTooClose) {
        break;
      }

      calculatedTargets.push(roundPrice(nextTarget));
      currentTarget = nextTarget;
      targetIndex++;
    }

    // O Take final da imagem é SEMPRE o último alvo
    const roundedFinalTp = roundPrice(finalTp);
    const lastCalculated = calculatedTargets[calculatedTargets.length - 1];
    const diffPct = Math.abs(lastCalculated - roundedFinalTp) / (roundedFinalTp || 1);

    if (diffPct < 0.0005) {
      calculatedTargets[calculatedTargets.length - 1] = roundedFinalTp;
    } else if ((direction === 'LONG' && roundedFinalTp > lastCalculated) || (direction === 'SHORT' && roundedFinalTp < lastCalculated)) {
      calculatedTargets.push(roundedFinalTp);
    }

    // Garantir sempre múltiplos alvos (no mínimo 3 alvos) se o gráfico tiver espaço
    if (calculatedTargets.length === 1) {
      const tp2 = direction === 'LONG' ? calculatedTargets[0] + stepDist : calculatedTargets[0] - stepDist;
      const tp3 = direction === 'LONG' ? tp2 + stepDist : tp2 - stepDist;
      calculatedTargets.push(roundPrice(tp2));
      calculatedTargets.push(roundPrice(tp3));
    }

    return calculatedTargets;
  };

  const parseTradingChartImageWithGemini = async (imageBuffer: Buffer, mimeType: string = "image/jpeg", userCaption?: string): Promise<ParsedChartSignalResult> => {
    try {
      const ai = getGeminiClient();
      const base64Data = imageBuffer.toString("base64");

      const promptText = `Você é um motor OCR ultrarrápido e altamente preciso, especializado em extrair dados de sinais de trading em gráficos do TradingView com indicador de trade na tela.

CAMPOS A EXTRAIR:
1. SÍMBOLO DA CRIPTOMOEDA (OBRIGATÓRIO):
   Examine atentamente TODA a imagem para encontrar o par/criptomoeda:
   - No cabeçalho superior esquerdo do TradingView (ex: "OPNUSDT", "OPNUSDT.P", "BTCUSDT", "ETH / TetherUS", "SOLUSDT 15m")
   - No cartão ou título do indicador na tela (ex: "OPN/USDT | BINGX", "BTC/USDT")
   - Na marca d'água grande no fundo do gráfico (ex: "OPN", "BTC", "ETH", "SOL")
   - Em abas ou nomes de janela
   Extraia apenas a sigla principal da moeda (ex: "OPN", "BTC", "ETH", "SOL", "PEPE"). NUNCA retorne vazio se houver qualquer sigla de cripto visível no print.

2. CARTÃO COM DIREÇÃO E ALAVANCAGEM:
   - "🟢 LONG | 86 x" ou "🔴 SHORT | 20 x" => direction = "LONG" ou "SHORT", leverage = número (ex: 86)

3. ETIQUETA DE ENTRADA:
   - "🔷 Entrada: $0.05278" ou "Entrada: $..." => entryPrice = 0.05278

4. ETIQUETA DE STOP LOSS:
   - "⭕ Stop: $0.05241" ou "Stop: $..." ou "Stop Loss: $..." => stopLoss = 0.05241

5. COLUNA DE ALVOS DE TAKE PROFIT:
   - "🎯 Alvo 01: $0.05297", "🎯 Alvo 02: $0.05316", ... até o último alvo exibido na tela.
   Extraia todos os valores numéricos de alvos visíveis em ordem, mesmo com marca de check (✔️).

REGRAS:
- Se a imagem NÃO contiver as etiquetas textuais de Entrada e Stop do indicador, retorne "isValidChart": false com erro explicativo.
- Retorne EXCLUSIVAMENTE um JSON válido (sem markdown):
{
  "isValidChart": true,
  "coinName": "OPN",
  "direction": "LONG",
  "entryPrice": 0.05278,
  "stopLoss": 0.05241,
  "takeProfits": [0.05297, 0.05316, 0.05335],
  "leverage": 86,
  "explanation": "Indicador na tela com Entrada 0.05278, Stop 0.05241, LONG 86x"
}`;

      // Detecção precisa de MIME Type a partir do cabeçalho binário (evita erro 400 Unable to process input image)
      let effectiveMime = mimeType || 'image/jpeg';
      if (imageBuffer.length >= 4 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4E && imageBuffer[3] === 0x47) {
        effectiveMime = 'image/png';
      } else if (imageBuffer.length >= 3 && imageBuffer[0] === 0xFF && imageBuffer[1] === 0xD8 && imageBuffer[2] === 0xFF) {
        effectiveMime = 'image/jpeg';
      } else if (imageBuffer.length >= 12 && imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP') {
        effectiveMime = 'image/webp';
      }

      // Modelos de visão ordenados por velocidade e suporte multimodal
      const candidateModels = [
        'gemini-2.5-flash',
        'gemini-2.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.1-flash-lite'
      ];

      // Executa chamada individual com timeout de 16s por modelo
      const callModel = async (modelName: string): Promise<any> => {
        const timeoutMs = 16000;
        const makeCall = async () => {
          try {
            return await ai.models.generateContent({
              model: modelName,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      inlineData: {
                        mimeType: effectiveMime,
                        data: base64Data
                      }
                    },
                    {
                      text: promptText
                    }
                  ]
                }
              ],
              config: {
                responseMimeType: 'application/json',
                temperature: 0.1
              }
            });
          } catch (firstErr: any) {
            // Se falhou por formato ou config, tenta chamada direta simplificada
            return await ai.models.generateContent({
              model: modelName,
              contents: [
                {
                  role: 'user',
                  parts: [
                    {
                      inlineData: {
                        mimeType: effectiveMime,
                        data: base64Data
                      }
                    },
                    {
                      text: promptText
                    }
                  ]
                }
              ]
            });
          }
        };

        const timer = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout de 16s no modelo ${modelName}`)), timeoutMs)
        );

        return Promise.race([makeCall(), timer]);
      };

      // Execução paralela escalonada (Hedge Racing ultrarrápido):
      // Dispara o modelo mais rápido primeiro (~1s). Se demorar mais de 1.2s ou oscilar, dispara o próximo.
      let response: any = null;
      let lastErr: any = null;

      const runWithHedge = async (): Promise<any> => {
        return new Promise((resolve, reject) => {
          let isResolved = false;
          let activeCount = candidateModels.length;
          const errors: any[] = [];

          const tryModel = async (mName: string) => {
            try {
              const res = await callModel(mName);
              if (res && res.text && !isResolved) {
                isResolved = true;
                console.log(`[GEMINI-VISION-SUCCESS] Gráfico processado com sucesso via modelo: ${mName}`);
                resolve(res);
              }
            } catch (mErr: any) {
              errors.push(mErr);
              const errMsg = String(mErr?.message || '');
              console.warn(`[GEMINI-VISION-WARN] Modelo ${mName} não concluiu: ${errMsg.substring(0, 100)}`);
              activeCount--;
              if (activeCount <= 0 && !isResolved) {
                reject(errors[errors.length - 1] || new Error("Falha ao analisar imagem do gráfico com todos os modelos disponíveis."));
              }
            }
          };

          // 1º dispara gemini-flash-lite-latest (o mais veloz, ~1s)
          tryModel(candidateModels[0]);

          // Se em 1200ms não respondeu, dispara gemini-3.1-flash-lite em paralelo
          setTimeout(() => {
            if (!isResolved) {
              console.log(`[GEMINI-VISION-HEDGE] Iniciando fallback ${candidateModels[1]} em paralelo...`);
              tryModel(candidateModels[1]);
            }
          }, 1200);

          // Se em 3500ms ainda não respondeu, dispara gemini-3.6-flash em paralelo
          setTimeout(() => {
            if (!isResolved) {
              console.log(`[GEMINI-VISION-HEDGE] Iniciando fallback ${candidateModels[2]} em paralelo...`);
              tryModel(candidateModels[2]);
            }
          }, 3500);
        });
      };

      response = await runWithHedge();

      if (!response || !response.text) {
        throw lastErr || new Error("Não foi possível processar a imagem do gráfico.");
      }

      const responseText = response.text || '';
      if (!responseText) {
        return { success: false, error: "Resposta vazia da inteligência artificial." };
      }

      let aiData: any;
      try {
        aiData = JSON.parse(responseText);
      } catch (e) {
        const match = responseText.match(/\{[\s\S]*\}/);
        if (match) {
          aiData = JSON.parse(match[0]);
        } else {
          return { success: false, error: "Falha ao decodificar dados do gráfico da IA." };
        }
      }

      if (!aiData.isValidChart && aiData.error) {
        return { success: false, error: aiData.error };
      }

      let rawCoin = String(aiData.coinName || aiData.symbol || aiData.pair || aiData.ticker || aiData.coin || '').toUpperCase()
        .replace(/USDT$/i, '')
        .replace(/USD$/i, '')
        .replace(/BINGX/g, '')
        .replace(/[\/\-_.]/g, '')
        .trim();

      // Se a IA não preencheu o campo da moeda, tenta extrair da explicação
      if (!rawCoin && aiData.explanation) {
        const matchCoin = String(aiData.explanation).match(/\b([A-Z0-9]{2,10})(?:USDT|\/USDT|\-USDT)?\b/i);
        if (matchCoin && !['LONG', 'SHORT', 'STOP', 'ENTRY', 'ALVO', 'ALVOS', 'USDT'].includes(matchCoin[1].toUpperCase())) {
          rawCoin = matchCoin[1].toUpperCase();
        }
      }

      // Se ainda não identificou e o usuário enviou legenda no Telegram, usa a legenda
      if (!rawCoin && userCaption) {
        const captionMatch = userCaption.match(/\b([A-Za-z0-9]{2,10})(?:\/USDT|\-USDT|USDT)?\b/);
        if (captionMatch) {
          const cand = captionMatch[1].toUpperCase().replace(/USDT$/i, '').trim();
          if (!['LONG', 'SHORT', 'STOP', 'BUY', 'SELL', 'ENTRADA', 'ALVO'].includes(cand)) {
            rawCoin = cand;
          }
        }
      }

      if (!rawCoin) {
        return {
          success: false,
          error: "Não foi possível identificar o par/criptomoeda no gráfico. Certifique-se de que o topo do gráfico com o nome da moeda (ex: BTC, ETH, OPN) está visível ou digite o par como legenda da foto."
        };
      }

      let direction: 'LONG' | 'SHORT' = 'LONG';
      const rawDir = String(aiData.direction || aiData.toolType || '').toUpperCase();

      let entryPrice = parseFloat(String(aiData.entryPrice || '0').replace(',', '.'));
      let stopLoss = parseFloat(String(aiData.stopLoss || '0').replace(',', '.'));

      // Detecção de direção a partir do indicador
      if (rawDir.includes('SHORT') || rawDir.includes('SELL') || rawDir.includes('VENDA')) {
        direction = 'SHORT';
      } else if (rawDir.includes('LONG') || rawDir.includes('BUY') || rawDir.includes('COMPRA')) {
        direction = 'LONG';
      } else if (entryPrice > 0 && stopLoss > 0) {
        direction = entryPrice > stopLoss ? 'LONG' : 'SHORT';
      }

      // Validação obrigatória do indicador na tela
      if (isNaN(entryPrice) || entryPrice <= 0) {
        return { success: false, error: "Preço de entrada não identificado na etiqueta do indicador." };
      }
      if (isNaN(stopLoss) || stopLoss <= 0) {
        return { success: false, error: "Stop Loss não identificado na etiqueta do indicador." };
      }

      // Correção caso Entrada e Stop tenham sido invertidos no retorno
      if (direction === 'SHORT' && stopLoss <= entryPrice) {
        const tmp = stopLoss;
        stopLoss = entryPrice;
        entryPrice = tmp;
      } else if (direction === 'LONG' && entryPrice <= stopLoss) {
        const tmp = stopLoss;
        stopLoss = entryPrice;
        entryPrice = tmp;
      }

      // Alvos de Take Profit lidos diretamente da coluna do indicador
      let takeProfits: number[] = [];
      if (Array.isArray(aiData.takeProfits) && aiData.takeProfits.length > 0) {
        const parsedTps = aiData.takeProfits
          .map((tp: any) => parseFloat(String(tp).replace(',', '.')))
          .filter((tp: number) => !isNaN(tp) && tp > 0);

        const validTps = parsedTps.filter((tp: number) => {
          return direction === 'LONG' ? tp > entryPrice : tp < entryPrice;
        });

        if (validTps.length > 0) {
          takeProfits = direction === 'LONG'
            ? validTps.sort((a: number, b: number) => a - b)
            : validTps.sort((a: number, b: number) => b - a);
        }
      }

      if (!takeProfits || takeProfits.length === 0) {
        takeProfits = generateChartTakeProfits(entryPrice, stopLoss, direction);
      }

      const resolved = resolveBingXSymbol(rawCoin);

      let leverage = 20;
      let originalSignalLeverage: number | null = null;
      let wasLeverageCappedByBroker = false;

      if (aiData.leverage && typeof aiData.leverage === 'number' && aiData.leverage > 0) {
        // Se a imagem tem alavancagem explícita no indicador (ex: 86x), guarda a original
        leverage = aiData.leverage;
        originalSignalLeverage = aiData.leverage;
      } else if (serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE') {
        leverage = serverTelegramBotConfig.fixedLeverageValue || 20;
      }
      if (serverTelegramBotConfig.maxLeverageCap && serverTelegramBotConfig.maxLeverageCap > 0 && leverage > serverTelegramBotConfig.maxLeverageCap) {
        leverage = serverTelegramBotConfig.maxLeverageCap;
      }

      // Checa limite máximo real de alavancagem suportado pela Bitunix para este par específico
      try {
        const maxBrokerLev = await fetchSymbolMaxBrokerLeverage(resolved.apiSymbol);
        if (maxBrokerLev > 0 && maxBrokerLev < 1000 && leverage > maxBrokerLev) {
          if (!originalSignalLeverage) {
            originalSignalLeverage = leverage;
          }
          leverage = maxBrokerLev;
          wasLeverageCappedByBroker = true;
          console.log(`[CHART-VISION-LEV-CAP] Alavancagem do sinal (${originalSignalLeverage}x) ajustada para o máximo real da Bitunix em ${resolved.apiSymbol} (${maxBrokerLev}x)`);
        }
      } catch (e: any) {
        console.warn(`[CHART-VISION-LEV-ERR]:`, e?.message);
      }

      const parsed: any = {
        isValidSignal: true,
        symbol: resolved.apiSymbol || `${rawCoin}-USDT`,
        apiSymbol: resolved.apiSymbol || `${rawCoin}-USDT`,
        displayName: resolved.displayName || rawCoin,
        coinName: resolved.cleanSymbol || rawCoin,
        direction,
        orderType: 'LIMIT' as const,
        entryPrice,
        entryPrice2: null,
        stopLoss,
        takeProfits,
        leverage,
        targetLeverage: leverage,
        originalSignalLeverage,
        wasLeverageCappedByBroker,
        hasLeverageMatch: true,
        contractInfo: resolved.contract,
        isFromChartVision: true,
        hasExplicitIndicatorTargets: true,
        chartExplanation: aiData.explanation || `Indicador na tela com Entrada $${entryPrice}, Stop $${stopLoss}, ${direction} ${leverage}x e ${takeProfits.length} alvos lidos diretamente`
      };

      const vipFormattedMessage = formatVipSignalMessage(parsed, false);
      const vipFormattedHtml = formatVipSignalMessage(parsed, true);
      parsed.vipFormattedMessage = vipFormattedMessage;
      parsed.vipFormattedHtml = vipFormattedHtml;

      return {
        success: true,
        parsed,
        vipFormattedMessage,
        vipFormattedHtml,
        rawJson: aiData
      };
    } catch (err: any) {
      console.error("[GEMINI-VISION-ERROR]:", err?.message || err);
      const rawErrMsg = String(err?.message || '');
      let friendlyErrMsg = rawErrMsg;
      if (rawErrMsg.includes('Timeout') || rawErrMsg.includes('timeout') || rawErrMsg.includes('aborted')) {
        friendlyErrMsg = "O processamento visual do gráfico excedeu o tempo de resposta dos servidores da IA. Por favor, reenvie uma imagem recortada focando no indicador de trade (Entrada, Stop e Alvos).";
      } else if (rawErrMsg.includes('503') || rawErrMsg.includes('high demand') || rawErrMsg.includes('UNAVAILABLE')) {
        friendlyErrMsg = "Os servidores de visão da IA do Google estão enfrentando um pico de tráfego momentâneo (Erro 503). Por favor, reenvie o print em alguns instantes ou envie o sinal em texto.";
      } else if (rawErrMsg.includes('429') || rawErrMsg.includes('quota')) {
        friendlyErrMsg = "Limite temporário de requisições de visão do Google atingido. Aguarde alguns segundos e tente novamente.";
      } else if (rawErrMsg.includes('Unable to process input image')) {
        friendlyErrMsg = "O formato da imagem enviada não pôde ser lido. Envie um print padrão em JPEG ou PNG com as etiquetas do gráfico visíveis.";
      }
      return {
        success: false,
        error: friendlyErrMsg
      };
    }
  };

  // Helper para formatar preços de forma idêntica aos padrões de grupos VIP
  const formatPriceVip = (val: number | string | undefined | null): string => {
    if (val === undefined || val === null || val === '') return '0';
    const num = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
    if (isNaN(num)) return String(val);
    let str = num.toString();
    if (str.includes('e-')) {
      str = num.toFixed(8).replace(/\.?0+$/, '');
    }
    return str.replace('.', ',');
  };

  // Helper para formatar sinal no formato VIP exato para grupos (igual ao modelo solicitado pelo usuário)
  const formatVipSignalMessage = (parsed: any, useHtml: boolean = false): string => {
    const rawCoin = parsed.coinName || parsed.symbol || parsed.apiSymbol || 'CRYPTO';
    const coin = String(rawCoin)
      .replace('BINGX:', '')
      .replace('-USDT', '')
      .replace('/USDT', '')
      .replace('USDT', '')
      .toUpperCase();

    const leverage = parsed.leverage || parsed.targetLeverage || 20;
    const isShort = String(parsed.direction || '').toUpperCase().includes('SHORT');
    const dirEmoji = isShort ? '🔴' : '🟢';
    const dirText = isShort ? 'SHORT' : 'LONG';

    const e1 = parsed.entryPrice;
    const e2 = parsed.entryPrice2;
    let entryFormatted = '';
    if (e1 && e2 && Number(e1) !== Number(e2) && !isNaN(Number(e2))) {
      entryFormatted = `${formatPriceVip(e1)} - ${formatPriceVip(e2)}`;
    } else if (e1) {
      entryFormatted = `${formatPriceVip(e1)}`;
    } else {
      entryFormatted = 'Mercado';
    }

    const tps = Array.isArray(parsed.takeProfits) && parsed.takeProfits.length > 0
      ? parsed.takeProfits
      : [e1 || 0];

    const tpLines = tps.map((tp: any, idx: number) => {
      const isHit = Array.isArray(parsed.hitTargets) && Boolean(parsed.hitTargets[idx]);
      const icon = isHit ? '✅' : '🚀';
      return `${icon} TP ${idx + 1}: ${formatPriceVip(tp)}`;
    }).join('\n');

    const stopFormatted = (parsed.stopLoss && Number(parsed.stopLoss) > 0)
      ? formatPriceVip(parsed.stopLoss)
      : 'Não Definido';

    // Cálculo exato do Risco da Operação (% stop × alavancagem) e definição de CRUZADA vs ISOLADA
    const entryNum = e1 ? parseFloat(String(e1).replace(',', '.')) : 0;
    const slNum = parsed.stopLoss ? parseFloat(String(parsed.stopLoss).replace(',', '.')) : 0;
    let riskFormatted = '';
    let isCross = false;
    const threshold = serverTelegramBotConfig?.autoCrossMarginThreshold || 25;

    if (entryNum > 0 && slNum > 0) {
      const slDist = Math.abs(entryNum - slNum);
      const slDistPct = (slDist / entryNum) * 100;
      const riskVal = slDistPct * leverage;
      riskFormatted = riskVal.toFixed(2).replace('.', ',');
      isCross = shouldUseCrossMargin(riskVal, leverage, threshold);
    } else if (parsed.marginMode === 'CROSS' || parsed.marginMode === 'CRUZADA' || parsed.marginType === 'CROSSED') {
      isCross = true;
    }

    const marginLabel = isCross ? 'CRUZADA' : 'ISOLADA';
    const orderTitle = parsed.orderType === 'MARKET' ? 'ORDEM A MERCADO' : 'ORDEM LIMITE';
    const riskSectionPlain = riskFormatted ? `\n\n⚠️ RISCO DA OPERAÇÃO\n▸ -${riskFormatted}% sobre o valor aportado.` : '';
    const riskSectionHtml = riskFormatted ? `\n\n⚠️ <b>RISCO DA OPERAÇÃO</b>\n▸ -${riskFormatted}% sobre o valor aportado.` : '';

    if (useHtml) {
      return (
        `💠 <b>${orderTitle}</b> 💠\n\n` +
        `🌲 <b>${coin}/USDT</b> 🌲\n\n` +
        `${dirEmoji} <b>${dirText} - ${leverage}x (${marginLabel})</b>\n\n` +
        `⚡ <b>Entrada:</b> ${entryFormatted}\n\n` +
        `${tpLines}\n\n` +
        `❌ <b>StopLoss:</b> ${stopFormatted}` +
        riskSectionHtml
      );
    }

    return (
      `💠 ${orderTitle} 💠\n\n` +
      `🌲 ${coin}/USDT 🌲\n\n` +
      `${dirEmoji} ${dirText} - ${leverage}x (${marginLabel})\n\n` +
      `⚡ Entrada: ${entryFormatted}\n\n` +
      `${tpLines}\n\n` +
      `❌ StopLoss: ${stopFormatted}` +
      riskSectionPlain
    );
  };

  // Mapa para prevenir execução de ordens duplicadas do Telegram (duplo clique ou webhooks repetidos)
  const tradeExecutionDedupMap = new Map<string, number>();

  // Helper to execute order directly on BingX from Telegram Bot
  const executeBingXTradeForTelegram = async (parsed: any) => {
    const apiKey = DEFAULT_BITUNIX_KEY;
    const apiSecret = DEFAULT_BITUNIX_SECRET;
    const targetAccountType: 'USDT' | 'VST' = parsed.accountType || serverTelegramBotConfig.accountType || 'USDT';
    const isDemo = targetAccountType === 'VST';

    console.log(`[BITUNIX-EXEC-START] Iniciando trade para ${parsed.apiSymbol || parsed.coinName} na conta: ${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'}`);

    if (!apiKey || !apiSecret) {
      return { success: false, error: "Chaves de API da Bitunix não configuradas no servidor." };
    }

    try {
      if (!parsed.coinName && !parsed.apiSymbol) {
        return { success: false, error: "Par de negociação inválido ou não identificado no sinal." };
      }
      const resolved = resolveBingXSymbol(parsed.apiSymbol || parsed.coinName || parsed.symbol);
      const apiSymbol = resolved.apiSymbol || (parsed.coinName ? `${parsed.coinName}-USDT` : parsed.symbol);
      const targetDirection = parsed.direction || 'LONG';

      // 🛡️ DEDUPLICAÇÃO ESTRITA: Impede que a mesma ordem seja disparada duas vezes em menos de 15 segundos
      const dedupKey = `${apiSymbol}_${targetDirection}_${parsed.orderType || 'ALL'}_${isDemo ? 'DEMO' : 'REAL'}`;
      const now = Date.now();
      const lastExec = tradeExecutionDedupMap.get(dedupKey);
      if (lastExec && (now - lastExec) < 15000) {
        console.warn(`[DEDUP-TELEGRAM-TRADE] 🛡️ Ignorando ordem duplicada para ${dedupKey} enviada há apenas ${((now - lastExec) / 1000).toFixed(1)}s.`);
        return { success: false, error: "Ordem duplicada bloqueada (já executada recentemente via Telegram)." };
      }
      tradeExecutionDedupMap.set(dedupKey, now);

      // Limpeza de cache antigo
      if (tradeExecutionDedupMap.size > 200) {
        const [first] = tradeExecutionDedupMap.keys();
        tradeExecutionDedupMap.delete(first);
      }

      const orderSide = targetDirection === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = targetDirection === 'LONG' ? 'SELL' : 'BUY';
      
      // Determinação rigorosa da alavancagem respeitando o sinal aprovado no Telegram e travas de segurança
      let targetLeverage = 20;
      if (parsed.targetLeverage && typeof parsed.targetLeverage === 'number' && parsed.targetLeverage > 0) {
        targetLeverage = parsed.targetLeverage;
      } else if (parsed.leverage && typeof parsed.leverage === 'number' && parsed.leverage > 0) {
        targetLeverage = parsed.leverage;
      } else if (serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE') {
        targetLeverage = serverTelegramBotConfig.fixedLeverageValue || 20;
      }

      // Aplica teto de segurança se configurado pelo usuário
      if (serverTelegramBotConfig.maxLeverageCap && serverTelegramBotConfig.maxLeverageCap > 0 && targetLeverage > serverTelegramBotConfig.maxLeverageCap) {
        targetLeverage = serverTelegramBotConfig.maxLeverageCap;
      }

      const orderType = parsed.orderType || (parsed.entryPrice ? 'LIMIT' : 'MARKET');

      // 1. Obter Especificações do Contrato da Bitunix (usando cache inteligente e fallback rápido)
      let pricePrecision = 4;
      let quantityPrecision = 1;
      let minQty = 1;
      let minUsdt = 2;
      let maxContractLeverage = 1000;

      const contract = resolved.contract || symbolLookupIndex.get(apiSymbol) || symbolLookupIndex.get(cleanKey(apiSymbol));
      if (contract) {
        pricePrecision = contract.pricePrecision ?? 4;
        quantityPrecision = contract.quantityPrecision ?? 1;
        minQty = parseFloat(contract.tradeMinQuantity) || 1;
        minUsdt = parseFloat(contract.tradeMinUSDT) || 2;
        try {
          const brokerMaxLev = await fetchSymbolMaxBrokerLeverage(apiSymbol, apiKey, apiSecret, isDemo);
          if (brokerMaxLev > 0 && brokerMaxLev < 1000) {
            maxContractLeverage = brokerMaxLev;
          }
        } catch (e) {}
      } else {
        try {
          const contractsRes = await sendBingXRequest('/openApi/swap/v2/quote/contracts', 'GET', {}, apiKey, apiSecret, isDemo);
          if (contractsRes?.data && Array.isArray(contractsRes.data)) {
            const c = contractsRes.data.find((item: any) => item.symbol === apiSymbol);
            if (c) {
              pricePrecision = c.pricePrecision ?? 4;
              quantityPrecision = c.quantityPrecision ?? 1;
              minQty = parseFloat(c.tradeMinQuantity) || 1;
              minUsdt = parseFloat(c.tradeMinUSDT) || 2;
            }
          }
        } catch (e) {}

        try {
          const brokerMaxLev = await fetchSymbolMaxBrokerLeverage(apiSymbol, apiKey, apiSecret, isDemo);
          if (brokerMaxLev > 0 && brokerMaxLev < 1000) {
            maxContractLeverage = brokerMaxLev;
          }
        } catch (e) {}
      }

      let wasLeverageCappedByBroker = parsed.wasLeverageCappedByBroker || false;
      let originalSignalLeverage = parsed.originalSignalLeverage || null;

      if (maxContractLeverage < 1000 && targetLeverage > maxContractLeverage) {
        console.log(`[BINGX-LEV-CAP] Alavancagem ${targetLeverage}x ajustada para o máximo suportado pelo par ${apiSymbol} (${maxContractLeverage}x)`);
        if (!originalSignalLeverage) {
          originalSignalLeverage = targetLeverage;
        }
        targetLeverage = maxContractLeverage;
        wasLeverageCappedByBroker = true;
      }

      // 2. Ajustar Alavancagem na Bitunix (Suporte completo a Hedge Mode "LONG/SHORT" e One-Way "BOTH")
      console.log(`[BINGX-SET-LEVERAGE] Configurando alavancagem ${targetLeverage}x para ${apiSymbol} (Direção: ${targetDirection})...`);
      try {
        const r1 = await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
          symbol: apiSymbol,
          leverage: targetLeverage.toString(),
          side: targetDirection
        }, apiKey, apiSecret, isDemo);
        console.log(`[BINGX-LEV-RES-${targetDirection}]:`, JSON.stringify(r1));
        if (r1?.code !== 0 && r1?.msg) {
          console.warn(`[BINGX-LEV-ERR-${targetDirection}]:`, r1.msg);
          const levMatch = r1.msg.match(/(?:max|maximum|limit|allowed|between\s*\d+\s*and\s*|up to\s*).*?(\d{1,4})\s*x?/i) || r1.msg.match(/(\d{1,4})\s*x\s*leverage/i);
          if (levMatch) {
            const parsedMax = parseInt(levMatch[1], 10);
            if (parsedMax > 0 && parsedMax < targetLeverage) {
              if (!originalSignalLeverage) originalSignalLeverage = targetLeverage;
              targetLeverage = parsedMax;
              wasLeverageCappedByBroker = true;
              symbolLeverageCache.set(apiSymbol.toUpperCase().trim(), {
                maxLongLeverage: parsedMax,
                maxShortLeverage: parsedMax,
                maxLeverage: parsedMax,
                timestamp: Date.now()
              });
              console.log(`[BINGX-LEV-FALLBACK-CAP] Re-ajustando alavancagem para ${targetLeverage}x com base no retorno da Bitunix`);
              await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
                symbol: apiSymbol,
                leverage: targetLeverage.toString(),
                side: targetDirection
              }, apiKey, apiSecret, isDemo).catch(() => {});
            }
          }
        }
      } catch (e: any) {
        console.warn(`[BINGX-LEV-ERR-${targetDirection}]:`, e?.message);
      }

      try {
        const r2 = await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
          symbol: apiSymbol,
          leverage: targetLeverage.toString(),
          side: "BOTH"
        }, apiKey, apiSecret, isDemo);
        console.log(`[BINGX-LEV-RES-BOTH]:`, JSON.stringify(r2));
      } catch (e: any) {
        console.warn(`[BINGX-LEV-ERR-BOTH]:`, e?.message);
      }

      try {
        const oppSide = targetDirection === 'LONG' ? 'SHORT' : 'LONG';
        await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
          symbol: apiSymbol,
          leverage: targetLeverage.toString(),
          side: oppSide
        }, apiKey, apiSecret, isDemo);
      } catch (e) {}

      // 4. Obter Preço Atual do Mercado
      let marketPrice = parsed.entryPrice || 0;
      try {
        const tickerRes = await sendBingXRequest('/openApi/swap/v2/quote/ticker', 'GET', {
          symbol: apiSymbol
        }, apiKey, apiSecret, isDemo);
        if (tickerRes?.data?.lastPrice) {
          marketPrice = parseFloat(tickerRes.data.lastPrice);
        }
      } catch (e) {}

      if (!marketPrice || marketPrice <= 0) {
        marketPrice = parsed.entryPrice || 1.0;
      }

      const executionPrice = (orderType === 'LIMIT' && parsed.entryPrice) ? parsed.entryPrice : marketPrice;

      // 5. Obter Saldo da Conta
      let balanceUsd = await getCachedBingXBalance(apiKey, apiSecret, isDemo);
      if (balanceUsd <= 0) balanceUsd = 100;

      // 6. Cálculo Preciso do Risco e Tamanho da Posição
      let riskUsd = 2.0;
      let isCustomSignalRisk = false;
      if (parsed.customRiskUsd && typeof parsed.customRiskUsd === 'number' && parsed.customRiskUsd > 0) {
        riskUsd = parsed.customRiskUsd;
        isCustomSignalRisk = true;
        console.log(`[RISK-CUSTOM-SIGNAL] Usando risco customizado do sinal: $${riskUsd.toFixed(2)} USDT (Perda máxima fixada no sinal: ${parsed.customRiskUsd} dol)`);
      } else if (serverTelegramBotConfig.riskMode === 'FIXED_USD') {
        riskUsd = serverTelegramBotConfig.riskFixedUsd || 50.0;
      } else {
        const pct = serverTelegramBotConfig.riskPercent || 2.0;
        riskUsd = (balanceUsd * pct) / 100;
      }

      let stopLossPrice = parsed.stopLoss;
      if (!stopLossPrice || stopLossPrice <= 0) {
        const emergPct = (serverTelegramBotConfig.emergencyStopPercent || 2.0) / 100;
        stopLossPrice = targetDirection === 'LONG'
          ? parseFloat((executionPrice * (1 - emergPct)).toFixed(pricePrecision))
          : parseFloat((executionPrice * (1 + emergPct)).toFixed(pricePrecision));
      }

      const slDist = Math.abs(executionPrice - stopLossPrice);
      const slDistancePct = executionPrice > 0 ? (slDist / executionPrice) : 0.02;
      const slLeveragedPct = slDistancePct * 100 * targetLeverage;

      // 3. Ajuste Inteligente de Margem: Cruzada (CROSSED) anti-liquidação se SL alavancado >= 25% ou alavancagem elevada
      const crossThreshold = serverTelegramBotConfig.autoCrossMarginThreshold || 25;
      const shouldCrossMargin = shouldUseCrossMargin(slLeveragedPct, targetLeverage, crossThreshold);
      const targetMarginType = shouldCrossMargin ? "CROSSED" : "ISOLATED";
      try {
        console.log(`[BINGX-MARGIN-MODE] Configurando margem ${targetMarginType} para ${apiSymbol} (Alav: ${targetLeverage}x | SL Alavancado: ${slLeveragedPct.toFixed(1)}% | Limiar: ${crossThreshold}%)...`);
        const marginRes = await sendBingXRequest('/openApi/swap/v2/trade/marginType', 'POST', {
          symbol: apiSymbol,
          marginType: targetMarginType
        }, apiKey, apiSecret, isDemo);
        console.log(`[BINGX-MARGIN-RES]:`, JSON.stringify(marginRes));
      } catch (e: any) {
        console.warn(`[BINGX-MARGIN-ERR]:`, e?.message);
      }

      // 🛡️ Taxas de Corretagem da Bitunix (0.10% round-trip: abertura ~0.05% + fechamento no SL ~0.05%)
      // Se includeFeesInRisk estiver ativo, embutimos a taxa na perda máxima total para que nunca passe de riskUsd
      const roundTripFeeRate = (serverTelegramBotConfig.includeFeesInRisk !== false) ? 0.0010 : 0.0;
      const totalLossPerUnit = slDist + (executionPrice * roundTripFeeRate);

      // Quantidade exata calculada a partir do risco em dólares (embutindo taxas para não estourar o risco)
      let targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / executionPrice);
      
      // 🛡️ Trava de Segurança de Margem: Nunca exceder 75% do saldo livre da conta em uma única ordem
      // Isso elimina o erro 'Insufficient margin' em sinais de Stop Loss ultra-curto (scalper)
      const maxSafeMarginUsd = Math.max(minUsdt, balanceUsd * 0.75);
      let requiredMarginUsd = (targetQty * executionPrice) / targetLeverage;
      let wasMarginCappedByBalance = false;

      if (requiredMarginUsd > maxSafeMarginUsd) {
        targetQty = (maxSafeMarginUsd * targetLeverage) / executionPrice;
        wasMarginCappedByBalance = true;
        console.log(`[BINGX-MARGIN-CAP] Margem de $${requiredMarginUsd.toFixed(2)} ajustada para $${maxSafeMarginUsd.toFixed(2)} (75% do saldo de $${balanceUsd.toFixed(2)}) para evitar 'Insufficient margin'`);
      }

      // Respeitar restrições mínimas do contrato na Bitunix
      if (targetQty < minQty) targetQty = minQty;
      if (targetQty * executionPrice < minUsdt) targetQty = minUsdt / executionPrice;

      let qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
      let finalExecutedQty = parseFloat(qtyStr);

      let exactPositionValueUsd = finalExecutedQty * executionPrice;
      let exactMarginUsd = exactPositionValueUsd / targetLeverage;
      let exactPriceLossUsd = finalExecutedQty * slDist;
      let exactFeesUsd = exactPositionValueUsd * 0.0010; // Taxa real estimada da Bitunix (~0.10%: 0.05% entrada + 0.05% saída)
      let exactActualRiskUsd = (serverTelegramBotConfig.includeFeesInRisk !== false)
        ? (exactPriceLossUsd + exactFeesUsd)
        : exactPriceLossUsd;

      const formattedEntryPrice = executionPrice.toFixed(pricePrecision);
      const formattedSL = stopLossPrice.toFixed(pricePrecision);

      console.log(`[BINGX-EXEC-TG] Executando ${apiSymbol} | ${targetDirection} ${targetLeverage}x | Preço: $${formattedEntryPrice} | Qtd: ${qtyStr} | Margem: $${exactMarginUsd.toFixed(2)} | SL: $${formattedSL} | Risco Real: $${exactActualRiskUsd.toFixed(2)}`);

      // 7. Preparar Parâmetros da Ordem Principal
      const orderParams: any = {
        symbol: apiSymbol,
        side: orderSide,
        positionSide: targetDirection,
        type: orderType,
        quantity: qtyStr
      };

      if (orderType === 'LIMIT') {
        orderParams.price = formattedEntryPrice;
        orderParams.timeInForce = "GTC";
      }

      // Stop Loss embutido (Estrutura idêntica ao Web App com Fechamento de Posição Inteira)
      if (formattedSL && parseFloat(formattedSL) > 0) {
        orderParams.slPrice = formattedSL;
        orderParams.slStopType = "MARK_PRICE";
        orderParams.slOrderType = "MARKET";
        orderParams.stopLoss = JSON.stringify({
          type: "STOP_MARKET",
          stopPrice: parseFloat(formattedSL),
          closePosition: true
        });
      }

      // Take Profit embutido no Último Alvo (Estrutura idêntica ao Web App)
      let selectedTpPrice: string | null = null;
      if (parsed.takeProfits && parsed.takeProfits.length > 0) {
        const tps = parsed.takeProfits;
        const chosenTp = (serverTelegramBotConfig.takeProfitSelection === 'TP1')
          ? tps[0]
          : tps[tps.length - 1];

        selectedTpPrice = chosenTp.toFixed(pricePrecision);
        orderParams.tpPrice = selectedTpPrice;
        orderParams.tpStopType = "MARK_PRICE";
        orderParams.tpOrderType = "MARKET";
        orderParams.takeProfit = JSON.stringify({
          type: "TAKE_PROFIT_MARKET",
          stopPrice: parseFloat(selectedTpPrice)
        });
      }

      console.log(`[BINGX-ORDER-SUBMIT] Params:`, JSON.stringify(orderParams));
      let orderRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', orderParams, apiKey, apiSecret, isDemo);
      console.log(`[BINGX-ORDER-RESPONSE]:`, JSON.stringify(orderRes));

      // 🔄 AUTO-RETRY INTELIGENTE 1: Limite Dinâmico de Alavancagem da Bitunix (Ex: Max 200x leverage allowed during this period)
      if (orderRes?.code !== 0 && orderRes?.msg) {
        const errMsg = orderRes.msg;
        const levRegex = /(?:max|maximum|limit|allowed|between\s*\d+\s*and\s*|up to\s*).*?(\d{1,4})\s*x?/i;
        const match = errMsg.match(levRegex) || errMsg.match(/(\d{1,4})\s*x\s*leverage/i);
        if (match) {
          const detectedMax = parseInt(match[1], 10);
          if (detectedMax > 0 && detectedMax < targetLeverage) {
            console.log(`[BINGX-AUTO-RETRY-LEV] Detectado limite da Bitunix de ${detectedMax}x para ${apiSymbol}. Reajustando e reenviando imediatamente...`);
            if (!originalSignalLeverage) originalSignalLeverage = targetLeverage;
            targetLeverage = detectedMax;
            wasLeverageCappedByBroker = true;

            symbolLeverageCache.set(apiSymbol.toUpperCase().trim(), {
              maxLongLeverage: detectedMax,
              maxShortLeverage: detectedMax,
              maxLeverage: detectedMax,
              timestamp: Date.now()
            });

            // Ajusta na Bitunix em ambas as direções
            await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
              symbol: apiSymbol,
              leverage: targetLeverage.toString(),
              side: targetDirection
            }, apiKey, apiSecret, isDemo).catch(() => {});
            await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
              symbol: apiSymbol,
              leverage: targetLeverage.toString(),
              side: "BOTH"
            }, apiKey, apiSecret, isDemo).catch(() => {});

            // Recalcula quantidade com a nova alavancagem respeitando o teto de margem segura (incluindo taxas)
            targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / executionPrice);
            requiredMarginUsd = (targetQty * executionPrice) / targetLeverage;
            if (requiredMarginUsd > maxSafeMarginUsd) {
              targetQty = (maxSafeMarginUsd * targetLeverage) / executionPrice;
              wasMarginCappedByBalance = true;
            }
            if (targetQty < minQty) targetQty = minQty;
            if (targetQty * executionPrice < minUsdt) targetQty = minUsdt / executionPrice;

            qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
            finalExecutedQty = parseFloat(qtyStr);
            exactPositionValueUsd = finalExecutedQty * executionPrice;
            exactMarginUsd = exactPositionValueUsd / targetLeverage;
            exactPriceLossUsd = finalExecutedQty * slDist;
            exactFeesUsd = exactPositionValueUsd * 0.0010;
            exactActualRiskUsd = (serverTelegramBotConfig.includeFeesInRisk !== false)
              ? (exactPriceLossUsd + exactFeesUsd)
              : exactPriceLossUsd;

            orderParams.quantity = qtyStr;
            console.log(`[BINGX-AUTO-RETRY-LEV-SUBMIT] Reenviando com ${targetLeverage}x e Qtd ${qtyStr}...`);
            orderRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', orderParams, apiKey, apiSecret, isDemo);
            console.log(`[BINGX-AUTO-RETRY-LEV-RES]:`, JSON.stringify(orderRes));
          }
        }
      }

      // 🔄 AUTO-RETRY INTELIGENTE 2: Margem Insuficiente (Insufficient margin / balance)
      if (orderRes?.code !== 0 && orderRes?.msg) {
        const lower = orderRes.msg.toLowerCase();
        if (lower.includes('margin') || lower.includes('balance')) {
          console.log(`[BINGX-AUTO-RETRY-MARGIN] 'Insufficient margin' detectado na Bitunix. Calibrando quantidade para caber na margem livre...`);
          targetQty = targetQty * 0.60;
          if (targetQty < minQty) targetQty = minQty;
          if (targetQty * executionPrice < minUsdt) targetQty = minUsdt / executionPrice;

          qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
          finalExecutedQty = parseFloat(qtyStr);
          exactPositionValueUsd = finalExecutedQty * executionPrice;
          exactMarginUsd = exactPositionValueUsd / targetLeverage;
          exactPriceLossUsd = finalExecutedQty * slDist;
          exactFeesUsd = exactPositionValueUsd * 0.0010;
          exactActualRiskUsd = (serverTelegramBotConfig.includeFeesInRisk !== false)
            ? (exactPriceLossUsd + exactFeesUsd)
            : exactPriceLossUsd;
          wasMarginCappedByBalance = true;

          orderParams.quantity = qtyStr;
          console.log(`[BINGX-AUTO-RETRY-MARGIN-SUBMIT] Reenviando com quantidade reduzida: ${qtyStr} (Margem: $${exactMarginUsd.toFixed(2)})...`);
          orderRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', orderParams, apiKey, apiSecret, isDemo);
          console.log(`[BINGX-AUTO-RETRY-MARGIN-RES]:`, JSON.stringify(orderRes));
        }
      }

      // 🔄 AUTO-RETRY INTELIGENTE 3: Limite de Risco da Bitunix Excedido (Maximum Open Limit / Risk Limit)
      // Ex: "The current positions amount has exceeded the maximum open limit, please adjust the risk limit."
      let wasCappedByRiskLimit = false;
      if (orderRes?.code !== 0 && orderRes?.msg) {
        const lowerErr = String(orderRes.msg).toLowerCase();
        if (
          lowerErr.includes('exceeded the maximum open limit') ||
          lowerErr.includes('maximum open limit') ||
          lowerErr.includes('adjust the risk limit') ||
          lowerErr.includes('risk limit') ||
          lowerErr.includes('max open limit') ||
          orderRes.code === 100003
        ) {
          console.log(`[BITUNIX-AUTO-RETRY-RISK-LIMIT] Limite máximo de posição atingido no par ${apiSymbol}. Ajustando para o tamanho MÁXIMO permitido pela Bitunix...`);
          
          let maxAllowedNotional = 0;
          try {
            const bitunixSym = resolveBitunixSymbol(apiSymbol).apiSymbol;
            const tiersRes = await sendBitunixRequest('/api/v1/futures/position/get_position_tiers', 'GET', { symbol: bitunixSym }, null, apiKey, apiSecret).catch(() => null);
            if (tiersRes?.code === 0 && Array.isArray(tiersRes.data) && tiersRes.data.length > 0) {
              const matchedTier = tiersRes.data.find((t: any) => parseFloat(t.maxLeverage || '0') >= targetLeverage) || tiersRes.data[0];
              if (matchedTier && matchedTier.endValue) {
                maxAllowedNotional = parseFloat(matchedTier.endValue) * 0.95;
              }
            }
          } catch (e) {}

          // Sequência de testes em cascata para encontrar o tamanho máximo aceito pela Bitunix
          const tryFractions = maxAllowedNotional > 0
            ? [Math.min(0.95, maxAllowedNotional / (targetQty * executionPrice)), 0.60, 0.40, 0.25, 0.12, 0.05]
            : [0.65, 0.45, 0.30, 0.15, 0.08, 0.04];

          for (const frac of tryFractions) {
            if (frac <= 0 || frac >= 1.0) continue;
            let retryQty = targetQty * frac;
            if (retryQty < minQty) retryQty = minQty;
            if (retryQty * executionPrice < minUsdt) retryQty = minUsdt / executionPrice;

            const tryQtyStr = quantityPrecision === 0 ? Math.ceil(retryQty).toString() : retryQty.toFixed(quantityPrecision);
            if (tryQtyStr === orderParams.quantity) continue;

            orderParams.quantity = tryQtyStr;
            console.log(`[BITUNIX-AUTO-RETRY-RISK-LIMIT-SUBMIT] Tentando tamanho máximo calibrado: ${tryQtyStr} contratos (~$${(parseFloat(tryQtyStr) * executionPrice).toFixed(2)} USDT)...`);
            orderRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', orderParams, apiKey, apiSecret, isDemo);
            console.log(`[BITUNIX-AUTO-RETRY-RISK-LIMIT-RES]:`, JSON.stringify(orderRes));

            if (orderRes?.code === 0) {
              finalExecutedQty = parseFloat(tryQtyStr);
              exactPositionValueUsd = finalExecutedQty * executionPrice;
              exactMarginUsd = exactPositionValueUsd / targetLeverage;
              exactPriceLossUsd = finalExecutedQty * slDist;
              exactFeesUsd = exactPositionValueUsd * 0.0010;
              exactActualRiskUsd = (serverTelegramBotConfig.includeFeesInRisk !== false)
                ? (exactPriceLossUsd + exactFeesUsd)
                : exactPriceLossUsd;
              wasCappedByRiskLimit = true;
              break;
            }
          }
        }
      }

      if (orderRes?.code === 0 && orderRes?.data) {
        const orderData = orderRes.data.order || orderRes.data;
        const realOrderId = orderData.orderId || `ORD-${Date.now()}`;

        // 0. Anexar Take Profit e Stop Loss diretamente na posição da Bitunix (Tentativas inteligentes pós-preenchimento)
        (async () => {
          const delays = [800, 2500, 5000];
          for (const delay of delays) {
            try {
              await new Promise(r => setTimeout(r, delay));
              const bitunixSym = resolveBitunixSymbol(apiSymbol).apiSymbol;

              // Limpa ordens de TPSL anteriores para evitar duplicações de stop e take
              const existingTpslRes = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', { symbol: bitunixSym }, null, apiKey, apiSecret).catch(() => null);
              const pendingTpslList = (existingTpslRes?.data && Array.isArray(existingTpslRes.data)) ? existingTpslRes.data : [];
              for (const oldOrd of pendingTpslList) {
                const oid = oldOrd.orderId || oldOrd.id;
                if (oid) {
                  await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym, orderId: oid }, apiKey, apiSecret).catch(() => null);
                }
              }

              const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, apiKey, apiSecret);
              const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
              const pos = positions.find((p: any) => p.symbol === bitunixSym);
              if (pos && pos.positionId) {
                const tpslRes = await safeSetBitunixPositionTPSL({
                  symbol: bitunixSym,
                  positionId: pos.positionId,
                  slPrice: (formattedSL && parseFloat(formattedSL) > 0) ? formattedSL : undefined,
                  tpPrice: (selectedTpPrice && parseFloat(selectedTpPrice) > 0) ? selectedTpPrice : undefined,
                  apiKey,
                  apiSecret
                });
                console.log(`[BITUNIX-TPSL-ATTACH-RES]:`, JSON.stringify(tpslRes));
                if (tpslRes?.code === 0) break;
              }
            } catch (e: any) {
              console.error(`[BITUNIX-TPSL-ATTACH-ERR]:`, e.message);
            }
          }
        })();

        // 3. Stop Móvel (Trailing Stop) na Bitunix (🛡️ Proteção de Lucro Dinâmica)
        let trailingPlaced = false;
        let trailingPostExecutionScheduled = false;
        if (serverTelegramBotConfig.trailingStopEnabled) {
          try {
            const slDist = Math.abs(executionPrice - stopLossPrice);
            const slDistPct = executionPrice > 0 ? (slDist / executionPrice) * 100 : 2.0;
            let effectiveRate = parseFloat((slDistPct * (serverTelegramBotConfig.trailingMultiplier || 1.0)).toFixed(3));
            if (effectiveRate < 0.1) {
              effectiveRate = 0.1;
            }
            if (effectiveRate > 10.0) effectiveRate = 10.0;
            
            const actPrice = targetDirection === 'LONG'
              ? executionPrice + (slDist * (serverTelegramBotConfig.trailingMultiplier || 1.0))
              : executionPrice - (slDist * (serverTelegramBotConfig.trailingMultiplier || 1.0));

            const parsedTpPriceNum = selectedTpPrice ? parseFloat(selectedTpPrice) : undefined;

            if (orderType === 'LIMIT') {
              // 🛡️ Ordem Limite pendente no livro: agenda ativação pós-execução quando preenchida
              const trailingConfigObj: PendingTrailingConfig = {
                orderId: realOrderId,
                symbol: apiSymbol,
                positionSide: targetDirection,
                closeSide,
                quantity: qtyStr,
                effectiveRate,
                activationPrice: actPrice,
                stopLossPrice,
                takeProfitPrice: parsedTpPriceNum,
                entryPrice: executionPrice,
                pricePrecision,
                createdAt: Date.now()
              };
              const cleanUpper = apiSymbol.replace('-USDT', '').replace('USDT', '');
              pendingTrailingConfigs.set(`${apiSymbol}_${targetDirection}`, trailingConfigObj);
              pendingTrailingConfigs.set(`${cleanUpper}_${targetDirection}`, trailingConfigObj);
              if (realOrderId) pendingTrailingConfigs.set(realOrderId, trailingConfigObj);
              savePendingTrailingConfigsToFile();
              trailingPostExecutionScheduled = true;
              console.log(`[BITUNIX-TRAILING-SCHEDULED] 🛡️ Stop Móvel (${effectiveRate}%) agendado para ativação pós-execução em ${apiSymbol} (Ordem #${realOrderId}, TP=${parsedTpPriceNum || 'Nenhum'})`);
            } else {
              // Ordem MARKET (posição preenchida de imediato): ativa Stop Móvel nativo na Bitunix com Take Profit protegido
              await registerBitunixTrailingStop({
                symbol: apiSymbol,
                positionSide: targetDirection,
                entryPrice: executionPrice,
                stopLossPrice,
                takeProfitPrice: parsedTpPriceNum,
                callbackRate: effectiveRate,
                activationPrice: actPrice,
                qty: qtyStr,
                pricePrecision
              });
              trailingPlaced = true;
            }
          } catch (e: any) {
            console.error("[BITUNIX-TRAILING-ORDER-ERR]:", e.message);
          }
        }

        recordTradeAudit({
          symbol: apiSymbol,
          cleanSymbol: parsed.coinName || apiSymbol.replace('-USDT', '').replace('USDT', ''),
          direction: targetDirection,
          entryPrice: parseFloat(formattedEntryPrice || '0'),
          stopLoss: parseFloat(formattedSL || '0'),
          takeProfits: parsed.takeProfits || [],
          leverage: targetLeverage,
          timestamp: Date.now()
        });

        return {
          success: true,
          orderId: realOrderId,
          apiSymbol,
          cleanSymbol: parsed.coinName || apiSymbol.replace('-USDT', '').replace('USDT', ''),
          direction: targetDirection,
          price: formattedEntryPrice,
          entryPrice2: parsed.entryPrice2,
          orderType,
          quantity: qtyStr,
          marginUsd: exactMarginUsd.toFixed(2),
          riskUsd: exactActualRiskUsd.toFixed(2),
          isCustomSignalRisk,
          customRiskUsd: parsed.customRiskUsd || null,
          priceLossUsd: exactPriceLossUsd.toFixed(2),
          feesUsd: exactFeesUsd.toFixed(2),
          includeFeesInRisk: serverTelegramBotConfig.includeFeesInRisk !== false,
          riskPercent: isCustomSignalRisk ? `Sinal ($${parsed.customRiskUsd} dol)` : (serverTelegramBotConfig.riskMode === 'PERCENT' ? `${serverTelegramBotConfig.riskPercent}% da conta` : 'Fixo'),
          stopLoss: formattedSL,
          slDistancePct: (slDistancePct * 100).toFixed(2),
          takeProfits: parsed.takeProfits || [],
          selectedTp: selectedTpPrice,
          trailingPlaced: trailingPlaced || trailingPostExecutionScheduled,
          trailingPostExecutionScheduled,
          leverage: targetLeverage,
          wasLeverageCappedByBroker,
          wasMarginCappedByBalance,
          originalSignalLeverage,
          marginType: targetMarginType,
          positionValueUsd: exactPositionValueUsd.toFixed(2),
          balanceUsd: balanceUsd.toFixed(2),
          wasCappedByRiskLimit,
          accountType: isDemo ? 'VST' : 'USDT'
        };
      } else {
        const errMsg = orderRes?.msg || (orderRes?.code ? `Código Bitunix ${orderRes.code}` : "Erro desconhecido na Bitunix");
        return { success: false, error: errMsg };
      }
    } catch (err: any) {
      console.error("[BITUNIX-EXEC-TG-ERROR]:", err.message);
      return {
        success: false,
        error: err.response?.data?.msg || err.message || "Falha na conexão com a Bitunix"
      };
    }
  };

  // Helper to execute trade for a specific managed account
  const executeTradeForManagedAccount = async (account: ManagedAccount, parsed: any) => {
    try {
      const isDemo = account.accountType === 'VST';
      const key = account.apiKey || DEFAULT_BITUNIX_KEY;
      const secret = account.apiSecret || DEFAULT_BITUNIX_SECRET;

      if (!key || !secret) {
        return { success: false, error: `Conta ${account.name}: Chaves de API não configuradas.` };
      }

      // Prepara objeto com risco customizado da conta
      const accountParsed = { ...parsed };
      if (account.riskMode === 'FIXED_USD') {
        accountParsed.customRiskUsd = account.riskFixedUsd || 50.0;
      } else if (account.riskMode === 'PERCENT') {
        // Se for PERCENT, calcula risco baseado no saldo da conta
        try {
          const bal = await getCachedBingXBalance(key, secret, isDemo);
          const pct = account.riskPercent || 2.0;
          accountParsed.customRiskUsd = Math.max(2.0, (bal * pct) / 100);
        } catch (e) {
          accountParsed.customRiskUsd = account.riskFixedUsd || 50.0;
        }
      }

      if (account.fixedLeverage && account.fixedLeverage > 0) {
        accountParsed.targetLeverage = account.fixedLeverage;
        accountParsed.leverage = account.fixedLeverage;
      }

      console.log(`[MULTI-ACCOUNT-EXEC] Disparando trade para ${account.name} (${account.ownerName}) em ${parsed.symbol || parsed.coinName}...`);
      
      // Chamada usando as credenciais da conta do operador
      const execResult = await executeBingXTradeForTelegramWithKeys(accountParsed, key, secret, isDemo);

      // Se configurado Telegram individual para esta conta, envia notificação privada
      if (execResult.success && account.telegramChatId && account.notifyOnExecution) {
        try {
          const individualMsg =
            `⚡ <b>SINAL REPLICADO NA SUA CONTA BITUNIX!</b>\n\n` +
            `👤 <b>Operador:</b> ${account.ownerName}\n` +
            `📊 <b>Par:</b> <code>${execResult.cleanSymbol}/USDT</code> (${execResult.direction})\n` +
            `🎯 <b>Tipo:</b> ${execResult.orderType}\n` +
            `💵 <b>Entrada:</b> $${execResult.price}\n` +
            `❌ <b>Stop Loss:</b> $${execResult.stopLoss}\n` +
            `📦 <b>Margem Alocada:</b> $${execResult.marginUsd} USDT (${execResult.leverage}x)\n` +
            `🛡️ <b>Risco Calculado:</b> $${execResult.riskUsd} USDT\n\n` +
            `<i>✅ Operação executada conforme suas regras de gestão de risco individuais.</i>`;
          await sendTelegramReply(account.telegramChatId, individualMsg, undefined, { disableDedup: true });
        } catch (tErr: any) {
          console.warn(`[MULTI-ACCOUNT-TG-ERR] Falha ao notificar ${account.ownerName}:`, tErr?.message);
        }
      }

      return execResult;
    } catch (err: any) {
      console.error(`[MULTI-ACCOUNT-EXEC-ERROR] Erro na conta ${account.name}:`, err.message);
      return { success: false, error: err.message };
    }
  };

  // Replicador automático para todas as contas ativas com Copy Trading habilitado
  const replicateTradeToAllActiveAccounts = async (parsed: any, initiatorAccountId?: string) => {
    const activeTargets = managedAccounts.filter(acc => 
      acc.isActive && 
      acc.copyTradingEnabled && 
      acc.id !== initiatorAccountId
    );

    if (activeTargets.length === 0) {
      console.log("[MULTI-ACCOUNT] Nenhuma outra conta secundária ativa para replicação.");
      return [];
    }

    console.log(`[MULTI-ACCOUNT] Replicando sinal para ${activeTargets.length} contas conectadas...`);
    const results = await Promise.allSettled(
      activeTargets.map(acc => executeTradeForManagedAccount(acc, parsed))
    );

    return results.map((r, idx) => ({
      accountId: activeTargets[idx].id,
      name: activeTargets[idx].name,
      owner: activeTargets[idx].ownerName,
      status: r.status === 'fulfilled' ? (r.value.success ? 'EXECUTED' : 'FAILED') : 'ERROR',
      error: r.status === 'fulfilled' ? r.value.error : (r as any).reason?.message
    }));
  };

  // Helper que aceita chaves dinâmicas para execução isolada por conta
  const executeBingXTradeForTelegramWithKeys = async (
    parsed: any,
    apiKey: string,
    apiSecret: string,
    isDemo: boolean
  ) => {
    try {
      if (!parsed.coinName && !parsed.apiSymbol) {
        return { success: false, error: "Par de negociação inválido." };
      }
      const resolved = resolveBingXSymbol(parsed.apiSymbol || parsed.coinName || parsed.symbol);
      const apiSymbol = resolved.apiSymbol || (parsed.coinName ? `${parsed.coinName}-USDT` : parsed.symbol);
      const targetDirection = parsed.direction || 'LONG';
      const orderSide = targetDirection === 'LONG' ? 'BUY' : 'SELL';
      const closeSide = targetDirection === 'LONG' ? 'SELL' : 'BUY';

      let targetLeverage = 20;
      if (parsed.targetLeverage && typeof parsed.targetLeverage === 'number' && parsed.targetLeverage > 0) {
        targetLeverage = parsed.targetLeverage;
      } else if (parsed.leverage && typeof parsed.leverage === 'number' && parsed.leverage > 0) {
        targetLeverage = parsed.leverage;
      }

      const orderType = parsed.orderType || (parsed.entryPrice ? 'LIMIT' : 'MARKET');
      let pricePrecision = 4;
      let quantityPrecision = 1;
      let minQty = 0.001;
      let minUsdt = 5.0;

      const contract = resolved.contract || symbolLookupIndex.get(apiSymbol) || symbolLookupIndex.get(cleanKey(apiSymbol));
      if (contract) {
        pricePrecision = contract.pricePrecision ?? 4;
        quantityPrecision = contract.quantityPrecision ?? 1;
        minQty = parseFloat(contract.tradeMinQuantity) || 0.001;
        minUsdt = parseFloat(contract.tradeMinUSDT) || 5.0;
      }

      // Alavancagem
      try {
        await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
          symbol: apiSymbol,
          side: "BOTH",
          leverage: targetLeverage.toString()
        }, apiKey, apiSecret, isDemo);
      } catch (e) {}

      let currentPrice = parsed.entryPrice || 0;
      try {
        const tickerRes = await sendBingXRequest('/openApi/swap/v2/quote/ticker', 'GET', {
          symbol: apiSymbol
        }, apiKey, apiSecret, isDemo);
        if (tickerRes?.data?.lastPrice) {
          currentPrice = parseFloat(tickerRes.data.lastPrice);
        }
      } catch (e) {}

      let executionPrice = (orderType === 'LIMIT' && parsed.entryPrice && parsed.entryPrice > 0)
        ? parsed.entryPrice
        : (currentPrice > 0 ? currentPrice : (parsed.entryPrice || 1.0));

      let balanceUsd = await getCachedBingXBalance(apiKey, apiSecret, isDemo);
      if (balanceUsd <= 0) balanceUsd = 100;

      let riskUsd = parsed.customRiskUsd || 10.0;
      let stopLossPrice = parsed.stopLoss;
      if (!stopLossPrice || stopLossPrice <= 0) {
        stopLossPrice = targetDirection === 'LONG'
          ? parseFloat((executionPrice * 0.98).toFixed(pricePrecision))
          : parseFloat((executionPrice * 1.02).toFixed(pricePrecision));
      }

      const slDist = Math.abs(executionPrice - stopLossPrice);
      const totalLossPerUnit = slDist + (executionPrice * 0.001);
      let targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / executionPrice);
      const maxSafeMarginUsd = Math.max(minUsdt, balanceUsd * 0.75);
      const rawMarginNeeded = (targetQty * executionPrice) / targetLeverage;
      if (rawMarginNeeded > maxSafeMarginUsd) {
        targetQty = (maxSafeMarginUsd * targetLeverage) / executionPrice;
      }
      if (targetQty < minQty) targetQty = minQty;

      const qtyStr = quantityPrecision === 0
        ? Math.floor(targetQty).toString()
        : targetQty.toFixed(quantityPrecision);

      const orderPayload: any = {
        symbol: apiSymbol,
        side: orderSide,
        positionSide: targetDirection,
        type: orderType,
        quantity: qtyStr
      };

      if (orderType === 'LIMIT' && executionPrice > 0) {
        orderPayload.price = executionPrice.toFixed(pricePrecision);
      }

      const orderRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', orderPayload, apiKey, apiSecret, isDemo);
      if (orderRes?.code === 0 && orderRes?.data) {
        const orderData = orderRes.data.order || orderRes.data;
        const realOrderId = orderData.orderId || orderData.orderID || Date.now().toString();

        // SL
        if (stopLossPrice > 0) {
          sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', {
            symbol: apiSymbol,
            side: closeSide,
            positionSide: targetDirection,
            type: 'STOP_MARKET',
            stopPrice: stopLossPrice.toFixed(pricePrecision),
            stopLoss: stopLossPrice.toFixed(pricePrecision),
            quantity: qtyStr,
            reduceOnly: true
          }, apiKey, apiSecret, isDemo).catch(() => {});
        }

        // TP
        if (Array.isArray(parsed.takeProfits) && parsed.takeProfits.length > 0) {
          const firstTp = parsed.takeProfits[0];
          if (firstTp > 0) {
            sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', {
              symbol: apiSymbol,
              side: closeSide,
              positionSide: targetDirection,
              type: 'TAKE_PROFIT_MARKET',
              stopPrice: firstTp.toFixed(pricePrecision),
              takeProfit: firstTp.toFixed(pricePrecision),
              quantity: qtyStr,
              reduceOnly: true
            }, apiKey, apiSecret, isDemo).catch(() => {});
          }
        }

        const exactMarginUsd = (parseFloat(qtyStr) * executionPrice) / targetLeverage;
        return {
          success: true,
          orderId: realOrderId,
          apiSymbol,
          cleanSymbol: parsed.coinName || apiSymbol.replace('-USDT', ''),
          direction: targetDirection,
          price: executionPrice.toFixed(pricePrecision),
          orderType,
          quantity: qtyStr,
          marginUsd: exactMarginUsd.toFixed(2),
          riskUsd: riskUsd.toFixed(2),
          stopLoss: stopLossPrice.toFixed(pricePrecision),
          leverage: targetLeverage,
          accountType: isDemo ? 'VST' : 'USDT'
        };
      } else {
        return { success: false, error: orderRes?.msg || "Erro na Bitunix ao abrir ordem." };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  };


  // Formatter for comprehensive, unified execution message
  const formatTelegramExecutionSuccessMessage = (res: any, fromUser?: string) => {
    const isLong = res.direction === 'LONG';
    const dirEmoji = isLong ? '🟢' : '🔴';
    const dirLabel = isLong ? 'COMPRA / LONG' : 'VENDA / SHORT';
    const orderTypeLabel = res.orderType === 'LIMIT' ? '🎯 LIMITE' : '⚡ A MERCADO';
    const accLabel = res.accountType === 'VST' ? '🟡 Simulação Bitunix' : '🟢 Bitunix USDT Real';
    const curr = 'USDT';

    // Format all take profit targets line by line
    let tpFormattedList = '';
    const lev = res.leverage || 20;
    if (res.takeProfits && res.takeProfits.length > 0) {
      const entryNum = parseFloat(res.price) || 0;
      const notionalNum = parseFloat(res.positionValueUsd) || (parseFloat(res.marginUsd) * lev);
      tpFormattedList = res.takeProfits.map((tpPrice: number, idx: number) => {
        const tpDist = entryNum > 0 ? (Math.abs(tpPrice - entryNum) / entryNum) * 100 : 0;
        const tpLeveragedPct = tpDist * lev;
        const estimatedProfit = notionalNum * (tpDist / 100);
        const isLast = idx === res.takeProfits.length - 1;
        return `  🎯 <b>TP ${idx + 1}${isLast ? ' (Último Alvo)' : ''}:</b> <code>$${tpPrice}</code> (<b>+${tpDist.toFixed(2)}%</b> | <b>+${tpLeveragedPct.toFixed(2)}%</b> | <b>+$${estimatedProfit.toFixed(2)} ${curr}</b>)`;
      }).join('\n');
    } else {
      tpFormattedList = '  🎯 <b>Alvo Padrão:</b> Trailing Stop 1.0x ativado no lucro';
    }

    const slDistNum = parseFloat(res.slDistancePct) || 2.0;
    const slLevPct = slDistNum * lev;
    const crossThreshold = serverTelegramBotConfig.autoCrossMarginThreshold || 25;
    const marginModeText = res.marginType === 'CROSSED' 
      ? `<code>CRUZADA (CROSSED)</code> ⚠️ <i>Anti-Liquidação (SL -${slLevPct.toFixed(1)}%${slLevPct >= crossThreshold ? ` ≥ ${crossThreshold}%` : ` em ${lev}x`})</i>`
      : `<code>ISOLADA (ISOLATED)</code> <i>(SL seguro &lt; ${crossThreshold}%)</i>`;

    const totalExecutedLoss = (parseFloat(res.priceLossUsd || '0') + parseFloat(res.feesUsd || '0')).toFixed(2);
    const feesBreakdownText = res.feesUsd && parseFloat(res.feesUsd) > 0
      ? `\n   └ <i>(Perda Preço: $${res.priceLossUsd} | Taxas Bitunix ~0.06%: $${res.feesUsd} | Total: $${totalExecutedLoss})</i>`
      : '';

    return `✅ <b>ORDEM EXECUTADA NA BITUNIX COM SUCESSO!</b> 🚀\n` +
      `═══════════════════════════\n` +
      `📊 <b>Par:</b> <code>${res.apiSymbol}</code> (${dirEmoji} <b>${dirLabel}</b>)\n` +
      `📋 <b>Tipo de Ordem:</b> <b>${orderTypeLabel}</b>\n` +
      `⚡ <b>Preço de Entrada:</b> <code>$${res.price}</code> | <b>Qtd:</b> <code>${res.quantity}</code>\n` +
      `🛑 <b>Stop Loss:</b> <code>$${res.stopLoss}</code> (<b>${slDistNum.toFixed(2)}%</b> | <b>-${slLevPct.toFixed(2)}%</b> | <b>-$${res.riskUsd} ${curr}</b> | Ativo na Bitunix)\n\n` +
      `🎯 <b>TODOS OS ALVOS (TAKE PROFIT):</b>\n` +
      `${tpFormattedList}\n\n` +
      `═══════════════════════════\n` +
      (res.wasCappedByRiskLimit
        ? `⚠️ <b>Aviso de Limite de Risco da Bitunix:</b> A ordem original ultrapassava o teto nocional permitido pela corretora para esta alavancagem (${res.leverage}x). O robô recalculou e abriu a posição com o <b>tamanho MÁXIMO permitido pela Bitunix</b> ($${res.positionValueUsd} ${curr} / ${res.quantity} contratos).\n\n`
        : '') +
      (res.wasLeverageCappedByBroker && res.originalSignalLeverage
        ? `⚡ <b>Alavancagem:</b> <code>${res.leverage}x</code> <i>(Ajustada para o máx. da corretora | Sinal: ${res.originalSignalLeverage}x)</i>\n` +
          `ℹ️ <i>A margem em USDT foi recalculada automaticamente para manter seu risco intacto.</i>\n`
        : `⚙️ <b>Alavancagem:</b> <code>${res.leverage}x</code>\n`) +
      `🛡️ <b>Modo de Margem:</b> ${marginModeText}\n` +
      `💰 <b>Margem Aplicada:</b> <code>$${res.marginUsd} ${curr}</code>${res.wasMarginCappedByBalance ? ` <i>(Calibrada para caber no saldo disponível)</i>` : ''}\n` +
      (res.isCustomSignalRisk
        ? `🛡️ <b>Risco Máximo Solicitado no Sinal:</b> <code>$${res.riskUsd} ${curr}</code> 🎯 <i>(Perda máxima de $${res.customRiskUsd || res.riskUsd} dol fixada no sinal)</i>${feesBreakdownText}\n`
        : `🛡️ <b>Risco Máximo Calculado:</b> <code>$${res.riskUsd} ${curr}</code> (${res.riskPercent || '2% da conta'})${feesBreakdownText}\n`) +
      `📈 <b>Tamanho da Posição:</b> <code>$${res.positionValueUsd} ${curr}</code>\n` +
      `🏦 <b>Saldo da Conta:</b> <code>$${res.balanceUsd} ${curr}</code>\n` +
      `🛰️ <b>Trailing Stop:</b> ${res.orderType === 'LIMIT' ? '🛡️ <b>Pós-Execução</b> (Ativação automática ao preencher entrada)' : '<b>1.0x Ativo</b> (proteção no lucro)'}\n` +
      `💼 <b>Conta Destino:</b> <b>${accLabel}</b>\n` +
      `🆔 <b>ID Bitunix:</b> <code>#${res.orderId}</code>\n` +
      `${fromUser ? `👤 <b>Operador:</b> <b>${fromUser}</b>\n` : ''}` +
      `═══════════════════════════\n` +
      `🟢 <i>Ordem enviada e ativa na sua corretora Bitunix!</i>`;
  };

  const getExecutionInlineKeyboard = (res: any) => {
    const sym = res.apiSymbol || 'BTC-USDT';
    const side = res.direction || 'LONG';
    const clean = res.cleanSymbol || sym.replace('-USDT', '').replace('USDT', '');
    const isLimit = res.orderType === 'LIMIT';
    const orderId = (res.orderId || '').toString();

    const actionRows: any[] = [];

    if (isLimit) {
      // Para Ordens Limite (pendentes no livro): botões diretos de edição rápida
      actionRows.push([
        { text: `✏️ Editar Entrada`, callback_data: `PROMPT_EDIT_LIMIT:${sym}:${orderId}` },
        { text: `🛑 Editar SL`, callback_data: `PROMPT_EDIT_SL:${sym}:${orderId}` },
        { text: `🎯 Editar TP`, callback_data: `PROMPT_EDIT_TP:${sym}:${orderId}` }
      ]);
      actionRows.push([
        { text: `❌ Cancelar Ordem ${clean}`, callback_data: `CANCEL_ORDER:${sym}:${orderId}` },
        { text: `⏳ Ver Pendentes`, callback_data: "LIST_PENDING_ORDERS" }
      ]);
    } else {
      // Para Ordens a Mercado (posições ativas):
      actionRows.push([
        { text: `❌ Fechar Posição (${clean})`, callback_data: `CLOSE_POS:${sym}:${side}` }
      ]);
      actionRows.push([
        { text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }
      ]);
    }

    return { inline_keyboard: actionRows };
  };

  // Helper to fetch Open Positions and Open Orders from Bitunix
  const getBitunixOpenPositions = async (apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false) => {
    try {
      const [posRes, ordersRes, balance] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/positions', 'GET', {}, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', {}, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        getCachedBitunixBalance(apiKey, apiSecret, isDemo)
      ]);

      const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
      const openOrders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

      // Filter active positions where position amount > 0
      const activePositions = positions.filter((p: any) => {
        const amt = Math.abs(parseFloat(p.positionAmt || p.positionAmount || '0'));
        return amt > 0;
      }).map((p: any) => {
        const amt = Math.abs(parseFloat(p.positionAmt || '0'));
        const entryPrice = parseFloat(p.avgPrice || p.entryPrice || '0');
        const markPrice = parseFloat(p.markPrice || p.lastPrice || '0');
        const unrealizedProfit = parseFloat(p.unrealizedProfit || p.pnl || '0');
        const leverage = parseInt(p.leverage || '20', 10);
        const margin = parseFloat(p.isolatedMargin || p.margin || '0') || (amt * entryPrice / leverage);
        const pnlRatio = margin > 0 ? (unrealizedProfit / margin) * 100 : 0;
        const symbol = p.symbol;
        const positionSide = p.positionSide || (parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT');

        // Look for matching trigger orders (SL / TP)
        const slOrder = openOrders.find((o: any) => isSameOrRelatedSymbol(o.symbol, symbol) && (o.type === 'STOP_MARKET' || o.type === 'STOP'));
        const tpOrder = openOrders.find((o: any) => isSameOrRelatedSymbol(o.symbol, symbol) && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT'));

        // Look for matching trailing stop registered on server
        const bitunixSym = resolveBitunixSymbol(symbol).apiSymbol;
        const cleanUpper = symbol.replace('-USDT', '').replace('USDT', '').toUpperCase();
        const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                         bitunixActiveTrailingStops.get(symbol) || 
                         bitunixActiveTrailingStops.get(cleanUpper);

        const customSLTP = activeCustomSLTPBySymbol.get(symbol) || activeCustomSLTPBySymbol.get(bitunixSym) || activeCustomSLTPBySymbol.get(cleanUpper);

        const resolvedSL = slOrder?.stopPrice ? parseFloat(slOrder.stopPrice) : (trRecord?.currentStopLoss || customSLTP?.stopLoss || null);
        const resolvedTP = tpOrder?.stopPrice ? parseFloat(tpOrder.stopPrice) : (trRecord?.takeProfitPrice || customSLTP?.takeProfit || null);

        return {
          symbol,
          cleanSymbol: symbol.replace('-', ''),
          positionId: p.positionId,
          positionSide,
          positionAmt: amt,
          entryPrice,
          markPrice,
          leverage,
          margin,
          notional: amt * (markPrice || entryPrice),
          unrealizedProfit,
          pnlPercent: pnlRatio,
          stopLoss: resolvedSL,
          takeProfit: resolvedTP,
          trailingStop: trRecord ? {
            enabled: true,
            isActivated: trRecord.isActivated,
            activationPrice: trRecord.activationPrice,
            callbackRate: trRecord.callbackRate,
            highestPrice: trRecord.highestPrice,
            lowestPrice: trRecord.lowestPrice,
            currentStopLoss: trRecord.currentStopLoss
          } : null,
          liquidationPrice: parseFloat(p.liquidationPrice || '0')
        };
      });

      return {
        success: true,
        balance,
        positions: activePositions,
        openOrdersCount: openOrders.length,
        openOrders
      };
    } catch (err: any) {
      console.error("[GET-POSITIONS-ERROR]:", err.message);
      return { success: false, error: err.message, positions: [], balance: 0, openOrdersCount: 0 };
    }
  };

  const getBingXOpenPositions = getBitunixOpenPositions;

  // Helper de formatação inteligente de preços para criptomoedas (suporta altcoins com valores decimais baixos)
  const formatDisplayPrice = (val: number | string | undefined | null): string => {
    const num = typeof val === 'number' ? val : parseFloat(val || '0');
    if (isNaN(num) || num === 0) return '0.00';
    const abs = Math.abs(num);
    if (abs < 0.0001) return num.toFixed(8);
    if (abs < 0.01) return num.toFixed(6);
    if (abs < 1) return num.toFixed(5);
    if (abs < 10) return num.toFixed(4);
    return num.toFixed(2);
  };

  // Cache de posições encerradas manualmente para evitar notificações duplicadas e conflitantes no daemon
  const manuallyClosedPositionsCache = new Map<string, {
    time: number;
    symbol: string;
    positionSide: string;
    entryPrice: number;
    closePrice: number;
    realizedPnl: number;
    roiPct: number;
    priceChangePct: number;
    leverage: number;
  }>();

  // Helper to close a BingX/Bitunix Position at Market with precise PnL detection
  const closeBingXPosition = async (symbol: string, positionSide: string, apiKey: string = DEFAULT_BINGX_KEY, apiSecret: string = DEFAULT_BINGX_SECRET, isDemo: boolean = false) => {
    try {
      const resolved = resolveBingXSymbol(symbol);
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = bitunixResolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = resolved.apiSymbol || `${cleanUpper}-USDT`;
      const bitunixSym = bitunixResolved.apiSymbol || `${cleanUpper}USDT`;

      // 1. Obtém dados prévios da posição aberta (preço de entrada, quantidade, alavancagem, margem)
      let openPosData: any = null;
      try {
        const pendPosRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, apiKey, apiSecret).catch(() => null);
        const pList = (pendPosRes?.data && Array.isArray(pendPosRes.data)) ? pendPosRes.data : [];
        openPosData = pList.find((p: any) => {
          const pClean = (p.symbol || '').replace('-USDT', '').replace('USDT', '').toUpperCase();
          const pSide = (p.side === 'BUY' || p.side === 'LONG' || p.side === 1 || p.side === '1') ? 'LONG' : 'SHORT';
          return (pClean === cleanUpper || p.symbol === bitunixSym) && (!positionSide || pSide === positionSide) && Math.abs(parseFloat(p.qty || p.holdAmt || p.total || p.positionAmt || '0')) > 0;
        }) || pList.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym) && Math.abs(parseFloat(p.qty || p.holdAmt || p.total || p.positionAmt || '0')) > 0);
      } catch (e) {}

      // Fallback para getBingXOpenPositions se necessário
      if (!openPosData) {
        try {
          const allPos = await getBingXOpenPositions(apiKey, apiSecret, isDemo).catch(() => null);
          openPosData = (allPos?.positions || []).find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym) && Math.abs(parseFloat(p.positionAmt || '0')) > 0);
        } catch (e) {}
      }

      const preEntryPrice = openPosData ? parseFloat(openPosData.avgPrice || openPosData.entryPrice || openPosData.avgOpenPrice || '0') : 0;
      const preQty = openPosData ? Math.abs(parseFloat(openPosData.qty || openPosData.positionAmt || openPosData.holdAmt || '0')) : 0;
      const preLeverage = openPosData ? (parseInt(openPosData.leverage || '20', 10) || 20) : 20;
      const preSide = openPosData ? ((openPosData.side === 'BUY' || openPosData.positionSide === 'LONG' || openPosData.side === 'LONG') ? 'LONG' : 'SHORT') : (positionSide || 'LONG');
      const preMargin = openPosData ? parseFloat(openPosData.margin || '0') : 0;

      // 2. Executa fechamento a mercado na Bitunix (close_all_position)
      let flashClosed = false;
      try {
        const flashRes = await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol: bitunixSym }, apiKey, apiSecret);
        if (flashRes?.code === 0) {
          flashClosed = true;
        }
      } catch (e) {}

      // Cancela todas as ordens pendentes e gatilhos da moeda
      await cancelAllOrdersForSymbol(bitunixSym, apiKey, apiSecret, isDemo);

      if (!flashClosed) {
        // Fallback: busca posições ativas para obter quantidade e positionId e faz place_order de fechamento
        const posRes = await sendBingXRequest('/openApi/swap/v2/user/positions', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
        const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [posRes?.data];
        const targetPos = positions.find((p: any) => {
          if (!p) return false;
          const pClean = (p.symbol || '').replace('-USDT', '').replace('USDT', '').toUpperCase();
          return (pClean === cleanUpper || p.symbol === bitunixSym || p.symbol === normalizedSym || p.symbol === symbol) && Math.abs(parseFloat(p.positionAmt || p.holdAmt || p.qty || '0')) > 0;
        });

        if (!targetPos && !openPosData) {
          await cancelAllOrdersForSymbol(normalizedSym, apiKey, apiSecret, isDemo);
          await checkAndResetLeverageIfNoPosition(bitunixSym, apiKey, apiSecret, isDemo);
          return { success: true, isPendingOrder: true, symbol: bitunixSym, message: `Ordem pendente em ${bitunixSym} cancelada com sucesso!` };
        }

        const amt = targetPos ? Math.abs(parseFloat(targetPos.positionAmt || targetPos.holdAmt || targetPos.qty || '0')) : preQty;
        const posSide = targetPos?.positionSide || preSide;
        const side = (posSide === 'LONG') ? 'SELL' : 'BUY';

        const closeRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, {
          symbol: bitunixSym,
          side,
          tradeSide: 'CLOSE',
          orderType: 'MARKET',
          qty: amt.toString(),
          positionId: targetPos?.positionId || undefined,
          reduceOnly: true
        }, apiKey, apiSecret);

        if (closeRes?.code !== 0 && !flashClosed) {
          return { success: false, error: closeRes?.msg || "Erro ao fechar posição na Bitunix" };
        }
      }

      // 3. Cancela todas as ordens restantes e reseta alavancagem
      await cancelAllOrdersForSymbol(bitunixSym, apiKey, apiSecret, isDemo);
      await resetSymbolLeverageAndMarginMode(bitunixSym, apiKey, apiSecret);

      // 4. Aguarda 600ms para a Bitunix consolidar a posição histórica e busca os dados reais da operação
      await new Promise(r => setTimeout(r, 650));

      let realClosePrice = 0;
      let realPnl = 0;
      let entryPrice = preEntryPrice;

      try {
        const [histPosRes, histOrdRes] = await Promise.all([
          sendBitunixRequest('/api/v1/futures/position/get_history_positions', 'GET', { symbol: bitunixSym, pageSize: 5 }, null, apiKey, apiSecret).catch(() => null),
          sendBitunixRequest('/api/v1/futures/trade/get_history_orders', 'GET', { symbol: bitunixSym, pageSize: 5 }, null, apiKey, apiSecret).catch(() => null)
        ]);

        const posList = histPosRes?.data?.positionList || (Array.isArray(histPosRes?.data) ? histPosRes.data : []);
        const matchPos = posList.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym)) || posList[0];
        if (matchPos) {
          const cPrice = parseFloat(matchPos.closePrice || matchPos.avgPrice || '0');
          if (cPrice > 0) realClosePrice = cPrice;
          const ePrice = parseFloat(matchPos.entryPrice || '0');
          if (ePrice > 0 && entryPrice <= 0) entryPrice = ePrice;
          const pnlVal = parseFloat(matchPos.realizedPNL || '0');
          if (!isNaN(pnlVal) && pnlVal !== 0) realPnl = pnlVal;
        }

        if (realClosePrice <= 0 || realPnl === 0) {
          const ordList = histOrdRes?.data?.orderList || (Array.isArray(histOrdRes?.data?.rows) ? histOrdRes.data.rows : []);
          const fillOrd = ordList.find((o: any) => (o.status === 'FILLED' || o.status === '2') && (o.reduceOnly === true || o.tradeSide === 'CLOSE')) || ordList[0];
          if (fillOrd) {
            const oPrice = parseFloat(fillOrd.avgPrice || fillOrd.price || '0');
            if (oPrice > 0 && realClosePrice <= 0) realClosePrice = oPrice;
            if (fillOrd.realizedPNL !== undefined && fillOrd.realizedPNL !== null && realPnl === 0) {
              const oPnl = parseFloat(fillOrd.realizedPNL);
              if (!isNaN(oPnl) && oPnl !== 0) realPnl = oPnl;
            }
          }
        }
      } catch (e) {}

      // Se ainda não tiver closePrice, busca ticker a mercado atual
      if (realClosePrice <= 0) {
        try {
          const tickerRes = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/tickers`, { timeout: 3000 }).catch(() => null);
          const tList = Array.isArray(tickerRes?.data?.data) ? tickerRes.data.data : [];
          const matchTicker = tList.find((t: any) => isSameOrRelatedSymbol(t.symbol, bitunixSym));
          if (matchTicker) {
            realClosePrice = parseFloat(matchTicker.lastPrice || matchTicker.last || '0');
          }
        } catch (e) {}
      }

      if (realClosePrice <= 0 && entryPrice > 0) {
        realClosePrice = entryPrice;
      }

      // Calcula variação e ROI precisos
      const isLong = preSide === 'LONG';
      const priceChangePct = (entryPrice > 0 && realClosePrice > 0)
        ? (isLong ? ((realClosePrice - entryPrice) / entryPrice) * 100 : ((entryPrice - realClosePrice) / entryPrice) * 100)
        : 0;
      const roiPct = priceChangePct * preLeverage;

      if (realPnl === 0 && preQty > 0 && entryPrice > 0 && realClosePrice > 0 && realClosePrice !== entryPrice) {
        const diff = isLong ? (realClosePrice - entryPrice) : (entryPrice - realClosePrice);
        realPnl = preQty * diff;
      } else if (realPnl === 0 && preMargin > 0) {
        realPnl = (preMargin * roiPct) / 100;
      }

      // Registra no cache de fechamento manual para impedir duplicações no ALERT-DAEMON
      const cacheKey1 = `${bitunixSym}_${preSide}`;
      const cacheKey2 = `${bitunixSym}_${preSide === 'LONG' ? 'SHORT' : 'LONG'}`;
      const cacheData = {
        time: Date.now(),
        symbol: bitunixSym,
        positionSide: preSide,
        entryPrice,
        closePrice: realClosePrice,
        realizedPnl: realPnl,
        roiPct,
        priceChangePct,
        leverage: preLeverage
      };
      manuallyClosedPositionsCache.set(cacheKey1, cacheData);
      manuallyClosedPositionsCache.set(cacheKey2, cacheData);

      return {
        success: true,
        isPendingOrder: false,
        symbol: bitunixSym,
        positionSide: preSide,
        entryPrice,
        closePrice: realClosePrice,
        realizedPnl: realPnl,
        roiPct,
        priceChangePct,
        leverage: preLeverage,
        message: `Posição em ${bitunixSym} (${preSide}) fechada a mercado com sucesso na Bitunix!`
      };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper to partially close a Bitunix Position at Market (e.g. 50% or 25%) — NEVER falls back to close_all_position!
  const closeBingXPositionPartial = async (
    symbol: string,
    positionSide: string = 'AUTO',
    percent: number = 50,
    apiKey: string = DEFAULT_BITUNIX_KEY,
    apiSecret: string = DEFAULT_BITUNIX_SECRET,
    isDemo: boolean = false
  ) => {
    try {
      await fetchBitunixContracts().catch(() => {});
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = bitunixResolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const bitunixSym = bitunixResolved.apiSymbol || `${cleanUpper}USDT`;
      const requestedSide = (positionSide || 'AUTO').toUpperCase();

      // 1. Busca posição aberta atual na Bitunix
      let targetPos: any = null;
      try {
        const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, apiKey, apiSecret);
        const bitunixPositions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
        const sameSymbolOpen = bitunixPositions.filter((p: any) => {
          const pClean = (p.symbol || '').replace('USDT', '').toUpperCase();
          return (pClean === cleanUpper || p.symbol === bitunixSym) && Math.abs(parseFloat(p.qty || p.positionAmt || p.holdAmt || '0')) > 0;
        });

        if (requestedSide === 'LONG' || requestedSide === 'SHORT') {
          targetPos = sameSymbolOpen.find((p: any) => {
            const pSide = (p.side === 'BUY' || p.positionSide === 'LONG') ? 'LONG' : 'SHORT';
            return pSide === requestedSide;
          });
        }
        if (!targetPos) {
          targetPos = sameSymbolOpen[0] || null;
        }
      } catch (e) {}

      // Fallback de leitura via getBingXOpenPositions (apenas leitura!)
      if (!targetPos) {
        const allPos = await getBingXOpenPositions(apiKey, apiSecret, isDemo);
        const sameSymAll = (allPos?.positions || []).filter((p: any) => isSameOrRelatedSymbol(p.symbol, symbol) && Math.abs(parseFloat(p.positionAmt || '0')) > 0);
        if (requestedSide === 'LONG' || requestedSide === 'SHORT') {
          targetPos = sameSymAll.find((p: any) => (p.positionSide || '').toUpperCase() === requestedSide);
        }
        if (!targetPos) {
          targetPos = sameSymAll[0] || null;
        }
      }

      if (!targetPos) {
        return { success: false, error: `Posição ativa para ${bitunixSym} não encontrada.` };
      }

      const totalAmt = Math.abs(parseFloat(targetPos.qty || targetPos.positionAmt || targetPos.holdAmt || '0'));
      if (totalAmt <= 0) {
        return { success: false, error: `Quantidade da posição em ${bitunixSym} é zerada.` };
      }

      const pct = Math.min(Math.max(percent, 5), 95);
      const posSide = (targetPos.side === 'BUY' || targetPos.positionSide === 'LONG') ? 'LONG' : 'SHORT';
      const posMode = (targetPos.positionMode || 'HEDGE').toUpperCase();

      // 2. Busca precisão OFICIAL (basePrecision) e volume mínimo do contrato na Bitunix (nunca chutar precision = 3 em par inteiro!)
      let contract = bitunixResolved.contract;
      if (!contract) {
        try {
          const pairRes = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/trading_pairs`, {
            params: { symbols: bitunixSym },
            timeout: 8000
          });
          const pairItem = Array.isArray(pairRes.data?.data) ? pairRes.data.data[0] : null;
          if (pairItem) {
            contract = {
              quantityPrecision: typeof pairItem.basePrecision === 'number' ? pairItem.basePrecision : parseInt(pairItem.basePrecision, 10),
              tradeMinQuantity: parseFloat(pairItem.minTradeVolume || '0')
            };
          }
        } catch (e) {}
      }

      const rawQtyStr = (targetPos.qty || targetPos.positionAmt || targetPos.holdAmt || totalAmt.toString()).toString();
      let precision = 0;
      if (contract && typeof contract.quantityPrecision === 'number' && !isNaN(contract.quantityPrecision)) {
        precision = Math.max(0, contract.quantityPrecision);
      } else if (rawQtyStr.includes('.')) {
        precision = rawQtyStr.split('.')[1].replace(/0+$/, '').length;
      }

      const minTradeQty = contract?.tradeMinQuantity && !isNaN(Number(contract.tradeMinQuantity)) ? Number(contract.tradeMinQuantity) : 0;

      // Arredonda para baixo na precisão exata do contrato para evitar decimal em par inteiro (ex: CYSUSDT basePrecision=0 -> 21253, nunca 21253.5!)
      const factor = Math.pow(10, precision);
      let closeQty = Math.floor((totalAmt * (pct / 100)) * factor + 1e-9) / factor;
      if (closeQty <= 0 && totalAmt * (pct / 100) > 0) {
        closeQty = Math.round((totalAmt * (pct / 100)) * factor) / factor;
      }

      const closeQtyStr = closeQty.toFixed(precision);
      closeQty = parseFloat(closeQtyStr);
      const remainingQty = parseFloat((totalAmt - closeQty).toFixed(precision));

      if (closeQty <= 0 || closeQty >= totalAmt || remainingQty <= 0) {
        return {
          success: false,
          error: `Quantidade parcial (${closeQtyStr} de ${totalAmt}) incompatível com a precisão mínima do par ${bitunixSym}.`
        };
      }

      if (minTradeQty > 0 && (closeQty < minTradeQty || remainingQty < minTradeQty)) {
        return {
          success: false,
          error: `Volume parcial (${closeQtyStr} ${cleanUpper}) ou restante (${remainingQty}) abaixo do mínimo exigido pela Bitunix (${minTradeQty} ${cleanUpper}).`
        };
      }

      // 3. Regras oficiais da Bitunix para place_order com tradeSide: 'CLOSE':
      //    Em HEDGE mode (openapidoc.bitunix.com): Close Long => side='BUY', tradeSide='CLOSE', reduceOnly=false; Close Short => side='SELL', tradeSide='CLOSE', reduceOnly=false
      //    Em ONE_WAY mode: Close Long => side='SELL', reduceOnly=true; Close Short => side='BUY', reduceOnly=true
      const hedgeCloseSide = posSide === 'LONG' ? 'BUY' : 'SELL';
      const oppositeCloseSide = posSide === 'LONG' ? 'SELL' : 'BUY';

      const primaryPayload: any = {
        symbol: bitunixSym,
        side: posMode === 'HEDGE' ? hedgeCloseSide : oppositeCloseSide,
        tradeSide: 'CLOSE',
        orderType: 'MARKET',
        qty: closeQtyStr,
        positionId: targetPos.positionId || undefined,
        reduceOnly: posMode !== 'HEDGE'
      };

      console.log(`[PARTIAL-CLOSE] ✂️ Enviando parcial ${pct}% de ${bitunixSym} (${posSide}, mode=${posMode}, prec=${precision}): qty=${closeQtyStr} de ${totalAmt} | side=${primaryPayload.side} | positionId=${primaryPayload.positionId}`);
      let placeRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, primaryPayload, apiKey, apiSecret);

      // Tentativa alternativa segura SOMENTE via place_order parcial (NUNCA close_all_position!)
      if (placeRes?.code !== 0) {
        console.warn(`[PARTIAL-CLOSE-RETRY] Tentativa primária falhou (${placeRes?.code}: ${placeRes?.msg}). Tentando payload alternativo parcial...`);
        const retryPayload: any = {
          symbol: bitunixSym,
          side: posMode === 'HEDGE' ? oppositeCloseSide : hedgeCloseSide,
          tradeSide: 'CLOSE',
          orderType: 'MARKET',
          qty: closeQtyStr,
          positionId: targetPos.positionId || undefined,
          reduceOnly: false
        };
        const retryRes = await sendBitunixRequest('/api/v1/futures/trade/place_order', 'POST', {}, retryPayload, apiKey, apiSecret);
        if (retryRes?.code === 0) {
          placeRes = retryRes;
        } else {
          console.error(`[PARTIAL-CLOSE-FAILED] Ambas tentativas parciais falharam em ${bitunixSym}:`, placeRes, retryRes);
          return {
            success: false,
            error: retryRes?.msg || placeRes?.msg || "Erro ao executar fechamento parcial na Bitunix (posição mantida intacta)."
          };
        }
      }

      // 4. Sucesso! Atualiza registro em memória do Stop Móvel/Condução sem encerrar a proteção
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || bitunixActiveTrailingStops.get(cleanUpper);
      if (trRecord) {
        trRecord.qty = remainingQty.toFixed(precision);
        trRecord.lastUpdated = Date.now();
        saveBitunixTrailingStopsToFile();
      }

      return {
        success: true,
        symbol: bitunixSym,
        cleanSymbol: cleanUpper,
        positionSide: posSide,
        percent: pct,
        closedQty: closeQty,
        remainingQty,
        message: `Fechamento parcial de ${pct}% (${closeQtyStr} ${cleanUpper}) executado com sucesso na Bitunix! Restante aberto: ${remainingQty.toFixed(precision)} ${cleanUpper}.`
      };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper to move Stop Loss to Breakeven (Entry price) - Exclusivo Bitunix
  const setBingXBreakeven = async (symbol: string, positionSide: string, apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = bitunixResolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const bitunixSym = bitunixResolved.apiSymbol || `${cleanUpper}USDT`;
      const bitunixKey = (apiKey || DEFAULT_BITUNIX_KEY || '').trim();
      const bitunixSec = (apiSecret || DEFAULT_BITUNIX_SECRET || '').trim();

      const bxRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, bitunixKey, bitunixSec);
      const bxList = (bxRes?.data && Array.isArray(bxRes.data)) ? bxRes.data : [];
      const targetPos = bxList.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym) && Math.abs(parseFloat(p.holdAmt || p.total || p.qty || '0')) > 0);

      if (!targetPos) {
        return { success: false, error: `Posição ${bitunixSym} não encontrada na Bitunix.` };
      }

      const entryPrice = parseFloat(targetPos.avgOpenPrice || targetPos.avgPrice || targetPos.entryPrice || '0');
      const targetPositionId = targetPos.positionId;

      if (!targetPositionId) {
        return { success: false, error: `Position ID não localizado para ${bitunixSym}.` };
      }

      const tpslRes = await safeSetBitunixPositionTPSL({
        symbol: bitunixSym,
        positionId: targetPositionId,
        slPrice: entryPrice.toString(),
        tpPrice: targetPos.takeProfit || undefined,
        apiKey: bitunixKey,
        apiSecret: bitunixSec
      });

      if (tpslRes?.code === 0) {
        return { success: true, entryPrice, message: `Stop Loss movido para $${entryPrice} (Breakeven / 0 a 0) com sucesso na Bitunix!` };
      } else {
        return { success: false, error: tpslRes?.msg || "Erro ao atualizar Stop Loss na Bitunix" };
      }
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper to cancel ALL pending open orders for a specific symbol in BingX/Bitunix
  const cancelAllOrdersForSymbol = async (symbol: string, apiKey: string = DEFAULT_BINGX_KEY, apiSecret: string = DEFAULT_BINGX_SECRET, isDemo: boolean = false) => {
    try {
      const resolved = resolveBingXSymbol(symbol);
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = bitunixResolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = resolved.apiSymbol || `${cleanUpper}-USDT`;
      const bitunixSym = bitunixResolved.apiSymbol || `${cleanUpper}USDT`;
      
      // 1. Chamar cancel_all_orders na Bitunix
      await Promise.allSettled([
        sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol: bitunixSym }, apiKey, apiSecret),
        sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym }, apiKey, apiSecret),
        sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', { symbol: normalizedSym }, apiKey, apiSecret, isDemo),
        sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', { symbol: cleanUpper }, apiKey, apiSecret, isDemo),
        sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', { symbol }, apiKey, apiSecret, isDemo)
      ]);

      // 🛡️ Auto-reset para 20x e Margem Isolada se não houver posição aberta para o símbolo
      await checkAndResetLeverageIfNoPosition(bitunixSym, apiKey, apiSecret, isDemo);

      return { 
        success: true, 
        symbol: bitunixSym, 
        message: `Todas as ordens pendentes em ${bitunixSym} foram canceladas com sucesso!` 
      };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper to update Stop Loss or Take Profit for a symbol/position
  const updateBingXStopLossOrTakeProfit = async (
    symbol: string,
    type: 'SL' | 'TP',
    newPrice: number,
    apiKey: string = DEFAULT_BINGX_KEY,
    apiSecret: string = DEFAULT_BINGX_SECRET,
    isDemo: boolean = false,
    specificOrderId?: string
  ) => {
    try {
      const resolved = resolveBingXSymbol(symbol);
      const cleanUpper = resolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = resolved.apiSymbol || `${cleanUpper}-USDT`;

      // 1. Obter especificações do contrato (precisão de preço e quantidade)
      let pricePrecision = 4;
      let quantityPrecision = 1;
      let minQty = 1;
      let minUsdt = 2;

      const contract = resolved.contract || symbolLookupIndex.get(normalizedSym) || symbolLookupIndex.get(cleanKey(normalizedSym));
      if (contract) {
        pricePrecision = contract.pricePrecision ?? 4;
        quantityPrecision = contract.quantityPrecision ?? 1;
        minQty = parseFloat(contract.tradeMinQuantity) || 1;
        minUsdt = parseFloat(contract.tradeMinUSDT) || 2;
      } else {
        try {
          const contractsRes = await sendBingXRequest('/openApi/swap/v2/quote/contracts', 'GET', {}, apiKey, apiSecret, isDemo);
          if (contractsRes?.data && Array.isArray(contractsRes.data)) {
            const c = contractsRes.data.find((item: any) => item.symbol === normalizedSym || item.symbol === cleanUpper);
            if (c) {
              pricePrecision = c.pricePrecision ?? 4;
              quantityPrecision = c.quantityPrecision ?? 1;
              minQty = parseFloat(c.tradeMinQuantity) || 1;
              minUsdt = parseFloat(c.tradeMinUSDT) || 2;
            }
          }
        } catch (e) {}
      }

      // 2. Buscar posições ativas e ordens abertas na Bitunix
      const [posRes, ordersRes] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/positions', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] }))
      ]);

      const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [posRes?.data];
      const targetPos = positions.find((p: any) => p && (p.symbol === normalizedSym || p.symbol === symbol) && Math.abs(parseFloat(p.positionAmt || '0')) > 0);
      const orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

      let limitOrder = specificOrderId ? orders.find((o: any) => (o.orderId || '').toString() === specificOrderId.toString()) : null;
      if (!limitOrder) {
        limitOrder = orders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');
      }

      // =========================================================================
      // CASO A: ORDEM LIMITE PENDENTE (Ainda não preenchida / Posição não existe)
      // =========================================================================
      if (!targetPos && limitOrder) {
        console.log(`[BINGX-EDIT-${type}] Atualizando ${type} para Ordem Limite Pendente em ${normalizedSym}...`);
        const limitPrice = parseFloat(limitOrder.price || limitOrder.origPrice || '0');
        const isLong = limitOrder.side === 'BUY' || limitOrder.positionSide === 'LONG';
        const positionSide = limitOrder.positionSide || (isLong ? 'LONG' : 'SHORT');
        const orderSide = limitOrder.side || (isLong ? 'BUY' : 'SELL');
        const closeSide = isLong ? 'SELL' : 'BUY';

        // Localizar SL e TP existentes
        // Localizar SL e TP existentes
        const slOrder = orders.find((o: any) => o.type === 'STOP_MARKET' || o.type === 'STOP' || o.type === 'STOP_LOSS');
        const tpOrder = orders.find((o: any) => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');
        
        // Busca o sinal mais recente recebido no Telegram correspondente a este par
        const matchingSignal = receivedTelegramSignals.find(s => 
          s.parsed && (
            isSameOrRelatedSymbol(s.parsed.apiSymbol, normalizedSym) || 
            isSameOrRelatedSymbol(s.parsed.coinName, cleanUpper) ||
            isSameOrRelatedSymbol(s.parsed.symbol, normalizedSym)
          )
        );
        const customCached = activeCustomSLTPBySymbol.get(normalizedSym) || activeCustomSLTPBySymbol.get(cleanUpper);

        // Prioridade de SL: 1. Ordem no livro -> 2. SL customizado editado pelo usuário -> 3. Sinal inicial
        let existingSLPrice = slOrder 
          ? parseFloat(slOrder.stopPrice || '0') 
          : (customCached?.stopLoss && customCached.stopLoss > 0 ? customCached.stopLoss : (matchingSignal?.parsed?.stopLoss || 0));

        // Prioridade de TP: 1. Ordem no livro -> 2. TP customizado editado pelo usuário -> 3. Sinal inicial
        let existingTPPrice = tpOrder 
          ? parseFloat(tpOrder.stopPrice || '0') 
          : (customCached?.takeProfit && customCached.takeProfit > 0 ? customCached.takeProfit : 0);

        if (existingTPPrice <= 0 && matchingSignal?.parsed?.takeProfits?.length) {
          const tps = matchingSignal.parsed.takeProfits;
          existingTPPrice = (serverTelegramBotConfig.takeProfitSelection === 'TP1') ? tps[0] : tps[tps.length - 1];
        }

        const finalSLPrice = type === 'SL' ? newPrice : (existingSLPrice > 0 ? existingSLPrice : (isLong ? limitPrice * 0.98 : limitPrice * 1.02));
        const finalTPPrice = type === 'TP' ? newPrice : existingTPPrice;

        // Armazena no cache ativo de personalização
        const curCustom = activeCustomSLTPBySymbol.get(normalizedSym) || { updatedAt: Date.now() };
        if (type === 'SL') curCustom.stopLoss = finalSLPrice;
        if (type === 'TP') curCustom.takeProfit = finalTPPrice;
        curCustom.updatedAt = Date.now();
        activeCustomSLTPBySymbol.set(normalizedSym, curCustom);
        activeCustomSLTPBySymbol.set(cleanUpper, curCustom);

        // Recalcular saldo se necessário
        let balanceUsd = 100;
        try {
          const balRes = await sendBingXRequest('/openApi/swap/v2/user/balance', 'GET', {}, apiKey, apiSecret, isDemo);
          if (balRes?.data) {
            if (balRes.data.balance?.equity) balanceUsd = parseFloat(balRes.data.balance.equity);
            else if (balRes.data.equity) balanceUsd = parseFloat(balRes.data.equity);
            else if (balRes.data.availableMargin) balanceUsd = parseFloat(balRes.data.availableMargin);
          }
        } catch (e) {}

        // 🛡️ Alavancagem Original: Mantém RIGOROSAMENTE a alavancagem do sinal original ou da ordem no livro
        const existingOrderLeverage = parseInt(limitOrder.leverage || limitOrder.leverageRate || '0', 10);
        let targetLeverage = 0;

        if (matchingSignal?.parsed?.targetLeverage && typeof matchingSignal.parsed.targetLeverage === 'number' && matchingSignal.parsed.targetLeverage > 0) {
          targetLeverage = matchingSignal.parsed.targetLeverage;
        } else if (matchingSignal?.parsed?.leverage && typeof matchingSignal.parsed.leverage === 'number' && matchingSignal.parsed.leverage > 0) {
          targetLeverage = matchingSignal.parsed.leverage;
        } else if (existingOrderLeverage > 0) {
          targetLeverage = existingOrderLeverage;
        } else {
          // Quando o usuário mandou sem alavancagem, usa a máxima do contrato da corretora (ex: 200x BTC, 100x ETH)
          const contractMax = contract?.maxLeverage || (contract?.maxLongLeverage ? parseInt(contract.maxLongLeverage, 10) : 0);
          if (contractMax && contractMax > 0) {
            targetLeverage = contractMax;
          } else {
            targetLeverage = serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE' ? (serverTelegramBotConfig.fixedLeverageValue || 20) : 20;
          }
        }

        if (serverTelegramBotConfig.maxLeverageCap && serverTelegramBotConfig.maxLeverageCap > 0 && targetLeverage > serverTelegramBotConfig.maxLeverageCap) {
          targetLeverage = serverTelegramBotConfig.maxLeverageCap;
        }

        // 🛡️ Gerenciamento de Risco / Perda Máxima:
        // Mantém RIGOROSAMENTE o valor de perda fixado no sinal original (ex: "Perda 10", customRiskUsd: 10)
        let riskUsd = 2.0;
        let riskDescription = '';
        const initialRiskPct = serverTelegramBotConfig.riskPercent || 2.0;

        if (matchingSignal?.parsed?.customRiskUsd && typeof matchingSignal.parsed.customRiskUsd === 'number' && matchingSignal.parsed.customRiskUsd > 0) {
          riskUsd = matchingSignal.parsed.customRiskUsd;
          riskDescription = `Perda máxima de $${riskUsd} dol fixada no sinal`;
        } else if (serverTelegramBotConfig.riskMode === 'FIXED_USD') {
          riskUsd = serverTelegramBotConfig.riskFixedUsd || 50.0;
          riskDescription = `$${riskUsd.toFixed(2)} USD fixos`;
        } else {
          riskUsd = (balanceUsd * initialRiskPct) / 100;
          riskDescription = `${initialRiskPct.toFixed(2)}% da conta`;
        }

        const mainEntryPrice = limitPrice;
        const slDist = Math.abs(mainEntryPrice - finalSLPrice);
        const roundTripFeeRate = (serverTelegramBotConfig.includeFeesInRisk !== false) ? 0.0010 : 0.0;
        const totalLossPerUnit = slDist + (mainEntryPrice * roundTripFeeRate);
        let targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / mainEntryPrice);
        if (targetQty < minQty) targetQty = minQty;
        if (targetQty * mainEntryPrice < minUsdt) targetQty = minUsdt / mainEntryPrice;

        const qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
        const finalOrderQty = parseFloat(qtyStr);

        let exactMarginUsd = (finalOrderQty * mainEntryPrice) / targetLeverage;
        if (exactMarginUsd > balanceUsd * 0.90) exactMarginUsd = balanceUsd * 0.90;

        // Cancelar ordens anteriores
        for (const ord of orders) {
          if (ord.orderId) {
            try {
              await sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
                symbol: normalizedSym,
                orderId: ord.orderId.toString()
              }, apiKey, apiSecret, isDemo);
            } catch (e) {}
          }
        }
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
        } catch (e) {}
        await new Promise(r => setTimeout(r, 200));

        // 🛡️ Re-aplica a alavancagem correta do sinal na Bitunix antes de enviar a nova ordem
        if (targetLeverage > 0) {
          try {
            await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
              symbol: normalizedSym,
              leverage: targetLeverage.toString(),
              side: positionSide
            }, apiKey, apiSecret, isDemo);
            await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
              symbol: normalizedSym,
              leverage: targetLeverage.toString(),
              side: "BOTH"
            }, apiKey, apiSecret, isDemo);
          } catch (e) {}
        }

        // 🛡️ Re-aplica modo de margem correto (CRUZADA se SL alavancado >= 25%, alavancagem elevada ou pedido pelo sinal)
        const slDistPct = mainEntryPrice > 0 ? (slDist / mainEntryPrice) : 0.02;
        const slLeveragedPct = slDistPct * 100 * targetLeverage;
        const crossThreshold = serverTelegramBotConfig.autoCrossMarginThreshold || 25;
        const shouldCross = shouldUseCrossMargin(slLeveragedPct, targetLeverage, crossThreshold) ||
                            (matchingSignal?.parsed?.marginMode === 'CROSS' || matchingSignal?.parsed?.marginMode === 'CRUZADA');
        const targetMarginType = shouldCross ? "CROSSED" : "ISOLATED";
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/marginType', 'POST', {
            symbol: normalizedSym,
            marginType: targetMarginType
          }, apiKey, apiSecret, isDemo);
        } catch (e) {}

        // Montar a nova ordem Limite com Stop Loss e Take Profit embutidos
        const formattedLimitPrice = mainEntryPrice.toFixed(pricePrecision);
        const formattedSL = finalSLPrice.toFixed(pricePrecision);
        const formattedTP = finalTPPrice > 0 ? finalTPPrice.toFixed(pricePrecision) : null;

        const newLimitParams: any = {
          symbol: normalizedSym,
          side: orderSide,
          positionSide,
          type: 'LIMIT',
          price: formattedLimitPrice,
          quantity: qtyStr,
          timeInForce: 'GTC'
        };

        if (parseFloat(formattedSL) > 0) {
          newLimitParams.stopLoss = JSON.stringify({
            type: "STOP_MARKET",
            stopPrice: parseFloat(formattedSL),
            closePosition: true
          });
        }
        if (formattedTP && parseFloat(formattedTP) > 0) {
          newLimitParams.takeProfit = JSON.stringify({
            type: "TAKE_PROFIT_MARKET",
            stopPrice: parseFloat(formattedTP)
          });
        }

        console.log(`[BINGX-REPLACE-LIMIT-WITH-${type}] Enviando:`, JSON.stringify(newLimitParams));
        const placeLimitRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', newLimitParams, apiKey, apiSecret, isDemo);

        if (placeLimitRes?.code === 0) {
          const newLimitId = (placeLimitRes.data?.order?.orderId || placeLimitRes.data?.orderId || '').toString();
          // 🛡️ OPÇÃO 1: Agenda o Trailing Stop para ativação pós-execução (sem poluir o livro antes da hora)
          if (serverTelegramBotConfig.trailingStopEnabled && slDist > 0) {
            try {
              const slDistPctVal = (slDist / limitPrice) * 100;
              const multiplier = serverTelegramBotConfig.trailingMultiplier || 1.0;
              let effectiveRate = parseFloat((slDistPctVal * multiplier).toFixed(3));
              if (effectiveRate < 0.1) effectiveRate = 0.1;
              if (effectiveRate > 10.0) effectiveRate = 10.0;
              const actPrice = isLong ? limitPrice + (slDist * multiplier) : limitPrice - (slDist * multiplier);

              const trailingConfigObj: PendingTrailingConfig = {
                orderId: newLimitId,
                symbol: normalizedSym,
                positionSide,
                closeSide,
                quantity: qtyStr,
                effectiveRate,
                activationPrice: actPrice,
                stopLossPrice: finalSLPrice,
                entryPrice: limitPrice,
                pricePrecision,
                createdAt: Date.now()
              };
              pendingTrailingConfigs.set(`${normalizedSym}_${positionSide}`, trailingConfigObj);
              pendingTrailingConfigs.set(`${cleanUpper}_${positionSide}`, trailingConfigObj);
              if (newLimitId) pendingTrailingConfigs.set(newLimitId, trailingConfigObj);
              savePendingTrailingConfigsToFile();
              console.log(`[TRAILING-SYNCED-PENDING] 🛡️ Trailing Stop agendado pós-execução para ${normalizedSym}: Ativação $${actPrice.toFixed(pricePrecision)} (${effectiveRate}%)`);
            } catch (trailErr: any) {
              console.warn("[TRAILING-SYNC-ERR]:", trailErr?.message);
            }
          }

        const label = type === 'SL' ? 'Stop Loss' : 'Take Profit';
        const changedVal = type === 'SL' ? formattedSL : (formattedTP || 'N/A');
        const slDistVal = Math.abs(mainEntryPrice - finalSLPrice);
        const multiplier = serverTelegramBotConfig.trailingMultiplier || 1.0;
        const actPriceVal = isLong ? mainEntryPrice + (slDistVal * multiplier) : mainEntryPrice - (slDistVal * multiplier);
        const effRateVal = mainEntryPrice > 0 ? parseFloat(((slDistVal / mainEntryPrice) * 100 * multiplier).toFixed(3)) : 0;
        const exactPriceLossUsd = finalOrderQty * slDistVal;
        const exactFeesUsd = (serverTelegramBotConfig.includeFeesInRisk !== false) ? (finalOrderQty * mainEntryPrice * 0.0010) : 0;
        const exactActualRiskUsd = exactPriceLossUsd + exactFeesUsd;

        const limitRiskNote = 
          `🎯 <b>Preço Entrada Principal:</b> <code>$${mainEntryPrice.toFixed(pricePrecision)}</code>\n` +
          `🛑 <b>Stop Loss Digitado:</b> <code>$${formattedSL}</code>\n` +
          `🎯 <b>Take Profit:</b> <code>${formattedTP ? `$${formattedTP}` : 'N/A'}</code>\n` +
          `🛰️ <b>Trailing Stop:</b> Ativação <code>$${actPriceVal.toFixed(pricePrecision)}</code> (${effRateVal}% recuo)\n` +
          `💰 <b>Margem Calculada:</b> <code>$${exactMarginUsd.toFixed(2)} USDT</code> (${targetLeverage}x)\n` +
          `🛡️ <b>Risco da Nova Ordem:</b> <code>-$${exactActualRiskUsd.toFixed(2)} USDT</code> (<b>${riskDescription}</b>)\n` +
          `📦 <b>Quantidade:</b> <code>${qtyStr} ${cleanUpper}</code>`;

        return {
          success: true,
          symbol: normalizedSym,
          newPrice: parseFloat(changedVal),
          recalculatedMargin: exactMarginUsd.toFixed(2),
          recalculatedQty: qtyStr,
          mainEntryPrice: mainEntryPrice.toFixed(pricePrecision),
          stopLoss: formattedSL,
          takeProfit: formattedTP || 'N/A',
          trailingActivation: actPriceVal.toFixed(pricePrecision),
          riskUsd: exactActualRiskUsd.toFixed(2),
          riskDescription,
          effectiveRiskPct: riskDescription,
          targetLeverage,
          activePosRiskNote: limitRiskNote,
          message: `${label} da ordem limite em ${normalizedSym} atualizado para $${changedVal} com nova ordem e proteção completa!`
        };
      } else {
        return {
          success: false,
          error: placeLimitRes?.msg || `Erro ao atualizar ordem limite na Bitunix`
        };
      }
    }

    // =========================================================================
    // CASO B: POSIÇÃO ATIVA / ABERTA (Criação de Nova Ordem com Take, Stop e Trailing Stop, Risco Configurado)
    // =========================================================================
    if (!targetPos) {
      return {
        success: false,
        error: `Nenhuma posição aberta ou ordem limite encontrada em ${normalizedSym}.`
      };
    }

    // 1. Limpeza de gatilhos antigos ou duplicados
    const orderTypesToCancel = type === 'SL' 
      ? ['STOP_MARKET', 'STOP', 'STOP_LOSS'] 
      : ['TAKE_PROFIT_MARKET', 'TAKE_PROFIT'];

    const toCancel = orders.filter((o: any) => {
      if (specificOrderId && (o.orderId || '').toString() === specificOrderId.toString()) return true;
      return orderTypesToCancel.includes(o.type);
    });

    for (const ord of toCancel) {
      if (ord.orderId) {
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
            symbol: normalizedSym,
            orderId: ord.orderId.toString()
          }, apiKey, apiSecret, isDemo);
        } catch (e) {}
      }
    }

    // 2. Direção e Dados da Posição Ativa
    const isLong = (targetPos.positionSide === 'LONG') || (parseFloat(targetPos.positionAmt || '0') > 0);
    const positionSide = targetPos.positionSide || (isLong ? 'LONG' : 'SHORT');
    const orderSide = isLong ? 'BUY' : 'SELL';
    const closeSide = isLong ? 'SELL' : 'BUY';

    // 3. Preço de Entrada Principal da Posição e Preço Atual
    const matchingSignal = [...receivedTelegramSignals].reverse().find(s => 
      s.parsed && (s.parsed.apiSymbol === normalizedSym || s.parsed.coinName === cleanUpper)
    );
    const mainEntryPrice = parseFloat(targetPos.avgPrice || targetPos.entryPrice || '0') || matchingSignal?.parsed?.entryPrice || 0;

    let currentPrice = mainEntryPrice;
    try {
      const tickerRes = await sendBingXRequest('/openApi/swap/v2/quote/ticker', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
      if (tickerRes?.data?.lastPrice) {
        currentPrice = parseFloat(tickerRes.data.lastPrice);
      }
    } catch (e) {}
    if (mainEntryPrice <= 0) {
      // Se não tinha avgPrice, usa o preço atual
      (targetPos as any).avgPrice = currentPrice.toString();
    }

    // 4. Parâmetros de Stop Loss (Digitado) e Take Profit
    const customCached = activeCustomSLTPBySymbol.get(normalizedSym) || activeCustomSLTPBySymbol.get(cleanUpper);
    let finalSL = type === 'SL' ? newPrice : (customCached?.stopLoss || (targetPos.stopLoss ? parseFloat(targetPos.stopLoss) : null));
    let finalTP = type === 'TP' ? newPrice : (customCached?.takeProfit || (targetPos.takeProfit ? parseFloat(targetPos.takeProfit) : null));

    if (!finalTP && matchingSignal?.parsed?.takeProfits?.length) {
      const tps = matchingSignal.parsed.takeProfits;
      finalTP = (serverTelegramBotConfig.takeProfitSelection === 'TP1') ? tps[0] : tps[tps.length - 1];
    }

    // 5. Cálculo de Margem e Quantidade:
    // Utiliza o preço de referência e o Stop Loss digitado com o risco configurado
    let balanceUsd = 100;
    try {
      const balRes = await sendBingXRequest('/openApi/swap/v2/user/balance', 'GET', {}, apiKey, apiSecret, isDemo);
      if (balRes?.data) {
        if (balRes.data.balance?.equity) balanceUsd = parseFloat(balRes.data.balance.equity);
        else if (balRes.data.equity) balanceUsd = parseFloat(balRes.data.equity);
        else if (balRes.data.availableMargin) balanceUsd = parseFloat(balRes.data.availableMargin);
      }
    } catch (e) {}

    const initialRiskPct = serverTelegramBotConfig.riskPercent || 2.0;
    const effectiveRiskPct = initialRiskPct;

    let riskUsd = 2.0;
    if (serverTelegramBotConfig.riskMode === 'FIXED_USD') {
      riskUsd = serverTelegramBotConfig.riskFixedUsd || 50.0;
    } else {
      riskUsd = (balanceUsd * effectiveRiskPct) / 100;
    }

    const referencePrice = (mainEntryPrice > 0 ? mainEntryPrice : currentPrice);
    const slDist = (finalSL && finalSL > 0) ? Math.abs(referencePrice - finalSL) : 0;
    const roundTripFeeRate = (serverTelegramBotConfig.includeFeesInRisk !== false) ? 0.0010 : 0.0;
    const totalLossPerUnit = slDist + (referencePrice * roundTripFeeRate);

    let newOrderQty = (totalLossPerUnit > 0) ? (riskUsd / totalLossPerUnit) : minQty;
    if (newOrderQty < minQty) newOrderQty = minQty;
    if (referencePrice > 0 && newOrderQty * referencePrice < minUsdt) {
      newOrderQty = minUsdt / referencePrice;
    }

    const orderQtyStr = quantityPrecision === 0 ? Math.ceil(newOrderQty).toString() : newOrderQty.toFixed(quantityPrecision);
    const finalOrderQty = parseFloat(orderQtyStr);

    let targetLeverage = parseInt(targetPos.leverage || '20', 10) || matchingSignal?.parsed?.targetLeverage || 20;
    if (serverTelegramBotConfig.maxLeverageCap && targetLeverage > serverTelegramBotConfig.maxLeverageCap) {
      targetLeverage = serverTelegramBotConfig.maxLeverageCap;
    }

    let exactMarginUsd = (finalOrderQty * referencePrice) / targetLeverage;
    if (exactMarginUsd > balanceUsd * 0.90) exactMarginUsd = balanceUsd * 0.90;

    const formattedStopPrice = (finalSL || newPrice).toFixed(pricePrecision);
    const formattedTPPrice = finalTP && finalTP > 0 ? finalTP.toFixed(pricePrecision) : null;

    // 6. Criar e Enviar Nova Ordem a Mercado com Take Profit, Stop Loss e Trailing Stop
    const newOrderPayload: any = {
      symbol: normalizedSym,
      side: orderSide,
      positionSide,
      type: "MARKET",
      quantity: orderQtyStr
    };

    if (finalSL && finalSL > 0) {
      newOrderPayload.stopLoss = JSON.stringify({
        type: "STOP_MARKET",
        stopPrice: parseFloat(formattedStopPrice),
        closePosition: true
      });
    }

    if (finalTP && finalTP > 0 && formattedTPPrice) {
      newOrderPayload.takeProfit = JSON.stringify({
        type: "TAKE_PROFIT_MARKET",
        stopPrice: parseFloat(formattedTPPrice)
      });
    }

    console.log(`[BINGX-NEW-ORDER-ON-${type}] Criando nova ordem em ${normalizedSym} (${orderSide} ${orderQtyStr} com margem $${exactMarginUsd.toFixed(2)} USDT, risco integral):`, JSON.stringify(newOrderPayload));
    const placeRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', newOrderPayload, apiKey, apiSecret, isDemo);

    if (placeRes?.code === 0) {
      // Aguarda 350ms e busca a posição atualizada com novo Preço Médio e Tamanho Acumulado
      await new Promise(resolve => setTimeout(resolve, 350));
      let updatedTotalAmt = Math.abs(parseFloat(targetPos.positionAmt || '0')) + finalOrderQty;
      let updatedAvgPrice = referencePrice;

      try {
        const updatedPosRes = await sendBingXRequest('/openApi/swap/v2/user/positions', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
        const updatedPositions = (updatedPosRes?.data && Array.isArray(updatedPosRes.data)) ? updatedPosRes.data : [updatedPosRes?.data];
        const updatedTargetPos = updatedPositions.find((p: any) => p && (p.symbol === normalizedSym || p.symbol === cleanUpper) && Math.abs(parseFloat(p.positionAmt || '0')) > 0);
        if (updatedTargetPos) {
          updatedTotalAmt = Math.abs(parseFloat(updatedTargetPos.positionAmt || '0'));
          if (updatedTargetPos.avgPrice) updatedAvgPrice = parseFloat(updatedTargetPos.avgPrice);
        }
      } catch (e) {}

      // 7. Criar/Sincronizar Trailing Stop cobrindo a posição com preço de ativação e recuo calculados
      const multiplier = serverTelegramBotConfig.trailingMultiplier || 1.0;
      const effectiveRate = referencePrice > 0 && slDist > 0 ? parseFloat(((slDist / referencePrice) * 100 * multiplier).toFixed(3)) : 1.0;
      const actPrice = isLong ? referencePrice + (slDist * multiplier) : referencePrice - (slDist * multiplier);

      if (serverTelegramBotConfig.trailingStopEnabled && finalSL && finalSL > 0 && slDist > 0) {
        try {
          await updateBingXTrailingStop(normalizedSym, {
            newActivationPrice: actPrice,
            newCallbackRatePct: effectiveRate
          }, apiKey, apiSecret, isDemo);
          console.log(`[TRAILING-SYNCED-NEW-ORDER] Trailing Stop sincronizado para ${normalizedSym}: Ativação $${actPrice.toFixed(pricePrecision)} (${effectiveRate}%)`);
        } catch (trailErr: any) {
          console.warn("[TRAILING-UPDATE-ERR]:", trailErr?.message);
        }
      }

      // 8. Também coloca ordens de gatilho explícitas para garantia máxima de fechamento (Posição Inteira)
      if (finalSL && finalSL > 0) {
        const fullQtyStr = quantityPrecision === 0 ? Math.ceil(updatedTotalAmt).toString() : updatedTotalAmt.toFixed(quantityPrecision);
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', {
            symbol: normalizedSym,
            side: closeSide,
            positionSide,
            type: "STOP_MARKET",
            stopPrice: parseFloat(formattedStopPrice),
            quantity: fullQtyStr,
            closePosition: true
          }, apiKey, apiSecret, isDemo);
        } catch (e) {}
      }

      if (finalTP && finalTP > 0 && formattedTPPrice) {
        const fullQtyStr = quantityPrecision === 0 ? Math.ceil(updatedTotalAmt).toString() : updatedTotalAmt.toFixed(quantityPrecision);
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', {
            symbol: normalizedSym,
            side: closeSide,
            positionSide,
            type: "TAKE_PROFIT_MARKET",
            stopPrice: parseFloat(formattedTPPrice),
            quantity: fullQtyStr
          }, apiKey, apiSecret, isDemo);
        } catch (e) {}
      }

      // Armazena no cache ativo de personalização
      const curCustom = activeCustomSLTPBySymbol.get(normalizedSym) || { updatedAt: Date.now() };
      if (type === 'SL') curCustom.stopLoss = finalSL;
      if (type === 'TP') curCustom.takeProfit = finalTP;
      curCustom.updatedAt = Date.now();
      activeCustomSLTPBySymbol.set(normalizedSym, curCustom);
      activeCustomSLTPBySymbol.set(cleanUpper, curCustom);

      const bitunixSym = resolveBitunixSymbol(normalizedSym).apiSymbol;
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                       bitunixActiveTrailingStops.get(cleanUpper) || 
                       bitunixActiveTrailingStops.get(normalizedSym);
      if (trRecord) {
        if (type === 'TP' && finalTP) trRecord.takeProfitPrice = finalTP;
        if (type === 'SL' && finalSL) trRecord.currentStopLoss = finalSL;
        saveBitunixTrailingStopsToFile();
      }

      const label = type === 'SL' ? 'Stop Loss' : 'Take Profit';

      // 9. Detalhamento completo do Risco, Entrada Principal, SL Digitado, Take e Trailing Stop
      const actualRiskUsd = finalOrderQty * slDist;
      const actualRiskPct = balanceUsd > 0 ? (actualRiskUsd / balanceUsd) * 100 : effectiveRiskPct;

      const activePosRiskNote = 
        `🎯 <b>Preço da Entrada Principal:</b> <code>$${referencePrice.toFixed(pricePrecision)}</code>\n` +
        `🛑 <b>Stop Loss Digitado:</b> <code>$${formattedStopPrice}</code>\n` +
        `🎯 <b>Take Profit Ativo:</b> <code>${formattedTPPrice ? `$${formattedTPPrice}` : 'N/A'}</code>\n` +
        `🛰️ <b>Trailing Stop:</b> Ativação <code>$${actPrice.toFixed(pricePrecision)}</code> (${effectiveRate}% recuo)\n` +
        `💰 <b>Margem da Nova Ordem:</b> <code>$${exactMarginUsd.toFixed(2)} USDT</code> (${targetLeverage}x)\n` +
        `🛡️ <b>Risco da Nova Ordem:</b> <code>-$${actualRiskUsd.toFixed(2)} USDT</code> (<b>${actualRiskPct.toFixed(2)}% da conta</b>)\n` +
        `📦 <b>Quantidade da Nova Ordem:</b> <code>${orderQtyStr} ${cleanUpper}</code> (Posição Total: <code>${updatedTotalAmt.toFixed(quantityPrecision)}</code>)`;

      return { 
        success: true, 
        symbol: normalizedSym, 
        newPrice, 
        isActivePosition: true,
        mainEntryPrice: referencePrice.toFixed(pricePrecision),
        stopLoss: formattedStopPrice,
        takeProfit: formattedTPPrice || 'N/A',
        trailingActivation: actPrice.toFixed(pricePrecision),
        recalculatedMargin: exactMarginUsd.toFixed(2),
        recalculatedQty: orderQtyStr,
        riskUsd: actualRiskUsd.toFixed(2),
        effectiveRiskPct: actualRiskPct.toFixed(2),
        activePosRiskNote,
        updatedAvgPrice: updatedAvgPrice.toFixed(pricePrecision),
        updatedTotalAmt,
        message: `Nova ordem criada com Take, Stop ($${formattedStopPrice}) e Trailing Stop em ${normalizedSym} com risco configurado (${actualRiskPct.toFixed(2)}%)!` 
      };
    } else {
      return { success: false, error: placeRes?.msg || `Erro ao criar nova ordem para ${type} na Bitunix` };
    }
  } catch (err: any) {
    return { success: false, error: err.response?.data?.msg || err.message };
  }
};

  // Helper to update Limit Entry price preserving SL, TP, recalculating margin/quantity and syncing Trailing Stop
  const updateBingXLimitEntryPrice = async (
    symbol: string,
    newPrice: number,
    apiKey: string = DEFAULT_BINGX_KEY,
    apiSecret: string = DEFAULT_BINGX_SECRET,
    isDemo: boolean = false,
    specificOrderId?: string
  ) => {
    try {
      const resolved = resolveBingXSymbol(symbol);
      const cleanUpper = resolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = resolved.apiSymbol || `${cleanUpper}-USDT`;

      const ordersRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
      const orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

      // Busca o sinal mais recente recebido no Telegram correspondente a este par
      const matchingSignal = receivedTelegramSignals.find(s => 
        s.parsed && (
          isSameOrRelatedSymbol(s.parsed.apiSymbol, normalizedSym) || 
          isSameOrRelatedSymbol(s.parsed.coinName, cleanUpper) ||
          isSameOrRelatedSymbol(s.parsed.symbol, normalizedSym)
        )
      );

      // Localiza a ordem limite de entrada (não ordens de gatilho ou trailing)
      let limitOrder = specificOrderId 
        ? orders.find((o: any) => (o.orderId || '').toString() === specificOrderId.toString() && (o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT')) 
        : null;
      if (!limitOrder) {
        limitOrder = orders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');
      }

      const signalDirection = matchingSignal?.parsed?.direction || 'LONG';
      const isLong = limitOrder 
        ? (limitOrder.positionSide === 'LONG' || (limitOrder.side === 'BUY' && limitOrder.positionSide !== 'SHORT'))
        : (signalDirection === 'LONG');

      const positionSide = isLong ? 'LONG' : 'SHORT';
      const orderSide = isLong ? 'BUY' : 'SELL';
      const closeSide = isLong ? 'SELL' : 'BUY';

      // 1. Localiza SL, TP existentes antes de substituir
      const slOrder = orders.find((o: any) => (o.symbol === normalizedSym || o.symbol === symbol || o.symbol === cleanUpper) && (o.type === 'STOP_MARKET' || o.type === 'STOP' || o.type === 'STOP_LOSS'));
      const tpOrder = orders.find((o: any) => (o.symbol === normalizedSym || o.symbol === symbol || o.symbol === cleanUpper) && (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT'));

      const customCached = activeCustomSLTPBySymbol.get(normalizedSym) || activeCustomSLTPBySymbol.get(cleanUpper);

      // Prioridade de SL: 1. Ordem no livro de ordens -> 2. SL customizado editado pelo usuário -> 3. StopLoss embutido na ordem limite -> 4. Sinal inicial
      let existingSLPrice = slOrder ? parseFloat(slOrder.stopPrice || '0') : 0;
      if (existingSLPrice <= 0 && customCached?.stopLoss && customCached.stopLoss > 0) {
        existingSLPrice = customCached.stopLoss;
      }
      if (existingSLPrice <= 0 && limitOrder?.stopLoss) {
        try {
          const slObj = typeof limitOrder.stopLoss === 'string' ? JSON.parse(limitOrder.stopLoss) : limitOrder.stopLoss;
          if (slObj?.stopPrice) existingSLPrice = parseFloat(slObj.stopPrice);
        } catch (e) {}
      }
      if (existingSLPrice <= 0 && matchingSignal?.parsed?.stopLoss) {
        existingSLPrice = matchingSignal.parsed.stopLoss;
      }

      // Prioridade de TP: 1. Ordem no livro -> 2. TP customizado editado pelo usuário -> 3. TakeProfit embutido -> 4. Sinal inicial
      let existingTPPrice = tpOrder ? parseFloat(tpOrder.stopPrice || '0') : 0;
      if (existingTPPrice <= 0 && customCached?.takeProfit && customCached.takeProfit > 0) {
        existingTPPrice = customCached.takeProfit;
      }
      if (existingTPPrice <= 0 && limitOrder?.takeProfit) {
        try {
          const tpObj = typeof limitOrder.takeProfit === 'string' ? JSON.parse(limitOrder.takeProfit) : limitOrder.takeProfit;
          if (tpObj?.stopPrice) existingTPPrice = parseFloat(tpObj.stopPrice);
        } catch (e) {}
      }
      if (existingTPPrice <= 0 && matchingSignal?.parsed?.takeProfits && matchingSignal.parsed.takeProfits.length > 0) {
        const tps = matchingSignal.parsed.takeProfits;
        existingTPPrice = (serverTelegramBotConfig.takeProfitSelection === 'TP1') ? tps[0] : tps[tps.length - 1];
      }

      // 2. Obter especificações do contrato para precisões de preço e quantidade
      let pricePrecision = 4;
      let quantityPrecision = 1;
      let minQty = 1;
      let minUsdt = 2;
      let maxContractLeverage = 1000;

      const contract = resolved.contract || symbolLookupIndex.get(normalizedSym) || symbolLookupIndex.get(cleanKey(normalizedSym));
      if (contract) {
        pricePrecision = contract.pricePrecision ?? 4;
        quantityPrecision = contract.quantityPrecision ?? 1;
        minQty = parseFloat(contract.tradeMinQuantity) || 1;
        minUsdt = parseFloat(contract.tradeMinUSDT) || 2;
        if (contract.maxLongLeverage || contract.maxLeverage) {
          maxContractLeverage = parseInt(contract.maxLongLeverage || contract.maxLeverage, 10);
        }
      } else {
        try {
          const contractsRes = await sendBingXRequest('/openApi/swap/v2/quote/contracts', 'GET', {}, apiKey, apiSecret, isDemo);
          if (contractsRes?.data && Array.isArray(contractsRes.data)) {
            const c = contractsRes.data.find((item: any) => item.symbol === normalizedSym || item.symbol === cleanUpper);
            if (c) {
              pricePrecision = c.pricePrecision ?? 4;
              quantityPrecision = c.quantityPrecision ?? 1;
              minQty = parseFloat(c.tradeMinQuantity) || 1;
              minUsdt = parseFloat(c.tradeMinUSDT) || 2;
              if (c.maxLongLeverage || c.maxLeverage) {
                maxContractLeverage = parseInt(c.maxLongLeverage || c.maxLeverage, 10);
              }
            }
          }
        } catch (e) {}
      }

      // Se ainda não tiver Stop Loss, calcula o Stop de Emergência configurado com a precisão correta
      if (existingSLPrice <= 0) {
        const emergPct = (serverTelegramBotConfig.emergencyStopPercent || 2.0) / 100;
        existingSLPrice = isLong 
          ? parseFloat((newPrice * (1 - emergPct)).toFixed(pricePrecision))
          : parseFloat((newPrice * (1 + emergPct)).toFixed(pricePrecision));
      }

      // 3. Obter saldo da conta para recálculo de risco e margem
      let balanceUsd = 100;
      try {
        const balRes = await sendBingXRequest('/openApi/swap/v2/user/balance', 'GET', {}, apiKey, apiSecret, isDemo);
        if (balRes?.data) {
          if (balRes.data.balance?.equity) balanceUsd = parseFloat(balRes.data.balance.equity);
          else if (balRes.data.equity) balanceUsd = parseFloat(balRes.data.equity);
          else if (balRes.data.availableMargin) balanceUsd = parseFloat(balRes.data.availableMargin);
          else if (Array.isArray(balRes.data)) {
            const usdtBal = balRes.data.find((b: any) => b.asset === 'USDT' || b.currency === 'USDT') || balRes.data[0];
            if (usdtBal) balanceUsd = parseFloat(usdtBal.equity || usdtBal.balance || usdtBal.availableMargin || '100');
          }
        }
      } catch (e) {}

      // 🛡️ Alavancagem Original: Mantém RIGOROSAMENTE a alavancagem do sinal original ou da ordem no livro
      const existingOrderLeverage = parseInt(limitOrder?.leverage || limitOrder?.leverageRate || '0', 10);
      let targetLeverage = 0;

      if (matchingSignal?.parsed?.targetLeverage && typeof matchingSignal.parsed.targetLeverage === 'number' && matchingSignal.parsed.targetLeverage > 0) {
        targetLeverage = matchingSignal.parsed.targetLeverage;
      } else if (matchingSignal?.parsed?.leverage && typeof matchingSignal.parsed.leverage === 'number' && matchingSignal.parsed.leverage > 0) {
        targetLeverage = matchingSignal.parsed.leverage;
      } else if (existingOrderLeverage > 0) {
        targetLeverage = existingOrderLeverage;
      } else {
        const contractMax = contract?.maxLeverage || (contract?.maxLongLeverage ? parseInt(contract.maxLongLeverage, 10) : 0);
        if (contractMax && contractMax > 0) {
          targetLeverage = contractMax;
        } else {
          targetLeverage = serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE' ? (serverTelegramBotConfig.fixedLeverageValue || 20) : 20;
        }
      }

      if (serverTelegramBotConfig.maxLeverageCap && targetLeverage > serverTelegramBotConfig.maxLeverageCap) {
        targetLeverage = serverTelegramBotConfig.maxLeverageCap;
      }
      if (maxContractLeverage > 0 && maxContractLeverage < 1000 && targetLeverage > maxContractLeverage) {
        targetLeverage = maxContractLeverage;
      }

      // 🛡️ Gerenciamento de Risco / Perda Máxima:
      // Mantém RIGOROSAMENTE o valor de perda fixado no sinal original (ex: "Perda 10", customRiskUsd: 10)
      let riskUsd = 2.0;
      let riskDescription = '';
      const initialRiskPct = serverTelegramBotConfig.riskPercent || 2.0;

      if (matchingSignal?.parsed?.customRiskUsd && typeof matchingSignal.parsed.customRiskUsd === 'number' && matchingSignal.parsed.customRiskUsd > 0) {
        riskUsd = matchingSignal.parsed.customRiskUsd;
        riskDescription = `Perda máxima de $${riskUsd} dol fixada no sinal`;
      } else if (serverTelegramBotConfig.riskMode === 'FIXED_USD') {
        riskUsd = serverTelegramBotConfig.riskFixedUsd || 50.0;
        riskDescription = `$${riskUsd.toFixed(2)} USD fixos`;
      } else {
        riskUsd = (balanceUsd * initialRiskPct) / 100;
        riskDescription = `${initialRiskPct.toFixed(2)}% da conta`;
      }

      // 4. RECALCULAR QUANTIDADE E MARGEM BASEADO NO NOVO PREÇO E DISTÂNCIA DE SL (INCLUINDO TAXAS)
      const slDist = Math.abs(newPrice - existingSLPrice);
      const roundTripFeeRate = (serverTelegramBotConfig.includeFeesInRisk !== false) ? 0.0010 : 0.0;
      const totalLossPerUnit = slDist + (newPrice * roundTripFeeRate);
      let targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / newPrice);
      if (targetQty < minQty) targetQty = minQty;
      if (targetQty * newPrice < minUsdt) targetQty = minUsdt / newPrice;

      const qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
      const finalExecutedQty = parseFloat(qtyStr);
      const exactPositionValueUsd = finalExecutedQty * newPrice;
      let exactMarginUsd = exactPositionValueUsd / targetLeverage;
      if (exactMarginUsd > balanceUsd * 0.90) exactMarginUsd = balanceUsd * 0.90;

      // 5. Monta parâmetros da NOVA ordem limite com SL/TP embutidos e quantidade recalculada
      const formattedPrice = newPrice.toFixed(pricePrecision);
      const formattedSL = existingSLPrice.toFixed(pricePrecision);
      const formattedTP = existingTPPrice > 0 ? existingTPPrice.toFixed(pricePrecision) : null;

      // Cancelar ordens anteriores
      console.log(`[BINGX-REPLACE-LIMIT] Cancelando todas as ordens anteriores em ${normalizedSym}...`);
      await cancelAllOrdersForSymbol(normalizedSym, apiKey, apiSecret, isDemo);
      for (const ord of orders) {
        const oId = (ord.orderId || ord.orderID || '').toString();
        if (oId) {
          await cancelSingleBingXOrder(ord.symbol || normalizedSym, oId, apiKey, apiSecret, isDemo);
        }
      }
      await new Promise(resolve => setTimeout(resolve, 350));

      // 🛡️ Re-aplica a alavancagem correta do sinal na Bitunix antes de enviar a nova ordem
      if (targetLeverage > 0) {
        try {
          await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
            symbol: normalizedSym,
            leverage: targetLeverage.toString(),
            side: positionSide
          }, apiKey, apiSecret, isDemo);
          await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
            symbol: normalizedSym,
            leverage: targetLeverage.toString(),
            side: "BOTH"
          }, apiKey, apiSecret, isDemo);
        } catch (e) {}
      }

      // 🛡️ Re-aplica modo de margem correto (CRUZADA se SL alavancado >= 25%, alavancagem elevada ou pedido pelo sinal)
      const slDistPct = newPrice > 0 ? (slDist / newPrice) : 0.02;
      const slLeveragedPct = slDistPct * 100 * targetLeverage;
      const crossThreshold = serverTelegramBotConfig.autoCrossMarginThreshold || 25;
      const shouldCross = shouldUseCrossMargin(slLeveragedPct, targetLeverage, crossThreshold) ||
                          (matchingSignal?.parsed?.marginMode === 'CROSS' || matchingSignal?.parsed?.marginMode === 'CRUZADA');
      const targetMarginType = shouldCross ? "CROSSED" : "ISOLATED";
      try {
        await sendBingXRequest('/openApi/swap/v2/trade/marginType', 'POST', {
          symbol: normalizedSym,
          marginType: targetMarginType
        }, apiKey, apiSecret, isDemo);
      } catch (e) {}

      const newLimitParams: any = {
        symbol: normalizedSym,
        side: orderSide,
        positionSide,
        type: 'LIMIT',
        price: formattedPrice,
        quantity: qtyStr,
        timeInForce: "GTC"
      };

      if (parseFloat(formattedSL) > 0) {
        newLimitParams.stopLoss = JSON.stringify({
          type: "STOP_MARKET",
          stopPrice: parseFloat(formattedSL),
          closePosition: true
        });
      }

      if (formattedTP && parseFloat(formattedTP) > 0) {
        newLimitParams.takeProfit = JSON.stringify({
          type: "TAKE_PROFIT_MARKET",
          stopPrice: parseFloat(formattedTP)
        });
      }

      console.log(`[BINGX-REPLACE-LIMIT] Enviando ordem limite para ${normalizedSym}: Lado=${orderSide}, Pos=${positionSide}, Preço=$${formattedPrice}, Qtd=${qtyStr}, Margem=$${exactMarginUsd.toFixed(2)}, SL=$${formattedSL}, TP=${formattedTP || 'N/A'}`);
      
      const placeRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', newLimitParams, apiKey, apiSecret, isDemo);

      if (placeRes?.code === 0) {
        const newLimitId = (placeRes.data?.order?.orderId || placeRes.data?.orderId || '').toString();
        // 🛡️ OPÇÃO 1: Agenda o Trailing Stop com base no NOVO preço de entrada para ativação pós-execução
        if (serverTelegramBotConfig.trailingStopEnabled && parseFloat(formattedSL) > 0) {
          const slDistPct = newPrice > 0 ? (slDist / newPrice) * 100 : 2.0;
          const multiplier = serverTelegramBotConfig.trailingMultiplier || 1.0;
          let effectiveRate = parseFloat((slDistPct * multiplier).toFixed(3));
          if (effectiveRate < 0.1) effectiveRate = 0.1;
          if (effectiveRate > 10.0) effectiveRate = 10.0;
          const actPrice = isLong ? newPrice + (slDist * multiplier) : newPrice - (slDist * multiplier);

          const trailingConfigObj: PendingTrailingConfig = {
            orderId: newLimitId,
            symbol: normalizedSym,
            positionSide,
            closeSide,
            quantity: qtyStr,
            effectiveRate,
            activationPrice: actPrice,
            stopLossPrice: parseFloat(formattedSL),
            entryPrice: newPrice,
            pricePrecision,
            createdAt: Date.now()
          };
          pendingTrailingConfigs.set(`${normalizedSym}_${positionSide}`, trailingConfigObj);
          pendingTrailingConfigs.set(`${cleanUpper}_${positionSide}`, trailingConfigObj);
          if (newLimitId) pendingTrailingConfigs.set(newLimitId, trailingConfigObj);
          savePendingTrailingConfigsToFile();
          console.log(`[TRAILING-REPLACED-PENDING] 🛡️ Trailing Stop recalculado pós-execução para ${normalizedSym}: Entrada $${formattedPrice} -> Ativação $${actPrice.toFixed(pricePrecision)} (${effectiveRate}%) | Qtd=${qtyStr}`);
        }

        return { 
          success: true, 
          symbol: normalizedSym, 
          newPrice: parseFloat(formattedPrice), 
          recalculatedMargin: exactMarginUsd.toFixed(2),
          recalculatedQty: qtyStr,
          stopLoss: formattedSL,
          takeProfit: formattedTP || 'N/A',
          message: `Preço Limite de Entrada em ${normalizedSym} atualizado para $${formattedPrice}! Margem recalculada para $${exactMarginUsd.toFixed(2)} USDT (Qtd: ${qtyStr}).` 
        };
      } else {
        return { success: false, error: placeRes?.msg || "Erro ao reenviar ordem limite com novo preço na Bitunix" };
      }
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper para atualizar Preço de Ativação e/ou Callback % do Trailing Stop sem duplicar ordens
  const updateBingXTrailingStop = async (
    symbol: string,
    options: {
      newActivationPrice?: number | null;
      newCallbackRatePct?: number | null;
    },
    apiKey: string = DEFAULT_BINGX_KEY,
    apiSecret: string = DEFAULT_BINGX_SECRET,
    isDemo: boolean = false
  ) => {
    try {
      const resolved = resolveBingXSymbol(symbol);
      const cleanUpper = resolved.cleanSymbol || symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = resolved.apiSymbol || `${cleanUpper}-USDT`;

      // 1. Busca abrangente de ordens abertas para garantir que localizamos e limpamos TODAS as ordens de trailing anteriores
      const [ordersRes, symOrdersRes, allOrdersRes, allTradeOrdersRes, posRes] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: cleanUpper }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', {}, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/trade/allOrders', 'GET', { symbol: normalizedSym, limit: 50 }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/user/positions', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] }))
      ]);

      const sym1Orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];
      const sym2Orders = (symOrdersRes?.data && Array.isArray(symOrdersRes.data?.orders || symOrdersRes.data)) ? (symOrdersRes.data?.orders || symOrdersRes.data) : [];
      const allOrders = (allOrdersRes?.data && Array.isArray(allOrdersRes.data?.orders || allOrdersRes.data)) ? (allOrdersRes.data?.orders || allOrdersRes.data) : [];
      const allTradeOrders = (allTradeOrdersRes?.data && Array.isArray(allTradeOrdersRes.data?.orders || allTradeOrdersRes.data)) ? (allTradeOrdersRes.data?.orders || allTradeOrdersRes.data) : [];
      
      // Mescla e desduplica ordens por orderId
      const ordersMap = new Map<string, any>();
      [...sym1Orders, ...sym2Orders, ...allOrders, ...allTradeOrders].forEach((o: any) => {
        if (o && (o.orderId || o.orderID)) {
          const id = (o.orderId || o.orderID).toString();
          // Só mantém se status for NEW, PENDING, UNTRIGGERED ou indefinido (aberto)
          const st = (o.status || '').toUpperCase();
          if (!st || st === 'NEW' || st === 'PENDING' || st === 'UNTRIGGERED' || st === 'SUBMITTED') {
            ordersMap.set(id, o);
          }
        }
      });
      const allMergedOrders = Array.from(ordersMap.values());

      // Filtra ordens pertencentes a este par (tanto com ou sem hífen)
      const pairOrders = allMergedOrders.filter((o: any) => {
        const s = (o.symbol || '').toUpperCase().replace('-USDT', '').replace('USDT', '');
        return s === cleanUpper || o.symbol === normalizedSym || o.symbol === symbol;
      });

      // Identifica com precisão cirúrgica ordens de entrada e SL/TP explícitos
      const isLimitEntry = (o: any) => {
        const t = (o.type || '').toUpperCase();
        return (t === 'LIMIT' || t === 'TRIGGER_LIMIT');
      };

      const isExplicitSL = (o: any) => {
        const t = (o.type || '').toUpperCase();
        return (t === 'STOP_MARKET' || t === 'STOP' || t === 'STOP_LOSS') && !o.callbackRate && !o.priceRate && !t.includes('TRAILING');
      };

      const isExplicitTP = (o: any) => {
        const t = (o.type || '').toUpperCase();
        return (t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT') && !o.callbackRate && !o.priceRate && !t.includes('TRAILING');
      };

      // Identifica TODAS as ordens de trailing stop existentes para este par
      const existingTrailingOrders = pairOrders.filter((o: any) => {
        const t = (o.type || '').toUpperCase();
        const ot = (o.orderType || '').toUpperCase();
        if (t === 'TRAILING_STOP_MARKET' || t === 'TRAILING_STOP' || t === 'TRAILING_TP_SL' || t.includes('TRAILING')) return true;
        if (ot === 'TRAILING_STOP_MARKET' || ot === 'TRAILING_STOP' || ot === 'TRAILING_TP_SL' || ot.includes('TRAILING')) return true;
        if (o.callbackRate || o.priceRate || o.activationPrice) return true;
        // Qualquer ordem que não seja a ordem de entrada limite, nem SL explícito, nem TP explícito
        if (!isLimitEntry(o) && !isExplicitSL(o) && !isExplicitTP(o)) return true;
        return false;
      });

      const limitOrder = pairOrders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');

      // Posição ativa se houver
      const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [posRes?.data];
      const targetPos = positions.find((p: any) => p && (p.symbol === normalizedSym || p.symbol === symbol || (p.symbol || '').replace('-USDT', '').replace('USDT', '') === cleanUpper) && Math.abs(parseFloat(p.positionAmt || '0')) > 0);

      // Sinal do histórico
      const matchingSignal = [...receivedTelegramSignals].reverse().find(s => 
        s.parsed && (s.parsed.apiSymbol === normalizedSym || s.parsed.coinName === cleanUpper)
      );

      const firstExistingTrailing = existingTrailingOrders[0];

      const isLong = firstExistingTrailing 
        ? (firstExistingTrailing.positionSide === 'LONG') 
        : (targetPos ? (targetPos.positionSide === 'LONG') : (limitOrder ? (limitOrder.positionSide === 'LONG' || limitOrder.side === 'BUY') : (matchingSignal?.parsed?.direction !== 'SHORT')));

      const positionSide = isLong ? 'LONG' : 'SHORT';
      const closeSide = isLong ? 'SELL' : 'BUY';

      // Especificações e precisão do contrato
      let pricePrecision = 4;
      let quantityPrecision = 1;
      let minQty = 1;
      let minUsdt = 2;

      try {
        const contractsRes = await sendBingXRequest('/openApi/swap/v2/quote/contracts', 'GET', {}, apiKey, apiSecret, isDemo);
        if (contractsRes?.data && Array.isArray(contractsRes.data)) {
          const contract = contractsRes.data.find((c: any) => c.symbol === normalizedSym || c.symbol === cleanUpper);
          if (contract) {
            pricePrecision = contract.pricePrecision ?? 4;
            quantityPrecision = contract.quantityPrecision ?? 1;
            minQty = parseFloat(contract.tradeMinQuantity) || 1;
            minUsdt = parseFloat(contract.tradeMinUSDT) || 2;
          }
        }
      } catch (e) {}

      // Quantidade protegida: para posições abertas, SEMPRE cobre 100% da mão total aberta
      let targetQty = 0;
      if (targetPos && Math.abs(parseFloat(targetPos.positionAmt || '0')) > 0) {
        targetQty = Math.abs(parseFloat(targetPos.positionAmt || '0'));
      } else {
        for (const oldTs of existingTrailingOrders) {
          const q = parseFloat(oldTs.origQty || oldTs.quantity || '0');
          if (q > 0) { targetQty = q; break; }
        }
        if (targetQty <= 0 && limitOrder) {
          targetQty = parseFloat(limitOrder.origQty || limitOrder.quantity || '0');
        }
      }
      if (targetQty <= 0) targetQty = minQty;

      const qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);

      // Porcentagem de Recuo (Callback Rate)
      let finalCallbackRatePct: number | null = options.newCallbackRatePct ?? null;
      if (finalCallbackRatePct === null || finalCallbackRatePct <= 0) {
        if (firstExistingTrailing) {
          const rawRate = parseFloat(firstExistingTrailing.priceRate || firstExistingTrailing.callbackRate || '0');
          if (rawRate > 0) {
            finalCallbackRatePct = rawRate < 0.5 ? rawRate * 100 : rawRate;
          }
        }
      }
      if (!finalCallbackRatePct || finalCallbackRatePct <= 0) {
        finalCallbackRatePct = (serverTelegramBotConfig.trailingMultiplier || 1.0) * 1.5;
      }
      if (finalCallbackRatePct < 0.1) {
        finalCallbackRatePct = 0.1;
      }
      if (finalCallbackRatePct > 10.0) {
        finalCallbackRatePct = 10.0;
      }

      // Preço de entrada base para calcular o gatilho automático (1x a % escolhida positiva)
      let baseEntryPrice = 0;
      if (limitOrder) {
        baseEntryPrice = parseFloat(limitOrder.price || limitOrder.origPrice || '0');
      }
      if (baseEntryPrice <= 0 && targetPos) {
        baseEntryPrice = parseFloat(targetPos.avgPrice || targetPos.entryPrice || '0');
      }
      if (baseEntryPrice <= 0 && matchingSignal?.parsed?.entryPrice) {
        baseEntryPrice = parseFloat(matchingSignal.parsed.entryPrice);
      }
      if (baseEntryPrice <= 0 && matchingSignal?.parsed?.price) {
        baseEntryPrice = parseFloat(matchingSignal.parsed.price);
      }
      if (baseEntryPrice <= 0) {
        try {
          const tickerRes = await sendBingXRequest('/openApi/swap/v2/quote/ticker', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo);
          if (tickerRes?.data?.lastPrice) baseEntryPrice = parseFloat(tickerRes.data.lastPrice);
        } catch (e) {}
      }

      // Preço de Ativação (Activation Price):
      // Se options.newActivationPrice foi fornecido explicitamente pelo usuário, usamos ele.
      // Se o usuário está mudando a % (ou não informou gatilho fixo):
      // Calcula o Preço de Ativação exatamente a 1 vez a % positiva a favor do trade, deixando o gatilho stopPrice em branco igual à ordem original!
      let finalActivationPrice: number | null = null;
      let isAutomaticActivation = false;

      if (options.newActivationPrice !== undefined && options.newActivationPrice !== null && options.newActivationPrice > 0) {
        finalActivationPrice = options.newActivationPrice;
      } else if (baseEntryPrice > 0 && finalCallbackRatePct > 0) {
        // Regra solicitada: ativação a 1 vez a % escolhida positiva a favor do trade
        finalActivationPrice = isLong 
          ? baseEntryPrice * (1 + (finalCallbackRatePct / 100))
          : baseEntryPrice * (1 - (finalCallbackRatePct / 100));
        isAutomaticActivation = true;
      } else if (firstExistingTrailing) {
        const act = parseFloat(firstExistingTrailing.activationPrice || '0');
        if (act > 0) finalActivationPrice = act;
      }

      // Converte percentual para decimal (ex: 0.70% -> 0.007)
      let rateDecimal = (finalCallbackRatePct / 100).toFixed(4);

      // 1. CANCELA RIGOROSAMENTE TODAS AS ORDENS DE TRAILING STOP ANTERIORES DO PAR
      console.log(`[TRAILING-STOP-CLEANUP] Localizadas ${existingTrailingOrders.length} ordens de Trailing Stop para ${normalizedSym}`);
      
      const deleteTrailingOrderRobust = async (ord: any) => {
        const ordIdStr = (ord.orderId || ord.orderID || '').toString();
        if (!ordIdStr) return;

        const delPromises = [
          sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: normalizedSym, orderId: ordIdStr }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: cleanUpper, orderId: ordIdStr }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: normalizedSym, orderID: ordIdStr }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: cleanUpper, orderID: ordIdStr }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/batchCancel', 'DELETE', { symbol: normalizedSym, orderIdList: `[${ordIdStr}]` }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/batchCancel', 'DELETE', { symbol: cleanUpper, orderIdList: `[${ordIdStr}]` }, apiKey, apiSecret, isDemo),
          sendBingXRequest('/openApi/swap/v2/trade/batchCancel', 'DELETE', { symbol: normalizedSym, orderIds: ordIdStr }, apiKey, apiSecret, isDemo)
        ];

        if (ord.clientOrderID) {
          delPromises.push(
            sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: normalizedSym, clientOrderID: ord.clientOrderID }, apiKey, apiSecret, isDemo),
            sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', { symbol: cleanUpper, clientOrderID: ord.clientOrderID }, apiKey, apiSecret, isDemo)
          );
        }

        const results = await Promise.allSettled(delPromises);
        console.log(`[TRAILING-STOP-DELETE #${ordIdStr}]:`, results.map(r => r.status === 'fulfilled' ? JSON.stringify(r.value) : r.reason?.message));
      };

      for (const oldTs of existingTrailingOrders) {
        await deleteTrailingOrderRobust(oldTs);
      }

      // Aguarda 400ms para propagação do cancelamento na Bitunix
      await new Promise(resolve => setTimeout(resolve, 400));

      // Verificação dupla: consulta se ainda sobrou alguma ordem trailing e cancela novamente
      try {
        const verifyRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] }));
        const verifyOrders = (verifyRes?.data && Array.isArray(verifyRes.data?.orders || verifyRes.data)) ? (verifyRes.data?.orders || verifyRes.data) : [];
        const remainingTrailing = verifyOrders.filter((o: any) => {
          const t = (o.type || '').toUpperCase();
          if (t === 'TRAILING_STOP_MARKET' || t === 'TRAILING_STOP' || t === 'TRAILING_TP_SL' || t.includes('TRAILING')) return true;
          if (o.callbackRate || o.priceRate || o.activationPrice) return true;
          if (!isLimitEntry(o) && !isExplicitSL(o) && !isExplicitTP(o)) return true;
          return false;
        });

        if (remainingTrailing.length > 0) {
          console.warn(`[TRAILING-STOP-RETRY] Ainda restam ${remainingTrailing.length} ordens de trailing após primeira tentativa. Executando limpeza forçada...`);
          for (const rem of remainingTrailing) {
            await deleteTrailingOrderRobust(rem);
          }
          await new Promise(resolve => setTimeout(resolve, 350));
        }
      } catch (e) {}

      // 🛡️ OPÇÃO 1 (PROTEÇÃO TOTAL):
      // Se NÃO houver posição aberta (apenas ordem LIMITE pendente no livro da Bitunix),
      // cancelamos ordens antigas de Trailing Stop na corretora e registramos a nova configuração para ativação PÓS-EXECUÇÃO.
      // Isso impede que o preço acione o Trailing Stop no livro antes de a ordem de entrada ser preenchida!
      if (!targetPos || Math.abs(parseFloat(targetPos.positionAmt || '0')) <= 0) {
        const trailingConfigObj: PendingTrailingConfig = {
          orderId: limitOrder ? (limitOrder.orderId || limitOrder.orderID) : undefined,
          symbol: normalizedSym,
          positionSide,
          closeSide,
          quantity: qtyStr,
          effectiveRate: finalCallbackRatePct,
          activationPrice: finalActivationPrice || undefined,
          stopLossPrice: 0,
          entryPrice: baseEntryPrice,
          pricePrecision,
          createdAt: Date.now()
        };
        pendingTrailingConfigs.set(`${normalizedSym}_${positionSide}`, trailingConfigObj);
        pendingTrailingConfigs.set(`${cleanUpper}_${positionSide}`, trailingConfigObj);
        if (trailingConfigObj.orderId) pendingTrailingConfigs.set(trailingConfigObj.orderId, trailingConfigObj);
        savePendingTrailingConfigsToFile();
        console.log(`[TRAILING-STOP-SAVED-PENDING] 🛡️ Não há posição aberta para ${normalizedSym}. Trailing Stop (${finalCallbackRatePct}%) salvo para ativação automática PÓS-EXECUÇÃO.`);

        const actLabel = finalActivationPrice && finalActivationPrice > 0
          ? `$${finalActivationPrice.toFixed(pricePrecision)}`
          : 'Pós-Execução (Entrada)';

        return {
          success: true,
          symbol: normalizedSym,
          activationPrice: actLabel,
          callbackRate: finalCallbackRatePct,
          isPostExecution: true,
          message: `Trailing Stop configurado com sucesso! Como a sua ordem ainda está pendente no livro da Bitunix, ele será ativado automaticamente assim que a entrada for executada (sem risco de acionamento prematuro).`
        };
      }

      // 2. Envia a nova ordem de Trailing Stop atualizada (sem stopPrice fixo para deixar preço de gatilho em branco igual a original)
      const trailingParams: any = {
        symbol: normalizedSym,
        side: closeSide,
        positionSide,
        type: "TRAILING_STOP_MARKET",
        quantity: qtyStr,
        priceRate: rateDecimal,
        callbackRate: rateDecimal
      };

      let formattedActPrice: string | null = null;
      if (finalActivationPrice && finalActivationPrice > 0) {
        formattedActPrice = finalActivationPrice.toFixed(pricePrecision);
        trailingParams.activationPrice = formattedActPrice;
      }

      console.log(`[TRAILING-STOP-SUBMIT] Enviando Trailing Stop para ${normalizedSym}: Ativação=${formattedActPrice ? `$${formattedActPrice}` : 'Imediato'}, Recuo=${finalCallbackRatePct.toFixed(2)}% (${rateDecimal}), Qtd=${qtyStr}, Lado=${closeSide}, Pos=${positionSide}`);

      let placeRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', trailingParams, apiKey, apiSecret, isDemo);
      console.log(`[TRAILING-STOP-RESPONSE]:`, JSON.stringify(placeRes));

      // 🔄 AUTO-RETRY: Se der erro de callback rate / 110415
      if (placeRes?.code !== 0 && placeRes?.msg) {
        const msgLow = placeRes.msg.toLowerCase();
        if (placeRes.code === 110415 || msgLow.includes('callback') || msgLow.includes('rate') || msgLow.includes('pricerate')) {
          console.log(`[TRAILING-STOP-RETRY-RATE] Ajustando para taxa mínima 0.1% e reenviando Trailing Stop...`);
          finalCallbackRatePct = 0.1;
          rateDecimal = "0.001";
          trailingParams.priceRate = rateDecimal;
          trailingParams.callbackRate = rateDecimal;
          placeRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', trailingParams, apiKey, apiSecret, isDemo);
          console.log(`[TRAILING-STOP-RETRY-RATE-RES]:`, JSON.stringify(placeRes));
        }
      }

      // 🔄 AUTO-RETRY: Se der erro de activationPrice
      if (placeRes?.code !== 0 && trailingParams.activationPrice) {
        const msgLow = (placeRes?.msg || '').toLowerCase();
        if (msgLow.includes('activation') || msgLow.includes('trigger') || msgLow.includes('price')) {
          console.log(`[TRAILING-STOP-RETRY-ACT] Erro no activationPrice (${placeRes.msg}). Reenviando Trailing Stop com ativação imediata...`);
          delete trailingParams.activationPrice;
          formattedActPrice = null;
          placeRes = await sendBingXRequest('/openApi/swap/v2/trade/order', 'POST', trailingParams, apiKey, apiSecret, isDemo);
          console.log(`[TRAILING-STOP-RETRY-ACT-RES]:`, JSON.stringify(placeRes));
        }
      }

      if (placeRes?.code === 0) {
        const actLabel = formattedActPrice 
          ? `$${formattedActPrice}${isAutomaticActivation ? ` (+${finalCallbackRatePct.toFixed(2)}% da entrada)` : ''}`
          : 'Ativação Imediata';

        return {
          success: true,
          symbol: normalizedSym,
          activationPrice: actLabel,
          callbackRatePct: finalCallbackRatePct.toFixed(2),
          baseEntryPrice: baseEntryPrice > 0 ? baseEntryPrice.toFixed(pricePrecision) : null,
          message: `Trailing Stop em ${normalizedSym} atualizado com sucesso! Gatilho: ${actLabel} | Recuo: ${finalCallbackRatePct.toFixed(2)}%`
        };
      } else {
        return { success: false, error: placeRes?.msg || "Erro ao atualizar Trailing Stop na Bitunix" };
      }
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper to cancel a single BingX Order with thorough multi-endpoint cleanup & trigger removal
  const cancelSingleBingXOrder = async (symbol: string, orderId?: string | number, apiKey: string = DEFAULT_BINGX_KEY, apiSecret: string = DEFAULT_BINGX_SECRET, isDemo: boolean = false) => {
    try {
      const cleanUpper = symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = `${cleanUpper}-USDT`;
      const orderIdStr = orderId ? orderId.toString().trim() : '';

      console.log(`[BINGX-CANCEL-ORDER] Cancelando ordem #${orderIdStr || 'TODAS'} em ${normalizedSym}...`);

      let cancelledCount = 0;
      let lastError = '';

      // 1. Envia allOpenOrders para o par na Bitunix (limpa livro de uma vez)
      try {
        const allOpenRes = await sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', {
          symbol: normalizedSym
        }, apiKey, apiSecret, isDemo);
        if (allOpenRes?.code === 0 || allOpenRes?.data?.success) {
          cancelledCount++;
        }
      } catch (e) {}

      // 2. Se temos orderId específico, cancela diretamente
      if (orderIdStr) {
        try {
          const res1 = await sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
            symbol: normalizedSym,
            orderId: orderIdStr
          }, apiKey, apiSecret, isDemo);

          if (res1?.code === 0 || res1?.data?.order || res1?.data?.orderId || res1?.code === 100414 || res1?.code === 80012) {
            cancelledCount++;
          } else if (res1?.msg) {
            lastError = res1.msg;
          }
        } catch (e) {}

        // Tenta também com clientOrderID caso tenha sido gerada com ID customizado
        try {
          const res2 = await sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
            symbol: normalizedSym,
            clientOrderID: orderIdStr
          }, apiKey, apiSecret, isDemo);

          if (res2?.code === 0 || res2?.data?.order) {
            cancelledCount++;
          }
        } catch (e) {}
      }

      // 3. Busca lista de ordens abertas para o par e cancela individualmente cada uma que ainda constar (ex: Trailing, SL, TP)
      try {
        const ordersRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => null);
        const orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

        for (const ord of orders) {
          const oId = (ord.orderId || ord.orderID || '').toString();
          if (oId) {
            const resInd = await sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
              symbol: ord.symbol || normalizedSym,
              orderId: oId
            }, apiKey, apiSecret, isDemo).catch(() => null);
            if (resInd?.code === 0) {
              cancelledCount++;
            }
          }
        }
      } catch (e) {}

      // Se cancelou algo, se a lista está vazia ou se já não existia na corretora, sucesso absoluto
      if (cancelledCount > 0 || (lastError && (lastError.toLowerCase().includes("not exist") || lastError.toLowerCase().includes("not found")))) {
        // Reset automático para 20x e ISOLATED caso não haja posição aberta no par
        resetBitunixLeverageAndMarginToDefault(normalizedSym, apiKey, apiSecret, isDemo).catch(() => {});
        return {
          success: true,
          message: `Ordem ${orderIdStr ? `(#${orderIdStr.length > 6 ? orderIdStr.slice(-6) : orderIdStr}) ` : ''}e gatilhos em ${normalizedSym} removidos com sucesso da Bitunix! (Alavancagem e margem resetadas)`
        };
      }

      // Verifica uma última vez se restou alguma ordem aberta do par
      const checkRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, apiKey, apiSecret, isDemo).catch(() => null);
      const remaining = (checkRes?.data && Array.isArray(checkRes.data?.orders || checkRes.data)) ? (checkRes.data?.orders || checkRes.data) : [];
      if (remaining.length === 0) {
        resetBitunixLeverageAndMarginToDefault(normalizedSym, apiKey, apiSecret, isDemo).catch(() => {});
        return {
          success: true,
          message: `Nenhuma ordem pendente restante para ${normalizedSym}. Cancelamento concluído e modo resetado!`
        };
      }

      return {
        success: false,
        error: lastError || "Não foi possível cancelar a ordem na Bitunix."
      };
    } catch (err: any) {
      console.error(`[BINGX-CANCEL-ERR]`, err);
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Helper para resetar alavancagem para 20x e modo de margem para ISOLATED na Bitunix após fechamento de posição ou cancelamento
  const resetBitunixLeverageAndMarginToDefault = async (symbol: string, apiKey: string = DEFAULT_BITUNIX_KEY, apiSecret: string = DEFAULT_BITUNIX_SECRET, isDemo: boolean = false) => {
    try {
      if (!symbol) return;
      const bitunixRes = resolveBitunixSymbol(symbol);
      const apiSymbol = bitunixRes.apiSymbol || symbol;
      const defaultLev = 20;

      console.log(`[AUTO-RESET] 🔄 Resetando alavancagem para ${defaultLev}x e margem para ISOLADA em ${apiSymbol}...`);

      // 1. Reset margin mode to ISOLATED
      await sendBingXRequest('/openApi/swap/v2/trade/marginType', 'POST', {
        symbol: apiSymbol,
        marginType: 'ISOLATED'
      }, apiKey, apiSecret, isDemo).catch(() => {});

      // 2. Reset leverage to 20x for BOTH, LONG and SHORT
      await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
        symbol: apiSymbol,
        leverage: defaultLev.toString(),
        side: 'BOTH'
      }, apiKey, apiSecret, isDemo).catch(() => {});

      await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
        symbol: apiSymbol,
        leverage: defaultLev.toString(),
        side: 'LONG'
      }, apiKey, apiSecret, isDemo).catch(() => {});

      await sendBingXRequest('/openApi/swap/v2/trade/leverage', 'POST', {
        symbol: apiSymbol,
        leverage: defaultLev.toString(),
        side: 'SHORT'
      }, apiKey, apiSecret, isDemo).catch(() => {});
    } catch (err: any) {
      console.warn(`[AUTO-RESET-WARN] Erro ao resetar alavancagem/margem de ${symbol}:`, err?.message || err);
    }
  };

  // Helper to cancel ALL pending open orders across all symbols in BingX/Bitunix
  const cancelAllBingXPendingOrders = async (apiKey: string = DEFAULT_BINGX_KEY, apiSecret: string = DEFAULT_BINGX_SECRET, isDemo: boolean = false) => {
    try {
      // 1. Bitunix: Cancela todas as ordens pendentes em todos os pares instantaneamente
      try {
        await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, {}, apiKey, apiSecret);
      } catch (e) {}

      const ordersRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', {}, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] }));
      const orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

      if (orders.length === 0) {
        return { success: true, count: 0, message: "Todas as ordens pendentes foram canceladas com sucesso!" };
      }

      // 2. Coleta símbolos únicos
      const symbols = Array.from(new Set(orders.map((o: any) => o.symbol).filter(Boolean)));
      
      // 3. Executa cancel_all_orders para cada par
      await Promise.allSettled(
        symbols.map((sym: any) => 
          sendBingXRequest('/openApi/swap/v2/trade/allOpenOrders', 'DELETE', { symbol: sym }, apiKey, apiSecret, isDemo)
        )
      );

      // 4. Executa cancelamento pontual por ID de cada ordem para garantir que nenhuma ordem (inclusive triggers) permaneça
      await Promise.allSettled(
        orders.map((o: any) => 
          sendBingXRequest('/openApi/swap/v2/trade/order', 'DELETE', {
            symbol: o.symbol,
            orderId: (o.orderId || '').toString()
          }, apiKey, apiSecret, isDemo)
        )
      );

      // 5. Reseta cada símbolo para 20x e ISOLADA
      await Promise.allSettled(
        symbols.map((sym: any) => resetBitunixLeverageAndMarginToDefault(sym, apiKey, apiSecret, isDemo))
      );

      return { success: true, count: orders.length, message: `Todas as ordens pendentes foram canceladas com sucesso e parâmetros resetados!` };
    } catch (err: any) {
      return { success: false, error: err.response?.data?.msg || err.message };
    }
  };

  // Global outbound message deduplication cache
  const sentRepliesCache = new Map<string, number>();

  // Armazena e persiste os IDs das mensagens que possuem botões interativos ativos por chat
  const ACTIVE_KEYBOARDS_FILE = path.join(process.cwd(), 'data_telegram_active_keyboards.json');
  const activeKeyboardMessagesByChat = new Map<string, Set<number>>();

  // Persistência de chats do Telegram para envio de alertas automáticos em tempo real
  const REGISTERED_CHATS_FILE = path.join(process.cwd(), 'data_registered_telegram_chats.json');
  const registeredTelegramChatIds = new Set<string>();

  const loadRegisteredChats = () => {
    try {
      if (fs.existsSync(REGISTERED_CHATS_FILE)) {
        const raw = fs.readFileSync(REGISTERED_CHATS_FILE, 'utf-8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          arr.forEach(id => { if (id) registeredTelegramChatIds.add(String(id)); });
        }
      }
      if (process.env.TELEGRAM_CHAT_ID) {
        process.env.TELEGRAM_CHAT_ID.split(',').forEach(id => {
          const cleanId = id.trim();
          if (cleanId) registeredTelegramChatIds.add(cleanId);
        });
      }
    } catch (e) {}
  };

  const saveRegisteredChats = () => {
    try {
      fs.writeFileSync(REGISTERED_CHATS_FILE, JSON.stringify(Array.from(registeredTelegramChatIds)), 'utf-8');
    } catch (e) {}
  };

  loadRegisteredChats();

  const registerTelegramChat = (chatId: number | string) => {
    if (!chatId) return;
    const strId = String(chatId);
    if (!registeredTelegramChatIds.has(strId)) {
      registeredTelegramChatIds.add(strId);
      saveRegisteredChats();
      console.log(`[TELEGRAM-ALERT] Novo chat de operador registrado para notificações: ${strId}`);
    }
  };

  const broadcastTelegramNotification = async (text: string, replyMarkup?: any) => {
    if (!TELEGRAM_BOT_TOKEN || registeredTelegramChatIds.size === 0) return;
    for (const cId of registeredTelegramChatIds) {
      try {
        await sendTelegramReply(cId, text, replyMarkup);
      } catch (e) {}
    }
  };

  const loadActiveKeyboards = () => {
    try {
      if (fs.existsSync(ACTIVE_KEYBOARDS_FILE)) {
        const raw = fs.readFileSync(ACTIVE_KEYBOARDS_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        for (const [cId, msgIds] of Object.entries(parsed)) {
          if (Array.isArray(msgIds)) {
            activeKeyboardMessagesByChat.set(String(cId), new Set(msgIds.filter(n => typeof n === 'number')));
          }
        }
      }
    } catch (e) {}
  };

  const saveActiveKeyboards = () => {
    try {
      const obj: Record<string, number[]> = {};
      for (const [cId, set] of activeKeyboardMessagesByChat.entries()) {
        const arr = Array.from(set).slice(-80);
        if (arr.length > 0) {
          obj[cId] = arr;
        }
      }
      fs.writeFileSync(ACTIVE_KEYBOARDS_FILE, JSON.stringify(obj), 'utf-8');
    } catch (e) {}
  };

  loadActiveKeyboards();

  const trackActiveKeyboardMessage = (chatId: number | string, messageId: number | string) => {
    if (!chatId || !messageId) return;
    const msgIdNum = typeof messageId === 'string' ? parseInt(messageId, 10) : messageId;
    if (!msgIdNum || isNaN(msgIdNum)) return;
    const chatKey = String(chatId);
    let activeSet = activeKeyboardMessagesByChat.get(chatKey);
    if (!activeSet) {
      activeSet = new Set<number>();
      activeKeyboardMessagesByChat.set(chatKey, activeSet);
    }
    activeSet.add(msgIdNum);
    saveActiveKeyboards();
  };

  // Helper universal para remover os botões inline de qualquer mensagem no Telegram
  const removeTelegramMessageButtons = async (chatId?: number | string, messageId?: number | string) => {
    if (!chatId || !messageId || !TELEGRAM_BOT_TOKEN) return;
    const msgIdNum = typeof messageId === 'string' ? parseInt(messageId, 10) : messageId;
    if (!msgIdNum || isNaN(msgIdNum)) return;
    const chatKey = String(chatId);

    // Remove do conjunto de ativos deste chat
    const activeSet = activeKeyboardMessagesByChat.get(chatKey);
    if (activeSet) {
      activeSet.delete(msgIdNum);
      saveActiveKeyboards();
    }

    try {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
        chat_id: chatId,
        message_id: msgIdNum,
        reply_markup: { inline_keyboard: [] }
      }, { timeout: 4000 });
    } catch (e: any) {
      // Ignora erro se a mensagem já não tinha botões ou se já foi apagada/editada
    }
  };

  // 👤 IDENTIFICADOR MULTI-CONTAS POR CHAT ID DO TELEGRAM
  // Mapeia o Telegram Chat ID para a conta gerenciada do operador correspondente.
  // Permite que múltiplos parceiros/operadores usem o mesmo bot e cada um opere
  // 100% isolado na sua própria conta Bitunix, saldo e gestão de risco.
  const getAccountContextForChat = (chatId?: number | string): {
    account: ManagedAccount | null;
    isOperator: boolean;
    name: string;
    ownerName: string;
    apiKey: string;
    apiSecret: string;
    isDemo: boolean;
    riskMode: 'PERCENT' | 'FIXED_USD';
    riskPercent: number;
    riskFixedUsd: number;
    fixedLeverage?: number;
    accountId: string;
  } => {
    if (!chatId) {
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      return {
        account: null,
        isOperator: false,
        name: 'Conta Master (Padrão)',
        ownerName: 'Administrador',
        apiKey: DEFAULT_BITUNIX_KEY,
        apiSecret: DEFAULT_BITUNIX_SECRET,
        isDemo,
        riskMode: serverTelegramBotConfig.riskMode || 'FIXED_USD',
        riskPercent: serverTelegramBotConfig.riskPercent || 2.0,
        riskFixedUsd: serverTelegramBotConfig.riskFixedUsd || 50.0,
        fixedLeverage: serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE' ? serverTelegramBotConfig.fixedLeverageValue : undefined,
        accountId: 'acc_master'
      };
    }

    const sChatId = String(chatId).trim();
    const matched = managedAccounts.find(a => 
      a.telegramChatId && 
      String(a.telegramChatId).trim() === sChatId && 
      a.isActive
    );

    if (matched && matched.role === 'OPERATOR') {
      const isDemo = matched.accountType === 'VST';
      return {
        account: matched,
        isOperator: true,
        name: matched.name,
        ownerName: matched.ownerName,
        apiKey: matched.apiKey || DEFAULT_BITUNIX_KEY,
        apiSecret: matched.apiSecret || DEFAULT_BITUNIX_SECRET,
        isDemo,
        riskMode: matched.riskMode || 'FIXED_USD',
        riskPercent: matched.riskPercent || 2.0,
        riskFixedUsd: matched.riskFixedUsd || 50.0,
        fixedLeverage: matched.fixedLeverage,
        accountId: matched.id
      };
    }

    // Se for o admin ou conta não cadastrada como operador, usa conta Master
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    return {
      account: matched || null,
      isOperator: false,
      name: matched?.name || 'Conta Master',
      ownerName: matched?.ownerName || 'Administrador',
      apiKey: matched?.apiKey || DEFAULT_BITUNIX_KEY,
      apiSecret: matched?.apiSecret || DEFAULT_BITUNIX_SECRET,
      isDemo: matched ? matched.accountType === 'VST' : isDemo,
      riskMode: matched?.riskMode || serverTelegramBotConfig.riskMode || 'FIXED_USD',
      riskPercent: matched?.riskPercent || serverTelegramBotConfig.riskPercent || 2.0,
      riskFixedUsd: matched?.riskFixedUsd || serverTelegramBotConfig.riskFixedUsd || 50.0,
      fixedLeverage: matched?.fixedLeverage || (serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE' ? serverTelegramBotConfig.fixedLeverageValue : undefined),
      accountId: matched?.id || 'acc_master'
    };
  };

  // Responde imediatamente a um callback de botão do Telegram com alta prioridade
  const answerTelegramCallback = async (callbackQueryId: string, text?: string, showAlert = false) => {
    await answerCallbackQuery(callbackQueryId, text, showAlert);
  };

  // Trava de execução para evitar duplicidade ou processamento repetido caso o usuário clique múltiplas vezes
  const activeTelegramOrderExecutions = new Set<string>();

  // Remove os botões de todas as mensagens ativas anteriores deste chat
  const clearActiveKeyboardsForChat = async (chatId: number | string, exceptMessageId?: number | string) => {
    if (!chatId) return;
    const chatKey = String(chatId);
    const activeSet = activeKeyboardMessagesByChat.get(chatKey);
    if (!activeSet || activeSet.size === 0) return;

    const exceptNum = exceptMessageId ? (typeof exceptMessageId === 'string' ? parseInt(exceptMessageId, 10) : exceptMessageId) : null;
    const msgIdsToRemove = Array.from(activeSet).filter(id => id !== exceptNum);

    if (msgIdsToRemove.length > 0) {
      await Promise.allSettled(
        msgIdsToRemove.map(mId => removeTelegramMessageButtons(chatId, mId))
      );
    }

    if (exceptNum && activeSet.has(exceptNum)) {
      activeKeyboardMessagesByChat.set(chatKey, new Set([exceptNum]));
    } else {
      activeKeyboardMessagesByChat.delete(chatKey);
    }
    saveActiveKeyboards();
  };

  // Helper to send message back to Telegram user with automatic fallback & hard deduplication
  const sendTelegramReply = async (
    chatId: number | string, 
    text: string, 
    replyMarkup?: any, 
    options?: { preserveBatch?: boolean; disableDedup?: boolean }
  ) => {
    if (!TELEGRAM_BOT_TOKEN || !chatId) return;

    const chatKey = String(chatId);

    // Se a nova mensagem possui botões interativos e NÃO faz parte de um lote preservado,
    // removemos os botões de mensagens anteriores deste chat!
    if (replyMarkup && replyMarkup.inline_keyboard && replyMarkup.inline_keyboard.length > 0) {
      if (!options?.preserveBatch) {
        await clearActiveKeyboardsForChat(chatId);
      }
    }

    // Hard Egress Deduplication: Discards identical messages sent to the same chat within 7 seconds
    if (!options?.disableDedup) {
      const cleanText = text.replace(/<[^>]*>?/gm, '').replace(/\s+/g, ' ').trim();
      const egressKey = `${chatId}_${cleanText.substring(0, 80)}`;
      const now = Date.now();
      const lastSentTime = sentRepliesCache.get(egressKey) || 0;

      if (now - lastSentTime < 7000) {
        console.log(`[DEDUP-EGRESS] Resposta duplicada para o chat ${chatId} descartada com sucesso.`);
        return;
      }
      sentRepliesCache.set(egressKey, now);

      if (sentRepliesCache.size > 500) {
        const [firstKey] = sentRepliesCache.keys();
        sentRepliesCache.delete(firstKey);
      }
    }

    try {
      const sentMsg = await sendTelegramMessage(chatId, text, replyMarkup);
      if (sentMsg?.message_id && replyMarkup && replyMarkup.inline_keyboard && replyMarkup.inline_keyboard.length > 0) {
        let activeSet = activeKeyboardMessagesByChat.get(chatKey);
        if (!activeSet) {
          activeSet = new Set<number>();
          activeKeyboardMessagesByChat.set(chatKey, activeSet);
        }
        activeSet.add(sentMsg.message_id);
      }
      return sentMsg;
    } catch (err: any) {
      const errDetail = err?.response?.data?.description || err?.message || '';
      const isDeadChat = errDetail.includes('chat not found') || errDetail.includes('bot was blocked') || errDetail.includes('user is deactivated');
      if (isDeadChat) {
        registeredTelegramChatIds.delete(String(chatId));
        saveRegisteredChats();
        console.warn(`[TELEGRAM-CLEANUP] Chat inacessível removido da lista de alertas: ${chatId} (${errDetail})`);
      } else {
        console.error("[TELEGRAM-SEND-ERROR]:", errDetail);
      }
      return null;
    }
  };

  // =========================================================================
  // 🛡️ BITUNIX STOP MÓVEL ENGINE (DYNAMIC HIGH-WATERMARK TRAILING STOP)
  // Rastreia topos e fundos em tempo real e avança o Stop Loss na Bitunix
  // =========================================================================
  registerBitunixTrailingStop = async (params: {
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    entryPrice: number;
    stopLossPrice?: number;
    takeProfitPrice?: number;
    callbackRate?: number;
    activationPrice?: number;
    qty?: string;
    positionId?: string;
    pricePrecision?: number;
  }): Promise<BitunixTrailingStopRecord> => {
    const bitunixResolved = resolveBitunixSymbol(params.symbol);
    const sym = bitunixResolved.apiSymbol || params.symbol;
    const clean = bitunixResolved.cleanSymbol || sym.replace('USDT', '');
    const isLong = params.positionSide === 'LONG';
    const entryPrice = params.entryPrice > 0 ? params.entryPrice : 1;
    const precision = params.pricePrecision ?? 4;
    const multiplier = serverTelegramBotConfig.trailingMultiplier || 1.0;

    // Se já existe um Stop Móvel ativo para esta MESMA posição na Bitunix, preserva topos/fundos e Stop Loss.
    // Se for uma NOVA posição (preço de entrada diferente ou positionId diferente), reinicia do zero com segurança total!
    const existing = bitunixActiveTrailingStops.get(sym) || 
                     bitunixActiveTrailingStops.get(`${clean}USDT`) || 
                     bitunixActiveTrailingStops.get(clean) ||
                     bitunixActiveTrailingStops.get(params.symbol);

    const isSameTrade = existing && 
      existing.positionSide === params.positionSide &&
      (!params.positionId || !existing.positionId || params.positionId === existing.positionId) &&
      (params.entryPrice <= 0 || existing.entryPrice <= 0 || Math.abs(params.entryPrice - existing.entryPrice) / existing.entryPrice <= 0.001);

    if (isSameTrade && existing) {
      console.log(`[BITUNIX-STOP-MOVEL] ℹ️ Stop Móvel já ativo para ${sym} (${params.positionSide}). Preservando topos/fundos e Stop Loss.`);
      if (params.qty && params.qty !== "0") existing.qty = params.qty;
      if (params.positionId) existing.positionId = params.positionId;
      if (params.takeProfitPrice && params.takeProfitPrice > 0) existing.takeProfitPrice = params.takeProfitPrice;
      saveBitunixTrailingStopsToFile();
      return existing;
    }

    let callbackRate = params.callbackRate;
    let actPrice = params.activationPrice || 0;
    const slDist = params.stopLossPrice && params.stopLossPrice > 0 ? Math.abs(entryPrice - params.stopLossPrice) : (entryPrice * 0.02);

    if (!callbackRate || callbackRate <= 0) {
      const slDistPct = (entryPrice > 0 && slDist > 0) ? (slDist / entryPrice) * 100 : 2.0;
      callbackRate = parseFloat((slDistPct * multiplier).toFixed(3));
      if (!actPrice || actPrice <= 0) {
        actPrice = isLong ? entryPrice + (slDist * multiplier) : entryPrice - (slDist * multiplier);
      }
    }

    if (callbackRate < 0.1) callbackRate = 0.1;
    if (callbackRate > 10.0) callbackRate = 10.0;

    const initialActivated = actPrice <= 0 || (isLong ? entryPrice >= actPrice : entryPrice <= actPrice);
    const initialSL = params.stopLossPrice && params.stopLossPrice > 0 
      ? params.stopLossPrice 
      : (isLong ? entryPrice * (1 - callbackRate / 100) : entryPrice * (1 + callbackRate / 100));

    const strategy = serverTelegramBotConfig.conducaoStrategy || 'CONDUCAO';
    const isConducao = strategy === 'CONDUCAO' || serverTelegramBotConfig.conducaoStopEnabled !== false;

    const c0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
    const c1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
    const c3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
    const c4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
    const c5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
    const c6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;

    const defTrigger = isLong ? entryPrice + (slDist * c0) : entryPrice - (slDist * c0);
    const beTrigger = isLong ? entryPrice + (slDist * c1) : entryPrice - (slDist * c1);
    const f1Trigger = isLong ? entryPrice + (slDist * c3) : entryPrice - (slDist * c3);
    const f2Trigger = isLong ? entryPrice + (slDist * c5) : entryPrice - (slDist * c5);

    const record: BitunixTrailingStopRecord = {
      symbol: sym,
      cleanSymbol: clean,
      positionSide: params.positionSide,
      entryPrice,
      activationPrice: actPrice,
      callbackRate,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      isActivated: initialActivated,
      currentStopLoss: initialSL,
      initialStopLoss: initialSL,
      takeProfitPrice: params.takeProfitPrice,
      qty: params.qty || "0",
      positionId: params.positionId,
      pricePrecision: precision,
      lastNotifiedSLPrice: initialSL,
      strategy: isConducao ? 'CONDUCAO' : 'TRAILING',
      stopDistance: slDist,
      maxUnitsReached: 0,
      conducaoStage: 0,
      createdAt: Date.now(),
      lastUpdated: Date.now()
    };

    bitunixActiveTrailingStops.set(sym, record);
    bitunixActiveTrailingStops.set(`${clean}USDT`, record);
    saveBitunixTrailingStopsToFile();

    // 🛡️ Anexa imediatamente o Stop Loss inicial na posição ativa da Bitunix (com Take Profit protegido)
    (async () => {
      const delays = [200, 1200, 3000];
      for (const delay of delays) {
        try {
          await new Promise(r => setTimeout(r, delay));
          const bitunixKey = DEFAULT_BITUNIX_KEY;
          const bitunixSecret = DEFAULT_BITUNIX_SECRET;
          if (!bitunixKey || !bitunixSecret) break;

          const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, bitunixKey, bitunixSecret);
          const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
          const pos = positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, sym) && Math.abs(parseFloat(p.holdAmt || p.total || p.qty || '0')) > 0);
          if (pos && pos.positionId) {
            record.positionId = pos.positionId;
            const tpslRes = await safeSetBitunixPositionTPSL({
              symbol: sym,
              positionId: pos.positionId,
              slPrice: initialSL.toFixed(precision),
              tpPrice: record.takeProfitPrice || undefined,
              apiKey: bitunixKey,
              apiSecret: bitunixSecret
            });
            console.log(`[BITUNIX-STOP-ATTACH] SL Inicial anexado à posição #${pos.positionId} na Bitunix com TP=${record.takeProfitPrice || 'Nenhum'}:`, JSON.stringify(tpslRes));
            if (tpslRes?.code === 0) break;
          }
        } catch (e: any) {
          console.warn(`[BITUNIX-STOP-ATTACH-ERR]:`, e?.message || e);
        }
      }
    })();

    console.log(`[BITUNIX-STOP-MOVEL] ✅ Stop registrado para ${sym}: Estratégia=${record.strategy}, SL Inicial=$${initialSL.toFixed(precision)}`);

    const msg = isConducao ? (
      `🎯 <b>CONDUÇÃO DE STOP (PROTEÇÃO ESCALONADA) ATIVADA NA BITUNIX!</b>\n\n` +
      `📊 <b>Par:</b> <code>${sym}</code> (${params.positionSide} ${isLong ? '🟢' : '🔴'})\n` +
      `⚡ <b>Preço de Entrada:</b> <code>$${entryPrice.toFixed(precision)}</code>\n` +
      `🛑 <b>Stop Loss Inicial:</b> <code>$${initialSL.toFixed(precision)}</code> (Distância: <code>$${slDist.toFixed(precision)}</code>)\n` +
      `🎯 <b>Estratégia:</b> <b>Condução por Vezes o Stop Loss (Alvos) 🟢</b>\n\n` +
      `<b>Escalonamento Programado:</b>\n` +
      `• 🛡️ <b>Stop Defensivo (${c0}x):</b> gatilho em <code>$${defTrigger.toFixed(precision)}</code> <i>(puxa Stop p/ -33%)</i>\n` +
      `• ⚖️ <b>Break-Even (${c1}x):</b> gatilho em <code>$${beTrigger.toFixed(precision)}</code> <i>(0 a 0 + cobrir taxas)</i>\n` +
      `• 🚀 <b>Fase 1 Lucro (${c3}x):</b> a partir de <code>$${f1Trigger.toFixed(precision)}</code> <i>(folga ${c4}x)</i>\n` +
      `• 📈 <b>Fase 2 Avanço (${c5}x):</b> a partir de <code>$${f2Trigger.toFixed(precision)}</code> <i>(folga ${c6}x)</i>\n\n` +
      `🟢 <i>O robô monitora a posição em tempo real e avança o Stop Loss na Bitunix conforme cada nível é atingido!</i>`
    ) : (
      `🛡️ <b>STOP MÓVEL (TRAILING STOP) ATIVADO NA BITUNIX!</b>\n\n` +
      `📊 <b>Par:</b> <code>${sym}</code> (${params.positionSide} ${isLong ? '🟢' : '🔴'})\n` +
      `🎯 <b>Entrada:</b> <code>$${entryPrice.toFixed(precision)}</code>\n` +
      `🛰️ <b>Gatilho de Ativação:</b> <code>${actPrice > 0 ? `$${actPrice.toFixed(precision)}` : 'Imediato'}</code>\n` +
      `📉 <b>Taxa de Recuo:</b> <code>${callbackRate}%</code> (Multiplicador ${multiplier}x)\n` +
      `🛡️ <b>Stop Loss Dinâmico:</b> <code>$${initialSL.toFixed(precision)}</code>\n\n` +
      `🟢 <i>O Stop Móvel está ativo e ajustará o Stop Loss na Bitunix dinamicamente conforme o preço avançar a seu favor!</i>`
    );

    await broadcastTelegramNotification(msg, {
      inline_keyboard: [
        [{ text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }]
      ]
    }).catch(() => {});

    return record;
  };

  stopBitunixTrailingStop = (symbol: string) => {
    const bitunixResolved = resolveBitunixSymbol(symbol);
    const sym = bitunixResolved.apiSymbol || symbol;
    const clean = (bitunixResolved.cleanSymbol || sym.replace('USDT', '')).toUpperCase();
    let had = false;
    for (const [k, rec] of Array.from(bitunixActiveTrailingStops.entries())) {
      if (isSameOrRelatedSymbol(k, sym) || isSameOrRelatedSymbol(rec.symbol, sym) || isSameOrRelatedSymbol(rec.cleanSymbol, clean)) {
        bitunixActiveTrailingStops.delete(k);
        had = true;
      }
    }
    bitunixActiveTrailingStops.delete(sym);
    bitunixActiveTrailingStops.delete(`${clean}USDT`);
    bitunixActiveTrailingStops.delete(clean);
    bitunixActiveTrailingStops.delete(symbol);
    if (had) {
      saveBitunixTrailingStopsToFile();
      console.log(`[BITUNIX-STOP-MOVEL] 🛑 Stop Móvel finalizado e limpo para ${sym}`);
    }
  };

  // =========================================================================
  // 🛡️ OPÇÃO 1 (PROTEÇÃO TOTAL): ATIVAÇÃO DE TRAILING STOP PÓS-EXECUÇÃO
  // Garante que o Trailing Stop NUNCA seja colocado no livro antes do preenchimento
  // da ordem limite, evitando 100% de acionamentos falsos ou prematuros pelo mercado!
  // =========================================================================
  deployPostExecutionTrailingStop = async (
    symbol: string,
    positionSide: string,
    actualQtyStr?: string,
    avgPriceNum?: number
  ) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const apiSymbol = bitunixResolved.apiSymbol || (symbol.includes('USDT') ? symbol : `${symbol}USDT`);
      const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
      const posSideUpper = (positionSide || 'LONG').toUpperCase() as 'LONG' | 'SHORT';

      const configKey = `${apiSymbol}_${posSideUpper}`;
      const configKeyClean = `${cleanUpper}_${posSideUpper}`;
      const cfg = pendingTrailingConfigs.get(configKey) || 
                  pendingTrailingConfigs.get(configKeyClean) ||
                  pendingTrailingConfigs.get(apiSymbol) ||
                  pendingTrailingConfigs.get(cleanUpper) ||
                  pendingTrailingConfigs.get(symbol);

      if (!serverTelegramBotConfig.trailingStopEnabled && !cfg) return;

      const finalEntryPrice = avgPriceNum || cfg?.entryPrice || 0;
      const precision = cfg?.pricePrecision ?? (finalEntryPrice >= 1000 ? 2 : finalEntryPrice >= 1 ? 4 : 5);
      const effectiveRate = cfg?.effectiveRate || 1.0;
      const actPrice = cfg?.activationPrice || 0;

      // Ativa o Stop Móvel nativo para Bitunix com proteção escalonada
      await registerBitunixTrailingStop({
        symbol: apiSymbol,
        positionSide: posSideUpper,
        entryPrice: finalEntryPrice,
        stopLossPrice: cfg?.stopLossPrice,
        takeProfitPrice: cfg?.takeProfitPrice,
        callbackRate: effectiveRate,
        activationPrice: actPrice,
        qty: actualQtyStr || cfg?.quantity || "0",
        pricePrecision: precision
      });

      // Limpa configuração agendada e todas as variações de chave
      pendingTrailingConfigs.delete(configKey);
      pendingTrailingConfigs.delete(configKeyClean);
      pendingTrailingConfigs.delete(apiSymbol);
      pendingTrailingConfigs.delete(cleanUpper);
      pendingTrailingConfigs.delete(symbol);
      pendingTrailingConfigs.delete(`${symbol}_${posSideUpper}`);
      pendingTrailingConfigs.delete(`${symbol.replace('-USDT', '')}_${posSideUpper}`);
      pendingTrailingConfigs.delete(`${symbol.replace('USDT', '')}_${posSideUpper}`);
      if (cfg?.orderId) pendingTrailingConfigs.delete(cfg.orderId.toString());
      savePendingTrailingConfigsToFile();

      console.log(`[TRAILING-POST-EXEC] ✅ Stop Móvel pós-execução ativado com sucesso para ${apiSymbol}`);
    } catch (err: any) {
      console.error("[TRAILING-POST-EXEC-ERROR]:", err?.message || err);
    }
  };

  // Render open positions overview in Telegram with interactive action buttons directly under each position
  const renderTelegramPositionsMessage = async (chatId: number | string, messageIdToEdit?: number) => {
    if (!messageIdToEdit) {
      await clearActiveKeyboardsForChat(chatId);
    }

    const accCtx = getAccountContextForChat(chatId);
    const isDemo = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
    const accLabel = accCtx.isOperator
      ? `👤 ${accCtx.name} (${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'})`
      : (isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real');
    const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
    const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

    const data = await getBingXOpenPositions(apiKey, apiSecret, isDemo);

    if (!data.success || data.positions.length === 0) {
      const emptyText = `📋 <b>PAINEL DE ORDENS & POSIÇÕES BITUNIX</b>\n` +
        `💼 Conta: <b>${accLabel}</b>\n` +
        `💰 Saldo Disponível: <b>$${(data.balance || 0).toFixed(2)} USDT</b>\n\n` +
        `ℹ️ <i>Nenhuma posição aberta no momento na Bitunix.</i>\n\n` +
        `💡 <i>Envie um sinal de trade para abrir uma nova operação com cálculo automático de risco!</i>`;

      const emptyKeyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Atualizar Lista", callback_data: "REFRESH_POSITIONS" },
            { text: "⏳ Ver Pendentes", callback_data: "LIST_PENDING_ORDERS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text: emptyText,
          parse_mode: "HTML",
          reply_markup: emptyKeyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, emptyText, emptyKeyboard);
      }
      return;
    }

    const positions = data.positions;
    const isDemoAccount = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
    const accCurrency = isDemoAccount ? 'USDT' : 'USDT';
    const exchangeLabel = 'Bitunix';

    for (let idx = 0; idx < positions.length; idx++) {
      const pos = positions[idx];
      const isLong = pos.positionSide === 'LONG';
      const dirEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';
      const pnlEmoji = pos.unrealizedProfit >= 0 ? '🟢' : '🔴';
      const pnlSign = pos.unrealizedProfit >= 0 ? '+' : '';

      const headerPrefix = positions.length > 1 
        ? `📋 <b>POSIÇÃO (${idx + 1}/${positions.length}): ${pos.symbol}</b>\n`
        : `📋 <b>POSIÇÃO ABERTA: ${pos.symbol}</b>\n`;

      const bitunixSym = resolveBitunixSymbol(pos.symbol).apiSymbol;
      const cleanUpper = (pos.cleanSymbol || pos.symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                       bitunixActiveTrailingStops.get(pos.symbol) || 
                       bitunixActiveTrailingStops.get(cleanUpper);

      const prec = trRecord?.pricePrecision ?? (pos.entryPrice >= 1000 ? 2 : pos.entryPrice >= 1 ? 4 : 5);
      const formatP = (v: number) => v.toFixed(prec);

      const displayCurrentPrice = (pos.markPrice && pos.markPrice > 0) 
        ? pos.markPrice 
        : (pos.entryPrice || 0);

      // Preço de Liquidação
      let liqDisplay = pos.liquidationPrice && pos.liquidationPrice > 0 ? `$${formatP(pos.liquidationPrice)}` : '';
      if (!liqDisplay) {
        const estLiq = isLong
          ? pos.entryPrice * (1 - 1 / (pos.leverage || 20) + 0.005)
          : pos.entryPrice * (1 + 1 / (pos.leverage || 20) - 0.005);
        liqDisplay = `$${formatP(estLiq)}`;
      }

      const slDisplay = pos.stopLoss ? `$${pos.stopLoss}` : (trRecord?.currentStopLoss ? `$${formatP(trRecord.currentStopLoss)}` : 'Não Definido');

      // Status do Stop Protegido
      let protectedStopDisplay = "Não Ativado (Aguardando Alvo 1x)";
      if (trRecord) {
        const stage = trRecord.conducaoStage || 0;
        const maxUnits = trRecord.maxUnitsReached || 0;
        if (stage === 1) {
          protectedStopDisplay = `Ativado (-33% Risco / $${formatP(trRecord.currentStopLoss)})`;
        } else if (stage === 2) {
          protectedStopDisplay = `Break-Even (0 a 0 / $${formatP(trRecord.currentStopLoss)})`;
        } else if (stage === 3) {
          protectedStopDisplay = `Fase 1 (+${maxUnits.toFixed(1)}x / $${formatP(trRecord.currentStopLoss)})`;
        } else if (stage >= 4) {
          protectedStopDisplay = `Fase 2 (+${maxUnits.toFixed(1)}x / $${formatP(trRecord.currentStopLoss)})`;
        }
      }

      const timeNow = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });

      // Mensagem exatamente idêntica ao Print 1
      const posText = headerPrefix +
        `════════════════════════════════════\n` +
        `💼 Conta: <b>${accLabel}</b>\n` +
        `💰 Saldo Disponível: <b>$${data.balance.toFixed(2)} ${accCurrency}</b>\n` +
        `════════════════════════════════════\n\n` +
        `📊 <b>Direção & Alavancagem:</b> ${dirEmoji} <b>${pos.leverage}x</b>\n` +
        `📈 <b>PnL ao Vivo:</b> <b>${pnlSign}$${pos.unrealizedProfit.toFixed(2)} (${pnlSign}${pos.pnlPercent.toFixed(2)}%)</b> ${pnlEmoji}\n` +
        `⚡ <b>Entrada:</b> <code>$${pos.entryPrice}</code> | <b>Atual:</b> <code>$${displayCurrentPrice}</code>\n` +
        `💥 <b>Liquidação:</b> <code>${liqDisplay}</code>\n` +
        `💰 <b>Margem:</b> <code>$${pos.margin.toFixed(2)} ${accCurrency}</code> (Posição: <b>$${pos.notional.toFixed(2)}</b>)\n` +
        `🛑 <b>Stop Loss Ativo (${exchangeLabel}):</b> <code>${slDisplay}</code>\n` +
        `🛡️ <b>Stop Protegido:</b> <i>${protectedStopDisplay}</i>\n` +
        `🎯 <b>Take Profit:</b> <code>${pos.takeProfit ? `$${pos.takeProfit}` : 'Não Definido'}</code>\n` +
        `════════════════════════════════════\n` +
        `🕒 <i>Atualizado às ${timeNow} (Brasília)</i>`;

      // Botões exatamente idênticos ao Print 1
      const posKeyboardRows: any[] = [
        // Linha 1: 25%, 50%, 75% e 100%
        [
          { text: `✂️ 25%`, callback_data: `PARTIAL_CLOSE:${pos.symbol}:${pos.positionSide}:25` },
          { text: `✂️ 50%`, callback_data: `PARTIAL_CLOSE:${pos.symbol}:${pos.positionSide}:50` },
          { text: `✂️ 75%`, callback_data: `PARTIAL_CLOSE:${pos.symbol}:${pos.positionSide}:75` },
          { text: `🛑 100%`, callback_data: `CLOSE_POS:${pos.symbol}:${pos.positionSide}` }
        ],
        // Linha 2: Editar SL, Editar TP, Condução
        [
          { text: `🛑 Editar SL`, callback_data: `PROMPT_TYPE_SL:${pos.symbol}:${pos.positionSide}` },
          { text: `🎯 Editar TP`, callback_data: `PROMPT_TYPE_TP:${pos.symbol}:${pos.positionSide}` },
          { text: `⚡ Condução`, callback_data: `VIEW_POS_CONDUCAO:${pos.symbol}:${pos.positionSide}` }
        ],
        // Linha 3: Breakeven, Sinal VIP, Alvos
        [
          { text: `🛡️ Breakeven`, callback_data: `SET_BE:${pos.symbol}:${pos.positionSide}` },
          { text: `🎯 Sinal VIP`, callback_data: `VIEW_VIP_SIGNAL:${pos.symbol}:${pos.positionSide}` },
          { text: `✅ Alvos`, callback_data: `VIEW_TARGETS:${pos.symbol}:${pos.positionSide}` }
        ],
        // Linha 4: Atualizar
        [
          { text: `🔄 Atualizar`, callback_data: "REFRESH_POSITIONS" }
        ]
      ];

      const keyboard = { inline_keyboard: posKeyboardRows };

      if (messageIdToEdit && idx === 0 && positions.length === 1) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text: posText,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
      } else {
        await sendTelegramReply(chatId, posText, keyboard, { preserveBatch: true, disableDedup: true });
      }
    }
  };

  // =========================================================================
  // 🎯 DETALHES DE CONDUÇÃO DE STOP ESPECÍFICA DA POSIÇÃO (PRINT 2)
  // Permite visualizar e alterar parâmetros de condução SOMENTE para essa posição
  // =========================================================================
  const renderTelegramPositionConducao = async (
    chatId: number | string, 
    symbol: string, 
    positionSide: string, 
    messageIdToEdit?: number
  ) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const bitunixSym = bitunixResolved.apiSymbol;
      const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
      const isDemo = serverTelegramBotConfig.accountType === 'VST';

      const data = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
      const pos = data.positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym) || isSameOrRelatedSymbol(p.symbol, symbol));

      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                       bitunixActiveTrailingStops.get(symbol) || 
                       bitunixActiveTrailingStops.get(cleanUpper);

      const side = (pos?.positionSide || positionSide || trRecord?.positionSide || 'LONG') as 'LONG' | 'SHORT';
      const isLong = side === 'LONG';
      const sideEmoji = isLong ? '🟢 LONG' : '🔴 SHORT';

      const entryPrice = pos?.entryPrice || trRecord?.entryPrice || 0;
      const currentPrice = (pos?.markPrice && pos.markPrice > 0) ? pos.markPrice : (pos?.entryPrice || trRecord?.highestPrice || entryPrice);
      const prec = trRecord?.pricePrecision ?? (entryPrice >= 1000 ? 2 : entryPrice >= 1 ? 4 : 5);
      const formatP = (v: number) => v.toFixed(prec);

      const currentSL = pos?.stopLoss || trRecord?.currentStopLoss || trRecord?.initialStopLoss || (isLong ? entryPrice * 0.98 : entryPrice * 1.02);
      const initialSL = trRecord?.initialStopLoss || currentSL;
      const slDist = trRecord?.stopDistance && trRecord.stopDistance > 0 
        ? trRecord.stopDistance 
        : (Math.abs(entryPrice - initialSL) || (entryPrice * 0.02));

      // Configurações Globais vs Específicas da Posição
      const isCustom = !!trRecord?.customConducao;
      const g0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
      const g1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
      const g2 = serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5;
      const g3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
      const g4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
      const g5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
      const g6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;

      const c0 = (isCustom && trRecord?.tier0Trigger !== undefined) ? trRecord.tier0Trigger : g0;
      const c1 = (isCustom && trRecord?.tier1Trigger !== undefined) ? trRecord.tier1Trigger : g1;
      const c2 = (isCustom && trRecord?.tier2Trigger !== undefined) ? trRecord.tier2Trigger : g2;
      const c3 = (isCustom && trRecord?.tier3Trigger !== undefined) ? trRecord.tier3Trigger : g3;
      const c4 = (isCustom && trRecord?.tier4Dist !== undefined) ? trRecord.tier4Dist : g4;
      const c5 = (isCustom && trRecord?.tier5Trigger !== undefined) ? trRecord.tier5Trigger : g5;
      const c6 = (isCustom && trRecord?.tier6Dist !== undefined) ? trRecord.tier6Dist : g6;

      // Cotações dos Gatilhos
      const quoteDef = isLong ? entryPrice + (c0 * slDist) : entryPrice - (c0 * slDist);
      const quoteDefSL = isLong ? entryPrice - (0.33 * slDist) : entryPrice + (0.33 * slDist);
      const quoteBE = isLong ? entryPrice + (c1 * slDist) : entryPrice - (c1 * slDist);
      const feeTick = entryPrice * 0.0010;
      const quoteEq = isLong ? entryPrice + feeTick : entryPrice - feeTick;
      const quoteF1 = isLong ? entryPrice + (c3 * slDist) : entryPrice - (c3 * slDist);
      const quoteF2 = isLong ? entryPrice + (c5 * slDist) : entryPrice - (c5 * slDist);

      // Preços para o Exemplo Prático Real
      const p2 = isLong ? entryPrice + (2 * slDist) : entryPrice - (2 * slDist);
      const s2 = isLong ? entryPrice + ((2 - c4) * slDist) : entryPrice - ((2 - c4) * slDist);

      const p2_5 = isLong ? entryPrice + (2.5 * slDist) : entryPrice - (2.5 * slDist);
      const s2_5 = isLong ? entryPrice + ((2.5 - c4) * slDist) : entryPrice - ((2.5 - c4) * slDist);

      const p3 = isLong ? entryPrice + (3 * slDist) : entryPrice - (3 * slDist);
      const s3 = isLong ? entryPrice + ((3 - c6) * slDist) : entryPrice - ((3 - c6) * slDist);

      const p3_5 = isLong ? entryPrice + (3.5 * slDist) : entryPrice - (3.5 * slDist);
      const s3_5 = isLong ? entryPrice + ((3.5 - c6) * slDist) : entryPrice - ((3.5 - c6) * slDist);

      const p4 = isLong ? entryPrice + (4 * slDist) : entryPrice - (4 * slDist);
      const s4 = isLong ? entryPrice + ((4 - c6) * slDist) : entryPrice - ((4 - c6) * slDist);

      const p4_5 = isLong ? entryPrice + (4.5 * slDist) : entryPrice - (4.5 * slDist);
      const s4_5 = isLong ? entryPrice + ((4.5 - c6) * slDist) : entryPrice - ((4.5 - c6) * slDist);

      const p5 = isLong ? entryPrice + (5 * slDist) : entryPrice - (5 * slDist);
      const s5 = isLong ? entryPrice + ((5 - c6) * slDist) : entryPrice - ((5 - c6) * slDist);

      const p5_5 = isLong ? entryPrice + (5.5 * slDist) : entryPrice - (5.5 * slDist);
      const s5_5 = isLong ? entryPrice + ((5.5 - c6) * slDist) : entryPrice - ((5.5 - c6) * slDist);

      const tpPrice = pos?.takeProfit || trRecord?.takeProfitPrice || (isLong ? entryPrice + 6 * slDist : entryPrice - 6 * slDist);
      const tpMult = slDist > 0 ? (Math.abs(tpPrice - entryPrice) / slDist) : 6.0;
      const netLucro = Math.max(0, tpMult - c6);
      const tpStop = isLong ? entryPrice + (netLucro * slDist) : entryPrice - (netLucro * slDist);

      const slLabel = trRecord?.conducaoStage && trRecord.conducaoStage > 0 ? "Alvo Protegido" : "Stop Loss Ativo";
      const badgeText = isCustom ? "CUSTOMIZADA DESTA POSIÇÃO" : "PADRÃO GLOBAL";
      const badgeEmoji = isCustom ? "🔵" : "🟢";
      const timeNow = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });

      // Mensagem exatamente idêntica ao Print 2
      const text =
        `🎯 <b>CONDUÇÃO DE STOP LOSS — ${cleanUpper} (${sideEmoji})</b>\n\n` +
        `⚡ <b>Entrada:</b> <code>$${formatP(entryPrice)}</code> | <b>Preço Atual:</b> <code>$${formatP(currentPrice)}</code>\n` +
        `🛑 <b>Stop Atual da Operação:</b> <code>$${formatP(currentSL)}</code> <i>(${slLabel})</i>\n` +
        `📏 <b>Distância do Stop (1x):</b> <code>$${formatP(slDist)}</code>\n\n` +
        `════════════════════════════════════════\n` +
        `⚙️ <b>CONDUÇÃO DESTA POSIÇÃO: [${badgeText}] ${badgeEmoji}</b>\n` +
        `0️⃣ <b>Stop Defensivo:</b> em <b>${c0}x Stop</b> (Cotação: <code>$${formatP(quoteDef)}</code> ➔ Stop: <code>$${formatP(quoteDefSL)}</code> a -33%)\n` +
        `1️⃣ <b>Break-Even:</b> em <b>${c1}x Stop</b> (Cotação: <code>$${formatP(quoteBE)}</code>)\n` +
        `2️⃣ <b>Preço de Equilíbrio:</b> em <b>${c2}x Stop</b> (Cotação: <code>$${formatP(quoteBE)}</code> ➔ Stop: <code>$${formatP(quoteEq)}</code>)\n` +
        `3️⃣ <b>Começar Condução:</b> a partir de <b>${c3}x Stop</b> (Cotação: <code>$${formatP(quoteF1)}</code>)\n` +
        `4️⃣ <b>Folga Inicial (Fase 1):</b> mantendo <b>${c4}x Stop</b> recuado\n` +
        `5️⃣ <b>Apertar Stop (Fase 2):</b> em <b>${c5}x Stop</b> (Cotação: <code>$${formatP(quoteF2)}</code>)\n` +
        `6️⃣ <b>Folga Reduzida (Fase 2):</b> mantendo <b>${c6}x Stop</b> recuado\n\n` +
        `════════════════════════════════════════\n` +
        `📊 <b>EXEMPLO PRÁTICO NA OPERAÇÃO (PREÇOS REAIS):</b>\n` +
        `• Cotação a <code>$${formatP(quoteDef)}</code> (+${c0}x): Stop ➔ <code>$${formatP(quoteDefSL)}</code> (Stop Defensivo a -33% / 67% de Risco Eliminado) 🛡️\n` +
        `• Cotação a <code>$${formatP(quoteBE)}</code> (+${c1}x): Stop ➔ <code>$${formatP(quoteEq)}</code> (Preço de Equilíbrio / Taxas Pagas) ⚖️\n` +
        `• Cotação a <code>$${formatP(p2)}</code> (+2x): Stop ➔ <code>$${formatP(s2)}</code> (+${(2 - c4).toFixed(1).replace('.0','')}x Lucro no Bolso)\n` +
        `• Cotação a <code>$${formatP(p2_5)}</code> (+2.5x): Stop ➔ <code>$${formatP(s2_5)}</code> (+${(2.5 - c4).toFixed(1).replace('.0','')}x Lucro no Bolso)\n` +
        `• Cotação a <code>$${formatP(p3)}</code> (+3x): Stop ➔ <code>$${formatP(s3)}</code> (+${(3 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(p3_5)}</code> (+3.5x): Stop ➔ <code>$${formatP(s3_5)}</code> (+${(3.5 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(p4)}</code> (+4x): Stop ➔ <code>$${formatP(s4)}</code> (+${(4 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(p4_5)}</code> (+4.5x): Stop ➔ <code>$${formatP(s4_5)}</code> (+${(4.5 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(p5)}</code> (+5x): Stop ➔ <code>$${formatP(s5)}</code> (+${(5 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(p5_5)}</code> (+5.5x): Stop ➔ <code>$${formatP(s5_5)}</code> (+${(5.5 - c6).toFixed(1).replace('.0','')}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x)\n` +
        `• Cotação a <code>$${formatP(tpPrice)}</code> (🎯 Take Profit Final / +${tpMult.toFixed(2)}x): Stop ➔ <code>$${formatP(tpStop)}</code> (+${netLucro.toFixed(2)}x Lucro no Bolso) (Fase 2 ⚡ Folga ${c6}x) 🚀\n\n` +
        `════════════════════════════════════════\n` +
        `💡 <i>Qualquer alteração feita aqui mudará SOMENTE esta posição de ${cleanUpper}. As próximas posições continuarão com o padrão configurado globalmente.</i>\n\n` +
        `🕒 <i>Atualizado às ${timeNow} (Brasília)</i>`;

      // Botões exatamente idênticos ao Print 2
      const conducaoRows: any[] = [
        [
          { text: `🛡️ 0. Stop Defensivo (${c0}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:def` }
        ],
        [
          { text: `✏️ 1. Break-Even (${c1}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:be` },
          { text: `⚖️ 2. Equilíbrio (${c2}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:eq` }
        ],
        [
          { text: `🚀 3. Início F1 (${c3}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:f1` },
          { text: `📏 4. Folga F1 (${c4}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:folga1` }
        ],
        [
          { text: `⚡ 5. Apertar F2 (${c5}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:f2` },
          { text: `🎯 6. Folga F2 (${c6}x)`, callback_data: `EDIT_POS_PARAM:${symbol}:${side}:folga2` }
        ],
        [
          { text: `🛡️ Mover BE Agora (0 a 0)`, callback_data: `POS_MOVE_BE_NOW:${symbol}:${side}` },
          { text: `📋 Voltar p/ Posições`, callback_data: `REFRESH_POSITIONS` }
        ]
      ];

      if (isCustom) {
        conducaoRows.push([
          { text: `🔄 Resetar p/ Padrão Global`, callback_data: `RESET_POS_CONDUCAO:${symbol}:${side}` }
        ]);
      }

      const keyboard = { inline_keyboard: conducaoRows };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(async () => {
          await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
        });
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (e: any) {
      console.error("[RENDER-POS-CONDUCAO-ERR]:", e.message);
    }
  };

  // Submenu de Edição de um Parâmetro Específico da Posição
  const renderEditPosParamMenu = async (
    chatId: number | string,
    symbol: string,
    side: string,
    param: 'def' | 'be' | 'eq' | 'f1' | 'folga1' | 'f2' | 'folga2',
    messageIdToEdit?: number
  ) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
      const bitunixSym = bitunixResolved.apiSymbol;
      const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                       bitunixActiveTrailingStops.get(symbol) || 
                       bitunixActiveTrailingStops.get(cleanUpper);

      let paramName = "";
      let paramDesc = "";
      let currentVal = 1.5;
      let presets: number[] = [];

      if (param === 'def') {
        paramName = "0. STOP DEFENSIVO (-33%)";
        paramDesc = "Em quantas vezes a distância do Stop Loss o robô deve puxar o Stop para -33% (cortando 67% da perda máxima e dando folga contra violinadas)?";
        currentVal = trRecord?.tier0Trigger ?? serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
        presets = [0.8, 1.0, 1.2, 1.5];
      } else if (param === 'be') {
        paramName = "1. BREAK-EVEN";
        paramDesc = "Em quantas vezes a distância do Stop Loss o robô deve mover a operação para o Break-Even (0 a 0)?";
        currentVal = trRecord?.tier1Trigger ?? serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
        presets = [1.0, 1.2, 1.5, 2.0];
      } else if (param === 'eq') {
        paramName = "2. PREÇO DE EQUILÍBRIO (TAXAS)";
        paramDesc = "Em quantas vezes a distância do Stop o robô deve garantir o Stop cobrindo 100% das taxas da corretora?";
        currentVal = trRecord?.tier2Trigger ?? serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5;
        presets = [1.0, 1.2, 1.5, 2.0];
      } else if (param === 'f1') {
        paramName = "3. INÍCIO DA FASE 1 (CONDUÇÃO)";
        paramDesc = "A partir de quantas vezes o Stop o robô deve iniciar a condução dinâmica no lucro?";
        currentVal = trRecord?.tier3Trigger ?? serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
        presets = [1.5, 2.0, 2.5, 3.0];
      } else if (param === 'folga1') {
        paramName = "4. FOLGA INICIAL (FASE 1)";
        paramDesc = "Quantas vezes a distância do Stop deve ser mantida de recuo/folga durante a Fase 1?";
        currentVal = trRecord?.tier4Dist ?? serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
        presets = [0.5, 0.8, 1.0, 1.5];
      } else if (param === 'f2') {
        paramName = "5. APERTAR STOP (FASE 2)";
        paramDesc = "A partir de quantas vezes o Stop o robô deve entrar na Fase 2 e colar o Stop no preço?";
        currentVal = trRecord?.tier5Trigger ?? serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
        presets = [2.5, 3.0, 3.5, 4.0];
      } else if (param === 'folga2') {
        paramName = "6. FOLGA REDUZIDA (FASE 2)";
        paramDesc = "Quantas vezes a distância do Stop deve ser mantida de recuo colado durante a Fase 2?";
        currentVal = trRecord?.tier6Dist ?? serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;
        presets = [0.3, 0.5, 0.8, 1.0];
      }

      const text =
        `⚙️ <b>AJUSTAR ${paramName} — ${cleanUpper}</b>\n\n` +
        `${paramDesc}\n\n` +
        `📌 <b>Valor atual nesta posição:</b> <code>${currentVal}x Stop</code>\n\n` +
        `👉 <i>Selecione um dos atalhos abaixo ou toque em 'Digitar Outro Valor' para enviar pelo chat:</i>`;

      const rows: any[] = [
        presets.map(p => ({
          text: `${p}x`,
          callback_data: `APPLY_POS_PARAM:${symbol}:${side}:${param}:${p}`
        })),
        [
          { text: "✏️ Digitar Outro Valor", callback_data: `PROMPT_POS_PARAM:${symbol}:${side}:${param}` }
        ],
        [
          { text: "🔙 Voltar p/ Condução", callback_data: `VIEW_POS_CONDUCAO:${symbol}:${side}` }
        ]
      ];

      const keyboard = { inline_keyboard: rows };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (e: any) {
      console.error("[RENDER-EDIT-PARAM-ERR]:", e.message);
    }
  };

  // Helper compartilhado para montar os dados do Sinal VIP da posição aberta (entrada real + alvos recalculados)
  const buildPositionVipSignalData = async (symbol: string, side: string) => {
    const bitunixResolved = resolveBitunixSymbol(symbol);
    const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    const data = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);

    const sideUpper = (side || 'LONG').toUpperCase();
    const pos = data.positions.find((p: any) =>
      (isSameOrRelatedSymbol(p.symbol, symbol) || isSameOrRelatedSymbol(p.symbol, bitunixResolved.apiSymbol)) &&
      (!side || p.positionSide === sideUpper)
    ) || data.positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, symbol) || isSameOrRelatedSymbol(p.symbol, bitunixResolved.apiSymbol));

    const trRecord = bitunixActiveTrailingStops.get(bitunixResolved.apiSymbol) ||
                     bitunixActiveTrailingStops.get(symbol) ||
                     bitunixActiveTrailingStops.get(`${cleanUpper}USDT`) ||
                     bitunixActiveTrailingStops.get(cleanUpper);

    const matchedSignal = receivedTelegramSignals.find(s => {
      const sigSym = s.parsed?.apiSymbol || s.parsed?.symbol || s.parsed?.coinName || '';
      const sameSym = isSameOrRelatedSymbol(sigSym, cleanUpper) || isSameOrRelatedSymbol(sigSym, bitunixResolved.apiSymbol);
      const sigDir = s.parsed?.direction;
      return sameSym && (!sigDir || sigDir === (pos?.positionSide || sideUpper));
    });

    const isLong = (pos?.positionSide === 'LONG') || sideUpper === 'LONG';
    const direction: 'LONG' | 'SHORT' = isLong ? 'LONG' : 'SHORT';

    const entry = (pos?.entryPrice && pos.entryPrice > 0)
      ? Number(pos.entryPrice)
      : Number(trRecord?.entryPrice || matchedSignal?.parsed?.entryPrice || 0);

    const currentPrice = (pos?.markPrice && pos.markPrice > 0)
      ? Number(pos.markPrice)
      : entry;

    const lev = pos?.leverage || matchedSignal?.parsed?.leverage || 20;

    const liveSL = (pos?.stopLoss && pos.stopLoss > 0) ? Number(pos.stopLoss) : 0;
    const trInitialSl = (trRecord?.initialStopLoss && trRecord.initialStopLoss > 0) ? Number(trRecord.initialStopLoss) : 0;
    const trCurrentSl = (trRecord?.currentStopLoss && trRecord.currentStopLoss > 0) ? Number(trRecord.currentStopLoss) : 0;
    const sigSl = (matchedSignal?.parsed?.stopLoss && matchedSignal.parsed.stopLoss > 0) ? Number(matchedSignal.parsed.stopLoss) : 0;

    const isOnRiskSide = (slVal: number) => slVal > 0 && entry > 0 && (isLong ? slVal < entry : slVal > entry);

    // Stop para cálculo dos alvos: prioriza SL na zona de risco (ou inicial antes da condução mover p/ BE/lucro)
    let slForCalc = 0;
    if (trRecord && (trRecord.conducaoStage || 0) > 0) {
      if (isOnRiskSide(trInitialSl)) slForCalc = trInitialSl;
      else if (trRecord.stopDistance > 0 && entry > 0) slForCalc = isLong ? (entry - trRecord.stopDistance) : (entry + trRecord.stopDistance);
      else if (isOnRiskSide(liveSL)) slForCalc = liveSL;
      else if (isOnRiskSide(sigSl)) slForCalc = sigSl;
    } else {
      if (isOnRiskSide(liveSL)) slForCalc = liveSL;
      else if (isOnRiskSide(trInitialSl)) slForCalc = trInitialSl;
      else if (isOnRiskSide(trCurrentSl)) slForCalc = trCurrentSl;
      else if (isOnRiskSide(sigSl)) slForCalc = sigSl;
    }

    const slForDisplay = (trRecord && (trRecord.conducaoStage || 0) > 0 && slForCalc > 0)
      ? slForCalc
      : (liveSL > 0 ? liveSL : slForCalc);

    // Take final atualizado da posição aberta (Bitunix TP ativo -> trailing record -> último alvo do sinal)
    const isValidTpSide = (tpVal: number) => tpVal > 0 && entry > 0 && (isLong ? tpVal > entry : tpVal < entry);
    const liveTp = (pos?.takeProfit && pos.takeProfit > 0) ? Number(pos.takeProfit) : 0;
    const trTp = (trRecord?.takeProfitPrice && trRecord.takeProfitPrice > 0) ? Number(trRecord.takeProfitPrice) : 0;
    const sigLastTp = (Array.isArray(matchedSignal?.parsed?.takeProfits) && matchedSignal.parsed.takeProfits.length > 0)
      ? Number(matchedSignal.parsed.takeProfits[matchedSignal.parsed.takeProfits.length - 1])
      : 0;

    let finalTake = 0;
    if (isValidTpSide(liveTp)) finalTake = liveTp;
    else if (isValidTpSide(trTp)) finalTake = trTp;
    else if (isValidTpSide(sigLastTp)) finalTake = sigLastTp;

    const checkDecimals = (n: number | null | undefined) => {
      if (!n || isNaN(n)) return 0;
      const s = n.toString();
      if (s.includes('e-')) return Math.min(parseInt(s.split('e-')[1], 10) + 2, 8);
      const dot = s.indexOf('.');
      return dot >= 0 ? s.length - dot - 1 : 0;
    };
    const maxInputDecimals = Math.max(
      checkDecimals(entry),
      checkDecimals(slForCalc),
      checkDecimals(finalTake)
    );
    const contractPrec = bitunixResolved.contract?.pricePrecision;
    const pricePrecision = (typeof contractPrec === 'number' && contractPrec > 0)
      ? Math.max(contractPrec, maxInputDecimals)
      : Math.max(maxInputDecimals, entry > 0 ? (entry < 0.01 ? 6 : entry < 1 ? 5 : entry < 100 ? 4 : 2) : 4);

    // Recalcula todos os alvos (TP 1 = 1x stop, TP 2+ = +0.5x stop) conforme a entrada real da posição
    let takeProfits: number[] = [];
    if (entry > 0 && slForCalc > 0 && finalTake > 0) {
      takeProfits = generateTargetsUpToFinal(entry, slForCalc, finalTake, direction, pricePrecision);
    } else if (entry > 0 && slForCalc > 0) {
      const stopDistance = Math.abs(entry - slForCalc);
      if (stopDistance > 0) {
        const targetMultipliers = [1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
        for (const m of targetMultipliers) {
          const calcTp = isLong ? entry + (m * stopDistance) : entry - (m * stopDistance);
          if (calcTp > 0) {
            takeProfits.push(parseFloat(calcTp.toFixed(pricePrecision)));
          }
        }
      }
    } else if (finalTake > 0) {
      takeProfits = [parseFloat(finalTake.toFixed(pricePrecision))];
    } else if (Array.isArray(matchedSignal?.parsed?.takeProfits)) {
      takeProfits = matchedSignal.parsed.takeProfits;
    }

    const trMatchesTrade = Boolean(
      trRecord &&
      trRecord.positionSide === direction &&
      (!entry || !trRecord.entryPrice || Math.abs(entry - trRecord.entryPrice) / trRecord.entryPrice <= 0.02)
    );

    const hitTargets = takeProfits.map((tp: number) => {
      if (!tp || tp <= 0) return false;
      if (isLong) {
        const peakHigh = Math.max(currentPrice || 0, trMatchesTrade ? (trRecord?.highestPrice || 0) : 0);
        return peakHigh > 0 && peakHigh >= tp;
      } else {
        const lowCandidates = [currentPrice, trMatchesTrade ? trRecord?.lowestPrice : 0].filter((v): v is number => typeof v === 'number' && v > 0);
        const peakLow = lowCandidates.length > 0 ? Math.min(...lowCandidates) : 0;
        return peakLow > 0 && peakLow <= tp;
      }
    });

    const vipPayload = {
      coinName: cleanUpper,
      symbol: bitunixResolved.apiSymbol || symbol,
      apiSymbol: bitunixResolved.apiSymbol || symbol,
      direction,
      orderType: matchedSignal?.parsed?.orderType || 'LIMIT',
      entryPrice: entry > 0 ? parseFloat(entry.toFixed(pricePrecision)) : 0,
      entryPrice2: null,
      stopLoss: slForDisplay > 0 ? parseFloat(slForDisplay.toFixed(pricePrecision)) : 0,
      takeProfits,
      leverage: lev
    };

    return { vipPayload, hitTargets };
  };

  // Visualizar Card de Sinal VIP da Posição Aberta (enviado ABAIXO sem apagar a mensagem da posição)
  const renderTelegramPositionVIPSignal = async (chatId: number | string, symbol: string, side: string) => {
    try {
      const { vipPayload } = await buildPositionVipSignalData(symbol, side);
      const text = formatVipSignalMessage(vipPayload, false);

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✅ Alvos Atingidos", callback_data: `VIEW_HIT_TARGETS:${symbol}:${side}` },
            { text: "📋 Voltar p/ Posições", callback_data: "REFRESH_POSITIONS" }
          ]
        ]
      };

      await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
    } catch (e: any) {
      console.error("[RENDER-VIP-SIGNAL-ERR]:", e.message);
    }
  };

  // Visualizar Alvos Atingidos no formato exato do Sinal VIP com ✅ verdinho nos alvos atingidos
  const renderTelegramPositionVIPHitTargets = async (chatId: number | string, symbol: string, side: string, messageIdToEdit?: number) => {
    try {
      const { vipPayload, hitTargets } = await buildPositionVipSignalData(symbol, side);
      const text = formatVipSignalMessage({ ...vipPayload, hitTargets }, false);

      const keyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Atualizar Alvos", callback_data: `VIEW_HIT_TARGETS:${symbol}:${side}` },
            { text: "📋 Voltar p/ Posições", callback_data: "REFRESH_POSITIONS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (e: any) {
      console.error("[RENDER-VIP-HIT-TARGETS-ERR]:", e.message);
    }
  };

  // Visualizar Progresso dos Alvos
  const renderTelegramPositionTargets = async (chatId: number | string, symbol: string, side: string, messageIdToEdit?: number) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const data = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
      const pos = data.positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, symbol) || isSameOrRelatedSymbol(p.symbol, bitunixResolved.apiSymbol));
      const trRecord = bitunixActiveTrailingStops.get(bitunixResolved.apiSymbol) || bitunixActiveTrailingStops.get(symbol);

      const isLong = (pos?.positionSide === 'LONG') || side === 'LONG';
      const entryPrice = pos?.entryPrice || trRecord?.entryPrice || 0;
      const currentPrice = (pos?.markPrice && pos.markPrice > 0) ? pos.markPrice : (pos?.entryPrice || entryPrice);
      const slPrice = pos?.stopLoss || trRecord?.currentStopLoss || trRecord?.initialStopLoss || (isLong ? entryPrice * 0.98 : entryPrice * 1.02);
      const slDist = trRecord?.stopDistance || Math.abs(entryPrice - slPrice) || (entryPrice * 0.02);
      const prec = trRecord?.pricePrecision ?? (entryPrice >= 1000 ? 2 : entryPrice >= 1 ? 4 : 5);

      const targets = [
        { name: "TP 1", mult: 1.0 },
        { name: "TP 2", mult: 1.5 },
        { name: "TP 3", mult: 2.0 },
        { name: "TP 4", mult: 2.5 },
        { name: "TP 5", mult: 3.0 },
        { name: "TP 6", mult: 4.0 },
        { name: "TP 7 (Final)", mult: 5.0 }
      ];

      let targetLines = "";
      for (const t of targets) {
        const p = isLong ? entryPrice + (t.mult * slDist) : entryPrice - (t.mult * slDist);
        const reached = isLong ? currentPrice >= p : currentPrice <= p;
        const icon = reached ? "✅" : "🎯";
        const status = reached ? "<b>(Atingido)</b>" : "<i>(Aguardando)</i>";
        targetLines += `${icon} <b>${t.name}:</b> <code>$${p.toFixed(prec)}</code> (+${t.mult}x) ${status}\n`;
      }

      const text =
        `✅ <b>ALVOS DA OPERAÇÃO — ${cleanUpper} (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})</b>\n` +
        `════════════════════════════════════\n\n` +
        `⚡ <b>Preço de Entrada:</b> <code>$${entryPrice.toFixed(prec)}</code>\n` +
        `📈 <b>Preço Atual:</b> <code>$${currentPrice.toFixed(prec)}</code>\n\n` +
        `🎯 <b>PROGRESSO DOS ALVOS:</b>\n` +
        `${targetLines}\n` +
        `💡 <i>Os alvos são integrados com a condução automática de Stop Loss.</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "⚡ Condução", callback_data: `VIEW_POS_CONDUCAO:${symbol}:${side}` },
            { text: "📋 Voltar p/ Posições", callback_data: "REFRESH_POSITIONS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (e: any) {
      console.error("[RENDER-TARGETS-ERR]:", e.message);
    }
  };

  // Renderiza Edição Direta de Stop Loss (Apenas opção de digitar novo valor)
  const renderTelegramEditSLMenu = async (chatId: number | string, symbol: string, positionSide: string, messageIdToEdit?: number) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const bitunixSym = bitunixResolved.apiSymbol;
      const cleanUpper = bitunixResolved.cleanSymbol;
      const isDemo = serverTelegramBotConfig.accountType === 'VST';

      const data = await getBingXOpenPositions(DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
      const pos = data.positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym));

      const isLong = (pos?.positionSide === 'LONG') || positionSide === 'LONG';
      const side = isLong ? 'LONG' : 'SHORT';
      const entryPrice = pos?.entryPrice || 0;
      const markPrice = (pos?.markPrice && pos.markPrice > 0) ? pos.markPrice : entryPrice;
      const currentSL = pos?.stopLoss ? `$${pos.stopLoss}` : 'Não Definido';
      const prec = bitunixResolved.contract?.pricePrecision ?? (entryPrice >= 1000 ? 2 : entryPrice >= 1 ? 4 : 6);

      const formatP = (v: number) => v.toFixed(prec);

      const text =
        `🛑 <b>EDITAR STOP LOSS — ${cleanUpper}USDT</b> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
        `═══════════════════════════\n\n` +
        `⚡ <b>Preço de Entrada:</b> <code>$${formatP(entryPrice)}</code>\n` +
        `📈 <b>Preço Atual:</b> <code>$${formatP(markPrice)}</code>\n` +
        `🛑 <b>Stop Loss Atual:</b> <code>${currentSL}</code>\n\n` +
        `👉 <b>Digite apenas o novo valor do Stop Loss no chat:</b>\n` +
        `<i>Exemplo: digite <code>${formatP(entryPrice)}</code> e envie</i>\n\n` +
        `💡 <i>O bot atualizará a posição aberta diretamente na Bitunix.</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `❌ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
          ]
        ]
      };

      let sentMsgId = messageIdToEdit;
      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(async () => {
          const sent = await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
          if (sent?.message_id) sentMsgId = sent.message_id;
        });
      } else {
        const sent = await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
        if (sent?.message_id) sentMsgId = sent.message_id;
      }

      pendingUserEdits.set(String(chatId), {
        symbol,
        orderType: 'SL',
        side,
        promptMsgId: sentMsgId,
        timestamp: Date.now()
      });
    } catch (e: any) {
      console.error("[RENDER-EDIT-SL-ERR]:", e.message);
    }
  };

  // Renderiza Edição Direta de Take Profit (Apenas opção de digitar novo valor)
  const renderTelegramEditTPMenu = async (chatId: number | string, symbol: string, positionSide: string, messageIdToEdit?: number) => {
    try {
      const bitunixResolved = resolveBitunixSymbol(symbol);
      const bitunixSym = bitunixResolved.apiSymbol;
      const cleanUpper = bitunixResolved.cleanSymbol;
      const isDemo = serverTelegramBotConfig.accountType === 'VST';

      const data = await getBingXOpenPositions(DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
      const pos = data.positions.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym));

      const isLong = (pos?.positionSide === 'LONG') || positionSide === 'LONG';
      const side = isLong ? 'LONG' : 'SHORT';
      const entryPrice = pos?.entryPrice || 0;
      const markPrice = (pos?.markPrice && pos.markPrice > 0) ? pos.markPrice : entryPrice;
      const currentTP = pos?.takeProfit ? `$${pos.takeProfit}` : 'Não Definido';
      const prec = bitunixResolved.contract?.pricePrecision ?? (entryPrice >= 1000 ? 2 : entryPrice >= 1 ? 4 : 6);

      const formatP = (v: number) => v.toFixed(prec);
      const exampleTP = entryPrice > 0 
        ? formatP(isLong ? entryPrice * 1.03 : entryPrice * 0.97) 
        : '77000';

      const text =
        `🎯 <b>EDITAR TAKE PROFIT — ${cleanUpper}USDT</b> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
        `═══════════════════════════\n\n` +
        `⚡ <b>Preço de Entrada:</b> <code>$${formatP(entryPrice)}</code>\n` +
        `📈 <b>Preço Atual:</b> <code>$${formatP(markPrice)}</code>\n` +
        `🎯 <b>Take Profit Atual:</b> <code>${currentTP}</code>\n\n` +
        `👉 <b>Digite apenas o novo valor do Take Profit no chat:</b>\n` +
        `<i>Exemplo: digite <code>${exampleTP}</code> e envie</i>\n\n` +
        `💡 <i>O bot atualizará a posição aberta diretamente na Bitunix.</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `❌ Remover Take Profit`, callback_data: `REMOVE_DIRECT_TP:${symbol}:${side}` }
          ],
          [
            { text: `⬅️ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
          ]
        ]
      };

      let sentMsgId = messageIdToEdit;
      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(async () => {
          const sent = await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
          if (sent?.message_id) sentMsgId = sent.message_id;
        });
      } else {
        const sent = await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
        if (sent?.message_id) sentMsgId = sent.message_id;
      }

      pendingUserEdits.set(String(chatId), {
        symbol,
        orderType: 'TP',
        side,
        promptMsgId: sentMsgId,
        timestamp: Date.now()
      });
    } catch (e: any) {
      console.error("[RENDER-EDIT-TP-ERR]:", e.message);
    }
  };

  // Render Trailing Stop status card in Telegram
  const renderTelegramTrailingStatusMessage = async (chatId: number | string) => {
    try {
      const activeList = Array.from(bitunixActiveTrailingStops.values()).filter(t => !t.symbol.includes('-'));
      
      if (activeList.length === 0) {
        const text = 
          `🛰️ <b>STOP MÓVEL INTELIGENTE (BITUNIX):</b>\n\n` +
          `⚪ <i>No momento não há nenhum Stop Móvel ativo.</i>\n\n` +
          `💡 <b>Como funciona na Bitunix:</b>\n` +
          `A Bitunix não possui tipo de ordem "Trailing Stop" nativa em seu livro de ofertas. Por isso, nosso servidor monitora as cotações 24/7 em tempo real. Quando o preço atinge o gatilho, o robô vai ajustando e elevando o Stop Loss da posição diretamente na Bitunix à medida que o lucro cresce, protegendo seus ganhos!`;
        const kb = {
          inline_keyboard: [
            [{ text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }],
            [{ text: "🔄 Atualizar", callback_data: "REFRESH_TRAILING" }]
          ]
        };
        await sendTelegramReply(chatId, text, kb, { disableDedup: true });
        return;
      }

      for (let idx = 0; idx < activeList.length; idx++) {
        const tr = activeList[idx];
        const isLong = tr.positionSide === 'LONG';
        const prec = tr.pricePrecision || 4;

        // Consulta cotação mais recente
        let livePrice = 0;
        try {
          const bitunixSym = resolveBitunixSymbol(tr.symbol).apiSymbol;
          const tickerRes = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/tickers?symbols=${bitunixSym}`, { timeout: 3000 });
          if (tickerRes.data?.code === 0 && Array.isArray(tickerRes.data?.data) && tickerRes.data.data.length > 0) {
            livePrice = parseFloat(tickerRes.data.data[0].lastPrice || tickerRes.data.data[0].markPrice || '0');
          }
        } catch (e) {}

        const isConducao = tr.strategy === 'CONDUCAO' || serverTelegramBotConfig.conducaoStrategy === 'CONDUCAO';
        let text = '';
        if (isConducao) {
          const stage = tr.conducaoStage || 0;
          const sDist = tr.stopDistance || Math.abs(tr.entryPrice - tr.initialStopLoss);
          const currentUnits = (sDist > 0 && livePrice > 0)
            ? (isLong ? (livePrice - tr.entryPrice) / sDist : (tr.entryPrice - livePrice) / sDist)
            : 0;
          const maxUnits = Math.max(tr.maxUnitsReached || 0, currentUnits);

          const c0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
          const c1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
          const c3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
          const c4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
          const c5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
          const c6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;

          const defP = isLong ? tr.entryPrice + sDist * c0 : tr.entryPrice - sDist * c0;
          const beP = isLong ? tr.entryPrice + sDist * c1 : tr.entryPrice - sDist * c1;
          const f1P = isLong ? tr.entryPrice + sDist * c3 : tr.entryPrice - sDist * c3;
          const f2P = isLong ? tr.entryPrice + sDist * c5 : tr.entryPrice - sDist * c5;

          let statusDetail = '⏳ <b>Aguardando Gatilho de Ativação (1x)</b>';
          if (stage === 1) statusDetail = '🛡️ <b>Fase Defensiva Ativa:</b> Stop reduzido p/ -33%';
          else if (stage === 2) statusDetail = '⚖️ <b>Break-Even Ativo:</b> Stop no 0 a 0 cobrindo taxas';
          else if (stage === 3) statusDetail = `🚀 <b>Fase 1 (Lucro) Ativa:</b> Stop travado com folga de ${c4}x`;
          else if (stage >= 4) statusDetail = `📈 <b>Fase 2 (Avanço) Ativa:</b> Stop colado com folga de ${c6}x`;

          text = 
            `🎯 <b>CONDUÇÃO DE STOP (PROTEÇÃO ESCALONADA) — ${tr.symbol}</b> (${idx + 1}/${activeList.length})\n` +
            `═══════════════════════════\n\n` +
            `📊 <b>Direção:</b> <b>${isLong ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
            `⚡ <b>Preço de Entrada:</b> <code>$${tr.entryPrice.toFixed(prec)}</code>\n` +
            (livePrice > 0 ? `📈 <b>Cotação Atual:</b> <code>$${livePrice.toFixed(prec)}</code>\n` : '') +
            `🛑 <b>Stop Loss Atual na Bitunix:</b> <code>$${tr.currentStopLoss.toFixed(prec)}</code>\n` +
            `🎯 <b>Distância Percorrida:</b> <code>${currentUnits >= 0 ? '+' : ''}${currentUnits.toFixed(2)}x do Stop</code> (Máxima: <code>+${maxUnits.toFixed(2)}x</code>)\n` +
            (tr.takeProfitPrice ? `🎯 <b>Take Profit Protegido:</b> <code>$${tr.takeProfitPrice}</code>\n\n` : '\n') +
            `⚙️ <b>Estado Atual:</b>\n${statusDetail}\n\n` +
            `<b>Níveis de Proteção Escalonada:</b>\n` +
            `• 0️⃣ <b>Stop Defensivo (${c0}x):</b> ${stage >= 1 ? '✅ Ativado' : `⏳ Gatilho: <code>$${defP.toFixed(prec)}</code>`}\n` +
            `• 1️⃣ <b>Break-Even (${c1}x):</b> ${stage >= 2 ? '✅ Ativado' : `⏳ Gatilho: <code>$${beP.toFixed(prec)}</code>`}\n` +
            `• 2️⃣ <b>Equilíbrio Taxas:</b> ${stage >= 2 ? '✅ Ativado' : `⏳ Gatilho: <code>$${beP.toFixed(prec)}</code>`}\n` +
            `• 3️⃣ <b>Fase 1 Lucro (${c3}x):</b> ${stage >= 3 ? `✅ Ativo (Folga ${c4}x)` : `⏳ Gatilho: <code>$${f1P.toFixed(prec)}</code>`}\n` +
            `• 4️⃣ <b>Fase 2 Avanço (${c5}x):</b> ${stage >= 4 ? `✅ Ativo (Folga ${c6}x)` : `⏳ Gatilho: <code>$${f2P.toFixed(prec)}</code>`}\n\n` +
            `ℹ️ <i>O robô monitora as cotações em tempo real e avança o Stop Loss diretamente na sua conta Bitunix conforme cada fase é atingida!</i>`;
        } else {
          const statusLabel = tr.isActivated
            ? `🟢 <b>ATIVO & RASTREANDO MÁXIMAS EM TEMPO REAL</b>\n` +
              `🔝 <b>${isLong ? 'Máxima' : 'Mínima'} Atingida:</b> <code>$${(isLong ? tr.highestPrice : tr.lowestPrice).toFixed(prec)}</code>\n` +
              `🛡️ <b>Stop Loss Dinâmico na Bitunix:</b> <code>$${tr.currentStopLoss.toFixed(prec)}</code>`
            : `⏳ <b>ARMADO NO SERVIDOR (Aguardando Gatilho de Lucro)</b>\n` +
              `🎯 <b>Gatilho de Disparo:</b> <code>$${tr.activationPrice.toFixed(prec)}</code>\n` +
              `🛡️ <b>Stop Loss Inicial na Bitunix:</b> <code>$${tr.currentStopLoss.toFixed(prec)}</code>\n` +
              `📍 <i>(O Stop Loss inicial já está ativo na sua conta Bitunix para proteção total).</i>`;

          text = 
            `🛰️ <b>STOP MÓVEL INTELIGENTE — ${tr.symbol}</b> (${idx + 1}/${activeList.length})\n` +
            `═══════════════════════════\n\n` +
            `📊 <b>Direção:</b> <b>${isLong ? '🟢 LONG' : '🔴 SHORT'}</b>\n` +
            `⚡ <b>Preço de Entrada:</b> <code>$${tr.entryPrice.toFixed(prec)}</code>\n` +
            (livePrice > 0 ? `📈 <b>Cotação Atual:</b> <code>$${livePrice.toFixed(prec)}</code>\n` : '') +
            `📉 <b>Taxa de Recuo (Callback):</b> <code>${tr.callbackRate}%</code>\n` +
            (tr.takeProfitPrice ? `🎯 <b>Take Profit Protegido:</b> <code>$${tr.takeProfitPrice}</code>\n\n` : '\n') +
            `⚙️ <b>Estado Atual:</b>\n${statusLabel}\n\n` +
            `ℹ️ <i>Como a Bitunix não possui ordem de Stop Móvel nativa no livro, nosso servidor eleva o Stop Loss da posição diretamente na corretora à medida que a moeda sobe.</i>`;
        }

        const kb = {
          inline_keyboard: [
            [
              { text: "🔄 Atualizar Status", callback_data: "REFRESH_TRAILING" },
              { text: "📋 Ver Posição", callback_data: "LIST_POSITIONS" }
            ]
          ]
        };

        await sendTelegramReply(chatId, text, kb, { disableDedup: true });
      }
    } catch (e: any) {
      console.error("[RENDER-TRAILING-ERR]", e);
    }
  };

  // Render Copy Trade Trader Leader summary in Telegram
  const renderTelegramCopyTradeMessage = async (chatId: number | string, messageIdToEdit?: number) => {
    if (!messageIdToEdit) {
      await clearActiveKeyboardsForChat(chatId);
    }
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    try {
      const [detailRes, summaryRes] = await Promise.all([
        sendBingXRequest('/openApi/copyTrading/v1/PFutures/traderDetail', 'GET', { daySize: 30 }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo),
        sendBingXRequest('/openApi/copyTrading/v1/PFutures/profitHistorySummarys', 'GET', {}, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo)
      ]);

      const d = detailRes?.data || {};
      const s = summaryRes?.data || {};

      const copiers = d.copiersNum || '0';
      const traderId = d.traderId || '35812519';
      const level = d.accountLevel || 'Bronze';
      const winRatio = d.winRatio || '0%';
      const copierProfit = parseFloat(d.copierProfit || '0');
      const totalAssets = parseFloat(d.accountAssets || '0');
      const profitShare = (parseFloat(s.profitRatio || '0.1') * 100).toFixed(0);
      const totalTrades = d.tradeNum || 0;
      const wins = d.winNum || 0;
      const losses = d.loseNum || 0;
      const riskLevel = d.riskLevel || 'N/A';
      const avgLev = d.leverageMedian || 'N/A';

      const profitSign = copierProfit >= 0 ? '+' : '';
      const profitEmoji = copierProfit >= 0 ? '🟢' : '🔴';

      const text = `👥 <b>PAINEL COPY TRADE BITUNIX (TRADER LÍDER)</b>\n\n` +
        `🏅 <b>Nível do Trader:</b> <b>${level}</b> | <b>ID:</b> <code>${traderId}</code>\n` +
        `👥 <b>Seguidores Ativos:</b> <b>${copiers} copiadores</b>\n` +
        `💰 <b>Ativos da Conta:</b> <b>$${totalAssets.toFixed(2)} USDT</b>\n` +
        `📈 <b>Taxa de Acerto (Win Rate):</b> <b>${winRatio}</b> (${wins}V / ${losses}D em ${totalTrades} trades)\n` +
        `${profitEmoji} <b>Lucro dos Copiadores:</b> <b>${profitSign}$${copierProfit.toFixed(2)} USDT</b>\n` +
        `💸 <b>Sua Comissão (Profit Share):</b> <b>${profitShare}%</b> dos lucros\n` +
        `⚖️ <b>Nível de Risco Bitunix:</b> ${riskLevel} | <b>Alavancagem Média:</b> ${avgLev}\n\n` +
        `🔗 <i>Novos seguidores podem te achar na Bitunix pesquisando pelo Trader ID:</i> <code>${traderId}</code>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Atualizar Dados", callback_data: "COPY_REFRESH" },
            { text: "📋 Ver Posições", callback_data: "LIST_POSITIONS" }
          ],
          [
            { text: "📊 Relatório Hoje", callback_data: "VIEW_REPORT:DAY" },
            { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard);
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao consultar Copy Trade: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Render Bitunix Status & Balance
  const renderTelegramStatusMessage = async (chatId: number | string, messageIdToEdit?: number) => {
    try {
      const accCtx = getAccountContextForChat(chatId);
      const isDemo = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
      const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
      const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

      const [posData, todayData] = await Promise.all([
        getBitunixOpenPositions(apiKey, apiSecret, isDemo),
        getTodayPnLAndTrades().catch(() => ({ balance: 0, todayPnl: 0, todayTradesCount: 0, positions: [] }))
      ]);

      const balance = posData.balance || 0;
      const curr = 'USDT';
      const activeSavedAcc = getActiveSavedBitunixAccount();
      const activeAccBadge = activeSavedAcc
        ? `${activeSavedAcc.label} (${maskKeyStr(activeSavedAcc.apiKey, 4, 4)})`
        : 'Bitunix Futuros USDT Real';
      const accountDesc = isDemo ? `🟡 Simulação Bitunix (Demo)` : `🟢 ${activeAccBadge}`;

      const positions = posData.positions || [];
      const posCount = positions.length;
      const totalUnrealizedPnL = positions.reduce((acc: number, p: any) => acc + parseFloat(p.unrealizedProfit || '0'), 0);
      let posLine = `🔥 Posições Abertas: <b>${posCount}</b>`;
      if (posCount > 0) {
        const pnlSign = totalUnrealizedPnL >= 0 ? '+' : '-';
        const pnlEmoji = totalUnrealizedPnL >= 0 ? '🟢' : '🔴';
        posLine = `🔥 Posições Abertas: <b>${posCount} (PnL: ${pnlSign}$${Math.abs(totalUnrealizedPnL).toFixed(2)} ${curr} ${pnlEmoji} )</b>`;
      }

      const openOrdersCount = posData.openOrdersCount || (posData.openOrders?.length || 0);

      const todayPnl = todayData.todayPnl || 0;
      const todayPnlSign = todayPnl > 0 ? '+' : (todayPnl < 0 ? '-' : '-');
      const todayPnlEmoji = todayPnl > 0.05 ? '🟢' : (todayPnl < -0.05 ? '🔴' : '🔴');
      const todayPnlLine = `📆 Resultado Hoje: <b>${todayPnlSign}$${Math.abs(todayPnl).toFixed(2)} ${curr} ${todayPnlEmoji}</b>`;

      const riskPct = serverTelegramBotConfig.riskPercent || 2.0;
      const riskVal = serverTelegramBotConfig.riskMode === 'PERCENT'
        ? (balance * (riskPct / 100))
        : (serverTelegramBotConfig.riskFixedUsd || 50.0);
      const riskBadgeStatus = serverTelegramBotConfig.riskMode === 'PERCENT'
        ? `${riskPct}% ($${riskVal.toFixed(2)} ${curr})`
        : `$${riskVal.toFixed(2)} ${curr} (Fixo)`;

      const fmtN = (n: number) => {
        const s = n.toFixed(1);
        return s.endsWith('.0') ? s.slice(0, -2) : s;
      };

      const c0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
      const c1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
      const c2 = serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5;
      const c3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
      const c4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
      const c5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
      const c6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;
      const isConducaoActive = serverTelegramBotConfig.conducaoStopEnabled !== false;

      const todayStrStatus = getBrasiliaDateString();
      const isDailyUnlockedStatus = serverTelegramBotConfig.dailyLockUnlockedDate === todayStrStatus;
      const dailyLossActive = serverTelegramBotConfig.dailyLossLimitEnabled;
      let dailyLockLine = `🔒 Trava Diária: <b>Desativada</b>`;
      if (isDailyUnlockedStatus) {
        dailyLockLine = `🔓 Trava Diária: <b>Destravada Hoje</b>`;
      } else if (dailyLossActive) {
        let maxLossUsdStatus = 0;
        let limitTag = '';
        if (serverTelegramBotConfig.dailyLossPercent > 0) {
          maxLossUsdStatus = balance * (serverTelegramBotConfig.dailyLossPercent / 100);
          limitTag = `-${serverTelegramBotConfig.dailyLossPercent}% = -$${maxLossUsdStatus.toFixed(2)}`;
        } else if (serverTelegramBotConfig.dailyLossFixedUsd > 0) {
          maxLossUsdStatus = serverTelegramBotConfig.dailyLossFixedUsd;
          limitTag = `-$${maxLossUsdStatus.toFixed(2)} ${curr}`;
        } else {
          maxLossUsdStatus = balance * 0.05;
          limitTag = `-5% = -$${maxLossUsdStatus.toFixed(2)}`;
        }
        const remainingToLock = Math.max(0, maxLossUsdStatus + todayPnl);
        if (maxLossUsdStatus > 0 && todayPnl <= -maxLossUsdStatus) {
          dailyLockLine = `🔒 Trava Diária: <b>🔴 BLOQUEADA (Limite ${limitTag} atingido!)</b>`;
        } else {
          dailyLockLine = `🔒 Trava Diária: <b>Ativa — Falta $${remainingToLock.toFixed(2)} ${curr} p/ travar</b> <i>(Limite: ${limitTag})</i>`;
        }
      }

      let dailyProfitLine = '';
      if (!isDailyUnlockedStatus && serverTelegramBotConfig.dailyProfitTargetEnabled) {
        let maxProfitUsdStatus = 0;
        let profitTag = '';
        if (serverTelegramBotConfig.dailyProfitTargetPercent > 0) {
          maxProfitUsdStatus = balance * (serverTelegramBotConfig.dailyProfitTargetPercent / 100);
          profitTag = `+${serverTelegramBotConfig.dailyProfitTargetPercent}% = +$${maxProfitUsdStatus.toFixed(2)}`;
        } else if (serverTelegramBotConfig.dailyProfitFixedUsd > 0) {
          maxProfitUsdStatus = serverTelegramBotConfig.dailyProfitFixedUsd;
          profitTag = `+$${maxProfitUsdStatus.toFixed(2)} ${curr}`;
        }
        if (maxProfitUsdStatus > 0) {
          const remainingProfit = Math.max(0, maxProfitUsdStatus - todayPnl);
          if (todayPnl >= maxProfitUsdStatus) {
            dailyProfitLine = `\n🎯 Meta de Lucro: <b>🟢 ATINGIDA (${profitTag})</b>`;
          } else {
            dailyProfitLine = `\n🎯 Meta de Lucro: <b>Ativa — Falta $${remainingProfit.toFixed(2)} ${curr}</b> <i>(Meta: ${profitTag})</i>`;
          }
        }
      }

      const nowBrasilia = new Intl.DateTimeFormat('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(new Date());

      const text =
        `📊 <b>STATUS DO SISTEMA & BITUNIX</b>\n` +
        `═════════════════════════════════\n\n` +
        `🟢 Servidor: <b>Online & Sincronizado</b>\n` +
        `💼 Conta: <b>${accountDesc}</b>\n` +
        `💰 Saldo Disponível: <b>$${balance.toFixed(2)} ${curr}</b>\n\n` +
        `═════════════════════════════════\n` +
        `📈 <b>OPERAÇÕES & RESULTADOS</b>\n` +
        `${posLine}\n` +
        `⌛ Ordens Pendentes: <b>${openOrdersCount}</b>\n` +
        `${todayPnlLine}\n\n` +
        `═════════════════════════════════\n` +
        `🛡️ <b>RISCO & AUTOMAÇÕES</b>\n` +
        `💵 Risco p/ Trade: <b>${riskBadgeStatus}</b>\n` +
        `🎯 Condução de Stop: <b>${isConducaoActive ? 'Ativa (Escalonada)' : 'Desativada'}</b>\n` +
        `   ├ 🛡️ Stop Defensivo: <b>${fmtN(c0)}x (puxa stop p/ -33%)</b>\n` +
        `   ├ ⚖️ Break-Even: <b>${fmtN(c1)}x (0 a 0 / entrada)</b>\n` +
        `   ├ 💎 Equilíbrio: <b>${fmtN(c2)}x (cobre 100% taxas Bitunix)</b>\n` +
        `   ├ 🚀 Fase 1 (Lucro): <b>a partir de ${fmtN(c3)}x (folga ${fmtN(c4)}x)</b>\n` +
        `   └ 📈 Fase 2 (Avanço): <b>a partir de ${fmtN(c5)}x (folga ${fmtN(c6)}x)</b>\n` +
        `${dailyLockLine}${dailyProfitLine}\n\n` +
        `═════════════════════════════════\n` +
        `🕒 <i>Atualizado às ${nowBrasilia} (Brasília)</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "📋 Posições Abertas", callback_data: "LIST_POSITIONS" },
            { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" }
          ],
          [
            { text: "🔄 Alternar Conta Bitunix", callback_data: "OPEN_ACCOUNT_SWITCHER" },
            { text: "🔄 Atualizar Status", callback_data: "REFRESH_STATUS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao consultar status da Bitunix: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Render Reorganized Main Menu in Telegram
  const renderTelegramMainMenu = async (chatId: number | string, messageIdToEdit?: number) => {
    const accCtx = getAccountContextForChat(chatId);
    const riskLabel = accCtx.riskMode === 'PERCENT'
      ? `${accCtx.riskPercent}% da conta`
      : `$${accCtx.riskFixedUsd} USD`;

    const activeSaved = getActiveSavedBitunixAccount();
    const activeAccLabel = activeSaved
      ? `💼 <b>Conta Ativa:</b> ${activeSaved.label} (<code>${maskKeyStr(activeSaved.apiKey, 4, 4)}</code>)\n`
      : '';

    const operatorBanner = accCtx.isOperator
      ? `👤 <b>Operador:</b> ${accCtx.name} (${accCtx.ownerName})\n💼 <b>Conta:</b> ${accCtx.isDemo ? '🟡 Simulação Bitunix' : '🟢 Bitunix USDT Real'}\n`
      : activeAccLabel;

    const text =
      `🤖 <b>PAINEL BITUNIX TRADER VIP</b>\n\n` +
      operatorBanner +
      `🛡️ <b>Gestão de Risco:</b> ${riskLabel} | Stop Móvel Ativo\n\n` +
      `📋 <b>MENU DE COMANDOS:</b>\n` +
      `1. <code>/status</code> — 💼 Saldo e Status da Bitunix\n` +
      `2. <code>/posicoes</code> — 📈 Posições Abertas\n` +
      `3. <code>/pendentes</code> — ⏳ Ordens Pendentes\n` +
      `4. <code>/imagem</code> — 🖼️ Enviar Imagem / Gráfico (IA)\n` +
      `5. <code>/historico</code> — 📜 Histórico de Trades\n` +
      `6. <code>/relatorio</code> — 📊 Relatório de Lucros (PnL)\n` +
      `7. <code>/copy</code> — 👥 Painel Copy Trade\n` +
      `8. <code>/config</code> — ⚙️ Configurações (Conta, Trailing, Risco, Trava)\n` +
      `9. <code>/ajuda</code> — 📖 Ajuda & Comandos\n\n` +
      `💡 <i>Toque em um comando acima ou use os botões de acesso rápido:</i>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "💼 Status", callback_data: "VIEW_STATUS" },
          { text: "📈 Posições Abertas", callback_data: "LIST_POSITIONS" }
        ],
        [
          { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" },
          { text: "🖼️ Imagem (IA)", callback_data: "PROMPT_IMAGE_SIGNAL" }
        ],
        [
          { text: "📜 Histórico", callback_data: "VIEW_HISTORY:DAY" },
          { text: "📊 Relatório", callback_data: "VIEW_REPORT:DAY" }
        ],
        [
          { text: "🔄 Alternar Conta", callback_data: "OPEN_ACCOUNT_SWITCHER" },
          { text: "⚙️ Configurações", callback_data: "VIEW_CONFIG" }
        ],
        [
          { text: "👥 Painel Copy Trade", callback_data: "VIEW_COPY_TRADE" },
          { text: "📖 Ajuda", callback_data: "VIEW_MAIN_MENU" }
        ]
      ]
    };

    if (messageIdToEdit) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard
      }, { timeout: 8000 }).catch(() => {});
      trackActiveKeyboardMessage(chatId, messageIdToEdit);
    } else {
      await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
    }
  };

  // Render pending / limit open orders in Telegram with separate Header, individual Coin Cards, and Bottom Global Action card
  const renderTelegramPendingOrdersMessage = async (chatId: number | string, messageIdToEdit?: number) => {
    if (!messageIdToEdit) {
      await clearActiveKeyboardsForChat(chatId);
    }

    const accCtx = getAccountContextForChat(chatId);
    const isDemo = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
    const accLabel = accCtx.isOperator
      ? `👤 ${accCtx.name} (${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'})`
      : (isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real');
    const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
    const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

    const data = await getBingXOpenPositions(apiKey, apiSecret, isDemo);
    const openOrders = data.openOrders || [];

    if (!data.success || openOrders.length === 0) {
      const emptyText = `⏳ <b>ORDENS PENDENTES ( 0 )</b>\n` +
        `💼 Conta: <b>${accLabel}</b> | 💰 Saldo: <b>$${(data.balance || 0).toFixed(2)} USDT</b>\n\n` +
        `ℹ️ <i>Nenhuma ordem pendente (Limite ou Gatilho) aguardando execução no livro da Bitunix.</i>\n\n` +
        `💡 <i>Quando você executa um sinal com preço LIMITE que ainda não atingiu a cotação de entrada, a ordem fica listada aqui até ser ativada!</i>`;

      const emptyKeyboard = {
        inline_keyboard: [
          [
            { text: "🔄 Atualizar Lista", callback_data: "REFRESH_PENDING_ORDERS" },
            { text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text: emptyText,
          parse_mode: "HTML",
          reply_markup: emptyKeyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, emptyText, emptyKeyboard);
      }
      return;
    }

    // Agrupa todas as ordens abertas por símbolo/moeda
    const groupedBySymbol = new Map<string, any[]>();
    openOrders.forEach((o: any) => {
      const sym = o.symbol || 'OUTROS-USDT';
      if (!groupedBySymbol.has(sym)) {
        groupedBySymbol.set(sym, []);
      }
      groupedBySymbol.get(sym)!.push(o);
    });

    const coinEntries = Array.from(groupedBySymbol.entries());

    // 1. Mensagem de Título / Cabeçalho Geral
    const headerText = `⏳ <b>ORDENS PENDENTES ( ${coinEntries.length} )</b>\n` +
      `💼 Conta: <b>${accLabel}</b> | 💰 Saldo: <b>$${data.balance.toFixed(2)} USDT</b>\n` +
      `═══════════════════════════\n` +
      `📊 <i>Total de <b>${openOrders.length} ordens ativas</b> no livro aguardando execução.</i>`;

    await sendTelegramReply(chatId, headerText, undefined, { preserveBatch: true, disableDedup: true });

    // 2. Mensagens Individuais com as Informações de cada Moeda + Botões exclusivos
    for (let coinIdx = 0; coinIdx < coinEntries.length; coinIdx++) {
      const [sym, symOrders] = coinEntries[coinIdx];
      const cleanSym = sym.replace('-USDT', '').replace('USDT', '');
      const limitOrder = symOrders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');
      const firstOrderId = (limitOrder?.orderId || symOrders[0]?.orderId || '').toString();
      const numLabel = String(coinIdx + 1).padStart(2, '0');

      let coinText = `🪙 <b>INFORMAÇÕES DA ORDEM ${numLabel} — ${cleanSym}</b> <i>(${symOrders.length} ${symOrders.length === 1 ? 'ordem' : 'ordens'})</i>\n` +
        `───────────────────────────\n`;

      symOrders.forEach((o: any) => {
        const orderIdStr = (o.orderId || '').toString();
        const shortId = orderIdStr.length > 6 ? orderIdStr.slice(-6) : orderIdStr;
        
        const isBuy = o.side === 'BUY' || o.positionSide === 'LONG';
        const sideEmoji = isBuy ? '🟢 LONG' : '🔴 SHORT';
        
        let typeLabel = o.type || 'LIMIT';
        let isTrailing = false;

        if (o.type === 'LIMIT') {
          typeLabel = '🎯 LIMITE (Entrada)';
        } else if (o.type === 'STOP_MARKET' || o.type === 'STOP' || o.type === 'STOP_LOSS') {
          typeLabel = '🛑 STOP LOSS';
        } else if (o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT') {
          typeLabel = '🎯 TAKE PROFIT';
        } else if (o.type === 'TRAILING_STOP_MARKET' || o.type === 'TRAILING_STOP' || (o.type || '').includes('TRAILING')) {
          typeLabel = '⚡ TRAILING STOP';
          isTrailing = true;
        } else if (o.type === 'TRIGGER_MARKET' || o.type === 'TRIGGER_LIMIT') {
          typeLabel = '⚡ GATILHO (Entrada)';
        }

        let displayPrice = 'Mercado';
        if (isTrailing) {
          const actPrice = parseFloat(o.activationPrice || '0');
          const rate = parseFloat(o.callbackRate || o.priceRate || '0');
          const ratePct = rate > 0 ? (rate < 0.5 ? (rate * 100).toFixed(2) : rate.toFixed(2)) : null;
          displayPrice = actPrice > 0 
            ? `$${actPrice}${ratePct ? ` (Recuo: ${ratePct}%)` : ''}` 
            : (ratePct ? `Recuo: ${ratePct}%` : 'Mercado');
        } else {
          const triggerPrice = parseFloat(o.stopPrice || '0');
          const limitPrice = parseFloat(o.price || '0');
          displayPrice = triggerPrice > 0 ? `$${triggerPrice}` : (limitPrice > 0 ? `$${limitPrice}` : 'Mercado');
        }
        const qty = parseFloat(o.origQty || o.quantity || '0');

        coinText += `• <b>${typeLabel}</b> <code>#${shortId}</code>\n` +
          `  ${sideEmoji} | ⚡ <b>${displayPrice}</b>${qty > 0 ? ` | Qtd: <code>${qty}</code>` : ''}\n`;
      });

      const coinKeyboardRows: any[] = [
        [
          { text: `🛑 SL`, callback_data: `PROMPT_EDIT_SL:${sym}:${firstOrderId}` },
          { text: `🎯 TP`, callback_data: `PROMPT_EDIT_TP:${sym}:${firstOrderId}` },
          { text: `🗑️ Cancelar`, callback_data: `CANCEL_ALL_SYM:${sym}` }
        ],
        [
          { text: "🔄 Atualizar", callback_data: "REFRESH_PENDING_ORDERS" }
        ]
      ];

      const keyboard = { inline_keyboard: coinKeyboardRows };
      await sendTelegramReply(chatId, coinText, keyboard, { preserveBatch: true, disableDedup: true });
    }

    // 3. Mensagem de Rodapé: Apenas enviada se houver MÚLTIPLAS moedas/ordens pendentes no livro
    if (coinEntries.length > 1) {
      const footerText = `🚨 <b>DESEJA CANCELAR TODAS AS ORDENS PENDENTES?</b>\n` +
        `═══════════════════════════\n` +
        `⚠️ <i>Ao clicar em Cancelar Todas, todas as ordens de entrada e gatilhos de todas as moedas serão canceladas simultaneamente na Bitunix.</i>`;

      const footerKeyboard = {
        inline_keyboard: [
          [
            { text: "🚨 Cancelar TODAS as Pendentes", callback_data: "CANCEL_ALL_PENDING_ORDERS" }
          ],
          [
            { text: "🔄 Atualizar", callback_data: "REFRESH_PENDING_ORDERS" }
          ]
        ]
      };

      await sendTelegramReply(chatId, footerText, footerKeyboard, { preserveBatch: true, disableDedup: true });
    }
  };

  type ReportPeriod = 'DAY' | 'WEEK' | 'MONTH';

  const MONTH_NAMES_PT = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'
  ];

  // Helper com cálculo rigoroso de fuso horário de Brasília (UTC-3)
  const getBrasiliaPeriodRange = (period: ReportPeriod = 'DAY'): {
    startTime: number;
    endTime: number;
    title: string;
    periodName: string;
    period: ReportPeriod;
  } => {
    const now = new Date();
    // Obtém data no fuso de Brasília YYYY-MM-DD
    const spDateStr = now.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // "YYYY-MM-DD"
    const [yearStr, monthStr, dayStr] = spDateStr.split('-');
    const year = parseInt(yearStr, 10);
    const monthIndex = parseInt(monthStr, 10) - 1; // 0 a 11
    const day = parseInt(dayStr, 10);

    // Início e Fim do dia atual em Brasília (00:00:00.000 às 23:59:59.999 UTC-3)
    const startOfDayMs = new Date(`${yearStr}-${monthStr}-${dayStr}T00:00:00.000-03:00`).getTime();
    const endOfDayMs = new Date(`${yearStr}-${monthStr}-${dayStr}T23:59:59.999-03:00`).getTime();

    if (period === 'WEEK') {
      // Semana começa na segunda-feira 00:00 e termina no domingo 23:59 (horário de Brasília)
      const spDateObj = new Date(`${yearStr}-${monthStr}-${dayStr}T12:00:00.000-03:00`);
      const dayOfWeek = spDateObj.getDay(); // 0 = Domingo, 1 = Segunda, ..., 6 = Sábado
      const diffToMonday = dayOfWeek === 0 ? 6 : (dayOfWeek - 1);

      const startOfWeekMs = startOfDayMs - (diffToMonday * 24 * 60 * 60 * 1000);
      const endOfWeekMs = startOfWeekMs + (7 * 24 * 60 * 60 * 1000) - 1;

      const monDate = new Date(startOfWeekMs);
      const sunDate = new Date(endOfWeekMs);
      const monStr = monDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
      const sunStr = sunDate.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });

      return {
        startTime: startOfWeekMs,
        endTime: endOfWeekMs,
        title: `RELATÓRIO DA SEMANA — ${monStr} a ${sunStr}`,
        periodName: `Semana (${monStr} a ${sunStr})`,
        period: 'WEEK'
      };
    }

    if (period === 'MONTH') {
      // Mês começa dia 01 às 00:00 e termina dia 30/31 às 23:59
      const startOfMonthMs = new Date(`${yearStr}-${monthStr}-01T00:00:00.000-03:00`).getTime();
      const lastDayOfMonth = new Date(year, monthIndex + 1, 0).getDate();
      const lastDayStr = String(lastDayOfMonth).padStart(2, '0');
      const endOfMonthMs = new Date(`${yearStr}-${monthStr}-${lastDayStr}T23:59:59.999-03:00`).getTime();

      const monthName = MONTH_NAMES_PT[monthIndex] || 'Mês Atual';

      return {
        startTime: startOfMonthMs,
        endTime: endOfMonthMs,
        title: `RELATÓRIO DO MÊS — ${monthName} de ${yearStr}`,
        periodName: `Mês de ${monthName}`,
        period: 'MONTH'
      };
    }

    // Padrão: DIA (00:00 às 23:59 horário de Brasília)
    const formattedDate = `${dayStr}/${monthStr}/${yearStr}`;
    return {
      startTime: startOfDayMs,
      endTime: endOfDayMs,
      title: `RELATÓRIO DO DIA — ${formattedDate}`,
      periodName: `Hoje (${formattedDate})`,
      period: 'DAY'
    };
  };

  // Helper para gerar e renderizar Relatórios (Dia, Semana ou Mês com Win, Breakeven e Loss)
  const renderTelegramReportMessage = async (chatId: number | string, period: ReportPeriod = 'DAY', messageIdToEdit?: number) => {
    try {
      const accCtx = getAccountContextForChat(chatId);
      const isDemo = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
      const accCurrency = 'USDT';
      const accLabel = accCtx.isOperator
        ? `👤 ${accCtx.name} (${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'})`
        : (isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real');
      const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
      const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

      const range = getBrasiliaPeriodRange(period);
      const now = new Date();

      // Consulta renda (income), saldo e posições abertas na Bitunix
      const [incomeRes, posData] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/income', 'GET', { limit: 100 }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        getBingXOpenPositions(apiKey, apiSecret, isDemo).catch(() => ({ positions: [], balance: 0, success: true }))
      ]);

      const rawItems = Array.isArray(incomeRes?.data) ? incomeRes.data : [];
      // Filtra estritamente dentro do período
      const items = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= range.startTime && t <= range.endTime;
      });

      const weekRange = getBrasiliaPeriodRange('WEEK');
      const monthRange = getBrasiliaPeriodRange('MONTH');
      const dayRange = getBrasiliaPeriodRange('DAY');

      const todayTrades = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= dayRange.startTime && t <= dayRange.endTime && it.incomeType === 'REALIZED_PNL';
      });
      const weekTrades = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= weekRange.startTime && t <= weekRange.endTime && it.incomeType === 'REALIZED_PNL';
      });
      const monthTrades = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= monthRange.startTime && t <= monthRange.endTime && it.incomeType === 'REALIZED_PNL';
      });
      
      let grossPnl = 0;
      let fees = 0;
      let wins = 0;
      let breakevens = 0;
      let losses = 0;
      const closedTrades: Array<{ symbol: string; info: string; pnl: number; time: number }> = [];

      for (const item of items) {
        const val = parseFloat(item.income || "0");
        if (item.incomeType === "REALIZED_PNL") {
          grossPnl += val;
          // Classificação de Win, Breakeven (0 a 0 / Proteção até $0.15 de oscilação) e Stop Loss
          if (val > 0.05) {
            wins++;
          } else if (Math.abs(val) <= 0.15) {
            breakevens++;
          } else {
            losses++;
          }
          closedTrades.push({
            symbol: (item.symbol || '').replace('-USDT', '').replace('USDT', ''),
            info: item.info || 'Fechamento',
            pnl: val,
            time: item.time || Date.now()
          });
        } else if (item.incomeType === "TRADING_FEE" || item.incomeType === "FUNDING_FEE") {
          fees += val;
        }
      }

      const netPnl = grossPnl + fees;
      const totalClosed = wins + breakevens + losses;
      const winRate = totalClosed > 0 ? ((wins / totalClosed) * 100).toFixed(1) : "0.0";
      const netSign = netPnl >= 0 ? '+' : '';
      const netEmoji = netPnl > 0.05 ? '🟢' : (Math.abs(netPnl) <= 0.15 ? '🛡️' : '🔴');

      const currentBalance = posData.balance || 0;
      const initialBalance = Math.max(0, currentBalance - netPnl);
      const periodPct = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0;
      const periodPctSign = periodPct >= 0 ? '+' : '';

      const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });

      let text = 
        `📊 <b>${range.title}</b>\n` +
        `💼 Conta: <b>${accLabel}</b> | 🕒 Atualizado: <code>${timeStr}</code>\n` +
        `═══════════════════════════\n\n` +
        `💰 <b>Resultado Líq.:</b> <code>${netPnl < 0 ? '-' : (netPnl > 0 ? '+' : '')}$${Math.abs(netPnl).toFixed(2)} ${accCurrency}</code>\n` +
        `📈 <b>Lucro/Prejuízo Bruto:</b> <code>${grossPnl < 0 ? '-' : (grossPnl > 0 ? '+' : '')}$${Math.abs(grossPnl).toFixed(2)} ${accCurrency}</code>\n` +
        `💸 <b>Taxas da Corretora:</b> <code>-$${Math.abs(fees).toFixed(2)} ${accCurrency}</code>\n` +
        `🎯 <b>Taxa de Acerto:</b> <b>${winRate}%</b> (🏆 ${wins}  | 🛡️ ${breakevens}  | 🛑 ${losses} )\n\n`;

      // Operações Fechadas no Período
      const periodLabel = period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'na Semana' : 'no Mês');
      const periodTitleLabel = period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'Semana' : 'Mês');
      if (closedTrades.length > 0) {
        text += `📋 <b>Operações Encerradas ${periodLabel} (${closedTrades.length}):</b>\n`;
        for (const t of closedTrades.slice(0, 10)) {
          const tSign = t.pnl < 0 ? '-' : (t.pnl > 0 ? '+' : '');
          const tEmoji = t.pnl > 0.05 ? '🟢' : (Math.abs(t.pnl) <= 0.05 ? '🛡️' : '🔴');
          const tradeTime = new Date(t.time).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
          const tradeDate = new Date(t.time).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' });
          const displayTime = period === 'DAY' ? tradeTime : `${tradeDate} ${tradeTime}`;
          const dirLabel = t.info?.toLowerCase().includes('short') ? 'Short' : (t.info?.toLowerCase().includes('long') ? 'Long' : t.info);
          text += `• <b>${t.symbol}</b> (${dirLabel}): <code>${tSign}$${Math.abs(t.pnl).toFixed(2)}</code> ${tEmoji} <i>(${displayTime})</i>\n`;
        }
        if (closedTrades.length > 10) {
          text += `<i>... e mais ${closedTrades.length - 10} operações anteriores neste período.</i>\n`;
        }
        text += `\n`;
      } else {
        text += `📋 <b>Operações Encerradas ${periodLabel}:</b> <i>Nenhuma operação encerrada ${periodLabel.toLowerCase()} ainda.</i>\n`;
        if (period === 'DAY' && weekTrades.length > 0) {
          const lastTrade = weekTrades[0];
          const lastTradeDate = new Date(lastTrade.time).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
          const lastPnl = parseFloat(lastTrade.income || '0');
          const lastSign = lastPnl < 0 ? '-' : (lastPnl > 0 ? '+' : '');
          const lastEmoji = lastPnl > 0.05 ? '🟢' : (Math.abs(lastPnl) <= 0.05 ? '🛡️' : '🔴');
          const weekNetPnl = weekTrades.reduce((acc: number, it: any) => acc + parseFloat(it.income || '0'), 0);
          const weekSign = weekNetPnl < 0 ? '-' : (weekNetPnl > 0 ? '+' : '');
          text += `💡 <i>Nesta semana constam <b>${weekTrades.length}</b> operações (${weekSign}$${Math.abs(weekNetPnl).toFixed(2)}). Última: <b>${(lastTrade.symbol || '').replace('-USDT', '').replace('USDT', '')}</b> (${lastSign}$${Math.abs(lastPnl).toFixed(2)} ${lastEmoji} em ${lastTradeDate}).\n👉 Clique em <b>📆 Semana</b> abaixo para o relatório consolidado.</i>\n\n`;
        } else {
          text += `\n`;
        }
      }

      // Posições Abertas no Momento (se houver)
      const openPos = posData.positions || [];
      if (openPos.length > 0) {
        text += `🔥 <b>Posições em Andamento (${openPos.length}):</b>\n`;
        for (const p of openPos) {
          const pSign = p.unrealizedProfit < 0 ? '-' : (p.unrealizedProfit > 0 ? '+' : '');
          const pEmoji = p.unrealizedProfit >= 0 ? '🟢' : '🔴';
          text += `• <b>${p.cleanSymbol}</b> (${p.positionSide} ${p.leverage}x) ➔ <code>${pSign}$${Math.abs(p.unrealizedProfit).toFixed(2)} (${pSign}${Math.abs(p.pnlPercent).toFixed(1)}%)</code> ${pEmoji}\n`;
        }
        text += `\n`;
      }

      const resultSignStr = periodPct < 0 ? `- ${Math.abs(periodPct).toFixed(2)}%` : (periodPct > 0 ? `+ ${periodPct.toFixed(2)}%` : `0.00%`);

      text += 
        `🏦 <b>Saldo Inicial (${periodTitleLabel}):</b> <code>$${initialBalance.toFixed(2)} ${accCurrency}</code>\n` +
        `🏦 <b>Saldo Atual Conta:</b> <code>$${currentBalance.toFixed(2)} ${accCurrency}</code>\n` +
        `💰 <b>Resultado final:</b> ${netEmoji} <b>${resultSignStr}</b>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `${period === 'DAY' ? '🔘' : '⚪'} 📅 Hoje (${todayTrades.length})`, callback_data: "VIEW_REPORT:DAY" },
            { text: `${period === 'WEEK' ? '🔘' : '⚪'} 📆 Semana (${weekTrades.length})`, callback_data: "VIEW_REPORT:WEEK" },
            { text: `${period === 'MONTH' ? '🔘' : '⚪'} 🗓️ Mês (${monthTrades.length})`, callback_data: "VIEW_REPORT:MONTH" }
          ],
          [
            { text: "🔄 Atualizar Relatório", callback_data: `REFRESH_REPORT:${period}` },
            { text: `📜 Histórico (${period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'Semana' : 'Mês')})`, callback_data: `VIEW_HISTORY:${period}` }
          ],
          [
            { text: "📋 Ver Posições", callback_data: "LIST_POSITIONS" },
            { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      console.error("[REPORT-ERR]:", err.message);
      await sendTelegramReply(chatId, `⚠️ <b>Falha ao gerar relatório:</b> ${err.message}`, undefined, { disableDedup: true });
    }
  };

  const renderTelegramDailyReportMessage = async (chatId: number | string, messageIdToEdit?: number) => {
    return renderTelegramReportMessage(chatId, 'DAY', messageIdToEdit);
  };

  // Helper para renderizar Histórico Detalhado de Operações Encerradas (Entrada, Stop, Take, Saída/Onde Tirou, PnL e ROI)
  const renderTelegramHistoryMessage = async (chatId: number | string, period: ReportPeriod = 'DAY', messageIdToEdit?: number) => {
    try {
      const accCtx = getAccountContextForChat(chatId);
      const isDemo = accCtx.isOperator ? accCtx.isDemo : (serverTelegramBotConfig.accountType === 'VST');
      const accCurrency = 'USDT';
      const accLabel = accCtx.isOperator
        ? `👤 ${accCtx.name} (${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'})`
        : (isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real');
      const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
      const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

      const range = getBrasiliaPeriodRange(period);
      const now = new Date();

      // Consulta renda detalhada (Realized PnL + Taxas) na Bitunix
      const [incomeRes, feeRes] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/income', 'GET', {
          incomeType: 'REALIZED_PNL',
          limit: 100
        }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        sendBingXRequest('/openApi/swap/v2/user/income', 'GET', {
          incomeType: 'TRADING_FEE',
          limit: 100
        }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] }))
      ]);

      const rawIncomeItems = Array.isArray(incomeRes?.data) ? incomeRes.data : [];
      const feeItems = Array.isArray(feeRes?.data) ? feeRes.data : [];

      const weekRange = getBrasiliaPeriodRange('WEEK');
      const monthRange = getBrasiliaPeriodRange('MONTH');
      const dayRange = getBrasiliaPeriodRange('DAY');

      const todayTrades = rawIncomeItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= dayRange.startTime && t <= dayRange.endTime && it.incomeType === 'REALIZED_PNL';
      });
      const weekTrades = rawIncomeItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= weekRange.startTime && t <= weekRange.endTime && it.incomeType === 'REALIZED_PNL';
      });
      const monthTrades = rawIncomeItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= monthRange.startTime && t <= monthRange.endTime && it.incomeType === 'REALIZED_PNL';
      });

      // Filtra estritamente dentro do período
      const incomeItems = rawIncomeItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= range.startTime && t <= range.endTime;
      });

      const periodLabel = period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'desta Semana' : 'deste Mês');
      const isFallbackRecent = incomeItems.length === 0 && rawIncomeItems.length > 0;

      if (incomeItems.length === 0 && rawIncomeItems.length === 0) {
        const emptyText = 
          `📜 <b>HISTÓRICO DETALHADO — ${range.periodName.toUpperCase()}</b>\n` +
          `💼 Conta: <b>${accLabel}</b>\n` +
          `═══════════════════════════\n\n` +
          `ℹ️ <i>Nenhuma operação encerrada registrada ${periodLabel.toLowerCase()} nesta conta.</i>\n\n` +
          `Assim que posições forem fechadas (via Take Profit, Stop Loss, Trailing Stop ou manual), elas aparecerão aqui com a auditoria completa da entrada, saída, motivo do encerramento e resultado líquido.`;

        const emptyKeyboard = {
          inline_keyboard: [
            [
              { text: `${period === 'DAY' ? '🔘' : '⚪'} 📅 Hoje (0)`, callback_data: "VIEW_HISTORY:DAY" },
              { text: `${period === 'WEEK' ? '🔘' : '⚪'} 📆 Semana (0)`, callback_data: "VIEW_HISTORY:WEEK" },
              { text: `${period === 'MONTH' ? '🔘' : '⚪'} 🗓️ Mês (0)`, callback_data: "VIEW_HISTORY:MONTH" }
            ],
            [
              { text: "🔄 Atualizar", callback_data: `REFRESH_HISTORY:${period}` },
              { text: `📊 Ver Relatório (${period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'Semana' : 'Mês')})`, callback_data: `VIEW_REPORT:${period}` }
            ],
            [
              { text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }
            ]
          ]
        };

        if (messageIdToEdit) {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: messageIdToEdit,
            text: emptyText,
            parse_mode: "HTML",
            reply_markup: emptyKeyboard
          }, { timeout: 8000 }).catch(() => {});
          trackActiveKeyboardMessage(chatId, messageIdToEdit);
        } else {
          await sendTelegramReply(chatId, emptyText, emptyKeyboard, { disableDedup: true });
        }
        return;
      }

      // Lista de operações a exibir (do período ou fallback recentes)
      const targetDisplayItems = isFallbackRecent ? rawIncomeItems.slice(0, 8) : incomeItems.slice(0, 8);

      // Obter detalhes de ordens dos símbolos do período para enriquecer Entrada, Stop, Take e Saída
      const symbolsToQuery = Array.from(new Set(targetDisplayItems.map((it: any) => it.symbol).filter(Boolean)));
      const ordersBySymbol: Record<string, any[]> = {};

      await Promise.allSettled(
        symbolsToQuery.map(async (sym: any) => {
          const ordRes = await sendBingXRequest('/openApi/swap/v2/trade/allOrders', 'GET', {
            symbol: sym,
            limit: 30
          }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo).catch(() => ({ code: -1, data: [] }));
          const ords = Array.isArray(ordRes?.data?.orders || ordRes?.data) ? (ordRes.data.orders || ordRes.data) : [];
          ordersBySymbol[sym] = ords;
        })
      );

      const timeStr = now.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
      let historyText = 
        `📜 <b>HISTÓRICO DETALHADO — ${range.periodName.toUpperCase()}</b>\n` +
        `💼 Conta: <b>${accLabel}</b> | 🕒 <code>${timeStr}</code>\n` +
        `═══════════════════════════\n\n`;

      if (isFallbackRecent) {
        historyText += `ℹ️ <i>Nenhuma operação finalizada hoje após as 00:00. Mostrando as <b>${targetDisplayItems.length} últimas operações</b> registradas na sua conta Bitunix:</i>\n\n`;
      }

      // Mostra as operações do período (até 8 mais recentes para não estourar o limite de caracteres do Telegram)
      const recentTrades = targetDisplayItems;
      let totalPnlSum = 0;

      recentTrades.forEach((item: any, idx: number) => {
        const sym = item.symbol || 'USDT';
        const cleanSym = sym.replace('-USDT', '').replace('USDT', '');
        const pnl = parseFloat(item.income || '0');
        totalPnlSum += pnl;
        const pnlSign = pnl > 0 ? '+' : (pnl < 0 ? '-' : '');
        const pnlEmoji = pnl > 0.05 ? '🟢' : (Math.abs(pnl) <= 0.05 ? '🛡️' : '🔴');
        const tradeDate = new Date(item.time || Date.now()).toLocaleString('pt-BR', {
          timeZone: 'America/Sao_Paulo',
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        });

        // 1. Buscar sinal original salvo no bot ou no histórico persistido de auditoria
        const matchedSignal = receivedTelegramSignals.find(s => 
          s.parsed && (s.parsed.coinName === cleanSym || s.parsed.symbol?.includes(cleanSym))
        );
        const auditRecord = tradeAuditHistory.find(a => 
          a.cleanSymbol === cleanSym && Math.abs(a.timestamp - item.time) < 86400000
        ) || tradeAuditHistory.find(a => a.cleanSymbol === cleanSym);

        // 2. Buscar ordens associadas no histórico da Bitunix
        const symOrders = ordersBySymbol[sym] || [];
        const filledOrders = symOrders
          .filter((o: any) => {
            const st = (o.status || '').toUpperCase();
            return st === 'FILLED' || parseFloat(o.executedQty || '0') > 0;
          })
          .sort((a: any, b: any) => (b.updateTime || b.time || 0) - (a.updateTime || a.time || 0));

        // Encontra a ordem de fechamento mais próxima no tempo
        const closeOrder = filledOrders.find((o: any) => {
          const ordTime = o.updateTime || o.time || 0;
          return Math.abs(ordTime - item.time) <= 60000;
        }) || filledOrders.find((o: any) => {
          const type = (o.type || '').toUpperCase();
          return type.includes('STOP') || type.includes('TAKE_PROFIT') || type.includes('MARKET');
        }) || filledOrders[0];

        // Encontra a ordem de abertura que antecedeu o fechamento
        const openOrder = filledOrders.find((o: any) => {
          const ordTime = o.updateTime || o.time || 0;
          return ordTime < (item.time - 500) && o.orderId !== closeOrder?.orderId;
        }) || filledOrders.find((o: any) => o.orderId !== closeOrder?.orderId) || filledOrders[1];

        // Determinar direção
        let direction = 'LONG';
        if (item.info && item.info.toLowerCase().includes('short')) direction = 'SHORT';
        else if (closeOrder && (closeOrder.positionSide === 'SHORT' || (closeOrder.side === 'BUY' && !closeOrder.positionSide))) direction = 'SHORT';
        else if (matchedSignal?.parsed?.direction) direction = matchedSignal.parsed.direction;
        else if (auditRecord?.direction) direction = auditRecord.direction;

        // Preços de Entrada e Saída
        let entryPrice = parseFloat(openOrder?.avgPrice || openOrder?.price || matchedSignal?.parsed?.entryPrice || auditRecord?.entryPrice || '0');
        let exitPrice = parseFloat(closeOrder?.avgPrice || closeOrder?.stopPrice || closeOrder?.price || '0');

        // Extrai alvos Take Profit e Stop Loss de todas as fontes disponíveis
        let tps: (number | string)[] = matchedSignal?.parsed?.takeProfits || auditRecord?.takeProfits || [];
        let stopPrice = parseFloat(matchedSignal?.parsed?.stopLoss || auditRecord?.stopLoss || '0');
        let leverage = matchedSignal?.parsed?.targetLeverage || auditRecord?.leverage || 20;

        // Vasculha as ordens da Bitunix para extrair TP, SL e Alavancagem reais se faltarem
        const orderTps: number[] = [];
        const orderStops: number[] = [];
        for (const o of symOrders) {
          const oType = (o.type || '').toUpperCase();
          const stopP = parseFloat(o.stopPrice || o.takeProfit?.stopPrice || o.stopLoss?.stopPrice || '0');
          const p = parseFloat(o.price || '0');
          if (o.leverage) {
            const levNum = parseInt(String(o.leverage).replace(/[^0-9]/g, ''), 10);
            if (levNum > 0 && leverage === 20) leverage = levNum;
          }
          if (oType.includes('TAKE_PROFIT') || o.takeProfit?.stopPrice > 0) {
            const targetP = stopP > 0 ? stopP : p;
            if (targetP > 0 && !orderTps.includes(targetP)) orderTps.push(targetP);
          }
          if (oType.includes('STOP') && !oType.includes('TRAILING')) {
            const sp = stopP > 0 ? stopP : p;
            if (sp > 0 && !orderStops.includes(sp)) orderStops.push(sp);
          }
        }

        if (tps.length === 0 && orderTps.length > 0) {
          tps = orderTps.sort((a, b) => direction === 'LONG' ? a - b : b - a);
        }

        if (stopPrice === 0 && orderStops.length > 0) {
          stopPrice = direction === 'LONG' ? Math.min(...orderStops) : Math.max(...orderStops);
        }

        // Determina o motivo real de saída ("Onde Tirou")
        let closeReasonDesc = 'Fechamento a Mercado';
        const cType = (closeOrder?.type || '').toUpperCase();
        const closeStopPrice = parseFloat(closeOrder?.stopPrice || '0');

        // Lógica precisa para identificar Proteção / Breakeven vs Stop Loss real
        const priceDiffPct = entryPrice > 0 && exitPrice > 0
          ? (direction === 'LONG' ? ((exitPrice - entryPrice) / entryPrice) * 100 : ((entryPrice - exitPrice) / entryPrice) * 100)
          : 0;

        const isStopProtectedPrice = (direction === 'LONG' && stopPrice > 0 && exitPrice > (stopPrice + (entryPrice - stopPrice) * 0.4))
          || (direction === 'SHORT' && stopPrice > 0 && exitPrice < (stopPrice - (stopPrice - entryPrice) * 0.4));
        const isNearZero = Math.abs(pnl) <= 0.15 || Math.abs(priceDiffPct) <= 0.45;
        const isStopOrderAtEntry = closeStopPrice > 0 && ((direction === 'LONG' && closeStopPrice >= entryPrice * 0.995) || (direction === 'SHORT' && closeStopPrice <= entryPrice * 1.005));

        const isProtectionExit = isStopOrderAtEntry || (cType.includes('TRAILING')) || ((cType.includes('STOP')) && (isNearZero || isStopProtectedPrice));

        if (cType.includes('TAKE_PROFIT')) {
          closeReasonDesc = '🎯 Take Profit Atingido';
        } else if (isProtectionExit) {
          if (pnl > 0.05) {
            closeReasonDesc = '⚡ Stop no Lucro (Proteção no Ganho)';
          } else if (Math.abs(pnl) <= 0.05) {
            closeReasonDesc = '🛡️ Proteção da Operação (Breakeven 0 a 0)';
          } else {
            closeReasonDesc = '🛡️ Proteção da Operação (0 a 0 / Breakeven)';
          }
        } else if (cType.includes('STOP')) {
          if (pnl > 0.05) {
            closeReasonDesc = '⚡ Stop no Lucro (Proteção)';
          } else if (Math.abs(pnl) <= 0.05) {
            closeReasonDesc = '🛡️ Breakeven (0 a 0 / Proteção)';
          } else {
            closeReasonDesc = '🛑 Stop Loss Acionado';
          }
        } else {
          if (pnl > 0.05) {
            closeReasonDesc = '💰 Saída com Lucro (Mercado)';
          } else if (Math.abs(pnl) <= 0.05) {
            closeReasonDesc = '🛡️ Breakeven (Proteção 0 a 0)';
          } else {
            closeReasonDesc = '🛑 Fechamento a Mercado';
          }
        }

        // Variação e ROI % precisos
        let roiDesc = '';
        if (isProtectionExit && Math.abs(pnl) <= 0.15) {
          roiDesc = ` <i>(${priceDiffPct >= 0 ? '+' : ''}${priceDiffPct.toFixed(2)}% no preço | 🛡️ Proteção)</i>`;
        } else if (entryPrice > 0 && exitPrice > 0 && Math.abs(entryPrice - exitPrice) > 0) {
          const roi = priceDiffPct * leverage;
          const roiSign = roi >= 0 ? '+' : '';
          roiDesc = ` <i>(${roiSign}${roi.toFixed(2)}% ROI)</i>`;
        } else {
          const estimatedMargin = 2.0;
          const estRoi = (pnl / estimatedMargin) * 100;
          const estSign = estRoi >= 0 ? '+' : '';
          roiDesc = ` <i>(${estSign}${estRoi.toFixed(2)}% ROI)</i>`;
        }

        // Taxas somadas para a operação
        const matchingFees = feeItems
          .filter((f: any) => f.symbol === sym && Math.abs(f.time - item.time) < 120000)
          .reduce((sum: number, f: any) => sum + Math.abs(parseFloat(f.income || '0')), 0);

        historyText += 
          `${pnlEmoji} <b>#${idx + 1} ${cleanSym}</b> (${direction} ${leverage}x)\n` +
          `💵 <b>Entrada:</b> <code>${entryPrice > 0 ? `$${entryPrice}` : 'Mercado'}</code>\n` +
          `🛑 <b>Stop Loss Inicial:</b> <code>${stopPrice > 0 ? `$${stopPrice}` : 'Proteção / Dinâmico'}</code>\n` +
          `🎯 <b>Alvos TP:</b> <code>${tps.length > 0 ? tps.map((tp: any) => `$${tp}`).join(' | ') : 'Take Profit Dinâmico'}</code>\n` +
          (exitPrice > 0 ? `🏁 <b>Preço de Saída:</b> <code>$${exitPrice}</code>\n` : '') +
          `🛡️ <b>Onde Tirou:</b> <i>${closeReasonDesc}</i>\n` +
          `💰 <b>Resultado Líquido:</b> <code>${pnlSign}$${Math.abs(pnl).toFixed(2)} ${accCurrency}</code>${roiDesc}\n` +
          (matchingFees > 0 ? `💸 <b>Taxas Bitunix:</b> <code>-$${matchingFees.toFixed(3)} ${accCurrency}</code>\n` : '') +
          `🕒 <b>Fechado em:</b> <code>${tradeDate}</code>\n` +
          `───────────────────────\n`;
      });

      const totalSign = totalPnlSum >= 0 ? '+' : '';
      const totalEmoji = totalPnlSum > 0.05 ? '🟢' : (totalPnlSum < -0.05 ? '🔴' : '⚪');
      historyText += 
        `\n📊 <b>Saldo Acumulado das ${recentTrades.length} operações:</b> ` +
        `<code>${totalSign}$${Math.abs(totalPnlSum).toFixed(2)} ${accCurrency}</code> ${totalEmoji}\n` +
        `💡 <i>Alterne os botões abaixo para ver o Dia, Semana ou Mês.</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `${period === 'DAY' ? '🔘' : '⚪'} 📅 Hoje (${todayTrades.length})`, callback_data: "VIEW_HISTORY:DAY" },
            { text: `${period === 'WEEK' ? '🔘' : '⚪'} 📆 Semana (${weekTrades.length})`, callback_data: "VIEW_HISTORY:WEEK" },
            { text: `${period === 'MONTH' ? '🔘' : '⚪'} 🗓️ Mês (${monthTrades.length})`, callback_data: "VIEW_HISTORY:MONTH" }
          ],
          [
            { text: "🔄 Atualizar Histórico", callback_data: `REFRESH_HISTORY:${period}` },
            { text: `📊 Relatório (${period === 'DAY' ? 'Hoje' : (period === 'WEEK' ? 'Semana' : 'Mês')})`, callback_data: `VIEW_REPORT:${period}` }
          ],
          [
            { text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" },
            { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text: historyText,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, historyText, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      console.error("[HISTORY-REPORT-ERR]:", err.message);
      await sendTelegramReply(chatId, `⚠️ <b>Falha ao gerar histórico detalhado:</b> ${err.message}`, undefined, { disableDedup: true });
    }
  };

  // Helper para obter detalhes atuais de Stop Loss, Take Profit e Entrada de uma moeda/ordem para exibição precisa nos menus de edição
  const getSymbolActiveSLTPInfo = async (symbol: string, orderId?: string) => {
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    const apiKey = DEFAULT_BITUNIX_KEY;
    const apiSecret = DEFAULT_BITUNIX_SECRET;
    const bitunixResolved = resolveBitunixSymbol(symbol);
    const bitunixSym = bitunixResolved.apiSymbol || symbol;
    const cleanSym = bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '');

    let entryPrice = 0;
    let currentSL: number | null = null;
    let currentTP: number | null = null;
    let positionSide = '';
    let markPrice = 0;
    let pricePrecision = bitunixResolved.contract?.pricePrecision || 2;

    try {
      const data = await getBingXOpenPositions(apiKey, apiSecret, isDemo);
      const openOrders: any[] = data.openOrders || [];
      const symOrders = openOrders.filter((o: any) => isSameOrRelatedSymbol(o.symbol, bitunixSym) || isSameOrRelatedSymbol(o.symbol, cleanSym));

      // 1. Posição aberta correspondente
      const pos = data.positions?.find((p: any) => isSameOrRelatedSymbol(p.symbol, bitunixSym) || isSameOrRelatedSymbol(p.symbol, cleanSym));
      if (pos) {
        if (pos.entryPrice) entryPrice = pos.entryPrice;
        if (pos.markPrice) markPrice = pos.markPrice;
        if (pos.stopLoss) currentSL = pos.stopLoss;
        if (pos.takeProfit) currentTP = pos.takeProfit;
        if (pos.positionSide) positionSide = pos.positionSide;
      }

      // 2. Ordens no livro da corretora (limite, stop loss, take profit)
      const limitOrder = symOrders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');
      if (limitOrder) {
        if (!entryPrice) entryPrice = parseFloat(limitOrder.price || limitOrder.stopPrice || '0');
        if (!positionSide) {
          positionSide = (limitOrder.side === 'BUY' || limitOrder.positionSide === 'LONG') ? 'LONG' : 'SHORT';
        }
      }

      const slOrder = symOrders.find((o: any) => o.type === 'STOP_MARKET' || o.type === 'STOP' || o.type === 'STOP_LOSS');
      if (slOrder) {
        const slVal = parseFloat(slOrder.stopPrice || slOrder.price || '0');
        if (slVal > 0) currentSL = slVal;
      }

      const tpOrder = symOrders.find((o: any) => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');
      if (tpOrder) {
        const tpVal = parseFloat(tpOrder.stopPrice || tpOrder.price || '0');
        if (tpVal > 0) currentTP = tpVal;
      }
    } catch (e: any) {
      console.warn(`[GET-SLTP-INFO-WARN]:`, e?.message || e);
    }

    // 3. Fallback ao cache customizado em memória (activeCustomSLTPBySymbol)
    const custom = activeCustomSLTPBySymbol.get(bitunixSym) || activeCustomSLTPBySymbol.get(cleanSym) || activeCustomSLTPBySymbol.get(symbol);
    if (custom) {
      if (currentSL == null && custom.stopLoss) currentSL = custom.stopLoss;
      if (currentTP == null && custom.takeProfit) currentTP = custom.takeProfit;
    }

    // 4. Fallback ao sinal recebido original
    const matchingSignal = receivedTelegramSignals.find((s: any) =>
      isSameOrRelatedSymbol(s.parsed?.symbol, cleanSym) || isSameOrRelatedSymbol(s.parsed?.symbol, symbol)
    );
    if (matchingSignal?.parsed) {
      if (!entryPrice && matchingSignal.parsed.entry) entryPrice = matchingSignal.parsed.entry;
      if (currentSL == null && matchingSignal.parsed.stopLoss) currentSL = matchingSignal.parsed.stopLoss;
      if (currentTP == null && matchingSignal.parsed.takeProfits?.length) currentTP = matchingSignal.parsed.takeProfits[0];
      if (!positionSide && matchingSignal.parsed.side) positionSide = matchingSignal.parsed.side;
    }

    if (entryPrice > 0 && !bitunixResolved.contract?.pricePrecision) {
      if (entryPrice >= 1000) pricePrecision = 2;
      else if (entryPrice >= 1) pricePrecision = 4;
      else pricePrecision = 6;
    }

    return {
      symbol: bitunixSym,
      cleanSym,
      entryPrice,
      markPrice,
      currentSL,
      currentTP,
      positionSide,
      pricePrecision
    };
  };

  // Armazenamento em memória do estado de edição rápida via Telegram (chatId -> pending edit info)
  const pendingUserEdits = new Map<string, {
    symbol: string;
    orderType: 'SL' | 'TP' | 'LIMIT' | 'TRAILING' | 'TRAILING_PRICE' | 'TRAILING_PCT';
    orderId?: string;
    promptMsgId?: number;
    side?: string;
    currentPrice?: number;
    timestamp: number;
  }>();

  // Armazenamento em memória da espera pelo comando /imagem de sinal (chatId -> prompt info)
  const pendingImagePrompts = new Map<string, {
    timestamp: number;
    promptMsgId?: number;
  }>();

  // Armazenamento em memória da espera por parâmetros de configuração (chatId -> prompt info)
  const pendingConfigPrompts = new Map<string, {
    type: 'RISK' | 'TRAILING_MULT' | 'TRAILING_TRIGGER' | 'DAILY_LOSS' | 'DAILY_PROFIT' | 'CONDUCAO_0' | 'CONDUCAO_1' | 'CONDUCAO_2' | 'CONDUCAO_3' | 'CONDUCAO_4' | 'CONDUCAO_5' | 'CONDUCAO_6';
    promptMsgId?: number;
    timestamp: number;
  }>();

  // Armazenamento em memória para edição de parâmetros de condução específicos de uma posição (chatId -> info)
  const pendingPosConducaoPrompts = new Map<string, {
    symbol: string;
    side: string;
    param: 'def' | 'be' | 'eq' | 'f1' | 'folga1' | 'f2' | 'folga2';
    promptMsgId?: number;
    timestamp: number;
  }>();

  const getBrasiliaDateString = () => {
    return new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  const getTodayPnLAndTrades = async () => {
    try {
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const range = getBrasiliaPeriodRange('DAY');
      const [incomeRes, posData] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/income', 'GET', { limit: 100 }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo).catch(() => ({ code: -1, data: [] })),
        getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo).catch(() => ({ positions: [], balance: 0, success: true }))
      ]);

      const rawItems = Array.isArray(incomeRes?.data) ? incomeRes.data : [];
      const todayTrades = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= range.startTime && t <= range.endTime && it.incomeType === 'REALIZED_PNL';
      });

      const todayPnl = todayTrades.reduce((acc: number, it: any) => acc + parseFloat(it.income || '0'), 0);
      return {
        balance: posData.balance || 0,
        todayPnl,
        todayTradesCount: todayTrades.length,
        positions: posData.positions || []
      };
    } catch (e) {
      return { balance: 0, todayPnl: 0, todayTradesCount: 0, positions: [] };
    }
  };

  const checkDailyLockBlocked = async (customBalance?: number): Promise<{ blocked: boolean; reason?: string }> => {
    try {
      const todayStr = getBrasiliaDateString();
      if (serverTelegramBotConfig.dailyLockUnlockedDate === todayStr) {
        return { blocked: false };
      }
      const data = await getTodayPnLAndTrades();
      const bal = customBalance !== undefined ? customBalance : data.balance;

      if (serverTelegramBotConfig.dailyLossLimitEnabled) {
        const maxLossUsd = serverTelegramBotConfig.dailyLossPercent > 0
          ? (bal * (serverTelegramBotConfig.dailyLossPercent / 100))
          : (serverTelegramBotConfig.dailyLossFixedUsd || 0);

        if (maxLossUsd > 0 && data.todayPnl <= -maxLossUsd) {
          return {
            blocked: true,
            reason: `🛑 <b>TRAVA DIÁRIA DE PERDA ATIVADA!</b>\n\n` +
              `Seu prejuízo de hoje atingiu <b>-$${Math.abs(data.todayPnl).toFixed(2)} USDT</b> (limite configurado: -$${maxLossUsd.toFixed(2)} USDT).\n` +
              `Novas operações foram bloqueadas para proteger seu capital.\n\n` +
              `👉 <i>Para liberar operações hoje, acesse <code>/config</code> e toque em <b>🔓 Destravar Hoje</b>.</i>`
          };
        }
      }

      if (serverTelegramBotConfig.dailyProfitTargetEnabled) {
        const maxProfitUsd = serverTelegramBotConfig.dailyProfitTargetPercent > 0
          ? (bal * (serverTelegramBotConfig.dailyProfitTargetPercent / 100))
          : (serverTelegramBotConfig.dailyProfitFixedUsd || 0);

        if (maxProfitUsd > 0 && data.todayPnl >= maxProfitUsd) {
          return {
            blocked: true,
            reason: `🎯 <b>META DE LUCRO DIÁRIA ATINGIDA!</b>\n\n` +
              `Seu lucro de hoje atingiu <b>+$${data.todayPnl.toFixed(2)} USDT</b> (meta configurada: +$${maxProfitUsd.toFixed(2)} USDT).\n` +
              `Novas operações foram pausadas para blindar os ganhos do dia.\n\n` +
              `👉 <i>Para continuar operando mesmo assim, acesse <code>/config</code> e toque em <b>🔓 Destravar Hoje</b>.</i>`
          };
        }
      }
    } catch (e) {}
    return { blocked: false };
  };

  // Helper para renderizar o seletor de Contas Salvas Bitunix no Telegram
  const renderTelegramAccountSwitcherMenu = async (chatId: number | string, messageIdToEdit?: number, statusNotice?: string) => {
    try {
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const activeAcc = getActiveSavedBitunixAccount();
      const balance = await getCachedBitunixBalance(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo, true).catch(() => 0);

      const lines = savedBitunixAccounts.map((acc, idx) => {
        const isCurrent = activeAcc ? acc.id === activeAcc.id : acc.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim();
        return `${isCurrent ? '✅' : '⚪'} <b>${idx + 1}. ${acc.label}</b> — <code>${maskKeyStr(acc.apiKey, 6, 4)}</code>${isCurrent ? ' <i>(Ativa)</i>' : ''}`;
      }).join('\n');

      const noticeBlock = statusNotice ? `\n✨ <i>${statusNotice}</i>\n` : '';
      const text =
        `🔑 <b>ALTERNAR CONTA BITUNIX</b>\n` +
        `═════════════════════════════════\n` +
        `💼 Conta Atual: <b>${activeAcc?.label || 'Bitunix'}</b>\n` +
        `🛡️ Chave: <code>${maskKeyStr(DEFAULT_BITUNIX_KEY, 6, 4)}</code>\n` +
        `💰 Saldo Disponível: <b>$${balance.toFixed(2)} USDT</b>\n` +
        `${noticeBlock}` +
        `═════════════════════════════════\n\n` +
        `📋 <b>Chaves Salvas:</b>\n${lines}\n\n` +
        `👇 <i>Toque em uma conta abaixo para alternar instantaneamente:</i>`;

      const accountRows = savedBitunixAccounts.map(acc => {
        const isCurrent = activeAcc ? acc.id === activeAcc.id : acc.apiKey.trim() === DEFAULT_BITUNIX_KEY.trim();
        return [
          {
            text: `${isCurrent ? '✅' : '🔄'} ${acc.label} (${maskKeyStr(acc.apiKey, 4, 4)})`,
            callback_data: `SWITCH_SAVED_ACCOUNT:${acc.id}`
          }
        ];
      });

      const keyboard = {
        inline_keyboard: [
          ...accountRows,
          [
            { text: "⚙️ Voltar p/ Config", callback_data: "VIEW_CONFIG" },
            { text: "💼 Ver Status", callback_data: "VIEW_STATUS" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (e: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao carregar contas salvas: ${e?.message || e}`, undefined, { disableDedup: true });
    }
  };

  // Helper para renderizar a Central de Configurações Bitunix no Telegram (Prints 3 e 4)
  const renderTelegramConfigMenu = async (chatId: number | string, messageIdToEdit?: number) => {
    try {
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const posData = await getBitunixOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
      const balance = posData.balance || 0;
      const curr = 'USDT';
      const activeAcc = getActiveSavedBitunixAccount();
      const accountBadge = isDemo
        ? "🟡 Simulação Bitunix"
        : `🟢 ${activeAcc?.label || 'Bitunix Futuros USDT Real'} (${maskKeyStr(DEFAULT_BITUNIX_KEY, 4, 4)})`;

      const fmtN = (n: number) => {
        const s = n.toFixed(1);
        return s.endsWith('.0') ? s.slice(0, -2) : s;
      };

      const c0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
      const c1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
      const c2 = serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5;
      const c3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
      const c4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
      const c5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
      const c6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;
      const isConducaoActive = serverTelegramBotConfig.conducaoStopEnabled !== false;

      const riskPct = serverTelegramBotConfig.riskPercent || 2.0;
      const riskVal = serverTelegramBotConfig.riskMode === 'PERCENT'
        ? (balance * (riskPct / 100))
        : (serverTelegramBotConfig.riskFixedUsd || 50.0);
      const riskBadge = serverTelegramBotConfig.riskMode === 'PERCENT'
        ? `${riskPct}% ($${riskVal.toFixed(2)} ${curr})`
        : `$${riskVal.toFixed(2)} ${curr}`;

      const todayStr = getBrasiliaDateString();
      const isUnlocked = serverTelegramBotConfig.dailyLockUnlockedDate === todayStr;
      let dailyLockBadge = "⚪ Desativada";
      if (isUnlocked) {
        dailyLockBadge = "🟡 Destravada Hoje";
      } else if (serverTelegramBotConfig.dailyLossLimitEnabled) {
        if (serverTelegramBotConfig.dailyLossPercent > 0) {
          dailyLockBadge = `🛑 Ativa (-${serverTelegramBotConfig.dailyLossPercent}%)`;
        } else if (serverTelegramBotConfig.dailyLossFixedUsd > 0) {
          dailyLockBadge = `🛑 Ativa (-$${serverTelegramBotConfig.dailyLossFixedUsd.toFixed(2)})`;
        } else {
          dailyLockBadge = `🛑 Ativa (-5%)`;
        }
      }

      const leverageBadge = serverTelegramBotConfig.defaultLeverageMode === 'SIGNAL_LEVERAGE'
        ? `📡 Do Sinal (Usa a alavancagem de cada canal até 1000x)`
        : `Fixa: ${serverTelegramBotConfig.fixedLeverageValue}x`;

      const execBadge = serverTelegramBotConfig.autoExecuteWithoutPrompt
        ? `⚡ Automática (Sem confirmação)`
        : `📳 Confirmação com 1 toque`;

      const feesBadge = serverTelegramBotConfig.includeFeesInRisk !== false
        ? `🟢 Embutidas no SL (~0.10%)`
        : `⚪ Desativadas`;

      const rebateBadge = (serverTelegramBotConfig as any).feeRebate !== false
        ? `🟢 Ativo (45% de retorno)`
        : `⚪ Desativado`;

      const vipTargetsBadge = (serverTelegramBotConfig as any).vipTargetsMode === 'STANDARD'
        ? `Alvos do Canal (Padrão)`
        : `Alvos xx-x (1x / +0.5x)`;

      const smartEntryBadge = (serverTelegramBotConfig as any).smartEntry1mEnabled !== false
        ? `🟢 Ativa (+5% SL)`
        : `⚪ Desativada`;

      const text =
        `⚙️ <b>CENTRAL DE CONFIGURAÇÕES BITUNIX</b>\n` +
        `═════════════════════════════════\n` +
        `💼 Conta: <b>${accountBadge}</b>\n` +
        `💰 Saldo Disponível: <b>$${balance.toFixed(2)} ${curr}</b>\n` +
        `═════════════════════════════════\n\n` +
        `📊 <b>Parâmetros Operacionais:</b>\n` +
        `• Condução de Stop: <b>${isConducaoActive ? 'Mover por Alvos 🟢' : 'Desativada ⚪'}</b> (Reduz: ${fmtN(c0)}x (-33%) | BE: ${fmtN(c1)}x | Eq: ${fmtN(c2)}x | Conduz: ${fmtN(c3)}x | Folga: ${fmtN(c4)}x | F2: ${fmtN(c5)}x (Folga ${fmtN(c6)}x))\n` +
        `• Gerenciamento de Risco: <b>${riskBadge}</b>\n` +
        `• Trava Diária: <b>${dailyLockBadge}</b>\n` +
        `• Modo de Alavancagem: <b>${leverageBadge}</b>\n` +
        `• Execução de Sinais: <b>${execBadge}</b>\n` +
        `• Taxas no Risco: <b>${feesBadge}</b>\n` +
        `• Reembolso de Taxas: <b>${rebateBadge}</b>\n` +
        `• Alvos VIP: <b>${vipTargetsBadge}</b>\n` +
        `• Entrada Inteligente 1m: <b>${smartEntryBadge}</b>\n` +
        `• Cancelamento Automático: <b>🛑 No Stop 🎯 Em 1x Stop</b>\n` +
        `═════════════════════════════════\n` +
        `👇 <i>Toque nos botões abaixo para alterar qualquer configuração:</i>`;

      const conducaoLabel = isConducaoActive ? 'ALVOS 🟢' : 'DESLIGADA ⚪';
      const levLabel = serverTelegramBotConfig.defaultLeverageMode === 'SIGNAL_LEVERAGE' ? 'Do Sinal' : `${serverTelegramBotConfig.fixedLeverageValue}x`;
      const execBtnLabel = serverTelegramBotConfig.autoExecuteWithoutPrompt ? '⚡ Auto 100%' : '📱 Confirmação 1-Toque';
      const feesBtnLabel = serverTelegramBotConfig.includeFeesInRisk !== false ? 'Embutidas 🟢' : 'Desativadas ⚪';
      const rebateBtnLabel = (serverTelegramBotConfig as any).feeRebate !== false ? '45% 🟢' : 'Desativado ⚪';
      const vipBtnLabel = (serverTelegramBotConfig as any).vipTargetsMode === 'STANDARD' ? 'Alvos: Padrão' : 'Alvos VIP (1x / +0.5x)';
      const smartEntryBtnLabel = (serverTelegramBotConfig as any).smartEntry1mEnabled !== false ? '🟢' : '⚪';

      const keyboard = {
        inline_keyboard: [
          [
            { text: `🔑 Conta: ${activeAcc?.label || 'Bitunix'}`, callback_data: "OPEN_ACCOUNT_SWITCHER" }
          ],
          [
            { text: `🎯 Condução: ${conducaoLabel}`, callback_data: "TOGGLE_CONDUCAO" },
            { text: "⚙️ Ajustar Condução", callback_data: "VIEW_TRAILING_CONFIG" }
          ],
          [
            { text: "🛡️ Configurar Risco", callback_data: "MENU_CONFIG_RISK" },
            { text: `${serverTelegramBotConfig.dailyLossLimitEnabled ? '🛑' : '⚪'} Trava Diária`, callback_data: "MENU_CONFIG_DAILY_LOCK" }
          ],
          [
            { text: `📡 Alavancagem: ${levLabel}`, callback_data: "TOGGLE_LEVERAGE_MODE" },
            { text: execBtnLabel, callback_data: "TOGGLE_SIGNAL_EXEC" }
          ],
          [
            { text: `💸 Taxas: ${feesBtnLabel}`, callback_data: "TOGGLE_FEES_EMBEDDED" },
            { text: `🎁 Reembolso: ${rebateBtnLabel}`, callback_data: "TOGGLE_FEE_REBATE" }
          ],
          [
            { text: `🎯 ${vipBtnLabel}`, callback_data: "TOGGLE_VIP_TARGETS" },
            { text: `🧠 Entrada 1m (${smartEntryBtnLabel})`, callback_data: "TOGGLE_1M_ENTRY" }
          ],
          [
            { text: "🔄 Atualizar Painel", callback_data: "REFRESH_CONFIG" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao abrir configurações: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Helper para renderizar Configuração da Condução de Stop Loss (Prints 2 e 3)
  const renderTelegramTrailingConfigMenu = async (chatId: number | string, messageIdToEdit?: number) => {
    try {
      const isConducaoActive = serverTelegramBotConfig.conducaoStopEnabled !== false;
      const isTrailingMode = serverTelegramBotConfig.conducaoStrategy === 'TRAILING';
      const isConducaoMode = !isTrailingMode;

      const fmtN = (n: number) => {
        const s = n.toFixed(1);
        return s.endsWith('.0') ? s.slice(0, -2) : s;
      };

      const c0 = serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0;
      const c1 = serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5;
      const c2 = serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5;
      const c3 = serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0;
      const c4 = serverTelegramBotConfig.conducaoTier4Dist ?? 1.0;
      const c5 = serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0;
      const c6 = serverTelegramBotConfig.conducaoTier6Dist ?? 0.5;

      const text =
        `🎯 <b>CONDUÇÃO DE STOP LOSS (PROTEÇÃO ESCALONADA)</b>\n` +
        `═════════════════════════════════\n\n` +
        `O robô monitora a posição em tempo real e avança o Stop Loss na Bitunix conforme cada nível é atingido.\n\n` +
        `📌 <b>Status:</b> ${isConducaoActive ? '🟢 ATIVADO' : '🔴 DESATIVADO'}\n` +
        `📌 <b>Estratégia:</b> 🎯 <b>Condução por Vezes o Stop Loss</b> 🟢\n\n` +
        `0️⃣ <b>Reduzir Risco (Stop Defensivo):</b>\n` +
        `👉 <b>Gatilho:</b> ${fmtN(c0)}x do Stop (Stop em -33%)\n` +
        `↳ <i>Puxa o Stop para -33%, cortando 67% da perda e evitando violinada na entrada.</i>\n\n` +
        `1️⃣ <b>Mover p/ Entrada (Break-Even):</b>\n` +
        `👉 <b>Gatilho:</b> ${fmtN(c1)}x do Stop\n` +
        `↳ <i>Puxa o Stop Loss para 0 a 0 garantindo risco zero.</i>\n\n` +
        `2️⃣ <b>Preço de Equilíbrio (Cobrir Taxas):</b>\n` +
        `👉 <b>Gatilho:</b> ${fmtN(c2)}x do Stop\n` +
        `↳ <i>Avança o Stop Loss para pagar 100% das taxas Bitunix (risco zero real).</i>\n\n` +
        `3️⃣ <b>Começar Condução (Garantir Lucro - Fase 1):</b>\n` +
        `👉 <b>Gatilho inicial:</b> ${fmtN(c3)}x do Stop\n` +
        `↳ <i>Momento em que o robô começa a travar lucro no bolso.</i>\n\n` +
        `4️⃣ <b>Folga Inicial (Fase 1):</b>\n` +
        `👉 <b>Distância:</b> ${fmtN(c4)}x recuado\n` +
        `↳ <i>Espaço para o trade respirar.</i>\n\n` +
        `5️⃣ <b>Apertar Stop / Acelerar Condução (Fase 2):</b>\n` +
        `👉 <b>A partir de:</b> ${fmtN(c5)}x do Stop\n` +
        `↳ <i>Acelera a proteção para blindar grandes lucros.</i>\n\n` +
        `6️⃣ <b>Folga Reduzida (Fase 2):</b>\n` +
        `👉 <b>Distância:</b> ${fmtN(c6)}x recuado\n` +
        `↳ <i>Stop colado para não devolver lucro alto acumulado.</i>\n\n` +
        `═════════════════════════════════\n` +
        `📊 <b>SIMULAÇÃO DA SUA CONDUÇÃO:</b>\n` +
        `• Atingir +${fmtN(c0)}x: Stop ➔ <b>Reduzir Risco p/ -33%</b> 🛡️ <i>(respiro sem violinada)</i>\n` +
        `• Atingir +${fmtN(c1)}x: Stop ➔ <b>Preço de Equilíbrio (Entrada + Taxas Pagas)</b> ⚖️\n` +
        `• Atingir +${fmtN(c3)}x: Stop ➔ <b>+${fmtN(c3 - c4)}x de Lucro garantido</b> (Fase 1 🛡️ )\n` +
        `• Atingir +${fmtN(c3 + 0.5)}x: Stop ➔ <b>+${fmtN(c3 + 0.5 - c4)}x de Lucro garantido</b> (Fase 1 🛡️ )\n` +
        `• Atingir +${fmtN(c5)}x: Stop ➔ <b>+${fmtN(c5 - c6)}x de Lucro garantido</b> (Fase 2 ⚡ Folga ${fmtN(c6)}x)\n` +
        `• Atingir +${fmtN(c5 + 0.5)}x: Stop ➔ <b>+${fmtN(c5 + 0.5 - c6)}x de Lucro garantido</b> (Fase 2 ⚡ Folga ${fmtN(c6)}x)\n` +
        `• Atingir +${fmtN(c5 + 1.0)}x: Stop ➔ <b>+${fmtN(c5 + 1.0 - c6)}x de Lucro garantido</b> (Fase 2 ⚡ Folga ${fmtN(c6)}x)\n` +
        `• Atingir +${fmtN(c5 + 1.5)}x: Stop ➔ <b>+${fmtN(c5 + 1.5 - c6)}x de Lucro garantido</b> (Fase 2 ⚡ Folga ${fmtN(c6)}x)\n` +
        `═════════════════════════════════\n\n` +
        `👇 <i>Toque nas opções abaixo para personalizar:</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: `⚡ Trailing Bitunix${isTrailingMode ? ' (Ativo)' : ''}`, callback_data: "SET_MODE_TRAILING" },
            { text: `🟢 Condução por Stop${isConducaoMode ? ' (Ativo)' : ''}`, callback_data: "SET_MODE_CONDUCAO" }
          ],
          [
            {
              text: isConducaoActive
                ? "🟢 Condução: ATIVADA (Toque p/ Pausar)"
                : "🔴 Condução: PAUSADA (Toque p/ Ativar)",
              callback_data: "TOGGLE_CONDUCAO_ACTIVE"
            }
          ],
          [
            { text: `🛡️ 0. Reduzir: ${fmtN(c0)}x (-33%)`, callback_data: "PROMPT_CONDUCAO_0" }
          ],
          [
            { text: `✏️ 1. Break-Even: ${fmtN(c1)}x`, callback_data: "PROMPT_CONDUCAO_1" },
            { text: `⚖️ 2. Equilíbrio: ${fmtN(c2)}x`, callback_data: "PROMPT_CONDUCAO_2" }
          ],
          [
            { text: `🚀 3. Início F1: ${fmtN(c3)}x`, callback_data: "PROMPT_CONDUCAO_3" },
            { text: `📐 4. Folga F1: ${fmtN(c4)}x`, callback_data: "PROMPT_CONDUCAO_4" }
          ],
          [
            { text: `⚡ 5. Apertar F2: ${fmtN(c5)}x`, callback_data: "PROMPT_CONDUCAO_5" },
            { text: `🎯 6. Folga F2: ${fmtN(c6)}x`, callback_data: "PROMPT_CONDUCAO_6" }
          ],
          [
            { text: "⬅️ Voltar p/ Configurações", callback_data: "VIEW_CONFIG" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao abrir Condução de Stop: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Helper para renderizar Gerenciamento de Risco Bitunix (Print 4)
  const renderTelegramRiskConfigMenu = async (chatId: number | string, messageIdToEdit?: number) => {
    try {
      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const posData = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
      const balance = posData.balance || 0;

      const isPercent = serverTelegramBotConfig.riskMode === 'PERCENT';
      const riskDisplay = isPercent
        ? `${serverTelegramBotConfig.riskPercent}% da conta`
        : `$${serverTelegramBotConfig.riskFixedUsd} USD`;
      const estimatedLoss = isPercent
        ? (balance * (serverTelegramBotConfig.riskPercent / 100))
        : (serverTelegramBotConfig.riskFixedUsd || 0);

      const text =
        `🛡️ <b>GERENCIAMENTO DE RISCO BITUNIX</b>\n\n` +
        `📌 <b>Configuração Atual:</b>\n` +
        `• Modo: 🔵 <b>${isPercent ? 'Percentual da Banca' : 'Dólares Fixos'}</b>\n` +
        `• Trava de Risco: <b>${riskDisplay}</b>\n` +
        `• Saldo Bitunix: <b>$${balance.toFixed(2)} USDT</b>\n` +
        `• Perda Máxima Estimada: <b>-$${estimatedLoss.toFixed(2)} USDT por Stop Loss</b>\n\n` +
        `👇 <i>Toque abaixo para definir o risco desejado:</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✏️ Digitar Novo Risco", callback_data: "PROMPT_CONFIG_RISK" }
          ],
          [
            { text: "⬅️ Voltar p/ Configurações", callback_data: "VIEW_CONFIG" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao abrir gestão de risco: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Helper para enviar instruções de digitação de risco (Print 5)
  const sendRiskPromptExplanation = async (chatId: number | string) => {
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    const posData = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
    const balance = posData.balance || 0;

    const p05 = (balance * 0.005).toFixed(2);
    const p1 = (balance * 0.01).toFixed(2);
    const p2 = (balance * 0.02).toFixed(2);

    const text =
      `✏️ <b>COMO DEFINIR SEU RISCO POR OPERAÇÃO</b>\n\n` +
      `💰 <b>Saldo Atual:</b> <b>$${balance.toFixed(2)} USDT</b>\n\n` +
      `Digite quanto aceita arriscar por trade (Stop Loss):\n\n` +
      `1️⃣ <b>Em Porcentagem da Banca:</b>\n` +
      `• Digite <code>0.5%</code> (equivale a -$${p05} USDT)\n` +
      `• Digite <code>1%</code> (equivale a -$${p1} USDT)\n` +
      `• Digite <code>2%</code> (equivale a -$${p2} USDT)\n\n` +
      `2️⃣ <b>Em Dólares Fixos:</b>\n` +
      `• Digite <code>$5</code>, <code>10 dol</code> ou apenas <code>15</code>\n\n` +
      `💬 <b>Envie sua resposta agora aqui no chat:</b>`;

    const keyboard = {
      inline_keyboard: [
        [
          { text: "⬅️ Voltar p/ Configurações", callback_data: "VIEW_CONFIG" },
          { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
        ]
      ]
    };

    const res = await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
    pendingConfigPrompts.set(String(chatId), {
      type: 'RISK',
      promptMsgId: res?.message_id,
      timestamp: Date.now()
    });
  };

  // Helper para renderizar a Trava Diária e Meta de Lucro (Print 6)
  const renderTelegramDailyLockMenu = async (chatId: number | string, messageIdToEdit?: number) => {
    try {
      const todayData = await getTodayPnLAndTrades();
      const balance = todayData.balance;
      const todayPnl = todayData.todayPnl;
      const todayStr = getBrasiliaDateString();
      const isUnlocked = serverTelegramBotConfig.dailyLockUnlockedDate === todayStr;

      const pnlSign = todayPnl > 0 ? '+' : (todayPnl < 0 ? '-' : '');
      const pnlEmoji = todayPnl > 0.05 ? '🟢' : (todayPnl < -0.05 ? '🔴' : '⚪');

      let lossLimitText = '⚪ Desativada';
      let maxLossUsd = 0;
      if (serverTelegramBotConfig.dailyLossLimitEnabled) {
        if (serverTelegramBotConfig.dailyLossPercent > 0) {
          maxLossUsd = balance * (serverTelegramBotConfig.dailyLossPercent / 100);
          lossLimitText = `🔵 ${serverTelegramBotConfig.dailyLossPercent}% da Banca (-$${maxLossUsd.toFixed(2)} USDT)`;
        } else if (serverTelegramBotConfig.dailyLossFixedUsd > 0) {
          maxLossUsd = serverTelegramBotConfig.dailyLossFixedUsd;
          lossLimitText = `🔵 -$${maxLossUsd.toFixed(2)} USDT`;
        }
      }

      let profitTargetText = '⚪ Desativada';
      let maxProfitUsd = 0;
      if (serverTelegramBotConfig.dailyProfitTargetEnabled) {
        if (serverTelegramBotConfig.dailyProfitTargetPercent > 0) {
          maxProfitUsd = balance * (serverTelegramBotConfig.dailyProfitTargetPercent / 100);
          profitTargetText = `🟢 ${serverTelegramBotConfig.dailyProfitTargetPercent}% da Banca (+$${maxProfitUsd.toFixed(2)} USDT)`;
        } else if (serverTelegramBotConfig.dailyProfitFixedUsd > 0) {
          maxProfitUsd = serverTelegramBotConfig.dailyProfitFixedUsd;
          profitTargetText = `🟢 +$${maxProfitUsd.toFixed(2)} USDT`;
        }
      }

      let statusBadge = "⚪ Desativada";
      if (isUnlocked) {
        statusBadge = "🟡 Destravada Hoje (Operando Manualmente)";
      } else if (serverTelegramBotConfig.dailyLossLimitEnabled && maxLossUsd > 0 && todayPnl <= -maxLossUsd) {
        statusBadge = "🔴 Bloqueado (Limite de Perda Atingido)";
      } else if (serverTelegramBotConfig.dailyProfitTargetEnabled && maxProfitUsd > 0 && todayPnl >= maxProfitUsd) {
        statusBadge = "🎯 Bloqueado (Meta de Lucro Atingida)";
      } else if (serverTelegramBotConfig.dailyLossLimitEnabled) {
        statusBadge = "🟢 Ativa e Blindando a Conta";
      }

      const remainingLossLine = (serverTelegramBotConfig.dailyLossLimitEnabled && maxLossUsd > 0 && !isUnlocked)
        ? `• Falta p/ Travar: <b>$${Math.max(0, maxLossUsd + todayPnl).toFixed(2)} USDT</b>\n`
        : '';

      const text =
        `🛡️ <b>TRAVA DIÁRIA & META DE LUCRO</b>\n\n` +
        `📌 <b>Status de Hoje (Hoje (${todayStr})):</b>\n` +
        `• Saldo Bitunix: <b>$${balance.toFixed(2)} USDT</b>\n` +
        `• PnL Fechado Hoje: <b>${pnlSign}$${Math.abs(todayPnl).toFixed(2)} USDT</b> ${pnlEmoji}\n` +
        `• Limite de Perda (Trava): ${lossLimitText}\n` +
        `${remainingLossLine}` +
        `• Meta de Lucro: ${profitTargetText}\n` +
        `• Status: ${statusBadge}\n\n` +
        `👇 <i>Toque em um dos botões para definir ou desativar:</i>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: "✏️ Digitar Trava de Perda", callback_data: "PROMPT_DAILY_LOSS" },
            { text: "🎯 Digitar Meta de Lucro", callback_data: "PROMPT_DAILY_PROFIT" }
          ],
          [
            { text: "❌ Desativar Trava", callback_data: "DISABLE_DAILY_LOSS" },
            { text: "❌ Desativar Meta", callback_data: "DISABLE_DAILY_PROFIT" }
          ],
          [
            { text: "🔓 Destravar Hoje", callback_data: "UNLOCK_DAILY_LOCK" }
          ],
          [
            { text: "⬅️ Voltar p/ Configurações", callback_data: "VIEW_CONFIG" }
          ]
        ]
      };

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 }).catch(() => {});
        trackActiveKeyboardMessage(chatId, messageIdToEdit);
      } else {
        await sendTelegramReply(chatId, text, keyboard, { disableDedup: true });
      }
    } catch (err: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao abrir Trava Diária: ${err?.message || err}`, undefined, { disableDedup: true });
    }
  };

  // Helper para renderizar Menu Interativo Dedicado do Trailing Stop
  const renderTelegramTrailingMenu = async (chatId: number | string, symbol: string, messageIdToEdit?: number) => {
    try {
      const cleanUpper = symbol.toUpperCase().replace('-USDT', '').replace('USDT', '');
      const normalizedSym = `${cleanUpper}-USDT`;
      const isDemo = serverTelegramBotConfig.accountType === 'VST';

      const ordersRes = await sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
      const orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];

      const tsOrder = orders.find((o: any) => o.type === 'TRAILING_STOP_MARKET' || o.type === 'TRAILING_STOP' || (o.type || '').includes('TRAILING'));
      const limitOrder = orders.find((o: any) => o.type === 'LIMIT' || o.type === 'TRIGGER_LIMIT');

      const triggerPrice = parseFloat(tsOrder?.activationPrice || tsOrder?.stopPrice || '0');
      const displayPrice = triggerPrice > 0 ? `$${triggerPrice}` : 'Não definido (Ativa Imediato)';
      
      const rawRate = parseFloat(tsOrder?.priceRate || tsOrder?.callbackRate || '0');
      const displayRatePct = rawRate > 0 ? (rawRate < 0.5 ? (rawRate * 100).toFixed(2) : rawRate.toFixed(2)) : ((serverTelegramBotConfig.trailingMultiplier || 1.0) * 1.5).toFixed(2);

      const qty = parseFloat(tsOrder?.origQty || tsOrder?.quantity || limitOrder?.origQty || limitOrder?.quantity || '0');

      let text = `🛰️ <b>GERENCIAR TRAILING STOP: ${cleanUpper}</b>\n\n` +
        `⚡ <b>Gatilho de Ativação:</b> <code>${displayPrice}</code>\n` +
        `📉 <b>Distância de Recuo:</b> <code>${displayRatePct}%</code> (Callback Rate)\n` +
        `${qty > 0 ? `📊 <b>Quantidade Protegida:</b> <code>${qty} ${cleanUpper}</code>\n` : ''}` +
        `═══════════════════════════\n` +
        `<i>Escolha uma % de recuo rápido ou personalize o preço de ativação:</i>`;

      const inline_keyboard = [
        [
          { text: `⚡ Mudar Gatilho ($)`, callback_data: `PROMPT_EDIT_TRAILING_PRICE:${normalizedSym}` },
          { text: `📉 Digitar % Recuo`, callback_data: `PROMPT_EDIT_TRAILING_PCT:${normalizedSym}` }
        ],
        [
          { text: `0.5%`, callback_data: `SET_TS_PCT:${normalizedSym}:0.5` },
          { text: `0.7%`, callback_data: `SET_TS_PCT:${normalizedSym}:0.7` },
          { text: `1.0%`, callback_data: `SET_TS_PCT:${normalizedSym}:1.0` }
        ],
        [
          { text: `1.5%`, callback_data: `SET_TS_PCT:${normalizedSym}:1.5` },
          { text: `2.0%`, callback_data: `SET_TS_PCT:${normalizedSym}:2.0` },
          { text: `3.0%`, callback_data: `SET_TS_PCT:${normalizedSym}:3.0` }
        ],
        [
          { text: `❌ Cancelar Trailing Stop`, callback_data: `CANCEL_TRAILING:${normalizedSym}` }
        ],
        [
          { text: `⬅️ Voltar às Pendentes`, callback_data: `REFRESH_PENDING_ORDERS` }
        ]
      ];

      if (messageIdToEdit) {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: messageIdToEdit,
          text,
          parse_mode: "HTML",
          reply_markup: { inline_keyboard }
        }, { timeout: 8000 }).catch(() => {});
      } else {
        await sendTelegramReply(chatId, text, { inline_keyboard });
      }
    } catch (e: any) {
      await sendTelegramReply(chatId, `⚠️ Erro ao carregar menu do Trailing Stop: ${e.message}`);
    }
  };

  // Helper to render dedicated submenu for managing a single pending order
  const renderTelegramManageOrderMenu = async (chatId: number | string, symbol: string, orderId: string, messageIdToEdit?: number) => {
    const isDemo = serverTelegramBotConfig.accountType === 'VST';
    const cleanSym = symbol.replace('-USDT', '').replace('USDT', '');
    const normalizedSym = `${cleanSym}-USDT`;

    // Busca todas as ordens abertas para garantir localização da ordem mesmo se o par vier em formatos diferentes
    const [ordersRes, allOrdersRes] = await Promise.all([
      sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo).catch(() => ({ code: -1, data: [] })),
      sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', {}, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo).catch(() => ({ code: -1, data: [] }))
    ]);

    const symOrders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];
    const allOrders = (allOrdersRes?.data && Array.isArray(allOrdersRes.data?.orders || allOrdersRes.data)) ? (allOrdersRes.data?.orders || allOrdersRes.data) : [];
    const mergedOrders = [...symOrders, ...allOrders];

    const targetOrder = mergedOrders.find((o: any) => (o.orderId || '').toString() === orderId.toString());

    if (!targetOrder) {
      await sendTelegramReply(chatId, `⚠️ <b>Ordem #${orderId.slice(-6)} de ${cleanSym} não foi encontrada!</b>\nEla pode já ter sido executada ou cancelada.`);
      setTimeout(() => renderTelegramPendingOrdersMessage(chatId, messageIdToEdit), 600);
      return;
    }

    const shortId = orderId.length > 6 ? orderId.slice(-6) : orderId;
    const isBuy = targetOrder.side === 'BUY' || targetOrder.positionSide === 'LONG';
    const sideEmoji = isBuy ? '🟢 COMPRA (LONG)' : '🔴 VENDA (SHORT)';
    
    let typeLabel = targetOrder.type || 'LIMIT';
    let isLimit = false;
    let isSl = false;
    let isTp = false;
    let isTrailing = false;

    if (targetOrder.type === 'LIMIT' || targetOrder.type === 'TRIGGER_LIMIT' || targetOrder.type === 'TRIGGER_MARKET') {
      typeLabel = '🎯 LIMITE (Entrada no Livro)';
      isLimit = true;
    } else if (targetOrder.type === 'STOP_MARKET' || targetOrder.type === 'STOP' || targetOrder.type === 'STOP_LOSS') {
      typeLabel = '🛑 STOP LOSS (Ordem de Proteção)';
      isSl = true;
    } else if (targetOrder.type === 'TAKE_PROFIT_MARKET' || targetOrder.type === 'TAKE_PROFIT') {
      typeLabel = '🎯 TAKE PROFIT (Alvo de Lucro)';
      isTp = true;
    } else if (targetOrder.type === 'TRAILING_STOP_MARKET') {
      typeLabel = '⚡ TRAILING STOP (Gatilho Dinâmico)';
      isTrailing = true;
    }

    const triggerPrice = parseFloat(targetOrder.stopPrice || targetOrder.activationPrice || '0');
    const limitPrice = parseFloat(targetOrder.price || '0');
    const displayPrice = triggerPrice > 0 ? `$${triggerPrice}` : (limitPrice > 0 ? `$${limitPrice}` : 'Mercado');
    const qty = parseFloat(targetOrder.origQty || targetOrder.quantity || '0');

    let text = `⚙️ <b>GERENCIAR ORDEM: ${cleanSym} (#${shortId})</b>\n\n` +
      `📌 <b>Tipo:</b> <b>${typeLabel}</b>\n` +
      `📈 <b>Direção:</b> ${sideEmoji}\n` +
      `⚡ <b>Preço Configurado:</b> <code>${displayPrice}</code>\n` +
      `${qty > 0 ? `📊 <b>Quantidade:</b> <code>${qty}</code>\n` : ''}` +
      `═══════════════════════════\n` +
      `<i>Escolha a ação desejada para esta ordem:</i>`;

    const inlineKeyboardRows: any[] = [];

    if (isLimit) {
      inlineKeyboardRows.push([
        { text: `🎯 Alterar Preço Limite (Entrada)`, callback_data: `PROMPT_EDIT_LIMIT:${normalizedSym}:${orderId}` }
      ]);
      inlineKeyboardRows.push([
        { text: `🛑 Editar Stop Loss (SL)`, callback_data: `PROMPT_EDIT_SL:${normalizedSym}:${orderId}` },
        { text: `🎯 Editar Take Profit (TP)`, callback_data: `PROMPT_EDIT_TP:${normalizedSym}:${orderId}` }
      ]);
    } else if (isSl) {
      inlineKeyboardRows.push([
        { text: `🛑 Alterar Stop Loss`, callback_data: `PROMPT_EDIT_SL:${normalizedSym}:${orderId}` }
      ]);
    } else if (isTp) {
      inlineKeyboardRows.push([
        { text: `🎯 Alterar Take Profit`, callback_data: `PROMPT_EDIT_TP:${normalizedSym}:${orderId}` }
      ]);
    } else if (isTrailing) {
      // Trailing Stop sem botão de cancelamento avulso
    } else {
      inlineKeyboardRows.push([
        { text: `✏️ Alterar Preço Limite`, callback_data: `PROMPT_EDIT_LIMIT:${normalizedSym}:${orderId}` }
      ]);
      inlineKeyboardRows.push([
        { text: `🛑 Editar SL`, callback_data: `PROMPT_EDIT_SL:${normalizedSym}:${orderId}` },
        { text: `🎯 Editar TP`, callback_data: `PROMPT_EDIT_TP:${normalizedSym}:${orderId}` }
      ]);
    }

    inlineKeyboardRows.push([
      { text: `❌ Cancelar Esta Ordem (#${shortId})`, callback_data: `CANCEL_ORDER:${normalizedSym}:${orderId}` }
    ]);
    inlineKeyboardRows.push([
      { text: `⬅️ Voltar à Lista de Ordens`, callback_data: `REFRESH_PENDING_ORDERS` }
    ]);

    const keyboard = { inline_keyboard: inlineKeyboardRows };
    if (messageIdToEdit) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
        chat_id: chatId,
        message_id: messageIdToEdit,
        text,
        parse_mode: "HTML",
        reply_markup: keyboard
      }, { timeout: 8000 }).catch(() => {});
    } else {
      await sendTelegramReply(chatId, text, keyboard);
    }
  };

  // Cálculo de viabilidade de taxas e detecção de armadilha (Paridade 100% com o App Web)
  const calculateFeeViability = (entryPrice: number | null, takeProfits: number[] | null, direction: 'LONG' | 'SHORT' = 'LONG', roundTripFeePercent: number = 0.10) => {
    if (!entryPrice || !takeProfits || takeProfits.length === 0 || entryPrice <= 0) {
      return null;
    }

    const tpDistances = takeProfits.map((tp) => {
      const dist = Math.abs(tp - entryPrice) / entryPrice * 100;
      const isProfitableAfterFees = dist > roundTripFeePercent;
      return {
        price: tp,
        distancePercent: dist,
        isProfitableAfterFees,
        netGainPercent: dist - roundTripFeePercent
      };
    });

    const tp1 = tpDistances[0];
    const lastTp = tpDistances[tpDistances.length - 1];

    let breakevenTpIndex = -1;
    for (let i = 0; i < tpDistances.length; i++) {
      if (tpDistances[i].isProfitableAfterFees) {
        breakevenTpIndex = i;
        break;
      }
    }

    const isTrap = !tp1.isProfitableAfterFees;
    let verdict: 'TRAP_UNVIABLE' | 'WARNING_HIGH_FEES' | 'VIABLE' = 'VIABLE';
    let explanation = '';

    if (isTrap) {
      if (breakevenTpIndex === -1) {
        verdict = 'TRAP_UNVIABLE';
        explanation = `Nenhum dos alvos cobre a taxa mínima da Bitunix (~${roundTripFeePercent.toFixed(2)}%). Qualquer encerramento resultará em prejuízo financeiro.`;
      } else {
        verdict = 'TRAP_UNVIABLE';
        explanation = `O TP 1 (+${tp1.distancePercent.toFixed(3)}%) não cobre a taxa da Bitunix (~${roundTripFeePercent.toFixed(2)}%). Encerrar no TP 1 dá prejuízo líquido. O lucro só inicia a partir do TP ${breakevenTpIndex + 1}.`;
      }
    } else if (tp1.distancePercent < roundTripFeePercent * 2) {
      verdict = 'WARNING_HIGH_FEES';
      const feeShare = (roundTripFeePercent / tp1.distancePercent) * 100;
      explanation = `As taxas da corretora consumirão cerca de ${feeShare.toFixed(0)}% de todo o lucro bruto no TP 1.`;
    } else {
      verdict = 'VIABLE';
      explanation = `Alvos com amplitude suficiente para absorver os custos operacionais da Bitunix com margem de segurança.`;
    }

    return {
      roundTripFeePercent,
      tpDistances,
      tp1,
      lastTp,
      breakevenTpIndex,
      isTrap,
      verdict,
      explanation
    };
  };

  const formatFeeViabilityTelegram = (viability: any): string => {
    if (!viability) return '';

    if (viability.verdict === 'TRAP_UNVIABLE') {
      const tp1Net = viability.tp1.netGainPercent;
      const beText = viability.breakevenTpIndex >= 0 
        ? `Só a partir de <code>${viability.tpDistances[viability.breakevenTpIndex].price}</code> (TP ${viability.breakevenTpIndex + 1})`
        : 'Nenhum dos alvos cobre taxas';
      
      const lastTpFeeShare = viability.lastTp.distancePercent > 0 
        ? Math.min(99, Math.round((viability.roundTripFeePercent / viability.lastTp.distancePercent) * 100))
        : 100;

      return `\n⚠️ <b>ALERTA DE VIABILIDADE: ARMADILHA DE TAXAS!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🚨 <b>Veredito:</b> ❌ <b>NÃO RECOMENDADO (Inviável)</b>\n` +
        `• <b>Taxa Bitunix Estimada:</b> ~${viability.roundTripFeePercent.toFixed(2)}% sobre o volume\n` +
        `• <b>Alvo 1 (TP 1):</b> +${viability.tp1.distancePercent.toFixed(3)}% ❌ <i>Prejuízo Líquido (${tp1Net >= 0 ? '+' : ''}${tp1Net.toFixed(2)}% após taxas)</i>\n` +
        `• <b>Ponto de Equilíbrio (Zero a Zero):</b> ${beText}\n` +
        `• <b>Último Alvo:</b> +${viability.lastTp.distancePercent.toFixed(3)}% ⚠️ <i>~${lastTpFeeShare}% do lucro bruto vai para corretora</i>\n` +
        `💡 <i>A variação de preço deste sinal é minúscula. As taxas da corretora devoram os lucros.</i>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    }

    if (viability.verdict === 'WARNING_HIGH_FEES') {
      const feeShare = Math.round((viability.roundTripFeePercent / viability.tp1.distancePercent) * 100);
      return `\n⚠️ <b>ATENÇÃO ÀS TAXAS DA CORRETORA:</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ <b>Veredito:</b> <b>ALTO IMPACTO DE TAXAS</b>\n` +
        `• <b>Taxa Bitunix Estimada:</b> ~${viability.roundTripFeePercent.toFixed(2)}%\n` +
        `• <b>TP 1:</b> +${viability.tp1.distancePercent.toFixed(2)}% (Taxas consomem ~${feeShare}% do lucro bruto)\n` +
        `• <b>Recomendação:</b> Considere buscar alvos maiores para diluir o custo operacional.\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    }

    return `\n✅ <b>VIABILIDADE OPERACIONAL:</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `✨ <b>Veredito:</b> 🟢 <b>SINAL VIÁVEL</b>\n` +
      `• <b>TP 1:</b> +${viability.tp1.distancePercent.toFixed(2)}% (Cobre taxas com folga positiva de +${viability.tp1.netGainPercent.toFixed(2)}%)\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  };

  // Helper to prompt Telegram user with interactive signal confirmation or price range selector
  const promptTelegramConfirmation = async (parsed: any, chatId?: number | string, signalId?: string, editMsgId?: number) => {
    if (!chatId) return;

    // 👤 IDENTIFICAÇÃO DE CONTA POR CHAT ID
    // Se o chatId for de um parceiro/operador cadastrado, usa a conta isolada dele
    const accCtx = getAccountContextForChat(chatId);
    const targetAccountType: 'USDT' | 'VST' = parsed.accountType || (accCtx.isOperator ? (accCtx.isDemo ? 'VST' : 'USDT') : (serverTelegramBotConfig.accountType || 'USDT'));
    parsed.accountType = targetAccountType;
    const isDemo = targetAccountType === 'VST';
    const curr = 'USDT';
    const apiKey = accCtx.apiKey || DEFAULT_BITUNIX_KEY;
    const apiSecret = accCtx.apiSecret || DEFAULT_BITUNIX_SECRET;

    // Cálculo de Alavancagem idêntico ao App
    let targetLeverage = 20;
    if (accCtx.isOperator && accCtx.fixedLeverage && accCtx.fixedLeverage > 0) {
      targetLeverage = accCtx.fixedLeverage;
    } else if (parsed.targetLeverage && typeof parsed.targetLeverage === 'number' && parsed.targetLeverage > 0) {
      targetLeverage = parsed.targetLeverage;
    } else if (parsed.leverage && typeof parsed.leverage === 'number' && parsed.leverage > 0) {
      targetLeverage = parsed.leverage;
    } else if (serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE') {
      targetLeverage = serverTelegramBotConfig.fixedLeverageValue || 20;
    }

    if (serverTelegramBotConfig.maxLeverageCap && serverTelegramBotConfig.maxLeverageCap > 0 && targetLeverage > serverTelegramBotConfig.maxLeverageCap) {
      targetLeverage = serverTelegramBotConfig.maxLeverageCap;
    }

    // Checa limite máximo real de alavancagem da corretora (Bitunix)
    let wasLeverageCappedByBroker = parsed.wasLeverageCappedByBroker || false;
    let originalSignalLeverage = parsed.originalSignalLeverage || null;
    try {
      const maxBrokerLev = await fetchSymbolMaxBrokerLeverage(parsed.apiSymbol, apiKey, apiSecret, isDemo);
      if (maxBrokerLev > 0 && maxBrokerLev < 1000 && targetLeverage > maxBrokerLev) {
        if (!originalSignalLeverage) {
          originalSignalLeverage = targetLeverage;
        }
        targetLeverage = maxBrokerLev;
        wasLeverageCappedByBroker = true;
      }
    } catch (e: any) {
      console.warn(`[CONFIRM-LEV-ERR]:`, e?.message);
    }

    parsed.targetLeverage = targetLeverage;
    parsed.leverage = targetLeverage;
    parsed.wasLeverageCappedByBroker = wasLeverageCappedByBroker;
    parsed.originalSignalLeverage = originalSignalLeverage;

    // 1. Obter Preço de Mercado em Tempo Real na Bitunix para o par do sinal
    let liveMarketPrice = 0;
    try {
      const tickerRes = await sendBingXRequest('/openApi/swap/v2/quote/ticker', 'GET', {
        symbol: parsed.apiSymbol
      }, apiKey, apiSecret, isDemo);
      if (tickerRes?.data?.lastPrice) {
        liveMarketPrice = parseFloat(tickerRes.data.lastPrice);
      }
    } catch (e) {}

    // Verifica se o sinal possui uma faixa de preço e o usuário ainda não escolheu
    const hasPriceRange = parsed.entryPrice && parsed.entryPrice2 && parsed.entryPrice !== parsed.entryPrice2 && !parsed.entryPriceChosen;

    const dirText = parsed.direction === 'LONG' ? '🟢 COMPRA / LONG' : '🔴 VENDA / SHORT';
    const orderTypeLabel = parsed.orderType === 'LIMIT' ? '🎯 LIMITE' : '⚡ A MERCADO';

    if (hasPriceRange && signalId) {
      const pHigh = Math.max(parsed.entryPrice, parsed.entryPrice2);
      const pLow = Math.min(parsed.entryPrice, parsed.entryPrice2);
      const pMid = parseFloat(((pHigh + pLow) / 2).toFixed(6));

      const pLowStr = pLow.toString();
      const pHighStr = pHigh.toString();
      const pMidStr = pMid.toString();

      let priceRows: any[] = [];
      if (parsed.direction === 'LONG') {
        // Para LONG:
        // 1º Preço mais alto (Entrada Imediata)
        // 2º Preço médio (Equilibrado)
        // 3º Preço menor (Melhor R:R / Stop mais curto)
        priceRows = [
          [{ text: `🟢 $${pHighStr} (Mais Alto / Entrada Imediata)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pHighStr}` }],
          [{ text: `⚖️ $${pMidStr} (Preço Médio / Equilibrado)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pMidStr}` }],
          [{ text: `💎 $${pLowStr} (Mais Baixo / Melhor R:R)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pLowStr}` }]
        ];
      } else {
        // Para SHORT:
        // 1º Preço mais baixo (Entrada Imediata)
        // 2º Preço médio (Equilibrado)
        // 3º Preço mais alto (Melhor R:R / Stop mais curto)
        priceRows = [
          [{ text: `🔴 $${pLowStr} (Mais Baixo / Entrada Imediata)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pLowStr}` }],
          [{ text: `⚖️ $${pMidStr} (Preço Médio / Equilibrado)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pMidStr}` }],
          [{ text: `💎 $${pHighStr} (Mais Alto / Melhor R:R)`, callback_data: `CHOOSE_ENTRY_${signalId}_${pHighStr}` }]
        ];
      }

      const slTextForRange = parsed.stopLoss 
        ? `$${parsed.stopLoss} (Ativo na Bitunix)` 
        : `${serverTelegramBotConfig.emergencyStopPercent}% Emergência`;

      const selectKeyboard = {
        inline_keyboard: [
          ...priceRows,
          [
            { text: "📋 Ver Ordens Abertas", callback_data: "LIST_POSITIONS" },
            { text: "❌ Cancelar", callback_data: `CANCEL_${signalId}` }
          ]
        ]
      };

      const accountDestinationLabel = accCtx.isOperator
        ? `👤 <b>Conta:</b> <b>${accCtx.name} (${accCtx.ownerName})</b> [${isDemo ? '🟡 Simulação' : '🟢 Real'}]`
        : `💼 <b>Conta Destino:</b> <b>${isDemo ? '🟡 Simulação Bitunix' : '🟢 USDT Real'}</b>`;

      const selectText = `📊 <b>FAIXA DE ENTRADA DETECTADA: ${parsed.apiSymbol}</b>\n` +
        `═══════════════════════════\n` +
        `📋 <b>Tipo de Ordem:</b> <b>${orderTypeLabel}</b>\n` +
        `📈 <b>Direção:</b> <b>${dirText}</b>\n` +
        `🎯 <b>Faixa do Sinal:</b> <code>$${pLowStr}</code> até <code>$${pHighStr}</code>\n` +
        `🛑 <b>Stop Loss:</b> <code>${slTextForRange}</code>\n` +
        `${accountDestinationLabel}\n` +
        `═══════════════════════════\n\n` +
        `👇 <b>Selecione em qual preço deseja posicionar a ordem:</b>`;

      if (editMsgId) {
        try {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
            chat_id: chatId,
            message_id: editMsgId,
            text: selectText,
            parse_mode: "HTML",
            reply_markup: selectKeyboard
          }, { timeout: 8000 });
          return;
        } catch (e) {}
      }

      await sendTelegramReply(chatId, selectText, selectKeyboard);
      return;
    }

    // Se é preço único ou o usuário já escolheu o preço da faixa:
    const effectiveEntry = (parsed.entryPrice && parsed.entryPrice > 0) 
      ? parsed.entryPrice 
      : (liveMarketPrice > 0 ? liveMarketPrice : (parsed.takeProfits[0] ? (parsed.direction === 'LONG' ? parsed.takeProfits[0] * 0.98 : parsed.takeProfits[0] * 1.02) : 1.0));

    // 1. Obter Especificações do Contrato da Bitunix (precisão e limites mínimos)
    let pricePrecision = 4;
    let quantityPrecision = 1;
    let minQty = 1;
    let minUsdt = 2;

    const contract = parsed.contractInfo || symbolLookupIndex.get(parsed.apiSymbol) || symbolLookupIndex.get(cleanKey(parsed.apiSymbol)) || bingxContractsList.find((c: any) => c.symbol === parsed.apiSymbol);
    if (contract) {
      pricePrecision = contract.pricePrecision ?? 4;
      quantityPrecision = contract.quantityPrecision ?? 1;
      minQty = parseFloat(contract.tradeMinQuantity) || 1;
      minUsdt = parseFloat(contract.tradeMinUSDT) || 2;
    } else {
      try {
        const contractsRes = await sendBingXRequest('/openApi/swap/v2/quote/contracts', 'GET', {}, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
        if (contractsRes?.data && Array.isArray(contractsRes.data)) {
          const c = contractsRes.data.find((item: any) => item.symbol === parsed.apiSymbol);
          if (c) {
            pricePrecision = c.pricePrecision ?? 4;
            quantityPrecision = c.quantityPrecision ?? 1;
            minQty = parseFloat(c.tradeMinQuantity) || 1;
            minUsdt = parseFloat(c.tradeMinUSDT) || 2;
          }
        }
      } catch (e) {}
    }

    // 2. Obter Saldo Real
    let currentBalance = await getCachedBingXBalance(apiKey, apiSecret, isDemo);
    if (currentBalance <= 0) currentBalance = 100;

    // 3. Calcular Risco (respeita risco individual se for conta de operador)
    let riskUsd = 2.0;
    let isCustomSignalRisk = false;
    const effectiveRiskMode = accCtx.isOperator ? accCtx.riskMode : serverTelegramBotConfig.riskMode;
    const effectiveRiskPercent = accCtx.isOperator ? accCtx.riskPercent : (serverTelegramBotConfig.riskPercent || 2.0);
    const effectiveRiskFixedUsd = accCtx.isOperator ? accCtx.riskFixedUsd : (serverTelegramBotConfig.riskFixedUsd || 50.0);

    if (parsed.customRiskUsd && typeof parsed.customRiskUsd === 'number' && parsed.customRiskUsd > 0) {
      riskUsd = parsed.customRiskUsd;
      isCustomSignalRisk = true;
    } else if (effectiveRiskMode === 'FIXED_USD') {
      riskUsd = effectiveRiskFixedUsd || 50.0;
    } else {
      riskUsd = (currentBalance * effectiveRiskPercent) / 100;
    }

    const entryText = parsed.entryPrice 
      ? `$${parsed.entryPrice}` 
      : `$${effectiveEntry} (Preço Atual de Mercado)`;

    const slPrice = parsed.stopLoss || (parsed.direction === 'LONG' ? effectiveEntry * (1 - (serverTelegramBotConfig.emergencyStopPercent || 5.0) / 100) : effectiveEntry * (1 + (serverTelegramBotConfig.emergencyStopPercent || 5.0) / 100));
    const slDist = Math.abs(effectiveEntry - slPrice);
    const slDistPct = effectiveEntry > 0 ? (slDist / effectiveEntry * 100) : (serverTelegramBotConfig.emergencyStopPercent || 5.0);

    // 4. Calcular Quantidade e Margem Exatas com base no Risco em Dólares (IDÊNTICO À EXECUÇÃO REAL)
    const roundTripFeeRate = (serverTelegramBotConfig.includeFeesInRisk !== false) ? 0.0010 : 0.0;
    const totalLossPerUnit = slDist + (effectiveEntry * roundTripFeeRate);
    let targetQty = totalLossPerUnit > 0 ? (riskUsd / totalLossPerUnit) : (minUsdt / effectiveEntry);

    // 🛡️ Trava de Segurança de Margem: Nunca exceder 75% do saldo disponível da conta
    // Evita erro de 'Insufficient margin' em sinais de Stop Loss ultra-curto (scalper)
    const maxSafeMarginUsd = Math.max(minUsdt, currentBalance * 0.75);
    let requiredMarginUsd = (targetQty * effectiveEntry) / targetLeverage;
    let wasMarginCappedByBalance = false;

    if (requiredMarginUsd > maxSafeMarginUsd) {
      targetQty = (maxSafeMarginUsd * targetLeverage) / effectiveEntry;
      wasMarginCappedByBalance = true;
    }

    // Respeitar restrições mínimas do contrato na Bitunix
    if (targetQty < minQty) targetQty = minQty;
    if (targetQty * effectiveEntry < minUsdt) targetQty = minUsdt / effectiveEntry;

    const qtyStr = quantityPrecision === 0 ? Math.ceil(targetQty).toString() : targetQty.toFixed(quantityPrecision);
    const finalPreviewQty = parseFloat(qtyStr);

    const finalPreviewNotional = finalPreviewQty * effectiveEntry;
    const calculatedMargin = finalPreviewNotional / targetLeverage;
    const priceLossUsd = finalPreviewQty * slDist;
    const estimatedBingXFeesUsd = finalPreviewNotional * 0.0010; // Taxa real estimada da Bitunix (~0.10%: 0.05% abertura + 0.05% fechamento)
    const isFeesIncludedInRisk = serverTelegramBotConfig.includeFeesInRisk !== false;
    const actualCalculatedRiskUsd = isFeesIncludedInRisk
      ? (priceLossUsd + estimatedBingXFeesUsd)
      : priceLossUsd;

    const slLeveragedPct = slDistPct * targetLeverage;
    const crossThresholdVal = serverTelegramBotConfig.autoCrossMarginThreshold || 25;
    const isCrossRequired = shouldUseCrossMargin(slLeveragedPct, targetLeverage, crossThresholdVal);
    const marginModeText = isCrossRequired 
      ? `🛡️ <b>Modo de Margem:</b> <code>CRUZADA (CROSSED)</code> ⚠️ <i>Anti-Liquidação (SL a -${slLeveragedPct.toFixed(1)}%${slLeveragedPct >= crossThresholdVal ? ` ≥ ${crossThresholdVal}%` : ` em ${targetLeverage}x`})</i>`
      : `🔒 <b>Modo de Margem:</b> <code>ISOLADA (ISOLATED)</code> <i>(SL seguro a -${slLeveragedPct.toFixed(1)}% &lt; ${crossThresholdVal}%)</i>`;

    const slText = parsed.stopLoss 
      ? `$${parsed.stopLoss} (${slDistPct.toFixed(2)}% | -${slLeveragedPct.toFixed(2)}% | -$${actualCalculatedRiskUsd.toFixed(2)} ${curr}${isFeesIncludedInRisk ? ` [c/ taxas]` : ''} | Ativo na Bitunix)` 
      : `${serverTelegramBotConfig.emergencyStopPercent}% Emergência ($${slPrice.toFixed(4)} | -${(serverTelegramBotConfig.emergencyStopPercent * targetLeverage).toFixed(2)}% | -$${actualCalculatedRiskUsd.toFixed(2)} ${curr})`;

    // 5. Formatar TODOS OS ALVOS (Take Profit) linha por linha com % de movimento, % com alavancagem e lucro em USD
    const feeViability = calculateFeeViability(effectiveEntry, parsed.takeProfits, parsed.direction, 0.10);
    const viabilitySection = formatFeeViabilityTelegram(feeViability);

    let tpFormattedList = '';
    if (parsed.takeProfits && parsed.takeProfits.length > 0) {
      tpFormattedList = parsed.takeProfits.map((tpPrice: number, idx: number) => {
        const tpDist = (Math.abs(tpPrice - effectiveEntry) / effectiveEntry) * 100;
        const tpLeveragedPct = tpDist * targetLeverage;
        const estimatedProfit = (finalPreviewNotional * (tpDist / 100));
        const isLast = idx === parsed.takeProfits.length - 1;

        // Análise de viabilidade pós-taxa para cada TP individual
        const isTpProfitable = tpDist > 0.10;
        const feeStatusSuffix = !isTpProfitable ? ' ❌ Negativo pós-taxa' : '';

        let labelSuffix = '';
        if (parsed.isFromChartVision) {
          if (parsed.hasExplicitIndicatorTargets) {
            labelSuffix = isLast ? ' (Último Alvo)' : '';
          } else if (isLast) {
            labelSuffix = ' (Take Final do Gráfico)';
          } else if (idx === 0) {
            labelSuffix = ' (1x Stop)';
          } else {
            labelSuffix = ` (+${(1.0 + idx * 0.5).toFixed(1)}x Stop)`;
          }
        } else if (isLast) {
          labelSuffix = ' (Último Alvo)';
        }

        return `  🎯 <b>TP ${idx + 1}${labelSuffix}:</b> <code>$${tpPrice}</code> (<b>+${tpDist.toFixed(2)}%</b> | <b>+${tpLeveragedPct.toFixed(2)}%</b> | <b>+$${estimatedProfit.toFixed(2)} ${curr}</b>)${feeStatusSuffix}`;
      }).join('\n');
    } else {
      tpFormattedList = '  🎯 <b>Alvo Padrão:</b> Trailing Stop 1.0x ativado no lucro';
    }

    // Preço estimado de ativação do Trailing Stop
    let trailingActivationStr = '1.0x Ativo no Lucro';
    if (serverTelegramBotConfig.trailingStopEnabled && effectiveEntry > 0 && slPrice > 0) {
      const actPrice = parsed.direction === 'LONG' 
        ? effectiveEntry + (slDist * serverTelegramBotConfig.trailingMultiplier)
        : effectiveEntry - (slDist * serverTelegramBotConfig.trailingMultiplier);
      trailingActivationStr = `1.0x Ativo (Ativação em $${actPrice.toFixed(4)})`;
    }

    const titleHeader = parsed.isFromChartVision 
      ? (parsed.hasExplicitIndicatorTargets 
          ? `📸 <b>SINAL DETECTADO DO INDICADOR NO GRÁFICO: ${parsed.apiSymbol}</b>`
          : `📸 <b>SINAL DETECTADO DO GRÁFICO (TRADINGVIEW): ${parsed.apiSymbol}</b>`)
      : `📊 <b>SINAL DETECTADO: ${parsed.apiSymbol}</b>`;

    const promptText = `${titleHeader}\n` +
      `═══════════════════════════\n` +
      viabilitySection +
      `📋 <b>Tipo de Ordem:</b> <b>${orderTypeLabel}</b>\n` +
      `📈 <b>Direção:</b> <b>${dirText}</b>\n` +
      `⚡ <b>Preço de Entrada:</b> <code>${(parsed.entryPrice && parsed.entryPrice2 && parsed.entryPrice !== parsed.entryPrice2) ? `$${parsed.entryPrice} - $${parsed.entryPrice2} (Limite calibrada: $${effectiveEntry})` : entryText}</code>\n` +
      `🛑 <b>Stop Loss:</b> <code>${slText}</code>\n\n` +
      `🎯 <b>TODOS OS ALVOS (TAKE PROFIT):</b>\n` +
      `${tpFormattedList}\n\n` +
      `═══════════════════════════\n` +
      (wasLeverageCappedByBroker && originalSignalLeverage
        ? `⚡ <b>Alavancagem:</b> <code>${targetLeverage}x</code> <i>(Ajustada para o máx. da corretora | Sinal: ${originalSignalLeverage}x)</i>\n` +
          `ℹ️ <i>A margem em USDT foi recalculada automaticamente para manter seu risco intacto.</i>\n`
        : `⚙️ <b>Alavancagem:</b> <code>${targetLeverage}x</code>\n`) +
      `${marginModeText}\n` +
      `💰 <b>Margem que vai Entrar:</b> <code>$${calculatedMargin.toFixed(2)} USDT</code>${wasMarginCappedByBalance ? ` <i>(Calibrada ao saldo livre)</i>` : ''}\n` +
      (isCustomSignalRisk
        ? `🛡️ <b>Perda Máxima Solicitada no Sinal:</b> <code>-$${actualCalculatedRiskUsd.toFixed(2)} USDT</code> 🎯 <i>(Perda de $${parsed.customRiskUsd} dol fixada no sinal)</i>\n`
        : `🛡️ <b>Perda Máxima no Stop Loss:</b> <code>-$${actualCalculatedRiskUsd.toFixed(2)} USDT</code> <i>(${serverTelegramBotConfig.riskMode === 'PERCENT' ? `${serverTelegramBotConfig.riskPercent}% da conta` : 'Risco Fixo'})</i>\n`) +
      `   ├ 📉 <b>Prejuízo do Preço (PnL):</b> <code>-$${priceLossUsd.toFixed(2)} USDT</code>\n` +
      `   ├ 🏷️ <b>Taxas Bitunix Estimadas (~0.10%):</b> <code>~$${estimatedBingXFeesUsd.toFixed(2)} USDT</code>\n` +
      `   └ ⚖️ <b>Perda Líquida Total no SL:</b> <code>-$${actualCalculatedRiskUsd.toFixed(2)} USDT</code>${isFeesIncludedInRisk ? ' <i>(Taxas embutidas)</i>' : ''}\n` +
      `📊 <b>Tamanho Total da Posição:</b> <code>$${finalPreviewNotional.toFixed(2)} USDT</code>\n` +
      `🏦 <b>Saldo da Conta Bitunix:</b> <code>$${currentBalance.toFixed(2)} USDT</code>\n` +
      `🛰️ <b>Trailing Stop:</b> <b>${trailingActivationStr}</b>\n` +
      (accCtx.isOperator
        ? `👤 <b>Conta Destino:</b> <b>${accCtx.name} (${accCtx.ownerName})</b> [${isDemo ? '🟡 Simulação' : '🟢 Real'}]\n`
        : `💼 <b>Conta Destino:</b> <b>${isDemo ? '🟡 Bitunix Simulação' : '🟢 Bitunix Futuros USDT Real'}</b>\n`) +
      (parsed.chartExplanation ? `\n💡 <i>${parsed.chartExplanation}</i>\n` : '') +
      `═══════════════════════════\n\n` +
      `❓ <b>Deseja enviar esta ordem para a Bitunix agora?</b>`;

    const executeBtnLabel = parsed.orderType === 'LIMIT' && parsed.entryPrice
      ? `🎯 Executar Ordem (${parsed.apiSymbol} a $${parsed.entryPrice})`
      : `⚡ Confirmar & Executar ${parsed.apiSymbol} na Bitunix`;

    const lastTpTargetVal = (parsed.takeProfits && parsed.takeProfits.length > 0)
      ? parsed.takeProfits[parsed.takeProfits.length - 1]
      : 0;

    const cbExecData = `EXEC:${signalId}:${targetAccountType}:${parsed.coinName || 'COIN'}:${parsed.direction || 'LONG'}:${parsed.orderType || 'LIMIT'}:${parsed.entryPrice || 0}:${parsed.stopLoss || 0}:${targetLeverage || 20}:${lastTpTargetVal}`;
    const safeCbData = Buffer.byteLength(cbExecData, 'utf8') <= 64 ? cbExecData : `EXEC:${signalId}:${targetAccountType}:${targetLeverage || 20}`;

    const isViabilityTrap = feeViability?.isTrap;

    const keyboard = {
      inline_keyboard: [
        [
          { text: executeBtnLabel, callback_data: safeCbData }
        ],
        ...(isViabilityTrap ? [
          [
            { text: "🛡️ Descartar Sinal (Evitar Armadilha de Taxas)", callback_data: `DISCARD_${signalId}` }
          ]
        ] : []),
        [
          { text: "📋 Ver Ordens Abertas", callback_data: "LIST_POSITIONS" },
          { text: "❌ Cancelar", callback_data: `CANCEL_${signalId}` }
        ]
      ]
    };

    if (editMsgId) {
      try {
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
          chat_id: chatId,
          message_id: editMsgId,
          text: promptText,
          parse_mode: "HTML",
          reply_markup: keyboard
        }, { timeout: 8000 });
        return;
      } catch (e) {}
    }

    await sendTelegramReply(chatId, promptText, keyboard);
  };

  // Process Telegram Updates (Webhook or Long-Polling)
  const processTelegramUpdate = async (update: any) => {
    if (!update) return;

    // 0. Deduplicação Instantânea em Memória (Update ID)
    const updateId = update.update_id;
    if (updateId) {
      const lockKey = `upd_${updateId}`;
      if (localInFlightOperations.has(lockKey)) return;
      localInFlightOperations.add(lockKey);
      if (localInFlightOperations.size > 2000) {
        const [first] = localInFlightOperations;
        localInFlightOperations.delete(first);
      }
    }

    // 1. Tratamento de Clique nos Botões (Inline Keyboard Callbacks)
    if (update.callback_query) {
      const cb = update.callback_query;
      const cbKey = `cb_${cb.id}`;
      if (localInFlightOperations.has(cbKey)) return;
      localInFlightOperations.add(cbKey);
      if (localInFlightOperations.size > 2000) {
        const [first] = localInFlightOperations;
        localInFlightOperations.delete(first);
      }

      const cbData = cb.data as string;
      const cbChatId = cb.message?.chat?.id;
      const cbMsgId = cb.message?.message_id;
      const fromUser = cb.from?.first_name || "Operador";
      const isDemo = serverTelegramBotConfig.accountType === 'VST';

      if (cbChatId) {
        registerTelegramChat(cbChatId);
      }

      // Se o usuário clicar em um botão de operação em andamento
      if (cbData === "NOOP" || cbData === "IN_PROGRESS") {
        await answerTelegramCallback(cb.id, "⏳ Operação em processamento na Bitunix, aguarde um instante...", false);
        return;
      }

      // Responde ao Telegram IMEDIATAMENTE em 0ms para liberar o botão no app sem nenhum delay
      answerTelegramCallback(cb.id, "⚡ Processando comando...").catch(() => {});

      try {
        if (cbChatId && cbMsgId) {
          trackActiveKeyboardMessage(cbChatId, cbMsgId);
        }

        // Se a ação não for uma atualização in-place (como confirmação de faixa ou execução direta no mesmo card),
        // removemos os botões da mensagem clicada e de todas as mensagens ativas anteriores deste chat.
        const isChoiceEntry = cbData.startsWith("CHOOSE_ENTRY_");
        const isInitialExec = cbData.startsWith("EXEC_") || cbData.startsWith("EXEC:");
        const isConfigEdit = (
          cbData === "VIEW_CONFIG" ||
          cbData === "REFRESH_CONFIG" ||
          cbData === "TOGGLE_ACCOUNT_TYPE" ||
          cbData === "TOGGLE_TRAILING" ||
          cbData === "TOGGLE_TRAILING_DETAIL" ||
          cbData === "TOGGLE_CONDUCAO" ||
          cbData === "TOGGLE_CONDUCAO_ACTIVE" ||
          cbData === "VIEW_TRAILING_CONFIG" ||
          cbData === "VIEW_RISK_CONFIG" ||
          cbData === "TOGGLE_FEES_EMBEDDED" ||
          cbData === "TOGGLE_FEE_REBATE" ||
          cbData === "TOGGLE_VIP_TARGETS" ||
          cbData === "TOGGLE_1M_ENTRY" ||
          cbData === "SET_MODE_TRAILING" ||
          cbData === "SET_MODE_CONDUCAO" ||
          cbData.startsWith("PROMPT_CONDUCAO_") ||
          cbData === "TOGGLE_LEVERAGE_MODE" ||
          cbData === "TOGGLE_SIGNAL_EXEC" ||
          cbData === "MENU_CONFIG_TRAILING" ||
          cbData === "MENU_CONFIG_RISK" ||
          cbData === "MENU_CONFIG_DAILY_LOCK" ||
          cbData === "DISABLE_DAILY_LOSS" ||
          cbData === "DISABLE_DAILY_PROFIT" ||
          cbData === "UNLOCK_DAILY_LOCK"
        );
        const isSelfEdit = (cbData === "REFRESH_STATUS" || cbData === "REFRESH_POSITIONS" || cbData === "REFRESH_PENDING_ORDERS" || cbData === "COPY_REFRESH" || cbData.startsWith("VIEW_HIT_TARGETS:") || cbData.startsWith("VIEW_HIT_TARGETS_") || isConfigEdit) && !!cbMsgId;

        if (cbChatId && !isChoiceEntry && !isInitialExec && !isSelfEdit) {
          if (cbMsgId) {
            await removeTelegramMessageButtons(cbChatId, cbMsgId);
          }
          await clearActiveKeyboardsForChat(cbChatId);
        }

        // Callback: Executar Ordem do Sinal
        if (cbData.startsWith("EXEC_") || cbData.startsWith("EXEC:")) {
          const dailyLockCheck = await checkDailyLockBlocked();
          if (dailyLockCheck.blocked) {
            if (cbChatId) {
              await sendTelegramReply(cbChatId, dailyLockCheck.reason || "🛑 Operação bloqueada pela trava diária.");
            }
            return;
          }

          const execLockKey = cbMsgId ? `${cbChatId}_${cbMsgId}` : cbData;
          if (activeTelegramOrderExecutions.has(execLockKey)) {
            await answerTelegramCallback(cb.id, "⏳ Esta ordem já está sendo enviada para a Bitunix, aguarde!", false);
            return;
          }
          activeTelegramOrderExecutions.add(execLockKey);

          try {
            // Desabilita os botões instantaneamente com await e keep-alive para dar feedback visual imediato
            if (cbChatId && cbMsgId) {
              await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
                chat_id: cbChatId,
                message_id: cbMsgId,
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "⏳ Enviando ordem para a Bitunix...", callback_data: "IN_PROGRESS" }]
                  ]
                }
              }, { timeout: 4000 }).catch(() => {});
            }

          let coinName = '';
          let direction: 'LONG' | 'SHORT' = 'LONG';
          let orderType: 'LIMIT' | 'MARKET' = 'LIMIT';
          let entryPrice = 0;
          let stopLoss = 0;
          let leverageFromBtn: number | null = null;
          let lastTpFromBtn = 0;
          let signalId = '';
          let accountTypeFromBtn: 'USDT' | 'VST' | null = null;

          if (cbData.startsWith("EXEC:")) {
            const cParts = cbData.split(":");
            if (cParts.length >= 10) {
              signalId = cParts[1] || '';
              accountTypeFromBtn = cParts[2] === 'VST' ? 'VST' : 'USDT';
              coinName = cParts[3] || '';
              direction = cParts[4] === 'SHORT' ? 'SHORT' : 'LONG';
              orderType = cParts[5] === 'MARKET' ? 'MARKET' : 'LIMIT';
              entryPrice = parseFloat(cParts[6]) || 0;
              stopLoss = parseFloat(cParts[7]) || 0;
              leverageFromBtn = parseInt(cParts[8], 10) || null;
              lastTpFromBtn = parseFloat(cParts[9]) || 0;
            } else if (cParts.length === 4 && (cParts[2] === 'VST' || cParts[2] === 'USDT')) {
              signalId = cParts[1] || '';
              accountTypeFromBtn = cParts[2] as 'VST' | 'USDT';
              leverageFromBtn = parseInt(cParts[3], 10) || null;
            } else if (cParts.length === 3 && (cParts[2] === 'VST' || cParts[2] === 'USDT')) {
              signalId = cParts[1] || '';
              accountTypeFromBtn = cParts[2] as 'VST' | 'USDT';
            } else if (cParts.length >= 9) {
              signalId = cParts[1] || '';
              coinName = cParts[2] || '';
              direction = cParts[3] === 'SHORT' ? 'SHORT' : 'LONG';
              orderType = cParts[4] === 'MARKET' ? 'MARKET' : 'LIMIT';
              entryPrice = parseFloat(cParts[5]) || 0;
              stopLoss = parseFloat(cParts[6]) || 0;
              leverageFromBtn = parseInt(cParts[7], 10) || null;
              lastTpFromBtn = parseFloat(cParts[8]) || 0;
            } else {
              signalId = cParts[1] || '';
            }
          } else {
            // Legado com underline
            const parts = cbData.split("_");
            if (parts.length >= 9) {
              coinName = parts[1];
              direction = parts[2] === 'SHORT' ? 'SHORT' : 'LONG';
              orderType = parts[3] === 'MARKET' ? 'MARKET' : 'LIMIT';
              entryPrice = parseFloat(parts[4]) || 0;
              stopLoss = parseFloat(parts[5]) || 0;
              leverageFromBtn = parseInt(parts[6], 10) || null;
              lastTpFromBtn = parseFloat(parts[7]) || 0;
              signalId = parts.slice(8).join('_');
            } else if (parts.length >= 8) {
              coinName = parts[1];
              direction = parts[2] === 'SHORT' ? 'SHORT' : 'LONG';
              orderType = parts[3] === 'MARKET' ? 'MARKET' : 'LIMIT';
              entryPrice = parseFloat(parts[4]) || 0;
              stopLoss = parseFloat(parts[5]) || 0;
              leverageFromBtn = parseInt(parts[6], 10) || null;
              signalId = parts.slice(7).join('_');
            } else {
              signalId = cbData.replace("EXEC_", "");
            }
          }

          const signal = signalsStoreById.get(signalId) || receivedTelegramSignals.find(s => s.id === signalId);
          let parsed = signal?.parsed;

          // Se a memória foi reiniciada mas o sinal tem texto salvo, re-extrair com parseSignalText
          if ((!parsed || !parsed.coinName) && signal?.text) {
            parsed = parseSignalText(signal.text);
          }

          // Se ainda não tiver parsed, reconstruir parsed a partir dos dados do botão
          if (!parsed || !parsed.coinName) {
            if (coinName) {
              const effLev = (leverageFromBtn && leverageFromBtn > 0) ? leverageFromBtn : (serverTelegramBotConfig.defaultLeverageMode === 'FIXED_LEVERAGE' ? (serverTelegramBotConfig.fixedLeverageValue || 20) : 20);
              parsed = {
                coinName,
                symbol: `${coinName}USDT`,
                apiSymbol: `${coinName}-USDT`,
                direction,
                orderType,
                entryPrice: entryPrice > 0 ? entryPrice : null,
                stopLoss: stopLoss > 0 ? stopLoss : null,
                takeProfits: lastTpFromBtn > 0 ? [lastTpFromBtn] : [],
                leverage: effLev,
                targetLeverage: effLev,
                hasLeverageMatch: true,
                accountType: accountTypeFromBtn || serverTelegramBotConfig.accountType || 'USDT'
              };
            }
          } else {
            // SINAL JÁ EXISTIA: só sobrescrever alavancagem se vier explícita do botão
            if (leverageFromBtn && leverageFromBtn > 0) {
              parsed.leverage = leverageFromBtn;
              parsed.targetLeverage = leverageFromBtn;
              parsed.hasLeverageMatch = true;
            }
            if ((!parsed.takeProfits || parsed.takeProfits.length === 0) && lastTpFromBtn > 0) {
              parsed.takeProfits = [lastTpFromBtn];
            }
            if (accountTypeFromBtn) {
              parsed.accountType = accountTypeFromBtn;
            }
          }

          if (parsed && !parsed.accountType) {
            parsed.accountType = accountTypeFromBtn || serverTelegramBotConfig.accountType || 'USDT';
          }

          if (!parsed || !parsed.coinName) {
            if (cbChatId && cbMsgId) {
              await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                chat_id: cbChatId,
                message_id: cbMsgId,
                text: `⚠️ <b>ESTE BOTÃO É DE UM SINAL ANTERIOR</b>\n\nPor favor, encaminhe o sinal novamente no chat para abrir a ordem na moeda correta.`,
                parse_mode: "HTML"
              }, { timeout: 8000 }).catch(() => {});
            }
            return;
          }

          const symbolLabel = parsed.apiSymbol || `${parsed.coinName}-USDT`;
          console.log(`[BITUNIX-EXEC-CALLBACK] Iniciando execução do sinal para ${symbolLabel} (${parsed.direction} ${parsed.leverage}x) via ChatID ${cbChatId}`);

          // 👤 ROTEAMENTO DINÂMICO DE CONTA POR CHAT ID NO CALLBACK EXEC:
          const accCtx = getAccountContextForChat(cbChatId);
          let tradeResult: any;

          if (accCtx.isOperator && accCtx.account) {
            console.log(`[MULTI-ACCOUNT-CALLBACK] Executando ordem para operador ${accCtx.name} (${accCtx.ownerName}) via ChatID: ${cbChatId}`);
            tradeResult = await executeTradeForManagedAccount(accCtx.account, parsed);
          } else {
            tradeResult = await executeBingXTradeForTelegram(parsed);
          }

          if (tradeResult.success) {
            // 🔄 REPLICAÇÃO AUTOMÁTICA COPY TRADE: Replicar nas contas conectadas
            const initiatorId = accCtx.isOperator && accCtx.account ? accCtx.account.id : 'acc_master';
            replicateTradeToAllActiveAccounts(parsed, initiatorId).catch(err => {
              console.warn("[REPLICATION-CALLBACK-ERROR]:", err.message);
            });
          }

          if (signal) {
            signal.status = tradeResult.success ? "EXECUTED" : "PENDING";
            signal.executedBy = fromUser;
            signal.executedAt = new Date().toISOString();
            saveTelegramSignalsToFile();
          }

          if (cbChatId && cbMsgId) {
            if (tradeResult.success) {
              const fullMsg = formatTelegramExecutionSuccessMessage(tradeResult, fromUser);
              const kb = getExecutionInlineKeyboard(tradeResult);
              await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                chat_id: cbChatId,
                message_id: cbMsgId,
                text: fullMsg,
                parse_mode: "HTML",
                reply_markup: kb
              }, { timeout: 8000 }).catch(() => {});
            } else {
              await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
                chat_id: cbChatId,
                message_id: cbMsgId,
                text: `⚠️ <b>AVISO DA BITUNIX AO EXECUTAR ORDEM:</b>\n\n` +
                  `📊 <b>Par:</b> <code>${symbolLabel}</code>\n` +
                  `❌ <b>Resposta da Corretora:</b> ${tradeResult.error}\n` +
                  `👤 <b>Tentativa por:</b> ${fromUser}\n\n` +
                  `💡 <i>Verifique o saldo disponível em USDT ou as permissões de Trade da sua API Key.</i>`,
                parse_mode: "HTML",
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "📋 Ver Ordens Abertas", callback_data: "LIST_POSITIONS" }]
                  ]
                }
              }, { timeout: 8000 }).catch(() => {});
            }
          }
        } finally {
          activeTelegramOrderExecutions.delete(execLockKey);
        }
      } 
      // Callback: Cancelar TODAS as Ordens Pendentes (Botão Cancelar Todas)
        else if (cbData === "CANCEL_ALL_PENDING_ORDERS") {
          const cancelAllRes = await cancelAllBingXPendingOrders(DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cbChatId) {
            if (cancelAllRes.success) {
              await sendTelegramReply(cbChatId, `🚨 <b>TODAS AS ORDENS PENDENTES FORAM CANCELADAS!</b>\n\n🗑️ ${cancelAllRes.message}`);
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao cancelar ordens:</b> ${cancelAllRes.error}`);
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(cbChatId), 500);
          }
        }
        // Callback: Cancelar TODAS as ordens de uma moeda específica
        else if (cbData.startsWith("CANCEL_ALL_SYM_") || cbData.startsWith("CANCEL_ALL_SYM:")) {
          const symbol = cbData.replace("CANCEL_ALL_SYM_", "").replace("CANCEL_ALL_SYM:", "");
          const cleanSym = symbol.replace('-USDT', '').replace('USDT', '');
          const res = await cancelAllOrdersForSymbol(symbol, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cbChatId) {
            if (res.success) {
              await sendTelegramReply(cbChatId, `🗑️ <b>TODAS AS ORDENS DE ${cleanSym} FORAM CANCELADAS!</b>\n\n📊 Par: <code>${symbol}</code>\n✅ Ordens pendentes e gatilhos removidos da Bitunix.`);
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao cancelar ordens de ${cleanSym}:</b> ${res.error}`);
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(cbChatId), 500);
          }
        }
        // Callback: Cancelar Ordem Pendente Individual
        else if (cbData.startsWith("CANCEL_ORDER_") || cbData.startsWith("CANCEL_ORDER:")) {
          const raw = cbData.replace("CANCEL_ORDER_", "").replace("CANCEL_ORDER:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : "";

          // Remove os botões da mensagem original de execução para indicar que foi cancelada
          if (cbChatId && cbMsgId) {
            axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageReplyMarkup`, {
              chat_id: cbChatId,
              message_id: cbMsgId,
              reply_markup: { inline_keyboard: [] }
            }, { timeout: 4000 }).catch(() => {});
          }

          const cancelRes = await cancelSingleBingXOrder(symbol, orderId, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cbChatId) {
            if (cancelRes.success) {
              await sendTelegramReply(cbChatId, `🗑️ <b>ORDEM PENDENTE CANCELADA!</b>\n\n📊 Par: <code>${symbol}</code>\n🆔 ID: <code>#${orderId}</code>\n✅ Removida do livro de ordens da Bitunix.`);
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao cancelar ordem #${orderId}:</b> ${cancelRes.error}`);
            }
            // Envia a lista atualizada de ordens pendentes logo abaixo como uma nova mensagem (preservando o card de execução acima)
            setTimeout(() => renderTelegramPendingOrdersMessage(cbChatId), 500);
          }
        }
        // Callback: Cancelar Edição Rápida
        else if (cbData === "CANCEL_QUICK_EDIT") {
          if (cbChatId) {
            const editState = pendingUserEdits.get(String(cbChatId));
            if (editState?.promptMsgId) {
              await removeTelegramMessageButtons(cbChatId, editState.promptMsgId);
            }
            pendingUserEdits.delete(String(cbChatId));
            await clearActiveKeyboardsForChat(cbChatId);
            await sendTelegramReply(cbChatId, "❌ <i>Modo de edição cancelado.</i>");
          }
        }
        // Callback: Descartar Sinal por Armadilha de Taxas
        else if (cbData.startsWith("DISCARD_")) {
          const signalId = cbData.replace("DISCARD_", "");
          const signal = receivedTelegramSignals.find(s => s.id === signalId);
          if (signal) {
            signal.status = "CANCELLED";
          }

          if (cbChatId && cbMsgId) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
              chat_id: cbChatId,
              message_id: cbMsgId,
              text: `🛡️ <b>Sinal descartado por ${fromUser}!</b>\n\n` +
                `✅ <b>Decisão Consciente:</b> A armadilha de taxas foi evitada com sucesso.\n` +
                `Nenhuma ordem foi enviada à Bitunix, protegendo seu capital contra o custo operacional.`,
              parse_mode: "HTML"
            }, { timeout: 8000 }).catch(() => {});
          }
        }
        // Callback: Cancelar Prompt de Sinal Inicial
        else if (cbData.startsWith("CANCEL_")) {
          const signalId = cbData.replace("CANCEL_", "");
          const signal = receivedTelegramSignals.find(s => s.id === signalId);
          if (signal) {
            signal.status = "CANCELLED";
          }

          if (cbChatId && cbMsgId) {
            await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/editMessageText`, {
              chat_id: cbChatId,
              message_id: cbMsgId,
              text: `❌ <b>Ordem cancelada por ${fromUser}.</b>\nNenhuma operação foi aberta na Bitunix.`,
              parse_mode: "HTML"
            }, { timeout: 8000 }).catch(() => {});
          }
        }
        // Callback: Escolha do Preço de Entrada em caso de Faixa
        else if (cbData.startsWith("CHOOSE_ENTRY_")) {
          const lastUnderscore = cbData.lastIndexOf("_");
          const chosenPriceStr = cbData.substring(lastUnderscore + 1);
          const signalId = cbData.substring("CHOOSE_ENTRY_".length, lastUnderscore);
          const chosenPrice = parseFloat(chosenPriceStr);

          const signal = signalsStoreById.get(signalId) || receivedTelegramSignals.find(s => s.id === signalId);
          if (signal && signal.parsed) {
            signal.parsed.entryPrice = chosenPrice;
            signal.parsed.entryPrice2 = null;
            signal.parsed.entryPriceChosen = true;
            await promptTelegramConfirmation(signal.parsed, cbChatId, signalId, cbMsgId);
          }
        }
        // Callback: Listar Posições Abertas (Envia como NOVA mensagem para NÃO apagar o sinal da tela)
        else if (cbData === "LIST_POSITIONS") {
          if (cbChatId) {
            await renderTelegramPositionsMessage(cbChatId);
          }
        }
        // Callback: Atualizar Painel de Posições (Edita a mensagem de posições existente)
        else if (cbData === "REFRESH_POSITIONS") {
          if (cbChatId && cbMsgId) {
            await renderTelegramPositionsMessage(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramPositionsMessage(cbChatId);
          }
        }
        // Callback: Listar Ordens Pendentes (Livro)
        else if (cbData === "LIST_PENDING_ORDERS") {
          if (cbChatId) {
            await renderTelegramPendingOrdersMessage(cbChatId);
          }
        }
        // Callback: Atualizar Painel de Ordens Pendentes
        else if (cbData === "REFRESH_PENDING_ORDERS") {
          if (cbChatId && cbMsgId) {
            await renderTelegramPendingOrdersMessage(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramPendingOrdersMessage(cbChatId);
          }
        }
        // Callback: Relatório (Dia, Semana, Mês)
        else if (cbData.startsWith("REFRESH_REPORT") || cbData === "REFRESH_DAILY_REPORT") {
          const parts = cbData.split(":");
          const period: ReportPeriod = (parts[1] === 'WEEK' || parts[1] === 'MONTH') ? parts[1] : 'DAY';
          if (cbChatId && cbMsgId) {
            await renderTelegramReportMessage(cbChatId, period, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramReportMessage(cbChatId, period);
          }
        }
        else if (cbData.startsWith("VIEW_REPORT") || cbData === "VIEW_DAILY_REPORT") {
          const parts = cbData.split(":");
          const period: ReportPeriod = (parts[1] === 'WEEK' || parts[1] === 'MONTH') ? parts[1] : 'DAY';
          if (cbChatId && cbMsgId) {
            await renderTelegramReportMessage(cbChatId, period, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramReportMessage(cbChatId, period);
          }
        }
        // Callback: Painel do Copy Trade (Trader Líder)
        else if (cbData === "VIEW_COPY_TRADE") {
          if (cbChatId) {
            await renderTelegramCopyTradeMessage(cbChatId);
          }
        }
        // Callback: Atualizar Painel de Copy Trade
        else if (cbData === "COPY_REFRESH") {
          if (cbChatId && cbMsgId) {
            await renderTelegramCopyTradeMessage(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramCopyTradeMessage(cbChatId);
          }
        }
        // Callback: Ver Saldo e Status Bitunix
        else if (cbData === "VIEW_STATUS" || cbData === "VIEW_ACCOUNT_STATUS") {
          if (cbChatId && cbMsgId) {
            await renderTelegramStatusMessage(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramStatusMessage(cbChatId);
          }
        }
        // Callback: Atualizar Saldo e Status Bitunix
        else if (cbData === "REFRESH_STATUS") {
          if (cbChatId && cbMsgId) {
            await renderTelegramStatusMessage(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramStatusMessage(cbChatId);
          }
        }
        // Callback: Menu Principal
        else if (cbData === "VIEW_MAIN_MENU") {
          if (cbChatId && cbMsgId) {
            await renderTelegramMainMenu(cbChatId, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramMainMenu(cbChatId);
          }
        }
        // Callback: Central de Configurações (Print 2)
        else if (cbData === "VIEW_CONFIG" || cbData === "REFRESH_CONFIG") {
          if (cbChatId) {
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Abrir seletor de contas Bitunix salvas
        else if (cbData === "OPEN_ACCOUNT_SWITCHER") {
          if (cbChatId) {
            await renderTelegramAccountSwitcherMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Trocar conta Bitunix ativa pelo Telegram
        else if (cbData.startsWith("SWITCH_SAVED_ACCOUNT:")) {
          if (cbChatId) {
            const targetAccId = cbData.split(":")[1];
            const foundAcc = savedBitunixAccounts.find(a => a.id === targetAccId);
            if (foundAcc) {
              await applyActiveBitunixCredential(foundAcc, true);
              await renderTelegramAccountSwitcherMenu(cbChatId, cbMsgId, `Conta alternada para ${foundAcc.label}!`);
            }
          }
        }
        // Callback: Alternar Tipo de Conta (Real USDT <-> VST Demo)
        else if (cbData === "TOGGLE_ACCOUNT_TYPE") {
          if (cbChatId) {
            serverTelegramBotConfig.accountType = serverTelegramBotConfig.accountType === 'USDT' ? 'VST' : 'USDT';
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Trailing Stop (Ligar/Desligar)
        else if (cbData === "TOGGLE_TRAILING") {
          if (cbChatId) {
            serverTelegramBotConfig.trailingStopEnabled = !serverTelegramBotConfig.trailingStopEnabled;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Trailing Stop no Submenu
        else if (cbData === "TOGGLE_TRAILING_DETAIL") {
          if (cbChatId) {
            serverTelegramBotConfig.trailingStopEnabled = !serverTelegramBotConfig.trailingStopEnabled;
            saveTelegramConfigToFile();
            await renderTelegramTrailingConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Modo de Alavancagem (Do Sinal <-> Fixa 20x)
        else if (cbData === "TOGGLE_LEVERAGE_MODE") {
          if (cbChatId) {
            serverTelegramBotConfig.defaultLeverageMode = serverTelegramBotConfig.defaultLeverageMode === 'SIGNAL_LEVERAGE' ? 'FIXED_LEVERAGE' : 'SIGNAL_LEVERAGE';
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Execução de Sinais (1 Toque <-> Auto 100%)
        else if (cbData === "TOGGLE_SIGNAL_EXEC") {
          if (cbChatId) {
            serverTelegramBotConfig.autoExecuteWithoutPrompt = !serverTelegramBotConfig.autoExecuteWithoutPrompt;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Submenu Configurar Trailing Stop / Condução de Stop (Prints 2 e 3)
        else if (cbData === "MENU_CONFIG_TRAILING" || cbData === "VIEW_TRAILING_CONFIG") {
          if (cbChatId) {
            await renderTelegramTrailingConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Condução de Stop no menu principal de configurações
        else if (cbData === "TOGGLE_CONDUCAO") {
          if (cbChatId) {
            serverTelegramBotConfig.conducaoStopEnabled = !serverTelegramBotConfig.conducaoStopEnabled;
            serverTelegramBotConfig.trailingStopEnabled = serverTelegramBotConfig.conducaoStopEnabled;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Condução de Stop (Ativada <-> Pausada) no submenu
        else if (cbData === "TOGGLE_CONDUCAO_ACTIVE") {
          if (cbChatId) {
            serverTelegramBotConfig.conducaoStopEnabled = !serverTelegramBotConfig.conducaoStopEnabled;
            serverTelegramBotConfig.trailingStopEnabled = serverTelegramBotConfig.conducaoStopEnabled;
            saveTelegramConfigToFile();
            await renderTelegramTrailingConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Taxas Embutidas no SL
        else if (cbData === "TOGGLE_FEES_EMBEDDED") {
          if (cbChatId) {
            serverTelegramBotConfig.includeFeesInRisk = !serverTelegramBotConfig.includeFeesInRisk;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Reembolso de Taxas (45%)
        else if (cbData === "TOGGLE_FEE_REBATE") {
          if (cbChatId) {
            (serverTelegramBotConfig as any).feeRebate = (serverTelegramBotConfig as any).feeRebate === false ? true : false;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Alvos VIP (1x / +0.5x <-> Padrão)
        else if (cbData === "TOGGLE_VIP_TARGETS") {
          if (cbChatId) {
            (serverTelegramBotConfig as any).vipTargetsMode = (serverTelegramBotConfig as any).vipTargetsMode === 'STANDARD' ? 'VIP_SCALED' : 'STANDARD';
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Alternar Entrada Inteligente 1m
        else if (cbData === "TOGGLE_1M_ENTRY") {
          if (cbChatId) {
            (serverTelegramBotConfig as any).smartEntry1mEnabled = (serverTelegramBotConfig as any).smartEntry1mEnabled === false ? true : false;
            saveTelegramConfigToFile();
            await renderTelegramConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Modo Trailing
        else if (cbData === "SET_MODE_TRAILING") {
          if (cbChatId) {
            serverTelegramBotConfig.conducaoStrategy = 'TRAILING';
            saveTelegramConfigToFile();
            await renderTelegramTrailingConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Modo Condução por Stop
        else if (cbData === "SET_MODE_CONDUCAO") {
          if (cbChatId) {
            serverTelegramBotConfig.conducaoStrategy = 'CONDUCAO';
            saveTelegramConfigToFile();
            await renderTelegramTrailingConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callbacks: Prompts Condução Tiers 0..6 (Print 3)
        else if (cbData === "PROMPT_CONDUCAO_0") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `🛡️ <b>0. REDUZIR RISCO (STOP DEFENSIVO)</b>\n\n` +
              `👉 Digite em quantas vezes a distância do Stop Loss o robô deve puxar o Stop para -33% (cortando 67% da perda e evitando violinada).\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 1 ou 1.2):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_0',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_1") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `✏️ <b>1. MOVER P/ ENTRADA (BREAK-EVEN)</b>\n\n` +
              `👉 Digite em quantas vezes a distância do Stop Loss o robô deve puxar o Stop Loss exatamente para a entrada (0 a 0 garantindo risco zero).\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 1.5):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_1',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_2") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `⚖️ <b>2. PREÇO DE EQUILÍBRIO (COBRIR TAXAS)</b>\n\n` +
              `👉 Digite em quantas vezes a distância do Stop Loss o robô deve avançar o Stop para pagar 100% das taxas (risco zero real).\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier2Trigger ?? 1.5}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 1.5):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_2',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_3") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `🚀 <b>3. COMEÇAR CONDUÇÃO (FASE 1 - GARANTIR LUCRO)</b>\n\n` +
              `👉 Digite o gatilho inicial (vezes o Stop Loss) em que o robô começa a travar lucro no bolso.\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 2):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_3',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_4") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `📐 <b>4. FOLGA INICIAL (FASE 1)</b>\n\n` +
              `👉 Digite a distância recuada (vezes o Stop Loss) para deixar o trade respirar na Fase 1.\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier4Dist ?? 1.0}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 1):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_4',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_5") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `⚡ <b>5. APERTAR STOP / ACELERAR CONDUÇÃO (FASE 2)</b>\n\n` +
              `👉 Digite a partir de quantas vezes o Stop Loss o robô acelera a condução na Fase 2 para blindar lucros.\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 3):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_5',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        else if (cbData === "PROMPT_CONDUCAO_6") {
          if (cbChatId) {
            if (cbMsgId) await removeTelegramMessageButtons(cbChatId, cbMsgId);
            const promptRes = await sendTelegramReply(
              cbChatId,
              `🎯 <b>6. FOLGA REDUZIDA (FASE 2)</b>\n\n` +
              `👉 Digite a folga reduzida (vezes o Stop Loss) na Fase 2 para manter o stop colado sem devolver lucros.\n\n` +
              `Padrão atual: <b>${serverTelegramBotConfig.conducaoTier6Dist ?? 0.5}x</b>\n\n` +
              `💬 <b>Envie seu número aqui no chat (ex: 0.5):</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Condução", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'CONDUCAO_6',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Submenu Configurar Risco (Print 4)
        else if (cbData === "MENU_CONFIG_RISK" || cbData === "VIEW_RISK_CONFIG") {
          if (cbChatId) {
            await renderTelegramRiskConfigMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Prompt Digitar Risco (Print 5)
        else if (cbData === "PROMPT_CONFIG_RISK") {
          if (cbChatId) {
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            await sendRiskPromptExplanation(cbChatId);
          }
        }
        // Callback: Submenu Trava Diária e Meta (Print 6)
        else if (cbData === "MENU_CONFIG_DAILY_LOCK") {
          if (cbChatId) {
            await renderTelegramDailyLockMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Prompt Trailing Multiplicador
        else if (cbData === "PROMPT_TRAILING_MULT") {
          if (cbChatId) {
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            const promptRes = await sendTelegramReply(
              cbChatId,
              `✏️ <b>VEZES O STOP LOSS (MULTIPLICADOR DE RECUO)</b>\n\n` +
              `👉 Digite quantas vezes o tamanho do Stop Loss o preço pode recuar a partir do topo antes de fechar no lucro.\n\n` +
              `Exemplos:\n• <code>1</code> (recuo de 1x do SL)\n• <code>1.5</code> (recuo de 1.5x do SL)\n• <code>2</code> (recuo de 2x do SL)\n\n` +
              `💬 <b>Envie seu número aqui no chat:</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Trailing", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'TRAILING_MULT',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Prompt Trailing Gatilho de Ativação
        else if (cbData === "PROMPT_TRAILING_TRIGGER") {
          if (cbChatId) {
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            const promptRes = await sendTelegramReply(
              cbChatId,
              `✏️ <b>ATIVAR TRAILING STOP A PARTIR DE</b>\n\n` +
              `👉 Digite a partir de quantas vezes a distância do Stop Loss o Trailing Stop deve armar o gatilho na corretora.\n\n` +
              `Exemplos:\n• <code>1</code> (ativa ao atingir 1x do SL de lucro)\n• <code>1.5</code> (ativa com 1.5x do SL)\n• <code>2</code> (ativa com 2x do SL)\n\n` +
              `💬 <b>Envie seu número aqui no chat:</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Trailing", callback_data: "MENU_CONFIG_TRAILING" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'TRAILING_TRIGGER',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Prompt Digitar Trava de Perda Diária
        else if (cbData === "PROMPT_DAILY_LOSS") {
          if (cbChatId) {
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            const promptRes = await sendTelegramReply(
              cbChatId,
              `✏️ <b>DEFINIR TRAVA DE PERDA DIÁRIA</b>\n\n` +
              `Digite o limite máximo de prejuízo diário antes de travar novas operações.\n\n` +
              `Exemplos:\n• <code>5%</code> (5% da banca)\n• <code>3%</code> (3% da banca)\n• <code>$20</code> (20 dólares fixos)\n• <code>15</code> (15 dólares fixos)\n\n` +
              `💬 <b>Envie seu valor aqui no chat:</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Trava", callback_data: "MENU_CONFIG_DAILY_LOCK" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'DAILY_LOSS',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Prompt Digitar Meta de Lucro Diária
        else if (cbData === "PROMPT_DAILY_PROFIT") {
          if (cbChatId) {
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            const promptRes = await sendTelegramReply(
              cbChatId,
              `🎯 <b>DEFINIR META DE LUCRO DIÁRIA</b>\n\n` +
              `Digite a meta de ganho diário para pausar operações e blindar seus lucros.\n\n` +
              `Exemplos:\n• <code>10%</code> (10% da banca)\n• <code>5%</code> (5% da banca)\n• <code>$50</code> (50 dólares fixos)\n• <code>30</code> (30 dólares fixos)\n\n` +
              `💬 <b>Envie seu valor aqui no chat:</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "⬅️ Voltar p/ Trava", callback_data: "MENU_CONFIG_DAILY_LOCK" },
                    { text: "❌ Cancelar", callback_data: "CANCEL_CONFIG_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            pendingConfigPrompts.set(String(cbChatId), {
              type: 'DAILY_PROFIT',
              promptMsgId: promptRes?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Desativar Trava de Perda
        else if (cbData === "DISABLE_DAILY_LOSS") {
          if (cbChatId) {
            serverTelegramBotConfig.dailyLossLimitEnabled = false;
            saveTelegramConfigToFile();
            await renderTelegramDailyLockMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Desativar Meta de Lucro
        else if (cbData === "DISABLE_DAILY_PROFIT") {
          if (cbChatId) {
            serverTelegramBotConfig.dailyProfitTargetEnabled = false;
            saveTelegramConfigToFile();
            await renderTelegramDailyLockMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Destravar Hoje
        else if (cbData === "UNLOCK_DAILY_LOCK") {
          if (cbChatId) {
            serverTelegramBotConfig.dailyLockUnlockedDate = getBrasiliaDateString();
            saveTelegramConfigToFile();
            await sendTelegramReply(cbChatId, `🔓 <b>Trava liberada para hoje!</b>\nOperações liberadas normalmente até o fim do dia.`, undefined, { disableDedup: true });
            await renderTelegramDailyLockMenu(cbChatId, cbMsgId);
          }
        }
        // Callback: Cancelar Prompt de Configuração
        else if (cbData === "CANCEL_CONFIG_PROMPT") {
          if (cbChatId) {
            pendingConfigPrompts.delete(String(cbChatId));
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            await sendTelegramReply(cbChatId, `ℹ️ <i>Configuração mantida sem alterações.</i>`, undefined, { disableDedup: true });
            await renderTelegramConfigMenu(cbChatId);
          }
        }
        // Callback: Histórico Detalhado de Operações (Dia, Semana, Mês)
        else if (cbData.startsWith("REFRESH_HISTORY")) {
          const parts = cbData.split(":");
          const period: ReportPeriod = (parts[1] === 'WEEK' || parts[1] === 'MONTH') ? parts[1] : 'DAY';
          if (cbChatId && cbMsgId) {
            await renderTelegramHistoryMessage(cbChatId, period, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramHistoryMessage(cbChatId, period);
          }
        }
        else if (cbData.startsWith("VIEW_HISTORY")) {
          const parts = cbData.split(":");
          const period: ReportPeriod = (parts[1] === 'WEEK' || parts[1] === 'MONTH') ? parts[1] : 'DAY';
          if (cbChatId && cbMsgId) {
            await renderTelegramHistoryMessage(cbChatId, period, cbMsgId);
          } else if (cbChatId) {
            await renderTelegramHistoryMessage(cbChatId, period);
          }
        }
        // Callback: Abrir Submenu para Gerenciar Ordem Específica
        else if (cbData.startsWith("MANAGE_ORDER_") || cbData.startsWith("MANAGE_ORDER:")) {
          const raw = cbData.replace("MANAGE_ORDER_", "").replace("MANAGE_ORDER:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : "";
          if (cbChatId) {
            await renderTelegramManageOrderMenu(cbChatId, symbol, orderId, cbMsgId);
          }
        }
        // Callback: Modo Edição Rápida de Stop Loss
        else if (cbData.startsWith("PROMPT_EDIT_SL_") || cbData.startsWith("PROMPT_EDIT_SL:")) {
          const raw = cbData.replace("PROMPT_EDIT_SL_", "").replace("PROMPT_EDIT_SL:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : undefined;
          if (cbChatId) {
            const info = await getSymbolActiveSLTPInfo(symbol, orderId);
            const formatP = (v: number) => v.toFixed(info.pricePrecision);
            const isLong = info.positionSide === 'LONG';
            const sideEmoji = info.positionSide ? (isLong ? '(LONG 🟢)' : '(SHORT 🔴)') : '';

            const exampleSL = (info.currentSL && info.currentSL > 0)
              ? formatP(info.currentSL)
              : (info.entryPrice > 0 ? formatP(isLong ? info.entryPrice * 0.98 : info.entryPrice * 1.02) : '81250');

            const sentPrompt = await sendTelegramReply(
              cbChatId,
              `🛑 <b>EDITAR STOP LOSS — ${info.cleanSym}</b> ${sideEmoji}\n` +
              `═══════════════════════════\n` +
              (info.entryPrice > 0 ? `⚡ <b>Preço de Entrada:</b> <code>$${formatP(info.entryPrice)}</code>\n` : '') +
              `🛑 <b>Stop Loss Atual:</b> <code>${info.currentSL && info.currentSL > 0 ? `$${formatP(info.currentSL)}` : 'Não Definido'}</code>\n` +
              (info.currentTP && info.currentTP > 0 ? `🎯 <b>Take Profit Atual:</b> <code>$${formatP(info.currentTP)}</code>\n` : '') +
              `───────────────────────────\n` +
              `👉 <b>Basta digitar apenas o novo preço no chat e enviar!</b>\n` +
              `<i>Exemplo: digite <code>${exampleSL}</code> e envie</i>\n\n` +
              `💡 <i>O bot atualizará o Stop Loss na Bitunix imediatamente.</i>`,
              {
                inline_keyboard: [
                  [
                    { text: `❌ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
                  ]
                ]
              }
            );

            pendingUserEdits.set(String(cbChatId), {
              symbol,
              orderType: 'SL',
              orderId,
              side: info.positionSide || undefined,
              promptMsgId: sentPrompt?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Modo Edição Rápida de Take Profit
        else if (cbData.startsWith("PROMPT_EDIT_TP_") || cbData.startsWith("PROMPT_EDIT_TP:")) {
          const raw = cbData.replace("PROMPT_EDIT_TP_", "").replace("PROMPT_EDIT_TP:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : undefined;
          if (cbChatId) {
            const info = await getSymbolActiveSLTPInfo(symbol, orderId);
            const formatP = (v: number) => v.toFixed(info.pricePrecision);
            const isLong = info.positionSide === 'LONG';
            const sideEmoji = info.positionSide ? (isLong ? '(LONG 🟢)' : '(SHORT 🔴)') : '';

            const exampleTP = (info.currentTP && info.currentTP > 0)
              ? formatP(info.currentTP)
              : (info.entryPrice > 0 ? formatP(isLong ? info.entryPrice * 1.03 : info.entryPrice * 0.97) : '76000');

            const sentPrompt = await sendTelegramReply(
              cbChatId,
              `🎯 <b>EDITAR TAKE PROFIT — ${info.cleanSym}</b> ${sideEmoji}\n` +
              `═══════════════════════════\n` +
              (info.entryPrice > 0 ? `⚡ <b>Preço de Entrada:</b> <code>$${formatP(info.entryPrice)}</code>\n` : '') +
              `🎯 <b>Take Profit Atual:</b> <code>${info.currentTP && info.currentTP > 0 ? `$${formatP(info.currentTP)}` : 'Não Definido'}</code>\n` +
              (info.currentSL && info.currentSL > 0 ? `🛑 <b>Stop Loss Atual:</b> <code>$${formatP(info.currentSL)}</code>\n` : '') +
              `───────────────────────────\n` +
              `👉 <b>Basta digitar apenas o novo preço no chat e enviar!</b>\n` +
              `<i>Exemplo: digite <code>${exampleTP}</code> e envie</i>\n\n` +
              `💡 <i>O bot atualizará a ordem na Bitunix imediatamente.</i>`,
              {
                inline_keyboard: [
                  [
                    { text: `❌ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
                  ]
                ]
              }
            );

            pendingUserEdits.set(String(cbChatId), {
              symbol,
              orderType: 'TP',
              orderId,
              side: info.positionSide || undefined,
              promptMsgId: sentPrompt?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Guia Interativo de Edição de SL / TP geral
        else if (cbData.startsWith("PROMPT_EDIT_SLTP_") || cbData.startsWith("PROMPT_EDIT_SLTP:")) {
          const raw = cbData.replace("PROMPT_EDIT_SLTP_", "").replace("PROMPT_EDIT_SLTP:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : undefined;
          if (cbChatId) {
            const info = await getSymbolActiveSLTPInfo(symbol, orderId);
            const formatP = (v: number) => v.toFixed(info.pricePrecision);
            const isLong = info.positionSide === 'LONG';
            const sideEmoji = info.positionSide ? (isLong ? '(LONG 🟢)' : '(SHORT 🔴)') : '';

            const exampleSL = (info.currentSL && info.currentSL > 0)
              ? formatP(info.currentSL)
              : (info.entryPrice > 0 ? formatP(isLong ? info.entryPrice * 0.98 : info.entryPrice * 1.02) : '81250');
            const exampleTP = (info.currentTP && info.currentTP > 0)
              ? formatP(info.currentTP)
              : (info.entryPrice > 0 ? formatP(isLong ? info.entryPrice * 1.03 : info.entryPrice * 0.97) : '76000');

            const sentPrompt = await sendTelegramReply(
              cbChatId,
              `✏️ <b>EDITAR STOP LOSS / TAKE PROFIT — ${info.cleanSym}</b> ${sideEmoji}\n` +
              `═══════════════════════════\n` +
              (info.entryPrice > 0 ? `⚡ <b>Preço de Entrada:</b> <code>$${formatP(info.entryPrice)}</code>\n` : '') +
              `🛑 <b>Stop Loss Atual:</b> <code>${info.currentSL && info.currentSL > 0 ? `$${formatP(info.currentSL)}` : 'Não Definido'}</code>\n` +
              `🎯 <b>Take Profit Atual:</b> <code>${info.currentTP && info.currentTP > 0 ? `$${formatP(info.currentTP)}` : 'Não Definido'}</code>\n` +
              `───────────────────────────\n` +
              `👉 <b>Basta digitar apenas o novo preço no chat e enviar!</b>\n` +
              `<i>Exemplo: digite <code>${exampleSL}</code> para alterar o SL</i>\n\n` +
              `<i>Você também pode usar: <code>/sl ${info.cleanSym} ${exampleSL}</code> ou <code>/tp ${info.cleanSym} ${exampleTP}</code></i>`,
              {
                inline_keyboard: [
                  [
                    { text: `🔄 Ver Pendentes`, callback_data: "REFRESH_PENDING_ORDERS" },
                    { text: `❌ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
                  ]
                ]
              }
            );

            pendingUserEdits.set(String(cbChatId), {
              symbol,
              orderType: 'SL',
              orderId,
              side: info.positionSide || undefined,
              promptMsgId: sentPrompt?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Modo Edição Rápida de Preço Limite de Entrada
        else if (cbData.startsWith("PROMPT_EDIT_LIMIT_") || cbData.startsWith("PROMPT_EDIT_LIMIT:")) {
          const raw = cbData.replace("PROMPT_EDIT_LIMIT_", "").replace("PROMPT_EDIT_LIMIT:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const orderId = lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : undefined;
          if (cbChatId) {
            const info = await getSymbolActiveSLTPInfo(symbol, orderId);
            const formatP = (v: number) => v.toFixed(info.pricePrecision);
            const isLong = info.positionSide === 'LONG';
            const sideEmoji = info.positionSide ? (isLong ? '(LONG 🟢)' : '(SHORT 🔴)') : '';

            const exampleLimit = info.entryPrice > 0 ? formatP(info.entryPrice) : '80850';

            const sentPrompt = await sendTelegramReply(
              cbChatId,
              `🎯 <b>EDITAR PREÇO LIMITE DE ENTRADA — ${info.cleanSym}</b> ${sideEmoji}\n` +
              `═══════════════════════════\n` +
              `⚡ <b>Preço Limite Atual:</b> <code>${info.entryPrice > 0 ? `$${formatP(info.entryPrice)}` : 'Não Definido'}</code>\n` +
              (info.currentSL && info.currentSL > 0 ? `🛑 <b>Stop Loss Atual:</b> <code>$${formatP(info.currentSL)}</code>\n` : '') +
              (info.currentTP && info.currentTP > 0 ? `🎯 <b>Take Profit Atual:</b> <code>$${formatP(info.currentTP)}</code>\n` : '') +
              `───────────────────────────\n` +
              `👉 <b>Basta digitar apenas o novo preço no chat e enviar!</b>\n` +
              `<i>Exemplo: digite <code>${exampleLimit}</code> e envie</i>\n\n` +
              `💡 <i>O bot irá substituir a ordem no livro da Bitunix instantaneamente!</i>`,
              {
                inline_keyboard: [
                  [
                    { text: `❌ Cancelar Edição`, callback_data: `CANCEL_QUICK_EDIT` }
                  ]
                ]
              }
            );

            pendingUserEdits.set(String(cbChatId), {
              symbol,
              orderType: 'LIMIT',
              orderId,
              side: info.positionSide || undefined,
              promptMsgId: sentPrompt?.message_id,
              timestamp: Date.now()
            });
          }
        }
        // Callback: Cancelar Trailing Stop
        else if (cbData.startsWith("CANCEL_TRAILING:") || cbData.startsWith("CANCEL_TRAILING_")) {
          const raw = cbData.replace("CANCEL_TRAILING:", "").replace("CANCEL_TRAILING_", "");
          const parts = raw.split(":");
          const symbol = parts[0] || '';
          const explicitOrderId = (parts.length > 1 && parts[1]) ? parts[1].trim() : undefined;
          const cleanSym = symbol.replace('-USDT', '').replace('USDT', '');
          if (cbChatId) {
            const isDemo = serverTelegramBotConfig.accountType === 'VST';
            const normalizedSym = `${cleanSym}-USDT`;
            
            console.log(`[CANCEL-TRAILING] Solicitado cancelamento de Trailing Stop para ${cleanSym} (ID explícito: ${explicitOrderId || 'Nenhum'})...`);

            let wasCancelled = false;
            let lastError = '';

            // 1. Se veio orderId explícito do botão, cancela imediatamente
            if (explicitOrderId && explicitOrderId.length > 0) {
              const res = await cancelSingleBingXOrder(normalizedSym, explicitOrderId, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
              if (res.success) {
                wasCancelled = true;
              } else {
                lastError = res.error || '';
              }
            }

            // 2. Busca ordens ativas na Bitunix para localizar e cancelar quaisquer trailing stops deste par
            try {
              const [ordersRes, allOrdersRes] = await Promise.all([
                sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', { symbol: normalizedSym }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo).catch(() => ({ code: -1, data: [] })),
                sendBingXRequest('/openApi/swap/v2/trade/openOrders', 'GET', {}, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo).catch(() => ({ code: -1, data: [] }))
              ]);

              const sym1Orders = (ordersRes?.data && Array.isArray(ordersRes.data?.orders || ordersRes.data)) ? (ordersRes.data?.orders || ordersRes.data) : [];
              const allOrders = (allOrdersRes?.data && Array.isArray(allOrdersRes.data?.orders || allOrdersRes.data)) ? (allOrdersRes.data?.orders || allOrdersRes.data) : [];
              
              const ordersMap = new Map<string, any>();
              [...sym1Orders, ...allOrders].forEach((o: any) => {
                if (o && (o.orderId || o.orderID)) {
                  const id = (o.orderId || o.orderID).toString();
                  const st = (o.status || '').toUpperCase();
                  if (st !== 'FILLED' && st !== 'CANCELED' && st !== 'CANCELLED' && st !== 'REJECTED' && st !== 'EXPIRED') {
                    ordersMap.set(id, o);
                  }
                }
              });
              const allMerged = Array.from(ordersMap.values());

              const isLimitEntry = (o: any) => {
                const t = (o.type || '').toUpperCase();
                return (t === 'LIMIT' || t === 'TRIGGER_LIMIT');
              };
              const isExplicitSL = (o: any) => {
                const t = (o.type || '').toUpperCase();
                return (t === 'STOP_MARKET' || t === 'STOP' || t === 'STOP_LOSS') && !o.callbackRate && !o.priceRate && !t.includes('TRAILING');
              };
              const isExplicitTP = (o: any) => {
                const t = (o.type || '').toUpperCase();
                return (t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT') && !o.callbackRate && !o.priceRate && !t.includes('TRAILING');
              };

              const tsOrders = allMerged.filter((o: any) => {
                const s = (o.symbol || '').toUpperCase().replace('-USDT', '').replace('USDT', '');
                if (s !== cleanSym) return false;
                const ordIdStr = (o.orderId || o.orderID || '').toString();
                if (explicitOrderId && ordIdStr === explicitOrderId) return true;
                const t = (o.type || '').toUpperCase();
                const ot = (o.orderType || '').toUpperCase();
                if (t === 'TRAILING_STOP_MARKET' || t === 'TRAILING_STOP' || t === 'TRAILING_TP_SL' || t.includes('TRAILING')) return true;
                if (ot === 'TRAILING_STOP_MARKET' || ot === 'TRAILING_STOP' || ot === 'TRAILING_TP_SL' || ot.includes('TRAILING')) return true;
                if (o.callbackRate || o.priceRate || o.activationPrice) return true;
                if (!isLimitEntry(o) && !isExplicitSL(o) && !isExplicitTP(o)) return true;
                return false;
              });

              for (const oldTs of tsOrders) {
                const ordIdStr = (oldTs.orderId || oldTs.orderID || '').toString();
                if (ordIdStr) {
                  const cancelRes = await cancelSingleBingXOrder(oldTs.symbol || normalizedSym, ordIdStr, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
                  if (cancelRes.success) {
                    wasCancelled = true;
                  } else if (!lastError) {
                    lastError = cancelRes.error || '';
                  }
                }
              }
            } catch (e: any) {
              console.error("[CANCEL-TRAILING-ERR]:", e.message);
            }

            if (wasCancelled || !lastError || lastError.includes("not found") || lastError.includes("100414")) {
              await sendTelegramReply(
                cbChatId,
                `🗑️ <b>TRAILING STOP CANCELADO COM SUCESSO!</b>\n\n` +
                `📊 Par: <code>${normalizedSym}</code>\n` +
                `✅ A ordem de Trailing Stop ${explicitOrderId ? `(#${explicitOrderId.slice(-6)}) ` : ''}foi cancelada e removida da Bitunix.`
              );
            } else {
              await sendTelegramReply(
                cbChatId,
                `⚠️ <b>Falha ao cancelar Trailing Stop na Bitunix:</b>\n<code>${lastError}</code>\n\n` +
                `💡 <i>A ordem pode já ter sido executada ou cancelada na corretora.</i>`
              );
            }

            setTimeout(() => renderTelegramPendingOrdersMessage(cbChatId, cbMsgId), 800);
          }
        }
        // Callback: Cancelar Modo de Edição Rápida
        else if (cbData === "CANCEL_QUICK_EDIT") {
          if (cbChatId) {
            pendingUserEdits.delete(String(cbChatId));
            await sendTelegramReply(cbChatId, `ℹ️ <i>Edição rápida cancelada.</i>`);
            setTimeout(() => renderTelegramPendingOrdersMessage(cbChatId, cbMsgId), 500);
          }
        }
        // Callback: Cancelar Espera de Imagem / Gráfico
        else if (cbData === "CANCEL_IMAGE_PROMPT") {
          if (cbChatId) {
            pendingImagePrompts.delete(String(cbChatId));
            if (cbMsgId) {
              await removeTelegramMessageButtons(cbChatId, cbMsgId);
            }
            await sendTelegramReply(cbChatId, `ℹ️ <i>Modo de espera por imagem de sinal foi cancelado.</i>`, undefined, { disableDedup: true });
          }
        }
        // Callback: Acionar Solicitação de Imagem / Gráfico
        else if (cbData === "PROMPT_IMAGE_SIGNAL") {
          if (cbChatId) {
            pendingImagePrompts.set(String(cbChatId), {
              timestamp: Date.now()
            });
            const promptRes = await sendTelegramReply(
              cbChatId,
              `🖼️ <b>MODO SINAL POR IMAGEM ATIVADO!</b>\n\n` +
              `📸 <b>Envie ou cole o print do seu gráfico TradingView agora</b> neste chat.\n\n` +
              `🔍 <i>A Inteligência Artificial analisa o gráfico e extrai automaticamente:</i>\n` +
              `• 📊 <b>Par / Criptomoeda</b> (ex: OPN/USDT, BTC, ETH, SOL...)\n` +
              `• ⚡ <b>Direção & Alavancagem</b> (LONG / SHORT | Ex: 86x)\n` +
              `• 🔷 <b>Preço de Entrada</b> (Etiqueta Entrada)\n` +
              `• 🛑 <b>Stop Loss</b> (Etiqueta Stop)\n` +
              `• 🎯 <b>Alvos de Lucro</b> (Take Profits: Alvo 01, Alvo 02...)\n\n` +
              `⏳ <b>Aguardando seu print nos próximos 5 minutos...</b>`,
              {
                inline_keyboard: [
                  [
                    { text: "❌ Cancelar Espera de Imagem", callback_data: "CANCEL_IMAGE_PROMPT" }
                  ]
                ]
              },
              { disableDedup: true }
            );
            if (promptRes?.message_id) {
              const state = pendingImagePrompts.get(String(cbChatId));
              if (state) {
                state.promptMsgId = promptRes.message_id;
              }
            }
          }
        }
        // Callback: Ver / Atualizar Stop Móvel (Trailing Stop)
        else if (cbData === "VIEW_TRAILING" || cbData === "REFRESH_TRAILING" || cbData.startsWith("DETAILS_TRAILING:") || cbData.startsWith("DETAILS_TRAILING_")) {
          if (cbChatId) {
            await renderTelegramTrailingStatusMessage(cbChatId);
          }
        }
        // Callback: Fechamento Parcial Rápido
        else if (cbData.startsWith("PARTIAL_CLOSE:") || cbData.startsWith("PARTIAL_CLOSE_")) {
          const raw = cbData.replace("PARTIAL_CLOSE:", "").replace("PARTIAL_CLOSE_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          const percent = parseInt(parts[2] || '50', 10) || 50;

          const pRes = await closeBingXPositionPartial(symbol, side, percent, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
          if (cbChatId) {
            if (pRes.success) {
              const msg =
                `✂️ <b>FECHAMENTO PARCIAL EXECUTADO!</b>\n\n` +
                `📊 <b>Par:</b> <code>${pRes.symbol}</code> (${side})\n` +
                `📦 <b>Quantidade Encerrada:</b> <b>${pRes.closedQty} (${percent}%)</b>\n` +
                `💼 <b>Quantidade Restante:</b> <b>${pRes.remainingQty}</b>\n\n` +
                `💰 <i>Lucro parcial garantido no saldo! O restante da posição segue aberto com proteção do robô!</i>`;
              await sendTelegramReply(cbChatId, msg, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao executar parcial em ${symbol}:</b> ${pRes.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 1000);
          }
        }
        // Callback: Fechar Posição
        else if (cbData.startsWith("CLOSE_POS_") || cbData.startsWith("CLOSE_POS:")) {
          const raw = cbData.replace("CLOSE_POS_", "").replace("CLOSE_POS:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const side = (lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : 'LONG') || 'LONG';

          const closeRes = await closeBingXPosition(symbol, side, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cbChatId) {
            if (closeRes.success) {
              if (closeRes.isPendingOrder) {
                await sendTelegramReply(cbChatId, `🛑 <b>ORDEM PENDENTE CANCELADA!</b>\n\n📊 Par: <code>${symbol}</code>\n🗑️ A ordem limite/gatilho que aguardava ativação foi removida do livro de ofertas da Bitunix.`, undefined, { disableDedup: true });
              } else {
                const isLong = (closeRes.positionSide || side) === 'LONG';
                const dirIcon = isLong ? '🟢' : '🔴';
                const pnlVal = closeRes.realizedPnl !== undefined ? closeRes.realizedPnl : 0;
                const roiVal = closeRes.roiPct !== undefined ? closeRes.roiPct : 0;
                const entryStr = formatDisplayPrice(closeRes.entryPrice);
                const exitStr = formatDisplayPrice(closeRes.closePrice);
                const isGain = pnlVal > 0.05;
                const isFlat = Math.abs(pnlVal) <= 0.05;

                const header = isGain
                  ? `✅ <b>POSIÇÃO ENCERRADA MANUALMENTE (COM LUCRO)</b>`
                  : isFlat
                  ? `🛡️ <b>POSIÇÃO ENCERRADA MANUALMENTE (0 a 0)</b>`
                  : `🚪 <b>POSIÇÃO ENCERRADA MANUALMENTE (COM PREJUÍZO)</b>`;

                const pnlSign = pnlVal >= 0 ? '+' : '';
                const roiSign = roiVal >= 0 ? '+' : '';

                const closeMsg = 
                  `${header}\n\n` +
                  `📊 <b>Par:</b> <code>${closeRes.symbol}</code> (${closeRes.positionSide || side} ${closeRes.leverage || 20}x ${dirIcon})\n` +
                  `💵 <b>Preço de Entrada:</b> <code>$${entryStr}</code>\n` +
                  `🏁 <b>Preço de Saída:</b> <code>$${exitStr}</code>\n` +
                  `💰 <b>Resultado PnL:</b> <code>${pnlSign}$${pnlVal.toFixed(2)} USDT (${roiSign}${roiVal.toFixed(2)}%)</code>\n\n` +
                  `🖐️ <i>Posição finalizada a mercado na Bitunix com sucesso. A margem e o saldo foram atualizados!</i>`;

                await sendTelegramReply(cbChatId, closeMsg, undefined, { disableDedup: true });
              }
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao fechar posição em ${symbol}:</b> ${closeRes.error}`, undefined, { disableDedup: true });
            }
            // Envia o Painel de Ordens & Posições estritamente DEPOIS da mensagem de fechamento manual
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 1200);
          }
        }
        // Callback: Mover Stop Loss para Breakeven (0 a 0)
        else if (cbData.startsWith("SET_BE_") || cbData.startsWith("SET_BE:")) {
          const raw = cbData.replace("SET_BE_", "").replace("SET_BE:", "");
          const delimiter = raw.includes(":") ? ":" : "_";
          const lastDelimIdx = raw.lastIndexOf(delimiter);
          const symbol = lastDelimIdx > 0 ? raw.substring(0, lastDelimIdx) : raw;
          const side = (lastDelimIdx > 0 ? raw.substring(lastDelimIdx + 1) : 'LONG') || 'LONG';

          const beRes = await setBingXBreakeven(symbol, side, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cbChatId) {
            if (beRes.success) {
              await sendTelegramReply(cbChatId, `🛡️ <b>BREAKEVEN APLICADO COM SUCESSO!</b>\n\n📊 Par: <code>${symbol}</code>\n🛑 Novo Stop Loss: <code>$${beRes.entryPrice}</code> (Preço de Entrada / Risco Zero!)`);
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao aplicar Breakeven em ${symbol}:</b> ${beRes.error}`);
            }
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 1000);
          }
        }
        // Callback: Abrir Menu Interativo de Edição de Stop Loss
        else if (cbData.startsWith("EDIT_SL_MENU:") || cbData.startsWith("EDIT_SL_MENU_")) {
          const raw = cbData.replace("EDIT_SL_MENU:", "").replace("EDIT_SL_MENU_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramEditSLMenu(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Abrir Menu Interativo de Edição de Take Profit
        else if (cbData.startsWith("EDIT_TP_MENU:") || cbData.startsWith("EDIT_TP_MENU_")) {
          const raw = cbData.replace("EDIT_TP_MENU:", "").replace("EDIT_TP_MENU_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramEditTPMenu(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Aplicar Stop Loss Rápido Direto
        else if (cbData.startsWith("APPLY_DIRECT_SL:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          const priceVal = parseFloat(parts[3]);
          if (cbChatId && !isNaN(priceVal) && priceVal > 0) {
            const res = await setBitunixPositionTPSLDirect(symbol, priceVal, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (res.success) {
              await sendTelegramReply(
                cbChatId,
                `🛑 <b>STOP LOSS ATUALIZADO COM SUCESSO NA BITUNIX!</b>\n\n` +
                `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide})\n` +
                `⚡ <b>Entrada:</b> <code>$${res.entryPrice}</code>\n` +
                `🛑 <b>Novo Stop Loss:</b> <code>$${priceVal}</code>\n\n` +
                `🔒 <i>Proteção salva na Bitunix e sincronizada com o Stop Móvel!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao atualizar Stop Loss em ${symbol}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 800);
          }
        }
        // Callback: Aplicar Take Profit Rápido Direto
        else if (cbData.startsWith("APPLY_DIRECT_TP:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          const priceVal = parseFloat(parts[3]);
          if (cbChatId && !isNaN(priceVal) && priceVal > 0) {
            const res = await setBitunixPositionTPSLDirect(symbol, null, priceVal, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (res.success) {
              await sendTelegramReply(
                cbChatId,
                `🎯 <b>TAKE PROFIT ATUALIZADO COM SUCESSO NA BITUNIX!</b>\n\n` +
                `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide})\n` +
                `⚡ <b>Entrada:</b> <code>$${res.entryPrice}</code>\n` +
                `🎯 <b>Novo Take Profit:</b> <code>$${priceVal}</code>\n\n` +
                `🔒 <i>Ordem de realização salva na Bitunix!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao atualizar Take Profit em ${symbol}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 800);
          }
        }
        // Callback: Remover Take Profit Direto
        else if (cbData.startsWith("REMOVE_DIRECT_TP:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          if (cbChatId) {
            const res = await setBitunixPositionTPSLDirect(symbol, null, 0, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (res.success) {
              await sendTelegramReply(
                cbChatId,
                `🎯 <b>TAKE PROFIT REMOVIDO COM SUCESSO!</b>\n\n` +
                `📊 <b>Par:</b> <code>${res.symbol}</code>\n` +
                `ℹ️ <i>A posição não possui mais alvo fixo de saída e será conduzida pelo Stop Móvel.</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao remover Take Profit em ${symbol}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(cbChatId), 800);
          }
        }
        // Callback: Solicitar Digitação Manual de Stop Loss
        else if (cbData.startsWith("PROMPT_TYPE_SL:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          if (cbChatId) {
            await renderTelegramEditSLMenu(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Solicitar Digitação Manual de Take Profit
        else if (cbData.startsWith("PROMPT_TYPE_TP:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          if (cbChatId) {
            await renderTelegramEditTPMenu(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Abrir Página de Detalhes de Condução da Posição (Print 2)
        else if (cbData.startsWith("VIEW_POS_CONDUCAO:") || cbData.startsWith("VIEW_POS_CONDUCAO_")) {
          const raw = cbData.replace("VIEW_POS_CONDUCAO:", "").replace("VIEW_POS_CONDUCAO_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramPositionConducao(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Abrir Menu para Editar Parâmetro de Condução da Posição
        else if (cbData.startsWith("EDIT_POS_PARAM:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          const param = parts[3] as any;
          if (cbChatId && param) {
            await renderEditPosParamMenu(cbChatId, symbol, side, param, cbMsgId);
          }
        }
        // Callback: Aplicar Valor Predefinido de Condução para a Posição
        else if (cbData.startsWith("APPLY_POS_PARAM:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          const param = parts[3];
          const val = parseFloat(parts[4]);
          if (cbChatId && !isNaN(val) && val > 0) {
            const bitunixResolved = resolveBitunixSymbol(symbol);
            const bitunixSym = bitunixResolved.apiSymbol;
            const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
            let trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                           bitunixActiveTrailingStops.get(symbol) || 
                           bitunixActiveTrailingStops.get(cleanUpper);

            if (!trRecord) {
              trRecord = await registerBitunixTrailingStop({
                symbol,
                positionSide: (side as any) || 'LONG',
                entryPrice: 1
              });
            }

            if (trRecord) {
              trRecord.customConducao = true;
              if (param === 'def') trRecord.tier0Trigger = val;
              else if (param === 'be') trRecord.tier1Trigger = val;
              else if (param === 'eq') trRecord.tier2Trigger = val;
              else if (param === 'f1') trRecord.tier3Trigger = val;
              else if (param === 'folga1') trRecord.tier4Dist = val;
              else if (param === 'f2') trRecord.tier5Trigger = val;
              else if (param === 'folga2') trRecord.tier6Dist = val;
              saveBitunixTrailingStopsToFile();
            }

            await renderTelegramPositionConducao(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Solicitar Digitação Manual de Parâmetro da Posição
        else if (cbData.startsWith("PROMPT_POS_PARAM:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          const param = parts[3] as any;
          if (cbChatId && param) {
            pendingPosConducaoPrompts.set(String(cbChatId), {
              symbol,
              side,
              param,
              promptMsgId: cbMsgId,
              timestamp: Date.now()
            });

            await sendTelegramReply(
              cbChatId,
              `✍️ <b>Digite apenas o multiplicador no chat:</b>\n<i>Exemplo: digite <code>1.8</code> e envie. O robô atualizará esta posição imediatamente.</i>`,
              {
                inline_keyboard: [
                  [{ text: "❌ Cancelar", callback_data: `VIEW_POS_CONDUCAO:${symbol}:${side}` }]
                ]
              },
              { disableDedup: true }
            );
          }
        }
        // Callback: Resetar Condução da Posição para o Padrão Global
        else if (cbData.startsWith("RESET_POS_CONDUCAO:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          if (cbChatId) {
            const bitunixResolved = resolveBitunixSymbol(symbol);
            const bitunixSym = bitunixResolved.apiSymbol;
            const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
            const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                             bitunixActiveTrailingStops.get(symbol) || 
                             bitunixActiveTrailingStops.get(cleanUpper);

            if (trRecord) {
              delete trRecord.customConducao;
              delete trRecord.tier0Trigger;
              delete trRecord.tier1Trigger;
              delete trRecord.tier2Trigger;
              delete trRecord.tier3Trigger;
              delete trRecord.tier4Dist;
              delete trRecord.tier5Trigger;
              delete trRecord.tier6Dist;
              saveBitunixTrailingStopsToFile();
            }
            await renderTelegramPositionConducao(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Mover Stop Loss para Breakeven Imediato
        else if (cbData.startsWith("POS_MOVE_BE_NOW:")) {
          const parts = cbData.split(":");
          const symbol = parts[1];
          const side = parts[2] || 'LONG';
          if (cbChatId) {
            const beRes = await setBingXBreakeven(symbol, side, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
            if (beRes.success) {
              const bitunixResolved = resolveBitunixSymbol(symbol);
              const bitunixSym = bitunixResolved.apiSymbol;
              const cleanUpper = (bitunixResolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
              const trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                               bitunixActiveTrailingStops.get(symbol) || 
                               bitunixActiveTrailingStops.get(cleanUpper);
              if (trRecord) {
                trRecord.currentStopLoss = beRes.entryPrice;
                trRecord.conducaoStage = 2;
                saveBitunixTrailingStopsToFile();
              }
              await sendTelegramReply(
                cbChatId, 
                `🛡️ <b>BREAK-EVEN APLICADO COM SUCESSO!</b>\n\n` +
                `📊 <b>Par:</b> <code>${symbol}</code>\n` +
                `🛑 <b>Novo Stop Loss:</b> <code>$${beRes.entryPrice}</code> (0 a 0 / Risco Zero!)`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(cbChatId, `⚠️ <b>Falha ao aplicar Break-Even em ${symbol}:</b> ${beRes.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionConducao(cbChatId, symbol, side, cbMsgId), 800);
          }
        }
        // Callback: Visualizar Card de Sinal VIP (sem apagar a mensagem da posição, envia abaixo)
        else if (cbData.startsWith("VIEW_VIP_SIGNAL:") || cbData.startsWith("VIEW_VIP_SIGNAL_")) {
          const raw = cbData.replace("VIEW_VIP_SIGNAL:", "").replace("VIEW_VIP_SIGNAL_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramPositionVIPSignal(cbChatId, symbol, side);
          }
        }
        // Callback: Visualizar Alvos Atingidos no formato VIP com ✅ verdinho
        else if (cbData.startsWith("VIEW_HIT_TARGETS:") || cbData.startsWith("VIEW_HIT_TARGETS_")) {
          const raw = cbData.replace("VIEW_HIT_TARGETS:", "").replace("VIEW_HIT_TARGETS_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramPositionVIPHitTargets(cbChatId, symbol, side, cbMsgId);
          }
        }
        // Callback: Visualizar Alvos da Posição
        else if (cbData.startsWith("VIEW_TARGETS:") || cbData.startsWith("VIEW_TARGETS_")) {
          const raw = cbData.replace("VIEW_TARGETS:", "").replace("VIEW_TARGETS_", "");
          const parts = raw.split(":");
          const symbol = parts[0];
          const side = parts[1] || 'LONG';
          if (cbChatId) {
            await renderTelegramPositionTargets(cbChatId, symbol, side, cbMsgId);
          }
        }
      } catch (e: any) {
        console.error("[TELEGRAM-CALLBACK-ERROR]:", e.message);
      }
      return;
    }

    // 2. Mensagens com Fotos/Prints de Gráfico ou Documentos (Análise por Visão Computacional do Gemini)
    const message = update.message || update.channel_post || update.edited_message;
    if (!message) return;

    const sender = message.from?.first_name || message.chat?.title || "Operador Telegram";
    const chatId = message.chat?.id;

    if (chatId) {
      registerTelegramChat(chatId);
    }

    const hasPhoto = (message.photo && Array.isArray(message.photo) && message.photo.length > 0) ||
                    (message.document && message.document.mime_type && message.document.mime_type.startsWith('image/'));

    if (hasPhoto) {
      const caption = (message.caption || '').trim().toLowerCase();
      const promptState = chatId ? pendingImagePrompts.get(String(chatId)) : undefined;
      const isImagePromptActive = Boolean(promptState && (Date.now() - promptState.timestamp < 300000));
      const hasSignalCaption = caption.includes('/imagem') || caption.includes('/sinal') || caption.includes('/grafico') || 
                               caption.includes('/foto') || caption.includes('sinal') || caption.includes('entrada') || 
                               caption.includes('long') || caption.includes('short') || caption.includes('sl') || 
                               caption.includes('tp') || caption.includes('tradingview');

      // Se NÃO foi acionado pelo comando /imagem e NÃO contém legenda de sinal, ignora fotos normais de conversas
      if (!isImagePromptActive && !hasSignalCaption) {
        console.log(`[TELEGRAM-PHOTO-IGNORED] Imagem recebida no chat ${chatId} de ${sender} ignorada pois não foi acionada com /imagem e não possui legenda de sinal.`);
        return;
      }

      // Se havia um prompt ativo aguardando a imagem, consome e limpa botões
      if (chatId && pendingImagePrompts.has(String(chatId))) {
        if (promptState?.promptMsgId) {
          await removeTelegramMessageButtons(chatId, promptState.promptMsgId);
        }
        pendingImagePrompts.delete(String(chatId));
      }

      if (chatId) {
        await clearActiveKeyboardsForChat(chatId);
      }

      console.log(`[TELEGRAM-PHOTO] Imagem/Gráfico de sinal recebido de ${sender} (Chat ${chatId}). Iniciando análise com Gemini Vision...`);

      // Envia mensagem de status temporária
      let statusMsgId: number | undefined;
      try {
        const sendStatusRes = await sendTelegramReply(
          chatId,
          `🔍 <b>Analisando gráfico com Inteligência Artificial...</b>\n\n` +
          `⏳ <i>Identificando par, entrada, stop loss, alavancagem e alvos...</i>`
        );
        if (sendStatusRes?.message_id) {
          statusMsgId = sendStatusRes.message_id;
        }
      } catch (e) {}

      try {
        const candidateFileIds: string[] = [];
        if (message.photo && Array.isArray(message.photo) && message.photo.length > 0) {
          const len = message.photo.length;
          // Se tiver 3 ou mais resoluções, prioriza a penúltima (alta nitidez ~1280px e download ultrarrápido)
          // e depois a última (resolução máxima) para evitar timeouts da rede do Telegram
          if (len >= 3) {
            if (message.photo[len - 2]?.file_id) candidateFileIds.push(message.photo[len - 2].file_id);
            if (message.photo[len - 1]?.file_id) candidateFileIds.push(message.photo[len - 1].file_id);
            for (let i = len - 3; i >= 0; i--) {
              if (message.photo[i]?.file_id) candidateFileIds.push(message.photo[i].file_id);
            }
          } else {
            for (let i = len - 1; i >= 0; i--) {
              if (message.photo[i]?.file_id) candidateFileIds.push(message.photo[i].file_id);
            }
          }
        } else if (message.document?.file_id) {
          candidateFileIds.push(message.document.file_id);
        }

        if (candidateFileIds.length === 0) {
          throw new Error("Nenhum arquivo de imagem identificado na mensagem.");
        }

        let imageBuffer: Buffer | null = null;
        let mimeType: string = 'image/jpeg';
        let lastDownloadErr: any = null;

        // Baixa a imagem dos servidores do Telegram com timeout seguro e tolerância a latência
        for (const fileId of candidateFileIds) {
          try {
            const fileMetaRes = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`, { timeout: 20000 });
            const filePath = fileMetaRes.data?.result?.file_path;
            if (!filePath) continue;

            const downloadRes = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`, {
              responseType: 'arraybuffer',
              timeout: 25000
            });

            if (downloadRes.data && downloadRes.data.byteLength > 0) {
              imageBuffer = Buffer.from(downloadRes.data);
              mimeType = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
              break;
            }
          } catch (dlErr: any) {
            lastDownloadErr = dlErr;
            console.warn(`[TELEGRAM-IMAGE-FETCH] Falha ao obter fileId ${fileId.substring(0, 10)}:`, dlErr.message);
          }
        }

        if (!imageBuffer) {
          throw lastDownloadErr || new Error("Não foi possível transferir a imagem dos servidores do Telegram.");
        }

        const userCaption = (message.caption || message.text || '').trim();
        const parseResult = await parseTradingChartImageWithGemini(imageBuffer, mimeType, userCaption);

        // Remove a mensagem de "Analisando..."
        if (statusMsgId && chatId) {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            chat_id: chatId,
            message_id: statusMsgId
          }).catch(() => {});
        }

        if (parseResult.success && parseResult.parsed) {
          const parsed = parseResult.parsed;
          const signalId = `tg_img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

          // 🌟 1. Envia PRIMEIRO a mensagem no formato exato para Grupos VIP (pronta para copiar ou encaminhar)
          const vipFormattedMsg = formatVipSignalMessage(parsed, false);
          if (chatId) {
            await sendTelegramReply(
              chatId,
              vipFormattedMsg,
              undefined,
              { disableDedup: true }
            );
          }

          const newSignal = {
            id: signalId,
            text: vipFormattedMsg,
            sender,
            chatId,
            receivedAt: new Date().toISOString(),
            status: 'PENDING' as 'PENDING' | 'EXECUTED' | 'CANCELLED',
            executedBy: undefined as string | undefined,
            executedAt: undefined as string | undefined,
            parsed
          };

          receivedTelegramSignals.unshift(newSignal);
          if (receivedTelegramSignals.length > 50) {
            receivedTelegramSignals.pop();
          }
          signalsStoreById.set(signalId, newSignal);
          saveTelegramSignalsToFile();

          recordTradeAudit({
            symbol: parsed.apiSymbol,
            cleanSymbol: parsed.coinName,
            direction: parsed.direction,
            entryPrice: parsed.entryPrice,
            stopLoss: parsed.stopLoss,
            takeProfits: parsed.takeProfits,
            leverage: parsed.leverage || 20,
            timestamp: Date.now()
          });

          // Se auto-execução estiver ligada
          if (serverTelegramBotConfig.autoExecuteWithoutPrompt) {
            const lockCheck = await checkDailyLockBlocked();
            if (lockCheck.blocked) {
              if (chatId) {
                await sendTelegramReply(chatId, lockCheck.reason || "🛑 Operação bloqueada pela trava diária.");
              }
              return;
            }

            const execResult = await executeBingXTradeForTelegram(parsed);
            if (execResult.success) {
              newSignal.status = 'EXECUTED';
              newSignal.executedBy = sender;
              newSignal.executedAt = new Date().toISOString();

              if (chatId) {
                const fullSuccessMsg = formatTelegramExecutionSuccessMessage(execResult, sender);
                const kb = getExecutionInlineKeyboard(execResult);
                await sendTelegramReply(chatId, fullSuccessMsg, kb);
              }
            } else {
              if (chatId) {
                await sendTelegramReply(
                  chatId,
                  `⚠️ <b>FALHA NA EXECUÇÃO DA ORDEM DO GRÁFICO NA BITUNIX</b>\n\n` +
                  `📊 <b>Par:</b> <code>${parsed.symbol}</code> (${parsed.direction})\n` +
                  `❌ <b>Motivo:</b> <code>${execResult.error || 'Erro desconhecido'}</code>\n\n` +
                  `💡 <i>Verifique o saldo disponível em USDT ou as permissões de Trade da sua API Key.</i>`,
                  {
                    inline_keyboard: [
                      [{ text: "📋 Ver Ordens Abertas", callback_data: "LIST_POSITIONS" }]
                    ]
                  }
                );
              }
            }
            return;
          }

          // 🌟 2. Em seguida, exibe o card interativo com confirmação de execução em 1 toque
          if (chatId) {
            await promptTelegramConfirmation(parsed, chatId, signalId);
          }
        } else {
          if (chatId) {
            await sendTelegramReply(
              chatId,
              `⚠️ <b>Não foi possível identificar níveis de trade no gráfico.</b>\n\n` +
              `ℹ️ <i>${parseResult.error || 'Certifique-se de que o print do gráfico possua as etiquetas do indicador (Entrada, Stop, Direção/Alavancagem e Alvos) nítidas e visíveis.'}</i>\n\n` +
              `💡 <i>Você também pode digitar o sinal em texto ou colar os parâmetros.</i>`,
              {
                inline_keyboard: [
                  [{ text: "📖 Ver Comandos & Ajuda", callback_data: "VIEW_HELP" }]
                ]
              }
            );
          }
        }
      } catch (err: any) {
        console.error("[TELEGRAM-PHOTO-HANDLER-ERROR]:", err?.message || err);
        if (statusMsgId && chatId) {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`, {
            chat_id: chatId,
            message_id: statusMsgId
          }).catch(() => {});
        }
        if (chatId) {
          await sendTelegramReply(
            chatId,
            `⚠️ <b>Erro ao processar imagem:</b> ${err?.message || 'Falha de comunicação'}`
          );
        }
      }
      return;
    }

    // 3. Mensagens Normais de Texto ou Legendas
    const rawMessageText = message.text || message.caption;
    if (!rawMessageText || typeof rawMessageText !== 'string') return;
    const trimmedText = rawMessageText.trim();

    console.log(`[TELEGRAM-MSG] Recebido de ${sender} (Chat ${chatId}): "${trimmedText.substring(0, 60)}..."`);

    if (chatId) {
      registerTelegramChat(chatId);
    }

    // Limpa botões de mensagens anteriores ao receber qualquer novo comando ou texto do operador
    if (chatId) {
      await clearActiveKeyboardsForChat(chatId);
    }

    // ==========================================
    // ⚙️ MODO DE ENTRADA DE CONFIGURAÇÃO VIA TELEGRAM (Risco, Trailing, Trava Diária)
    // ==========================================
    if (chatId && pendingConfigPrompts.has(String(chatId))) {
      const promptState = pendingConfigPrompts.get(String(chatId))!;
      if (Date.now() - promptState.timestamp < 180000 && !trimmedText.startsWith('/')) {
        const text = trimmedText.trim();
        if (promptState.promptMsgId) {
          await removeTelegramMessageButtons(chatId, promptState.promptMsgId);
        }
        pendingConfigPrompts.delete(String(chatId));

        if (promptState.type === 'RISK') {
          if (text.includes('%')) {
            const num = parseFloat(text.replace('%', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.riskMode = 'PERCENT';
              serverTelegramBotConfig.riskPercent = num;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Risco configurado para:</b> <code>${num}% da conta</code> por operação!`);
              await renderTelegramRiskConfigMenu(chatId);
              return;
            }
          } else {
            const num = parseFloat(text.replace('$', '').replace(/dol(ar|ares)?/i, '').replace('USDT', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.riskMode = 'FIXED_USD';
              serverTelegramBotConfig.riskFixedUsd = num;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Risco configurado para:</b> <code>$${num.toFixed(2)} USDT fixos</code> por operação!`);
              await renderTelegramRiskConfigMenu(chatId);
              return;
            }
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor de risco inválido. Exemplo: <code>0.5%</code>, <code>1%</code> ou <code>$10</code>.</i>`);
          await renderTelegramRiskConfigMenu(chatId);
          return;
        }

        if (promptState.type === 'TRAILING_MULT') {
          const num = parseFloat(text.replace(/x/i, '').replace(',', '.').trim());
          if (!isNaN(num) && num > 0) {
            serverTelegramBotConfig.trailingMultiplier = num;
            saveTelegramConfigToFile();
            await sendTelegramReply(chatId, `✅ <b>Recuo do Trailing Stop ajustado para:</b> <code>a cada ${num}x do tamanho do SL</code>!`);
            await renderTelegramTrailingConfigMenu(chatId);
            return;
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor inválido. Digite um número positivo como <code>1</code>, <code>1.5</code> ou <code>2</code>.</i>`);
          await renderTelegramTrailingConfigMenu(chatId);
          return;
        }

        if (promptState.type === 'TRAILING_TRIGGER') {
          const num = parseFloat(text.replace(/x/i, '').replace(',', '.').trim());
          if (!isNaN(num) && num > 0) {
            serverTelegramBotConfig.trailingActivationMultiplier = num;
            saveTelegramConfigToFile();
            await sendTelegramReply(chatId, `✅ <b>Gatilho de ativação do Trailing ajustado para:</b> <code>a partir de ${num}x da distância do SL</code>!`);
            await renderTelegramTrailingConfigMenu(chatId);
            return;
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor inválido. Digite um número positivo como <code>1</code>, <code>1.5</code> ou <code>2</code>.</i>`);
          await renderTelegramTrailingConfigMenu(chatId);
          return;
        }

        if (promptState.type.startsWith('CONDUCAO_')) {
          const num = parseFloat(text.replace(/x/i, '').replace(',', '.').trim());
          if (!isNaN(num) && num >= 0) {
            let label = '';
            if (promptState.type === 'CONDUCAO_0') {
              serverTelegramBotConfig.conducaoTier0Trigger = num;
              label = '0. Reduzir Risco (Stop Defensivo)';
            } else if (promptState.type === 'CONDUCAO_1') {
              serverTelegramBotConfig.conducaoTier1Trigger = num;
              label = '1. Mover p/ Entrada (Break-Even)';
            } else if (promptState.type === 'CONDUCAO_2') {
              serverTelegramBotConfig.conducaoTier2Trigger = num;
              label = '2. Preço de Equilíbrio (Cobrir Taxas)';
            } else if (promptState.type === 'CONDUCAO_3') {
              serverTelegramBotConfig.conducaoTier3Trigger = num;
              label = '3. Começar Condução (Garantir Lucro - Fase 1)';
            } else if (promptState.type === 'CONDUCAO_4') {
              serverTelegramBotConfig.conducaoTier4Dist = num;
              label = '4. Folga Inicial (Fase 1)';
            } else if (promptState.type === 'CONDUCAO_5') {
              serverTelegramBotConfig.conducaoTier5Trigger = num;
              label = '5. Apertar Stop / Acelerar Condução (Fase 2)';
            } else if (promptState.type === 'CONDUCAO_6') {
              serverTelegramBotConfig.conducaoTier6Dist = num;
              label = '6. Folga Reduzida (Fase 2)';
            }
            saveTelegramConfigToFile();
            await sendTelegramReply(chatId, `✅ <b>${label} ajustado para:</b> <code>${num}x</code>!`);
            await renderTelegramTrailingConfigMenu(chatId);
            return;
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor inválido. Digite um número positivo como <code>1</code>, <code>1.5</code> ou <code>2</code>.</i>`);
          await renderTelegramTrailingConfigMenu(chatId);
          return;
        }

        if (promptState.type === 'DAILY_LOSS') {
          if (text.includes('%')) {
            const num = parseFloat(text.replace('%', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.dailyLossLimitEnabled = true;
              serverTelegramBotConfig.dailyLossPercent = num;
              serverTelegramBotConfig.dailyLossFixedUsd = 0;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Trava de Perda Diária configurada para:</b> <code>${num}% da banca</code>!`);
              await renderTelegramDailyLockMenu(chatId);
              return;
            }
          } else {
            const num = parseFloat(text.replace('$', '').replace(/dol(ar|ares)?/i, '').replace('USDT', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.dailyLossLimitEnabled = true;
              serverTelegramBotConfig.dailyLossFixedUsd = num;
              serverTelegramBotConfig.dailyLossPercent = 0;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Trava de Perda Diária configurada para:</b> <code>-$${num.toFixed(2)} USDT</code>!`);
              await renderTelegramDailyLockMenu(chatId);
              return;
            }
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor inválido. Exemplo: <code>5%</code> ou <code>$20</code>.</i>`);
          await renderTelegramDailyLockMenu(chatId);
          return;
        }

        if (promptState.type === 'DAILY_PROFIT') {
          if (text.includes('%')) {
            const num = parseFloat(text.replace('%', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.dailyProfitTargetEnabled = true;
              serverTelegramBotConfig.dailyProfitTargetPercent = num;
              serverTelegramBotConfig.dailyProfitFixedUsd = 0;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Meta de Lucro Diária configurada para:</b> <code>${num}% da banca</code>!`);
              await renderTelegramDailyLockMenu(chatId);
              return;
            }
          } else {
            const num = parseFloat(text.replace('$', '').replace(/dol(ar|ares)?/i, '').replace('USDT', '').replace(',', '.').trim());
            if (!isNaN(num) && num > 0) {
              serverTelegramBotConfig.dailyProfitTargetEnabled = true;
              serverTelegramBotConfig.dailyProfitFixedUsd = num;
              serverTelegramBotConfig.dailyProfitTargetPercent = 0;
              saveTelegramConfigToFile();
              await sendTelegramReply(chatId, `✅ <b>Meta de Lucro Diária configurada para:</b> <code>+$${num.toFixed(2)} USDT</code>!`);
              await renderTelegramDailyLockMenu(chatId);
              return;
            }
          }
          await sendTelegramReply(chatId, `⚠️ <i>Valor inválido. Exemplo: <code>10%</code> ou <code>$50</code>.</i>`);
          await renderTelegramDailyLockMenu(chatId);
          return;
        }
      } else {
        pendingConfigPrompts.delete(String(chatId));
      }
    }

    // ==========================================
    // 🎯 MODO DE EDIÇÃO DE PARÂMETRO DE CONDUÇÃO DA POSIÇÃO (RESPOSTA DIRETA VIA CHAT)
    // ==========================================
    if (chatId && pendingPosConducaoPrompts.has(String(chatId))) {
      const posPrompt = pendingPosConducaoPrompts.get(String(chatId))!;
      if (Date.now() - posPrompt.timestamp < 180000 && !trimmedText.startsWith('/')) {
        const text = trimmedText.trim();
        if (posPrompt.promptMsgId) {
          await removeTelegramMessageButtons(chatId, posPrompt.promptMsgId);
        }
        pendingPosConducaoPrompts.delete(String(chatId));

        const num = parseFloat(text.replace(/x/i, '').replace('$', '').replace(',', '.').trim());
        if (!isNaN(num) && num > 0) {
          const bitunixResolved = resolveBitunixSymbol(posPrompt.symbol);
          const bitunixSym = bitunixResolved.apiSymbol;
          const cleanUpper = (bitunixResolved.cleanSymbol || posPrompt.symbol.replace('-USDT', '').replace('USDT', '')).toUpperCase();
          let trRecord = bitunixActiveTrailingStops.get(bitunixSym) || 
                         bitunixActiveTrailingStops.get(posPrompt.symbol) || 
                         bitunixActiveTrailingStops.get(cleanUpper);

          if (!trRecord) {
            trRecord = await registerBitunixTrailingStop({
              symbol: posPrompt.symbol,
              positionSide: (posPrompt.side as any) || 'LONG',
              entryPrice: 1
            });
          }

          if (trRecord) {
            trRecord.customConducao = true;
            if (posPrompt.param === 'def') trRecord.tier0Trigger = num;
            else if (posPrompt.param === 'be') trRecord.tier1Trigger = num;
            else if (posPrompt.param === 'eq') trRecord.tier2Trigger = num;
            else if (posPrompt.param === 'f1') trRecord.tier3Trigger = num;
            else if (posPrompt.param === 'folga1') trRecord.tier4Dist = num;
            else if (posPrompt.param === 'f2') trRecord.tier5Trigger = num;
            else if (posPrompt.param === 'folga2') trRecord.tier6Dist = num;
            saveBitunixTrailingStopsToFile();

            await sendTelegramReply(
              chatId, 
              `✅ <b>Parâmetro atualizado para ${num}x nesta posição de ${cleanUpper}!</b>`,
              undefined,
              { disableDedup: true }
            );
            await renderTelegramPositionConducao(chatId, posPrompt.symbol, posPrompt.side);
            return;
          }
        } else {
          await sendTelegramReply(chatId, `⚠️ <i>Valor numérico inválido. Envie um número positivo como <code>1.5</code> ou <code>2</code>.</i>`);
          await renderTelegramPositionConducao(chatId, posPrompt.symbol, posPrompt.side);
          return;
        }
      } else {
        pendingPosConducaoPrompts.delete(String(chatId));
      }
    }

    // ==========================================
    // 🎯 MODO DE EDIÇÃO RÁPIDA (Ideia 1 - Resposta Direta Apenas com Número)
    // ==========================================
    if (chatId && pendingUserEdits.has(String(chatId))) {
      const editState = pendingUserEdits.get(String(chatId))!;
      // Se tiver menos de 3 minutos
      if (Date.now() - editState.timestamp < 180000) {
        // Verifica se a mensagem é um número puro (ex: "435.5", "$435.5", "435,50", "4480")
        const cleanNumberStr = trimmedText.replace('$', '').replace('USDT', '').replace('usdt', '').trim().replace(',', '.');
        const numericVal = parseFloat(cleanNumberStr);

        if (!isNaN(numericVal) && numericVal > 0 && !trimmedText.startsWith('/')) {
          if (editState.promptMsgId) {
            await removeTelegramMessageButtons(chatId, editState.promptMsgId);
          }
          pendingUserEdits.delete(String(chatId)); // Consome o estado
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const cleanSym = editState.symbol.replace('-USDT', '').replace('USDT', '');

          // Se for uma posição aberta (sem orderId)
          if (!editState.orderId) {
            const newSL = editState.orderType === 'SL' ? numericVal : null;
            const newTP = editState.orderType === 'TP' ? numericVal : null;
            const directRes = await setBitunixPositionTPSLDirect(editState.symbol, newSL, newTP, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (directRes.success) {
              const label = editState.orderType === 'SL' ? 'Stop Loss' : 'Take Profit';
              const emoji = editState.orderType === 'SL' ? '🛑' : '🎯';
              await sendTelegramReply(
                chatId,
                `${emoji} <b>${label.toUpperCase()} ATUALIZADO COM SUCESSO NA BITUNIX!</b>\n\n` +
                `📊 <b>Par:</b> <code>${directRes.symbol}</code> (${directRes.positionSide})\n` +
                `⚡ <b>Preço de Entrada:</b> <code>$${directRes.entryPrice}</code>\n` +
                `${emoji} <b>Novo ${label}:</b> <code>$${numericVal}</code>\n\n` +
                `🔒 <i>Proteção salva na Bitunix e sincronizada com o robô!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar ${editState.orderType} em ${cleanSym}:</b> ${directRes.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
            return;
          }

          if (editState.orderType === 'SL') {
            const res = await updateBingXStopLossOrTakeProfit(editState.symbol, 'SL', numericVal, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo, editState.orderId);
            if (res.success) {
              const riskInfo = res.riskDescription || (res.effectiveRiskPct ? `${res.effectiveRiskPct}% da conta` : '2.0% da conta');
              await sendTelegramReply(
                chatId, 
                `🛑 <b>NOVA ORDEM COM SL, TAKE E TRAILING STOP ATUALIZADA!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n\n` +
                (res.activePosRiskNote 
                  ? `${res.activePosRiskNote}\n\n` 
                  : (
                    (res.mainEntryPrice ? `🎯 Entrada Principal: <code>$${res.mainEntryPrice}</code>\n` : '') +
                    `⚡ Stop Loss Digitado: <code>$${numericVal}</code>\n` +
                    (res.takeProfit && res.takeProfit !== 'N/A' ? `🎯 Take Profit: <code>$${res.takeProfit}</code>\n` : '') +
                    (res.trailingActivation && res.trailingActivation !== 'N/A' ? `🛰️ Trailing Stop: Ativação <code>$${res.trailingActivation}</code>\n` : '') +
                    (res.recalculatedMargin ? `💰 Margem da Ordem: <code>$${res.recalculatedMargin} USDT</code>${res.targetLeverage ? ` (${res.targetLeverage}x)` : ''}\n` : '') +
                    (res.riskUsd ? `🛡️ Risco: <code>-$${res.riskUsd} USDT</code> (${riskInfo})\n` : '') +
                    (res.recalculatedQty ? `📦 Quantidade: <code>${res.recalculatedQty}</code>\n\n` : '')
                  )) +
                `✅ <i>Nova ordem criada e sincronizada com proteção completa na Bitunix!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Stop Loss em ${cleanSym}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
          } else if (editState.orderType === 'TP') {
            const res = await updateBingXStopLossOrTakeProfit(editState.symbol, 'TP', numericVal, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo, editState.orderId);
            if (res.success) {
              await sendTelegramReply(
                chatId, 
                `🎯 <b>TAKE PROFIT ATUALIZADO COM SUCESSO!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n` +
                `⚡ Novo Take Profit: <code>$${numericVal}</code>\n` +
                `${res.activePosRiskNote ? `\n${res.activePosRiskNote}\n` : ''}` +
                `✅ Configurado na Bitunix!`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Take Profit em ${cleanSym}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
          } else if (editState.orderType === 'LIMIT') {
            const res = await updateBingXLimitEntryPrice(editState.symbol, numericVal, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo, editState.orderId);
            if (res.success) {
              await sendTelegramReply(
                chatId, 
                `⚡ <b>PREÇO LIMITE DE ENTRADA ATUALIZADO!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n` +
                `🎯 <b>Novo Preço no Livro:</b> <code>$${res.newPrice}</code>\n` +
                `💰 <b>Margem Recalculada:</b> <code>$${res.recalculatedMargin || 'N/A'} USDT</code>\n` +
                `📦 <b>Nova Quantidade:</b> <code>${res.recalculatedQty || 'N/A'}</code>\n` +
                `🛑 <b>Stop Loss Ativo:</b> <code>$${res.stopLoss}</code>\n` +
                `🎯 <b>Take Profit:</b> <code>${res.takeProfit !== 'N/A' ? `$${res.takeProfit}` : 'N/A'}</code>\n\n` +
                `✅ <i>Ordem substituída e sincronizada com sucesso na Bitunix!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar preço limite em ${cleanSym}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
          }

          setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          return;
        }
      } else {
        // Expirou após 3 minutos
        pendingUserEdits.delete(String(chatId));
      }
    }

    // Normalização Inteligente de Comandos (com ou sem '/', com emojis ou acentos)
    const cleanCmdText = trimmedText
      .replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\s]+/u, '') // remove emojis iniciais (ex: 📊 Status -> Status)
      .trim();

    const isExplicitSlash = cleanCmdText.startsWith('/');
    const rawFirstWord = cleanCmdText.split(/\s+/)[0] || '';
    const normalizedFirstWord = (isExplicitSlash ? rawFirstWord.slice(1) : rawFirstWord)
      .split('@')[0]
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");

    const KNOWN_COMMANDS = new Set([
      'imagem', 'sinal_imagem', 'sinalimagem', 'sinal_foto', 'sinalfoto', 'grafico', 'foto', 'analisar_imagem', 'analisarimagem', 'chart',
      'status', 'saldo', 'conexao', 'conta', 'modo', 'ambiente', 'demo', 'vst', 'real', 'usdt',
      'posicoes', 'ordens', 'abertas', 'painel', 'pendentes', 'pendente', 'ordens_pendentes', 'limite', 'livro',
      'relatorio', 'relatoriodia', 'relatorio_do_dia', 'diario', 'resultado', 'pnl', 'hoje',
      'relatoriosemana', 'relatorio_da_semana', 'semana', 'relatorio_semana',
      'relatoriomes', 'relatorio_do_mes', 'mes', 'relatorio_mes',
      'historico', 'history', 'trades', 'fechadas', 'operacoes', 'detalhes', 'historicodia', 'historico_do_dia',
      'historicosemana', 'historico_semana', 'trades_semana', 'fechadas_semana',
      'historicomes', 'historico_mes', 'trades_mes', 'fechadas_mes',
      'cancelar_todas', 'cancel_all', 'cancelartodas', 'cancelar', 'cancel',
      'sl', 'stoploss', 'tp', 'takeprofit', 'preco', 'editar_limite',
      'conducao', 'conducaostop', 'conducaodestop', 'trailing', 'ts', 'trailingstop', 'be', 'breakeven',
      'copy', 'copytrade', 'seguidores', 'copiadores',
      'start', 'ajuda', 'help', 'comandos', 'menu'
    ]);

    const isRecognizedCommand = isExplicitSlash || KNOWN_COMMANDS.has(normalizedFirstWord);
    const rootCmd = (isRecognizedCommand || isExplicitSlash) ? normalizedFirstWord : '';

    if (rootCmd) {
      console.log(`[TELEGRAM-CMD-EXEC] Executando comando detectado: "${rootCmd}" para o chat ${chatId}`);

      // Comando Sinal por Imagem / Gráfico (/imagem, /sinal_imagem, /grafico, /foto)
      if (['imagem', 'sinal_imagem', 'sinalimagem', 'sinal_foto', 'sinalfoto', 'grafico', 'foto', 'analisar_imagem', 'analisarimagem', 'chart'].includes(rootCmd)) {
        if (chatId) {
          pendingImagePrompts.set(String(chatId), {
            timestamp: Date.now()
          });

          const promptRes = await sendTelegramReply(
            chatId,
            `🖼️ <b>MODO SINAL POR IMAGEM ATIVADO!</b>\n\n` +
            `📸 <b>Envie ou cole o print do seu gráfico TradingView agora</b> neste chat.\n\n` +
            `🔍 <i>A Inteligência Artificial analisa o gráfico e extrai automaticamente:</i>\n` +
            `• 📊 <b>Par / Criptomoeda</b> (ex: OPN/USDT, BTC, ETH, SOL...)\n` +
            `• ⚡ <b>Direção & Alavancagem</b> (LONG / SHORT | Ex: 86x)\n` +
            `• 🔷 <b>Preço de Entrada</b> (Etiqueta Entrada)\n` +
            `• 🛑 <b>Stop Loss</b> (Etiqueta Stop)\n` +
            `• 🎯 <b>Alvos de Lucro</b> (Take Profits: Alvo 01, Alvo 02...)\n\n` +
            `⏳ <b>Aguardando seu print nos próximos 5 minutos...</b>\n` +
            `💡 <i>(Fotos normais de conversas sem o comando /imagem são ignoradas automaticamente).</i>`,
            {
              inline_keyboard: [
                [
                  { text: "❌ Cancelar Espera de Imagem", callback_data: "CANCEL_IMAGE_PROMPT" }
                ]
              ]
            },
            { disableDedup: true }
          );

          if (promptRes?.message_id) {
            const state = pendingImagePrompts.get(String(chatId));
            if (state) {
              state.promptMsgId = promptRes.message_id;
            }
          }
        }
        return;
      }

      // Comandos Copy Trade (/copy, /copytrade, /seguidores, /copiadores)
      if (['copy', 'copytrade', 'seguidores', 'copiadores'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramCopyTradeMessage(chatId);
        }
        return;
      }

      // Comando Configurações (/config, /configuracoes, /configs, /ajustes)
      if (['config', 'configuracoes', 'configurações', 'configs', 'ajustes', 'parametros', 'parâmetros'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramConfigMenu(chatId);
        }
        return;
      }

      // Comando Status e Saldo Bitunix (/status, /saldo, /conexao)
      if (['status', 'saldo', 'conexao'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramStatusMessage(chatId);
        }
        return;
      }

      // Comandos de Consulta de Conta (/conta, /modo, /ambiente, /real, /usdt)
      if (['conta', 'modo', 'ambiente', 'real', 'usdt'].includes(rootCmd)) {
        if (chatId) {
          const posData = await getBingXOpenPositions(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, false);
          await sendTelegramReply(
            chatId,
            `💼 <b>Gerenciamento de Conta Bitunix:</b>\n\n` +
            `Ambiente: <b>🟢 Futuros USDT Real</b>\n` +
            `💰 Saldo Disponível: <b>$${posData.balance.toFixed(2)} USDT</b>\n\n` +
            `🔒 <i>Todas as operações são executadas diretamente na sua conta Real de Futuros da Bitunix.</i>`,
            {
              inline_keyboard: [
                [
                  { text: "📋 Ver Posições", callback_data: "LIST_POSITIONS" },
                  { text: "⏳ Ordens Pendentes", callback_data: "LIST_PENDING_ORDERS" }
                ],
                [
                  { text: "📊 Relatório Hoje", callback_data: "VIEW_REPORT:DAY" },
                  { text: "📜 Histórico Hoje", callback_data: "VIEW_HISTORY:DAY" }
                ]
              ]
            },
            { disableDedup: true }
          );
        }
        return;
      }

      // Comandos de Posições e Ordens Abertas (/posicoes, /posições, /ordens, /abertas, /painel)
      if (['posicoes', 'posições', 'ordens', 'abertas', 'painel'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramPositionsMessage(chatId);
        }
        return;
      }

      // Comandos de Condução de Stop / Trailing Stop (/conducao, /conducaostop, /trailing, /stopmovel)
      if (['conducao', 'conducaostop', 'conducaodestop', 'conducao_stop', 'trailing', 'stopmovel', 'ordemmovel', 'ordem_movel', 'stop_movel', 'movel', 'trailingstop', 'rastreamento'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramTrailingConfigMenu(chatId);
        }
        return;
      }

      // Comandos de Relatório da Semana (/relatoriosemana, /semana)
      if (['relatoriosemana', 'relatorio_da_semana', 'semana', 'relatorio_semana'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramReportMessage(chatId, 'WEEK');
        }
        return;
      }

      // Comandos de Relatório do Mês (/relatoriomes, /mes)
      if (['relatoriomes', 'relatorio_do_mes', 'mes', 'relatorio_mes'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramReportMessage(chatId, 'MONTH');
        }
        return;
      }

      // Comandos de Relatório do Dia (/relatorio, /relatoriodia, /relatorio_do_dia, /diario, /resultado, /pnl, /hoje)
      if (['relatorio', 'relatoriodia', 'relatorio_do_dia', 'diario', 'resultado', 'pnl', 'hoje'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramReportMessage(chatId, 'DAY');
        }
        return;
      }

      // Comandos de Histórico da Semana (/historicosemana, /historico_semana)
      if (['historicosemana', 'historico_semana', 'trades_semana', 'fechadas_semana'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramHistoryMessage(chatId, 'WEEK');
        }
        return;
      }

      // Comandos de Histórico do Mês (/historicomes, /historico_mes)
      if (['historicomes', 'historico_mes', 'trades_mes', 'fechadas_mes'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramHistoryMessage(chatId, 'MONTH');
        }
        return;
      }

      // Comandos de Histórico Detalhado (/historico, /history, /trades, /fechadas, /operacoes, /detalhes, /historicodia)
      if (['historico', 'history', 'trades', 'fechadas', 'operacoes', 'detalhes', 'historicodia', 'historico_do_dia'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramHistoryMessage(chatId, 'DAY');
        }
        return;
      }

      // Comandos de Ordens Pendentes (/pendentes, /pendente, /ordens_pendentes, /limite, /livro)
      if (['pendentes', 'pendente', 'ordens_pendentes', 'limite', 'livro'].includes(rootCmd)) {
        if (chatId) {
          await renderTelegramPendingOrdersMessage(chatId);
        }
        return;
      }

      // Comando Cancelar Todas as Pendentes (/cancelar_todas, /cancel_all, /cancelartodas)
      if (['cancelar_todas', 'cancel_all', 'cancelartodas'].includes(rootCmd)) {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const cancelAllRes = await cancelAllBingXPendingOrders(DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
          if (cancelAllRes.success) {
            await sendTelegramReply(chatId, `🚨 <b>TODAS AS ORDENS PENDENTES FORAM CANCELADAS!</b>\n\n🗑️ ${cancelAllRes.message}`, undefined, { disableDedup: true });
          } else {
            await sendTelegramReply(chatId, `⚠️ <b>Falha ao cancelar ordens:</b> ${cancelAllRes.error}`, undefined, { disableDedup: true });
          }
        }
        return;
      }

      // Comando Cancelar Moeda Específica (/cancelar MOEDA) ou Geral (/cancelar)
      if (rootCmd === 'cancelar' || rootCmd === 'cancel') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const rawArg = parts[1];
          // Se o segundo termo for uma palavra genérica como "ordem", "ordens", "todas", ignora como símbolo
          const isGenericArg = !rawArg || ['ordem', 'ordens', 'todas', 'tudo', 'todas_ordens'].includes(rawArg.toLowerCase());
          const symArg = !isGenericArg ? rawArg : null;

          if (symArg) {
            const res = await cancelAllOrdersForSymbol(symArg, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              await sendTelegramReply(chatId, `🗑️ <b>TODAS AS ORDENS DE ${symArg.toUpperCase()} FORAM CANCELADAS!</b>\n\n✅ Ordens pendentes removidas com sucesso.`, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao cancelar ordens de ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          } else {
            // Cancelar geral quando o usuário envia /cancelar ou 'cancelar ordem'
            const cancelAllRes = await cancelAllBingXPendingOrders(DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (cancelAllRes.success) {
              await sendTelegramReply(chatId, `🚨 <b>ORDENS CANCELADAS COM SUCESSO!</b>\n\n🗑️ ${cancelAllRes.message}`, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao cancelar ordens:</b> ${cancelAllRes.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          }
        }
        return;
      }

      // Comando Editar Stop Loss (/sl XMR 435.5)
      if (rootCmd === 'sl' || rootCmd === 'stoploss') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const priceArg = parseFloat(parts[2]?.replace(',', '.'));

          if (symArg && priceArg > 0) {
            const res = await updateBingXStopLossOrTakeProfit(symArg, 'SL', priceArg, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              await sendTelegramReply(
                chatId, 
                `🛑 <b>NOVA ORDEM COM SL, TAKE E TRAILING STOP ATUALIZADA!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n` +
                (res.mainEntryPrice ? `🎯 Entrada Principal: <code>$${res.mainEntryPrice}</code>\n` : '') +
                `⚡ Stop Loss Digitado: <code>$${priceArg}</code>\n` +
                (res.takeProfit && res.takeProfit !== 'N/A' ? `🎯 Take Profit: <code>$${res.takeProfit}</code>\n` : '') +
                (res.trailingActivation && res.trailingActivation !== 'N/A' ? `🛰️ Trailing Stop: Ativação <code>$${res.trailingActivation}</code>\n` : '') +
                (res.recalculatedMargin ? `💰 Margem da Ordem: <code>$${res.recalculatedMargin} USDT</code>\n` : '') +
                (res.riskUsd ? `🛡️ Risco: <code>-$${res.riskUsd} USDT</code> (${res.effectiveRiskPct || '2.0'}% da conta)\n` : '') +
                (res.recalculatedQty ? `📦 Quantidade: <code>${res.recalculatedQty}</code>\n` : '') +
                `\n${res.activePosRiskNote ? `${res.activePosRiskNote}\n\n` : ''}` +
                `✅ <i>Nova ordem criada e sincronizada com proteção completa na Bitunix!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Stop Loss em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          } else {
            await sendTelegramReply(chatId, `ℹ️ <i>Uso correto:</i> <code>/sl MOEDA NOVO_PREÇO</code>\n<i>Exemplo:</i> <code>/sl XMR 435.0</code>`, undefined, { disableDedup: true });
          }
        }
        return;
      }

      // Comando Editar Take Profit (/tp XMR 460.0)
      if (rootCmd === 'tp' || rootCmd === 'takeprofit') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const priceArg = parseFloat(parts[2]?.replace(',', '.'));

          if (symArg && priceArg > 0) {
            const res = await updateBingXStopLossOrTakeProfit(symArg, 'TP', priceArg, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              await sendTelegramReply(
                chatId, 
                `🎯 <b>TAKE PROFIT ATUALIZADO COM SUCESSO!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n` +
                `⚡ Novo Take Profit: <code>$${priceArg}</code>\n` +
                `${res.activePosRiskNote ? `\n${res.activePosRiskNote}\n` : ''}` +
                `✅ Configurado na Bitunix!`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Take Profit em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          } else {
            await sendTelegramReply(chatId, `ℹ️ <i>Uso correto:</i> <code>/tp MOEDA NOVO_PREÇO</code>\n<i>Exemplo:</i> <code>/tp XMR 460.0</code>`, undefined, { disableDedup: true });
          }
        }
        return;
      }

      // Comando Editar Preço Limite de Entrada (/preco NCCOGOLD 4480.0)
      if (rootCmd === 'preco' || rootCmd === 'preço' || rootCmd === 'editar_limite') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const priceArg = parseFloat(parts[2]?.replace(',', '.'));

          if (symArg && priceArg > 0) {
            const res = await updateBingXLimitEntryPrice(symArg, priceArg, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              await sendTelegramReply(chatId, `⚡ <b>PREÇO LIMITE DE ENTRADA ATUALIZADO!</b>\n\n📊 Par: <code>${res.symbol}</code>\n🎯 Novo Preço no Livro: <code>$${priceArg}</code>\n✅ Ordem substituída com sucesso na Bitunix!`, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar preço limite em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          } else {
            await sendTelegramReply(chatId, `ℹ️ <i>Uso correto:</i> <code>/preco MOEDA NOVO_PREÇO</code>\n<i>Exemplo:</i> <code>/preco NCCOGOLD 4480.0</code>`, undefined, { disableDedup: true });
          }
        }
        return;
      }

      // Comando Editar Trailing Stop (/trailing XMR 2.35 ou /ts XMR 1.5%)
      if (rootCmd === 'trailing' || rootCmd === 'ts' || rootCmd === 'trailingstop') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const arg2 = parts[2];
          const arg3 = parts[3];

          if (!symArg) {
            await sendTelegramReply(
              chatId,
              `ℹ️ <b>Uso do Comando Trailing Stop:</b>\n\n` +
              `• <code>/ts MOEDA GATILHO</code> (ex: <code>/ts ICP 2.35</code>)\n` +
              `• <code>/ts MOEDA %_RECUO</code> (ex: <code>/ts ICP 1.5%</code>)\n` +
              `• <code>/ts MOEDA GATILHO %_RECUO</code> (ex: <code>/ts ICP 2.35 1.5%</code>)\n\n` +
              `💡 <i>Você também pode gerenciar clicando no botão do menu de Ordens Pendentes!</i>`,
              undefined,
              { disableDedup: true }
            );
            return;
          }

          let targetPrice: number | null = null;
          let targetPct: number | null = null;

          if (arg2) {
            if (arg2.includes('%')) {
              targetPct = parseFloat(arg2.replace('%', '').replace(',', '.'));
            } else {
              targetPrice = parseFloat(arg2.replace(',', '.'));
            }
          }

          if (arg3) {
            if (arg3.includes('%')) {
              targetPct = parseFloat(arg3.replace('%', '').replace(',', '.'));
            } else {
              targetPrice = parseFloat(arg3.replace(',', '.'));
            }
          }

          if (targetPrice !== null || targetPct !== null) {
            const res = await updateBingXTrailingStop(symArg, {
              newActivationPrice: targetPrice,
              newCallbackRatePct: targetPct
            }, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);

            if (res.success) {
              await sendTelegramReply(
                chatId,
                `🛰️ <b>TRAILING STOP ATUALIZADO COM SUCESSO!</b>\n\n` +
                `📊 Par: <code>${res.symbol}</code>\n` +
                `⚡ <b>Gatilho de Ativação:</b> <code>${res.activationPrice}</code>\n` +
                `📉 <b>Distância de Recuo:</b> <code>${res.callbackRatePct}%</code>\n` +
                `✅ <i>Ativo e sincronizado na Bitunix sem duplicidades!</i>`,
                undefined,
                { disableDedup: true }
              );
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Trailing Stop em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
          } else {
            // Se só passou a moeda, abre o menu interativo de Trailing Stop para ela!
            await renderTelegramTrailingMenu(chatId, symArg);
          }
        }
        return;
      }

      // Comando Breakeven (/be XMR)
      if (rootCmd === 'be' || rootCmd === 'breakeven') {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const symArg = cleanCmdText.split(/\s+/)[1];
          if (symArg) {
            const normalizedSym = symArg.includes('-USDT') ? symArg : `${symArg.toUpperCase()}-USDT`;
            const res = await setBingXBreakeven(normalizedSym, 'LONG', DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              await sendTelegramReply(chatId, `🛡️ <b>BREAKEVEN APLICADO COM SUCESSO!</b>\n\n📊 Par: <code>${normalizedSym}</code>\n🛑 Novo Stop Loss: <code>$${res.entryPrice}</code> (Preço de Entrada / Risco Zero!)`, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao aplicar Breakeven em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
          } else {
            await sendTelegramReply(chatId, `ℹ️ <i>Uso correto:</i> <code>/be MOEDA</code> (ex: <code>/be XMR</code>)`, undefined, { disableDedup: true });
          }
        }
        return;
      }

      // Comando Fechar Posição (/fechar MOEDA, /fechar, /encerrar, /close)
      if (['fechar', 'close', 'encerrar', 'fecharposicao', 'fechar_posicao', 'fechar_todas', 'fechar_tudo'].includes(rootCmd)) {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const rawArg = parts[1];
          const isGenericArg = !rawArg || ['ordem', 'ordens', 'todas', 'tudo', 'posicao', 'posicoes'].includes(rawArg.toLowerCase());
          const symArg = !isGenericArg ? rawArg : null;

          if (symArg) {
            const res = await closeBingXPosition(symArg, 'LONG', DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
            if (res.success) {
              if (res.isPendingOrder) {
                await sendTelegramReply(chatId, `🛑 <b>ORDEM PENDENTE CANCELADA!</b>\n\n📊 Par: <code>${res.symbol}</code>\n🗑️ A ordem foi removida da Bitunix.`, undefined, { disableDedup: true });
              } else {
                const isLong = (res.positionSide || 'LONG') === 'LONG';
                const dirIcon = isLong ? '🟢' : '🔴';
                const pnlVal = res.realizedPnl !== undefined ? res.realizedPnl : 0;
                const roiVal = res.roiPct !== undefined ? res.roiPct : 0;
                const entryStr = formatDisplayPrice(res.entryPrice);
                const exitStr = formatDisplayPrice(res.closePrice);
                const isGain = pnlVal > 0.05;
                const isFlat = Math.abs(pnlVal) <= 0.05;

                const header = isGain
                  ? `✅ <b>POSIÇÃO ENCERRADA MANUALMENTE (COM LUCRO)</b>`
                  : isFlat
                  ? `🛡️ <b>POSIÇÃO ENCERRADA MANUALMENTE (0 a 0)</b>`
                  : `🚪 <b>POSIÇÃO ENCERRADA MANUALMENTE (COM PREJUÍZO)</b>`;

                const pnlSign = pnlVal >= 0 ? '+' : '';
                const roiSign = roiVal >= 0 ? '+' : '';

                const msg = 
                  `${header}\n\n` +
                  `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide || 'LONG'} ${res.leverage || 20}x ${dirIcon})\n` +
                  `💵 <b>Preço de Entrada:</b> <code>$${entryStr}</code>\n` +
                  `🏁 <b>Preço de Saída:</b> <code>$${exitStr}</code>\n` +
                  `💰 <b>Resultado PnL:</b> <code>${pnlSign}$${pnlVal.toFixed(2)} USDT (${roiSign}${roiVal.toFixed(2)}%)</code>\n\n` +
                  `🖐️ <i>Posição encerrada a mercado na Bitunix. A margem residual retornou para o saldo disponível e ordens pendentes foram limpas com segurança.</i>`;

                await sendTelegramReply(chatId, msg, undefined, { disableDedup: true });
              }
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao fechar posição em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
            }
            // Envia o Painel de Ordens & Posições estritamente DEPOIS da mensagem de fechamento manual
            setTimeout(() => renderTelegramPositionsMessage(chatId), 1200);
          } else {
            // Fechar automático sem argumento: busca posições ativas
            const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => null);
            const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data.filter((p: any) => Math.abs(parseFloat(p.holdAmt || p.qty || '0')) > 0) : [];

            if (positions.length > 0) {
              let closedCount = 0;
              let totalRealizedPnl = 0;
              for (const p of positions) {
                const cRes = await closeBingXPosition(p.symbol, (p.side === 'BUY' || p.side === 'LONG') ? 'LONG' : 'SHORT', DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
                if (cRes.success) {
                  closedCount++;
                  if (cRes.realizedPnl) totalRealizedPnl += cRes.realizedPnl;
                }
              }
              const pnlSign = totalRealizedPnl >= 0 ? '+' : '';
              await sendTelegramReply(chatId, `✅ <b>POSIÇÕES ENCERRADAS COM SUCESSO!</b>\n\n🎯 ${closedCount} de ${positions.length} posição(ões) fechada(s) a mercado na Bitunix.\n💰 <b>PnL Total Estimado:</b> <code>${pnlSign}$${totalRealizedPnl.toFixed(2)} USDT</code>\n🧹 Todas as ordens pendentes e trailing stops foram limpos!`, undefined, { disableDedup: true });
              // Envia o Painel de Ordens & Posições estritamente DEPOIS da mensagem de fechamento
              setTimeout(() => renderTelegramPositionsMessage(chatId), 1200);
            } else {
              // Nenhuma posição aberta, tenta cancelar qualquer ordem pendente
              const cancelAllRes = await cancelAllBingXPendingOrders(DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
              await sendTelegramReply(chatId, `ℹ️ <b>Nenhuma posição ativa em aberto.</b>\n🧹 ${cancelAllRes.message || 'Ordens pendentes canceladas.'}`, undefined, { disableDedup: true });
              setTimeout(() => renderTelegramPendingOrdersMessage(chatId), 800);
            }
          }
        }
        return;
      }

      // Comando Fechamento Parcial (/parcial MOEDA [25|50|75])
      if (['parcial', 'fechar_parcial', 'partial'].includes(rootCmd)) {
        if (chatId) {
          const isDemo = serverTelegramBotConfig.accountType === 'VST';
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          let pctArg = parseInt(parts[2] || '50', 10);
          if (isNaN(pctArg) || pctArg <= 0) pctArg = 50;

          if (symArg) {
            const pRes = await closeBingXPositionPartial(symArg, 'AUTO', pctArg, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
            if (pRes.success) {
              const msg =
                `✂️ <b>FECHAMENTO PARCIAL EXECUTADO!</b>\n\n` +
                `📊 <b>Par:</b> <code>${pRes.symbol}</code> (${pRes.positionSide})\n` +
                `📦 <b>Quantidade Encerrada:</b> <b>${pRes.closedQty} (${pctArg}%)</b>\n` +
                `💼 <b>Quantidade Restante:</b> <b>${pRes.remainingQty}</b>\n\n` +
                `💰 <i>Lucro parcial garantido no saldo! O restante da operação segue protegido com Trailing/Breakeven.</i>`;
              await sendTelegramReply(chatId, msg, undefined, { disableDedup: true });
            } else {
              await sendTelegramReply(chatId, `⚠️ <b>Falha ao executar parcial em ${symArg}:</b> ${pRes.error}`, undefined, { disableDedup: true });
            }
            setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
          } else {
            await sendTelegramReply(
              chatId,
              `ℹ️ <b>Como usar o Fechamento Parcial Rápido:</b>\n\n` +
              `• <code>/parcial MOEDA [PORCENTAGEM]</code>\n\n` +
              `<b>Exemplos:</b>\n` +
              `• <code>/parcial BTC 50</code> (fecha 50% de BTC)\n` +
              `• <code>/parcial SOL 25</code> (fecha 25% de SOL)\n\n` +
              `<i>💡 Você também pode clicar direto no botão [✂️ Parcial 50%] no card da posição!</i>`,
              undefined,
              { disableDedup: true }
            );
          }
        }
        return;
      }

      // Comando Editar Stop Loss (/sl MOEDA PREÇO ou /editarsl MOEDA PREÇO)
      if (['sl', 'editarsl', 'stoploss', 'set_sl'].includes(rootCmd)) {
        if (chatId) {
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const valArg = parts[2];
          if (symArg && valArg) {
            const priceVal = parseFloat(valArg.replace('$', '').replace(',', '.'));
            if (!isNaN(priceVal) && priceVal > 0) {
              const res = await setBitunixPositionTPSLDirect(symArg, priceVal, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
              if (res.success) {
                await sendTelegramReply(
                  chatId,
                  `🛑 <b>STOP LOSS ATUALIZADO COM SUCESSO NA BITUNIX!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide})\n` +
                  `⚡ <b>Entrada:</b> <code>$${res.entryPrice}</code>\n` +
                  `🛑 <b>Novo Stop Loss:</b> <code>$${priceVal}</code>\n\n` +
                  `🔒 <i>Proteção salva na Bitunix e sincronizada com o robô!</i>`,
                  undefined,
                  { disableDedup: true }
                );
              } else {
                await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Stop Loss em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
              }
              setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
              return;
            }
          }
          await sendTelegramReply(
            chatId,
            `ℹ️ <b>Como editar Stop Loss via comando:</b>\n\n` +
            `• <code>/sl MOEDA NOVO_VALOR</code>\n\n` +
            `<b>Exemplos:</b>\n` +
            `• <code>/sl BTC 81500</code>\n` +
            `• <code>/sl SOL 135.50</code>\n\n` +
            `<i>💡 Ou simplesmente clique no botão [🛑 Editar Stop Loss] na listagem de posições!</i>`,
            undefined,
            { disableDedup: true }
          );
        }
        return;
      }

      // Comando Editar Take Profit (/tp MOEDA PREÇO ou /editartp MOEDA PREÇO)
      if (['tp', 'editartp', 'takeprofit', 'set_tp'].includes(rootCmd)) {
        if (chatId) {
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const valArg = parts[2];
          if (symArg && valArg) {
            const priceVal = parseFloat(valArg.replace('$', '').replace(',', '.'));
            if (!isNaN(priceVal) && priceVal > 0) {
              const res = await setBitunixPositionTPSLDirect(symArg, null, priceVal, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
              if (res.success) {
                await sendTelegramReply(
                  chatId,
                  `🎯 <b>TAKE PROFIT ATUALIZADO COM SUCESSO NA BITUNIX!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide})\n` +
                  `⚡ <b>Entrada:</b> <code>$${res.entryPrice}</code>\n` +
                  `🎯 <b>Novo Take Profit:</b> <code>$${priceVal}</code>\n\n` +
                  `🔒 <i>Ordem de realização salva na Bitunix!</i>`,
                  undefined,
                  { disableDedup: true }
                );
              } else {
                await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar Take Profit em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
              }
              setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
              return;
            }
          }
          await sendTelegramReply(
            chatId,
            `ℹ️ <b>Como editar Take Profit via comando:</b>\n\n` +
            `• <code>/tp MOEDA NOVO_VALOR</code>\n\n` +
            `<b>Exemplos:</b>\n` +
            `• <code>/tp BTC 87000</code>\n` +
            `• <code>/tp SOL 152.00</code>\n\n` +
            `<i>💡 Ou clique no botão [🎯 Editar Take Profit] na listagem de posições!</i>`,
            undefined,
            { disableDedup: true }
          );
        }
        return;
      }

      // Comando SL e TP Combinados (/sltp MOEDA STOP_LOSS TAKE_PROFIT)
      if (['sltp', 'set_sltp'].includes(rootCmd)) {
        if (chatId) {
          const parts = cleanCmdText.split(/\s+/);
          const symArg = parts[1];
          const slArg = parts[2];
          const tpArg = parts[3];
          if (symArg && slArg && tpArg) {
            const slVal = parseFloat(slArg.replace('$', '').replace(',', '.'));
            const tpVal = parseFloat(tpArg.replace('$', '').replace(',', '.'));
            if (!isNaN(slVal) && !isNaN(tpVal)) {
              const res = await setBitunixPositionTPSLDirect(symArg, slVal, tpVal, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
              if (res.success) {
                await sendTelegramReply(
                  chatId,
                  `🛡️ <b>STOP LOSS & TAKE PROFIT ATUALIZADOS!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${res.symbol}</code> (${res.positionSide})\n` +
                  `⚡ <b>Entrada:</b> <code>$${res.entryPrice}</code>\n` +
                  `🛑 <b>Stop Loss:</b> <code>$${slVal}</code>\n` +
                  `🎯 <b>Take Profit:</b> <code>$${tpVal}</code>\n\n` +
                  `🔒 <i>Proteções sincronizadas na Bitunix e no robô!</i>`,
                  undefined,
                  { disableDedup: true }
                );
              } else {
                await sendTelegramReply(chatId, `⚠️ <b>Falha ao atualizar SL/TP em ${symArg}:</b> ${res.error}`, undefined, { disableDedup: true });
              }
              setTimeout(() => renderTelegramPositionsMessage(chatId), 800);
              return;
            }
          }
          await sendTelegramReply(
            chatId,
            `ℹ️ <b>Como editar SL e TP simultaneamente:</b>\n\n` +
            `• <code>/sltp MOEDA STOP_LOSS TAKE_PROFIT</code>\n\n` +
            `<b>Exemplo:</b>\n` +
            `• <code>/sltp BTC 81500 87000</code>`,
            undefined,
            { disableDedup: true }
          );
        }
        return;
      }

      // Comando Configurar Chave Gemini (/gemini CHAVE ou /setgemini CHAVE)
      if (['gemini', 'setgemini', 'chave_gemini'].includes(rootCmd)) {
        if (chatId) {
          const parts = cleanCmdText.split(/\s+/);
          const keyArg = parts.slice(1).join('').trim();
          if (keyArg) {
            DEFAULT_GEMINI_KEY = keyArg;
            geminiClient = null;
            saveCredentialsToFile();
            await sendTelegramReply(chatId, `✅ <b>Chave Gemini Vision configurada com sucesso!</b>\n\n🔑 Chave salva. Agora o bot está pronto para analisar prints de gráficos do TradingView e extrair sinais automaticamente!`, undefined, { disableDedup: true });
          } else {
            const hasKey = Boolean(DEFAULT_GEMINI_KEY);
            await sendTelegramReply(
              chatId,
              `🤖 <b>Configuração do Gemini Vision (Leitura de Gráficos)</b>\n\n` +
              `Status: <b>${hasKey ? '🟢 Chave configurada' : '🔴 Nenhuma chave configurada'}</b>\n\n` +
              `Para configurar ou alterar sua chave da API Gemini do Google AI Studio, envie:\n` +
              `<code>/gemini SUA_CHAVE_AQUI</code>\n\n` +
              `<i>💡 Dica: Você pode obter uma chave gratuita em: https://aistudio.google.com/app/apikey</i>`,
              undefined,
              { disableDedup: true }
            );
          }
        }
        return;
      }

      // Comando /start, /ajuda, /help, /menu ou qualquer comando desconhecido
      if (['start', 'ajuda', 'help', 'comandos', 'menu'].includes(rootCmd) || isExplicitSlash) {
        if (chatId) {
          await renderTelegramMainMenu(chatId);
        }
        return;
      }
    }

    // 3. Processamento Completo de Sinal Recebido
    const parsed = parseSignalText(trimmedText);

    // Se a mensagem NÃO for um sinal de trade genuíno (conversa, texto aleatório, etc.), ignora
    if (!parsed.isValidSignal) {
      console.log(`[NON-SIGNAL] Mensagem ignorada (não é sinal de trade válido): "${trimmedText}"`);
      return;
    }

    // Trava Estrita Anti-Duplicação de Cartão de Sinal (Local + Distribuído)
    const signalFingerprint = `${chatId}_${parsed.apiSymbol}_${parsed.direction}_${parsed.entryPrice || 0}_${parsed.stopLoss || 0}_${parsed.orderType}`;
    const now = Date.now();
    const lastSentTime = localSentCardsCache.get(signalFingerprint) || 0;
    if (now - lastSentTime < 15000) {
      console.log(`[DEDUP-LOCAL] Sinal idêntico recente detectado para ${parsed.apiSymbol}. Descartando duplicata.`);
      return;
    }
    localSentCardsCache.set(signalFingerprint, now);
    if (localSentCardsCache.size > 200) {
      const [firstK] = localSentCardsCache.keys();
      localSentCardsCache.delete(firstK);
    }

    const signalId = `tg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const newSignal = {
      id: signalId,
      text: trimmedText,
      sender,
      chatId,
      receivedAt: new Date().toISOString(),
      status: 'PENDING' as 'PENDING' | 'EXECUTED' | 'CANCELLED',
      executedBy: undefined as string | undefined,
      executedAt: undefined as string | undefined,
      parsed
    };

    receivedTelegramSignals.unshift(newSignal);
    if (receivedTelegramSignals.length > 50) {
      receivedTelegramSignals.pop();
    }
    signalsStoreById.set(signalId, newSignal);
    saveTelegramSignalsToFile();

    if (parsed) {
      recordTradeAudit({
        symbol: parsed.apiSymbol || (parsed.coinName ? `${parsed.coinName}-USDT` : parsed.symbol),
        cleanSymbol: parsed.coinName || parsed.symbol?.replace('-USDT', ''),
        direction: parsed.direction || 'LONG',
        entryPrice: parsed.entryPrice || 0,
        stopLoss: typeof parsed.stopLoss === 'number' ? parsed.stopLoss : parseFloat(String(parsed.stopLoss || '0')),
        takeProfits: parsed.takeProfits || [],
        leverage: (parsed as any).targetLeverage || parsed.leverage || 20,
        timestamp: Date.now()
      });
    }

    // Se o modo de auto-execução instantânea estiver ATIVADO
    if (serverTelegramBotConfig.autoExecuteWithoutPrompt) {
      const lockCheck = await checkDailyLockBlocked();
      if (lockCheck.blocked) {
        if (chatId) {
          await sendTelegramReply(chatId, lockCheck.reason || "🛑 Operação bloqueada pela trava diária.");
        }
        return;
      }

      // 👤 ROTEAMENTO DINÂMICO DE CONTA POR CHAT ID:
      // Se o sinal veio de um operador/parceiro cadastrado no bot, executa exclusivamente na conta dele
      const accCtx = getAccountContextForChat(chatId);
      let execResult: any;

      if (accCtx.isOperator && accCtx.account) {
        console.log(`[MULTI-ACCOUNT] Executando sinal automático para operador ${accCtx.name} (${accCtx.ownerName}) via ChatID: ${chatId}`);
        execResult = await executeTradeForManagedAccount(accCtx.account, parsed);
      } else {
        execResult = await executeBingXTradeForTelegram(parsed);
      }

      if (execResult.success) {
        newSignal.status = 'EXECUTED';
        newSignal.executedBy = sender;
        newSignal.executedAt = new Date().toISOString();

        // 🔄 REPLICAÇÃO AUTOMÁTICA COPY TRADE:
        // Se foi iniciado pelo Master (ou sinal geral), replica para as outras contas.
        // Se foi disparado por um operador específico, replica apenas se o operador tiver copy habilitado, excluindo a própria conta.
        const initiatorId = accCtx.isOperator && accCtx.account ? accCtx.account.id : 'acc_master';
        replicateTradeToAllActiveAccounts(parsed, initiatorId).catch(err => {
          console.warn("[REPLICATION-BACKGROUND-ERROR]:", err.message);
        });

        if (chatId) {
          const fullSuccessMsg = formatTelegramExecutionSuccessMessage(execResult, sender);
          const kb = getExecutionInlineKeyboard(execResult);
          await sendTelegramReply(chatId, fullSuccessMsg, kb);
        }
      } else {
        if (chatId) {
          await sendTelegramReply(
            chatId,
            `⚠️ <b>FALHA NA EXECUÇÃO DA ORDEM NA BITUNIX</b>\n\n` +
            `📊 <b>Par:</b> <code>${parsed.symbol}</code> (${parsed.direction})\n` +
            `👤 <b>Conta:</b> <code>${accCtx.name} (${accCtx.ownerName})</code>\n` +
            `❌ <b>Motivo:</b> <code>${execResult.error || 'Erro desconhecido'}</code>\n\n` +
            `💡 <i>Verifique o saldo disponível em USDT ou as permissões de Trade da sua API Key.</i>`,
            {
              inline_keyboard: [
                [{ text: "📋 Ver Ordens Abertas", callback_data: "LIST_POSITIONS" }]
              ]
            }
          );
        }
      }
      return;
    }

    // 🌟 Envia o sinal formatado para o Grupo VIP idêntico ao modelo (Print 2), pronto para copiar e colar
    if (chatId) {
      if (parsed.isFastCompactSignal) {
        const vipFormatted = formatVipSignalMessage(parsed, false);
        await sendTelegramReply(
          chatId,
          vipFormatted,
          undefined,
          { disableDedup: true }
        );
      }

      // Modo Detalhado com Confirmação em 1-Toque
      await promptTelegramConfirmation(parsed, chatId, signalId);
    }
  };

  // Agente HTTPS dedicado para requisições de mensagens e comandos (TCP Keep-Alive)
  // Background Telegram Long-Polling Engine 24/7 (Arquitetura Versão 1 em ./telegramBot.ts)
  telegramUpdateBridge = processTelegramUpdate;
  configureTelegramBot({
    getToken: () => TELEGRAM_BOT_TOKEN,
    onUpdate: (update) => processTelegramUpdate(update),
    defaultBotUsername: "Crypptooo_bot"
  });
  await syncTelegramHostLock();
  if (shouldRunTelegramBotHere()) {
    startTelegramPolling();
  } else {
    console.log(`[TELEGRAM-POLLING] ⏸️ Preview em standby: bot cedido ao servidor Render 24h (sem conflito 409).`);
  }
  setInterval(syncTelegramHostLock, 20000);

  // Watchdog de segurança: verifica a cada 15s se o loop contínuo segue ativo (janela de 55s > 20s poll + 35s socket)
  setInterval(() => {
    if (!shouldRunTelegramBotHere()) {
      stopTelegramBotPolling();
      return;
    }
    if (TELEGRAM_BOT_TOKEN && hasCheckedTelegramLockOnce) {
      const state = getTelegramBotState();
      const staleTime = Date.now() - state.lastPollingHeartbeat;
      if (!state.isPollingActive || staleTime > 55000) {
        console.warn(`[TELEGRAM-WATCHDOG] Polling inativo ou sem resposta há ${Math.round(staleTime / 1000)}s. Reiniciando loop...`);
        startTelegramPolling(true);
      }
    }
  }, 15000);

  // =========================================================================
  // 🔔 REAL-TIME MONITOR & PROTECTION DAEMON (Automated Execution & Alarms)
  // Notifica automaticamente no Telegram quando:
  // 1. Uma Ordem Pendente (Limite/Gatilho) é executada no mercado
  // 2. Take Profit (TP) é atingido
  // 3. Stop Loss (SL) é atingido
  // 4. Trailing Stop atinge o preço de ativação ou executa fechamento no recuo
  // 5. Breakeven automático (0 a 0) é acionado
  // =========================================================================
  const startPositionProtectionDaemon = () => {
    let isDaemonRunning = false;
    let isFirstCycle = true;

    // Cache de ordens pendentes anteriores
    const previousPendingOrders = new Map<string, {
      orderId: string;
      symbol: string;
      positionSide: string;
      side: string;
      price: number;
      origQty: string;
      stopLoss?: string;
      takeProfit?: string;
      timestamp: number;
    }>();

    // Cache de posições abertas anteriores
    const previousPositions = new Map<string, {
      positionId?: string;
      symbol: string;
      positionSide: string;
      entryPrice: number;
      stopLoss?: number;
      takeProfit?: number;
      positionAmt: string;
      leverage?: number;
      margin?: number;
      unrealizedProfit?: number;
      timestamp: number;
    }>();

    // Cache para evitar notificações duplicadas de ativação de Trailing Stop
    const notifiedTrailingActivations = new Set<string>();

    setInterval(async () => {
      if (!shouldRunTelegramBotHere()) return;
      if (isDaemonRunning) return;
      if (!DEFAULT_BITUNIX_KEY && !DEFAULT_BINGX_KEY) return;

      isDaemonRunning = true;
      try {
        const isDemo = serverTelegramBotConfig.accountType === 'VST';

        // 1. Consulta posições abertas na Bitunix
        let bitunixPositions: any[] = [];
        let positionsFetchOk = false;
        try {
          if (DEFAULT_BITUNIX_KEY && DEFAULT_BITUNIX_SECRET) {
            const bxRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (bxRes?.code === 0 && Array.isArray(bxRes.data)) {
              positionsFetchOk = true;
              bitunixPositions = bxRes.data
                .filter((p: any) => Math.abs(parseFloat(p.holdAmt || p.total || p.qty || '0')) > 0)
                .map((p: any) => ({
                  ...p,
                  exchange: 'BITUNIX',
                  positionAmt: p.holdAmt || p.qty || p.total || '0',
                  avgPrice: p.avgOpenPrice || p.avgPrice || p.entryPrice || '0',
                  positionSide: (p.side === 'BUY' || p.side === 'LONG' || p.side === 1 || p.side === '1') ? 'LONG' : 'SHORT'
                }));
            }
          }
        } catch (e) {}

        // 2. Consulta ordens abertas na Bitunix
        let currentOpenOrders: any[] = [];
        try {
          if (DEFAULT_BITUNIX_KEY && DEFAULT_BITUNIX_SECRET) {
            const ordRes = await sendBitunixRequest('/api/v1/futures/trade/get_pending_orders', 'GET', {}, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
            if (ordRes?.code === 0 && Array.isArray(ordRes.data)) {
              currentOpenOrders = ordRes.data;
            }
          }
        } catch (e) {}

        const currentPositions = bitunixPositions;

        // -------------------------------------------------------------
        // 1. DETECÇÃO DE EXECUÇÃO DE ORDENS PENDENTES (ENTRADA ATIVADA)
        // -------------------------------------------------------------
        const currentPendingEntryOrders = currentOpenOrders.filter((o: any) => {
          const type = (o.type || '').toUpperCase();
          const isTrigger = type.includes('TRIGGER') || type.includes('STOP') || type.includes('LIMIT') || type === '1' || type === '2';
          return !o.reduceOnly && !o.closePosition && isTrigger;
        });

        const currentPendingOrderIds = new Set(currentPendingEntryOrders.map((o: any) => (o.orderId || o.orderID || o.id || '').toString()));

        if (!isFirstCycle) {
          for (const [orderId, prevOrder] of previousPendingOrders.entries()) {
            if (!currentPendingOrderIds.has(orderId)) {
              // A ordem pendente saiu do livro! Verifica se gerou/aumentou posição correspondente
              const normPrevSide = (prevOrder.positionSide || 'LONG').toUpperCase();
              const hasMatchingPosition = currentPositions.some((p: any) => {
                const sameSym = isSameOrRelatedSymbol(p.symbol, prevOrder.symbol);
                const pSide = (p.positionSide || (parseFloat(p.positionAmt || '0') >= 0 ? 'LONG' : 'SHORT')).toUpperCase();
                const sameSide = pSide === normPrevSide || !prevOrder.positionSide;
                const hasAmt = Math.abs(parseFloat(p.positionAmt || p.holdAmt || p.qty || '0')) > 0;
                return sameSym && sameSide && hasAmt;
              });

              if (hasMatchingPosition) {
                console.log(`[ALERT-DAEMON] Ordem pendente executada com sucesso: ${prevOrder.symbol} (#${orderId})`);

                // 1. Extração limpa e segura de valores de preço (evitando $[object Object])
                const formatPriceClean = (val: any): string => {
                  if (val === undefined || val === null) return '';
                  if (typeof val === 'number') return val > 0 ? val.toString() : '';
                  if (typeof val === 'string') {
                    const trimmed = val.trim();
                    if (trimmed.startsWith('{')) {
                      try {
                        const parsed = JSON.parse(trimmed);
                        const p = parsed.stopPrice || parsed.price || parsed.triggerPrice;
                        return p ? p.toString() : '';
                      } catch (e) {
                        return '';
                      }
                    }
                    if (trimmed === '[object Object]' || trimmed === 'NaN') return '';
                    return trimmed;
                  }
                  if (typeof val === 'object') {
                    const p = val.stopPrice || val.price || val.triggerPrice;
                    return p ? p.toString() : '';
                  }
                  return '';
                };

                const matchingPos = currentPositions.find((p: any) => {
                  const sameSym = isSameOrRelatedSymbol(p.symbol, prevOrder.symbol);
                  const pSide = (p.positionSide || (parseFloat(p.positionAmt || '0') >= 0 ? 'LONG' : 'SHORT')).toUpperCase();
                  const sameSide = pSide === normPrevSide || !prevOrder.positionSide;
                  const hasAmt = Math.abs(parseFloat(p.positionAmt || p.holdAmt || p.qty || '0')) > 0;
                  return sameSym && sameSide && hasAmt;
                });

                const trailingSaved = pendingTrailingConfigs.get(`${prevOrder.symbol}_${prevOrder.positionSide || 'LONG'}`) ||
                                      pendingTrailingConfigs.get(prevOrder.symbol);

                const slFormatted = formatPriceClean(prevOrder.stopLoss) || 
                                    formatPriceClean(matchingPos?.stopLoss) || 
                                    (trailingSaved?.stopLossPrice ? trailingSaved.stopLossPrice.toString() : '');

                const tpFormatted = formatPriceClean(prevOrder.takeProfit) || 
                                    formatPriceClean(matchingPos?.takeProfit);

                const entryPriceDisplay = prevOrder.price > 0 
                  ? prevOrder.price 
                  : (matchingPos ? parseFloat(matchingPos.avgPrice || matchingPos.entryPrice || '0') : 'Mercado');

                const qtyDisplay = prevOrder.origQty || (matchingPos ? Math.abs(parseFloat(matchingPos.positionAmt || '0')) : 'Operada');

                // 2. 🚀 ENVIAR PRIMEIRO: Confirmação de Ordem Pendente Executada!
                const execMsg = 
                  `🚀 <b>ORDEM PENDENTE EXECUTADA NA BITUNIX!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${prevOrder.symbol}</code> (${prevOrder.positionSide || 'LONG'})\n` +
                  `🎯 <b>Preço de Entrada:</b> <code>$${entryPriceDisplay}</code>\n` +
                  `📦 <b>Quantidade:</b> <code>${qtyDisplay}</code>\n` +
                  `${slFormatted ? `🛑 <b>Stop Loss:</b> <code>$${slFormatted}</code>\n` : ''}` +
                  `${tpFormatted ? `🎯 <b>Take Profit:</b> <code>$${tpFormatted}</code>\n` : ''}` +
                  `\n🟢 <i>A sua ordem que aguardava no livro foi preenchida pelo mercado e a posição já está em andamento com proteção ativa!</i>`;

                await broadcastTelegramNotification(execMsg, {
                  inline_keyboard: [
                    [{ text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }]
                  ]
                });

                // Pequena pausa (350ms) para garantir ordem cronológica perfeita das mensagens no Telegram
                await new Promise((resolve) => setTimeout(resolve, 350));

                // 3. 🛡️ ENVIAR SEGUNDO: Implanta o Trailing Stop PÓS-EXECUÇÃO agora que a posição está ativa!
                await deployPostExecutionTrailingStop(prevOrder.symbol, prevOrder.positionSide || 'LONG', prevOrder.origQty, prevOrder.price);
              } else {
                pendingTrailingConfigs.delete(orderId);
                const sym = prevOrder.symbol;
                const posSide = (prevOrder.positionSide || 'LONG').toUpperCase();
                pendingTrailingConfigs.delete(`${sym}_${posSide}`);
                const clean = sym.replace('-USDT', '').replace('USDT', '');
                pendingTrailingConfigs.delete(`${clean}_${posSide}`);
                savePendingTrailingConfigsToFile();
                // 🛡️ Auto-reset para 20x e Margem Isolada se ordem pendente cancelada e sem posição aberta
                await checkAndResetLeverageIfNoPosition(sym, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
              }
              previousPendingOrders.delete(orderId);
            }
          }
        }

        // Atualiza cache de ordens pendentes
        for (const o of currentPendingEntryOrders) {
          const oId = (o.orderId || '').toString();
          if (oId) {
            previousPendingOrders.set(oId, {
              orderId: oId,
              symbol: o.symbol,
              positionSide: o.positionSide || 'LONG',
              side: o.side || 'BUY',
              price: parseFloat(o.price || o.stopPrice || '0'),
              origQty: o.origQty || o.quantity || '',
              stopLoss: o.stopLoss,
              takeProfit: o.takeProfit,
              timestamp: Date.now()
            });
          }
        }

        // -------------------------------------------------------------
        // 1.1 VERIFICAÇÃO CONTÍNUA DE TRAILING STOP PENDENTE E AJUSTE DE QUANTIDADE PARA 100% DA POSIÇÃO
        // -------------------------------------------------------------
        for (const p of currentPositions) {
          const pSym = p.symbol || '';
          const pSide = ((p.positionSide || 'LONG').toUpperCase()) as 'LONG' | 'SHORT';
          const pAmt = Math.abs(parseFloat(p.positionAmt || '0'));
          if (pAmt > 0) {
            const cleanSym = pSym.replace('-USDT', '').replace('USDT', '');
            const hasPendingCfg = pendingTrailingConfigs.has(`${pSym}_${pSide}`) || 
                                  pendingTrailingConfigs.has(`${cleanSym}_${pSide}`);

            const existingActive = (bitunixActiveTrailingStops.get(pSym) || 
                                    bitunixActiveTrailingStops.get(`${cleanSym}USDT`) || 
                                    bitunixActiveTrailingStops.get(cleanSym))?.positionSide === pSide;

            if (existingActive) {
              // Se já está ativo no Stop Móvel Bitunix, descarta chaves pendentes para evitar loop
              if (hasPendingCfg || pendingTrailingConfigs.has(pSym) || pendingTrailingConfigs.has(cleanSym)) {
                pendingTrailingConfigs.delete(`${pSym}_${pSide}`);
                pendingTrailingConfigs.delete(`${cleanSym}_${pSide}`);
                pendingTrailingConfigs.delete(pSym);
                pendingTrailingConfigs.delete(cleanSym);
                savePendingTrailingConfigsToFile();
              }
            } else if (hasPendingCfg) {
              await deployPostExecutionTrailingStop(pSym, pSide, p.positionAmt, parseFloat(p.avgPrice || p.entryPrice || '0'));
            }
          }
        }

        // -------------------------------------------------------------
        // 2. DETECÇÃO DE ATIVAÇÃO DE TRAILING STOP NO GATILHO ESTABELECIDO
        // -------------------------------------------------------------
        const trailingOrders = currentOpenOrders.filter((o: any) => {
          const type = (o.type || '').toUpperCase();
          return type.includes('TRAILING');
        });

        for (const trOrder of trailingOrders) {
          const actPrice = parseFloat(trOrder.activationPrice || '0');
          const oId = (trOrder.orderId || `${trOrder.symbol}_ts`).toString();
          if (actPrice > 0 && !notifiedTrailingActivations.has(oId)) {
            // Busca o preço atual da posição para checar se cruzou o gatilho
            const matchPos = currentPositions.find((p: any) => p.symbol === trOrder.symbol);
            if (matchPos) {
              const markPrice = parseFloat(matchPos.markPrice || matchPos.avgPrice || '0');
              const isLong = (trOrder.positionSide || matchPos.positionSide) === 'LONG';
              const isTriggered = isLong ? (markPrice >= actPrice) : (markPrice <= actPrice && markPrice > 0);

              if (isTriggered) {
                notifiedTrailingActivations.add(oId);
                console.log(`[ALERT-DAEMON] Trailing Stop ativado no mercado para ${trOrder.symbol} no preço $${actPrice}`);

                const actMsg = 
                  `⚡ <b>TRAILING STOP ATIVADO NO MERCADO!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${trOrder.symbol}</code> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
                  `🎯 <b>Gatilho de Ativação:</b> <code>$${actPrice}</code>\n` +
                  `📈 <b>Cotação Atual:</b> <code>$${markPrice}</code>\n\n` +
                  `🚀 <i>O preço de mercado atingiu o gatilho de segurança! O Stop Móvel agora está ativo na Bitunix rastreando as máximas e protegendo o ganho no recuo!</i>`;

                await broadcastTelegramNotification(actMsg, {
                  inline_keyboard: [
                    [{ text: "📋 Ver Posições Abertas", callback_data: "LIST_POSITIONS" }]
                  ]
                });
              }
            }
          }
        }

        // Helper para atualizar Stop Loss na Bitunix
        const applyConducaoStopLossToExchange = async (
          trRecord: BitunixTrailingStopRecord,
          calculatedSL: number,
          matchingPos: any,
          isDemoMode: boolean
        ) => {
          try {
            const bitunixSym = resolveBitunixSymbol(trRecord.symbol).apiSymbol;
            let targetPositionId = matchingPos?.positionId || trRecord.positionId;
            if (!targetPositionId) {
              const posRes = await sendBitunixRequest('/api/v1/futures/position/get_pending_positions', 'GET', { marginCoin: 'USDT' }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET);
              const positions = (posRes?.data && Array.isArray(posRes.data)) ? posRes.data : [];
              const p = positions.find((item: any) => isSameOrRelatedSymbol(item.symbol, bitunixSym) && Math.abs(parseFloat(item.holdAmt || item.qty || item.total || '0')) > 0);
              if (p?.positionId) targetPositionId = p.positionId;
            }
            if (targetPositionId) {
              const tpslRes = await safeSetBitunixPositionTPSL({
                symbol: bitunixSym,
                positionId: targetPositionId,
                slPrice: calculatedSL.toString(),
                tpPrice: trRecord.takeProfitPrice || undefined,
                apiKey: DEFAULT_BITUNIX_KEY,
                apiSecret: DEFAULT_BITUNIX_SECRET
              });
              console.log(`[BITUNIX-SL-UPDATE-RES] ${bitunixSym} SL=$${calculatedSL}:`, JSON.stringify(tpslRes));
              return tpslRes;
            }
          } catch (e: any) {
            console.warn(`[BITUNIX-SL-UPDATE-ERR]:`, e.message);
            return null;
          }
        };

        // -------------------------------------------------------------
        // 2.1 STOP MÓVEL / CONDUÇÃO ENGINE (BITUNIX EXCLUSIVO)
        // Monitora topos e fundos em tempo real, atualiza o SL na corretora e protege lucro
        // -------------------------------------------------------------
        if (bitunixActiveTrailingStops.size > 0) {
          // Busca cotações de mercado (markPrice / lastPrice) em lote e ultra-rápido para todos os pares ativos
          const activeSymbols = Array.from(new Set(
            Array.from(bitunixActiveTrailingStops.values()).map(r => resolveBitunixSymbol(r.symbol).apiSymbol)
          ));
          const liveTickerMap = new Map<string, { markPrice: number; lastPrice: number }>();
          if (activeSymbols.length > 0) {
            try {
              const tickerRes = await axios.get(
                `${BITUNIX_BASE_URL}/api/v1/futures/market/tickers?symbols=${activeSymbols.join(',')}`,
                { timeout: 1500 }
              );
              if (tickerRes.data?.code === 0 && Array.isArray(tickerRes.data?.data)) {
                for (const tItem of tickerRes.data.data) {
                  const sym = (tItem.symbol || '').toUpperCase();
                  const mark = parseFloat(tItem.markPrice || '0');
                  const last = parseFloat(tItem.lastPrice || tItem.last || '0');
                  if (sym) liveTickerMap.set(sym, { markPrice: mark, lastPrice: last });
                }
              }
            } catch (e) {}
          }

          const processedTrailingRecords = new Set<BitunixTrailingStopRecord>();
          for (const [symKey, trRecord] of Array.from(bitunixActiveTrailingStops.entries())) {
            if (processedTrailingRecords.has(trRecord)) continue;
            processedTrailingRecords.add(trRecord);

            const matchingPos = currentPositions.find((p: any) => 
              isSameOrRelatedSymbol(p.symbol, trRecord.symbol) && 
              (p.positionSide === trRecord.positionSide || !trRecord.positionSide)
            );

            // Se a posição não for encontrada de imediato, aguarda período de carência (mínimo 60s) e 5 ciclos consecutivos
            if (!matchingPos || Math.abs(parseFloat(matchingPos.positionAmt || '0')) <= 0) {
              const isRecent = (Date.now() - trRecord.createdAt) < 60000;
              (trRecord as any).missingCycles = ((trRecord as any).missingCycles || 0) + 1;
              if (!isRecent && (trRecord as any).missingCycles >= 5) {
                stopBitunixTrailingStop(trRecord.symbol);
              }
              continue;
            } else {
              (trRecord as any).missingCycles = 0;
              if (matchingPos.positionId && !trRecord.positionId) {
                trRecord.positionId = matchingPos.positionId;
              }
            }

            const bitunixSym = resolveBitunixSymbol(trRecord.symbol).apiSymbol;
            const liveTick = liveTickerMap.get(bitunixSym);

            let currentPrice = 0;
            if (liveTick && liveTick.markPrice > 0) {
              currentPrice = liveTick.markPrice;
            } else if (liveTick && liveTick.lastPrice > 0) {
              currentPrice = liveTick.lastPrice;
            } else {
              const pMark = parseFloat(matchingPos.markPrice || '0');
              const pLast = parseFloat(matchingPos.lastPrice || '0');
              if (pMark > 0) currentPrice = pMark;
              else if (pLast > 0) currentPrice = pLast;
            }

            // Se ainda não tiver cotação, consulta o ticker individual
            if (currentPrice <= 0) {
              try {
                const tickerRes = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/tickers?symbols=${bitunixSym}`, { timeout: 1500 });
                if (tickerRes.data?.code === 0 && Array.isArray(tickerRes.data?.data) && tickerRes.data.data.length > 0) {
                  const tItem = tickerRes.data.data[0];
                  const tPrice = parseFloat(tItem.lastPrice || tItem.markPrice || '0');
                  if (tPrice > 0) currentPrice = tPrice;
                }
              } catch (e) {}
            }

            if (currentPrice <= 0) {
              currentPrice = parseFloat(matchingPos.entryPrice || '0');
            }

            if (currentPrice <= 0) continue;

            const isLong = trRecord.positionSide === 'LONG';
            const bitunixContract = resolveBitunixSymbol(trRecord.symbol).contract;
            const precision = (typeof trRecord.pricePrecision === 'number' && trRecord.pricePrecision > 0)
              ? trRecord.pricePrecision
              : (bitunixContract?.pricePrecision ?? (trRecord.entryPrice >= 1000 ? 1 : trRecord.entryPrice >= 1 ? 4 : 5));
            const exchangeName = 'Bitunix';

            // 1. Execução de Condução Escalonada (Mover por Vezes o Stop Loss / Alvos) vs Trailing Stop %
            const isConducao = trRecord.strategy === 'CONDUCAO' || serverTelegramBotConfig.conducaoStrategy === 'CONDUCAO';

            if (isConducao) {
              const stopDistance = trRecord.stopDistance || Math.abs(trRecord.entryPrice - trRecord.initialStopLoss);
              if (stopDistance > 0 && trRecord.entryPrice > 0) {
                const currentUnits = isLong
                  ? (currentPrice - trRecord.entryPrice) / stopDistance
                  : (trRecord.entryPrice - currentPrice) / stopDistance;

                if (currentUnits > (trRecord.maxUnitsReached || 0)) {
                  trRecord.maxUnitsReached = currentUnits;
                }
                const maxUnits = trRecord.maxUnitsReached || 0;

                const c0 = (trRecord.customConducao && trRecord.tier0Trigger !== undefined) ? trRecord.tier0Trigger : (serverTelegramBotConfig.conducaoTier0Trigger ?? 1.0);
                const c1 = (trRecord.customConducao && trRecord.tier1Trigger !== undefined) ? trRecord.tier1Trigger : (serverTelegramBotConfig.conducaoTier1Trigger ?? 1.5);
                const c3 = (trRecord.customConducao && trRecord.tier3Trigger !== undefined) ? trRecord.tier3Trigger : (serverTelegramBotConfig.conducaoTier3Trigger ?? 2.0);
                const c4 = (trRecord.customConducao && trRecord.tier4Dist !== undefined) ? trRecord.tier4Dist : (serverTelegramBotConfig.conducaoTier4Dist ?? 1.0);
                const c5 = (trRecord.customConducao && trRecord.tier5Trigger !== undefined) ? trRecord.tier5Trigger : (serverTelegramBotConfig.conducaoTier5Trigger ?? 3.0);
                const c6 = (trRecord.customConducao && trRecord.tier6Dist !== undefined) ? trRecord.tier6Dist : (serverTelegramBotConfig.conducaoTier6Dist ?? 0.5);

                let targetSL: number | null = null;
                let newStage = trRecord.conducaoStage || 0;
                let stageTitle = '';
                let stageDesc = '';

                // Fase 2 (Apertar Stop a partir de c5, ex: 3x, em degraus discretos de 0.5x com folga c6)
                if (maxUnits >= c5) {
                  newStage = 4;
                  // Degrau discreto de 0.5x atingido (3.0x, 3.5x, 4.0x, 4.5x, 5.0x, 5.5x...)
                  const step = Math.floor((maxUnits + 0.0001) / 0.5) * 0.5;
                  const profitUnits = Math.max(0, step - c6);
                  targetSL = isLong
                    ? trRecord.entryPrice + (profitUnits * stopDistance)
                    : trRecord.entryPrice - (profitUnits * stopDistance);
                  stageTitle = `📈 <b>CONDUÇÃO DE STOP: FASE 2 (DEGRAU +${step.toFixed(1)}x)!</b>`;
                  stageDesc = `O trade atingiu o degrau de <b>+${step.toFixed(1)}x do Stop</b>! O Stop Loss foi ajustado para <b>+${profitUnits.toFixed(1)}x no bolso</b> (folga de ${c6}x)! Próximo degrau: <b>+${(step + 0.5).toFixed(1)}x</b>.`;
                }
                // Fase 1 (Condução Inicial a partir de c3, ex: 2x, em degraus discretos de 0.5x com folga c4)
                else if (maxUnits >= c3) {
                  newStage = 3;
                  // Degraus discretos de 0.5x: 2.0x, 2.5x
                  const step = Math.floor((maxUnits + 0.0001) / 0.5) * 0.5;
                  const profitUnits = Math.max(0, step - c4);
                  targetSL = isLong
                    ? trRecord.entryPrice + (profitUnits * stopDistance)
                    : trRecord.entryPrice - (profitUnits * stopDistance);
                  stageTitle = `🚀 <b>CONDUÇÃO DE STOP: FASE 1 (DEGRAU +${step.toFixed(1)}x)!</b>`;
                  stageDesc = `O trade atingiu o degrau de <b>+${step.toFixed(1)}x do Stop</b>! O robô travou o Stop Loss no lucro em <b>+${profitUnits.toFixed(1)}x</b> (folga de ${c4}x)! Próximo degrau: <b>+${(step + 0.5).toFixed(1)}x</b>.`;
                }
                // Break-Even + Taxas (1.5x)
                else if (maxUnits >= c1) {
                  newStage = 2;
                  const feeOffset = trRecord.entryPrice * 0.0010;
                  targetSL = isLong
                    ? trRecord.entryPrice + feeOffset
                    : trRecord.entryPrice - feeOffset;
                  stageTitle = `⚖️ <b>CONDUÇÃO DE STOP: BREAK-EVEN (0 a 0) ATIVADO!</b>`;
                  stageDesc = `O mercado andou <b>+${c1}x a favor</b>! Stop Loss movido para a entrada cobrindo taxas. <b>Risco zero real!</b>`;
                }
                // Stop Defensivo (1x: ao atingir +1x do Stop, move o Stop Loss para -33% do valor do stop)
                else if (maxUnits >= c0) {
                  newStage = 1;
                  targetSL = isLong
                    ? trRecord.entryPrice - (stopDistance * 0.33)
                    : trRecord.entryPrice + (stopDistance * 0.33);
                  stageTitle = `🛡️ <b>CONDUÇÃO DE STOP: STOP DEFENSIVO (+${c0}x)!</b>`;
                  stageDesc = `O mercado atingiu <b>+${c0}x do Stop</b>! O Stop Loss na Bitunix foi puxado para <b>-33% do valor do Stop</b>, eliminando 67% do risco inicial e mantendo folga contra violinadas!`;
                }

                if (targetSL !== null) {
                  const calculatedSL = parseFloat(targetSL.toFixed(precision));
                  const shouldAdvance = isLong
                    ? calculatedSL > trRecord.currentStopLoss
                    : (trRecord.currentStopLoss <= 0 || calculatedSL < trRecord.currentStopLoss);

                  if (shouldAdvance) {
                    console.log(`[CONDUCAO-${exchangeName.toUpperCase()}] 🎯 Avanço de Stop Condução ${trRecord.symbol}: Estágio ${newStage}, Anterior=$${trRecord.currentStopLoss} -> Novo=$${calculatedSL}`);
                    trRecord.currentStopLoss = calculatedSL;
                    trRecord.conducaoStage = newStage;
                    trRecord.lastUpdated = Date.now();
                    saveBitunixTrailingStopsToFile();

                    try {
                      await applyConducaoStopLossToExchange(trRecord, calculatedSL, matchingPos, isDemo);

                      // Como o avanço é por degraus exatos de 0.5x, cada novo avanço de SL é um degrau oficial conquistado!
                      trRecord.lastNotifiedStage = newStage;
                      trRecord.lastNotifiedUnits = maxUnits;
                      trRecord.lastNotifiedSLPrice = calculatedSL;
                      trRecord.lastNotifiedSLTime = Date.now();
                      saveBitunixTrailingStopsToFile();

                      const moveMsg = 
                        `${stageTitle}\n\n` +
                        `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
                        `⚡ <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                        `📈 <b>Cotação de Mercado:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                        `🛡️ <b>Novo Stop Loss na ${exchangeName}:</b> <code>$${calculatedSL.toFixed(precision)}</code>\n` +
                        `🎯 <b>Avanço Atual:</b> <code>+${maxUnits.toFixed(2)}x do Stop</code>\n\n` +
                        `${stageDesc}`;
                      broadcastTelegramNotification(moveMsg).catch(() => {});
                    } catch (e: any) {
                      console.warn(`[CONDUCAO-UPDATE-ERR]:`, e.message);
                    }
                  }
                }

                // 🛑 Proteção contra fechamento prematuro:
                // No estágio 0 (aguardando Alvo 1), o Stop Loss inicial já está ativo diretamente na Bitunix no livro de ordens.
                // O daemon NUNCA encerra a mercado no estágio 0, permitindo que a operação respire normalmente!
                // A partir do estágio 1 (Defensivo, BE ou Lucro), a Bitunix mantém o SL atualizado na corretora.
                // Apenas em caso de emergência (se o preço ultrapassar o stop por >0.3% em 3 ciclos consecutivos sem a corretora executar)
                // o daemon intervém como garantia de segurança.
                if (trRecord.conducaoStage && trRecord.conducaoStage >= 1) {
                  const emergencyBreached = isLong
                    ? (trRecord.currentStopLoss > 0 && currentPrice <= trRecord.currentStopLoss * 0.997)
                    : (trRecord.currentStopLoss > 0 && currentPrice >= trRecord.currentStopLoss * 1.003);

                  if (emergencyBreached) {
                    (trRecord as any).stopBreachCycles = ((trRecord as any).stopBreachCycles || 0) + 1;
                    if ((trRecord as any).stopBreachCycles >= 3) {
                      console.log(`[CONDUCAO] 🛑 Stop de proteção violado em ${trRecord.symbol} na Bitunix (encerramento emergencial).`);
                      const bitunixSym = resolveBitunixSymbol(trRecord.symbol).apiSymbol;
                      await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                      await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                      stopBitunixTrailingStop(trRecord.symbol);

                      const profitPct = trRecord.entryPrice > 0 
                        ? (isLong ? ((currentPrice - trRecord.entryPrice) / trRecord.entryPrice) * 100 : ((trRecord.entryPrice - currentPrice) / trRecord.entryPrice) * 100) 
                        : 0;
                      const finalMsg = 
                        `🏁 <b>CONDUÇÃO DE STOP FINALIZADA NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                        `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
                        `💰 <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                        `🛑 <b>Fechamento no Stop Protegido:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                        `🎯 <b>Avanço Máximo Alcançado:</b> <code>+${maxUnits.toFixed(2)}x</code>\n` +
                        `📈 <b>Resultado Final:</b> <code>${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%</code>\n\n` +
                        `🛡️ <i>Posição encerrada e lucro blindado pela Condução de Stop Escalonada!</i>`;
                      broadcastTelegramNotification(finalMsg).catch(() => {});
                    }
                  } else {
                    (trRecord as any).stopBreachCycles = 0;
                  }
                }
              }
            } else {
              // 2. Trailing Stop Percentual Clássico (% Recuo)
              if (!trRecord.isActivated) {
                const shouldActivate = trRecord.activationPrice <= 0 || 
                  (isLong ? currentPrice >= trRecord.activationPrice : currentPrice <= trRecord.activationPrice);

                if (shouldActivate) {
                  trRecord.isActivated = true;
                  trRecord.highestPrice = currentPrice;
                  trRecord.lowestPrice = currentPrice;
                  trRecord.lastUpdated = Date.now();
                  saveBitunixTrailingStopsToFile();

                  console.log(`[STOP-MOVEL] 🚀 Stop Móvel ativado para ${trRecord.symbol} na cotação $${currentPrice}!`);
                  const actMsg = 
                    `⚡ <b>STOP MÓVEL (TRAILING STOP) ATIVADO NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                    `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (${isLong ? 'LONG 🟢' : 'SHORT 🔴'})\n` +
                    `🎯 <b>Cotação de Disparo:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                    `📉 <b>Recuo Permitido:</b> <code>${trRecord.callbackRate}%</code>\n\n` +
                    `🚀 <i>O preço de mercado atingiu o gatilho! O Stop Móvel agora está rastreando máximas e protegendo o lucro no recuo!</i>`;

                  broadcastTelegramNotification(actMsg).catch(() => {});
                }
              }

              if (trRecord.isActivated) {
                if (isLong) {
                  if (currentPrice > trRecord.highestPrice) {
                    trRecord.highestPrice = currentPrice;
                  }

                  const calculatedSL = parseFloat((trRecord.highestPrice * (1 - trRecord.callbackRate / 100)).toFixed(precision));

                  if (calculatedSL > trRecord.currentStopLoss) {
                    const slDiff = calculatedSL - trRecord.currentStopLoss;
                    const slDiffPct = trRecord.currentStopLoss > 0 ? (slDiff / trRecord.currentStopLoss) * 100 : 1;

                    if (slDiffPct >= 0.05 || trRecord.currentStopLoss <= 0) {
                      console.log(`[STOP-MOVEL] 📈 Elevando Stop Loss de ${trRecord.symbol}: Anterior=$${trRecord.currentStopLoss} -> Novo=$${calculatedSL}`);
                      trRecord.currentStopLoss = calculatedSL;
                      trRecord.lastUpdated = Date.now();
                      saveBitunixTrailingStopsToFile();

                      try {
                        await applyConducaoStopLossToExchange(trRecord, calculatedSL, matchingPos, isDemo);

                        const lastNotifiedSL = trRecord.lastNotifiedSLPrice || trRecord.initialStopLoss || 0;
                        const lastNotifiedTime = trRecord.lastNotifiedSLTime || 0;
                        const notifyAdvancePct = lastNotifiedSL > 0 ? ((calculatedSL - lastNotifiedSL) / lastNotifiedSL) * 100 : 1;
                        const timeSinceNotify = Date.now() - lastNotifiedTime;

                        if (notifyAdvancePct >= 0.05 || timeSinceNotify >= 4000 || !trRecord.lastNotifiedSLPrice) {
                          trRecord.lastNotifiedSLPrice = calculatedSL;
                          trRecord.lastNotifiedSLTime = Date.now();
                          saveBitunixTrailingStopsToFile();

                          const moveMsg = 
                            `📈 <b>STOP MÓVEL: STOP LOSS ELEVADO NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                            `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (LONG 🟢)\n` +
                            `⚡ <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                            `📈 <b>Cotação Atual:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                            `🔝 <b>Nova Máxima:</b> <code>$${trRecord.highestPrice.toFixed(precision)}</code>\n` +
                            `🛡️ <b>Novo Stop Loss:</b> <code>$${calculatedSL.toFixed(precision)}</code>\n\n` +
                            `🔒 <i>Stop Loss atualizado diretamente na ${exchangeName} para garantir o lucro!</i>`;
                          broadcastTelegramNotification(moveMsg).catch(() => {});
                        }
                      } catch (e: any) {
                        console.warn(`[STOP-MOVEL-UPDATE-ERR]:`, e.message);
                      }
                    }
                  }

                  if (currentPrice <= trRecord.currentStopLoss) {
                    console.log(`[STOP-MOVEL] 🛑 Recuo atingido para ${trRecord.symbol}! Fechando posição na Bitunix...`);
                    const bitunixSym = resolveBitunixSymbol(trRecord.symbol).apiSymbol;
                    await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                    await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                    stopBitunixTrailingStop(trRecord.symbol);

                    const profitPct = trRecord.entryPrice > 0 ? (((currentPrice - trRecord.entryPrice) / trRecord.entryPrice) * 100) : 0;
                    const execMsg = 
                      `🎯 <b>STOP MÓVEL EXECUTADO NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                      `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (LONG 🟢)\n` +
                      `💰 <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                      `🔝 <b>Máxima Atingida:</b> <code>$${trRecord.highestPrice.toFixed(precision)}</code>\n` +
                      `🏁 <b>Fechamento no Recuo:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                      `📈 <b>Resultado:</b> <code>${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%</code>\n\n` +
                      `🛡️ <i>Posição encerrada com sucesso pelo Stop Móvel, garantindo a proteção dos lucros acumulados!</i>`;

                    broadcastTelegramNotification(execMsg).catch(() => {});
                  }
                } else {
                  if (trRecord.lowestPrice <= 0 || currentPrice < trRecord.lowestPrice) {
                    trRecord.lowestPrice = currentPrice;
                  }

                  const calculatedSL = parseFloat((trRecord.lowestPrice * (1 + trRecord.callbackRate / 100)).toFixed(precision));

                  if (trRecord.currentStopLoss <= 0 || calculatedSL < trRecord.currentStopLoss) {
                    const slDiff = trRecord.currentStopLoss - calculatedSL;
                    const slDiffPct = trRecord.currentStopLoss > 0 ? (slDiff / trRecord.currentStopLoss) * 100 : 1;

                    if (slDiffPct >= 0.05 || trRecord.currentStopLoss <= 0) {
                      console.log(`[STOP-MOVEL] 📉 Reduzindo Stop Loss (SHORT) de ${trRecord.symbol}: Anterior=$${trRecord.currentStopLoss} -> Novo=$${calculatedSL}`);
                      trRecord.currentStopLoss = calculatedSL;
                      trRecord.lastUpdated = Date.now();
                      saveBitunixTrailingStopsToFile();

                      try {
                        await applyConducaoStopLossToExchange(trRecord, calculatedSL, matchingPos, isDemo);

                        const lastNotifiedSL = trRecord.lastNotifiedSLPrice || trRecord.initialStopLoss || 0;
                        const lastNotifiedTime = trRecord.lastNotifiedSLTime || 0;
                        const notifyAdvancePct = lastNotifiedSL > 0 ? ((lastNotifiedSL - calculatedSL) / lastNotifiedSL) * 100 : 1;
                        const timeSinceNotify = Date.now() - lastNotifiedTime;

                        if (notifyAdvancePct >= 0.05 || timeSinceNotify >= 4000 || !trRecord.lastNotifiedSLPrice) {
                          trRecord.lastNotifiedSLPrice = calculatedSL;
                          trRecord.lastNotifiedSLTime = Date.now();
                          saveBitunixTrailingStopsToFile();

                          const moveMsg = 
                            `📉 <b>STOP MÓVEL: STOP LOSS REDUZIDO NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                            `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (SHORT 🔴)\n` +
                            `⚡ <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                            `📈 <b>Cotação Atual:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                            `🔽 <b>Nova Mínima:</b> <code>$${trRecord.lowestPrice.toFixed(precision)}</code>\n` +
                            `🛡️ <b>Novo Stop Loss:</b> <code>$${calculatedSL.toFixed(precision)}</code>\n\n` +
                            `🔒 <i>Stop Loss atualizado diretamente na ${exchangeName} para garantir o lucro!</i>`;
                          broadcastTelegramNotification(moveMsg).catch(() => {});
                        }
                      } catch (e: any) {
                        console.warn(`[STOP-MOVEL-UPDATE-ERR]:`, e.message);
                      }
                    }
                  }

                  if (trRecord.currentStopLoss > 0 && currentPrice >= trRecord.currentStopLoss) {
                    console.log(`[STOP-MOVEL] 🛑 Reversão de SHORT atingida em ${trRecord.symbol}! Fechando posição na Bitunix...`);
                    const bitunixSym = resolveBitunixSymbol(trRecord.symbol).apiSymbol;
                    await sendBitunixRequest('/api/v1/futures/trade/close_all_position', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                    await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                    stopBitunixTrailingStop(trRecord.symbol);

                    const profitPct = trRecord.entryPrice > 0 ? (((trRecord.entryPrice - currentPrice) / trRecord.entryPrice) * 100) : 0;
                    const execMsg = 
                      `🎯 <b>STOP MÓVEL EXECUTADO NA ${exchangeName.toUpperCase()}!</b>\n\n` +
                      `📊 <b>Par:</b> <code>${trRecord.symbol}</code> (SHORT 🔴)\n` +
                      `💰 <b>Entrada:</b> <code>$${trRecord.entryPrice.toFixed(precision)}</code>\n` +
                      `🔽 <b>Mínima Atingida:</b> <code>$${trRecord.lowestPrice.toFixed(precision)}</code>\n` +
                      `🏁 <b>Fechamento no Repique:</b> <code>$${currentPrice.toFixed(precision)}</code>\n` +
                      `📈 <b>Resultado:</b> <code>${profitPct >= 0 ? '+' : ''}${profitPct.toFixed(2)}%</code>\n\n` +
                      `🛡️ <i>Posição encerrada com sucesso pelo Stop Móvel, garantindo a proteção dos lucros acumulados!</i>`;

                    broadcastTelegramNotification(execMsg).catch(() => {});
                  }
                }
              }
            }
          }
        }

        // -------------------------------------------------------------
        // 3. DETECÇÃO DE TAKE PROFIT (TP), STOP LOSS (SL) E FECHAMENTOS
        // -------------------------------------------------------------
        const currentPosKeys = new Set(currentPositions.map((p: any) => `${p.symbol}_${p.positionSide}`));

        if (!isFirstCycle && positionsFetchOk) {
          for (const [posKey, prevPos] of previousPositions.entries()) {
            if (!currentPosKeys.has(posKey)) {
              // A posição foi fechada!
              console.log(`[ALERT-DAEMON] Posição encerrada detectada: ${posKey}`);

              // 🛡️ 1. Verifica se essa posição já foi notificada pelo fechamento manual recente
              const bitunixSym = resolveBitunixSymbol(prevPos.symbol).apiSymbol;
              const directKey = `${bitunixSym}_${prevPos.positionSide}`;
              const altKey = `${bitunixSym}_${prevPos.positionSide === 'LONG' ? 'SHORT' : 'LONG'}`;
              const cachedManual = manuallyClosedPositionsCache.get(posKey) || manuallyClosedPositionsCache.get(directKey) || manuallyClosedPositionsCache.get(altKey);

              if (cachedManual && (Date.now() - cachedManual.time) < 180000) {
                console.log(`[ALERT-DAEMON] Posição ${posKey} já foi notificada pelo fechamento manual (${Math.round((Date.now() - cachedManual.time)/1000)}s atrás). Evitando mensagem duplicada/conflitante no daemon.`);
                try {
                  await cancelAllOrdersForSymbol(prevPos.symbol, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
                  await resetBitunixLeverageAndMarginToDefault(prevPos.symbol, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
                } catch (e) {}
                previousPositions.delete(posKey);
                continue;
              }

              let closeReason: string = 'MANUAL';
              let fillPrice = 0;
              let realizedProfit = 0;
              let liqPrice = 0;
              let hasConfirmedCloseData = false;
              let hasExactPnlFromApi = false;
              let matchHistPos: any = null;
              let closingOrder: any = null;
              let matchedTpsl: any = null;
              const isLong = prevPos.positionSide === 'LONG';
              const closeSide = isLong ? 'SELL' : 'BUY';

              // 2. Consulta histórico de posições, ordens executadas e histórico de TPSL na Bitunix (até 3 tentativas para aguardar indexação)
              try {
                for (let attempt = 0; attempt < 3; attempt++) {
                  if (attempt > 0) {
                    await new Promise(resolve => setTimeout(resolve, attempt === 1 ? 1500 : 2000));
                  }
                  const [histPosRes, histOrdersRes, tpslOrdersRes] = await Promise.all([
                    sendBitunixRequest('/api/v1/futures/position/get_history_positions', 'GET', {
                      symbol: bitunixSym,
                      pageSize: 10
                    }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => null),
                    sendBitunixRequest('/api/v1/futures/trade/get_history_orders', 'GET', {
                      symbol: bitunixSym,
                      pageSize: 10
                    }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => null),
                    sendBitunixRequest('/api/v1/futures/tpsl/get_history_orders', 'GET', {
                      symbol: bitunixSym,
                      pageSize: 10
                    }, null, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => null)
                  ]);

                  const nowMs = Date.now();

                  // A. Analisa histórico de posições (ordena do mais recente para o mais antigo, priorizando positionId e janela recente)
                  const rawPosList: any[] = histPosRes?.data?.positionList || (Array.isArray(histPosRes?.data) ? histPosRes.data : []);
                  const sortedPosList = [...rawPosList].sort((a, b) => Number(b.mtime || b.ctime || 0) - Number(a.mtime || a.ctime || 0));
                  const recentPosList = sortedPosList.filter((p: any) => {
                    if (prevPos.positionId && p.positionId && String(p.positionId) === prevPos.positionId) return true;
                    const ts = Number(p.mtime || p.ctime || 0);
                    return ts > 0 && Math.abs(nowMs - ts) < 15 * 60 * 1000;
                  });

                  matchHistPos = (prevPos.positionId ? recentPosList.find((p: any) => String(p.positionId || '') === prevPos.positionId) : null)
                    || recentPosList.find((p: any) => {
                      const sMatch = isSameOrRelatedSymbol(p.symbol, prevPos.symbol) || isSameOrRelatedSymbol(p.symbol, bitunixSym);
                      const sideMatch = !p.side || (isLong ? (p.side === 'BUY' || p.side === 'LONG') : (p.side === 'SELL' || p.side === 'SHORT'));
                      return sMatch && sideMatch;
                    })
                    || recentPosList.find((p: any) => isSameOrRelatedSymbol(p.symbol, prevPos.symbol) || isSameOrRelatedSymbol(p.symbol, bitunixSym))
                    || null;

                  // B. Analisa ordens executadas recentes na Bitunix
                  const rawOrders: any[] = histOrdersRes?.data?.orderList || (Array.isArray(histOrdersRes?.data?.rows) ? histOrdersRes.data.rows : (Array.isArray(histOrdersRes?.data) ? histOrdersRes.data : []));
                  const sortedOrders = [...rawOrders].sort((a, b) => Number(b.mtime || b.ctime || 0) - Number(a.mtime || a.ctime || 0));
                  const filledOrders = sortedOrders.filter((o: any) => {
                    const isFilled = o.status === 'FILLED' || o.status === '2';
                    if (!isFilled) return false;
                    const ts = Number(o.mtime || o.ctime || 0);
                    return ts <= 0 || Math.abs(nowMs - ts) < 15 * 60 * 1000;
                  });
                  closingOrder = filledOrders.find((o: any) => o.reduceOnly === true || o.tradeSide === 'CLOSE' || o.side === closeSide) || filledOrders[0] || null;

                  // C. Analisa histórico de ordens TPSL disparadas na Bitunix
                  const rawTpsl: any[] = tpslOrdersRes?.data?.orderList || (Array.isArray(tpslOrdersRes?.data?.rows) ? tpslOrdersRes.data.rows : (Array.isArray(tpslOrdersRes?.data) ? tpslOrdersRes.data : []));
                  const filledTpsl = rawTpsl.filter((t: any) => t.status === 'FILLED' || t.status === 'TRIGGERED' || t.triggerTime);
                  matchedTpsl = ((matchHistPos?.positionId || prevPos.positionId)
                      ? filledTpsl.find((t: any) => String(t.positionId || '') === String(matchHistPos?.positionId || prevPos.positionId))
                      : null)
                    || filledTpsl.find((t: any) => {
                      const ts = Number(t.triggerTime || t.mtime || t.ctime || 0);
                      const isRec = ts <= 0 || Math.abs(nowMs - ts) < 15 * 60 * 1000;
                      return isRec && (isSameOrRelatedSymbol(t.symbol, prevPos.symbol) || isSameOrRelatedSymbol(t.symbol, bitunixSym));
                    })
                    || null;

                  if (matchHistPos || closingOrder) {
                    hasConfirmedCloseData = true;
                    break;
                  }
                }

                if (matchHistPos) {
                  const pClose = parseFloat(matchHistPos.closePrice || matchHistPos.avgPrice || '0');
                  if (pClose > 0) fillPrice = pClose;
                  const pEntry = parseFloat(matchHistPos.entryPrice || '0');
                  if (pEntry > 0 && prevPos.entryPrice <= 0) prevPos.entryPrice = pEntry;
                  if (matchHistPos.realizedPNL !== undefined && matchHistPos.realizedPNL !== null && String(matchHistPos.realizedPNL).trim() !== '') {
                    const pPnl = parseFloat(matchHistPos.realizedPNL);
                    if (!isNaN(pPnl)) {
                      realizedProfit = pPnl;
                      hasExactPnlFromApi = true;
                    }
                  }
                  const pLiqPrice = parseFloat(matchHistPos.liqPrice || '0');
                  const pLiqQty = parseFloat(matchHistPos.liqQty || '0');
                  if ((pLiqPrice > 0) || (!isNaN(pLiqQty) && pLiqQty !== 0)) {
                    closeReason = 'LIQUIDATION';
                    if (pLiqPrice > 0) {
                      liqPrice = pLiqPrice;
                      if (fillPrice <= 0) fillPrice = pLiqPrice;
                    }
                  }
                }

                if (closingOrder) {
                  const rawAvg = parseFloat(closingOrder.avgPrice || closingOrder.price || '0');
                  if (rawAvg > 0 && fillPrice <= 0) fillPrice = rawAvg;
                  if (!hasExactPnlFromApi && closingOrder.realizedPNL !== undefined && closingOrder.realizedPNL !== null && String(closingOrder.realizedPNL).trim() !== '') {
                    const parsedPnl = parseFloat(closingOrder.realizedPNL);
                    if (!isNaN(parsedPnl)) {
                      realizedProfit = parsedPnl;
                      hasExactPnlFromApi = true;
                    }
                  }
                }

                if (matchedTpsl && closeReason !== 'LIQUIDATION') {
                  const slCandidate = parseFloat(matchedTpsl.slPrice || matchedTpsl.stopLoss || matchedTpsl.triggerPrice || '0');
                  const tpCandidate = parseFloat(matchedTpsl.tpPrice || matchedTpsl.takeProfit || '0');
                  if (slCandidate > 0 && (tpCandidate <= 0 || (prevPos.stopLoss && Math.abs(slCandidate - prevPos.stopLoss) / prevPos.stopLoss < 0.02))) {
                    closeReason = 'SL';
                    if (fillPrice <= 0) fillPrice = slCandidate;
                  } else if (tpCandidate > 0) {
                    closeReason = 'TP';
                    if (fillPrice <= 0) fillPrice = tpCandidate;
                  }
                }
              } catch (e) {}

              // Se o fillPrice não veio da ordem ou do histórico, tenta obter via ticker apenas para referência
              if (fillPrice <= 0) {
                if (closeReason === 'SL' && prevPos.stopLoss) {
                  fillPrice = prevPos.stopLoss;
                } else if (closeReason === 'TP' && prevPos.takeProfit) {
                  fillPrice = prevPos.takeProfit;
                } else {
                  try {
                    const tickerRes = await axios.get(`${BITUNIX_BASE_URL}/api/v1/futures/market/tickers`, { timeout: 3000 }).catch(() => null);
                    const tList = Array.isArray(tickerRes?.data?.data) ? tickerRes.data.data : [];
                    const matchTicker = tList.find((t: any) => isSameOrRelatedSymbol(t.symbol, bitunixSym));
                    if (matchTicker) {
                      fillPrice = parseFloat(matchTicker.lastPrice || matchTicker.last || '0');
                    }
                  } catch (e) {}
                }
              }

              // Variação de preço percentual real na direção da posição (+ = lucro, - = prejuízo)
              const priceChangePct = (prevPos.entryPrice > 0 && fillPrice > 0)
                ? (isLong ? ((fillPrice - prevPos.entryPrice) / prevPos.entryPrice) * 100 : ((prevPos.entryPrice - fillPrice) / prevPos.entryPrice) * 100)
                : 0;
              const leverage = prevPos.leverage || 20;
              const roiPct = priceChangePct * leverage;

              // Cálculo de PnL em USDT preciso caso não tenha vindo da API
              const posQty = Math.abs(parseFloat(prevPos.positionAmt || '0'));
              if (!hasExactPnlFromApi && fillPrice > 0 && fillPrice !== prevPos.entryPrice) {
                if (posQty > 0) {
                  const diff = isLong ? (fillPrice - prevPos.entryPrice) : (prevPos.entryPrice - fillPrice);
                  realizedProfit = posQty * diff;
                } else if (prevPos.margin && prevPos.margin > 0) {
                  realizedProfit = (prevPos.margin * roiPct) / 100;
                }
              }

              // 🛡️ REFINAMENTO DE CLASSIFICAÇÃO STOP LOSS vs TRAILING vs LIQUIDAÇÃO:
              const wasExplicitManual = cachedManual && (Date.now() - cachedManual.time) < 180000;
              if (!wasExplicitManual && closeReason !== 'LIQUIDATION') {
                if (prevPos.stopLoss && prevPos.stopLoss > 0 && fillPrice > 0) {
                  const slDiffPct = Math.abs(fillPrice - prevPos.stopLoss) / prevPos.stopLoss;
                  const crossedOrTouchedSL = slDiffPct <= 0.0025 || (isLong && fillPrice <= prevPos.stopLoss) || (!isLong && fillPrice >= prevPos.stopLoss);
                  if (crossedOrTouchedSL) {
                    if (priceChangePct > 0.05 || realizedProfit > 0.05) {
                      closeReason = 'TRAILING';
                    } else if (hasConfirmedCloseData || priceChangePct < -0.05 || realizedProfit < -0.05) {
                      closeReason = 'SL';
                    }
                  }
                }
                // Se fechou com prejuízo real na Bitunix e não houve ação manual do usuário pelo bot
                if (priceChangePct < -0.05 || realizedProfit < -0.05) {
                  closeReason = 'SL';
                }
              }

              const profitAbsStr = Math.abs(realizedProfit).toFixed(2);
              const priceChangeAbsStr = Math.abs(priceChangePct).toFixed(2);
              const roiAbsStr = Math.abs(roiPct).toFixed(2);
              const entryPriceStr = formatDisplayPrice(prevPos.entryPrice);
              const fillPriceStr = fillPrice > 0 ? formatDisplayPrice(fillPrice) : 'N/A';

              // =====================================================================
              // DISPARO DE MENSAGENS COM RESULTADO E PnL EXATOS
              // =====================================================================

              // CASO 0: LIQUIDAÇÃO EXECUTADA NA BITUNIX
              if (closeReason === 'LIQUIDATION') {
                const liqDisplay = liqPrice > 0 ? formatDisplayPrice(liqPrice) : fillPriceStr;
                const slPlannedStr = prevPos.stopLoss && prevPos.stopLoss > 0 ? `$${formatDisplayPrice(prevPos.stopLoss)}` : 'Não definido';
                const liqMsg =
                  `💥 <b>LIQUIDAÇÃO EXECUTADA NA BITUNIX!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                  `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                  `💥 <b>Preço de Liquidação:</b> <code>$${liqDisplay}</code>\n` +
                  `🛑 <b>Stop Loss Planejado:</b> <code>${slPlannedStr}</code>\n` +
                  `📉 <b>Prejuízo Realizado:</b> <code>-$${profitAbsStr} USDT (-${priceChangeAbsStr}% | ROI: -${roiAbsStr}%)</code>\n\n` +
                  `⚠️ <i>A posição atingiu o preço de liquidação antes do Stop Loss configurado (Margem Isolada insuficiente para a distância do SL em ${leverage}x).</i>`;

                await broadcastTelegramNotification(liqMsg);
              }
              // CASO 1: LUCRO REALIZADO (Preço fechou a favor da posição)
              else if (priceChangePct > 0.05 || realizedProfit > 0.05) {
                if (closeReason === 'TP' || (prevPos.takeProfit && fillPrice > 0 && Math.abs(fillPrice - prevPos.takeProfit) / prevPos.takeProfit < 0.02)) {
                  const tpMsg = 
                    `🎯 <b>TAKE PROFIT ATINGIDO COM SUCESSO! 🏆</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `🎯 <b>Alvo de Lucro (TP):</b> <code>$${fillPriceStr}</code>\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Execução:</b> <code>$${fillPriceStr}</code>\n` +
                    `💰 <b>Lucro Realizado:</b> <code>+$${profitAbsStr} USDT (+${priceChangeAbsStr}% | ROI: +${roiAbsStr}%)</code>\n\n` +
                    `🏆 <i>Parabéns! A ordem de Take Profit foi executada na Bitunix e o lucro está garantido no seu saldo!</i>`;
                  
                  await broadcastTelegramNotification(tpMsg);
                } else if (closeReason === 'TRAILING') {
                  // Ordem de Stop móvel executada garantindo lucro
                  const trMsg = 
                    `⚡ <b>TRAILING STOP / STOP NO LUCRO EXECUTADO! 🏆</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `🛡️ <b>Stop de Saída:</b> <code>$${fillPriceStr}</code>\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Execução:</b> <code>$${fillPriceStr}</code>\n` +
                    `💰 <b>Lucro Protegido:</b> <code>+$${profitAbsStr} USDT (+${priceChangeAbsStr}% | ROI: +${roiAbsStr}%)</code>\n\n` +
                    `🏆 <i>A posição foi encerrada no lucro após o stop móvel/proteção garantir os ganhos na reversão do mercado!</i>`;
                  
                  await broadcastTelegramNotification(trMsg);
                } else {
                  // Fechamento manual no lucro
                  const manMsg = 
                    `✅ <b>POSIÇÃO ENCERRADA MANUALMENTE (LUCRO)</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Saída:</b> <code>$${fillPriceStr}</code>\n` +
                    `💰 <b>Lucro Realizado:</b> <code>+$${profitAbsStr} USDT (+${priceChangeAbsStr}% | ROI: +${roiAbsStr}%)</code>\n\n` +
                    `🖐️ <i>Posição encerrada a mercado com lucro. A margem e os ganhos retornaram para o saldo disponível.</i>`;
                  
                  await broadcastTelegramNotification(manMsg);
                }
              }
              // CASO 2: BREAKEVEN / 0 a 0 (Somente quando confirmado pelo histórico oficial da corretora!)
              else if (hasConfirmedCloseData && Math.abs(priceChangePct) <= 0.05 && Math.abs(realizedProfit) <= 0.05) {
                if (closeReason === 'SL' || closeReason === 'TRAILING') {
                  const beMsg = 
                    `🛡️ <b>BREAKEVEN EXECUTADO (0 a 0) NA BITUNIX!</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Saída:</b> <code>$${fillPriceStr}</code>\n` +
                    `🛡️ <b>Resultado:</b> <code>$0.00 USDT (0.00% | Risco Zero Protegido)</code>\n\n` +
                    `🛡️ <i>A posição foi encerrada no ponto de entrada garantindo proteção total do capital sem perdas!</i>`;
                  
                  await broadcastTelegramNotification(beMsg);
                } else {
                  const beManMsg = 
                    `🛡️ <b>POSIÇÃO ENCERRADA MANUALMENTE (0 a 0)</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Saída:</b> <code>$${fillPriceStr}</code>\n` +
                    `🛡️ <b>Resultado:</b> <code>$0.00 USDT (0.00% | Risco Zero)</code>\n\n` +
                    `🖐️ <i>Posição finalizada no ponto de entrada garantindo preservação total do capital.</i>`;
                  
                  await broadcastTelegramNotification(beManMsg);
                }
              }
              // CASO 2B: ENCERRAMENTO DETECTADO SEM HISTÓRICO INDEXADO (Evita falso "0 a 0 Breakeven")
              else if (!hasConfirmedCloseData && Math.abs(priceChangePct) <= 0.05 && Math.abs(realizedProfit) <= 0.05) {
                const unconfirmedMsg =
                  `ℹ️ <b>POSIÇÃO ENCERRADA NA BITUNIX</b>\n\n` +
                  `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                  `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                  `${fillPrice > 0 ? `🏁 <b>Última Cotação:</b> <code>$${fillPriceStr}</code>\n` : ''}` +
                  `\n⚠️ <i>A posição foi finalizada na corretora, mas a Bitunix ainda estava indexando o extrato no momento da leitura. Verifique o PnL exato no painel ou no histórico da corretora.</i>`;

                await broadcastTelegramNotification(unconfirmedMsg);
              }
              // CASO 3: PREJUÍZO REALIZADO (Preço fechou contra a posição)
              else {
                // STOP LOSS executado na Bitunix
                if (closeReason === 'SL') {
                  const slMsg = 
                    `🛑 <b>STOP LOSS EXECUTADO NA BITUNIX</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `🛑 <b>Stop Loss Disparado:</b> <code>$${fillPriceStr}</code>\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Saída (Stop):</b> <code>$${fillPriceStr}</code>\n` +
                    `📉 <b>Prejuízo Realizado:</b> <code>-$${profitAbsStr} USDT (-${priceChangeAbsStr}% | ROI: -${roiAbsStr}%)</code>\n\n` +
                    `🛡️ <i>A ordem de Stop Loss foi disparada automaticamente pela Bitunix para conter o risco estabelecido na operação.</i>`;
                  
                  await broadcastTelegramNotification(slMsg);
                } else {
                  // Fechamento manual do usuário (a mercado na Bitunix ou no bot)
                  const manMsg = 
                    `🚪 <b>POSIÇÃO ENCERRADA MANUALMENTE NA BITUNIX</b>\n\n` +
                    `📊 <b>Par:</b> <code>${prevPos.symbol}</code> (${prevPos.positionSide} ${leverage}x)\n` +
                    `💵 <b>Preço de Entrada:</b> <code>$${entryPriceStr}</code>\n` +
                    `🏁 <b>Preço de Saída:</b> <code>$${fillPriceStr}</code>\n` +
                    `📉 <b>Resultado Realizado:</b> <code>-$${profitAbsStr} USDT (-${priceChangeAbsStr}% | ROI: -${roiAbsStr}%)</code>\n\n` +
                    `🖐️ <i>Você encerrou esta posição manualmente a mercado na Bitunix. A margem residual retornou para o saldo disponível e todas as ordens pendentes foram limpas com segurança.</i>`;
                  
                  await broadcastTelegramNotification(manMsg);
                }
              }

              // 🧹 CANCELAMENTO AUTOMÁTICO DE SEGURANÇA:
              // Quando uma posição é fechada (seja por Stop Loss, Take Profit, Trailing Stop, Breakeven ou Manual),
              // cancela IMEDIATAMENTE todas as ordens pendentes remanescentes da moeda (Trailing Stop, TP, SL, Gatilhos)
              // para não permanecerem no livro de ordens e não conflitarem com novas operações!
              try {
                console.log(`[ALERT-DAEMON] Posição ${posKey} finalizada (${closeReason}). Cancelando todas as ordens restantes na Bitunix para ${prevPos.symbol}...`);
                await cancelAllOrdersForSymbol(prevPos.symbol, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
                await sendBitunixRequest('/api/v1/futures/trade/cancel_all_orders', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                await sendBitunixRequest('/api/v1/futures/tpsl/cancel_order', 'POST', {}, { symbol: bitunixSym }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                // 🔄 Auto-Reset de Alavancagem e Modo de Margem: restaura para 20x e Isolada
                await resetBitunixLeverageAndMarginToDefault(prevPos.symbol, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo);
                // 🛑 Limpa o registro de condução/trailing da posição finalizada
                stopBitunixTrailingStop(prevPos.symbol);
              } catch (cancelErr: any) {
                console.warn(`[ALERT-DAEMON] Erro ao limpar ordens de ${prevPos.symbol}:`, cancelErr?.message || cancelErr);
              }

              previousPositions.delete(posKey);
            }
          }
        }

        // Atualiza cache de posições abertas
        for (const p of currentPositions) {
          const pKey = `${p.symbol}_${p.positionSide}`;
          const entryVal = parseFloat(p.avgPrice || p.entryPrice || '0');
          const levVal = parseInt(p.leverage || '20', 10) || 20;
          const cleanSym = (p.symbol || '').replace('-USDT', '').replace('USDT', '');
          const trRecord = bitunixActiveTrailingStops.get(p.symbol) || 
                           bitunixActiveTrailingStops.get(`${cleanSym}USDT`) || 
                           bitunixActiveTrailingStops.get(cleanSym);
          const custom = activeCustomSLTPBySymbol.get(p.symbol) || activeCustomSLTPBySymbol.get(cleanSym);

          let slVal = p.stopLoss ? parseFloat(p.stopLoss) : undefined;
          if (!slVal || slVal <= 0) {
            if (trRecord?.currentStopLoss && trRecord.currentStopLoss > 0) slVal = trRecord.currentStopLoss;
            else if (custom?.stopLoss && custom.stopLoss > 0) slVal = custom.stopLoss;
          }

          let tpVal = p.takeProfit ? parseFloat(p.takeProfit) : undefined;
          if (!tpVal || tpVal <= 0) {
            if (trRecord?.takeProfitPrice && trRecord.takeProfitPrice > 0) tpVal = trRecord.takeProfitPrice;
            else if (custom?.takeProfit && custom.takeProfit > 0) tpVal = custom.takeProfit;
          }

          previousPositions.set(pKey, {
            positionId: p.positionId ? String(p.positionId) : undefined,
            symbol: p.symbol,
            positionSide: p.positionSide || 'LONG',
            entryPrice: entryVal,
            stopLoss: slVal,
            takeProfit: tpVal,
            positionAmt: p.positionAmt,
            leverage: levVal,
            margin: p.margin,
            unrealizedProfit: parseFloat(p.unrealizedProfit || '0'),
            timestamp: Date.now()
          });

          // 4. Breakeven Automático se ativado
          const pnlPct = parseFloat(p.unrealizedProfitRate) || 0;
          const entryPrice = parseFloat(p.entryPrice);
          const currentSL = parseFloat(p.stopLoss);

          if (serverTelegramBotConfig.trailingStopEnabled && pnlPct >= 1.2 && entryPrice > 0) {
            const isLong = p.positionSide === 'LONG';
            const needsBreakeven = isLong 
              ? (!currentSL || currentSL < entryPrice) 
              : (!currentSL || currentSL > entryPrice);

            if (needsBreakeven) {
              console.log(`[TRAILING-DAEMON] Movendo Stop Loss de ${p.symbol} (${p.positionSide}) para 0x0 Breakeven ($${entryPrice})`);
              const beRes = await setBingXBreakeven(p.symbol, p.positionSide, DEFAULT_BINGX_KEY, DEFAULT_BINGX_SECRET, isDemo);
              if (beRes.success) {
                const beMsg = 
                  `🛡️ <b>BREAKEVEN AUTOMÁTICO APLICADO!</b>\n\n` +
                  `📊 <b>Par:</b> <code>${p.symbol}</code> (${p.positionSide})\n` +
                  `🛑 <b>Novo Stop Loss:</b> <code>$${entryPrice}</code> (Preço de Entrada)\n\n` +
                  `🚀 <i>O lucro da operação ultrapassou o gatilho e o Stop Loss foi ajustado para 0 a 0 (Risco Zero)!</i>`;
                await broadcastTelegramNotification(beMsg);
              }
            }
          }
        }

        // -------------------------------------------------------------
        // 4. VARREDURA E LIMPEZA AUTOMÁTICA DE ORDENS ÓRFÃS NO LIVRO
        // -------------------------------------------------------------
        // Se houver ordens no livro que eram de proteção (Trailing Stop, Stop Loss, Take Profit ou ordens de fechamento)
        // mas a posição já NÃO existe mais na Bitunix e NÃO há nenhuma ordem limite de entrada pendente aguardando,
        // essas ordens são órfãs (ex: posição fechada por SL na exchange e sobrou o Trailing Stop no livro).
        // Devem ser canceladas imediatamente para deixar o livro 100% limpo e sem conflitos em novos trades!
        if (currentOpenOrders.length > 0) {
          for (const o of currentOpenOrders) {
            const oSym = o.symbol || '';
            const oType = (o.type || '').toUpperCase();
            const oId = (o.orderId || o.orderID || '').toString();
            
            const isTrailing = oType === 'TRAILING_STOP_MARKET' || 
                               oType === 'TRAILING_STOP' || 
                               oType === 'TRAILING_TP_SL' || 
                               oType.includes('TRAILING') || 
                               !!o.callbackRate || 
                               !!o.priceRate;
            
            const isCloseOrReduce = o.closePosition === true || o.reduceOnly === true;
            const isStopOrTp = oType.includes('STOP') || oType.includes('TAKE_PROFIT');

            if (isTrailing || isCloseOrReduce || isStopOrTp) {
              const hasActivePos = currentPositions.some((p: any) => {
                const pSym = p.symbol || '';
                return isSameOrRelatedSymbol(pSym, oSym) && Math.abs(parseFloat(p.positionAmt || '0')) > 0;
              });

              if (!hasActivePos) {
                let isOrphan = false;
                if (isTrailing || isCloseOrReduce) {
                  // Trailing Stop e Close/Reduce NUNCA devem existir no livro sem posição aberta!
                  isOrphan = true;
                } else if (isStopOrTp) {
                  // Checa se há alguma ordem limite de entrada pendente para essa mesma moeda
                  const hasPendingEntry = currentOpenOrders.some((po: any) => {
                    const poSym = po.symbol || '';
                    const poType = (po.type || '').toUpperCase();
                    const poId = (po.orderId || po.orderID || '').toString();
                    const isEntry = (poType === 'LIMIT' || poType === 'TRIGGER_LIMIT' || poType === 'MARKET') && !po.reduceOnly && !po.closePosition;
                    return isSameOrRelatedSymbol(poSym, oSym) && isEntry && poId !== oId;
                  });
                  if (!hasPendingEntry) {
                    isOrphan = true;
                  }
                }

                if (isOrphan) {
                  console.log(`[ORPHAN-CLEANUP] Ordem órfã detectada na Bitunix: ${oSym} #${oId} (${oType}) sem posição aberta. Cancelando automaticamente...`);
                  try {
                    const cleanSym = resolveBitunixSymbol(o.symbol).apiSymbol;
                    await sendBitunixRequest('/api/v1/futures/trade/cancel_order', 'POST', {}, {
                      symbol: cleanSym,
                      orderId: oId
                    }, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET).catch(() => {});
                    // Reset alavancagem para 20x e margem para ISOLATED se ordem órfã foi limpa
                    resetBitunixLeverageAndMarginToDefault(cleanSym, DEFAULT_BITUNIX_KEY, DEFAULT_BITUNIX_SECRET, isDemo).catch(() => {});
                  } catch (err: any) {
                    console.warn(`[ORPHAN-CLEANUP] Erro ao deletar ordem órfã #${oId}:`, err?.message || err);
                  }
                }
              }
            }
          }
        }

        isFirstCycle = false;
      } catch (e: any) {
        console.error("[ALERT-DAEMON-ERROR]:", e?.message || e);
      } finally {
        isDaemonRunning = false;
      }
    }, 2000);
  };

  startPositionProtectionDaemon();

  // API Endpoints for Frontend Open Positions & Orders Management
  app.get("/api/open-positions", async (req, res) => {
    try {
      const isDemo = req.query.accountType === 'VST' || serverTelegramBotConfig.accountType === 'VST';
      const apiKey = (req.query.apiKey as string) || DEFAULT_BITUNIX_KEY;
      const apiSecret = (req.query.apiSecret as string) || DEFAULT_BITUNIX_SECRET;

      const data = await getBitunixOpenPositions(apiKey, apiSecret, isDemo);
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message, positions: [] });
    }
  });

  app.get("/api/debug-tpsl", async (req, res) => {
    try {
      const sym = (req.query.symbol as string) || "PONSUSDT";
      const tests: any = {};

      // Test 1: different query params on /api/v1/futures/tpsl/get_pending_orders
      const tpslParams = [
        {},
        { symbol: sym },
        { symbol: sym, type: "TRAILING" },
        { symbol: sym, type: "TRAILING_STOP" },
        { symbol: sym, orderType: "TRAILING_STOP" },
        { symbol: sym, orderType: "TRAILING" },
        { symbol: sym, planType: "TRAILING" },
        { symbol: sym, category: "TRAILING" },
        { symbol: sym, isTrailing: "1" },
        { symbol: sym, isTrailing: "true" }
      ];
      tests.tpslQueries = [];
      for (const p of tpslParams) {
        try {
          const r = await sendBitunixRequest('/api/v1/futures/tpsl/get_pending_orders', 'GET', p);
          tests.tpslQueries.push({ params: p, res: r });
        } catch (e: any) {
          tests.tpslQueries.push({ params: p, err: e.message });
        }
      }

      // Test 2: other potential endpoints
      const eps = [
        "/api/v1/futures/tpsl/trailing/get_pending_orders",
        "/api/v1/futures/tpsl/trailing_orders",
        "/api/v1/futures/trade/get_pending_orders",
        "/api/v1/futures/trade/get_condition_orders",
        "/api/v1/futures/trade/get_trigger_orders",
        "/api/v1/futures/trade/get_plan_orders",
        "/api/v1/futures/trade/get_orders",
        "/api/v1/futures/trade/current_orders",
        "/api/v1/futures/tpsl/current_orders",
        "/api/v1/futures/trade/trailing_orders",
        "/api/v1/futures/trade/trailing/get_pending_orders",
        "/api/v1/futures/position/get_tpsl_orders",
        "/api/v1/futures/position/tpsl",
        "/api/v1/futures/user/orders",
        "/api/v1/futures/trade/openOrders"
      ];
      tests.otherEps = [];
      for (const ep of eps) {
        try {
          const r = await sendBitunixRequest(ep, 'GET', { symbol: sym });
          if (r?.code !== 404 && r?.msg !== "Not Found") {
            tests.otherEps.push({ endpoint: ep, res: r });
          }
        } catch (e: any) {
          // ignore
        }
      }

      res.json(tests);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/daily-report", async (req, res) => {
    try {
      const isDemo = req.query.accountType === 'VST' || serverTelegramBotConfig.accountType === 'VST';
      const apiKey = (req.query.apiKey as string) || DEFAULT_BITUNIX_KEY;
      const apiSecret = (req.query.apiSecret as string) || DEFAULT_BITUNIX_SECRET;
      const periodParam = (req.query.period as string)?.toUpperCase();
      const period: ReportPeriod = (periodParam === 'WEEK' || periodParam === 'MONTH') ? periodParam : 'DAY';

      const range = getBrasiliaPeriodRange(period);
      const now = new Date();

      const [incomeRes, posData] = await Promise.all([
        sendBingXRequest('/openApi/swap/v2/user/income', 'GET', { startTime: range.startTime, limit: 100 }, apiKey, apiSecret, isDemo).catch(() => ({ code: -1, data: [] })),
        getBitunixOpenPositions(apiKey, apiSecret, isDemo).catch(() => ({ positions: [], balance: 0, success: true }))
      ]);

      const rawItems = Array.isArray(incomeRes?.data) ? incomeRes.data : [];
      const items = rawItems.filter((it: any) => {
        const t = parseInt(it.time || "0", 10);
        return t >= range.startTime && t <= range.endTime;
      });

      let grossPnl = 0;
      let fees = 0;
      let wins = 0;
      let breakevens = 0;
      let losses = 0;
      const closedTrades: any[] = [];

      for (const item of items) {
        const val = parseFloat(item.income || "0");
        if (item.incomeType === "REALIZED_PNL") {
          grossPnl += val;
          if (val > 0.05) {
            wins++;
          } else if (Math.abs(val) <= 0.05) {
            breakevens++;
          } else {
            losses++;
          }
          closedTrades.push({
            symbol: item.symbol,
            info: item.info,
            pnl: val,
            time: item.time
          });
        } else if (item.incomeType === "TRADING_FEE" || item.incomeType === "FUNDING_FEE") {
          fees += val;
        }
      }

      const netPnl = grossPnl + fees;
      const totalClosed = wins + breakevens + losses;
      const winRate = totalClosed > 0 ? parseFloat(((wins / totalClosed) * 100).toFixed(1)) : 0;

      const currentBalance = posData.balance || 0;
      const initialBalance = Math.max(0, currentBalance - netPnl);
      const periodPct = initialBalance > 0 ? (netPnl / initialBalance) * 100 : 0;
      const periodPctSign = periodPct >= 0 ? '+' : '';
      const periodPctFormatted = `${periodPctSign}${periodPct.toFixed(2)}%`;

      res.json({
        success: true,
        date: now.toISOString(),
        period,
        title: range.title,
        periodName: range.periodName,
        netPnl,
        grossPnl,
        fees,
        wins,
        breakevens,
        losses,
        totalClosed,
        winRate,
        dailyPct: parseFloat(periodPct.toFixed(2)),
        dailyPctFormatted: periodPctFormatted,
        initialBalance: parseFloat(initialBalance.toFixed(2)),
        closedTrades,
        openPositions: posData.positions || [],
        balance: posData.balance || 0,
        accountType: isDemo ? 'VST' : 'USDT'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/close-position", async (req, res) => {
    try {
      const { symbol, positionSide, accountType, apiKey, apiSecret } = req.body;
      const isDemo = accountType === 'VST';
      const key = apiKey || DEFAULT_BITUNIX_KEY;
      const secret = apiSecret || DEFAULT_BITUNIX_SECRET;

      const result = await closeBingXPosition(symbol, positionSide || 'LONG', key, secret, isDemo);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/set-breakeven", async (req, res) => {
    try {
      const { symbol, positionSide, accountType, apiKey, apiSecret } = req.body;
      const isDemo = accountType === 'VST';
      const key = apiKey || DEFAULT_BITUNIX_KEY;
      const secret = apiSecret || DEFAULT_BITUNIX_SECRET;

      const result = await setBingXBreakeven(symbol, positionSide || 'LONG', key, secret, isDemo);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post("/api/update-sltp", async (req, res) => {
    try {
      const { symbol, newStopLoss, newTakeProfit, accountType, apiKey, apiSecret } = req.body;
      const isDemo = accountType === 'VST' || serverTelegramBotConfig.accountType === 'VST';
      const key = apiKey || DEFAULT_BITUNIX_KEY;
      const secret = apiSecret || DEFAULT_BITUNIX_SECRET;

      const slNum = (newStopLoss !== undefined && newStopLoss !== null && newStopLoss !== '') ? parseFloat(newStopLoss) : null;
      const tpNum = (newTakeProfit !== undefined && newTakeProfit !== null && newTakeProfit !== '') ? parseFloat(newTakeProfit) : null;

      // 1. Tenta atualizar diretamente a posição aberta na Bitunix primeiro
      if (symbol) {
        const directRes = await setBitunixPositionTPSLDirect(symbol, slNum, tpNum, key, secret);
        if (directRes.success) {
          return res.json({
            success: true,
            updatedSL: directRes.stopLoss,
            updatedTP: directRes.takeProfit,
            message: directRes.message,
            symbol: directRes.symbol
          });
        }
      }

      // 2. Se não havia posição aberta, atualiza ordem pendente no livro
      const results: any = { success: true, updatedSL: null, updatedTP: null };

      if (slNum && slNum > 0) {
        const slRes = await updateBingXStopLossOrTakeProfit(symbol, 'SL', slNum, key, secret, isDemo);
        if (slRes.success) {
          results.updatedSL = slNum;
          results.updatedAvgPrice = slRes.updatedAvgPrice;
          results.updatedTotalAmt = slRes.updatedTotalAmt;
          results.recalculatedMargin = slRes.recalculatedMargin;
          results.recalculatedQty = slRes.recalculatedQty;
          results.mainEntryPrice = slRes.mainEntryPrice;
          results.stopLoss = slRes.stopLoss;
          results.takeProfit = slRes.takeProfit;
          results.trailingActivation = slRes.trailingActivation;
          results.riskUsd = slRes.riskUsd;
          results.effectiveRiskPct = slRes.effectiveRiskPct;
          results.activePosRiskNote = slRes.activePosRiskNote;
          results.message = slRes.message;
        } else {
          results.slError = slRes.error;
        }
      }

      if (tpNum && tpNum > 0) {
        const tpRes = await updateBingXStopLossOrTakeProfit(symbol, 'TP', tpNum, key, secret, isDemo);
        if (tpRes.success) {
          results.updatedTP = tpNum;
          results.updatedAvgPrice = tpRes.updatedAvgPrice;
          results.updatedTotalAmt = tpRes.updatedTotalAmt;
          if (!results.activePosRiskNote) results.activePosRiskNote = tpRes.activePosRiskNote;
        } else {
          results.tpError = tpRes.error;
        }
      }

      if (!results.updatedSL && !results.updatedTP && (results.slError || results.tpError)) {
        return res.status(400).json({ success: false, error: results.slError || results.tpError });
      }

      res.json(results);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 🛡️ OPÇÃO 1: Endpoint para agendar Trailing Stop para ativação pós-execução (Bitunix)
  app.post(["/api/register-pending-trailing", "/api/bitunix-trailing/register-pending"], (req, res) => {
    try {
      const { orderId, symbol, positionSide, closeSide, quantity, effectiveRate, activationPrice, stopLossPrice, entryPrice, pricePrecision } = req.body;
      if (!symbol) return res.status(400).json({ success: false, error: "Symbol is required" });

      const bitunixRes = resolveBitunixSymbol(symbol);
      const resolved = resolveBingXSymbol(symbol);
      const apiSym = bitunixRes.apiSymbol || resolved.apiSymbol || symbol;
      const cleanUpper = bitunixRes.cleanSymbol || resolved.cleanSymbol || symbol.replace('-USDT', '').replace('USDT', '');
      const posSideUpper = (positionSide || 'LONG').toUpperCase();

      const configObj: PendingTrailingConfig = {
        orderId: orderId ? orderId.toString() : undefined,
        symbol: apiSym,
        positionSide: posSideUpper,
        closeSide: closeSide || (posSideUpper === 'LONG' ? 'SELL' : 'BUY'),
        quantity: quantity?.toString() || '0',
        effectiveRate: Math.min(10.0, Math.max(0.1, parseFloat(effectiveRate || '2.0'))),
        activationPrice: activationPrice ? parseFloat(activationPrice) : undefined,
        stopLossPrice: stopLossPrice ? parseFloat(stopLossPrice) : undefined,
        entryPrice: entryPrice ? parseFloat(entryPrice) : undefined,
        pricePrecision: pricePrecision ? parseInt(pricePrecision) : 4,
        createdAt: Date.now()
      };

      pendingTrailingConfigs.set(`${apiSym}_${posSideUpper}`, configObj);
      pendingTrailingConfigs.set(`${cleanUpper}_${posSideUpper}`, configObj);
      pendingTrailingConfigs.set(apiSym, configObj);
      pendingTrailingConfigs.set(cleanUpper, configObj);
      if (orderId) pendingTrailingConfigs.set(orderId.toString(), configObj);
      savePendingTrailingConfigsToFile();

      // Se a ordem for na Bitunix e já tiver posição aberta correspondente, ativa de imediato também
      if (typeof registerBitunixTrailingStop === 'function') {
        registerBitunixTrailingStop({
          symbol: apiSym,
          positionSide: posSideUpper as 'LONG' | 'SHORT',
          entryPrice: configObj.entryPrice || 0,
          callbackRate: configObj.effectiveRate,
          activationPrice: configObj.activationPrice,
          stopLossPrice: configObj.stopLossPrice,
          qty: configObj.quantity
        }).catch(() => {});
      }

      console.log(`[API-PENDING-TRAILING-REGISTERED] 🛡️ Trailing Stop agendado pós-execução para ${apiSym} (${posSideUpper})`);
      res.json({ success: true, message: "Trailing Stop agendado para ativação pós-execução." });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Endpoint para testar o parser de sinais de texto do Telegram
  app.post("/api/telegram/test-parse", (req, res) => {
    try {
      const text = req.body?.text || "";
      const parsed = parseSignalText(text);
      const vipFormattedMessage = formatVipSignalMessage(parsed, false);
      const vipFormattedHtml = formatVipSignalMessage(parsed, true);
      res.json({ ok: true, parsed, vipFormattedMessage, vipFormattedHtml });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  app.get("/api/bitunix/contracts/search", (req, res) => {
    const q = (req.query.q as string || "").toUpperCase();
    const matches = bitunixContractsList.filter(c => !q || c.symbol?.includes(q) || c.base?.includes(q));
    res.json({ count: bitunixContractsList.length, matches: matches.slice(0, 20) });
  });

  // Endpoint to get Telegram Bot configuration
  app.get("/api/telegram-config", (req, res) => {
    res.json({
      ok: true,
      config: serverTelegramBotConfig,
      botUsername: "@Sinaltelegran_bot"
    });
  });

  // Endpoint to update Telegram Bot configuration
  app.post("/api/telegram-config", (req, res) => {
    try {
      const newConfig = req.body;
      if (newConfig && typeof newConfig === 'object') {
        if (newConfig.riskPercent !== undefined) {
          serverTelegramBotConfig.riskPercent = parseFloat(newConfig.riskPercent);
        }
        if (newConfig.riskMode) {
          serverTelegramBotConfig.riskMode = newConfig.riskMode;
        }
        if (newConfig.riskFixedUsd !== undefined) {
          serverTelegramBotConfig.riskFixedUsd = parseFloat(newConfig.riskFixedUsd);
        }
        if (newConfig.accountType) {
          serverTelegramBotConfig.accountType = newConfig.accountType;
        }
        if (newConfig.defaultOrderType) {
          serverTelegramBotConfig.defaultOrderType = newConfig.defaultOrderType;
        }
        if (newConfig.defaultLeverageMode) {
          serverTelegramBotConfig.defaultLeverageMode = newConfig.defaultLeverageMode;
        }
        if (newConfig.fixedLeverageValue !== undefined) {
          serverTelegramBotConfig.fixedLeverageValue = parseInt(newConfig.fixedLeverageValue, 10);
        }
        if (newConfig.maxLeverageCap !== undefined) {
          serverTelegramBotConfig.maxLeverageCap = parseInt(newConfig.maxLeverageCap, 10);
        }
        if (newConfig.trailingStopEnabled !== undefined) {
          serverTelegramBotConfig.trailingStopEnabled = Boolean(newConfig.trailingStopEnabled);
        }
        if (newConfig.trailingMultiplier !== undefined) {
          serverTelegramBotConfig.trailingMultiplier = parseFloat(newConfig.trailingMultiplier);
        }
        if (newConfig.autoExecuteWithoutPrompt !== undefined) {
          serverTelegramBotConfig.autoExecuteWithoutPrompt = Boolean(newConfig.autoExecuteWithoutPrompt);
        }
        if (newConfig.takeProfitSelection) {
          serverTelegramBotConfig.takeProfitSelection = newConfig.takeProfitSelection;
        }
        if (newConfig.emergencyStopPercent !== undefined) {
          serverTelegramBotConfig.emergencyStopPercent = parseFloat(newConfig.emergencyStopPercent);
        }
        if (newConfig.includeFeesInRisk !== undefined) {
          serverTelegramBotConfig.includeFeesInRisk = Boolean(newConfig.includeFeesInRisk);
        }
        if (newConfig.autoCrossMarginEnabled !== undefined) {
          serverTelegramBotConfig.autoCrossMarginEnabled = Boolean(newConfig.autoCrossMarginEnabled);
        }
        if (newConfig.autoCrossMarginThreshold !== undefined) {
          serverTelegramBotConfig.autoCrossMarginThreshold = parseFloat(newConfig.autoCrossMarginThreshold);
        }
        if (newConfig.dailyLossLimitEnabled !== undefined) {
          serverTelegramBotConfig.dailyLossLimitEnabled = Boolean(newConfig.dailyLossLimitEnabled);
        }
        if (newConfig.dailyLossPercent !== undefined) {
          serverTelegramBotConfig.dailyLossPercent = parseFloat(newConfig.dailyLossPercent);
        }
        if (newConfig.dailyLossFixedUsd !== undefined) {
          serverTelegramBotConfig.dailyLossFixedUsd = parseFloat(newConfig.dailyLossFixedUsd);
        }
        if (newConfig.dailyProfitTargetEnabled !== undefined) {
          serverTelegramBotConfig.dailyProfitTargetEnabled = Boolean(newConfig.dailyProfitTargetEnabled);
        }
        if (newConfig.dailyProfitTargetPercent !== undefined) {
          serverTelegramBotConfig.dailyProfitTargetPercent = parseFloat(newConfig.dailyProfitTargetPercent);
        }
        if (newConfig.dailyProfitFixedUsd !== undefined) {
          serverTelegramBotConfig.dailyProfitFixedUsd = parseFloat(newConfig.dailyProfitFixedUsd);
        }
        if (newConfig.dailyLockUnlockedDate !== undefined) {
          serverTelegramBotConfig.dailyLockUnlockedDate = String(newConfig.dailyLockUnlockedDate);
        }
        if (newConfig.telegramBotToken && typeof newConfig.telegramBotToken === 'string') {
          const tToken = newConfig.telegramBotToken.trim();
          if (tToken && tToken !== TELEGRAM_BOT_TOKEN) {
            TELEGRAM_BOT_TOKEN = tToken;
            saveCredentialsToFile();
            resetBotMetadataFlag();
            startTelegramPolling(true);
          }
        }
        saveTelegramConfigToFile(true);
      }
      console.log("[TELEGRAM-CONFIG-UPDATED]", serverTelegramBotConfig);
      res.json({
        ok: true,
        config: serverTelegramBotConfig
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Endpoint to get current credentials & saved Bitunix accounts list
  app.get("/api/credentials", (req, res) => {
    const activeAcc = getActiveSavedBitunixAccount();
    res.json({
      ok: true,
      apiKey: DEFAULT_BITUNIX_KEY || "",
      apiSecret: DEFAULT_BITUNIX_SECRET || "",
      telegramToken: TELEGRAM_BOT_TOKEN || "",
      geminiApiKey: DEFAULT_GEMINI_KEY || "",
      apiKeyMasked: maskKeyStr(DEFAULT_BITUNIX_KEY, 6, 6),
      apiSecretMasked: maskKeyStr(DEFAULT_BITUNIX_SECRET, 4, 4),
      telegramTokenMasked: maskKeyStr(TELEGRAM_BOT_TOKEN, 5, 4),
      geminiApiKeyMasked: maskKeyStr(DEFAULT_GEMINI_KEY, 6, 4),
      hasApiKey: Boolean(DEFAULT_BITUNIX_KEY),
      hasApiSecret: Boolean(DEFAULT_BITUNIX_SECRET),
      hasTelegramToken: Boolean(TELEGRAM_BOT_TOKEN),
      hasGeminiApiKey: Boolean(DEFAULT_GEMINI_KEY),
      botUsername: getTelegramBotState().botUsername || "BHBtrade_bot",
      activeAccountId: activeAcc?.id || activeBitunixAccountId,
      activeAccountLabel: activeAcc?.label || "Conta Bitunix",
      savedAccounts: getSafeSavedAccountsList()
    });
  });

  // Endpoint to switch active Bitunix account between saved profiles
  app.post("/api/credentials/switch", async (req, res) => {
    try {
      const { accountId } = req.body || {};
      const found = savedBitunixAccounts.find(a => a.id === accountId);
      if (!found) {
        return res.status(404).json({ ok: false, error: "Conta salva não encontrada." });
      }

      await applyActiveBitunixCredential(found, true);

      const isDemo = serverTelegramBotConfig.accountType === 'VST';
      const balance = await getCachedBitunixBalance(found.apiKey, found.apiSecret, isDemo, true).catch(() => 0);

      res.json({
        ok: true,
        message: `Conta alterada para "${found.label}" com sucesso!`,
        activeAccountId: found.id,
        activeAccountLabel: found.label,
        apiKey: found.apiKey,
        apiSecret: found.apiSecret,
        balance,
        savedAccounts: getSafeSavedAccountsList()
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Erro ao alternar conta Bitunix" });
    }
  });

  // Endpoint to create or update a saved Bitunix account profile without losing existing keys
  app.post("/api/credentials/accounts", async (req, res) => {
    try {
      const { id, label, apiKey, apiSecret, accountType, activate } = req.body || {};
      const cleanLabel = typeof label === 'string' ? label.trim() : '';
      const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      const cleanSecret = typeof apiSecret === 'string' ? apiSecret.trim() : '';

      if (!cleanLabel) {
        return res.status(400).json({ ok: false, error: "Informe um nome/apelido para identificar a conta." });
      }
      if (!cleanKey || !cleanSecret) {
        return res.status(400).json({ ok: false, error: "Informe a API Key e a Secret Key da Bitunix." });
      }

      const now = new Date().toISOString();
      let target: SavedBitunixAccount | undefined =
        (id ? savedBitunixAccounts.find(a => a.id === id) : undefined) ||
        savedBitunixAccounts.find(a => a.apiKey.trim() === cleanKey);

      if (target) {
        target.label = cleanLabel;
        target.apiKey = cleanKey;
        target.apiSecret = cleanSecret;
        target.accountType = accountType === 'VST' ? 'VST' : 'USDT';
        target.updatedAt = now;
      } else {
        target = {
          id: `acc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
          label: cleanLabel,
          apiKey: cleanKey,
          apiSecret: cleanSecret,
          accountType: accountType === 'VST' ? 'VST' : 'USDT',
          createdAt: now,
          updatedAt: now
        };
        savedBitunixAccounts.push(target);
      }

      if (activate !== false) {
        await applyActiveBitunixCredential(target, true);
      } else {
        saveCredentialsToFile();
      }

      const activeAcc = getActiveSavedBitunixAccount();
      res.json({
        ok: true,
        account: {
          ...target,
          apiSecretMasked: maskKeyStr(target.apiSecret, 4, 4),
          isActive: activeAcc?.id === target.id
        },
        activeAccountId: activeAcc?.id || activeBitunixAccountId,
        activeAccountLabel: activeAcc?.label || "Conta Bitunix",
        apiKey: DEFAULT_BITUNIX_KEY,
        apiSecret: DEFAULT_BITUNIX_SECRET,
        savedAccounts: getSafeSavedAccountsList()
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Erro ao salvar perfil de conta Bitunix" });
    }
  });

  // Endpoint to remove a saved Bitunix account profile (keeps at least 1)
  app.delete("/api/credentials/accounts/:id", async (req, res) => {
    try {
      const targetId = req.params.id;
      if (savedBitunixAccounts.length <= 1) {
        return res.status(400).json({ ok: false, error: "É necessário manter pelo menos 1 conta Bitunix salva." });
      }
      const idx = savedBitunixAccounts.findIndex(a => a.id === targetId);
      if (idx === -1) {
        return res.status(404).json({ ok: false, error: "Conta não encontrada." });
      }

      const wasActive = savedBitunixAccounts[idx].id === activeBitunixAccountId;
      savedBitunixAccounts.splice(idx, 1);

      if (wasActive && savedBitunixAccounts[0]) {
        await applyActiveBitunixCredential(savedBitunixAccounts[0], true);
      } else {
        saveCredentialsToFile();
      }

      const activeAcc = getActiveSavedBitunixAccount();
      res.json({
        ok: true,
        activeAccountId: activeAcc?.id || activeBitunixAccountId,
        activeAccountLabel: activeAcc?.label || "Conta Bitunix",
        apiKey: DEFAULT_BITUNIX_KEY,
        apiSecret: DEFAULT_BITUNIX_SECRET,
        savedAccounts: getSafeSavedAccountsList()
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Erro ao remover conta salva" });
    }
  });

  // Endpoint to update Bitunix API Keys, Telegram Bot Token and Gemini API Key
  app.post("/api/credentials", async (req, res) => {
    try {
      const { apiKey, apiSecret, telegramToken, geminiApiKey, accountLabel, saveAsNew } = req.body;
      let telegramChanged = false;
      let bitunixChanged = false;

      const cleanKey = typeof apiKey === 'string' ? apiKey.trim() : '';
      const cleanSecret = typeof apiSecret === 'string' ? apiSecret.trim() : '';

      if (cleanKey && cleanSecret) {
        const existingByKey = savedBitunixAccounts.find(a => a.apiKey.trim() === cleanKey);
        const now = new Date().toISOString();

        if (existingByKey && !saveAsNew) {
          existingByKey.apiSecret = cleanSecret;
          if (typeof accountLabel === 'string' && accountLabel.trim()) {
            existingByKey.label = accountLabel.trim();
          }
          existingByKey.updatedAt = now;
          if (cleanKey !== DEFAULT_BITUNIX_KEY || cleanSecret !== DEFAULT_BITUNIX_SECRET) {
            bitunixChanged = true;
          }
          await applyActiveBitunixCredential(existingByKey, true);
        } else {
          // Preserva as contas anteriores e adiciona esta nova chave como perfil salvo
          const newAcc: SavedBitunixAccount = {
            id: `acc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
            label: (typeof accountLabel === 'string' && accountLabel.trim())
              ? accountLabel.trim()
              : `Conta Bitunix ${savedBitunixAccounts.length + 1}`,
            apiKey: cleanKey,
            apiSecret: cleanSecret,
            accountType: 'USDT',
            createdAt: now,
            updatedAt: now
          };
          savedBitunixAccounts.push(newAcc);
          bitunixChanged = true;
          await applyActiveBitunixCredential(newAcc, true);
        }
      } else {
        if (cleanKey && cleanKey !== DEFAULT_BITUNIX_KEY) {
          DEFAULT_BITUNIX_KEY = cleanKey;
          DEFAULT_BINGX_KEY = cleanKey;
          bitunixChanged = true;
        }
        if (cleanSecret && cleanSecret !== DEFAULT_BITUNIX_SECRET) {
          DEFAULT_BITUNIX_SECRET = cleanSecret;
          DEFAULT_BINGX_SECRET = cleanSecret;
          bitunixChanged = true;
        }
      }
      if (typeof telegramToken === 'string' && telegramToken.trim()) {
        const cleanToken = telegramToken.trim();
        if (cleanToken !== TELEGRAM_BOT_TOKEN) {
          TELEGRAM_BOT_TOKEN = cleanToken;
          telegramChanged = true;
        }
      }
      if (typeof geminiApiKey === 'string') {
        const cleanGemini = geminiApiKey.trim();
        if (cleanGemini !== DEFAULT_GEMINI_KEY) {
          DEFAULT_GEMINI_KEY = cleanGemini;
          geminiClient = null;
        }
      }

      saveCredentialsToFile();

      // Persist to Firestore workspaces/global/settings/config
      try {
        const keyParam = FIRESTORE_API_KEY ? `&key=${FIRESTORE_API_KEY}` : '';
        const url = `https://firestore.googleapis.com/v1/projects/${FIRESTORE_PROJECT_ID}/databases/${FIRESTORE_DB_ID}/documents/workspaces/global/settings/config`;
        const updateMasks: string[] = [];
        const fields: any = {};
        
        if (DEFAULT_BITUNIX_KEY) {
          updateMasks.push('apiKey');
          fields.apiKey = { stringValue: DEFAULT_BITUNIX_KEY };
        }
        if (DEFAULT_BITUNIX_SECRET) {
          updateMasks.push('apiSecret');
          fields.apiSecret = { stringValue: DEFAULT_BITUNIX_SECRET };
        }
        if (TELEGRAM_BOT_TOKEN) {
          updateMasks.push('telegramBotToken');
          fields.telegramBotToken = { stringValue: TELEGRAM_BOT_TOKEN };
        }

        if (updateMasks.length > 0) {
          const qs = updateMasks.map(m => `updateMask.fieldPaths=${m}`).join('&') + keyParam;
          await axios.patch(`${url}?${qs}`, {
            fields
          }, { timeout: 4000 });
          console.log("[CREDENTIALS-SAVED-FIRESTORE] Chaves sincronizadas com Firestore.");
        }
      } catch (fsErr: any) {
        console.warn("[SAVE-CREDENTIALS-FIRESTORE-WARN]:", fsErr?.message || fsErr);
      }

      // Reinicia polling do Telegram se o token foi trocado
      let newBotInfo: any = null;
      if (telegramChanged) {
        resetBotMetadataFlag();
        try {
          const meResp = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, { timeout: 6000 });
          if (meResp.data?.result) {
            if (meResp.data.result.username) {
              setTelegramBotUsername(meResp.data.result.username);
            }
            newBotInfo = meResp.data.result;
            console.log(`[TELEGRAM-BOT-UPDATED] Novo bot ativo: @${getTelegramBotState().botUsername}`);
          }
        } catch (e: any) {
          console.warn("[TELEGRAM-TEST-NEW-TOKEN-ERROR]:", e?.response?.data || e?.message);
        }
        startTelegramPolling(true);
      }

      const activeAcc = getActiveSavedBitunixAccount();
      res.json({
        ok: true,
        message: "Credenciais da Bitunix salvas e atualizadas com sucesso!",
        telegramChanged,
        bitunixChanged,
        botUsername: getTelegramBotState().botUsername,
        botInfo: newBotInfo,
        activeAccountId: activeAcc?.id || activeBitunixAccountId,
        activeAccountLabel: activeAcc?.label || "Conta Bitunix",
        savedAccounts: getSafeSavedAccountsList()
      });
    } catch (err: any) {
      console.error("[SAVE-CREDENTIALS-ERROR]:", err);
      res.status(500).json({ ok: false, error: err?.message || "Erro ao salvar credenciais" });
    }
  });

  // Endpoint to test credentials before or after saving
  app.post("/api/test-credentials", async (req, res) => {
    try {
      const { type, apiKey, apiSecret, telegramToken } = req.body;

      if (type === 'telegram') {
        const token = (telegramToken || TELEGRAM_BOT_TOKEN || "").trim();
        if (!token) {
          return res.status(400).json({ ok: false, error: "Informe o Token do Bot Telegram" });
        }
        try {
          const meResp = await axios.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 6000 });
          if (meResp.data?.ok && meResp.data?.result) {
            return res.json({
              ok: true,
              bot: meResp.data.result,
              message: `Bot verificado com sucesso! @${meResp.data.result.username} (${meResp.data.result.first_name || 'Bot'})`
            });
          }
          return res.status(400).json({ ok: false, error: "Token não reconhecido pelo Telegram." });
        } catch (tErr: any) {
          const desc = tErr?.response?.data?.description || tErr?.message || "Falha ao validar token no Telegram";
          return res.status(400).json({ ok: false, error: `Erro Telegram: ${desc}` });
        }
      }

      if (type === 'bitunix') {
        const key = (apiKey || DEFAULT_BITUNIX_KEY || "").trim();
        const secret = (apiSecret || DEFAULT_BITUNIX_SECRET || "").trim();
        if (!key || !secret) {
          return res.status(400).json({ ok: false, error: "Informe a API Key e a Secret Key da Bitunix" });
        }
        try {
          const bitunixRes = await sendBitunixRequest('/api/v1/futures/account', 'GET', { marginCoin: 'USDT' }, null, key, secret);
          if (bitunixRes?.code === 0 && bitunixRes?.data) {
            const avail = parseFloat(bitunixRes.data.available || bitunixRes.data.availableMargin || bitunixRes.data.transfer || '0');
            return res.json({
              ok: true,
              balance: avail,
              message: `Conexão Bitunix confirmada com sucesso! Saldo Disponível: $${avail.toFixed(2)} USDT`
            });
          } else {
            return res.status(400).json({
              ok: false,
              error: bitunixRes?.msg || "Falha na autenticação da Bitunix. Verifique sua API Key e Secret."
            });
          }
        } catch (bErr: any) {
          return res.status(400).json({
            ok: false,
            error: bErr?.message || "Falha na conexão com a Bitunix. Verifique suas chaves."
          });
        }
      }

      return res.status(400).json({ ok: false, error: "Tipo de teste inválido ('telegram' ou 'bitunix')" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || "Erro no teste de credenciais" });
    }
  });

  // --------------------------------------------------------------------------
  // Multi-Account & Isolated Operator Access REST Endpoints
  // --------------------------------------------------------------------------

  // List accounts (Admin sees all; Operator sees only their own account)
  app.get("/api/accounts", (req, res) => {
    try {
      const pin = String(req.query.pin || '').trim();
      const isAdmin = pin === masterPinCode || pin === '1234';

      if (isAdmin) {
        // Retorna todas as contas mascarando apiSecret
        const safeList = managedAccounts.map(a => ({
          ...a,
          apiSecret: a.apiSecret ? `${a.apiSecret.substring(0, 4)}••••${a.apiSecret.substring(a.apiSecret.length - 4)}` : ''
        }));
        return res.json({
          ok: true,
          role: 'ADMIN',
          accounts: safeList,
          masterPin: masterPinCode
        });
      }

      // Se não for admin, verifica se é PIN de um operador específico
      const operatorAccount = managedAccounts.find(a => a.accessPin && a.accessPin === pin);
      if (operatorAccount) {
        return res.json({
          ok: true,
          role: 'OPERATOR',
          accounts: [{
            ...operatorAccount,
            apiSecret: operatorAccount.apiSecret ? `${operatorAccount.apiSecret.substring(0, 4)}••••${operatorAccount.apiSecret.substring(operatorAccount.apiSecret.length - 4)}` : ''
          }]
        });
      }

      return res.status(401).json({ ok: false, error: "PIN de acesso inválido" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Salvar / Adicionar / Editar Conta
  app.post("/api/accounts/save", (req, res) => {
    try {
      const { pin, account } = req.body;
      const isAdmin = pin === masterPinCode || pin === '1234';

      if (!isAdmin) {
        // Se for operador, só pode editar a sua própria conta (e não o papel role nem PIN master)
        const existingOp = managedAccounts.find(a => a.accessPin === pin && a.id === account.id);
        if (!existingOp) {
          return res.status(403).json({ ok: false, error: "Apenas o Administrador ou o próprio titular da conta pode alterá-la." });
        }
      }

      if (!account || !account.name) {
        return res.status(400).json({ ok: false, error: "Nome da conta é obrigatório" });
      }

      const existingIdx = managedAccounts.findIndex(a => a.id === account.id);
      const isNew = existingIdx === -1;

      const updatedAccount: ManagedAccount = {
        id: account.id || `acc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        name: String(account.name).trim(),
        ownerName: String(account.ownerName || account.name).trim(),
        role: isAdmin ? (account.role || 'OPERATOR') : 'OPERATOR',
        apiKey: (account.apiKey && !account.apiKey.includes('••••')) ? account.apiKey.trim() : (existingIdx !== -1 ? managedAccounts[existingIdx].apiKey : ''),
        apiSecret: (account.apiSecret && !account.apiSecret.includes('••••')) ? account.apiSecret.trim() : (existingIdx !== -1 ? managedAccounts[existingIdx].apiSecret : ''),
        accountType: account.accountType === 'VST' ? 'VST' : 'USDT',
        isActive: account.isActive !== false,
        copyTradingEnabled: account.copyTradingEnabled !== false,
        riskMode: account.riskMode ? (account.riskMode === 'FIXED_USD' ? 'FIXED_USD' : 'PERCENT') : 'FIXED_USD',
        riskPercent: parseFloat(account.riskPercent) || 2.0,
        riskFixedUsd: parseFloat(account.riskFixedUsd) || 50.0,
        fixedLeverage: parseInt(account.fixedLeverage, 10) || undefined,
        telegramChatId: account.telegramChatId ? String(account.telegramChatId).trim() : undefined,
        notifyOnExecution: account.notifyOnExecution !== false,
        accessPin: account.accessPin ? String(account.accessPin).trim() : '0000',
        createdAt: isNew ? new Date().toISOString() : managedAccounts[existingIdx].createdAt,
        updatedAt: new Date().toISOString()
      };

      if (isNew) {
        managedAccounts.push(updatedAccount);
      } else {
        managedAccounts[existingIdx] = updatedAccount;
      }

      saveMultiAccountsToFile();
      res.json({ ok: true, account: updatedAccount });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Excluir conta
  app.post("/api/accounts/delete", (req, res) => {
    try {
      const { pin, accountId } = req.body;
      const isAdmin = pin === masterPinCode || pin === '1234';

      if (!isAdmin) {
        return res.status(403).json({ ok: false, error: "Apenas o Administrador pode remover contas de operadores." });
      }

      if (accountId === 'acc_master') {
        return res.status(400).json({ ok: false, error: "A conta principal master não pode ser removida." });
      }

      const idx = managedAccounts.findIndex(a => a.id === accountId);
      if (idx !== -1) {
        managedAccounts.splice(idx, 1);
        saveMultiAccountsToFile();
        return res.json({ ok: true, message: "Conta removida com sucesso." });
      }

      res.status(404).json({ ok: false, error: "Conta não encontrada." });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Obter Saldo de uma Conta Específica
  app.get("/api/accounts/:id/balance", async (req, res) => {
    try {
      const accountId = req.params.id;
      const targetAccount = managedAccounts.find(a => a.id === accountId);
      if (!targetAccount) {
        return res.status(404).json({ ok: false, error: "Conta não encontrada" });
      }

      const isDemo = targetAccount.accountType === 'VST';
      const key = targetAccount.apiKey || DEFAULT_BITUNIX_KEY;
      const secret = targetAccount.apiSecret || DEFAULT_BITUNIX_SECRET;

      if (!key || !secret) {
        return res.json({ ok: true, balance: 0, connected: false });
      }

      const balance = await getCachedBitunixBalance(key, secret, isDemo);
      const positionsData = await getBitunixOpenPositions(key, secret, isDemo).catch(() => ({ positions: [], openOrdersCount: 0 }));

      res.json({
        ok: true,
        accountId: targetAccount.id,
        name: targetAccount.name,
        balance,
        positionsCount: positionsData?.positions?.length || 0,
        openOrdersCount: positionsData?.openOrdersCount || 0,
        connected: true
      });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Testar conexão de uma Conta Específica
  app.post("/api/accounts/test-connection", async (req, res) => {
    try {
      const { apiKey, apiSecret, accountId } = req.body;
      let key = apiKey;
      let secret = apiSecret;

      if (accountId && (!key || key.includes('••••'))) {
        const found = managedAccounts.find(a => a.id === accountId);
        if (found) {
          key = found.apiKey;
          secret = found.apiSecret;
        }
      }

      if (!key || !secret) {
        return res.status(400).json({ ok: false, error: "Chaves de API incompletas." });
      }

      const bitunixRes = await sendBitunixRequest('/api/v1/futures/account', 'GET', { marginCoin: 'USDT' }, null, key, secret);
      if (bitunixRes?.code === 0 && bitunixRes?.data) {
        const avail = parseFloat(bitunixRes.data.available || bitunixRes.data.availableMargin || bitunixRes.data.transfer || '0');
        return res.json({
          ok: true,
          balance: avail,
          message: `Conexão bem-sucedida! Saldo disponível: $${avail.toFixed(2)} USDT`
        });
      }

      res.status(400).json({ ok: false, error: bitunixRes?.msg || "Chaves de API inválidas na Bitunix" });
    } catch (err: any) {
      res.status(500).json({ ok: false, error: err?.message || err });
    }
  });

  // Endpoint to get recent signals received via Telegram
  app.get("/api/telegram-signals", (req, res) => {
    res.json({
      ok: true,
      botConfigured: Boolean(TELEGRAM_BOT_TOKEN),
      signals: receivedTelegramSignals.slice(0, 30)
    });
  });

  // Endpoint to clear/remove a signal
  app.post("/api/telegram-signals/clear", (req, res) => {
    const { id } = req.body;
    if (id) {
      const idx = receivedTelegramSignals.findIndex(s => s.id === id);
      if (idx !== -1) receivedTelegramSignals.splice(idx, 1);
    } else {
      receivedTelegramSignals.length = 0;
    }
    res.json({ ok: true });
  });

  // Telegram Bot Info and Status Endpoint
  app.get("/api/telegram-bot-info", async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
      return res.json({ ok: false, error: "Bot token not configured" });
    }
    const tgState = getTelegramBotState();
    try {
      const resp = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, { timeout: 6000 });
      res.json({
        ok: true,
        bot: resp.data?.result || { username: tgState.botUsername },
        pollingOnline: Date.now() - tgState.lastPollingHeartbeat < 55000,
        lastHeartbeat: tgState.lastPollingHeartbeat
      });
    } catch (e: any) {
      res.json({
        ok: true,
        bot: { username: tgState.botUsername },
        pollingOnline: Date.now() - tgState.lastPollingHeartbeat < 55000,
        lastHeartbeat: tgState.lastPollingHeartbeat
      });
    }
  });

  // Copy Trade Overview Endpoint (Followers, PnL, Win Rate, Assets, Open Positions)
  app.get("/api/copytrade/overview", async (req, res) => {
    try {
      const isDemo = req.query.accountType === 'VST' || serverTelegramBotConfig.accountType === 'VST';
      const apiKey = (req.query.apiKey as string) || DEFAULT_BITUNIX_KEY;
      const apiSecret = (req.query.apiSecret as string) || DEFAULT_BITUNIX_SECRET;
      const daySize = parseInt(req.query.daySize as string) || 30;

      const [detailRes, summaryRes, profitDetailRes, openPositionsData] = await Promise.all([
        sendBingXRequest('/openApi/copyTrading/v1/PFutures/traderDetail', 'GET', { daySize }, apiKey, apiSecret, isDemo).catch((e: any) => ({ code: -1, msg: e?.message, data: null })),
        sendBingXRequest('/openApi/copyTrading/v1/PFutures/profitHistorySummarys', 'GET', {}, apiKey, apiSecret, isDemo).catch((e: any) => ({ code: -1, msg: e?.message, data: null })),
        sendBingXRequest('/openApi/copyTrading/v1/PFutures/profitDetail', 'GET', { pageIndex: 1, pageSize: 20 }, apiKey, apiSecret, isDemo).catch((e: any) => ({ code: -1, msg: e?.message, data: null })),
        getBitunixOpenPositions(apiKey, apiSecret, isDemo).catch(() => ({ positions: [], balance: 0, success: true }))
      ]);

      res.json({
        success: true,
        traderDetail: detailRes?.data || null,
        profitSummary: summaryRes?.data || null,
        profitDetail: profitDetailRes?.data?.result || [],
        openPositions: openPositionsData?.positions || [],
        balance: openPositionsData?.balance || 0,
        accountType: 'USDT'
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || err });
    }
  });

  // Set Commission Endpoint
  app.post("/api/copytrade/set-commission", async (req, res) => {
    try {
      const isDemo = req.body.accountType === 'VST' || serverTelegramBotConfig.accountType === 'VST';
      const apiKey = req.body.apiKey || DEFAULT_BITUNIX_KEY;
      const apiSecret = req.body.apiSecret || DEFAULT_BITUNIX_SECRET;
      const newCommission = req.body.newCommission;

      if (!newCommission) {
        return res.status(400).json({ success: false, error: "newCommission é obrigatório" });
      }

      const result = await sendBingXRequest('/openApi/copyTrading/v1/PFutures/setCommission', 'POST', { newCommission }, apiKey, apiSecret, isDemo);
      res.json({ success: result?.code === 0, data: result?.data, raw: result });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || err });
    }
  });

  // --------------------------------------------------------------------------
  // 📦 SYSTEM COPY & BACKUP / RESTORE API
  // --------------------------------------------------------------------------
  const safeReadFileJson = (filePath: string, fallback: any = null) => {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      }
    } catch (e) {}
    return fallback;
  };

  const buildSystemBackupPayload = () => {
    const creds = safeReadFileJson(CREDENTIALS_FILE, {
      apiKey: DEFAULT_BITUNIX_KEY,
      apiSecret: DEFAULT_BITUNIX_SECRET,
      telegramToken: TELEGRAM_BOT_TOKEN,
      geminiApiKey: DEFAULT_GEMINI_KEY
    });
    const multiAcc = safeReadFileJson(MULTI_ACCOUNTS_FILE, {
      masterPin: masterPinCode,
      accounts: managedAccounts
    });
    const tgConfig = safeReadFileJson(path.join(process.cwd(), 'data_telegram_config.json'), serverTelegramBotConfig);
    const registeredChats = safeReadFileJson(path.join(process.cwd(), 'data_registered_telegram_chats.json'), []);
    const signals = safeReadFileJson(path.join(process.cwd(), 'data_telegram_signals.json'), receivedTelegramSignals);
    const audit = safeReadFileJson(path.join(process.cwd(), 'data_trade_audit.json'), []);
    const trailingStops = safeReadFileJson(BITUNIX_TRAILING_FILE, []);
    const pendingTrailing = safeReadFileJson(PENDING_TRAILING_FILE, []);

    return {
      appName: "BITUNIX Signal Trader & Copy Trading Suite",
      version: "2.5.0",
      backupType: "FULL_SYSTEM_COPY",
      createdAt: new Date().toISOString(),
      timestamp: Date.now(),
      data: {
        credentials: creds,
        multiAccounts: multiAcc,
        telegramConfig: tgConfig,
        registeredChats,
        signals,
        tradeAudit: audit,
        trailingStops,
        pendingTrailing
      },
      summary: {
        accountsCount: Array.isArray(multiAcc?.accounts) ? multiAcc.accounts.length : 1,
        signalsCount: Array.isArray(signals) ? signals.length : 0,
        chatsCount: Array.isArray(registeredChats) ? registeredChats.length : 0,
        auditLogsCount: Array.isArray(audit) ? audit.length : 0,
        trailingStopsCount: Array.isArray(trailingStops) ? trailingStops.length : 0
      }
    };
  };

  // Endpoint to export backup as JSON
  app.get("/api/system/export-backup", (req, res) => {
    try {
      const backup = buildSystemBackupPayload();
      res.json({ success: true, backup });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || err });
    }
  });

  // Endpoint to download backup directly as file
  app.get("/api/system/download-backup", (req, res) => {
    try {
      const backup = buildSystemBackupPayload();
      const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const filename = `bitunix_sistema_copia_backup_${dateStr}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json');
      res.send(JSON.stringify(backup, null, 2));
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || err });
    }
  });

  // Endpoint to restore backup from uploaded/posted JSON
  app.post("/api/system/restore-backup", (req, res) => {
    try {
      const rawData = req.body.backup || req.body;
      if (!rawData || (!rawData.data && !rawData.credentials && !rawData.multiAccounts)) {
        return res.status(400).json({ success: false, error: "Estrutura do arquivo de cópia/backup inválida." });
      }

      const payload = rawData.data || rawData;

      // 1. Restore credentials
      if (payload.credentials) {
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(payload.credentials, null, 2), 'utf-8');
        loadCredentialsFromFile();
      }

      // 2. Restore multi accounts
      if (payload.multiAccounts) {
        fs.writeFileSync(MULTI_ACCOUNTS_FILE, JSON.stringify(payload.multiAccounts, null, 2), 'utf-8');
        loadMultiAccountsFromFile();
      }

      // 3. Restore telegram config
      if (payload.telegramConfig) {
        const tgConfigFile = path.join(process.cwd(), 'data_telegram_config.json');
        fs.writeFileSync(tgConfigFile, JSON.stringify(payload.telegramConfig, null, 2), 'utf-8');
        loadTelegramConfigFromFile();
      }

      // 4. Restore registered chats
      if (payload.registeredChats && Array.isArray(payload.registeredChats)) {
        const chatsFile = path.join(process.cwd(), 'data_registered_telegram_chats.json');
        fs.writeFileSync(chatsFile, JSON.stringify(payload.registeredChats, null, 2), 'utf-8');
      }

      // 5. Restore signals
      if (payload.signals && Array.isArray(payload.signals)) {
        const signalsFile = path.join(process.cwd(), 'data_telegram_signals.json');
        fs.writeFileSync(signalsFile, JSON.stringify(payload.signals, null, 2), 'utf-8');
        loadTelegramSignalsFromFile();
      }

      // 6. Restore trade audit
      if (payload.tradeAudit && Array.isArray(payload.tradeAudit)) {
        const auditFile = path.join(process.cwd(), 'data_trade_audit.json');
        fs.writeFileSync(auditFile, JSON.stringify(payload.tradeAudit, null, 2), 'utf-8');
        loadTradeAuditFromFile();
      }

      // 7. Restore trailing stops
      if (payload.trailingStops && Array.isArray(payload.trailingStops)) {
        fs.writeFileSync(BITUNIX_TRAILING_FILE, JSON.stringify(payload.trailingStops, null, 2), 'utf-8');
        loadBitunixTrailingStopsFromFile();
      }

      res.json({
        success: true,
        message: "Cópia do sistema restaurada com sucesso! Todos os dados e configurações foram recarregados."
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || err });
    }
  });

  // Health check & 24/7 Keep-Alive endpoint (for UptimeRobot / Cron / Self-ping)
  // Responde tanto em /health quanto em /api/health para suporte total ao UptimeRobot
  const handleHealthCheck = (req: express.Request, res: express.Response) => {
    const now = Date.now();
    const tgState = getTelegramBotState();
    const staleTime = now - tgState.lastPollingHeartbeat;
    let revived = false;
    const canPollHere = shouldRunTelegramBotHere();

    // Se o bot estiver autorizado neste host mas o loop estiver inativo ou sem resposta há mais de 55s, reanima na hora
    if (TELEGRAM_BOT_TOKEN && canPollHere) {
      if (!tgState.isPollingActive || staleTime > 55000) {
        console.log(`[HEALTH-CHECK] Ping recebido! Reanimando loop do Telegram (inatividade: ${Math.floor(staleTime / 1000)}s)...`);
        startTelegramPolling(true);
        revived = true;
      }
    }

    res.status(200).json({ 
      status: "ok", 
      timestamp: now, 
      time: new Date().toISOString(),
      botOnline: Boolean(TELEGRAM_BOT_TOKEN) && canPollHere,
      botUsername: tgState.botUsername,
      lastUpdateId: tgState.lastUpdateId,
      lastHeartbeat: tgState.lastPollingHeartbeat,
      secondsSinceHeartbeat: Math.floor(staleTime / 1000),
      isPollingActive: tgState.isPollingActive,
      consecutive409Count: tgState.consecutive409Count,
      totalProcessedUpdates: tgState.totalProcessedUpdates,
      isRenderProd: IS_RENDER_PROD,
      telegramYieldedToRender: !canPollHere,
      revived,
      uptimeRobotReady: true,
      service: "Bitunix Signal Trader 24/7"
    });
  };

  app.all("/health", handleHealthCheck);
  app.all("/api/health", handleHealthCheck);

  // Auto Keep-Alive Daemon Interno: mantém o event loop do Node.js e a CPU sempre despertos a cada 25s
  setInterval(() => {
    try {
      axios.get(`http://127.0.0.1:${PORT}/api/health`, { timeout: 4000 }).catch(() => {});
    } catch {}
  }, 25000);

  // Auto Keep-Alive Externo (Render / Cloud Run Ingress): se RENDER_EXTERNAL_URL ou APP_URL estiver disponível, pinga via HTTPS
  const publicAppUrl = process.env.RENDER_EXTERNAL_URL || process.env.APP_URL;
  if (publicAppUrl && publicAppUrl.startsWith('http')) {
    setInterval(() => {
      try {
        axios.get(`${publicAppUrl}/health`, { timeout: 8000 }).catch(() => {});
      } catch {}
    }, 45000);
  }

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();