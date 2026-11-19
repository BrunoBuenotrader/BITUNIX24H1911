import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ============================================================================
// 1. CONFIGURAÇÕES & PERSISTÊNCIA DO OFFSET
// ============================================================================
const LAST_UPDATE_FILE = path.join(process.cwd(), 'data_telegram_last_update.json');

let getTokenFn: () => string = () => process.env.TELEGRAM_BOT_TOKEN || '';
let onUpdateHandler: ((update: any) => Promise<void>) | null = null;

let lastUpdateId = 0;
let isPollingActive = false;
let pollingGeneration = 0;
let lastPollingHeartbeat = Date.now();
let botUsername = 'Crypptooo_bot';
let consecutive409Count = 0;
let totalProcessedUpdates = 0;
let hasInitializedBotMeta = false;

const getActiveToken = (): string => (getTokenFn() || '').trim();

// Carrega o último update_id processado para não reprocessar mensagens antigas após reiniciar
export const loadLastUpdateId = () => {
  try {
    if (fs.existsSync(LAST_UPDATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LAST_UPDATE_FILE, 'utf-8'));
      if (typeof data.lastUpdateId === 'number' && data.lastUpdateId > 0) {
        lastUpdateId = data.lastUpdateId;
      }
    }
  } catch (e) {}
};

// Salva o offset no disco
export const saveLastUpdateId = (id: number) => {
  try {
    lastUpdateId = id;
    fs.writeFileSync(
      LAST_UPDATE_FILE,
      JSON.stringify({ lastUpdateId: id, updatedAt: Date.now() }),
      'utf-8'
    );
  } catch (e) {}
};

loadLastUpdateId();

// Cache em memória para evitar processar a mesma mensagem duas vezes
const inFlightDeduplication = new Set<string>();
export const isDuplicate = (key: string): boolean => {
  if (inFlightDeduplication.has(key)) return true;
  inFlightDeduplication.add(key);
  if (inFlightDeduplication.size > 2000) {
    const [first] = inFlightDeduplication;
    if (first !== undefined) inFlightDeduplication.delete(first);
  }
  return false;
};

// ============================================================================
// 2. CONFIGURAÇÃO DINÂMICA & ESTADO PARA SERVER.TS
// ============================================================================
export const configureTelegramBot = (opts: {
  getToken: () => string;
  onUpdate: (update: any) => Promise<void>;
  defaultBotUsername?: string;
}) => {
  getTokenFn = opts.getToken;
  onUpdateHandler = opts.onUpdate;
  if (opts.defaultBotUsername) {
    botUsername = opts.defaultBotUsername;
  }
};

export const resetBotMetadataFlag = () => {
  hasInitializedBotMeta = false;
};

export const setTelegramBotUsername = (username: string) => {
  if (username) botUsername = username;
};

export const getTelegramBotState = () => ({
  lastUpdateId,
  isPollingActive,
  lastPollingHeartbeat,
  botUsername,
  consecutive409Count,
  totalProcessedUpdates
});

// ============================================================================
// 3. FUNÇÕES DE ENVIO E RESPOSTA (COM FALLBACK HTML)
// ============================================================================

/**
 * Responde cliques nos botões inline instantaneamente (remove o relógio do botão no Telegram)
 */
