#!/usr/bin/env node
// Bakes site/content/content.json into site/template.html -> site/index.html.
// Runs locally and in the Pages deploy workflow. Content strings are HTML-escaped;
// structured fragments (about paragraphs, service cards, footer links) are
// rendered here so the template stays plain HTML.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DEFAULT_CONTENT } from '../shared/default-content.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const contentPath = join(root, 'content', 'content.json');
const content = existsSync(contentPath)
  ? deepMerge(structuredClone(DEFAULT_CONTENT), JSON.parse(readFileSync(contentPath, 'utf8')))
  : structuredClone(DEFAULT_CONTENT);

const API_BASE = process.env.API_BASE || 'https://api.seanhase.ca';
const BUILD_VERSION = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : String(Math.floor(Date.now() / 1000));

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const ICONS = [
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21c-4 0-7-3-7-7 0-5 7-11 7-11s7 6 7 11c0 4-3 7-7 7z"/></svg>',
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12h4l3-8 4 16 3-8h6"/></svg>',
  '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>',
];

function aboutBodyHtml(body) {
  return String(body || '').split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('\n');
}

function servicesItemsHtml(items) {
  return (items || []).map((it, i) => `
      <div class="card reveal">
        <div class="card-icon">${ICONS[i % ICONS.length]}</div>
        <h3>${esc(it.title)}</h3>
        <p>${esc(it.desc)}</p>
        ${it.detail ? `<span class="detail">${esc(it.detail)}</span>` : ''}
      </div>`).join('\n');
}

function footerLinksHtml(footer) {
  const links = [];
  if (footer.instagram) {
    const handle = String(footer.instagram).replace(/^@/, '');
    links.push(`<a href="https://instagram.com/${esc(handle)}" target="_blank" rel="noopener">@${esc(handle)}</a>`);
  }
  if (footer.email) links.push(`<a href="mailto:${esc(footer.email)}">${esc(footer.email)}</a>`);
  return links.length ? `<p>${links.join(' · ')}</p>` : '';
}

let html = readFileSync(join(root, 'template.html'), 'utf8');

const fragments = {
  about_body_html: aboutBodyHtml(content.about.body),
  services_items_html: servicesItemsHtml(content.services.items),
  footer_links_html: footerLinksHtml(content.footer),
  api_base: API_BASE,
  build_version: BUILD_VERSION,
};

html = html.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (m, key) => {
  if (key in fragments) return fragments[key];
  const val = key.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), content);
  if (val === undefined) {
    console.error(`build: unknown token {{${key}}}`);
    process.exitCode = 1;
    return '';
  }
  return esc(val);
});

writeFileSync(join(root, 'index.html'), html);
console.log(`built site/index.html (api=${API_BASE}, v=${BUILD_VERSION})`);

function deepMerge(base, over) {
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      deepMerge(base[k], v);
    } else {
      base[k] = v;
    }
  }
  return base;
}
