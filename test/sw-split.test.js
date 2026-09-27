// test/sw-split.test.js — background.js 拆檔（SW-3）的結構契約。
//
// background.js 拆成 sw-history.js／sw-device.js／sw-og.js／sw-scam.js 四支
// classic script，由 background.js 頂端以單參數 importScripts 依序載入：
//   i18n → tcl-core → auth → sync → sw-history → sw-device → sw-og → sw-scam → background 本體
// 本檔驗五件事：打包與 manifest 推導（SP1）、腳本邊界（SP2）、頂層載入順序
// （SP3）、功能歸屬（SP4）、validateScamHit 改用 TCLCore 的形狀判準（SP5），
// 另跑幾條代表性行為在逐檔載入下全綠（SP6）。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createChromeStorage } = require('./support/helpers');
const {
  REPO_ROOT,
  readSource,
  importsOf,
  swLoadOrder,
  prepareSandbox,
  loadSwSources,
} = require('./support/sw-sources');

const SW_SPLIT_FILES = ['sw-history.js', 'sw-device.js', 'sw-og.js', 'sw-scam.js'];
const EXPECTED_IMPORT_ORDER = ['i18n.js', 'tcl-core.js', 'auth.js', 'sync.js', ...SW_SPLIT_FILES];

function exists(rel) {
  return fs.existsSync(path.join(REPO_ROOT, rel));
}

// 還沒拆出來的檔案讀成空字串，讓紅燈是一次斷言失敗而不是 ENOENT 炸掉整支測試。
function readIfExists(rel) {
  return exists(rel) ? readSource(rel) : '';
}

// SW 端所有自家腳本（依載入順序，background.js 殿後）。
function swFiles() {
  return [...swLoadOrder(), 'background.js'];
}

// 檔案頂層（第 0 欄）宣告的名稱。classic script 之間共用全域詞法環境，
// 這些名稱在整個 SW 必須唯一。
const TOP_DECL_RE = /^(?:const|let|var|function\*?|async\s+function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
function topLevelNames(src) {
  return [...src.matchAll(TOP_DECL_RE)].map((m) => m[1]);
}

// 取出具名函式的原始碼（到對應的收尾大括號為止）；找不到回 null。
function functionSource(src, name) {
  const m = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm').exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(m.index, i + 1);
  }
  return null;
}

function declares(src, name) {
  return topLevelNames(src).includes(name);
}

// 通用 chrome 替身：storage 用 createChromeStorage（補 remove），其餘 API
// 一律是可呼叫、可任意取屬性的空殼，呼叫回 undefined 的 Promise。只供
// 「載入不炸」類測試使用，不做行為斷言。
function stubChrome(storage) {
  const cache = new Map();
  function stub(pathKey) {
    if (cache.has(pathKey)) return cache.get(pathKey);
    const fn = function () {
      return Promise.resolve(undefined);
    };
    const p = new Proxy(fn, {
      get(target, prop) {
        if (prop === 'then') return undefined;
        if (typeof prop === 'symbol') return target[prop];
        return stub(pathKey + '.' + prop);
      },
      apply() {
        return Promise.resolve(undefined);
      },
    });
    cache.set(pathKey, p);
    return p;
  }
  const s = storage || createChromeStorage({}, {});
  ['local', 'sync'].forEach((area) => {
    if (typeof s.api[area].remove !== 'function') s.api[area].remove = async () => {};
  });
  s.api.session = s.api.session || createChromeStorage({}, {}).api.local;
  if (typeof s.api.session.remove !== 'function') s.api.session.remove = async () => {};
  const root = stub('chrome');
  return new Proxy(
    { storage: s.api, runtime: new Proxy({ id: 'test-extension-id' }, {
      get(target, prop) {
        if (prop in target) return target[prop];
        return stub('chrome.runtime.' + String(prop));
      },
    }) },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return root[prop];
      },
    }
  );
}

// ---------------------------------------------------------------------------
// SP1 manifest／打包
// ---------------------------------------------------------------------------

