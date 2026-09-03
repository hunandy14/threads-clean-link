// test/dev-browser.test.js — tools/dev-browser.mjs 的純函式契約。
//
// dev-browser.mjs 是 ESM，主流程(啟動真正的 Chrome、CDP 連線)只在
// `import.meta.url === 直接執行的檔案` 時跑，import 進來不會有任何副作用。
// 本檔只測可 import 的純函式:
//   - parseArgs:三個環境、缺/未知 --env 報錯、
//     --yes/--fresh/--restart/--no-open 解析、同一旗標重複出現時後者覆蓋前者
//   - productionGuard:TTY/非 TTY、--yes、輸入相符/不符
//   - withHostPermission／loadedBuildDirFor／samePath:--env local 的
//     manifest 副本注入是純函式(冪等、不動 key 與既有 host)
//   - syncLoadedBuild:在暫存目錄實跑一次副本同步(排除 .git、重跑不殘留、
//     只有 local 會多一項 host、其餘環境與 dev-build 逐字相同)
//   - probeHealth:本機後端探活的失敗路徑一律回 false
//   - reloadExtension:載入後強制重載擴充，清掉 SW 的舊腳本快取;喚醒分頁
//     用完即關
//   - sendCdpCommand:逾時會 reject，不永遠掛住
//   - configureApiEnvAndCleanup:喚醒 SW 用的暫時分頁，--no-open 時要關掉、
//     --open 時要沿用成 options 頁而非開兩個(用 mock CDP transport 斷言，
//     不需要真 Chrome)
//   - configureApiEnv:剛喚醒的 SW 在 CDP 裡處於暫停狀態(真實環境驗證發現
//     的 bug，不送 Runtime.runIfWaitingForDebugger 就會卡死)要先解除暫停;
//     失敗路徑(如逾時)也要把喚醒分頁關掉，不能只有成功路徑會清;切換環境
//     時要在寫入新 apiBase 之前清掉舊環境的登入與同步狀態
// 另外靜態檢查 package.json 的 scripts 清單，以及沿用 test/package.test.js
// 既有邏輯確認打包白名單不誤收 docs/、test/、package.json。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REPO_ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

let devBrowser;

test.before(async () => {
  devBrowser = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'dev-browser.mjs')).href);
});

// ---- parseArgs ----

test('parseArgs:三個環境各自可解析', () => {
  for (const env of ['local', 'staging', 'production']) {
    const opts = devBrowser.parseArgs(['--env', env]);
    assert.equal(opts.env, env);
    assert.equal(opts.help, false);
  }
});

test('parseArgs:缺 --env 報錯', () => {
  assert.throws(() => devBrowser.parseArgs([]), /--env/);
});

test('parseArgs:--env 未知值報錯', () => {
  assert.throws(() => devBrowser.parseArgs(['--env', 'prod']), /--env/);
});

test('parseArgs:--help 不需要 --env 也能解析', () => {
  const opts = devBrowser.parseArgs(['--help']);
  assert.equal(opts.help, true);
  const opts2 = devBrowser.parseArgs(['-h']);
  assert.equal(opts2.help, true);
});

test('parseArgs:--yes、--fresh、--restart、--no-open 解析為 true/false', () => {
  const opts = devBrowser.parseArgs([
    '--env',
    'production',
    '--yes',
    '--fresh',
    '--restart',
    '--no-open',
  ]);
  assert.equal(opts.yes, true);
  assert.equal(opts.fresh, true);
  assert.equal(opts.restart, true);
  assert.equal(opts.open, false);

  const defaults = devBrowser.parseArgs(['--env', 'staging']);
  assert.equal(defaults.yes, false);
  assert.equal(defaults.fresh, false);
  assert.equal(defaults.restart, false);
  assert.equal(defaults.open, true);
});

test('parseArgs:同一旗標重複出現時，後者覆蓋前者(對應 npm run dev -- --env production)', () => {
  const opts = devBrowser.parseArgs(['--env', 'local', '--env', 'production']);
  assert.equal(opts.env, 'production');

  const portOpts = devBrowser.parseArgs(['--port', '9222', '--port', '9333', '--env', 'staging']);
  assert.equal(portOpts.port, 9333);
});

