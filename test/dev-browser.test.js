// test/dev-browser.test.js — tools/dev-browser.mjs 的純函式契約。
//
// dev-browser.mjs 是 ESM，主流程(啟動真正的 Chrome、CDP 連線)只在
// `import.meta.url === 直接執行的檔案` 時跑，import 進來不會有任何副作用。
// 本檔只測可 import 的純函式:
//   - parseArgs:三個環境、缺/未知 --env 報錯、--yes/--fresh/--no-open 解析、
//     同一旗標重複出現時後者覆蓋前者
//   - productionGuard:TTY/非 TTY、--yes、輸入相符/不符
//   - localNotBuiltError:local 回傳帶 code 的「尚未建置」錯誤
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
