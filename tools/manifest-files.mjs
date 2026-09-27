// tools/manifest-files.mjs — 由 manifest.json 推導上架 zip 的必要檔案清單。
//
// 涵蓋 manifest 直接或間接引用的所有擴充檔案:
//   - manifest.json 本身
//   - background.service_worker 與其 importScripts() 載入的腳本
//   - content_scripts[].js／css
//   - 擴充頁面(action.default_popup、options_ui.page、options_page 等)與頁面
//     內以 <script src>、<link rel="stylesheet" href> 引用的本地檔案
//   - web_accessible_resources[].resources(支援 * 萬用字元)
//   - icons 與 action.default_icon
//   - 宣告 default_locale 時，_locales/*/messages.json
//
// 回傳 repo 根目錄相對路徑(正斜線)、排序後去重。只列「必要」檔案，
// 打包白名單可以多於此清單，不可少於此清單(見 test/package.test.js)。
//
// 命令列用法:node tools/manifest-files.mjs   逐行印出清單

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isLocalRef(ref) {
  return !/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
}

function normalize(ref) {
  return path.posix.normalize(ref.replace(/\\/g, '/').replace(/^\/+/, '').split(/[?#]/)[0]);
}

function listRepoFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk('');
  return out;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function iconPaths(value) {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  return Object.values(value);
}

export function manifestRequiredFiles(root = DEFAULT_ROOT) {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const manifest = JSON.parse(read('manifest.json'));
  const required = new Set(['manifest.json']);
  const add = (ref) => {
    if (typeof ref === 'string' && ref && isLocalRef(ref)) required.add(normalize(ref));
  };

  const sw = manifest.background && manifest.background.service_worker;
  if (sw) {
    add(sw);
    for (const m of read(sw).matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1]);
  }

  for (const cs of manifest.content_scripts || []) {
    (cs.js || []).forEach(add);
    (cs.css || []).forEach(add);
  }

  const pages = [
    manifest.action && manifest.action.default_popup,
    manifest.browser_action && manifest.browser_action.default_popup,
    manifest.options_ui && manifest.options_ui.page,
    manifest.options_page,
    manifest.devtools_page,
    manifest.side_panel && manifest.side_panel.default_path,
    ...Object.values(manifest.chrome_url_overrides || {}),
  ].filter(Boolean);
  for (const page of pages) {
    add(page);
    const html = read(page);
    for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) add(m[1]);
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      if (!/\brel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
      const href = m[0].match(/\bhref\s*=\s*["']([^"']+)["']/i);
      if (href) add(href[1]);
    }
  }

  let repoFiles = null;
  for (const war of manifest.web_accessible_resources || []) {
    const resources = typeof war === 'string' ? [war] : war.resources || [];
    for (const res of resources) {
      if (!/[*?]/.test(res)) {
        add(res);
        continue;
      }
      repoFiles = repoFiles || listRepoFiles(root);
      const re = globToRegExp(normalize(res));
      repoFiles.filter((f) => re.test(f)).forEach(add);
    }
  }

  iconPaths(manifest.icons).forEach(add);
  iconPaths(manifest.action && manifest.action.default_icon).forEach(add);

  if (manifest.default_locale) {
    const localesDir = path.join(root, '_locales');
    for (const entry of fs.readdirSync(localesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) add(`_locales/${entry.name}/messages.json`);
    }
  }

  return [...required].sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  for (const file of manifestRequiredFiles()) console.log(file);
}