export const answerCallbackQuery = async (
  callbackQueryId: string,
  text?: string,
  showAlert = false
) => {
  const token = getActiveToken();
  if (!callbackQueryId || !token) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/answerCallbackQuery`,
      {
        callback_query_id: callbackQueryId,
        text: text || undefined,
        show_alert: showAlert,
        cache_time: 0
      },
      { timeout: 4000 }
    );
  } catch (e) {}
};

/**
 * Envia mensagens com suporte a HTML e fallback automático caso haja erro de tags
 */
export const sendTelegramMessage = async (
  chatId: number | string,
  text: string,
  replyMarkup?: any
) => {
  const token = getActiveToken();
  if (!token || !chatId) return null;

  try {
    const payload: any = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML'
    };
    if (replyMarkup) payload.reply_markup = replyMarkup;

    const res = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      payload,
      { timeout: 8000 }
    );
    return res.data?.result;
  } catch (err: any) {
    const errDetail = err?.response?.data?.description || err?.message || '';
    if (
      errDetail.includes('chat not found') ||
      errDetail.includes('bot was blocked') ||
      errDetail.includes('user is deactivated')
    ) {
      throw err;
    }

    // Se falhar por erro de sintaxe HTML, remove as tags e envia texto puro
    try {
      const plainText = text.replace(/<[^>]*>?/gm, '');
      const fallbackPayload: any = { chat_id: chatId, text: plainText };
      if (replyMarkup) fallbackPayload.reply_markup = replyMarkup;

      const fallbackRes = await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        fallbackPayload,
        { timeout: 8000 }
      );
      return fallbackRes.data?.result;
    } catch (e) {
      console.error('[TELEGRAM-SEND-ERROR]:', err?.response?.data || err?.message);
      return null;
    }
  }
};

// ============================================================================
// 4. INICIALIZAÇÃO DE METADADOS & MENU DE COMANDOS (☰)
// ============================================================================
export const initBotMetadata = async () => {
  const token = getActiveToken();
  if (!token || hasInitializedBotMeta) return;

  try {
    // 1. Limpa webhooks antigos para liberar o long-polling
    await axios
      .get(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
        timeout: 8000
      })
      .catch(() => {});

    // 2. Identifica o username do bot conectado
    const meResp = await axios
      .get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 6000 })
      .catch(() => null);
    if (meResp?.data?.result?.username) {
      botUsername = meResp.data.result.username;
      console.log(
        `[TELEGRAM-BOT] Conectado como @${botUsername} (${meResp.data.result.first_name})`
      );
    }

    // 3. Registra o menu de comandos rápidos (botão ☰ do Telegram)
    const commands = [
      { command: 'status', description: '💼 Saldo e Status da Bitunix' },
      { command: 'posicoes', description: '📈 Ver Posições Abertas' },
      { command: 'pendentes', description: '⏳ Ver Ordens Pendentes' },
      { command: 'imagem', description: '🖼️ Enviar Imagem / Gráfico (IA)' },
      { command: 'historico', description: '📜 Histórico de Trades' },
      { command: 'relatorio', description: '📊 Relatório de Lucros (PnL)' },
      { command: 'copy', description: '👥 Painel Copy Trade' },
      { command: 'conducao', description: '🎯 Condução de Stop (Proteção Escalonada)' },
      { command: 'config', description: '⚙️ Configurações (Conta, Condução, Risco, Trava)' },
      { command: 'ajuda', description: '📖 Ajuda & Comandos' }
    ];

    await axios
      .post(`https://api.telegram.org/bot${token}/setMyCommands`, { commands }, { timeout: 8000 })
      .catch(() => {});
    await axios
      .post(
        `https://api.telegram.org/bot${token}/setChatMenuButton`,
        { menu_button: { type: 'commands' } },
        { timeout: 6000 }
      )
      .catch(() => {});

    hasInitializedBotMeta = true;
    console.log('[TELEGRAM-BOT] Menu de comandos registrado com sucesso!');
  } catch (e: any) {
    console.warn('[TELEGRAM-INIT-WARN]:', e?.message || e);
  }
};

// ============================================================================
// 5. PROCESSAMENTO DE UPDATES COM DEDUPLICAÇÃO
// ============================================================================
const dispatchTelegramUpdate = async (update: any) => {
  if (!update) return;

  // 1. Evita duplicidade por Update ID
  if (update.update_id && isDuplicate(`upd_${update.update_id}`)) return;

  // 2. Evita duplicidade por Callback ID ou Message ID
  if (update.callback_query?.id) {
    if (isDuplicate(`cb_${update.callback_query.id}`)) return;
  } else {
    const msg = update.message || update.channel_post || update.edited_message;
    if (msg?.chat?.id && msg?.message_id) {
      if (isDuplicate(`msg_${msg.chat.id}_${msg.message_id}`)) return;
    }
  }

  totalProcessedUpdates++;

  if (onUpdateHandler) {
    await onUpdateHandler(update);
  }
};

