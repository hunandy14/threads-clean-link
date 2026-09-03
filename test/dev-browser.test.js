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
//   - resolveBackendDir／backendStartPlan／parsePidFile／killTreeCommand:
//     --env local 自動帶起本機後端的純函式決策(目錄解析——含 TCL_API_LOCAL_DIR
//     相對路徑經 path.resolve() 解析成絕對路徑、要不要啟動、PID 檔解析——
//     含超出合法 PID 上界一律回 null、依平台選關閉行程樹的方式)
//   - isProcessNotFoundError:區分 killTreeRunner 的例外是「行程本來就不
//     存在」(win32 訊息含 not found／ERROR: The process，其他平台 ESRCH)
//     還是真正的失敗(例如權限不足)，後者不能被靜默吞掉當成功
//   - resolveBackendSpawnTarget:win32 上 npm 是 .cmd，直接 spawn 需要
//     shell:true，但那疊加 detached:true 時 log 檔會是空的(現場實測發現
//     的真實 bug，見函式註解)——找得到 npm-cli.js 就改用 node.exe 直接
//     執行它跳過外殼，找不到才退回舊行為；非 win32 不受影響
//   - ensureLocalBackend:注入假的 spawn／fetch／fs 驗多條路徑——探活成功
//     跳過、--no-backend 不啟動、後端目錄缺失、啟動後等到 /health 通過。
//     預設(不帶 detachBackend)是前景模式:spawn 不 detach、stdio 為
//     'inherit'、不開 log 檔，逾時也沒有 log 尾段可清;detachBackend:true
//     是背景模式，維持原本 detached + fd 重導向 + windowsHide 的斷言
//     (win32 找得到／找不到 npm-cli.js 兩種、非 win32 一種)，逾時要清 log
//     尾段並殺掉剛起的行程樹
//   - attachForegroundBackendLifecycle:前景模式收到 SIGINT/SIGTERM 時殺
//     行程樹、等埠釋放、刪 PID 檔、以 0 結束;子行程自己先結束(未收到訊號)
//     則印結束碼、刪 PID 檔，結束碼非 0 才跟著非 0 結束；兩條路徑互斥
//     (shuttingDown 旗標)，不會搶著收尾兩次
//   - stopBackend:--stop-backend 的三種狀態(有 PID 檔、無 PID 檔且埠仍活著、
//     無 PID 檔且埠已死)，以及殺行程樹失敗時依 isProcessNotFoundError 分流
//     ——行程本來就不存在則不中斷、照樣清 PID 檔收尾;真正失敗(權限不足等)
//     則回 kill-failed、保留 PID 檔、不靜默當成功
// 另外靜態檢查 package.json 的 scripts 清單，以及沿用 test/package.test.js
// 既有邏輯確認打包白名單不誤收 docs/、test/、package.json。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
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
  swSilent = false,
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
      // deadSwConnections:模擬「/json 清單裡還留著剛被終止的 SW target」，
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
        // swSilent:endpoint 活著（連得上、不斷線）但一個指令都不回。這是
        // 「對端卡住」，與 deadSwConnections 的「連線層斷掉」是兩種失敗。
        if (swSilent) return;
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

