export interface TradingAccount {
  id: string;                      // ex: 'acc_master', 'acc_partner_1'
  name: string;                    // ex: 'Minha Conta Principal (Bruno)', 'Conta Parceiro (Leo)'
  ownerName: string;               // ex: 'Bruno', 'Leo'
  role: 'ADMIN' | 'OPERATOR';      // ADMIN pode ver todas as contas; OPERATOR só gerencia a sua
  apiKey: string;                  // API Key da Bitunix
  apiSecret: string;               // API Secret da Bitunix
  accountType: 'USDT' | 'VST';     // Real ou Demo
  isActive: boolean;               // Habilitada para operar
  copyTradingEnabled: boolean;     // Replicar sinais automaticamente quando um sinal chegar
  
  // Gestão de Risco individual da conta
  riskMode: 'PERCENT' | 'FIXED_USD'; // Risco em % ou USD Fixo
  riskPercent: number;             // ex: 2.0%
  riskFixedUsd: number;            // ex: 10 USDT
  fixedLeverage?: number;          // Se preenchido, força essa alavancagem
  
  // Notificações individuais
  telegramChatId?: string;         // Chat ID do Telegram individual deste operador
  notifyOnExecution: boolean;      // Enviar mensagem no Telegram individual dele
  
  // Token / Senha de Acesso Web Restrito
  accessPin?: string;              // PIN de acesso ao painel do operador (ex: 4 dígitos)
  
  createdAt: string;
  updatedAt: string;
}

export interface MultiAccountConfig {
  masterPin: string;               // PIN de Administrador (Bruno)
  accounts: TradingAccount[];
}
