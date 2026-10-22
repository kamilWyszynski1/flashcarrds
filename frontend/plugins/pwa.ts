import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Minimal PWA plugin (dependency-free replacement for vite-plugin-pwa):
 *  - emits `manifest.webmanifest` with dynamically resolved `base` path
 *  - after `vite build`, copies `index.html` -> `404.html` for GitHub Pages SPA routing
 *  - writes `sw.js` with a precache list of every file in `dist/` plus content hash
 *
 * Runtime strategy (see sw.template.js):
 *  - navigations          → network first, fall back to cached index.html or base
 *  - hashed build assets  → cache first
 *  - GET /api/*           → network first (8 s), fall back to last cached copy
 *  - Google Fonts         → stale-while-revalidate
 */
export function pwaPlugin(): Plugin {
  let config: ResolvedConfig;

  function getBase(): string {
    const raw = config?.base || '/';
    return raw.endsWith('/') ? raw : raw + '/';
  }

  function createManifest(base: string) {
    return {
      name: 'Fiszki',
      short_name: 'Fiszki',
      description: 'Personal flashcards from your textbook photos',
      lang: 'en',
      id: base,
      start_url: base,
      scope: base,
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f8f9ff',
      theme_color: '#f8f9ff',
      icons: [
        { src: `${base}icons/icon-192.png`, sizes: '192x192', type: 'image/png' },
        { src: `${base}icons/icon-512.png`, sizes: '512x512', type: 'image/png' },
        { src: `${base}icons/maskable-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'Study now', url: `${base}study?scope=all`, icons: [{ src: `${base}icons/icon-192.png`, sizes: '192x192' }] },
        { name: 'Cards from photo', url: `${base}capture`, icons: [{ src: `${base}icons/icon-192.png`, sizes: '192x192' }] },
      ],
    };
  }

  return {
    name: 'fiszki-pwa',
    configResolved(c) {
      config = c;
    },
    generateBundle() {
      const base = getBase();
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify(createManifest(base), null, 2),
      });
    },
    transformIndexHtml(html) {
      const base = getBase();
      return html.replace(
        /href="\/manifest\.webmanifest"/g,
        `href="${base}manifest.webmanifest"`
      );
    },
    configureServer(server) {
      // In dev there is no precache; serve a manifest so "install" still works for testing.
      server.middlewares.use((req, res, next) => {
        const base = getBase();
        if (req.url === '/manifest.webmanifest' || req.url === `${base}manifest.webmanifest`) {
          res.setHeader('content-type', 'application/manifest+json');
          res.end(JSON.stringify(createManifest(base)));
          return;
        }
        if (req.url === '/sw.js' || req.url === `${base}sw.js`) {
          res.setHeader('content-type', 'application/javascript');
          res.end('// dev: no service worker\nself.addEventListener("install", () => self.skipWaiting());');
          return;
        }
        next();
      });
    },
    closeBundle() {
      if (config.command !== 'build') return;
      const base = getBase();
      const outDir = join(config.root, config.build.outDir);

      // Copy dist/index.html to dist/404.html for GitHub Pages SPA routing
      const indexFile = join(outDir, 'index.html');
      const notFoundFile = join(outDir, '404.html');
      if (existsSync(indexFile)) {
        copyFileSync(indexFile, notFoundFile);
      }

      const rawFiles = walk(outDir);
      const precachePaths = rawFiles
        .map((f) => base + relative(outDir, f).split('\\').join('/'))
        .filter((f) => !/\.(map|txt)$/.test(f) && f !== `${base}sw.js`);

      if (!precachePaths.includes(base)) {
        precachePaths.unshift(base);
      }

      const hash = createHash('sha1');
      for (const rf of rawFiles) {
        if (!/\.(map|txt)$/.test(rf) && !rf.endsWith('sw.js')) {
          hash.update(readFileSync(rf));
        }
      }
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync(join(config.root, 'plugins', 'sw.template.js'), 'utf8');
      const sw = template
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(precachePaths))
        .replace('__BASE__', base);
      writeFileSync(join(outDir, 'sw.js'), sw);
      config.logger.info(`[fiszki-pwa] sw.js written (v${version}, ${precachePaths.length} precached files)`);
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
