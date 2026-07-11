#!/usr/bin/env node
// Bundles the admin SPA into worker/public (served by the Worker's assets binding).

import { build } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, '..', 'worker', 'public');
mkdirSync(join(out, 'fonts'), { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'app.mjs')],
  bundle: true,
  minify: true,
  format: 'esm',
  target: 'es2022',
  outfile: join(out, 'app.js'),
  logLevel: 'warning',
});

cpSync(join(root, 'index.html'), join(out, 'index.html'));
cpSync(join(root, 'admin.css'), join(out, 'admin.css'));
cpSync(join(root, '..', 'site', 'assets', 'fonts', 'fraunces-var.woff2'), join(out, 'fonts', 'fraunces-var.woff2'));
cpSync(join(root, '..', 'site', 'assets', 'fonts', 'manrope-var.woff2'), join(out, 'fonts', 'manrope-var.woff2'));
console.log('built worker/public (admin SPA)');