test('SP1 拆檔：sw-history／sw-device／sw-og／sw-scam 四支檔案存在於 repo 根目錄', () => {
  const missing = SW_SPLIT_FILES.filter((f) => !exists(f));
  assert.deepEqual(missing, [], `缺少拆出的 SW 檔：${missing.join(', ')}`);
});

test('SP1 importScripts：background.js 頂端每支檔案一個單參數呼叫，順序為 i18n → tcl-core → auth → sync → sw-history → sw-device → sw-og → sw-scam', () => {
  const src = readSource('background.js');
  const calls = [...src.matchAll(/importScripts\(([^)]*)\)/g)].map((m) => m[1].trim());
  calls.forEach((arg) => {
    assert.match(
      arg,
      /^['"][^'"]+['"]$/,
      `importScripts 一律單參數（package.test／manifest-files 的正則只認單參數），違規：importScripts(${arg})`
    );
  });
  assert.deepEqual(importsOf('background.js'), EXPECTED_IMPORT_ORDER, 'importScripts 的出現順序即 SW 載入順序');
});

test('SP1 打包白名單：build-release.ps1 的 $includeFiles 含四支 sw-*.js', () => {
  const ps1 = readSource(path.join('tools', 'build-release.ps1'));
  const match = ps1.match(/\$includeFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(match, 'build-release.ps1 應有 $includeFiles = @(...) 白名單');
  const listed = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const missing = SW_SPLIT_FILES.filter((f) => !listed.includes(f));
  assert.deepEqual(missing, [], `白名單漏列：${missing.join(', ')}（漏打包會讓 SW 在商店版 importScripts 失敗）`);
});

test('SP1 manifest-files：從 manifest 推導的必要檔案含四支 sw-*.js', async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'manifest-files.mjs')).href);
  const required = mod.manifestRequiredFiles(REPO_ROOT);
  const missing = SW_SPLIT_FILES.filter((f) => !required.includes(f));
  assert.deepEqual(missing, [], `manifest 推導漏了：${missing.join(', ')}`);
});

test('SP1 dev-browser：重載說明的 importScripts 檔案清單補上四支 sw-*.js', () => {
  const src = readSource(path.join('tools', 'dev-browser.mjs'));
  const missing = SW_SPLIT_FILES.filter((f) => !src.includes(f));
  assert.deepEqual(missing, [], `tools/dev-browser.mjs 的註解清單漏了：${missing.join(', ')}`);
});

// ---------------------------------------------------------------------------
// SP2 載入邊界
// ---------------------------------------------------------------------------

test('SP2 邊界：loadSwSources 逐檔載入含四支 sw-*.js，不得出現重複宣告或頂層 ReferenceError', () => {
  const order = swLoadOrder();
  const missing = SW_SPLIT_FILES.filter((f) => !order.includes(f));
  assert.deepEqual(missing, [], `SW 載入順序缺：${missing.join(', ')}`);
  const sandbox = { chrome: stubChrome() };
  assert.doesNotThrow(() => loadSwSources(sandbox), '逐檔載入失敗代表腳本邊界有衝突（重複宣告／頂層引用後載名稱）');
});

test('SP2 邊界：realSync 模式（auth.js、sync.js 一併進沙箱）逐檔載入同樣不炸', () => {
  const sandbox = { chrome: stubChrome(), fetch: async () => { throw new Error('offline'); } };
  assert.doesNotThrow(() => loadSwSources(sandbox, { realSync: true }));
  assert.equal(typeof sandbox.TCLSync, 'object', '真 sync.js 應把 TCLSync 掛上全域');
});

test('SP2 邊界：SW 所有自家腳本的頂層宣告名稱全域唯一', () => {
  const owner = new Map();
  const dupes = [];
  swFiles().forEach((f) => {
    if (!exists(f)) return;
    topLevelNames(readSource(f)).forEach((name) => {
      if (owner.has(name) && owner.get(name) !== f) dupes.push(`${name}（${owner.get(name)} 與 ${f}）`);
      else owner.set(name, f);
    });
  });
  assert.deepEqual(dupes, [], `classic script 之間重複宣告會 SyntaxError：${dupes.join('；')}`);
});

