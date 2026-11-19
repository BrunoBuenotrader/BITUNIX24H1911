import React, { useState, useEffect } from 'react';
import { 
  Users, Key, Shield, UserPlus, Trash2, CheckCircle2, 
  AlertCircle, RefreshCw, Send, Lock, Eye, EyeOff, 
  Percent, DollarSign, Smartphone, ExternalLink, Sliders
} from 'lucide-react';
import { TradingAccount } from '../types/multiAccount';

export const MultiAccountManager: React.FC = () => {
  const [pin, setPin] = useState<string>(() => localStorage.getItem('multi_account_pin') || '1234');
  const [authenticatedRole, setAuthenticatedRole] = useState<'ADMIN' | 'OPERATOR' | null>(null);
  const [accounts, setAccounts] = useState<TradingAccount[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Modal para criar/editar conta
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editingAccount, setEditingAccount] = useState<Partial<TradingAccount>>({
    name: '',
    ownerName: '',
    role: 'OPERATOR',
    apiKey: '',
    apiSecret: '',
    accountType: 'USDT',
    isActive: true,
    copyTradingEnabled: true,
    riskMode: 'FIXED_USD',
    riskPercent: 2.0,
    riskFixedUsd: 50.0,
    notifyOnExecution: true,
    accessPin: '1234'
  });
  const [showSecret, setShowSecret] = useState<boolean>(false);
  const [balances, setBalances] = useState<Record<string, { balance: number; connected: boolean }>>({});
  const [testingConnection, setTestingConnection] = useState<boolean>(false);

  // Carrega as contas da API
  const fetchAccounts = async (pinToUse = pin) => {
    setLoading(true);
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/accounts?pin=${encodeURIComponent(pinToUse)}`);
      const data = await res.json();
      if (res.ok && data.ok) {
        setAccounts(data.accounts || []);
        setAuthenticatedRole(data.role);
        localStorage.setItem('multi_account_pin', pinToUse);

        // Busca saldos de cada conta
        data.accounts.forEach((acc: TradingAccount) => {
          fetchAccountBalance(acc.id);
        });
      } else {
        setAuthenticatedRole(null);
        setErrorMsg(data.error || "PIN inválido ou acesso negado.");
      }
    } catch (err: any) {
      setErrorMsg("Erro de conexão ao buscar contas: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const fetchAccountBalance = async (accId: string) => {
    try {
      const res = await fetch(`/api/accounts/${accId}/balance`);
      const data = await res.json();
      if (data.ok) {
        setBalances(prev => ({
          ...prev,
          [accId]: { balance: data.balance || 0, connected: data.connected }
        }));
      }
    } catch (e) {}
  };

  useEffect(() => {
    if (pin) {
      fetchAccounts(pin);
    }
  }, []);

  const handleSaveAccount = async () => {
    if (!editingAccount.name || !editingAccount.ownerName) {
      setErrorMsg("Preencha o nome da conta e o nome do operador.");
      return;
    }

    setLoading(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('/api/accounts/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin,
          account: editingAccount
        })
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        setSuccessMsg(`Conta "${editingAccount.name}" salva com sucesso!`);
        setIsEditing(false);
        fetchAccounts(pin);
      } else {
        setErrorMsg(data.error || "Erro ao salvar conta.");
      }
    } catch (err: any) {
      setErrorMsg("Falha ao salvar: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteAccount = async (accId: string, accName: string) => {
    if (!window.confirm(`Deseja realmente remover a conta "${accName}"? As ordens não serão mais replicadas para ela.`)) {
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/accounts/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, accountId: accId })
      });
      const data = await res.json();
      if (data.ok) {
        setSuccessMsg("Conta removida com sucesso.");
        fetchAccounts(pin);
      } else {
        setErrorMsg(data.error || "Erro ao remover conta.");
      }
    } catch (err: any) {
      setErrorMsg("Falha ao excluir: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleTestBitunix = async () => {
    setTestingConnection(true);
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const res = await fetch('/api/accounts/test-connection', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: editingAccount.apiKey,
          apiSecret: editingAccount.apiSecret,
          accountId: editingAccount.id
        })
      });
      const data = await res.json();
      if (data.ok) {
        setSuccessMsg(data.message || "Conexão com a Bitunix validada com sucesso!");
      } else {
        setErrorMsg(data.error || "Erro na validação da Bitunix.");
      }
    } catch (err: any) {
      setErrorMsg("Falha no teste: " + err.message);
    } finally {
      setTestingConnection(false);
    }
  };

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-6 text-brand-text">
      {/* Cabeçalho */}
      <div className="bg-brand-surface border border-brand-border rounded-2xl p-6 shadow-xl relative overflow-hidden">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center space-x-3 mb-2">
              <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-xl text-blue-400">
                <Users className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl md:text-2xl font-bold tracking-tight text-white flex items-center gap-2">
                  Multi-Contas & Copy Trading
                  <span className="text-xs px-2.5 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                    Isolamento Total
                  </span>
                </h1>
                <p className="text-xs md:text-sm text-brand-text/60">
                  Gerencie múltiplos operadores e replique os sinais do Telegram instantaneamente em contas Bitunix separadas.
                </p>
              </div>
            </div>
          </div>

          {/* Autenticação rápida de PIN */}
          <div className="flex items-center gap-3 bg-brand-bg/60 p-2.5 rounded-xl border border-brand-border">
            <Lock className="w-4 h-4 text-brand-text/40 ml-1" />
            <input 
              type="password"
              placeholder="PIN de Acesso"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="bg-transparent border-none text-sm text-white focus:outline-none w-28 tracking-widest font-mono"
            />
            <button 
              onClick={() => fetchAccounts(pin)}
              disabled={loading}
              className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-all"
            >
              {loading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : "Entrar"}
            </button>
          </div>
        </div>

        {authenticatedRole && (
          <div className="mt-4 pt-4 border-t border-brand-border/40 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-brand-text/50">Nível de Acesso:</span>
              <span className={`font-bold px-2 py-0.5 rounded ${authenticatedRole === 'ADMIN' ? 'bg-amber-500/10 text-amber-400 border border-amber-500/20' : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'}`}>
                {authenticatedRole === 'ADMIN' ? '👑 ADMINISTRADOR (BRUNO)' : '👤 OPERADOR CONVIDADO'}
              </span>
            </div>
            {authenticatedRole === 'ADMIN' && (
              <button 
                onClick={() => {
                  setEditingAccount({
                    name: `Conta Parceiro #${accounts.length}`,
                    ownerName: '',
                    role: 'OPERATOR',
                    apiKey: '',
                    apiSecret: '',
                    accountType: 'USDT',
                    isActive: true,
                    copyTradingEnabled: true,
                    riskMode: 'FIXED_USD',
                    riskPercent: 2.0,
                    riskFixedUsd: 50.0,
                    notifyOnExecution: true,
                    accessPin: '5678'
                  });
                  setIsEditing(true);
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-medium transition-all shadow-lg shadow-emerald-950/20"
              >
                <UserPlus className="w-4 h-4" />
                <span>Adicionar Operador</span>
              </button>
            )}
          </div>
        )}
      </div>

      {/* Avisos */}
      {errorMsg && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl flex items-start space-x-3 text-rose-400 text-sm">
          <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}
      {successMsg && (
        <div className="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-start space-x-3 text-emerald-400 text-sm">
          <CheckCircle2 className="w-5 h-5 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Lista de Contas Conectadas */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {accounts.map(acc => {
          const balData = balances[acc.id];
          const isMaster = acc.role === 'ADMIN' || acc.id === 'acc_master';

          return (
            <div 
              key={acc.id} 
              className={`bg-brand-surface border rounded-2xl p-5 transition-all shadow-md relative ${
                acc.isActive ? 'border-brand-border' : 'border-rose-900/30 opacity-75'
              }`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-white text-base">{acc.name}</span>
                    {isMaster ? (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-bold border border-amber-500/20">
                        MASTER
                      </span>
                    ) : (
                      <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-bold border border-blue-500/20">
                        OPERADOR
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-brand-text/50 mt-0.5">
                    Responsável: <strong className="text-brand-text/80">{acc.ownerName}</strong>
                  </p>
                </div>

                <div className="flex items-center space-x-2">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    acc.isActive ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'
                  }`}>
                    {acc.isActive ? 'Ativa' : 'Pausada'}
                  </span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                    acc.copyTradingEnabled ? 'bg-blue-500/10 text-blue-400' : 'bg-neutral-800 text-neutral-400'
                  }`}>
                    {acc.copyTradingEnabled ? 'Replicando' : 'Individual'}
                  </span>
                </div>
              </div>

              {/* Saldo e Detalhes da Conta */}
              <div className="mt-4 p-3 bg-brand-bg/80 rounded-xl border border-brand-border/60 flex items-center justify-between">
                <div>
                  <span className="text-[10px] uppercase tracking-wider text-brand-text/50 block">Saldo na Bitunix</span>
                  <span className="text-lg font-bold text-emerald-400 font-mono">
                    {balData ? `$${balData.balance.toFixed(2)} USDT` : 'Carregando...'}
                  </span>
                </div>
                <div className="text-right">
                  <span className="text-[10px] uppercase tracking-wider text-brand-text/50 block">Tipo de Conta</span>
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded ${acc.accountType === 'VST' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
                    {acc.accountType === 'VST' ? '🟡 Demo (VST)' : '🟢 Real (USDT)'}
                  </span>
                </div>
              </div>

              {/* Gestão de Risco Individual */}
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                <div className="bg-brand-bg/40 p-2.5 rounded-lg border border-brand-border/40">
                  <span className="text-brand-text/50 block text-[10px]">Gestão de Risco:</span>
                  <span className="font-semibold text-white">
                    {acc.riskMode === 'PERCENT' ? `${acc.riskPercent}% por Trade` : `$${acc.riskFixedUsd} USD Fixo`}
                  </span>
                </div>
                <div className="bg-brand-bg/40 p-2.5 rounded-lg border border-brand-border/40">
                  <span className="text-brand-text/50 block text-[10px]">Telegram Pessoal:</span>
                  <span className="font-semibold text-white truncate block">
                    {acc.telegramChatId ? `ID: ${acc.telegramChatId}` : 'Não configurado'}
                  </span>
                </div>
              </div>

              {/* Ações */}
              <div className="mt-4 pt-3 border-t border-brand-border/40 flex items-center justify-between">
                <div className="text-[11px] text-brand-text/50 font-mono">
                  PIN Operador: <strong className="text-white">{acc.accessPin || '—'}</strong>
                </div>

                <div className="flex items-center space-x-2">
                  <button 
                    onClick={() => {
                      setEditingAccount({ ...acc });
                      setIsEditing(true);
                    }}
                    className="px-2.5 py-1 bg-brand-bg hover:bg-brand-border text-brand-text/80 text-xs font-medium rounded-lg transition-all"
                  >
                    Editar
                  </button>
                  {authenticatedRole === 'ADMIN' && !isMaster && (
                    <button 
                      onClick={() => handleDeleteAccount(acc.id, acc.name)}
                      className="p-1.5 text-rose-400 hover:bg-rose-500/10 rounded-lg transition-all"
                      title="Excluir Conta"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal de Criação / Edição de Conta */}
      {isEditing && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-brand-surface border border-brand-border rounded-2xl w-full max-w-xl p-6 shadow-2xl space-y-4 my-8">
            <div className="flex items-center justify-between border-b border-brand-border/60 pb-3">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <Sliders className="w-5 h-5 text-blue-400" />
                {editingAccount.id ? 'Editar Conta do Operador' : 'Nova Conta de Operador'}
              </h2>
              <button 
                onClick={() => setIsEditing(false)}
                className="text-brand-text/50 hover:text-white text-sm"
              >
                ✕
              </button>
            </div>

            <div className="space-y-4 text-xs md:text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-brand-text/60 block mb-1">Identificação da Conta</label>
                  <input 
                    type="text"
                    value={editingAccount.name || ''}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Ex: Conta Parceiro (Carlos)"
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
                <div>
                  <label className="text-brand-text/60 block mb-1">Nome do Operador</label>
                  <input 
                    type="text"
                    value={editingAccount.ownerName || ''}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, ownerName: e.target.value }))}
                    placeholder="Ex: Carlos"
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-white focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              {/* Chaves Bitunix */}
              <div className="p-3 bg-brand-bg/60 rounded-xl border border-brand-border/60 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-white flex items-center gap-1.5">
                    <Key className="w-4 h-4 text-amber-400" />
                    Credenciais Bitunix do Operador
                  </span>
                  <button 
                    onClick={handleTestBitunix}
                    disabled={testingConnection}
                    className="text-xs text-blue-400 hover:underline flex items-center gap-1"
                  >
                    {testingConnection ? <RefreshCw className="w-3 h-3 animate-spin" /> : "Testar Chaves"}
                  </button>
                </div>

                <div>
                  <label className="text-brand-text/50 block text-[11px] mb-1">API Key</label>
                  <input 
                    type="text"
                    value={editingAccount.apiKey || ''}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, apiKey: e.target.value }))}
                    placeholder="Cole a API Key da Bitunix dele"
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-blue-500"
                  />
                </div>

                <div>
                  <label className="text-brand-text/50 block text-[11px] mb-1">API Secret</label>
                  <div className="relative">
                    <input 
                      type={showSecret ? "text" : "password"}
                      value={editingAccount.apiSecret || ''}
                      onChange={(e) => setEditingAccount(prev => ({ ...prev, apiSecret: e.target.value }))}
                      placeholder="Cole a Secret Key da Bitunix dele"
                      className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-1.5 text-white font-mono text-xs focus:outline-none focus:border-blue-500 pr-9"
                    />
                    <button 
                      type="button"
                      onClick={() => setShowSecret(!showSecret)}
                      className="absolute right-2.5 top-2 text-brand-text/40 hover:text-white"
                    >
                      {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>
              </div>

              {/* Gestão de Risco */}
              <div className="p-3 bg-brand-bg/60 rounded-xl border border-brand-border/60 space-y-3">
                <span className="font-semibold text-white block">
                  Regras de Risco e Margem Desta Conta
                </span>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-brand-text/50 block text-[11px] mb-1">Modo de Risco</label>
                    <select 
                      value={editingAccount.riskMode || 'PERCENT'}
                      onChange={(e: any) => setEditingAccount(prev => ({ ...prev, riskMode: e.target.value }))}
                      className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none"
                    >
                      <option value="PERCENT">Percentual da Banca (%)</option>
                      <option value="FIXED_USD">Valor Fixo (USDT)</option>
                    </select>
                  </div>

                  <div>
                    <label className="text-brand-text/50 block text-[11px] mb-1">
                      {editingAccount.riskMode === 'PERCENT' ? 'Percentual (%)' : 'Valor Fixo ($)'}
                    </label>
                    <input 
                      type="number"
                      step="0.5"
                      value={editingAccount.riskMode === 'PERCENT' ? editingAccount.riskPercent : editingAccount.riskFixedUsd}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        if (editingAccount.riskMode === 'PERCENT') {
                          setEditingAccount(prev => ({ ...prev, riskPercent: val }));
                        } else {
                          setEditingAccount(prev => ({ ...prev, riskFixedUsd: val }));
                        }
                      }}
                      className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-1.5 text-white text-xs focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* Notificações e Acesso */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-brand-text/60 block mb-1">PIN de Acesso Web Restrito</label>
                  <input 
                    type="text"
                    value={editingAccount.accessPin || ''}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, accessPin: e.target.value }))}
                    placeholder="Ex: 5678"
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-[10px] text-brand-text/40">Dê este PIN para o usuário acessar o app</span>
                </div>

                <div>
                  <label className="text-brand-text/60 block mb-1">Chat ID Telegram (Opcional)</label>
                  <input 
                    type="text"
                    value={editingAccount.telegramChatId || ''}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, telegramChatId: e.target.value }))}
                    placeholder="Ex: 123456789"
                    className="w-full bg-brand-bg border border-brand-border rounded-lg px-3 py-2 text-white font-mono focus:outline-none focus:border-blue-500"
                  />
                  <span className="text-[10px] text-brand-text/40">Para receber avisos no Telegram dele</span>
                </div>
              </div>

              {/* Toggles */}
              <div className="flex flex-col sm:flex-row gap-4 pt-2">
                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox"
                    checked={editingAccount.copyTradingEnabled}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, copyTradingEnabled: e.target.checked }))}
                    className="rounded border-brand-border text-blue-600 focus:ring-0"
                  />
                  <span className="text-xs text-white">Replicar Sinais Automaticamente (Copy Trading)</span>
                </label>

                <label className="flex items-center space-x-2 cursor-pointer">
                  <input 
                    type="checkbox"
                    checked={editingAccount.isActive}
                    onChange={(e) => setEditingAccount(prev => ({ ...prev, isActive: e.target.checked }))}
                    className="rounded border-brand-border text-blue-600 focus:ring-0"
                  />
                  <span className="text-xs text-white">Conta Ativa para Operar</span>
                </label>
              </div>
            </div>

            <div className="flex items-center justify-end space-x-3 pt-3 border-t border-brand-border/60">
              <button 
                onClick={() => setIsEditing(false)}
                className="px-4 py-2 bg-brand-bg hover:bg-brand-border text-brand-text text-xs rounded-xl font-medium"
              >
                Cancelar
              </button>
              <button 
                onClick={handleSaveAccount}
                disabled={loading}
                className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl shadow-lg shadow-blue-900/30 flex items-center gap-2"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : "Salvar Configuração"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