test('attachToServiceWorker(經 reloadExtension):SW 活著但不回覆時只試一次，不重試', async () => {
  const port = 9412;
  const extensionId = 'hehokicokbgajpanjcajhmflaennnmdj';
  const mock = createMockCdp({ port, extensionId, swSilent: true });
  global.fetch = mock.fetchImpl;
  global.WebSocket = mock.WebSocketImpl;

  // 逾時用注入的短值，測試不必真的等滿 CDP_COMMAND_TIMEOUT_MS。
  await assert.rejects(() => devBrowser.reloadExtension(port, extensionId, 50), /逾時/);

  assert.deepEqual(
    mock.closedTargetIds,
    ['wake-1'],
    '只該嘗試一次:endpoint 活著卻不回覆，重試只是再等一輪逾時;而且那一個喚醒分頁要收掉'
  );
  assert.equal(mock.newTargetCalls, 1, '不重試就不會再開第二個喚醒分頁');
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

// ---- parseArgs:--no-backend／--detach-backend／--stop-backend ----

test('parseArgs:--no-backend 解析為 true，預設 false', () => {
  const opts = devBrowser.parseArgs(['--env', 'local', '--no-backend']);
  assert.equal(opts.noBackend, true);
  assert.equal(devBrowser.parseArgs(['--env', 'local']).noBackend, false);
});

test('parseArgs:--detach-backend 解析為 true，預設 false(預設走前景模式)', () => {
  const opts = devBrowser.parseArgs(['--env', 'local', '--detach-backend']);
  assert.equal(opts.detachBackend, true);
  assert.equal(devBrowser.parseArgs(['--env', 'local']).detachBackend, false);
});

test('parseArgs:--stop-backend 是獨立旗標，不需要 --env 也能解析', () => {
  const opts = devBrowser.parseArgs(['--stop-backend']);
  assert.equal(opts.stopBackend, true);
  assert.equal(opts.env, null, '沒帶 --env 不該報錯');
});

// ---- resolveBackendDir ----

test('resolveBackendDir:TCL_API_LOCAL_DIR 有值時優先採用，空白視同未設定', () => {
  const home = path.join('C:', 'Users', 'someone');
  assert.equal(
    devBrowser.resolveBackendDir({ TCL_API_LOCAL_DIR: 'D:\\custom\\api' }, home),
    'D:\\custom\\api'
  );
  assert.equal(
    devBrowser.resolveBackendDir({}, home),
    path.join(home, '.threads-clean-link', 'api-local', 'api'),
    '沒設環境變數時回預設路徑'
  );
  assert.equal(
    devBrowser.resolveBackendDir({ TCL_API_LOCAL_DIR: '   ' }, home),
    path.join(home, '.threads-clean-link', 'api-local', 'api'),
    '純空白視同未設定'
  );
});

test('resolveBackendDir:TCL_API_LOCAL_DIR 是相對路徑時，經 path.resolve() 解析成絕對路徑(與 --build 的路徑處理一致)', () => {
  const home = path.join('C:', 'Users', 'someone');
  const relative = path.join('..', 'custom-api-local', 'api');
  const resolved = devBrowser.resolveBackendDir({ TCL_API_LOCAL_DIR: relative }, home);

  assert.equal(
    resolved,
    path.resolve(relative),
    '相對路徑應該被解析成相對於目前工作目錄的絕對路徑'
  );
  assert.notEqual(resolved, relative, '不能原樣回傳沒解析過的相對路徑');
  assert.ok(path.isAbsolute(resolved), '結果必須是絕對路徑');
});

// ---- backendStartPlan ----

test('backendStartPlan:健康時跳過，理由 healthy，不查目錄', () => {
  const plan = devBrowser.backendStartPlan({
    healthy: true,
    noBackend: false,
    dirExists: false,
    pkgJsonExists: false,
    backendDir: 'x',
  });
  assert.deepEqual(plan, { action: 'skip', reason: 'healthy' });
});

test('backendStartPlan:不健康但帶 --no-backend 時跳過，理由 no-backend', () => {
  const plan = devBrowser.backendStartPlan({
    healthy: false,
    noBackend: true,
    dirExists: true,
    pkgJsonExists: true,
    backendDir: 'x',
  });
  assert.deepEqual(plan, { action: 'skip', reason: 'no-backend' });
});

test('backendStartPlan:目錄不存在或缺 package.json 時回 missing-dir', () => {
  assert.deepEqual(
    devBrowser.backendStartPlan({
      healthy: false,
      noBackend: false,
      dirExists: false,
      pkgJsonExists: false,
      backendDir: 'x',
    }),
    { action: 'missing-dir', dir: 'x' }
  );
  assert.deepEqual(
    devBrowser.backendStartPlan({
      healthy: false,
      noBackend: false,
      dirExists: true,
      pkgJsonExists: false,
      backendDir: 'x',
    }),
    { action: 'missing-dir', dir: 'x' },
    '目錄在但沒有 package.json，一樣視為缺失'
  );
});

test('backendStartPlan:目錄與 package.json 都在時回 start 計畫(npm run dev)', () => {
  const plan = devBrowser.backendStartPlan({
    healthy: false,
    noBackend: false,
    dirExists: true,
    pkgJsonExists: true,
    backendDir: 'x/api-local/api',
  });
  assert.deepEqual(plan, { action: 'start', command: 'npm', args: ['run', 'dev'], cwd: 'x/api-local/api' });
});

// ---- parsePidFile ----

test('parsePidFile:合法正整數字串回數字(含前後空白／換行)，其餘一律回 null', () => {
  assert.equal(devBrowser.parsePidFile('12345'), 12345);
  assert.equal(devBrowser.parsePidFile('12345\n'), 12345);
  assert.equal(devBrowser.parsePidFile('  67  '), 67);
  assert.equal(devBrowser.parsePidFile(''), null);
  assert.equal(devBrowser.parsePidFile('abc'), null);
  assert.equal(devBrowser.parsePidFile('-5'), null, '負數不是合法 PID');
  assert.equal(devBrowser.parsePidFile('0'), null, '0 不是合法 PID');
  assert.equal(devBrowser.parsePidFile('12.5'), null, '非整數不是合法 PID');
});

test('parsePidFile:超出合法 PID 上界一律回 null，PID 檔壞掉不會被當成真 PID 拿去殺行程', () => {
  assert.equal(devBrowser.parsePidFile(String(devBrowser.MAX_PID)), devBrowser.MAX_PID, '上界本身仍合法');
  assert.equal(
    devBrowser.parsePidFile('4294967296'),
    null,
    '2^32，超過 32 位元帶號整數上限，不是合法 PID'
  );
  assert.equal(
    devBrowser.parsePidFile('99999999999999999999999'),
    null,
    '遠超 Number.isSafeInteger 範圍，PID 檔寫壞成這樣也不能放行'
  );
});

// ---- killTreeCommand／runKillTree ----

test('killTreeCommand:win32 用 taskkill /PID <pid> /T /F', () => {
  assert.deepEqual(devBrowser.killTreeCommand(4242, 'win32'), {
    type: 'exec',
    command: 'taskkill',
    args: ['/PID', '4242', '/T', '/F'],
  });
});

test('killTreeCommand:非 win32 用負 pid 送 SIGKILL(對應 process.kill(-pid))', () => {
  assert.deepEqual(devBrowser.killTreeCommand(4242, 'darwin'), {
    type: 'signal',
    pid: -4242,
    signal: 'SIGKILL',
  });
  assert.deepEqual(devBrowser.killTreeCommand(4242, 'linux'), {
    type: 'signal',
    pid: -4242,
    signal: 'SIGKILL',
  });
});

test('runKillTree:win32 呼叫注入的 execFileFn(taskkill)', async () => {
  const calls = [];
  await devBrowser.runKillTree(111, 'win32', {
    execFileFn: async (cmd, args) => {
      calls.push([cmd, args]);
    },
  });
  assert.deepEqual(calls, [['taskkill', ['/PID', '111', '/T', '/F']]]);
});

test('runKillTree:非 win32 呼叫注入的 killFn(對應 process.kill(-pid))', async () => {
  const calls = [];
  await devBrowser.runKillTree(111, 'linux', {
    killFn: (pid, signal) => {
      calls.push([pid, signal]);
    },
  });
  assert.deepEqual(calls, [[-111, 'SIGKILL']]);
});

// ---- tailLines／isPortOpen ----

test('tailLines:取最後 n 行，混用 \\n／\\r\\n 皆正確，結尾換行不算多一空行', () => {
  assert.equal(devBrowser.tailLines('a\nb\nc\nd\n', 2), 'c\nd');
  assert.equal(devBrowser.tailLines('a\r\nb\r\nc\r\n', 2), 'b\nc');
  assert.equal(devBrowser.tailLines('only one line', 20), 'only one line');
});

test('isPortOpen:埠有人監聽回 true，關閉後回 false', async (t) => {
  const net = require('node:net');
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  assert.equal(await devBrowser.isPortOpen(port), true);

  await new Promise((resolve) => server.close(() => resolve()));
  assert.equal(await devBrowser.isPortOpen(port), false);
});

// ---- ensureLocalBackend:注入假 spawn／fetch／fs，涵蓋 --env local 自動帶
// 起後端的每一條路徑 ----

test('ensureLocalBackend:探活成功時跳過啟動，回 existing，不呼叫 spawn 或查目錄', async () => {
  let spawnCalled = false;
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    backendDir: 'unused',
    logPath: 'unused.log',
    pidPath: 'unused.pid',
    deps: {
      probeHealthFn: async () => true,
      spawnFn: () => {
        spawnCalled = true;
      },
      existsSyncFn: () => {
        throw new Error('健康時不該查後端目錄');
      },
    },
  });
  assert.deepEqual(result, { status: 'existing' });
  assert.equal(spawnCalled, false);
});

