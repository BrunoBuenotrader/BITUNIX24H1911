export interface ParsedSignal {
  rawText: string;
  symbol: string;         // e.g. "BTCUSDT"
  formattedSymbol: string; // e.g. "BITUNIX:BTCUSDT"
  apiSymbol: string;      // e.g. "BTC-USDT"
  coinName: string;       // e.g. "BTC"
  direction: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  entryPrice: number | null; // null if MARKET (default or average)
  entryPriceText: string;
  entryPrices?: number[]; // Detected multiple entry prices (e.g. [605.60, 605.15])
  entryRange?: {
    first: number;
    second: number;
    average: number;
  } | null;
  leverage: number;
  takeProfits: number[];
  stopLoss: number | null;
  trailingMode?: 'TARGET_STEP' | 'MATCH_SL' | 'CUSTOM' | null;
  trailingTargetPreset?: 'TARGET_2_ENTRY_THEN_PREV' | 'TARGET_1_ENTRY_THEN_PREV' | 'STEP_BY_STEP' | 'CUSTOM';
  trailingBreakEvenTarget?: number;
  trailingStepDistance?: number;
  trailingStepFrequency?: number;
  trailingCallback?: number | null;
  trailingActivation?: number | null;
  isFastCompactSignal?: boolean;
  isValid: boolean;
  confidence: number;     // 0 - 100%
  parsedAt: string;
}

