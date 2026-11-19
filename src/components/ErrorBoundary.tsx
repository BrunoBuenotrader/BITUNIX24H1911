import React, { Component, ReactNode, ErrorInfo } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = {
      hasError: false,
      error: null
    };
  }

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught UI error:', error, errorInfo);
  }

  private handleReload = () => {
    window.location.reload();
  };

  public render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#0d1017] text-white flex flex-col items-center justify-center p-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center border border-rose-500/30 mb-4 shadow-xl">
            <AlertTriangle className="w-8 h-8" />
          </div>
          <h1 className="text-xl font-bold mb-2">Ops! Ocorreu uma instabilidade no carregamento</h1>
          <p className="text-sm text-slate-400 max-w-md mb-6 leading-relaxed">
            Detectamos uma instabilidade temporária. Clique no botão abaixo para recarregar o sistema e restaurar a conexão em tempo real.
          </p>
          {this.state.error && (
            <div className="bg-slate-900 border border-slate-800 p-3 rounded-xl text-left text-xs font-mono text-rose-300 max-w-lg mb-6 overflow-auto max-h-32 w-full">
              {this.state.error.toString()}
            </div>
          )}
          <button
            onClick={this.handleReload}
            className="px-6 py-2.5 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-all flex items-center gap-2 shadow-lg shadow-blue-600/30 cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Recarregar Aplicação</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