test('ensureLocalBackend:探活失敗且帶 --no-backend 時不啟動，回 no-backend', async () => {
  let spawnCalled = false;
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: true,
    backendDir: 'unused',
    logPath: 'unused.log',
    pidPath: 'unused.pid',
    deps: {
      probeHealthFn: async () => false,
      spawnFn: () => {
        spawnCalled = true;
      },
      existsSyncFn: () => {
        throw new Error('--no-backend 時不該查後端目錄');
      },
    },
  });
  assert.deepEqual(result, { status: 'no-backend' });
  assert.equal(spawnCalled, false);
});

test('ensureLocalBackend:探活失敗且後端目錄不存在時回 missing-dir，不呼叫 spawn', async () => {
  let spawnCalled = false;
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    backendDir: '/no/such/dir',
    logPath: 'unused.log',
    pidPath: 'unused.pid',
    deps: {
      probeHealthFn: async () => false,
      existsSyncFn: () => false,
      spawnFn: () => {
        spawnCalled = true;
      },
    },
  });
  assert.deepEqual(result, { status: 'missing-dir', dir: '/no/such/dir' });
  assert.equal(spawnCalled, false);
});

test('ensureLocalBackend:帶 --detach-backend 時，探活失敗且未帶 --no-backend 自動背景啟動，等到 /health 回應即回 started(win32 找得到 npm-cli.js，走 node.exe 直接執行，不經外殼)', async () => {
  const events = {};
  let probeCallCount = 0;
  const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    detachBackend: true,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => {
        probeCallCount += 1;
        // 第一次是啟動前的探活(失敗)，第二次(輪詢的第一次)就通過。
        return probeCallCount > 1;
      },
      existsSyncFn: () => true,
      openSyncFn: (p, flag) => {
        events.opened = { p, flag };
        return 99;
      },
      closeSyncFn: (fd) => {
        events.closedFd = fd;
      },
      spawnFn: (cmd, args, opts) => {
        events.spawnArgs = { cmd, args, opts };
        return { pid: 5555, unref() {} };
      },
      writeFileSyncFn: (p, data) => {
        events.pidWritten = { p, data };
      },
      platformFn: () => 'win32',
      pollIntervalMs: 1,
    },
  });

  assert.deepEqual(result, { status: 'started', pid: 5555, log: '/tmp/api-local.log' });
  // 見 resolveBackendSpawnTarget 的註解:win32 上找得到 npm-cli.js 時，改成
  // 用目前這顆 node.exe 直接執行它，不經過 npm.cmd 這層外殼——實測 shell:true
  // 疊加 detached:true 會讓 log 檔案永遠是空的。
  assert.equal(events.spawnArgs.cmd, process.execPath);
  assert.deepEqual(events.spawnArgs.args, [npmCliPath, 'run', 'dev']);
  assert.equal(events.spawnArgs.opts.cwd, '/api-local/api');
  assert.equal(events.spawnArgs.opts.detached, true, '不 detach 的話本腳本結束時後端會被一起收掉');
  assert.equal(events.spawnArgs.opts.shell, false, '單一層直達 node.exe，不需要外殼');
  assert.equal(events.spawnArgs.opts.windowsHide, true, 'Windows 上不彈出空白主控台視窗');
  assert.deepEqual(events.spawnArgs.opts.stdio, ['ignore', 99, 99]);
  assert.deepEqual(events.opened, { p: '/tmp/api-local.log', flag: 'w' }, 'log 檔要覆寫，不是續寫');
  assert.equal(events.closedFd, 99);
  assert.deepEqual(events.pidWritten, { p: '/tmp/api-local.pid', data: '5555' });
});