SW_SPLIT_FILES.forEach((file) => {
  test(`SP2 守衛：${file} 單獨在沒有 importScripts 的沙箱（只預載 i18n、tcl-core）載入不炸`, () => {
    assert.ok(exists(file), `${file} 不存在`);
    const sandbox = prepareSandbox({ chrome: stubChrome() });
    assert.equal(typeof sandbox.importScripts, 'undefined', '前置條件：沙箱沒有 importScripts');
    vm.runInContext(readSource('i18n.js'), sandbox, { filename: 'i18n.js' });
    vm.runInContext(readSource('tcl-core.js'), sandbox, { filename: 'tcl-core.js' });
    assert.doesNotThrow(() => vm.runInContext(readSource(file), sandbox, { filename: file }));
  });
});

// ---------------------------------------------------------------------------
// SP3 頂層載入順序
// ---------------------------------------------------------------------------

// 跨檔共用的全域名稱表：名稱 → 定義檔；consumers 為規格指明的使用檔。
// lateBound：使用檔早於定義檔載入，只准在函式內引用（頂層讀取由下方的攔截測試把關）。
const SHARED_NAMES = [
  { name: 'HISTORY_KEY', provider: 'sw-history.js' },
  // storageAreaAdapter 隨 mutate 搬進 sw-history：mutate 在 sw-history 頂層建立時就要呼叫它，
  // 留在 background.js（最後才載）會在頂層 ReferenceError。
  { name: 'storageAreaAdapter', provider: 'sw-history.js', consumers: ['background.js'] },
  { name: 'storageQueue', provider: 'sw-history.js', consumers: ['sw-device.js'] },
  { name: 'mutate', provider: 'sw-history.js', consumers: ['sw-scam.js'] },
  { name: 'notifySyncRecorded', provider: 'sw-history.js' },
  { name: 'recordHistory', provider: 'sw-history.js', consumers: ['background.js'] },
  { name: 'DEVICE_KEY', provider: 'sw-device.js' },
  { name: 'ensureDevice', provider: 'sw-device.js' },
  { name: 'getLocalDevice', provider: 'sw-device.js', consumers: ['background.js'] },
  { name: 'readLocalDeviceId', provider: 'sw-device.js', consumers: ['sw-scam.js'] },
  { name: 'OG_FETCH_HEADERS', provider: 'sw-og.js', consumers: ['sw-scam.js'] },
  { name: 'OG_SCAN_LIMIT', provider: 'sw-og.js' },
  { name: 'escapeRegExp', provider: 'sw-og.js', consumers: ['sw-scam.js'] },
  { name: 'decodeHtmlEntities', provider: 'sw-og.js', consumers: ['sw-scam.js'] },
  { name: 'syncEngine', provider: 'background.js', consumers: ['sw-history.js'], lateBound: true },
];