test('parseArgs:--port 非正整數報錯', () => {
  assert.throws(() => devBrowser.parseArgs(['--env', 'staging', '--port', 'abc']));
  assert.throws(() => devBrowser.parseArgs(['--env', 'staging', '--port', '-1']));
});

test('parseArgs:不明旗標報錯', () => {
  assert.throws(() => devBrowser.parseArgs(['--env', 'staging', '--nope']));
});

// ---- productionGuard ----

test('productionGuard:非 production 環境一律通過，不呼叫 readLine', async () => {
  let called = false;
  const result = await devBrowser.productionGuard({
    env: 'staging',
    yes: false,
    isTTY: false,
    readLine: async () => {
      called = true;
      return '';
    },
  });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

test('productionGuard:非 TTY 且無 --yes → 拒絕', async () => {
  const result = await devBrowser.productionGuard({
    env: 'production',
    yes: false,
    isTTY: false,
    readLine: async () => 'production',
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
});

test('productionGuard:TTY 輸入 "production" → 通過', async () => {
  const result = await devBrowser.productionGuard({
    env: 'production',
    yes: false,
    isTTY: true,
    readLine: async () => 'production',
  });
  assert.equal(result.ok, true);
});

test('productionGuard:TTY 輸入 "prod" → 拒絕', async () => {
  const result = await devBrowser.productionGuard({
    env: 'production',
    yes: false,
    isTTY: true,
    readLine: async () => 'prod',
  });
  assert.equal(result.ok, false);
});

test('productionGuard:TTY 輸入空字串 → 拒絕', async () => {
  const result = await devBrowser.productionGuard({
    env: 'production',
    yes: false,
    isTTY: true,
    readLine: async () => '',
  });
  assert.equal(result.ok, false);
});

test('productionGuard:--yes → 通過，且不呼叫 readLine', async () => {
  let called = false;
  const result = await devBrowser.productionGuard({
    env: 'production',
    yes: true,
    isTTY: true,
    readLine: async () => {
      called = true;
      return 'production';
    },
  });
  assert.equal(result.ok, true);
  assert.equal(called, false);
});

// ---- local:manifest 副本注入(純函式) ----

test('withHostPermission:追加 host 權限，key 與既有 host 原樣保留', () => {
  const manifest = {
    key: 'FAKE-KEY',
    optional_host_permissions: [
      'https://api.metalinkclearer.workers.dev/*',
      'https://api-staging.metalinkclearer.workers.dev/*',
    ],
  };
  const out = devBrowser.withHostPermission(manifest, devBrowser.LOCAL_HOST_PERMISSION);

  assert.equal(out.key, 'FAKE-KEY', 'key 動到就等於換一個擴充 ID');
  assert.deepEqual(out.optional_host_permissions, [
    'https://api.metalinkclearer.workers.dev/*',
    'https://api-staging.metalinkclearer.workers.dev/*',
    'http://localhost:8787/*',
  ]);
  assert.deepEqual(
    manifest.optional_host_permissions,
    [
      'https://api.metalinkclearer.workers.dev/*',
      'https://api-staging.metalinkclearer.workers.dev/*',
    ],
    '純函式:輸入的 manifest 不得被就地改動'
  );
});

test('withHostPermission:冪等，重複套用不會出現兩份同樣的 host', () => {
  const manifest = { key: 'FAKE-KEY', optional_host_permissions: [] };
  const once = devBrowser.withHostPermission(manifest, devBrowser.LOCAL_HOST_PERMISSION);
  const twice = devBrowser.withHostPermission(once, devBrowser.LOCAL_HOST_PERMISSION);
  assert.deepEqual(twice, once);
  assert.deepEqual(twice.optional_host_permissions, ['http://localhost:8787/*']);
});

test('withHostPermission:manifest 沒有 optional_host_permissions 也能注入', () => {
  const out = devBrowser.withHostPermission({ key: 'K' }, devBrowser.LOCAL_HOST_PERMISSION);
  assert.deepEqual(out.optional_host_permissions, ['http://localhost:8787/*']);
  assert.equal(out.key, 'K');
});

test('loadedBuildDirFor:副本與 dev-build 同層，名字加 -loaded 後綴', () => {
  const out = devBrowser.loadedBuildDirFor(path.join('C:', 'x', 'dev-build'));
  assert.equal(path.basename(out), 'dev-build-loaded');
  assert.equal(path.dirname(out), path.join('C:', 'x'));

  const trailing = devBrowser.loadedBuildDirFor(path.join('C:', 'x', 'dev-build') + path.sep);
  assert.equal(path.basename(trailing), 'dev-build-loaded', '尾隨分隔符不該讓 basename 落空');
});

// ---- syncLoadedBuild:在暫存目錄實跑，不碰使用者的 dev-build ----

function makeFakeBuild() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tcl-dev-browser-'));
  const build = path.join(root, 'dev-build');
  fs.mkdirSync(path.join(build, 'icons'), { recursive: true });
  fs.mkdirSync(path.join(build, '.git'), { recursive: true });
  fs.writeFileSync(path.join(build, '.git', 'HEAD'), 'ref: refs/heads/x');
  fs.writeFileSync(path.join(build, 'icons', 'icon16.png'), 'png');
  fs.writeFileSync(path.join(build, 'sync.js'), '// sync');
  fs.writeFileSync(
    path.join(build, 'manifest.json'),
    JSON.stringify(
      {
        key: 'FAKE-KEY',
        manifest_version: 3,
        optional_permissions: ['identity'],
        optional_host_permissions: [
          'https://api.metalinkclearer.workers.dev/*',
          'https://api-staging.metalinkclearer.workers.dev/*',
        ],
      },
      null,
      2
    )
  );
  return { root, build, loaded: devBrowser.loadedBuildDirFor(build) };
}

test('syncLoadedBuild:整包複製但排除 .git，重跑不殘留 dev-build 已刪掉的檔案', (t) => {
  const { root, build, loaded } = makeFakeBuild();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  devBrowser.syncLoadedBuild(build, loaded);
  assert.ok(fs.existsSync(path.join(loaded, 'sync.js')));
  assert.ok(fs.existsSync(path.join(loaded, 'icons', 'icon16.png')));
  assert.ok(
    !fs.existsSync(path.join(loaded, '.git')),
    '.git 是 worktree 中繼資料，複製過去會讓副本被當成另一個 worktree'
  );

  // dev-build 刪掉一個檔案後重跑:副本裡也該跟著消失。
  fs.rmSync(path.join(build, 'sync.js'));
  devBrowser.syncLoadedBuild(build, loaded);
  assert.ok(!fs.existsSync(path.join(loaded, 'sync.js')), '副本每次重建，不留上一輪的殘骸');
});

test('syncLoadedBuild:非 local 時副本 manifest 與 dev-build 的逐字相同', (t) => {
  const { root, build, loaded } = makeFakeBuild();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  devBrowser.syncLoadedBuild(build, loaded);
  assert.equal(
    fs.readFileSync(path.join(loaded, 'manifest.json'), 'utf8'),
    fs.readFileSync(path.join(build, 'manifest.json'), 'utf8'),
    'staging／production 不該讓副本的 manifest 與 dev-build 有任何差異'
  );
});

test('syncLoadedBuild:local 時副本與 dev-build 的差異恰好只有那一項 host', (t) => {
  const { root, build, loaded } = makeFakeBuild();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  devBrowser.syncLoadedBuild(build, loaded, devBrowser.LOCAL_HOST_PERMISSION);
  const before = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json'), 'utf8'));
  const after = JSON.parse(fs.readFileSync(path.join(loaded, 'manifest.json'), 'utf8'));

  assert.equal(after.key, before.key, 'key 逐字相同，否則擴充 ID 會變');
  assert.deepEqual(Object.keys(after), Object.keys(before), '不該多出或少掉任何頂層欄位');
  assert.deepEqual(after.optional_host_permissions, [
    ...before.optional_host_permissions,
    devBrowser.LOCAL_HOST_PERMISSION,
  ]);

  // 逐欄位比對:除了 optional_host_permissions 之外，一個字都不能動。
  for (const key of Object.keys(before)) {
    if (key === 'optional_host_permissions') continue;
    assert.deepEqual(after[key], before[key], `${key} 不該被副本改動`);
  }
});

test('syncLoadedBuild:副本路徑不是 dev-build 的兄弟目錄時拒絕執行，不遞迴刪除', (t) => {
  const { root, build } = makeFakeBuild();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  // rmSync 是這支腳本唯一會刪東西的地方，路徑傳錯的後果無法挽回。
  assert.throws(() => devBrowser.syncLoadedBuild(build, path.join(root, 'sub', 'x')), /同層/);
  assert.throws(() => devBrowser.syncLoadedBuild(build, build), /不得等於/);
  assert.ok(fs.existsSync(path.join(build, 'manifest.json')), '拒絕的路徑不得刪到任何東西');
});

test('samePath:大小寫與尾隨分隔符的差異不算換路徑;缺值一律視為不同', () => {
  const base = path.resolve(path.join('C:', 'x', 'dev-build'));
  assert.equal(devBrowser.samePath(base, base.toUpperCase()), true);
  assert.equal(devBrowser.samePath(base, base + path.sep), true);
  assert.equal(devBrowser.samePath(base, base + '-local'), false);
  assert.equal(devBrowser.samePath(null, base), false);
});

// ---- local:本機後端探活 ----

test('probeHealth:200 回 true;非 2xx、連線失敗一律回 false，不丟例外', async () => {
  const saved = global.fetch;
  try {
    const seen = [];
    global.fetch = async (url) => {
      seen.push(url);
      return { ok: true };
    };
    assert.equal(await devBrowser.probeHealth('http://localhost:8787'), true);
    assert.deepEqual(seen, ['http://localhost:8787/health']);

    global.fetch = async () => ({ ok: false, status: 503 });
    assert.equal(await devBrowser.probeHealth('http://localhost:8787'), false);

    global.fetch = async () => {
      throw new Error('ECONNREFUSED');
    };
    assert.equal(
      await devBrowser.probeHealth('http://localhost:8787'),
      false,
      '後端沒起來時要安靜回 false，讓呼叫端印啟動指令，而不是往上炸'
    );
  } finally {
    global.fetch = saved;
  }
});

// ---- package.json scripts ----

test('package.json:scripts 恰為 test/dev/dev:staging/verify-id 四個', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.deepEqual(Object.keys(pkg.scripts).sort(), ['dev', 'dev:staging', 'test', 'verify-id'].sort());
  assert.equal(pkg.scripts['test'], 'node --test test/*.test.js');
  assert.equal(pkg.scripts['dev'], 'node tools/dev-browser.mjs --env local');
  assert.equal(pkg.scripts['dev:staging'], 'node tools/dev-browser.mjs --env staging');
  assert.equal(pkg.scripts['verify-id'], 'node tools/verify-extension-id.mjs');
  assert.equal(pkg.scripts['dev:prod'], undefined);
});

// ---- 打包白名單不誤收 docs/、test/、package.json ----
// 沿用 test/package.test.js 既有的 $includeFiles 抽取邏輯，這裡只額外斷言
// 三個一律不該進 zip 的路徑沒有被收進去。

function readIncludeFiles() {
  const ps1 = read(path.join('tools', 'build-release.ps1'));
  const match = ps1.match(/\$includeFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(match, 'build-release.ps1 應有 $includeFiles = @(...) 白名單');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('打包白名單:不收 docs/、test/、package.json', () => {
  const included = readIncludeFiles();
  assert.ok(!included.includes('package.json'));
  assert.ok(!included.some((f) => f.startsWith('docs/')));
  assert.ok(!included.some((f) => f.startsWith('test/')));
});

// ---- mock CDP transport(給 configureApiEnvAndCleanup / sendCdpCommand 用) ----
//
// dev-browser.mjs 對 CDP 只透過全域 fetch(HTTP 端:/json、/json/version、
// /json/new)與全域 WebSocket(每個 target 自己的 debugger endpoint)溝通，
// 兩者都是呼叫當下才查找的全域，不是 import 時就綁死——測試可以整個蓋掉，
// 不需要真 Chrome。

function createMockCdp({
  port,
  extensionId,
  currentApiBase = null,
  wakeSw = true,
  apiBaseReadable = true,
  deadSwConnections = 0,
}) {
  const browserWsUrl = `ws://mock-browser:${port}`;
  const swWsUrl = `ws://mock-sw:${port}`;
  let targets = [];
  let nextWakeId = 1;
  let newTargetCalls = 0;
  const closedTargetIds = [];
  // 側錄送進 SW 的每一段 Runtime.evaluate 原文:切換環境的清鍵動作沒有其他
  // 可觀測的外部效果，只能從送出的指令序列驗。
  const evaluated = [];
  // 真實 Chrome 對「剛啟動」的 service worker 會暫停等除錯器接手，直到收到
  // Runtime.runIfWaitingForDebugger 才會處理其他指令(含 Runtime.evaluate)；
  // 這裡用一個旗標模擬同一份行為，讓測試能重現「不送這道指令就永遠卡住」。
  let swPaused = false;

  function swTarget() {
    return {
      id: 'sw-1',
      type: 'service_worker',
      url: `chrome-extension://${extensionId}/background.js`,
      webSocketDebuggerUrl: swWsUrl,
    };
  }

  class MockWebSocket {
    constructor(wsUrl) {
      this.url = wsUrl;
      this.listeners = {};
      // deadSwConnections:模擬「/json 清單裡還留著剛被終止的 SW target」,
      // 連上去當場被切斷。真實 Chrome 隨後會換上新的 target，這裡用消耗
      // 計數器等價表現。
      if (wsUrl === swWsUrl && deadSwConnections > 0) {
        deadSwConnections -= 1;
        queueMicrotask(() => this._emit('close'));
        return;
      }
      queueMicrotask(() => this._emit('open'));
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    send(raw) {
      const msg = JSON.parse(raw);

      if (this.url === swWsUrl) {
        if (msg.method === 'Runtime.runIfWaitingForDebugger') {
          swPaused = false;
          queueMicrotask(() =>
            this._emit('message', { data: JSON.stringify({ id: msg.id, result: {} }) })
          );
          return;
        }
        if (swPaused) {
          // 暫停狀態下，其他指令(尤其 Runtime.evaluate)一律不回覆——這正是
          // 真實 Chrome 卡住的行為，靠呼叫端先解除暫停才不會撞上。
          return;
        }
      }

      let result = {};
      if (msg.method === 'Runtime.evaluate') {
        evaluated.push(msg.params.expression);
        // 真實 Chrome 收到 chrome.runtime.reload() 會當場終止這個 SW，
        // 它的 target 隨即從 /json 清單消失;呼叫端要等的正是這一刻。
        if (msg.params.expression.includes('chrome.runtime.reload()')) {
          targets = targets.filter((t) => t.type !== 'service_worker');
        }
        // 讀「目前的 syncApiBase」那一段:回傳測試設定的值，模擬擴充現在
        // 指向哪個環境。
        // apiBaseReadable = false 模擬「回傳形狀不對」:CDP 回了，但沒有
        // 可用的 result.value，呼叫端讀不出目前指向哪個環境。
        if (msg.params.expression.includes('got.syncApiBase') && apiBaseReadable) {
          result = { result: { type: 'string', value: currentApiBase } };
        }
      }
      if (msg.method === 'Target.closeTarget') {
        const targetId = msg.params.targetId;
        closedTargetIds.push(targetId);
        targets = targets.filter((t) => t.id !== targetId);
        result = { success: true };
      }
      // Runtime.evaluate 等其他 method 一律回空 result，測試不關心其回傳值。
      queueMicrotask(() =>
        this._emit('message', { data: JSON.stringify({ id: msg.id, result }) })
      );
    }
    close() {}
    _emit(type, evt = {}) {
      (this.listeners[type] || []).forEach((fn) => fn(evt));
    }
  }

  async function fetchImpl(url) {
    const u = new URL(url);
    if (u.pathname === '/json/version') {
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: browserWsUrl }) };
    }
    if (u.pathname === '/json/new') {
      newTargetCalls++;
      const id = `wake-${nextWakeId++}`;
      const target = {
        id,
        type: 'page',
        url: decodeURIComponent(u.search.slice(1)),
        webSocketDebuggerUrl: `ws://mock-page:${id}`,
      };
      targets.push(target);
      // mock 簡化:喚醒分頁一開就視為 SW 隨即上線(剛啟動、處於暫停狀態)，
      // 不模擬真正的載入延遲(真實流程裡 wakeServiceWorker 本來就是輪詢等它
      // 出現)。
      if (wakeSw && !targets.some((t) => t.type === 'service_worker')) {
        targets.push(swTarget());
        swPaused = true;
      }
      return { ok: true, json: async () => target };
    }
    if (u.pathname === '/json') {
      return { ok: true, json: async () => targets };
    }
    throw new Error(`mock fetch 未處理的路徑:${u.pathname}`);
  }

  return {
    fetchImpl,
    WebSocketImpl: MockWebSocket,
    closedTargetIds,
    evaluated,
    get newTargetCalls() {
      return newTargetCalls;
    },
    get targets() {
      return targets;
    },
    get swPaused() {
      return swPaused;
    },
  };
}

let originalFetch;
let originalWebSocket;

test.beforeEach(() => {
  originalFetch = global.fetch;
  originalWebSocket = global.WebSocket;
});

test.afterEach(() => {
  global.fetch = originalFetch;
  global.WebSocket = originalWebSocket;
});

test('configureApiEnvAndCleanup:--no-open 時，喚醒 SW 用的暫時分頁要關掉(回歸:曾經只喚醒不關閉)', async () => {
  const port = 9401;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnvAndCleanup(port, extensionId, 'staging', false);

  assert.equal(mock.closedTargetIds.length, 1, '應該關閉恰好一個 target');
  assert.equal(mock.closedTargetIds[0], 'wake-1', '關閉的應是喚醒用的暫時分頁');
  assert.ok(
    !mock.targets.some((t) => t.id === 'wake-1'),
    '關閉後 /json 清單裡不該再看到喚醒用的暫時分頁'
  );
});

test('configureApiEnvAndCleanup:open 時，沿用喚醒分頁當 options 頁，不重開第二個', async () => {
  const port = 9402;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnvAndCleanup(port, extensionId, 'staging', true);

  assert.equal(mock.closedTargetIds.length, 0, 'open 時不該關閉喚醒用的分頁');
  assert.equal(
    mock.newTargetCalls,
    1,
    'openOptionsPage 應偵測到既有分頁，不再呼叫 /json/new 開第二個'
  );
});

test('configureApiEnv:剛喚醒的 SW 處於 CDP 暫停狀態時，會先解除暫停再 evaluate，不會卡住(現場驗證發現的真實 bug)', async () => {
  const port = 9403;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  const wakeTargetId = await devBrowser.configureApiEnv(port, extensionId, 'staging');

  assert.equal(wakeTargetId, 'wake-1', 'SW 原本未上線，這次呼叫應該喚醒過一個暫時分頁');
  assert.equal(mock.swPaused, false, 'configureApiEnv 完成時，SW 的暫停狀態應該已經解除');
});

test('configureApiEnv:失敗時(例如 Runtime.evaluate 逾時)也要把喚醒用的暫時分頁關掉，不留下垃圾分頁', async () => {
  const port = 9404;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId });
  // 讓 SW 永遠回不了任何指令(不只是暫停)，模擬 Runtime.evaluate 逾時失敗。
  const originalSend = mock.WebSocketImpl.prototype.send;
  mock.WebSocketImpl.prototype.send = function stuckSend(raw) {
    const msg = JSON.parse(raw);
    if (this.url === `ws://mock-sw:${port}` && msg.method !== 'Target.closeTarget') return;
    return originalSend.call(this, raw);
  };
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await assert.rejects(() => devBrowser.configureApiEnv(port, extensionId, 'staging', 50));

  assert.deepEqual(
    mock.closedTargetIds,
    ['wake-1'],
    '失敗路徑也要恰好關掉那一個喚醒用的暫時分頁'
  );
  assert.ok(
    !mock.targets.some((t) => t.id === 'wake-1'),
    '關閉後 /json 清單裡不該再看到喚醒用的暫時分頁'
  );
});

