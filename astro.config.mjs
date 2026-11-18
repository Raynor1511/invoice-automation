// @ts-check
// The demo page (web/) is a static Astro site built into dist/web and served by src/server.
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://invoices.raynors.dev',
  srcDir: './web/src',
  publicDir: './web/public',
  outDir: './dist/web',
  build: { inlineStylesheets: 'auto', assets: '_astro' },
  // No inline scripts, so the page's CSP can be script-src 'self'.
  vite: { build: { assetsInlineLimit: 0 } },
});
