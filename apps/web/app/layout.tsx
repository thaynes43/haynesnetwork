import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { ThemeProvider } from '@hnet/ui';
import { TRPCProvider } from '@/lib/trpc-provider';
import '@hnet/ui/theme/tokens.css';
import '@hnet/ui/layout/layout.css';
import './app.css';

export const metadata: Metadata = {
  title: 'haynesnetwork',
  description: 'SSO front door for *.haynesnetwork.com',
};

// Pre-hydration theme script (DESIGN-004 D-03): the server renders the dark
// default on <html>; this inline, blocking, dependency-free ES5 script corrects
// it from localStorage ('hnet-theme') or `prefers-color-scheme` BEFORE first
// paint, so there is never a theme flash. It writes `data-theme` exactly once —
// after hydration the ThemeProvider is the single writer (D-02).
const themeInit = `(function(){try{
  var t=localStorage.getItem('hnet-theme');
  if(t!=='hnet-dark'&&t!=='hnet-light'){
    t=window.matchMedia('(prefers-color-scheme: light)').matches?'hnet-light':'hnet-dark';
  }
  document.documentElement.setAttribute('data-theme',t);
}catch(e){document.documentElement.setAttribute('data-theme','hnet-dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme='hnet-dark' is the no-JS/failed-JS SSR fallback;
    // suppressHydrationWarning (on <html> ONLY) keeps React quiet when the
    // script's attribute differs from the server-rendered default (D-03).
    <html lang="en" data-theme="hnet-dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body>
        <ThemeProvider>
          <TRPCProvider>{children}</TRPCProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
