// test/dev-browser.test.js — tools/dev-browser.mjs 的純函式契約。
//
// dev-browser.mjs 是 ESM，主流程(啟動真正的 Chrome、CDP 連線)只在
// `import.meta.url === 直接執行的檔案` 時跑，import 進來不會有任何副作用。
// 本檔只測可 import 的純函式:
//   - parseArgs:三個環境、缺/未知 --env 報錯、--yes/--fresh/--no-open 解析、
//     同一旗標重複出現時後者覆蓋前者
//   - productionGuard:TTY/非 TTY、--yes、輸入相符/不符
//   - localNotBuiltError:local 回傳帶 code 的「尚未建置」錯誤
//   - sendCdpCommand:逾時會 reject，不永遠掛住
//   - configureApiEnvAndCleanup:喚醒 SW 用的暫時分頁，--no-open 時要關掉、
//     --open 時要沿用成 options 頁而非開兩個(用 mock CDP transport 斷言,
//     不需要真 Chrome)
//   - configureApiEnv:剛喚醒的 SW 在 CDP 裡處於暫停狀態(真實環境驗證發現
//     的 bug，不送 Runtime.runIfWaitingForDebugger 就會卡死)要先解除暫停;
//     失敗路徑(如逾時)也要把喚醒分頁關掉，不能只有成功路徑會清
// 另外靜態檢查 package.json 的 scripts 清單，以及沿用 test/package.test.js
// 既有邏輯確認打包白名單不誤收 docs/、test/、package.json。
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

test('parseArgs:--yes、--fresh、--no-open 解析為 true/false', () => {
  const opts = devBrowser.parseArgs(['--env', 'production', '--yes', '--fresh', '--no-open']);
  assert.equal(opts.yes, true);
  assert.equal(opts.fresh, true);
  assert.equal(opts.open, false);

  const defaults = devBrowser.parseArgs(['--env', 'staging']);
  assert.equal(defaults.yes, false);
  assert.equal(defaults.fresh, false);
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

// ---- local ----

test('localNotBuiltError:回傳帶 code 的「尚未建置」錯誤', () => {
  const err = devBrowser.localNotBuiltError();
  assert.equal(err.code, 'ENV_NOT_BUILT');
  assert.match(err.message, /尚未建置/);
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

function createMockCdp({ port, extensionId }) {
  const browserWsUrl = `ws://mock-browser:${port}`;
  const swWsUrl = `ws://mock-sw:${port}`;
  let targets = [];
  let nextWakeId = 1;
  let newTargetCalls = 0;
  const closedTargetIds = [];
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
      if (!targets.some((t) => t.type === 'service_worker')) {
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