test('configureApiEnv:SW 始終不上線(wakeServiceWorker 自己逾時)時，也要關掉喚醒分頁', async () => {
  const port = 9408;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId, wakeSw: false });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await assert.rejects(() => devBrowser.configureApiEnv(port, extensionId, 'staging'), /逾時/);

  assert.deepEqual(
    mock.closedTargetIds,
    ['wake-1'],
    '等待 SW 上線逾時是最常見的失敗;分頁是這一步開的，就得由這一步收掉'
  );
});

// ---- 載入後強制重載擴充 ----

test('attachToServiceWorker(經 reloadExtension):SW endpoint 已死時換一個重試，不當場放棄', async () => {
  const port = 9411;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId, deadSwConnections: 1 });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.reloadExtension(port, extensionId);

  assert.ok(
    mock.evaluated.some((e) => e.includes('chrome.runtime.reload()')),
    '第一次連到的是剛被終止的 target，重試就該成功'
  );
  assert.equal(
    mock.targets.filter((t) => t.type === 'page').length,
    0,
    '重試路徑上開的喚醒分頁一個都不能留'
  );
});

test('reloadExtension:送出 chrome.runtime.reload()，並關掉自己開的喚醒分頁', async () => {
  const port = 9409;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.reloadExtension(port, extensionId);

  assert.ok(
    mock.evaluated.some((e) => e.includes('chrome.runtime.reload()')),
    'loadUnpacked 只重讀 manifest;importScripts 進來的模組要靠 reload 才會更新'
  );
  assert.deepEqual(mock.closedTargetIds, ['wake-1'], '喚醒用的暫時分頁要收掉');
  assert.ok(
    !mock.targets.some((t) => t.type === 'service_worker'),
    'reload 後要等舊的 SW target 退場才回;連上死掉的 endpoint 會讓下一步永遠等不到回覆'
  );
});