test('ensureLocalBackend:帶 --detach-backend 時，win32 上找不到 npm-cli.js 就退回 npm + shell:true', async () => {
  const events = {};
  let probeCallCount = 0;
  const npmCliPath = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    detachBackend: true,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => {
        probeCallCount += 1;
        return probeCallCount > 1;
      },
      // 後端目錄／package.json 都在，唯獨查不到 npm-cli.js。
      existsSyncFn: (p) => p !== npmCliPath,
      openSyncFn: () => 99,
      closeSyncFn: () => {},
      spawnFn: (cmd, args, opts) => {
        events.spawnArgs = { cmd, args, opts };
        return { pid: 6666, unref() {} };
      },
      writeFileSyncFn: () => {},
      platformFn: () => 'win32',
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.status, 'started');
  assert.equal(events.spawnArgs.cmd, 'npm');
  assert.deepEqual(events.spawnArgs.args, ['run', 'dev']);
  assert.equal(events.spawnArgs.opts.shell, true, '找不到 npm-cli.js 時退回舊行為，靠 shell 解析 npm.cmd');
  assert.equal(events.spawnArgs.opts.windowsHide, true, 'shell:true 分支也不彈出空白主控台視窗');
});

test('ensureLocalBackend:帶 --detach-backend 時，非 win32 平台一律直接 spawn npm，不查 npm-cli.js、不用 shell', async () => {
  const events = {};
  let probeCallCount = 0;
  let existsSyncCalls = 0;
  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    detachBackend: true,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => {
        probeCallCount += 1;
        return probeCallCount > 1;
      },
      existsSyncFn: () => {
        existsSyncCalls += 1;
        return true;
      },
      openSyncFn: () => 99,
      closeSyncFn: () => {},
      spawnFn: (cmd, args, opts) => {
        events.spawnArgs = { cmd, args, opts };
        return { pid: 7000, unref() {} };
      },
      writeFileSyncFn: () => {},
      platformFn: () => 'linux',
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.status, 'started');
  assert.equal(events.spawnArgs.cmd, 'npm');
  assert.deepEqual(events.spawnArgs.args, ['run', 'dev']);
  assert.equal(events.spawnArgs.opts.shell, false, '非 win32 的 npm 本身就是可執行檔，不需要外殼');
  assert.equal(events.spawnArgs.opts.detached, true);
  assert.equal(events.spawnArgs.opts.windowsHide, true, '非 Windows 平台這個選項無作用，但一律帶上不需要另外分支');
  // existsSyncFn 只該為了查後端目錄／package.json 被呼叫兩次，不該多查
  // npm-cli.js(那是 win32 專屬的分支)。
  assert.equal(existsSyncCalls, 2);
});