export function parseTradingSignal(text: string): ParsedSignal {
  const cleanText = text.toUpperCase().trim();

  // 1. Symbol Detection com suporte a Cripto, Ouro, Prata, Petróleo, Índices e Contratos Especiais
  let symbol = 'BTCUSDT';
  let coinName = 'BTC';
  let apiSymbol = 'BTC-USDT';

  // Mapa de aliases conhecidos
  const KNOWN_ALIASES: Record<string, { apiSymbol: string; symbol: string; coinName: string }> = {
    'GOLD': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'XAU': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'XAUUSD': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'XAUUSDT': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'GOLDUSD': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'GOLDUSDT': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'NCCOGOLD2USD': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'NCCOGOLD2USDUSDT': { apiSymbol: 'NCCOGOLD2USD-USDT', symbol: 'NCCOGOLD2USDUSDT', coinName: 'NCCOGOLD2USD' },
    'SILVER': { apiSymbol: 'NCCOXAG2USD-USDT', symbol: 'NCCOXAG2USDUSDT', coinName: 'NCCOXAG2USD' },
    'XAG': { apiSymbol: 'NCCOXAG2USD-USDT', symbol: 'NCCOXAG2USDUSDT', coinName: 'NCCOXAG2USD' },
    'XAGUSD': { apiSymbol: 'NCCOXAG2USD-USDT', symbol: 'NCCOXAG2USDUSDT', coinName: 'NCCOXAG2USD' },
    'XAGUSDT': { apiSymbol: 'NCCOXAG2USD-USDT', symbol: 'NCCOXAG2USDUSDT', coinName: 'NCCOXAG2USD' },
    'OIL': { apiSymbol: 'NCCO1OILWTI2USD-USDT', symbol: 'NCCO1OILWTI2USDUSDT', coinName: 'NCCO1OILWTI2USD' },
    'USOIL': { apiSymbol: 'NCCO1OILWTI2USD-USDT', symbol: 'NCCO1OILWTI2USDUSDT', coinName: 'NCCO1OILWTI2USD' },
    'WTI': { apiSymbol: 'NCCO1OILWTI2USD-USDT', symbol: 'NCCO1OILWTI2USDUSDT', coinName: 'NCCO1OILWTI2USD' },
    'BRENT': { apiSymbol: 'NCCO1OILBRENT2USD-USDT', symbol: 'NCCO1OILBRENT2USDUSDT', coinName: 'NCCO1OILBRENT2USD' },
    'SP500': { apiSymbol: 'NCSISP5002USD-USDT', symbol: 'NCSISP5002USDUSDT', coinName: 'NCSISP5002USD' },
    'US500': { apiSymbol: 'NCSISP5002USD-USDT', symbol: 'NCSISP5002USDUSDT', coinName: 'NCSISP5002USD' },
    'SPX': { apiSymbol: 'NCSISP5002USD-USDT', symbol: 'NCSISP5002USDUSDT', coinName: 'NCSISP5002USD' },
    'NAS100': { apiSymbol: 'NCSINASDAQ1002USD-USDT', symbol: 'NCSINASDAQ1002USDUSDT', coinName: 'NCSINASDAQ1002USD' },
    'NASDAQ': { apiSymbol: 'NCSINASDAQ1002USD-USDT', symbol: 'NCSINASDAQ1002USDUSDT', coinName: 'NCSINASDAQ1002USD' },
    'US100': { apiSymbol: 'NCSINASDAQ1002USD-USDT', symbol: 'NCSINASDAQ1002USDUSDT', coinName: 'NCSINASDAQ1002USD' },
    'US30': { apiSymbol: 'NCSIDOWJONES2USD-USDT', symbol: 'NCSIDOWJONES2USDUSDT', coinName: 'NCSIDOWJONES2USD' },
    'DOW': { apiSymbol: 'NCSIDOWJONES2USD-USDT', symbol: 'NCSIDOWJONES2USDUSDT', coinName: 'NCSIDOWJONES2USD' },
    'GER40': { apiSymbol: 'NCSIGER2USD-USDT', symbol: 'NCSIGER2USDUSDT', coinName: 'NCSIGER2USD' },
    'DAX': { apiSymbol: 'NCSIGER2USD-USDT', symbol: 'NCSIGER2USDUSDT', coinName: 'NCSIGER2USD' },
    'NEIRO': { apiSymbol: 'NEIROCTO-USDT', symbol: 'NEIROCTOUSDT', coinName: 'NEIROCTO' },
    'TRUMP': { apiSymbol: 'TRUMPSOL-USDT', symbol: 'TRUMPSOLUSDT', coinName: 'TRUMPSOL' },
    'PEPE': { apiSymbol: '1000PEPE-USDT', symbol: '1000PEPEUSDT', coinName: '1000PEPE' },
    'BONK': { apiSymbol: '1000BONK-USDT', symbol: '1000BONKUSDT', coinName: '1000BONK' },
    'FLOKI': { apiSymbol: '1000FLOKI-USDT', symbol: '1000FLOKIUSDT', coinName: '1000FLOKI' },
    'SHIB': { apiSymbol: '1000SHIB-USDT', symbol: '1000SHIBUSDT', coinName: '1000SHIB' },
    'LUNC': { apiSymbol: '1000LUNC-USDT', symbol: '1000LUNCUSDT', coinName: '1000LUNC' },
    'RATS': { apiSymbol: '1000RATS-USDT', symbol: '1000RATSUSDT', coinName: '1000RATS' },
    'SATS': { apiSymbol: '1000SATS-USDT', symbol: '1000SATSUSDT', coinName: '1000SATS' },
    // Forex (Moedas)
    'EURGBP': { apiSymbol: 'NCFXEUR2GBP-USDT', symbol: 'NCFXEUR2GBPUSDT', coinName: 'NCFXEUR2GBP' },
    'NCFXEUR2GBP': { apiSymbol: 'NCFXEUR2GBP-USDT', symbol: 'NCFXEUR2GBPUSDT', coinName: 'NCFXEUR2GBP' },
    'NCFXEUR2GBPUSDT': { apiSymbol: 'NCFXEUR2GBP-USDT', symbol: 'NCFXEUR2GBPUSDT', coinName: 'NCFXEUR2GBP' },
    'EURUSD': { apiSymbol: 'NCFXEUR2USD-USDT', symbol: 'NCFXEUR2USDUSDT', coinName: 'NCFXEUR2USD' },
    'GBPUSD': { apiSymbol: 'NCFXGBP2USD-USDT', symbol: 'NCFXGBP2USDUSDT', coinName: 'NCFXGBP2USD' },
    'USDJPY': { apiSymbol: 'NCFXUSD2JPY-USDT', symbol: 'NCFXUSD2JPYUSDT', coinName: 'NCFXUSD2JPY' },
    'AUDUSD': { apiSymbol: 'NCFXAUD2USD-USDT', symbol: 'NCFXAUD2USDUSDT', coinName: 'NCFXAUD2USD' },
    'USDCAD': { apiSymbol: 'NCFXUSD2CAD-USDT', symbol: 'NCFXUSD2CADUSDT', coinName: 'NCFXUSD2CAD' },
    'USDCHF': { apiSymbol: 'NCFXUSD2CHF-USDT', symbol: 'NCFXUSD2CHFUSDT', coinName: 'NCFXUSD2CHF' },
    'NZDUSD': { apiSymbol: 'NCFXNZD2USD-USDT', symbol: 'NCFXNZD2USDUSDT', coinName: 'NCFXNZD2USD' },
    'GBPJPY': { apiSymbol: 'NCFXGBP2JPY-USDT', symbol: 'NCFXGBP2JPYUSDT', coinName: 'NCFXGBP2JPY' },
    'EURJPY': { apiSymbol: 'NCFXEUR2JPY-USDT', symbol: 'NCFXEUR2JPYUSDT', coinName: 'NCFXEUR2JPY' }
  };

  // 1.1 Match direto por palavras-chave ou pares explícitos
  let matchedKey = '';
  // Ex: NCCOGOLD2USD-USDT, BTC-USDT, #BTC/USDT, ETH_USDT, GOLD, XAU/USD, EURGBP, etc.
  const symbolRegex = /(?:SINAL(?:\s*DETECTADO)?\s*:?\s*)?#?([A-Z0-9]{2,25})[\/_\-]?USDT|#?USDT[\/_\-]?([A-Z0-9]{2,25})|#([A-Z0-9]{2,25})|\b(NCCO[A-Z0-9]+|NCSI[A-Z0-9]+|NCFX[A-Z0-9]+|EURGBP|EURUSD|GBPUSD|USDJPY|AUDUSD|USDCAD|USDCHF|NZDUSD|GBPJPY|EURJPY|XAUUSD|XAGUSD|US500|SP500|NAS100|US30|GER40|GOLD|SILVER|USOIL|WTI|BRENT)\b/i;
  const symbolMatch = cleanText.match(symbolRegex);

  if (symbolMatch) {
    matchedKey = (symbolMatch[1] || symbolMatch[2] || symbolMatch[3] || symbolMatch[4] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  // Checagem em aliases
  if (matchedKey && KNOWN_ALIASES[matchedKey]) {
    const ali = KNOWN_ALIASES[matchedKey];
    apiSymbol = ali.apiSymbol;
    symbol = ali.symbol;
    coinName = ali.coinName;
  } else if (matchedKey && matchedKey !== 'USDT') {
    coinName = matchedKey;
    symbol = `${matchedKey}USDT`;
    apiSymbol = `${matchedKey}-USDT`;
  }

  const formattedSymbol = `BITUNIX:${symbol}`;

  // 2. Direction Detection
  let direction: 'LONG' | 'SHORT' = 'LONG';
  const isShort = /SHORT|VENDA|SELL|🔴|BAIXA|BEARISH|PUT/i.test(text);
  const isLong = /LONG|COMPRA|BUY|🟢|ALTA|BULLISH|CALL/i.test(text);

  if (isShort && !isLong) {
    direction = 'SHORT';
  } else if (isLong && !isShort) {
    direction = 'LONG';
  } else if (isShort) {
    direction = 'SHORT';
  }

  // 3. Leverage Detection
  let leverage = 10;
  let hasLeverageMatch = false;
  const leverageRegex = /(?:ALAVANCAGEM|LEVERAGE|ALAV|LEV|CROSS|ISOLATED|ISOLADA)?\s*:?\s*(\d{1,4})\s*X/i;
  const leverageMatch = cleanText.match(leverageRegex);
  if (leverageMatch && leverageMatch[1]) {
    const levVal = parseInt(leverageMatch[1], 10);
    if (levVal >= 1 && levVal <= 1000) {
      leverage = levVal;
      hasLeverageMatch = true;
    }
  }

  // Direction + leverage pattern (e.g. LONG - 350x, 🟢 LONG - 350x, SHORT 200X)
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
    // Secondary check for simple "350X", "350x" or "X350"
    const simpleXMatch = cleanText.match(/(?:^|[\s\(\[\{,\/\-_])(?:X\s*(\d{1,4})|(\d{1,4})\s*X)(?:$|[\s\)\]\},!\.\?\-_])/i);
    if (simpleXMatch && (simpleXMatch[1] || simpleXMatch[2])) {
      const levVal = parseInt(simpleXMatch[1] || simpleXMatch[2], 10);
      if (levVal >= 1 && levVal <= 1000) {
        leverage = levVal;
        hasLeverageMatch = true;
      }
    }
  }

  // 4. Order Type & Entry Price
  let orderType: 'MARKET' | 'LIMIT' = 'MARKET';
  let entryPrice: number | null = null;
  let entryPriceText = 'A MERCADO';
  let entryPrices: number[] = [];
  let entryRange: { first: number; second: number; average: number } | null = null;

  const isMarketExplicit = /A\s*MERCADO|MERCADO|CMP|CURRENT\s*PRICE|MARKET/i.test(cleanText);

  // Search for Entry Price numerical value (including ranges with -, /, ~, a, to)
  const entryRegex = /(?:ENTRADA|ENTRY|ENTRADAS|PREÇO|PRICE|GATILHO|ZONA|ZONA\s*DE\s*ENTRADA)\s*:?\s*([0-9.,\s\-\/–—~a]+)/i;
  const entryMatch = cleanText.match(entryRegex);

  if (!isMarketExplicit && entryMatch && entryMatch[1]) {
    const numbers = entryMatch[1].replace(/,/g, '.').match(/\d+\.?\d*/g);
    if (numbers && numbers.length > 0) {
      const validNums = numbers.map(n => parseFloat(n)).filter(n => !isNaN(n) && n > 0 && n !== leverage);
      if (validNums.length === 1) {
        entryPrice = validNums[0];
        entryPriceText = entryPrice.toString();
        entryPrices = [validNums[0]];
        orderType = 'LIMIT';
      } else if (validNums.length >= 2) {
        // Range e.g. 605.60 - 605.15 -> Average
        const first = validNums[0];
        const second = validNums[1];
        const avg = (first + second) / 2;
        const decimals = avg < 1 ? 6 : avg < 100 ? 4 : 2;
        const roundedAvg = parseFloat(avg.toFixed(decimals));

        entryPrices = [first, second];
        entryRange = {
          first,
          second,
          average: roundedAvg
        };
        entryPrice = roundedAvg;
        entryPriceText = `${first} - ${second}`;
        orderType = 'LIMIT';
      }
    }
  }

  // Check for multiple entry lines (e.g. Entrada 1: 605.60 / Entrada 2: 605.15) if no range found yet
  if (entryPrices.length === 0 && !isMarketExplicit) {
    const multiEntryRegex = /(?:ENTRADA|ENTRY|GATILHO)\s*\d*[\:\-]?\s*\$?\s*([0-9.,]+)/gi;
    let mMatch;
    const foundEntries: number[] = [];
    while ((mMatch = multiEntryRegex.exec(cleanText)) !== null) {
      if (mMatch[1]) {
        const val = parseFloat(mMatch[1].replace(',', '.'));
        if (!isNaN(val) && val > 0 && val !== leverage && !foundEntries.includes(val)) {
          foundEntries.push(val);
        }
      }
    }
    if (foundEntries.length === 1) {
      entryPrice = foundEntries[0];
      entryPriceText = entryPrice.toString();
      entryPrices = [foundEntries[0]];
      orderType = 'LIMIT';
    } else if (foundEntries.length >= 2) {
      const first = foundEntries[0];
      const second = foundEntries[1];
      const avg = (first + second) / 2;
      const decimals = avg < 1 ? 6 : avg < 100 ? 4 : 2;
      const roundedAvg = parseFloat(avg.toFixed(decimals));

      entryPrices = [first, second];
      entryRange = {
        first,
        second,
        average: roundedAvg
      };
      entryPrice = roundedAvg;
      entryPriceText = `${first} - ${second}`;
      orderType = 'LIMIT';
    }
  }

  // If no entry found via regex keyword, try to find floating number after symbol
  if (!entryPrice && !isMarketExplicit) {
    const genericNumbers = cleanText.match(/\b\d{1,6}(?:\.\d{1,8})?\b/g);
    if (genericNumbers) {
      const filtered = genericNumbers.map(n => parseFloat(n)).filter(n => n !== leverage && n > 0.000001);
      if (filtered.length > 0) {
        // keep as market if not explicit limit
      }
    }
  }

  // 5. Take Profit Targets (TPs)
  const takeProfits: number[] = [];
  
  // Look for TP lines
  const tpRegex = /(?:ALVO|TP|TARGET|TAKE\s*PROFIT|ALVOS)\s*\d*[\:\-]?\s*\$?\s*([0-9.,]+)/gi;
  let tpMatch;
  while ((tpMatch = tpRegex.exec(cleanText)) !== null) {
    if (tpMatch[1]) {
      const val = parseFloat(tpMatch[1].replace(',', '.'));
      if (!isNaN(val) && val > 0 && !takeProfits.includes(val)) {
        takeProfits.push(val);
      }
    }
  }

  // If list format e.g., "TPs: 66000, 67000, 68000"
  if (takeProfits.length === 0) {
    const tpListRegex = /(?:ALVOS|TPS|TARGETS)\s*:?\s*([0-9.,\s\)\(]+)/i;
    const tpListMatch = cleanText.match(tpListRegex);
    if (tpListMatch && tpListMatch[1]) {
      const nums = tpListMatch[1].replace(/,/g, '.').match(/\d+\.?\d*/g);
      if (nums) {
        nums.forEach(n => {
          const val = parseFloat(n);
          if (!isNaN(val) && val > 0 && !takeProfits.includes(val) && val !== leverage) {
            takeProfits.push(val);
          }
        });
      }
    }
  }

  // Sort TPs logically: ascending for LONG, descending for SHORT
  takeProfits.sort((a, b) => direction === 'LONG' ? a - b : b - a);

  // 6. Stop Loss (SL)
  let stopLoss: number | null = null;
  const slRegex = /(?:STOP|SL|STOP\s*LOSS|STOPLOSS)\s*:?\s*\$?\s*([0-9.,]+)/i;
  const slMatch = cleanText.match(slRegex);

  if (slMatch && slMatch[1]) {
    const val = parseFloat(slMatch[1].replace(',', '.'));
    if (!isNaN(val) && val > 0) {
      stopLoss = val;
    }
  }

  // 7. Trailing Stop (Stop Móvel) Detection
  let trailingMode: 'TARGET_STEP' | 'MATCH_SL' | 'CUSTOM' | null = null;
  let trailingTargetPreset: 'TARGET_2_ENTRY_THEN_PREV' | 'TARGET_1_ENTRY_THEN_PREV' | 'STEP_BY_STEP' | 'CUSTOM' = 'TARGET_2_ENTRY_THEN_PREV';
  let trailingBreakEvenTarget = 2; // Default: move to Entry on TP2
  let trailingStepDistance = 1;    // Default: 1 target behind (TP N-1)
  let trailingStepFrequency = 1;   // Default: every 1 target
  let trailingCallback: number | null = null;
  let trailingActivation: number | null = null;

  // Check for Target-based trailing in text
  const isTargetTrailing = /TRAILING.*(?:ALVO|TARGET|PASSO|DEGRAU)|BREAK\s*EVEN.*ALVO|STOP.*MOVEL.*ALVO|ALVO.*(?:ENTRADA|0X0|BREAK)/i.test(cleanText);
  if (isTargetTrailing) {
    trailingMode = 'TARGET_STEP';
    if (/ALVO\s*1.*(?:ENTRADA|0X0|BE)/i.test(cleanText)) {
      trailingTargetPreset = 'TARGET_1_ENTRY_THEN_PREV';
      trailingBreakEvenTarget = 1;
      trailingStepDistance = 1;
      trailingStepFrequency = 1;
    } else {
      trailingTargetPreset = 'TARGET_2_ENTRY_THEN_PREV';
      trailingBreakEvenTarget = 2;
      trailingStepDistance = 1;
      trailingStepFrequency = 1;
    }
  }

  const tsRegex = /(?:TRAILING|TRAILING\s*STOP|TS|STOP\s*M[ÓO]VEL)\s*:?\s*([0-9.,]+)\s*%/i;
  const tsMatch = cleanText.match(tsRegex);
  if (tsMatch && tsMatch[1]) {
    const val = parseFloat(tsMatch[1].replace(',', '.'));
    if (!isNaN(val) && val > 0 && val <= 50) {
      trailingCallback = val;
      if (!trailingMode) trailingMode = 'CUSTOM';
    }
  }

  const tsActRegex = /(?:ATIVA[ÇC][ÃA]O|ACTIVATION|ATIVAR\s*EM)\s*:?\s*\$?\s*([0-9.,]+)/i;
  const tsActMatch = cleanText.match(tsActRegex);
  if (tsActMatch && tsActMatch[1]) {
    const val = parseFloat(tsActMatch[1].replace(',', '.'));
    if (!isNaN(val) && val > 0) {
      trailingActivation = val;
    }
  }

  // Calculate confidence score
  let score = 0;
  if (symbolMatch) score += 30;
  if (isShort || isLong) score += 25;
  if (hasLeverageMatch) score += 15;
  if (takeProfits.length > 0) score += 15;
  if (stopLoss !== null) score += 15;
  if (trailingCallback !== null || trailingMode !== null) score += 10;

  const isValid = score >= 40;

  return {
    rawText: text,
    symbol,
    formattedSymbol,
    apiSymbol,
    coinName,
    direction,
    orderType,
    entryPrice,
    entryPriceText,
    entryPrices,
    entryRange,
    leverage,
    takeProfits,
    stopLoss,
    trailingMode,
    trailingTargetPreset,
    trailingBreakEvenTarget,
    trailingStepDistance,
    trailingStepFrequency,
    trailingCallback,
    trailingActivation,
    isValid,
    confidence: Math.min(100, score),
    parsedAt: new Date().toLocaleTimeString()
  };
}

export interface FeeViabilityTarget {
  targetIndex: number;
  price: number;
  rawPct: number;
  netPct: number;
  status: 'LOSS_AFTER_FEES' | 'BREAKEVEN' | 'PROFITABLE';
  statusLabel: string;
}

export interface FeeViabilityResult {
  isTrap: boolean;
  verdict: 'INVIÁVEL' | 'ATENÇÃO' | 'VIÁVEL';
  verdictLabel: string;
  roundTripFeePct: number; // e.g. 0.10%
  tp1RawPct: number;
  tp1NetGainPct: number;
  finalTpRawPct: number;
  finalTpNetGainPct: number;
  breakevenTpIndex: number; // 1-based, or -1 if none
  breakevenPrice: number | null;
  feeEatenPercent: number; // % do lucro do TP final devorado pela taxa
  explanation: string;
  targets: FeeViabilityTarget[];
}

export function calculateFeeViability(
  entryPrice: number,
  takeProfits: number[],
  direction: 'LONG' | 'SHORT' = 'LONG',
  roundTripFeePct: number = 0.10 // 0.05% entry + 0.05% exit Bitunix standard
): FeeViabilityResult | null {
  if (!entryPrice || entryPrice <= 0 || !takeProfits || takeProfits.length === 0) {
    return null;
  }

  const isLong = direction === 'LONG';
  let breakevenTpIndex = -1;
  let breakevenPrice: number | null = null;
  let tp1RawPct = 0;
  let tp1NetGainPct = 0;
  let finalTpRawPct = 0;
  let finalTpNetGainPct = 0;

  const targets: FeeViabilityTarget[] = takeProfits.map((tp, idx) => {
    const rawPct = isLong
      ? ((tp - entryPrice) / entryPrice) * 100
      : ((entryPrice - tp) / entryPrice) * 100;
    const netPct = rawPct - roundTripFeePct;

    if (idx === 0) {
      tp1RawPct = rawPct;
      tp1NetGainPct = netPct;
    }
    if (idx === takeProfits.length - 1) {
      finalTpRawPct = rawPct;
      finalTpNetGainPct = netPct;
    }

    let status: 'LOSS_AFTER_FEES' | 'BREAKEVEN' | 'PROFITABLE';
    let statusLabel: string;

    if (netPct < 0) {
      status = 'LOSS_AFTER_FEES';
      statusLabel = `❌ Prejuízo Líquido (${netPct.toFixed(3)}% após taxas)`;
    } else if (netPct <= roundTripFeePct * 0.3) {
      status = 'BREAKEVEN';
      statusLabel = `⚖️ Empate (Breakeven +${netPct.toFixed(3)}%)`;
      if (breakevenTpIndex === -1) {
        breakevenTpIndex = idx + 1;
        breakevenPrice = tp;
      }
    } else {
      status = 'PROFITABLE';
      statusLabel = `✅ Lucro Real (+${netPct.toFixed(3)}% líq.)`;
      if (breakevenTpIndex === -1) {
        breakevenTpIndex = idx + 1;
        breakevenPrice = tp;
      }
    }

    return {
      targetIndex: idx + 1,
      price: tp,
      rawPct,
      netPct,
      status,
      statusLabel
    };
  });

  const feeEatenPercent = finalTpRawPct > 0
    ? Math.min(100, Math.max(0, (roundTripFeePct / finalTpRawPct) * 100))
    : 100;

  // Inviável se TP1 dá prejuízo pós-taxas OU se o TP final tem mais de 60% comido por taxas OU variação total < 0.15%
  const isTrap = tp1NetGainPct <= 0 || feeEatenPercent > 60 || finalTpRawPct < 0.15;

  let verdict: 'INVIÁVEL' | 'ATENÇÃO' | 'VIÁVEL';
  let verdictLabel: string;
  let explanation: string;

  if (isTrap) {
    verdict = 'INVIÁVEL';
    verdictLabel = '❌ NÃO RECOMENDADO (Inviável)';
    explanation = 'A variação do gráfico neste sinal é minúscula. As taxas da corretora devoram os lucros.';
  } else if (feeEatenPercent > 35) {
    verdict = 'ATENÇÃO';
    verdictLabel = '⚠️ ALERTA DE TAXAS ELEVADAS';
    explanation = 'As taxas da corretora consomem parte significativa dos ganhos dos primeiros alvos.';
  } else {
    verdict = 'VIÁVEL';
    verdictLabel = '✅ SINAL COM BOA MARGEM DE LUCRO';
    explanation = 'A variação entre entrada e alvos cobre com folga as taxas da corretora.';
  }

  return {
    isTrap,
    verdict,
    verdictLabel,
    roundTripFeePct,
    tp1RawPct,
    tp1NetGainPct,
    finalTpRawPct,
    finalTpNetGainPct,
    breakevenTpIndex,
    breakevenPrice,
    feeEatenPercent,
    explanation,
    targets
  };
}

export const SAMPLE_SIGNALS = [
  {
    title: "⚠️ Armadilha de Taxas (EURGBP)",
    category: "Alerta de Viabilidade 🚨",
    text: `💎 ORDEM LIMITE 💎
🔼 EURGBP/USDT 🔼
🟢LONG - 200x (ISOLADA)
⚡Entrada: 0,85913 / 0.85918
🚀TP 1: 0,85935
🚀TP 2: 0,85945
🚀TP 3: 0,85955
🚀TP 4: 0,85966
🚀TP 5: 0,85976
🚀TP 6: 0,85986
🚀TP 7: 0,85997
🚀TP 8: 0,86010
❌ StopLoss: 0,85895`
  },
  {
    title: "Sinal com Zona de Entrada (BNB)",
    category: "Zona / Preço Médio 🎯",
    text: `▲BNB/USDT▲
🟢LONG - 75x
➡️Entrada: 605.60 - 605.15
🎯 TP 1: 606.67
🎯 TP 2: 607.30
🎯 TP 3: 607.93
🛑 SL: 601.20`
  },
  {
    title: "Sinal com Trailing Stop (SOL)",
    category: "Trailing Stop ⚡",
    text: `🟢 COMPRA / LONG
MOEDA: SOL/USDT
ALAVANCAGEM: 20X
ENTRADA: 195.50
ALVO 1: 198.50
ALVO 2: 204.00
STOP LOSS: 190.00
TRAILING STOP: 1.5%`
  },
  {
    title: "Telegram VIP (LONG BTC)",
    category: "Crypto Signals VIP",
    text: `🟢 COMPRA / LONG
MOEDA: BTC/USDT
ALAVANCAGEM: 20X
ENTRADA: A MERCADO
ALVO 1: 96500
ALVO 2: 97800
ALVO 3: 99200
STOP LOSS: 94100`
  },
  {
    title: "Sinal Trailing Stop (LONG SOL)",
    category: "Trailing Stop Pro",
    text: `🟢 COMPRA / LONG #SOL/USDT
Alavancagem: 15x
Entrada: A Mercado
TP1: 195.00
TP2: 205.00
SL: 178.00
TRAILING STOP: 1.5%
ATIVAÇÃO: 195.00`
  },
  {
    title: "Sinal Rápido (SHORT ETH)",
    category: "Scalp Traders",
    text: `🔴 VENDA / SHORT #ETH/USDT
Alavancagem: Cross 15x
Entrada: A Mercado
TP1: 2650.00
TP2: 2580.00
SL: 2780.00`
  },
  {
    title: "Sinal Com Limite (SOL)",
    category: "Futures Pro",
    text: `SOLUSDT LONG
Entrada: 185.50
Leverage: 10x
Take Profit 1: 192.00
Take Profit 2: 198.50
Stop Loss: 178.00`
  },
  {
    title: "Sinal WhatsApp Grupo VIP (SUI)",
    category: "Sinais WhatsApp",
    text: `🚀 SINAL DE COMPRA
#SUI/USDT - LONG
Alavancagem: 25x
Entrada: Mercado
Alvo 1: 3.45
Alvo 2: 3.68
Alvo 3: 3.90
Stop: 3.10`
  }
];

export function formatPriceVip(val: number | string | undefined | null): string {
  if (val === undefined || val === null || val === '') return '0';
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(',', '.'));
  if (isNaN(num)) return String(val);
  let str = num.toString();
  if (str.includes('e-')) {
    str = num.toFixed(8).replace(/\.?0+$/, '');
  }
  return str.replace('.', ',');
}