// ---- 切換環境時清掉舊登入狀態 ----

test('configureApiEnv:目前指向別的環境時，先清舊登入狀態再寫新的 apiBase', async () => {
  const port = 9405;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({
    port,
    extensionId,
    currentApiBase: 'https://api-staging.metalinkclearer.workers.dev',
  });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnv(port, extensionId, 'local');

  const readIdx = mock.evaluated.findIndex((e) => e.includes('got.syncApiBase'));
  const clearIdx = mock.evaluated.findIndex((e) => e.includes('chrome.storage.local.remove'));
  const writeIdx = mock.evaluated.findIndex((e) => e.includes('chrome.storage.local.set'));

  assert.ok(readIdx !== -1, '應先讀回目前的 syncApiBase');
  assert.ok(clearIdx !== -1, '換了環境就該清掉舊登入狀態');
  assert.ok(writeIdx !== -1, '應寫入新環境的 syncApiBase');
  assert.ok(readIdx < clearIdx && clearIdx < writeIdx, '順序必須是讀 → 清 → 寫');

  for (const key of devBrowser.STALE_LOCAL_KEYS) {
    assert.ok(mock.evaluated[clearIdx].includes(key), `storage.local 的 ${key} 要被清掉`);
  }
  for (const key of devBrowser.STALE_SESSION_KEYS) {
    assert.ok(mock.evaluated[clearIdx].includes(key), `storage.session 的 ${key} 要被清掉`);
  }
  assert.ok(
    mock.evaluated[writeIdx].includes('http://localhost:8787'),
    '寫入的必須是 local 的 apiBase'
  );
});