test('SP3 共用名稱表：每個跨檔共用名稱只在它的定義檔宣告一次', () => {
  const problems = [];
  SHARED_NAMES.forEach(({ name, provider }) => {
    const declaredIn = swFiles().filter((f) => exists(f) && declares(readSource(f), name));
    if (declaredIn.length !== 1 || declaredIn[0] !== provider) {
      problems.push(`${name}：期望只在 ${provider}，實際 [${declaredIn.join(', ')}]`);
    }
  });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('SP3 共用名稱表：定義檔早於使用檔載入（lateBound 者除外，且使用檔確實引用該名稱）', () => {
  const order = swFiles();
  const problems = [];
  SHARED_NAMES.forEach(({ name, provider, consumers, lateBound }) => {
    (consumers || []).forEach((consumer) => {
      const src = readIfExists(consumer);
      if (!new RegExp(`\\b${name}\\b`).test(src)) problems.push(`${consumer} 未引用 ${name}`);
      const pi = order.indexOf(provider);
      const ci = order.indexOf(consumer);
      if (pi === -1 || ci === -1) problems.push(`${name}：${provider} 或 ${consumer} 不在載入順序內`);
      else if (!lateBound && pi >= ci) problems.push(`${name}：${provider}（#${pi}）不早於 ${consumer}（#${ci}）`);
      else if (lateBound && pi <= ci) problems.push(`${name}：標為 lateBound 但 ${provider} 其實早於 ${consumer}`);
    });
  });
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('SP3 頂層順序：攔截載入期間的全域讀取，任何檔案頂層都不讀後載檔案才宣告的名稱', () => {
  const order = swFiles();
  const missing = SW_SPLIT_FILES.filter((f) => !order.includes(f));
  assert.deepEqual(missing, [], `SW 載入順序缺：${missing.join(', ')}`);

  // 每支檔案頂層宣告的名稱（const／let／var／function／class）。
  const namesOf = new Map(order.map((f) => [f, topLevelNames(readSource(f))]));

  // 攔截法：載入第 i 支之前，把「第 i 支之後才宣告」的每個名稱在沙箱全域物件
  // 掛成可設定的 getter——頂層（含 typeof、try 包住的讀取）一碰就記下來。已
  // 宣告的 const／let 走全域詞法環境，不會經過這些 getter；輪到宣告檔之前先
  // 把 getter 拆掉，宣告本身不受影響。
  const sandbox = prepareSandbox({
    chrome: stubChrome(),
    fetch: async () => {
      throw new Error('offline');
    },
  });
  const violations = [];
  let current = null;
  const armed = new Set();
  order.forEach((file, i) => {
    armed.forEach((name) => {
      delete sandbox[name];
    });
    armed.clear();
    order.slice(i + 1).forEach((later) => {
      namesOf.get(later).forEach((name) => {
        if (name in sandbox) return;
        Object.defineProperty(sandbox, name, {
          configurable: true,
          enumerable: false,
          get() {
            violations.push(`${current} 頂層讀了 ${name}（宣告於後載的 ${later}）`);
            return undefined;
          },
        });
        armed.add(name);
      });
    });
    current = file;
    try {
      vm.runInContext(readSource(file), sandbox, { filename: file });
    } finally {
      current = null;
    }
  });
  armed.forEach((name) => {
    delete sandbox[name];
  });
  assert.deepEqual([...new Set(violations)], [], violations.join('\n'));
});

// ---------------------------------------------------------------------------
// SP4 功能歸屬
// ---------------------------------------------------------------------------

const OWNERSHIP = {
  'sw-history.js': [
    'getSettings',
    'handleCleanedNotice',
    'extractHistoryExtraFields',
    'historyDedupKey',
    'findDedupIndex',
    'adoptFailureEntry',
    'seenEvent',
    'mergeHistoryEntry',
    'applyHistorySchema',
    'notifySyncRecorded',
    'recordHistory',
    'mergeHistoryGroup',
    'migrateHistoryMerge',
    'fillHistorySchema',
    'migrateHistorySchema',
    'HISTORY_KEY',
    'DEFAULT_SETTINGS',
    'storageAreaAdapter',
    'storageQueue',
    'mutate',
    'normalizeHistoryList',
    'HISTORY_MUTATE_OPTS',
  ],
  'sw-device.js': [
    'DEVICE_KEY',
    'localDevicePromise',
    'ensureDevice',
    'detectPlatformOs',
    'getLocalDevice',
    'rememberLocalDeviceName',
    'normalizeDeviceName',
    'handleDevicesList',
    'handleDevicesRename',
    'handleDevicesRemove',
    'readLocalDeviceId',
  ],
  'sw-og.js': [
    'CLEAN_POST_URL_PATTERN',
    'diffRemovedParams',
    'OG_SCAN_LIMIT',
    'OG_FETCH_HEADERS',
    'extractOgFields',
    'mergeOgIntoFields',
    'cacheOgFields',
    'peekOgFields',
    'fetchOgFieldsForLocalKind',
    'handleResolveShareMessage',
    'resolveFinalUrl',
    'extractCleanPostUrl',
  ],
  'sw-scam.js': [
    'SCAM_BLOCKLIST_KEY',
    'SCAM_MUTATE_OPTS',
    'SCAM_FETCH_RATE_MAX',
    'validateScamHit',
    'isScamGuardEnabled',
    'scamThrottleArea',
    'reserveScamFetchSlot',
    'resolveScamAuthorId',
    'handleScamHit',
    'handleScamBlocklistRemove',
    'handleScamBlocklistRestore',
  ],
};

Object.keys(OWNERSHIP).forEach((file) => {
  test(`SP4 歸屬：${file} 宣告其負責的函式與常數，background.js 不再定義它們`, () => {
    const src = readIfExists(file);
    const bg = readSource('background.js');
    const notHere = OWNERSHIP[file].filter((n) => !declares(src, n));
    const stillInBg = OWNERSHIP[file].filter((n) => declares(bg, n));
    assert.deepEqual(notHere, [], `${file} 應宣告：${notHere.join(', ')}`);
    assert.deepEqual(stillInBg, [], `background.js 仍定義：${stillInBg.join(', ')}`);
  });
});

test('SP4 歸屬：background.js 只剩接線——寄件者判斷、路由表、引擎接線、右鍵與通知留在本體', () => {
  const bg = readSource('background.js');
  [
    'isOwnExtensionSender',
    'isExtensionPageSender',
    'isScamContentScriptSender',
    'SCAM_PAGE_ORIGINS',
    'syncEngine',
    'ROUTES',
    'handleShareLinkClick',
    'writeToClipboard',
    'getLocale',
    'notifyByKey',
    'safeNotify',
  ].forEach((n) => assert.ok(declares(bg, n), `background.js 應保留 ${n}`));
});

test('SP4 歸屬：裝置寫入不再搭便車——unsavedDevice 與 persistDevice 從 SW 全部檔案消失', () => {
  swFiles().forEach((f) => {
    if (!exists(f)) return;
    const src = readSource(f);
    ['unsavedDevice', 'persistDevice'].forEach((n) => {
      assert.ok(!new RegExp(`\\b${n}\\b`).test(src), `${f} 仍引用 ${n}`);
    });
  });
  assert.ok(exists('sw-device.js'), 'sw-device.js 不存在');
});

// ---------------------------------------------------------------------------
// SP5 validateScamHit 改用 TCLCore 判準
// ---------------------------------------------------------------------------

test('SP5 validateScamHit：SW 端不再自養 handle／userId 正則（SCAM_HANDLE_PATTERN、SCAM_USER_ID_PATTERN 全數消失）', () => {
  assert.ok(exists('sw-scam.js'), 'sw-scam.js 不存在');
  const offenders = [];
  swFiles()
    .filter((f) => f !== 'i18n.js' && f !== 'tcl-core.js' && f !== 'auth.js' && f !== 'sync.js')
    .forEach((f) => {
      const src = readIfExists(f);
      ['SCAM_HANDLE_PATTERN', 'SCAM_USER_ID_PATTERN'].forEach((n) => {
        if (new RegExp(`\\b${n}\\b`).test(src)) offenders.push(`${f}:${n}`);
      });
    });
  assert.deepEqual(offenders, [], `仍自養正則：${offenders.join(', ')}`);
});

test('SP5 TCLCore：新增匯出 isScamUserId，與伺服器同一把尺（1–20 位數字字串）', () => {
  const TCL = require(path.join(REPO_ROOT, 'tcl-core.js'));
  assert.equal(typeof TCL.isScamUserId, 'function', 'TCLCore 應匯出 isScamUserId');
  ['1', '10000000001', '12345678901234567890'].forEach((v) => assert.equal(TCL.isScamUserId(v), true, v));
  ['', '123456789012345678901', '12a', ' 1', 1, null, undefined, '__proto__'].forEach((v) =>
    assert.equal(TCL.isScamUserId(v), false, String(v))
  );
});

test('SP5 validateScamHit：位於 sw-scam.js，handle 與 userId 改用 TCLCore.isScamMarkHandle／TCLCore.isScamUserId 判定', () => {
  const body = functionSource(readIfExists('sw-scam.js'), 'validateScamHit');
  assert.ok(body, 'sw-scam.js 應定義 validateScamHit');
  assert.match(body, /TCLCore\.isScamMarkHandle\(/, 'handle 形狀改走 TCLCore.isScamMarkHandle');
  assert.match(body, /TCLCore\.isScamUserId\(/, 'userId 形狀改走 TCLCore.isScamUserId');
  assert.doesNotMatch(body, /\/\^[^/]*\/[gimsuy]*\.test\(/, 'validateScamHit 內不得再有正則字面值比對');
});

test('SP5 scam remove／restore：userId 判定同樣改走 TCLCore.isScamUserId', () => {
  const src = readIfExists('sw-scam.js');
  ['handleScamBlocklistRemove', 'handleScamBlocklistRestore'].forEach((n) => {
    const body = functionSource(src, n);
    assert.ok(body, `sw-scam.js 應定義 ${n}`);
    assert.match(body, /TCLCore\.isScamUserId\(/, `${n} 的 userId 判定改走 TCLCore.isScamUserId`);
  });
});

// ---------------------------------------------------------------------------
// SP6 行為零變更（逐檔載入下的代表性回歸）
// ---------------------------------------------------------------------------

const EXT_ID = 'test-extension-id';
const OWN_SENDER = { id: EXT_ID };
const EXT_PAGE_SENDER = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };
const SHARE_URL = 'https://www.threads.com/share/DHuf91XTf/';
const CLEAN_POST_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const NO_OG_HTML = '<html><head></head><body></body></html>';
const LOCAL_DEVICE_ID = '11111111-2222-4333-8444-555555555555';
const SCAM_USER_ID = '10000000001';
const SCAM_HANDLE = 'example_author';
const SCAM_POST_URL = 'https://www.threads.com/@example_author/post/DxSyNtH0001';
const SCAM_TAB_SENDER = { id: EXT_ID, tab: { id: 77, url: SCAM_POST_URL }, url: SCAM_POST_URL };

function deep(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

// 逐檔載入的 background，TCLSync 用 devices 替身。
function loadSplitBackground() {
  const storage = createChromeStorage(
    { saveHistory: true },
    { syncDevice: { deviceId: LOCAL_DEVICE_ID, platform: 'chrome_extension', createdAt: 1700000000000 } }
  );
  storage.api.local.remove = async () => {};
  const listeners = [];
  const engineCalls = [];
  const engine = {};
  ['getState', 'signIn', 'signOut', 'syncNow', 'deleteCloud', 'verifySession', 'notifyRecorded', 'onAlarm'].forEach(
    (n) => {
      engine[n] = (...args) => {
        engineCalls.push(n);
        return Promise.resolve({ status: 'signed_out' });
      };
    }
  );
  engine.listDevices = (...args) => {
    engineCalls.push('listDevices');
    return Promise.resolve({ ok: true, devices: [], currentDeviceId: LOCAL_DEVICE_ID, fetchedAt: 0 });
  };
  engine.renameDevice = () => Promise.resolve({ ok: true });
  engine.removeDevice = () => Promise.resolve({ ok: true });
  const chrome = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => listeners.push(fn) },
      sendMessage: () => Promise.resolve(undefined),
      getPlatformInfo: () => Promise.resolve({ os: 'win' }),
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
    alarms: { create: () => {}, clear: async () => true, onAlarm: { addListener: () => {} } },
    permissions: { contains: (d, cb) => cb(true), request: (d, cb) => cb(true) },
    storage: storage.api,
  };
  const fetchImpl = async (url) => {
    if (url === SHARE_URL) return { url: `${CLEAN_POST_URL}?xmt=AQGabc`, text: async () => NO_OG_HTML };
    return { url, text: async () => NO_OG_HTML };
  };
  const sandbox = {
    chrome,
    fetch: fetchImpl,
    TCLSync: {
      ALARM_NAME: 'tcl-sync',
      DEBOUNCE_MS: 2000,
      SYNC_PERIOD_MINUTES: 5,
      API_BASE_PRODUCTION: 'https://api.metalinkclearer.workers.dev',
      API_BASE_STAGING: 'https://api-staging.metalinkclearer.workers.dev',
      create: () => engine,
    },
  };
  loadSwSources(sandbox);

  function send(message, sender) {
    return new Promise((resolve, reject) => {
      let done = false;
      const timer = setTimeout(() => {
        if (!done) reject(new Error('訊息逾時未回應：' + message.type));
      }, 5000);
      let keepOpen = false;
      listeners.forEach((fn) => {
        if (
          fn(message, sender, (response) => {
            done = true;
            clearTimeout(timer);
            resolve({ responded: true, response });
          }) === true
        ) {
          keepOpen = true;
        }
      });
      if (!keepOpen && !done) {
        done = true;
        clearTimeout(timer);
        resolve({ responded: false });
      }
    });
  }

  async function waitFor(pred, ms = 3000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (pred()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return pred();
  }

  return { sandbox, storage, send, waitFor, engineCalls };
}

test('SP6 回歸 resolveShare：逐檔載入下短連結解析回 ok:true 與乾淨網址', async () => {
  const bg = loadSplitBackground();
  const res = await bg.send({ type: 'resolveShare', url: SHARE_URL }, OWN_SENDER);
  assert.equal(res.responded, true);
  assert.equal(res.response.ok, true);
  assert.equal(res.response.cleanUrl, CLEAN_POST_URL);
});

test('SP6 回歸 recordHistory：逐檔載入下 cleanedNotice 寫入一筆紀錄並帶本機 deviceId', async () => {
  const bg = loadSplitBackground();
  await bg.send({ type: 'cleanedNotice', cleanUrl: CLEAN_POST_URL, kind: 'strip' }, OWN_SENDER);
  const ok = await bg.waitFor(() => {
    const h = bg.storage.localSnapshot().history;
    return Array.isArray(h) && h.length === 1;
  });
  assert.ok(ok, 'history 應寫入一筆');
  const entry = deep(bg.storage.localSnapshot().history[0]);
  assert.equal(entry.url, CLEAN_POST_URL);
  assert.equal(entry.kind, 'strip');
  assert.equal(typeof entry.at, 'number');
  assert.ok(
    JSON.stringify(entry).includes(LOCAL_DEVICE_ID),
    '紀錄的 seen 事件應帶本機 deviceId（sw-history 經 sw-device 取身分）'
  );
});

test('SP6 回歸 scam.hit：逐檔載入下合法命中建立條目，回 added:true', async () => {
  const bg = loadSplitBackground();
  const res = await bg.send(
    {
      type: 'scam.hit',
      userId: SCAM_USER_ID,
      handle: SCAM_HANDLE,
      displayName: 'Example Author',
      postUrl: SCAM_POST_URL,
      snippet: '加我 賴：ex01abc 聊黑馬股',
      anchorMatch: '賴：ex01abc',
      at: 1700000100000,
    },
    SCAM_TAB_SENDER
  );
  assert.equal(res.responded, true, 'scam.hit 必須有人接手');
  const response = deep(res.response);
  assert.equal(response.ok, true);
  assert.equal(response.added, true);
  const list = deep(bg.storage.localSnapshot().scamBlocklist);
  assert.ok(list && list.entries && list.entries[SCAM_USER_ID], '黑名單應有該作者條目');
  assert.equal(list.handleIndex[SCAM_HANDLE], SCAM_USER_ID);
});

test('SP6 回歸 sync.devices.list：逐檔載入下轉呼叫引擎並補 defaultName', async () => {
  const bg = loadSplitBackground();
  const res = await bg.send({ type: 'sync.devices.list' }, EXT_PAGE_SENDER);
  assert.equal(res.responded, true);
  const response = deep(res.response);
  assert.equal(response.ok, true);
  assert.equal(response.currentDeviceId, LOCAL_DEVICE_ID);
  assert.equal(typeof response.defaultName, 'string', 'list 成功回應補頂層 defaultName');
  assert.ok(bg.engineCalls.includes('listDevices'));
});
