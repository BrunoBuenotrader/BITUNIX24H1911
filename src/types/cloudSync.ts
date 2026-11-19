export interface PartnerPermissions {
  canEditRisk: boolean;              // Se falso, risco fica fixado (ex: 2%) sem permissão de alteração
  canEditLeverage: boolean;          // Se falso, alavancagem fica travada na regra do Bruno
  canDisableStopLoss: boolean;       // Se falso, Stop Loss é estritamente obrigatório
  canEditTrailingStop: boolean;      // Se falso, Trailing Stop fica travado em 1x SL
  canExecuteRealTrading: boolean;    // Se falso, Leo só pode operar em modo Simulação / VST
  canEditApiKeys: boolean;           // Se falso, chaves de API ficam ocultas/bloqueadas
  canClearLogsOrHistory: boolean;    // Se falso, Leo não pode apagar logs nem zerar histórico
  canOverrideTakeProfits: boolean;   // Se Leo pode desmarcar/alterar alvos de TP
}

export interface TelegramBotConfig {
  autoExecuteWithoutPrompt: boolean;      // Se falso: manda botão [Confirmar & Executar]. Se verdadeiro: executa no mesmo segundo!
  riskPercent: number;                     // Risco em % da conta (ex: 2.0%)
  riskMode: 'PERCENT' | 'FIXED_USD';       // Risco em % ou USD Fixo
  riskFixedUsd: number;                    // Valor em $ se for USD Fixo (ex: $10)
  accountType: 'USDT' | 'VST';             // Executar em USDT Real ou Simulação VST
  defaultOrderType: 'SMART' | 'ENTRY_1' | 'ENTRY_2' | 'ENTRY_AVG' | 'MARKET'; // Tipo de entrada padrão
  defaultLeverageMode: 'SIGNAL_LEVERAGE' | 'FIXED_LEVERAGE'; // Seguir sinal ou forçar alavancagem fixa
  fixedLeverageValue: number;              // Valor fixo se selecionado (ex: 20x)
  maxLeverageCap: number;                  // Teto máximo de segurança (ex: 1000x)
  trailingStopEnabled: boolean;            // Trailing Stop ativo (true)
  trailingMultiplier: number;              // Multiplicador do SL (1.0x = 1:1, 1.5x, 2.0x)
  takeProfitSelection: 'TP1' | 'TP2' | 'TP3' | 'ALL_TPS' | 'LAST_TP'; // Qual TP registrar como ordem na Bitunix
  emergencyStopPercent: number;            // SL padrão se o sinal vier sem SL (ex: 2.0%)
  includeFeesInRisk: boolean;              // Embutir 0.10% de taxas no cálculo de margem
  autoCrossMarginEnabled: boolean;         // Ativar Margem Cruzada inteligente anti-liquidação
  autoCrossMarginThreshold: number;        // Limiar em % de perda com alavancagem para mudar para Cruzada (ex: 65%)
  dailyLossLimitEnabled?: boolean;         // Trava diária de perda ativa
  dailyLossPercent?: number;               // Trava diária em %
  dailyLossFixedUsd?: number;              // Trava diária em USD fixos
  telegramBotToken?: string;               // Token do Bot no Telegram (@BotFather)
}

export interface SharedSettings {
  accountType: 'USDT' | 'VST';
  executionMode: 'simulation' | 'api_real';
  apiKey?: string;
  apiSecret?: string;
  telegramBotToken?: string;
  activeOperator: 'Bruno' | 'Leo' | string;
  
  // Safety Locks (Travas de Segurança Master do Bruno)
  isMasterLocked: boolean;         // Trava Master do Bruno ativa
  masterPasswordOrPin?: string;    // PIN opcional do Bruno
  maxRiskPercent: number;          // Risco por Trade em % (ex: 2.0%)
  maxRiskPerTradeUsd: number;      // Risco em USD
  riskCalculationMode: 'PERCENT' | 'USD';
  allowFreeLeverage: boolean;      // Alavancagem livre do sinal com margem auto-calculada
  maxLeverageCap: number;          // Teto se alavancagem livre estiver desmarcada (ex: 1000x)
  requireStopLoss: boolean;        // Stop Loss Obrigatório
  emergencyStopPercent: number;    // SL padrão caso o sinal não informe (ex: 2.0%)
  dailyLossLimitPercent: number;   // Limite de perda diária %
  dailyLossLimitUsd: number;       // Limite de perda diária $
  autoCrossMarginEnabled?: boolean;// Ativar Margem Cruzada inteligente anti-liquidação
  autoCrossMarginThreshold?: number; // Limiar (ex: 65%)
  