test('configureApiEnv:目前已指向同一個環境時，不清舊登入狀態', async () => {
  const port = 9406;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId, currentApiBase: 'http://localhost:8787' });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnv(port, extensionId, 'local');

  assert.ok(
    !mock.evaluated.some((e) => e.includes('syncAuth')),
    '同一個環境重跑一次不該把使用者的登入狀態洗掉'
  );
});

test('configureApiEnv:讀不出目前的 apiBase 時保守處理，照樣清掉舊登入狀態', async () => {
  const port = 9410;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({
    port,
    extensionId,
    currentApiBase: 'http://localhost:8787',
    apiBaseReadable: false,
  });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnv(port, extensionId, 'local');

  assert.ok(
    mock.evaluated.some((e) => e.includes('syncAuth')),
    '讀不出來就不能假設「沒換環境」;寧可多清一次，也不要把舊 token 留給新後端'
  );
});

test('configureApiEnv:沒有 syncApiBase(等同 production)時切到 local，一樣要清', async () => {
  const port = 9407;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId, currentApiBase: null });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  await devBrowser.configureApiEnv(port, extensionId, 'local');

  assert.ok(mock.evaluated.some((e) => e.includes('syncAuth')));
});

test('sendCdpCommand:逾時會 reject，不會永遠掛住', async () => {
  class NeverRespondWebSocket {
    constructor() {
      this.listeners = {};
      queueMicrotask(() => this._emit('open'));
    }
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    }
    send() {
      // 故意不回覆，模擬對端卡住不回應。
    }
    close() {}
    _emit(type, evt = {}) {
      (this.listeners[type] || []).forEach((fn) => fn(evt));
    }
  }
  global.WebSocket = NeverRespondWebSocket;

  await assert.rejects(
    () => devBrowser.sendCdpCommand('ws://mock-stuck', 'Runtime.evaluate', {}, 50),
    /逾時/
  );
});
