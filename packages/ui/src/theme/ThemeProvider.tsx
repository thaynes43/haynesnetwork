'use client';

// Theme context (ADR-005 / DESIGN-004 D-02). Holds the active theme name and
// keeps `<html data-theme>` in sync — switching the attribute re-skins the app
// via the CSS-variable token seam, with no markup change. After hydration the
// provider is the SINGLE writer of `data-theme`; the pre-hydration script in
// the root layout (DESIGN-004 D-03) writes it exactly once before first paint,
// and everything else reads the active name here.
//
// Extended over the demo-console donor (ADR-005 C-03): the initial theme is
// seeded from localStorage ('hnet-theme') when valid, else the pre-stamped
// `<html data-theme>` attribute, else `prefers-color-scheme`, else the dark
// default — and every change persists back to localStorage.

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { DEFAULT_THEME, THEME_STORAGE_KEY, isThemeName, type ThemeName } from './tokenContract';

interface ThemeContextValue {
  current: ThemeName;
  setTheme(name: ThemeName): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Resolve the theme to start from: stored choice → pre-stamped attribute
 *  (the D-03 script) → OS preference → default. On the server (SSR pass of
 *  this client component) there is no document — fall back to the default. */
function initialTheme(): ThemeName {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeName(stored)) return stored;
  } catch {
    /* private mode / storage disabled — fall through */
  }
  const existing = document.documentElement.getAttribute('data-theme');
  if (isThemeName(existing)) return existing;
  if (typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'hnet-light';
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: ReactNode }): ReactElement {
  const [current, setTheme] = useState<ThemeName>(initialTheme);

  // Adopt whatever the pre-hydration script stamped (DESIGN-004 D-03) — covers
  // the SSR pass having seeded DEFAULT_THEME.
  useEffect(() => {
    setTheme(initialTheme());
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', current);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, current);
    } catch {
      /* private mode / storage disabled — theme still applies for the session */
    }
  }, [current]);

  return (
    <ThemeContext.Provider value={{ current, setTheme }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