// ---- ensureLocalBackend:前景模式(預設，不帶 --detach-backend) ----

test('ensureLocalBackend:預設(不帶 --detach-backend)是前景模式——spawn 不 detach、stdio 為 inherit、不開不關 log 檔，回傳帶 child 而不是 log', async () => {
  const events = {};
  let probeCallCount = 0;
  let openCalled = false;
  let closeCalled = false;
  const fakeChild = { pid: 8123 };

  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => {
        probeCallCount += 1;
        return probeCallCount > 1;
      },
      existsSyncFn: () => true,
      openSyncFn: () => {
        openCalled = true;
        return 99;
      },
      closeSyncFn: () => {
        closeCalled = true;
      },
      spawnFn: (cmd, args, opts) => {
        events.spawnArgs = { cmd, args, opts };
        return fakeChild;
      },
      writeFileSyncFn: (p, data) => {
        events.pidWritten = { p, data };
      },
      platformFn: () => 'linux',
      pollIntervalMs: 1,
    },
  });

  assert.deepEqual(result, { status: 'started', pid: 8123, child: fakeChild });
  assert.equal(events.spawnArgs.cmd, 'npm');
  assert.deepEqual(events.spawnArgs.args, ['run', 'dev']);
  assert.equal(events.spawnArgs.opts.cwd, '/api-local/api');
  assert.equal(events.spawnArgs.opts.stdio, 'inherit', '前景模式輸出直接印在目前這個終端機，不經過 Node 轉印');
  assert.equal('detached' in events.spawnArgs.opts, false, '前景模式不 detach，子行程隨父行程一起結束');
  assert.equal('windowsHide' in events.spawnArgs.opts, false, '前景模式沒有主控台視窗被彈出的問題，不需要這個選項');
  assert.equal(openCalled, false, '前景模式不寫 log 檔');
  assert.equal(closeCalled, false);
  assert.deepEqual(events.pidWritten, { p: '/tmp/api-local.pid', data: '8123' }, '前景模式仍要寫 PID 檔，供 --stop-backend 救孤兒');
});

test('ensureLocalBackend:前景模式逾時——沒有 log 檔可讀，tail 是空字串，仍照樣殺行程樹、刪 PID 檔', async () => {
  const killCalls = [];
  const unlinkCalls = [];
  let readFileCalled = false;

  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => false,
      existsSyncFn: () => true,
      spawnFn: () => ({ pid: 8888 }),
      writeFileSyncFn: () => {},
      readFileSyncFn: () => {
        readFileCalled = true;
        return 'unused';
      },
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      platformFn: () => 'linux',
      killTreeRunner: async (pid, plat) => {
        killCalls.push([pid, plat]);
      },
      pollTimeoutMs: 5,
      pollIntervalMs: 1,
    },
  });

  assert.deepEqual(result, { status: 'timeout', tail: '', pid: 8888 });
  assert.equal(readFileCalled, false, '前景模式沒有 log 檔，不該嘗試讀取');
  assert.deepEqual(killCalls, [[8888, 'linux']]);
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid']);
});

// ---- resolveBackendSpawnTarget(純函式) ----

