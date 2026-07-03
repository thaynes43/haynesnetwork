'use client';

// Temporary themed placeholder proving the token seam works end-to-end
// (tokens.css → app.css → ThemeProvider toggle). Replaced by the dashboard
// (DESIGN-004 D-07). Note: no theme-dependent JSX — the button label is fixed
// so first client render matches SSR regardless of the pre-stamped theme.

import { useTheme } from '@hnet/ui';

export default function HomePage() {
  const { current, setTheme } = useTheme();
  return (
    <section className="card">
      <span className="tag">Phase 1</span>
      <h1>haynesnetwork</h1>
      <p>Themed shell placeholder — the dashboard arrives with Phase 1.</p>
      <button
        type="button"
        className="btn"
        onClick={() => setTheme(current === 'hnet-dark' ? 'hnet-light' : 'hnet-dark')}
      >
        Toggle theme
      </button>
    </section>
  );
}