  // Trailing Stop Lock
  lockTrailingStop1x: boolean;     // Trailing Stop ativado e travado em 1x SL (1:1)
  trailingStopMultiplier: number;  // 1.0 (1x)
  trailingStopMode: 'MATCH_SL' | 'CUSTOM';
  autoBreakEvenTarget: number;     // 0 = Off, 1 = TP1, 2 = TP2
  
  // Configurações Específicas do Bot do Telegram
  telegramBotConfig?: TelegramBotConfig;

  // Permissões Granulares para o Leo (Sócio)
  partnerPermissions: PartnerPermissions;

  updatedAt: string;
  updatedBy: string;
}

export interface ActivityLogItem {
  id: string;
  operator: string;
  action: string;
  details: string;
  type: 'info' | 'success' | 'warning' | 'error';
  timestamp: string;
}

export const DEFAULT_TELEGRAM_BOT_CONFIG: TelegramBotConfig = {
  autoExecuteWithoutPrompt: false,
  riskPercent: 2.0,
  riskMode: 'FIXED_USD',
  riskFixedUsd: 50.0,
  accountType: 'USDT',
  defaultOrderType: 'SMART',
  defaultLeverageMode: 'SIGNAL_LEVERAGE',
  fixedLeverageValue: 20,
  maxLeverageCap: 1000,
  trailingStopEnabled: true,
  trailingMultiplier: 1.0,
  takeProfitSelection: 'LAST_TP',
  emergencyStopPercent: 5.0,
  includeFeesInRisk: true,
  autoCrossMarginEnabled: true,
  autoCrossMarginThreshold: 25,
  dailyLossLimitEnabled: true,
  dailyLossPercent: 0,
  dailyLossFixedUsd: 100.0
};

export const DEFAULT_PARTNER_PERMISSIONS: PartnerPermissions = {
  canEditRisk: false,            // Risco travado no padrão do Bruno (2%)
  canEditLeverage: true,         // Alavancagem livre do sinal
  canDisableStopLoss: false,     // Stop Loss 100% obrigatório
  canEditTrailingStop: false,    // Trailing Stop travado em 1x
  canExecuteRealTrading: true,   // Pode executar em conta Real ou Demo
  canEditApiKeys: false,         // Protegido contra alteração de API
  canClearLogsOrHistory: false,  // Auditoria e logs protegidos
  canOverrideTakeProfits: true   // Pode escolher qual TP ativar
};

export const DEFAULT_SHARED_SETTINGS: SharedSettings = {
  accountType: 'USDT',
  executionMode: 'api_real',
  activeOperator: 'Bruno',
  
  // Configuração Padrão do Bruno: Risco 2% Fixado, Alavancagem Livre, Trailing Stop 1x
  isMasterLocked: true,
  masterPasswordOrPin: '1234',
  maxRiskPercent: 2,
  maxRiskPerTradeUsd: 50,
  riskCalculationMode: 'USD',
  allowFreeLeverage: true,
  maxLeverageCap: 1000,
  requireStopLoss: true,
  emergencyStopPercent: 2.0,
  dailyLossLimitPercent: 0,
  dailyLossLimitUsd: 100,
  autoCrossMarginEnabled: true,
  autoCrossMarginThreshold: 25,
  
  lockTrailingStop1x: true,
  trailingStopMultiplier: 1.0,
  trailingStopMode: 'MATCH_SL',
  autoBreakEvenTarget: 1,
  
  telegramBotConfig: DEFAULT_TELEGRAM_BOT_CONFIG,

  partnerPermissions: DEFAULT_PARTNER_PERMISSIONS,
  
  updatedAt: new Date().toISOString(),
  updatedBy: 'Bruno'
};