test('resolveBackendSpawnTarget:win32 且找得到 npm-cli.js 時，改用 execPath 直接執行它，不需要外殼', () => {
  const target = devBrowser.resolveBackendSpawnTarget({
    command: 'npm',
    args: ['run', 'dev'],
    plat: 'win32',
    execPath: 'C:\\App\\node\\node.exe',
    npmCliExists: true,
  });
  assert.deepEqual(target, {
    file: 'C:\\App\\node\\node.exe',
    args: [path.join('C:\\App\\node', 'node_modules', 'npm', 'bin', 'npm-cli.js'), 'run', 'dev'],
    shell: false,
  });
});

test('resolveBackendSpawnTarget:win32 但找不到 npm-cli.js 時，退回 npm + shell:true', () => {
  const target = devBrowser.resolveBackendSpawnTarget({
    command: 'npm',
    args: ['run', 'dev'],
    plat: 'win32',
    execPath: 'C:\\App\\node\\node.exe',
    npmCliExists: false,
  });
  assert.deepEqual(target, { file: 'npm', args: ['run', 'dev'], shell: true });
});

test('resolveBackendSpawnTarget:非 win32 一律直接執行 command，不需要外殼', () => {
  const target = devBrowser.resolveBackendSpawnTarget({
    command: 'npm',
    args: ['run', 'dev'],
    plat: 'darwin',
    execPath: '/usr/local/bin/node',
    npmCliExists: false,
  });
  assert.deepEqual(target, { file: 'npm', args: ['run', 'dev'], shell: false });
});

test('resolveBackendSpawnTarget:command 不是 npm 時(理論上不會發生，但函式本身不假設)，win32 仍照原樣搭配 shell', () => {
  const target = devBrowser.resolveBackendSpawnTarget({
    command: 'something-else',
    args: ['x'],
    plat: 'win32',
    execPath: 'C:\\App\\node\\node.exe',
    npmCliExists: true,
  });
  assert.deepEqual(target, { file: 'something-else', args: ['x'], shell: true });
});

test('ensureLocalBackend:帶 --detach-backend 時，啟動後 /health 一直不通，逾時要清 log 尾段、殺行程樹、刪 PID 檔', async () => {
  const killCalls = [];
  const unlinkCalls = [];
  const logLines = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');

  const result = await devBrowser.ensureLocalBackend({
    apiBase: 'http://localhost:8787',
    noBackend: false,
    detachBackend: true,
    backendDir: '/api-local/api',
    logPath: '/tmp/api-local.log',
    pidPath: '/tmp/api-local.pid',
    deps: {
      probeHealthFn: async () => false, // 永遠探不到，逼出逾時路徑
      existsSyncFn: () => true,
      openSyncFn: () => 1,
      closeSyncFn: () => {},
      spawnFn: () => ({ pid: 7777, unref() {} }),
      writeFileSyncFn: () => {},
      readFileSyncFn: () => logLines,
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      platformFn: () => 'win32',
      killTreeRunner: async (pid, plat) => {
        killCalls.push([pid, plat]);
      },
      pollTimeoutMs: 5,
      pollIntervalMs: 1,
    },
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.pid, 7777);
  assert.equal(result.log, '/tmp/api-local.log');
  assert.equal(result.tail.split('\n').length, 20, '只留最後 20 行');
  assert.ok(result.tail.endsWith('line29'), '要是最新的尾段，不是頭段');
  assert.deepEqual(killCalls, [[7777, 'win32']], '逾時要把剛起的行程樹連根殺掉');
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid'], '殺掉後不留誤導下次執行的 PID 檔');
});

// ---- attachForegroundBackendLifecycle:前景模式的訊號與子行程結束處理 ----
// signalSource／child 都用假的 EventEmitter 手動觸發，不必真的送系統訊號或
// spawn 一個行程；exitFn 用假的把結束碼收進一個 Promise，不必真的終止測試
// 行程。

test('attachForegroundBackendLifecycle:收到 SIGINT 時殺行程樹、等埠釋放、刪 PID 檔、以 0 結束', async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 9001;
  const killCalls = [];
  const unlinkCalls = [];
  let portOpenCallCount = 0;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  devBrowser.attachForegroundBackendLifecycle({
    child,
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      signalSource,
      exitFn: (code) => resolveExit(code),
      existsSyncFn: () => true,
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      isPortOpenFn: async () => {
        portOpenCallCount += 1;
        // 殺完的瞬間埠可能還沒真的放掉，第二次輪詢才放。
        return portOpenCallCount === 1;
      },
      platformFn: () => 'win32',
      killTreeRunner: async (pid, plat) => {
        killCalls.push([pid, plat]);
      },
      pollIntervalMs: 1,
      log: () => {},
      error: () => {},
    },
  });

  signalSource.emit('SIGINT');
  const code = await exitPromise;

  assert.equal(code, 0);
  assert.deepEqual(killCalls, [[9001, 'win32']]);
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid']);
});

