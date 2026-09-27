// test/package.test.js — 打包白名單防漏檔(靜態)。
//
// 上架 zip 的必要檔案由 tools/manifest-files.mjs 從 manifest.json 與其引用鏈
// 推導;tools/build-release.ps1 實際會打包的檔案集合($includeFiles 白名單，
// 加上 icons/ 圖示檔與 _locales/*/messages.json)必須是它的超集。可以多打，
// 不可漏打——漏檔會讓 Chrome Web Store 的自動安裝測試失敗。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

// build-release.ps1 實際打包的檔案集合:$includeFiles、icons/ 底下的
// *.png／*.svg／*.ico、_locales/*/messages.json。規則與 ps1 一致。
function packagedFiles() {
  const files = new Set(readIncludeFiles());
  fs.readdirSync(path.join(REPO_ROOT, 'icons'), { withFileTypes: true })
    .filter((e) => e.isFile() && ['.png', '.svg', '.ico'].includes(path.extname(e.name).toLowerCase()))
    .forEach((e) => files.add(`icons/${e.name}`));
  fs.readdirSync(path.join(REPO_ROOT, '_locales'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(REPO_ROOT, '_locales', e.name, 'messages.json')))
    .forEach((e) => files.add(`_locales/${e.name}/messages.json`));
  return files;
}

async function manifestRequiredFiles() {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'manifest-files.mjs')).href);
  return mod.manifestRequiredFiles(REPO_ROOT);
}

test('打包白名單:打包集合是 manifest 推導出的必要檔案的超集', async () => {
  const packaged = packagedFiles();
  const required = await manifestRequiredFiles();

  const missing = required.filter((f) => !packaged.has(f));
  assert.deepEqual(
    missing,
    [],
    `以下檔案被 manifest 或其引用鏈需要，但 build-release.ps1 不會打包:${missing.join(', ')}`
  );
});

test('manifest-files:推導結果涵蓋 SW importScripts、HTML 腳本、圖示與語系檔', async () => {
  const required = await manifestRequiredFiles();
  ['manifest.json', 'background.js', 'auth.js', 'sync.js', 'options-init.js', 'popup-init.js',
    'icons/icon16.png', '_locales/en/messages.json'].forEach((f) => {
    assert.ok(required.includes(f), `推導清單應含 ${f}`);
  });
});

test('打包白名單:每個條目都真實存在於 repo 根目錄', () => {
  readIncludeFiles().forEach((f) => {
    assert.ok(
      fs.existsSync(path.join(REPO_ROOT, f)),
      `白名單條目 ${f} 在 repo 根目錄不存在(改名或刪除後忘了同步白名單?)`
    );
  });
});

// ---- 固定擴充 ID 與雲端同步的選用權限 ----

test('manifest:key 欄位存在，且推導出的擴充 ID 等於商店版 ID', async () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(typeof manifest.key, 'string');
  assert.ok(manifest.key.length > 0, 'manifest.key 不得為空字串');

  const mod = await import(
    pathToFileURL(path.join(REPO_ROOT, 'tools', 'verify-extension-id.mjs')).href
  );
  assert.equal(mod.extensionIdFromManifest(), mod.EXPECTED_EXTENSION_ID);
});

test('manifest:選用權限恰為 identity 與兩個後端 host', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.optional_permissions, ['identity']);
  assert.deepEqual(manifest.optional_host_permissions, [
    'https://api.metalinkclearer.workers.dev/*',
    'https://api-staging.metalinkclearer.workers.dev/*',
  ]);
});

test('manifest:既有 permissions 與 host_permissions 未被選用權限稀釋', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions, [
    'contextMenus',
    'scripting',
    'notifications',
    'activeTab',
    'storage',
    // D12 的週期同步靠 chrome.alarms，沒宣告權限 chrome.alarms 就是 undefined。
    // alarms 屬非警示型權限，Chrome 更新時不會觸發自動停用(見 test/sync.test.js T5)。
    'alarms',
  ]);
  assert.deepEqual(manifest.host_permissions, [
    'https://*.threads.com/*',
    'https://*.threads.net/*',
  ]);
});

// manifest.json 本身就在 $includeFiles 白名單裡，key 欄位隨檔案進 zip,
// 商店版與 unpacked dev build 因此共用同一個擴充 ID。
test('打包白名單:manifest.json 在白名單內，key 會隨檔案進 zip', () => {
  assert.ok(readIncludeFiles().includes('manifest.json'));
});

test('版本號:manifest.json 與 package.json 一致，避免上架版與 repo 標記的版本號對不上', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
});