export function formatVipSignalMessage(parsed: {
  coinName?: string;
  symbol?: string;
  apiSymbol?: string;
  direction?: string;
  leverage?: number;
  targetLeverage?: number;
  orderType?: string;
  entryPrice?: number | string | null;
  entryPrice2?: number | string | null;
  entryPrices?: number[];
  takeProfits?: (number | string)[];
  stopLoss?: number | string | null;
}, useHtml: boolean = false): string {
  const rawCoin = parsed.coinName || parsed.symbol || parsed.apiSymbol || 'CRYPTO';
  const coin = rawCoin
    .replace(/^BITUNIX:/i, '')
    .replace('-USDT', '')
    .replace('/USDT', '')
    .replace('USDT', '')
    .toUpperCase();

  const leverage = parsed.leverage || parsed.targetLeverage || 20;
  const isShort = String(parsed.direction || '').toUpperCase().includes('SHORT');
  const dirEmoji = isShort ? '🔴' : '🟢';
  const dirText = isShort ? 'SHORT' : 'LONG';

  // Format Entry
  let entryFormatted = '';
  const e1 = parsed.entryPrice;
  const e2 = parsed.entryPrice2 || (parsed.entryPrices && parsed.entryPrices.length > 1 ? parsed.entryPrices[1] : null);

  if (e1 && e2 && Number(e1) !== Number(e2) && !isNaN(Number(e2))) {
    entryFormatted = `${formatPriceVip(e1)} - ${formatPriceVip(e2)}`;
  } else if (e1) {
    entryFormatted = `${formatPriceVip(e1)}`;
  } else {
    entryFormatted = 'Mercado';
  }

  // Format Take Profits
  const tps = Array.isArray(parsed.takeProfits) && parsed.takeProfits.length > 0
    ? parsed.takeProfits
    : [e1 || 0];

  const tpLines = tps.map((tp, idx) => {
    return `🚀 TP ${idx + 1}: ${formatPriceVip(tp)}`;
  }).join('\n');

  const stopFormatted = formatPriceVip(parsed.stopLoss);

  // Cálculo exato do Risco da Operação (% stop × alavancagem) e definição de CRUZADA vs ISOLADA
  const entryNum = e1 ? parseFloat(String(e1).replace(',', '.')) : 0;
  const slNum = parsed.stopLoss ? parseFloat(String(parsed.stopLoss).replace(',', '.')) : 0;
  let riskFormatted = '';
  let isCross = false;
  const threshold = 65; // Limiar inteligente: se perda alavancada >= 65%, recomenda CRUZADA anti-liquidação

  if (entryNum > 0 && slNum > 0) {
    const slDist = Math.abs(entryNum - slNum);
    const slDistPct = (slDist / entryNum) * 100;
    const riskVal = slDistPct * leverage;
    riskFormatted = riskVal.toFixed(2).replace('.', ',');
    isCross = riskVal >= threshold;
  }

  const marginLabel = isCross ? 'CRUZADA' : 'ISOLADA';
  const orderTitle = parsed.orderType === 'MARKET' ? 'ORDEM A MERCADO' : 'ORDEM LIMITE';

  if (useHtml) {
    return (
      `💠 <b>${orderTitle}</b> 💠\n\n` +
      `🌲 <b>${coin}/USDT</b> 🌲\n\n` +
      `${dirEmoji} <b>${dirText} - ${leverage}x (${marginLabel})</b>\n\n` +
      `⚡ <b>Entrada:</b> ${entryFormatted}\n\n` +
      `${tpLines}\n\n` +
      `❌ <b>StopLoss:</b> ${stopFormatted}` +
      (riskFormatted ? `\n\n⚠️ <b>RISCO DA OPERAÇÃO</b>\n▸ <b>-${riskFormatted}%</b> sobre o valor aportado.` : '')
    );
  }

  return (
    `💠 ${orderTitle} 💠\n\n` +
    `🌲 ${coin}/USDT 🌲\n\n` +
    `${dirEmoji} ${dirText} - ${leverage}x (${marginLabel})\n\n` +
    `⚡ Entrada: ${entryFormatted}\n\n` +
    `${tpLines}\n\n` +
    `❌ StopLoss: ${stopFormatted}` +
    (riskFormatted ? `\n\n⚠️ RISCO DA OPERAÇÃO\n▸ -${riskFormatted}% sobre o valor aportado.` : '')
  );
}