test('attachForegroundBackendLifecycle:子行程自己先結束(未收到訊號)時，印結束碼、刪 PID 檔，非 0 結束碼就以非 0 收尾，且不再多殺一次行程樹', async () => {
  const unlinkCalls = [];
  let killCalled = false;
  const child = new EventEmitter();
  child.pid = 9002;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  devBrowser.attachForegroundBackendLifecycle({
    child,
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      signalSource: new EventEmitter(),
      exitFn: (code) => resolveExit(code),
      existsSyncFn: () => true,
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      killTreeRunner: async () => {
        killCalled = true;
      },
      log: () => {},
      error: () => {},
    },
  });

  child.emit('exit', 1);
  const code = await exitPromise;

  assert.equal(code, 1, '後端自己非 0 結束，本腳本也非 0 結束');
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid']);
  assert.equal(killCalled, false, '後端已經自己結束，不必再殺一次行程樹');
});

test('attachForegroundBackendLifecycle:子行程自己以 0 結束(例如使用者在 wrangler 互動介面按 x)時，本腳本也以 0 收尾', async () => {
  const child = new EventEmitter();
  child.pid = 9003;
  let resolveExit;
  const exitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });

  devBrowser.attachForegroundBackendLifecycle({
    child,
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      signalSource: new EventEmitter(),
      exitFn: (code) => resolveExit(code),
      existsSyncFn: () => false,
      unlinkSyncFn: () => {},
      log: () => {},
      error: () => {},
    },
  });

  child.emit('exit', 0);
  const code = await exitPromise;
  assert.equal(code, 0);
});

test('attachForegroundBackendLifecycle:子行程結束事件與 SIGINT 幾乎同時發生時互斥，只有一條路徑真正收尾', async () => {
  const signalSource = new EventEmitter();
  const child = new EventEmitter();
  child.pid = 9004;
  let exitCallCount = 0;
  let killCallCount = 0;

  devBrowser.attachForegroundBackendLifecycle({
    child,
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      signalSource,
      exitFn: () => {
        exitCallCount += 1;
      },
      existsSyncFn: () => true,
      unlinkSyncFn: () => {},
      isPortOpenFn: async () => false,
      killTreeRunner: async () => {
        killCallCount += 1;
      },
      pollIntervalMs: 1,
      log: () => {},
      error: () => {},
    },
  });

  child.emit('exit', 0); // 後端先自己結束(同步收尾)
  signalSource.emit('SIGINT'); // 使用者幾乎同時按下 Ctrl+C
  // 讓 onSignal 的非同步流程有機會跑完(若沒被 shuttingDown 擋下的話)。
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(exitCallCount, 1, '兩條路徑只該有一條真正跑完收尾');
  assert.equal(killCallCount, 0, '後端已經自己結束，SIGINT 那條路徑不該再殺一次行程樹');
});

// ---- stopBackend:--stop-backend 的三種狀態 ----

test('stopBackend:有 PID 檔時，關閉行程樹、刪 PID 檔、等埠釋放後回 stopped', async () => {
  const killCalls = [];
  const unlinkCalls = [];
  let portOpenCallCount = 0;

  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '4321',
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      isPortOpenFn: async () => {
        portOpenCallCount += 1;
        // 殺完的瞬間埠可能還沒真的放掉，第二次輪詢才放。
        return portOpenCallCount === 1;
      },
      platformFn: () => 'win32',
      killTreeRunner: async (pid, plat) => {
        killCalls.push([pid, plat]);
      },
      pollIntervalMs: 1,
    },
  });

  assert.deepEqual(result, { status: 'stopped', pid: 4321 });
  assert.deepEqual(killCalls, [[4321, 'win32']]);
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid']);
});

test('stopBackend:PID 檔不存在但埠仍有服務在聽時，回 not-owned，不動任何行程', async () => {
  const killCalls = [];
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => false,
      isPortOpenFn: async () => true,
      killTreeRunner: async (...args) => killCalls.push(args),
    },
  });
  assert.deepEqual(result, { status: 'not-owned' });
  assert.equal(killCalls.length, 0, '不是本腳本啟動的行程，不能動它');
});

