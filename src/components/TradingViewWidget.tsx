/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, memo } from 'react';

interface TradingViewWidgetProps {
  symbol?: string;
  theme?: 'dark' | 'light';
  interval?: string;
  timezone?: string;
  style?: string;
  locale?: string;
  toolbar_bg?: string;
  enable_publishing?: boolean;
  allow_symbol_change?: boolean;
  container_id?: string;
}

const TradingViewWidget = ({
  symbol = 'BINANCE:BTCUSDT.P',
  theme = 'dark',
  interval = '15',
  timezone = 'Etc/UTC',
  style = '1',
  locale = 'br',
  toolbar_bg = '#f1f3f6',
  enable_publishing = false,
  allow_symbol_change = true,
  container_id = 'tradingview_chart'
}: TradingViewWidgetProps) => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const initWidget = () => {
      if (container.current && (window as any).TradingView) {
        container.current.innerHTML = `<div id="${container_id}" style="height:100%;width:100%" />`;
        
        // Format symbol for TradingView (handles Bitunix/crypto perp standard, commodities like XAUUSD, indices like SPX)
        let perpetualSymbol = symbol.trim().toUpperCase();
        
        // Mapeamento para TradingView de commodities e índices
        const TV_SPECIAL_MAP: Record<string, string> = {
          'NCCOGOLD2USDUSDT': 'OANDA:XAUUSD',
          'NCCOGOLD2USD': 'OANDA:XAUUSD',
          'GOLD': 'OANDA:XAUUSD',
          'GOLDUSDT': 'OANDA:XAUUSD',
          'XAUUSDT': 'OANDA:XAUUSD',
          'XAUUSD': 'OANDA:XAUUSD',
          'NCCOXAG2USDUSDT': 'OANDA:XAGUSD',
          'NCCOXAG2USD': 'OANDA:XAGUSD',
          'SILVER': 'OANDA:XAGUSD',
          'SILVERUSDT': 'OANDA:XAGUSD',
          'XAGUSDT': 'OANDA:XAGUSD',
          'XAGUSD': 'OANDA:XAGUSD',
          'NCCO1OILWTI2USDUSDT': 'TVC:USOIL',
          'OIL': 'TVC:USOIL',
          'USOIL': 'TVC:USOIL',
          'WTI': 'TVC:USOIL',
          'NCSISP5002USDUSDT': 'INDEX:SPX',
          'SP500': 'INDEX:SPX',
          'US500': 'INDEX:SPX',
          'NCSINASDAQ1002USDUSDT': 'INDEX:NDX',
          'NAS100': 'INDEX:NDX',
          'US100': 'INDEX:NDX',
          'NCSIDOWJONES2USDUSDT': 'INDEX:DJI',
          'US30': 'INDEX:DJI'
        };

        const cleanKey = perpetualSymbol.replace(/^BITUNIX:/, '').replace(/\.P$/, '').replace(/[^A-Z0-9]/g, '');
        if (TV_SPECIAL_MAP[cleanKey]) {
          perpetualSymbol = TV_SPECIAL_MAP[cleanKey];
        } else {
          // Standard crypto perp feed for TradingView widget
          if (perpetualSymbol.startsWith('BITUNIX:')) {
            perpetualSymbol = `BINANCE:${cleanKey}.P`;
          } else if (!perpetualSymbol.includes(':')) {
            perpetualSymbol = `BINANCE:${cleanKey}.P`;
          }
        }

        new (window as any).TradingView.widget({
          autosize: true,
          symbol: perpetualSymbol,
          interval,
          timezone,
          theme,
          style,
          locale,
          toolbar_bg,
          enable_publishing,
          allow_symbol_change,
          container_id,
          studies: [
            {
              id: "MAExp@tv-basicstudies",
              inputs: { length: 9 }
            },
            {
              id: "MASimple@tv-basicstudies",
              inputs: { length: 20 }
            },
            {
              id: "MAExp@tv-basicstudies",
              inputs: { length: 50 }
            },
            {
              id: "MASimple@tv-basicstudies",
              inputs: { length: 200 }
            }
          ],
          studies_overrides: {
            // --- EMA 9 (Green #00FF00) ---
            "moving average exponential.0.plot.color": "#00FF00",
            "moving average exponential.0.ma.color": "#00FF00",
            "moving average exponential.0.color": "#00FF00",

            // --- SMA 20 (Blue #2962FF) ---
            "moving average.0.plot.color": "#2962FF",
            "moving average.0.ma.color": "#2962FF",
            "moving average.0.color": "#2962FF",

            // --- EMA 50 (Purple #A020F0) ---
            "moving average exponential.1.plot.color": "#A020F0",
            "moving average exponential.1.ma.color": "#A020F0",
            "moving average exponential.1.color": "#A020F0",

            // --- SMA 200 (White #FFFFFF) ---
            "moving average.1.plot.color": "#FFFFFF",
            "moving average.1.ma.color": "#FFFFFF",
            "moving average.1.color": "#FFFFFF"
          }
        });
      }
    };

    if ((window as any).TradingView) {
      initWidget();
    } else {
      const existingScript = document.getElementById('tradingview-tv-js');
      if (!existingScript) {
        const script = document.createElement('script');
        script.id = 'tradingview-tv-js';
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = initWidget;
        document.head.appendChild(script);
      } else {
        existingScript.addEventListener('load', initWidget);
      }
    }
  }, [symbol, theme, interval, timezone, style, locale, toolbar_bg, enable_publishing, allow_symbol_change, container_id]);

  return (
    <div className='tradingview-widget-container' ref={container}>
      <div id={container_id} className='h-full w-full' />
    </div>
  );
};

export default memo(TradingViewWidget);