// ============================================================================
// 6. LOOP DE POLLING CONTÍNUO (VERSÃO 1 - NUNCA TRAVA)
// ============================================================================
const runPollingLoop = async (myGeneration: number) => {
  console.log(`[TELEGRAM-POLLING] 🚀 Iniciando escuta ininterrupta do Telegram (geração #${myGeneration})...`);
  await initBotMetadata();

  let offset = lastUpdateId > 0 ? lastUpdateId + 1 : 0;

  // Loop contínuo padrão da Versão 1:
  // Usa timeout do Telegram de 20s e timeout de socket de 35s.
  while (isPollingActive && myGeneration === pollingGeneration) {
    const token = getActiveToken();
    if (!token) {
      lastPollingHeartbeat = Date.now();
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (!hasInitializedBotMeta) {
      await initBotMetadata();
    }

    try {
      const offsetParam = offset > 0 ? `&offset=${offset}` : '';
      const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=20${offsetParam}`;

      const res = await axios.get(url, {
        timeout: 35000,
        validateStatus: (status) => status < 500
      });

      if (myGeneration !== pollingGeneration || !isPollingActive) break;

      lastPollingHeartbeat = Date.now();

      if (res.status === 200 && res.data?.ok && Array.isArray(res.data.result)) {
        consecutive409Count = 0;
        for (const update of res.data.result) {
          if (update.update_id) {
            offset = update.update_id + 1;
            if (update.update_id > lastUpdateId) {
              saveLastUpdateId(update.update_id);
            }
          }

          // Executa em segundo plano para não bloquear a fila do loop
          dispatchTelegramUpdate(update).catch((err) => {
            console.error('[TELEGRAM-PROCESS-ERR]:', err?.message || err);
          });
        }
      } else if (res.status === 409) {
        consecutive409Count++;
        if (consecutive409Count === 1 || consecutive409Count % 5 === 0) {
          console.warn(`[TELEGRAM] Conflito 409 temporário (${consecutive409Count}x - outra sessão/preview usando o mesmo bot). Aguardando...`);
        }
        if (consecutive409Count === 1) {
          await axios
            .get(`https://api.telegram.org/bot${token}/deleteWebhook?drop_pending_updates=false`, {
              timeout: 5000
            })
            .catch(() => {});
        }
        const waitMs = consecutive409Count > 2 ? 4000 : 2000;
        await new Promise((r) => setTimeout(r, waitMs));
      } else if (res.status === 429) {
        const retryAfter = (res.data?.parameters?.retry_after || 5) * 1000;
        console.warn(`[TELEGRAM] Rate-limit 429. Aguardando ${retryAfter / 1000}s...`);
        await new Promise((r) => setTimeout(r, retryAfter));
      } else {
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (err: any) {
      if (myGeneration !== pollingGeneration || !isPollingActive) break;
      lastPollingHeartbeat = Date.now();
      // Timeouts normais de long-polling (20s) NÃO são erros reais de rede
      const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
      if (!isTimeout) {
        console.warn('[TELEGRAM-NETWORK-WARN]:', err?.message || err);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // Pequena folga de 50ms para desobstruir o Event Loop do Node.js
    await new Promise((r) => setTimeout(r, 50));
  }
};

export const startTelegramPolling = (forceRestart = false) => {
  const token = getActiveToken();
  if (!token) {
    console.error('[TELEGRAM-POLLING] Token não configurado!');
    return;
  }

  if (isPollingActive && !forceRestart) return;

  pollingGeneration++;
  isPollingActive = true;
  lastPollingHeartbeat = Date.now();

  if (forceRestart) {
    hasInitializedBotMeta = false;
  }

  const myGen = pollingGeneration;
  runPollingLoop(myGen).catch((err) => {
    console.error('[TELEGRAM-LOOP-FATAL]:', err?.message || err);
    if (myGen === pollingGeneration) {
      isPollingActive = false;
    }
  });
};

export const stopTelegramPolling = () => {
  if (!isPollingActive) return;
  pollingGeneration++;
  isPollingActive = false;
  console.log('[TELEGRAM-POLLING] ⏸️ Escuta pausada neste ambiente (cedida ao servidor 24h ativo).');
};
