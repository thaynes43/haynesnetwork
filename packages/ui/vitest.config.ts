import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// ADR-018 / DESIGN-008 D-10 — the ported filter/sort engine ships interaction tests
// (@testing-library/react in jsdom); the react plugin + jsdom environment let them run
// verbatim (authorized repo-convention change). css:false stubs the .css import so the
// jsdom transform doesn't choke. The pure modules (chipModel/filterMap/sort) run in the
// same runner unaffected.
export default defineConfig({
  plugins: [react()],
  test: {
    // Default env stays 'node' so the token-contract / node-based tests keep working; the
    // filter COMPONENT tests opt into jsdom via a `// @vitest-environment jsdom` docblock.
    globals: true,
    css: false,
    include: ['__tests__/**/*.test.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
  },
});
