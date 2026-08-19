// test/package.test.js — 打包白名單防漏檔(靜態)。
//
// 新增執行檔(如 options 頁、i18n.js)卻沒同步 tools/build-release.ps1 的
// $includeFiles 白名單時,zip 會缺檔,導致 Chrome Web Store 的 Linux 自動安
// 裝測試失敗。本測試從 manifest.json 與各 HTML/SW 的實際引用推導「上架 zip
// 必要檔案集合」,再比對 ps1 白名單,漏一個就紅燈——在本地就擋下,不會燒到
// 商店端。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

// 從 build-release.ps1 撈出 $includeFiles 白名單。
function readIncludeFiles() {
  const ps1 = read(path.join('tools', 'build-release.ps1'));
  const match = ps1.match(/\$includeFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(match, 'build-release.ps1 應有 $includeFiles = @(...) 白名單');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

// 從 manifest 與其引用鏈推導 zip 根目錄必要檔案(不含 icons/_locales,
// 那兩個資料夾由 ps1 另行整包處理)。
function collectRequiredFiles() {
  const manifest = JSON.parse(read('manifest.json'));
  const required = new Set(['manifest.json']);

  if (manifest.background && manifest.background.service_worker) {
    required.add(manifest.background.service_worker);
  }
  (manifest.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach((f) => required.add(f));
  });
  if (manifest.action && manifest.action.default_popup) {
    required.add(manifest.action.default_popup);
  }
  if (manifest.options_ui && manifest.options_ui.page) {
    required.add(manifest.options_ui.page);
  }

  // HTML 內以 <script src> 載入的腳本。
  [...required].filter((f) => f.endsWith('.html')).forEach((htmlFile) => {
    const html = read(htmlFile);
    [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].forEach((m) => {
      required.add(m[1]);
    });
  });

  // service worker 以 importScripts 載入的腳本。
  if (manifest.background && manifest.background.service_worker) {
    const sw = read(manifest.background.service_worker);
    [...sw.matchAll(/importScripts\(\s*['"]([^'"]+)['"]\s*\)/g)].forEach((m) => {
      required.add(m[1]);
    });
  }

  return [...required];
}

test('打包白名單:manifest 與引用鏈推導出的必要檔案,一個都不能漏', () => {
  const included = readIncludeFiles();
  const required = collectRequiredFiles();

  const missing = required.filter((f) => !included.includes(f));
  assert.deepEqual(
    missing,
    [],
    `以下檔案被 manifest/HTML/SW 引用,但不在 build-release.ps1 的 $includeFiles 白名單內:${missing.join(', ')}`
  );

  // 反向檢查:白名單裡的每個檔案都真實存在,擋住改名後殘留的舊條目。
  included.forEach((f) => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, f)),
      `白名單條目 ${f} 在 repo 根目錄不存在(改名或刪除後忘了同步白名單?)`
    );
  });
});