test('stopBackend:PID 檔不存在且埠也沒人聽時，回 already-stopped', async () => {
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => false,
      isPortOpenFn: async () => false,
    },
  });
  assert.deepEqual(result, { status: 'already-stopped' });
});

test('stopBackend:殺完行程樹但埠遲遲不放，逾時回 stop-timeout', async () => {
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '999',
      unlinkSyncFn: () => {},
      isPortOpenFn: async () => true, // 永遠佔著，逼出逾時路徑
      killTreeRunner: async () => {},
      pollTimeoutMs: 5,
      pollIntervalMs: 1,
    },
  });
  assert.deepEqual(result, { status: 'stop-timeout', pid: 999 });
});

test('stopBackend:killTreeRunner 失敗且是「行程本來就不存在」(win32 taskkill 訊息含 not found)時不中斷，照樣清 PID 檔並回 stopped', async () => {
  const unlinkCalls = [];
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '123',
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      isPortOpenFn: async () => false,
      platformFn: () => 'win32',
      killTreeRunner: async () => {
        throw new Error('ERROR: The process "123" not found.');
      },
    },
  });
  assert.deepEqual(result, { status: 'stopped', pid: 123 });
  assert.deepEqual(unlinkCalls, ['/tmp/api-local.pid']);
});

test('stopBackend:killTreeRunner 失敗且不是「行程本來就不存在」時(例如權限不足)，回 kill-failed 並保留 PID 檔，不靜默當成功', async () => {
  const unlinkCalls = [];
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '123',
      unlinkSyncFn: (p) => unlinkCalls.push(p),
      isPortOpenFn: async () => true,
      platformFn: () => 'win32',
      killTreeRunner: async () => {
        throw new Error('ERROR: Access is denied.');
      },
    },
  });
  assert.deepEqual(result, { status: 'kill-failed', pid: 123, error: 'ERROR: Access is denied.' });
  assert.deepEqual(unlinkCalls, [], '殺不掉就不該刪 PID 檔，刪了會讓下一次 --stop-backend 誤判成已經沒在跑');
});

test('stopBackend:非 win32 平台 killTreeRunner 丟 ESRCH 時視為行程本來就不存在，照樣回 stopped', async () => {
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '456',
      unlinkSyncFn: () => {},
      isPortOpenFn: async () => false,
      platformFn: () => 'linux',
      killTreeRunner: async () => {
        const err = new Error('kill ESRCH');
        err.code = 'ESRCH';
        throw err;
      },
    },
  });
  assert.deepEqual(result, { status: 'stopped', pid: 456 });
});

test('stopBackend:非 win32 平台 killTreeRunner 丟非 ESRCH 錯誤時(例如 EPERM)，回 kill-failed', async () => {
  const result = await devBrowser.stopBackend({
    pidPath: '/tmp/api-local.pid',
    port: 8787,
    deps: {
      existsSyncFn: () => true,
      readFileSyncFn: () => '456',
      unlinkSyncFn: () => {},
      isPortOpenFn: async () => true,
      platformFn: () => 'linux',
      killTreeRunner: async () => {
        const err = new Error('kill EPERM');
        err.code = 'EPERM';
        throw err;
      },
    },
  });
  assert.deepEqual(result, { status: 'kill-failed', pid: 456, error: 'kill EPERM' });
});

// ---- isProcessNotFoundError(純函式) ----

test('isProcessNotFoundError:win32 訊息含 not found 或 ERROR: The process 時視為行程不存在', () => {
  assert.equal(
    devBrowser.isProcessNotFoundError(new Error('ERROR: The process "123" not found.'), 'win32'),
    true
  );
  assert.equal(
    devBrowser.isProcessNotFoundError(new Error('some prefix ERROR: The process blah'), 'win32'),
    true
  );
  assert.equal(
    devBrowser.isProcessNotFoundError(new Error('ERROR: Access is denied.'), 'win32'),
    false,
    '權限不足不是行程不存在'
  );
  assert.equal(devBrowser.isProcessNotFoundError(null, 'win32'), false, '沒有例外物件時保守回 false');
});

test('isProcessNotFoundError:非 win32 用例外的 code === ESRCH 判斷', () => {
  const esrch = Object.assign(new Error('no such process'), { code: 'ESRCH' });
  const eperm = Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  assert.equal(devBrowser.isProcessNotFoundError(esrch, 'linux'), true);
  assert.equal(devBrowser.isProcessNotFoundError(eperm, 'linux'), false);
  assert.equal(devBrowser.isProcessNotFoundError(esrch, 'darwin'), true);
});
