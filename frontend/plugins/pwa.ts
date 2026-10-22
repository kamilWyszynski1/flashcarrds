import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Minimal PWA plugin (dependency-free replacement for vite-plugin-pwa):
 *  - emits `manifest.webmanifest`
 *  - after `vite build`, writes `sw.js` with a precache list of every file in
 *    `dist/` plus a content hash so a new build invalidates the old cache.
 *
 * Runtime strategy (see sw.template.js):
 *  - navigations          → network first, fall back to cached index.html
 *  - hashed build assets  → cache first
 *  - GET /api/*           → network first (8 s), fall back to last cached copy
 *  - Google Fonts         → stale-while-revalidate
 */
export function pwaPlugin(): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'fiszki-pwa',
    configResolved(c) {
      config = c;
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'manifest.webmanifest', source: JSON.stringify(manifest, null, 2) });
    },
    configureServer(server) {
      // In dev there is no precache; serve a manifest so "install" still works for testing.
      server.middlewares.use((req, res, next) => {
        if (req.url === '/manifest.webmanifest') {
          res.setHeader('content-type', 'application/manifest+json');
          res.end(JSON.stringify(manifest));
          return;
        }
        if (req.url === '/sw.js') {
          res.setHeader('content-type', 'application/javascript');
          res.end('// dev: no service worker\nself.addEventListener("install", () => self.skipWaiting());');
          return;
        }
        next();
      });
    },
    closeBundle() {
      if (config.command !== 'build') return;
      const outDir = join(config.root, config.build.outDir);
      const files = walk(outDir)
        .map((f) => '/' + relative(outDir, f).split('\\').join('/'))
        .filter((f) => !/\.(map|txt)$/.test(f) && f !== '/sw.js');
      const hash = createHash('sha1');
      for (const f of files) hash.update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync(join(config.root, 'plugins', 'sw.template.js'), 'utf8');
      const sw = template.replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(files));
      writeFileSync(join(outDir, 'sw.js'), sw);
      config.logger.info(`[fiszki-pwa] sw.js written (v${version}, ${files.length} precached files)`);
    },
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const manifest = {
  name: 'Fiszki',
  short_name: 'Fiszki',
  description: 'Personal flashcards from your textbook photos',
  lang: 'en',
  id: '/',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#f8f9ff',
  theme_color: '#f8f9ff',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: 'Study now', url: '/study?scope=all', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    { name: 'Cards from photo', url: '/capture', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
  ],
};
