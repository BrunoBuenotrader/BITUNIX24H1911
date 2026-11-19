import React, { useState, useEffect } from 'react';
import {
  Download,
  Upload,
  Copy,
  Check,
  Database,
  ShieldCheck,
  FileText,
  RefreshCw,
  AlertTriangle,
  Users,
  Key,
  Bot,
  ExternalLink,
  X,
  Sparkles,
  ChevronRight,
  FolderArchive,
  ArrowRight,
  CheckCircle2,
  HardDrive
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface SystemBackupModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateToView?: (view: 'copytrade' | 'accounts' | 'signals') => void;
}

export const SystemBackupModal: React.FC<SystemBackupModalProps> = ({
  isOpen,
  onClose,
  onNavigateToView
}) => {
  const [activeTab, setActiveTab] = useState<'export' | 'restore' | 'copytrade' | 'clone'>('export');
  const [loading, setLoading] = useState(false);
  const [backupData, setBackupData] = useState<any>(null);
  const [copied, setCopied] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [restoreText, setRestoreText] = useState('');
  const [restoreLoading, setRestoreLoading] = useState(false);
  const [restoreStatus, setRestoreStatus] = useState<{ type: 'success' | 'error' | null; message: string }>({ type: null, message: '' });
  const [dragActive, setDragActive] = useState(false);

  // Fetch full system backup when modal opens or user requests
  const fetchBackup = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/system/export-backup');
      const data = await res.json();
      if (data.success && data.backup) {
        setBackupData(data.backup);
        setJsonText(JSON.stringify(data.backup, null, 2));
      }
    } catch (err: any) {
      console.error('Erro ao buscar cópia do sistema:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchBackup();
      setRestoreStatus({ type: null, message: '' });
      setRestoreText('');
    }
  }, [isOpen]);

  const handleCopyClipboard = () => {
    if (!jsonText) return;
    navigator.clipboard.writeText(jsonText);
    setCopied(true);
    setTimeout(() => setCopied(false), 3000);
  };

  const handleDownloadFile = () => {
    if (!backupData && !jsonText) return;
    const dateStr = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filename = `bitunix_sistema_copia_backup_${dateStr}.json`;
    const blob = new Blob([jsonText], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleFileUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setRestoreText(text);
      validateAndPreviewRestore(text);
    };
    reader.readAsText(file);
  };

  const validateAndPreviewRestore = (text: string) => {
    try {
      const parsed = JSON.parse(text);
      if (!parsed || (!parsed.data && !parsed.credentials && !parsed.multiAccounts)) {
        setRestoreStatus({ type: 'error', message: 'O arquivo JSON selecionado não contém a estrutura válida de backup do sistema.' });
      } else {
        const d = parsed.data || parsed;
        const accCount = d.multiAccounts?.accounts?.length ?? (Array.isArray(d.multiAccounts) ? d.multiAccounts.length : 1);
        const sigCount = d.signals?.length ?? (Array.isArray(d.signals) ? d.signals.length : 0);
        setRestoreStatus({
          type: 'success',
          message: `Arquivo válido pronto para restauração! Contas detectadas: ${accCount} | Sinais: ${sigCount}`
        });
      }
    } catch (err: any) {
      setRestoreStatus({ type: 'error', message: 'Conteúdo JSON inválido: ' + err.message });
    }
  };

  const executeRestore = async () => {
    if (!restoreText) return;
    setRestoreLoading(true);
    setRestoreStatus({ type: null, message: '' });
    try {
      const parsed = JSON.parse(restoreText);
      const res = await fetch('/api/system/restore-backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backup: parsed })
      });
      const data = await res.json();
      if (data.success) {
        setRestoreStatus({
          type: 'success',
          message: '✅ Cópia restaurada com sucesso total! Todas as credenciais, contas e configurações foram sincronizadas.'
        });
        fetchBackup();
      } else {
        setRestoreStatus({
          type: 'error',
          message: 'Falha ao restaurar: ' + (data.error || 'Erro desconhecido')
        });
      }
    } catch (err: any) {
      setRestoreStatus({
        type: 'error',
        message: 'Erro durante a restauração: ' + err.message
      });
    } finally {
      setRestoreLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex items-center justify-center p-3 sm:p-4 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 10 }}
        className="bg-brand-surface border border-brand-border rounded-2xl max-w-3xl w-full p-4 sm:p-6 shadow-2xl space-y-5 relative my-auto max-h-[92vh] flex flex-col"
      >
        {/* Top Header */}
        <div className="flex items-center justify-between pb-3 border-b border-brand-border shrink-0">
          <div className="flex items-center space-x-3">
            <div className="p-2.5 bg-brand-accent/20 text-brand-accent border border-brand-accent/40 rounded-xl shadow-inner">
              <FolderArchive className="w-6 h-6" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-black text-white tracking-wide">
                  Central de Cópia & Backup
                </h2>
                <span className="px-2 py-0.5 rounded-full text-[9px] font-mono font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                  100% Completo & Seguro
                </span>
              </div>
              <p className="text-xs text-brand-text/60">
                Gere uma cópia completa dos dados, restaure backups ou configure a cópia de operações (Copy Trade).
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 text-brand-text/50 hover:text-white hover:bg-brand-bg rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Selection */}
        <div className="flex space-x-1 sm:space-x-2 bg-brand-bg/80 p-1 rounded-xl border border-brand-border/60 shrink-0 overflow-x-auto">
          <button
            onClick={() => setActiveTab('export')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 ${
              activeTab === 'export'
                ? 'bg-brand-accent text-white shadow-md'
                : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
            }`}
          >
            <Download className="w-4 h-4" />
            <span>Fazer Cópia / Baixar</span>
          </button>

          <button
            onClick={() => setActiveTab('restore')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 ${
              activeTab === 'restore'
                ? 'bg-brand-accent text-white shadow-md'
                : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
            }`}
          >
            <Upload className="w-4 h-4" />
            <span>Restaurar de Cópia</span>
          </button>

          <button
            onClick={() => setActiveTab('copytrade')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 ${
              activeTab === 'copytrade'
                ? 'bg-blue-600 text-white shadow-md'
                : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
            }`}
          >
            <Users className="w-4 h-4" />
            <span>Cópia de Operações (Copy Trade)</span>
          </button>

          <button
            onClick={() => setActiveTab('clone')}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold transition-all shrink-0 ${
              activeTab === 'clone'
                ? 'bg-purple-600 text-white shadow-md'
                : 'text-brand-text/60 hover:text-white hover:bg-brand-surface'
            }`}
          >
            <Sparkles className="w-4 h-4" />
            <span>Clonar Aplicativo</span>
          </button>
        </div>

        {/* Tab Content */}
        <div className="flex-1 overflow-y-auto pr-1 space-y-4">
          {/* TAB 1: EXPORT / FAZER CÓPIA */}
          {activeTab === 'export' && (
            <div className="space-y-4">
              {/* Main Call to Action Box */}
              <div className="p-4 sm:p-5 rounded-2xl bg-gradient-to-br from-brand-accent/15 via-brand-bg to-brand-surface border border-brand-accent/30 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-black text-white flex items-center gap-2">
                      <HardDrive className="w-4 h-4 text-brand-accent" />
                      Cópia Completa do Sistema em 1 Clique
                    </h3>
                    <p className="text-xs text-brand-text/70 mt-1">
                      Exporta todas as chaves de API, contas vinculadas, histórico de sinais, ordens executadas, canais do Telegram e travas de segurança em um único arquivo JSON.
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={fetchBackup}
                      disabled={loading}
                      title="Atualizar dados para a cópia"
                      className="p-2.5 bg-brand-surface border border-brand-border hover:bg-brand-bg rounded-xl text-brand-text/70 hover:text-white transition-colors"
                    >
                      <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      onClick={handleCopyClipboard}
                      className="px-3.5 py-2.5 bg-brand-surface border border-brand-border hover:bg-brand-bg rounded-xl text-xs font-bold text-white transition-colors flex items-center gap-1.5 shadow-sm"
                    >
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4 text-brand-accent" />}
                      <span>{copied ? 'Copiado!' : 'Copiar JSON'}</span>
                    </button>
                    <button
                      onClick={handleDownloadFile}
                      className="px-4 py-2.5 bg-brand-accent hover:bg-brand-accent/90 text-white rounded-xl text-xs font-black transition-all flex items-center gap-2 shadow-lg shadow-brand-accent/25 hover:scale-[1.02]"
                    >
                      <Download className="w-4 h-4" />
                      <span>Baixar Cópia (.JSON)</span>
                    </button>
                  </div>
                </div>

                {/* Items Breakdown Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-brand-border/40">
                  <div className="bg-brand-bg/60 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-brand-text/50 uppercase">
                      <Key className="w-3 h-3 text-yellow-400" />
                      Credenciais
                    </div>
                    <div className="text-xs font-mono font-bold text-white mt-1">
                      {backupData?.data?.credentials?.apiKey ? 'Bitunix & Bot OK' : 'Configuradas'}
                    </div>
                  </div>

                  <div className="bg-brand-bg/60 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-brand-text/50 uppercase">
                      <Users className="w-3 h-3 text-purple-400" />
                      Multi-Contas
                    </div>
                    <div className="text-xs font-mono font-bold text-white mt-1">
                      {backupData?.summary?.accountsCount ?? 1} Conta(s) Salva(s)
                    </div>
                  </div>

                  <div className="bg-brand-bg/60 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-brand-text/50 uppercase">
                      <Bot className="w-3 h-3 text-sky-400" />
                      Bot Telegram
                    </div>
                    <div className="text-xs font-mono font-bold text-white mt-1">
                      {backupData?.summary?.chatsCount ?? 0} Chat(s) & Regras
                    </div>
                  </div>

                  <div className="bg-brand-bg/60 p-2.5 rounded-xl border border-white/5">
                    <div className="flex items-center gap-1.5 text-[10px] font-bold text-brand-text/50 uppercase">
                      <ShieldCheck className="w-3 h-3 text-emerald-400" />
                      Trailing & Travas
                    </div>
                    <div className="text-xs font-mono font-bold text-white mt-1">
                      100% Protegido
                    </div>
                  </div>
                </div>
              </div>

              {/* JSON Code Inspector */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-brand-text/50 font-bold uppercase tracking-wider px-1">
                  <span>Pré-visualização da Cópia (JSON Raw)</span>
                  <span>{jsonText ? `${(jsonText.length / 1024).toFixed(1)} KB` : 'Carregando...'}</span>
                </div>
                <div className="relative">
                  <pre className="bg-[#07090e] border border-brand-border/60 rounded-xl p-3 text-[10px] font-mono text-emerald-400/90 max-h-52 overflow-y-auto select-all leading-relaxed whitespace-pre-wrap">
                    {loading ? '// Gerando pacote de cópia integral do sistema...' : (jsonText || '// Nenhum dado retornado')}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: RESTORE / RESTAURAR */}
          {activeTab === 'restore' && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div className="text-xs space-y-1">
                  <div className="font-bold text-amber-300">Restauração de Backup do Sistema</div>
                  <p className="text-brand-text/70">
                    Ao restaurar uma cópia, as configurações do servidor, contas cadastradas e regras de trading serão substituídas pelas informações presentes no arquivo de backup.
                  </p>
                </div>
              </div>

              {/* Drag and Drop Zone */}
              <div
                onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
                    handleFileUpload(e.dataTransfer.files[0]);
                  }
                }}
                className={`border-2 border-dashed rounded-2xl p-6 text-center cursor-pointer transition-all ${
                  dragActive
                    ? 'border-brand-accent bg-brand-accent/10'
                    : 'border-brand-border/80 hover:border-brand-accent/50 bg-brand-bg/40'
                }`}
                onClick={() => {
                  const input = document.createElement('input');
                  input.type = 'file';
                  input.accept = '.json,application/json';
                  input.onchange = (e: any) => {
                    if (e.target.files && e.target.files[0]) {
                      handleFileUpload(e.target.files[0]);
                    }
                  };
                  input.click();
                }}
              >
                <Upload className="w-8 h-8 text-brand-accent mx-auto mb-2 opacity-80" />
                <div className="text-xs font-bold text-white">
                  Clique para selecionar o arquivo da cópia (.JSON) ou arraste-o aqui
                </div>
                <div className="text-[10px] text-brand-text/50 mt-1">
                  Aceita arquivos de backup gerados por este aplicativo
                </div>
              </div>

              {/* Paste JSON manually */}
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-brand-text/70 flex items-center justify-between">
                  <span>Ou cole o conteúdo JSON da cópia diretamente:</span>
                  {restoreText && (
                    <button
                      onClick={() => setRestoreText('')}
                      className="text-[10px] text-brand-danger hover:underline"
                    >
                      Limpar
                    </button>
                  )}
                </label>
                <textarea
                  value={restoreText}
                  onChange={(e) => {
                    setRestoreText(e.target.value);
                    if (e.target.value.trim()) {
                      validateAndPreviewRestore(e.target.value);
                    }
                  }}
                  placeholder='Cole aqui {"appName": "BITUNIX...", "data": {...}}'
                  className="w-full bg-[#07090e] border border-brand-border rounded-xl p-3 text-xs font-mono text-white placeholder:text-brand-text/30 outline-none focus:border-brand-accent min-h-[110px]"
                />
              </div>

              {/* Status Alert */}
              {restoreStatus.type && (
                <div className={`p-3 rounded-xl border flex items-center gap-2 text-xs font-mono ${
                  restoreStatus.type === 'success'
                    ? 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300'
                    : 'bg-red-500/15 border-red-500/30 text-red-300'
                }`}>
                  {restoreStatus.type === 'success' ? (
                    <CheckCircle2 className="w-4 h-4 shrink-0 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 shrink-0 text-red-400" />
                  )}
                  <span>{restoreStatus.message}</span>
                </div>
              )}

              {/* Confirm Restore Button */}
              <div className="flex justify-end pt-2">
                <button
                  onClick={executeRestore}
                  disabled={!restoreText.trim() || restoreLoading}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-xl text-xs font-black transition-all flex items-center gap-2 shadow-lg shadow-emerald-600/20"
                >
                  {restoreLoading ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4" />
                  )}
                  <span>{restoreLoading ? 'Restaurando Cópia...' : 'Confirmar e Restaurar Sistema'}</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB 3: COPY TRADE (CÓPIA DE OPERAÇÕES) */}
          {activeTab === 'copytrade' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-blue-950/40 border border-blue-500/30 space-y-3">
                <div className="flex items-center gap-2 text-blue-300 font-bold text-sm">
                  <Users className="w-5 h-5 text-blue-400" />
                  Como Funciona a Cópia de Operações (Copy Trade)
                </div>
                <p className="text-xs text-brand-text/80 leading-relaxed">
                  O sistema possui duas camadas de cópia de trades automatizadas para você operar com segurança absoluta:
                </p>
              </div>

              {/* Method 1: Multi-Account Replicator */}
              <div className="p-4 rounded-xl bg-brand-bg/60 border border-brand-border/70 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-purple-500/20 text-purple-300 flex items-center justify-center text-[10px] font-bold">1</span>
                    <h4 className="text-xs font-bold text-white">Replicador Automático Multi-Contas (Interno)</h4>
                  </div>
                  <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                    Ativo no Sistema
                  </span>
                </div>
                <p className="text-xs text-brand-text/60 leading-relaxed">
                  Cada sinal de entrada (via Telegram ou Manual) pode ser replicado simultaneamente para todas as contas cadastradas na aba <b>Multi-Contas</b>, com controle de risco individual (% da banca ou dólar fixo) para cada operador.
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => {
                      onClose();
                      onNavigateToView?.('accounts');
                    }}
                    className="px-3 py-1.5 bg-purple-600/30 hover:bg-purple-600/50 text-purple-200 border border-purple-500/40 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5"
                  >
                    <span>Configurar Contas no Multi-Contas</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              {/* Method 2: Bitunix Leader Trader */}
              <div className="p-4 rounded-xl bg-brand-bg/60 border border-brand-border/70 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-5 h-5 rounded-full bg-blue-500/20 text-blue-300 flex items-center justify-center text-[10px] font-bold">2</span>
                    <h4 className="text-xs font-bold text-white">Trader Líder Oficial Bitunix (Seguidores Externos)</h4>
                  </div>
                  <span className="text-[9px] font-bold px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30">
                    Bitunix Copy Trade
                  </span>
                </div>
                <p className="text-xs text-brand-text/60 leading-relaxed">
                  Conecte sua conta como Trader Líder na Bitunix para que outros investidores e seguidores copiem suas ordens diretamente na exchange, gerando comissões sobre os lucros realizados.
                </p>
                <div className="pt-2">
                  <button
                    onClick={() => {
                      onClose();
                      onNavigateToView?.('copytrade');
                    }}
                    className="px-3 py-1.5 bg-blue-600/30 hover:bg-blue-600/50 text-blue-200 border border-blue-500/40 rounded-lg text-xs font-bold transition-colors flex items-center gap-1.5"
                  >
                    <span>Abrir Painel Copy Trade</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: CLONE / DUPLICAR APLICATIVO */}
          {activeTab === 'clone' && (
            <div className="space-y-4">
              <div className="p-4 rounded-2xl bg-purple-950/40 border border-purple-500/30 space-y-3">
                <div className="flex items-center gap-2 text-purple-300 font-bold text-sm">
                  <Sparkles className="w-5 h-5 text-purple-400" />
                  Como Duplicar ou Fazer uma Cópia deste App no Google AI Studio
                </div>
                <p className="text-xs text-brand-text/80 leading-relaxed">
                  Se você deseja criar um clone completo deste ambiente para ter uma segunda instância ou rodar em outra máquina:
                </p>
              </div>

              <div className="space-y-2.5">
                <div className="p-3 bg-brand-bg rounded-xl border border-brand-border/60 flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    1
                  </div>
                  <div className="text-xs space-y-1">
                    <span className="font-bold text-white">Baixe o Backup JSON</span>
                    <p className="text-brand-text/60">
                      Na aba <b>Fazer Cópia / Baixar</b>, clique em <b>Baixar Cópia (.JSON)</b> para garantir que todas as suas configurações, contas e regras estejam salvas.
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-brand-bg rounded-xl border border-brand-border/60 flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    2
                  </div>
                  <div className="text-xs space-y-1">
                    <span className="font-bold text-white">Duplicar Projeto no Google AI Studio</span>
                    <p className="text-brand-text/60">
                      No menu superior do Google AI Studio, você pode duplicar o projeto (Fork / Duplicate) para gerar uma nova URL independente.
                    </p>
                  </div>
                </div>

                <div className="p-3 bg-brand-bg rounded-xl border border-brand-border/60 flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-brand-accent/20 text-brand-accent flex items-center justify-center text-xs font-bold shrink-0 mt-0.5">
                    3
                  </div>
                  <div className="text-xs space-y-1">
                    <span className="font-bold text-white">Restauração Imediata</span>
                    <p className="text-brand-text/60">
                      No novo app clonado, abra esta mesma janela de <b>Central de Cópia & Backup</b>, vá em <b>Restaurar de Cópia</b> e envie seu arquivo JSON. O novo sistema estará 100% configurado em segundos!
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="pt-3 border-t border-brand-border flex items-center justify-between shrink-0">
          <div className="text-[10px] text-brand-text/50 font-mono">
            Bitunix Cloud Copy & Backup v2.5.0
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 bg-brand-surface hover:bg-brand-bg border border-brand-border rounded-xl text-xs font-bold text-white transition-colors"
          >
            Fechar
          </button>
        </div>
      </motion.div>
    </div>
  );
};