// 防止 dev-browser.mjs 為 --env local 注入的 http://localhost:8787/* 這類
// 開發用 host 權限，因 dev-build-loaded 副本被誤當成正式 repo 內容提交或打包
// 進上架 zip——manifest 的 host 權限清單一律不得出現 localhost／127.0.0.1／
// 明文 http://。
test('manifest:host 權限不得含開發用的 localhost／127.0.0.1／http://', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const hostLists = [
    ...(manifest.host_permissions || []),
    ...(manifest.optional_host_permissions || []),
  ];
  hostLists.forEach((host) => {
    assert.doesNotMatch(host, /localhost|127\.0\.0\.1/i, `host 權限混入開發用網域:${host}`);
    assert.doesNotMatch(host, /^http:\/\//i, `host 權限混入明文 http://:${host}`);
  });
});

// ---- scam-guard.js（詐騙串文警示 content script）的登記 ----
//
// scam-guard.js 讀 DOM、掛 tag、對 background 送 scam.hit，屬 ISOLATED world
// 的 content script，必須排在 post-icon.js 之後——它要沿用 post-icon 已建立
// 的樣式／toast 基礎設施，順序倒過來時 post-icon 的 api 還沒掛上。

// ISOLATED world 的 content_scripts 條目（沒有 world 欄位者即為預設的
// ISOLATED），目前就是載入 i18n.js / post-icon.js 的那條 document_idle 條目。
function isolatedContentScript() {
  const manifest = JSON.parse(read('manifest.json'));
  const entries = (manifest.content_scripts || []).filter(
    (cs) => !cs.world || cs.world === 'ISOLATED'
  );
  const entry = entries.find((cs) => (cs.js || []).includes('post-icon.js'));
  assert.ok(entry, 'manifest 應有一條載入 post-icon.js 的 ISOLATED content script');
  return entry;
}

test('manifest:ISOLATED content script 陣列含 scam-guard.js，且排在 post-icon.js 之後', () => {
  const js = isolatedContentScript().js || [];

  assert.ok(js.includes('scam-guard.js'), `ISOLATED 陣列應含 scam-guard.js，實際為:${js.join(', ')}`);
  assert.ok(
    js.indexOf('scam-guard.js') > js.indexOf('post-icon.js'),
    'scam-guard.js 必須排在 post-icon.js 之後'
  );
});

test('打包白名單:scam-guard.js 在 build-release.ps1 的 $includeFiles 內', () => {
  assert.ok(
    readIncludeFiles().includes('scam-guard.js'),
    'scam-guard.js 漏進白名單時，上架 zip 會缺檔，詐騙警示在商店版整個不會動'
  );
});

// ---- ISOLATED content_scripts 的完整載入順序（PM 裁決）----
//
// scam-guard.js 呼叫 TCLCore.detectScamPitch 做話術判定，但 tcl-core.js 原本
// 只由 background 以 importScripts 載入，不在 content_scripts 內——真實頁面上
// TCLCore 會是 undefined。tcl-core.js 因此要一併登記進 ISOLATED 陣列。
//
// 四支的相依方向是單向的：i18n 提供文案字典，tcl-core 提供判定與黑名單純函
// 式，post-icon 建立樣式／toast 基礎設施並匯出 showToast，scam-guard 三者都
// 用。content script 依陣列順序同步執行，排錯順序時後者讀到的是 undefined，
// 因此順序本身就是契約，逐一釘死而不只驗「有沒有」。
//
// tcl-core.js 早已在 build-release.ps1 的 $includeFiles 內（background 需
// 要），這裡不必另外加。
const ISOLATED_JS_ORDER = ['i18n.js', 'tcl-core.js', 'post-icon.js', 'scam-guard.js'];

test('manifest:ISOLATED content script 的 js 陣列恰為 i18n → tcl-core → post-icon → scam-guard', () => {
  assert.deepEqual(
    isolatedContentScript().js || [],
    ISOLATED_JS_ORDER,
    'content script 依陣列順序同步執行，排錯順序時後載入者讀到的相依模組會是 undefined'
  );
});

test('打包白名單:ISOLATED 陣列的每一支都在 build-release.ps1 的 $includeFiles 內', () => {
  const included = readIncludeFiles();
  const missing = ISOLATED_JS_ORDER.filter((file) => !included.includes(file));

  assert.deepEqual(
    missing,
    [],
    `ISOLATED content script 漏進白名單時，上架 zip 會缺檔:${missing.join(', ')}`
  );
});

// 語法基準為 ES2024，對應 Chrome 123;manifest 以 minimum_chrome_version
// 讓商店端在安裝前擋掉不支援的舊版 Chrome。
test('manifest:宣告 minimum_chrome_version，且不低於 123（ES2024 語法基準）', () => {
  const manifest = JSON.parse(read('manifest.json'));

  assert.equal(
    typeof manifest.minimum_chrome_version,
    'string',
    'manifest 應宣告 minimum_chrome_version（字串形式的版本號）'
  );
  const major = Number(String(manifest.minimum_chrome_version).split('.')[0]);
  assert.ok(Number.isFinite(major), 'minimum_chrome_version 的主版號應為數字');
  assert.ok(
    major >= 123,
    '語法基準為 ES2024（Chrome 123），minimum_chrome_version 不得低於 123（目前為 ' +
      manifest.minimum_chrome_version +
      '）'
  );
});
