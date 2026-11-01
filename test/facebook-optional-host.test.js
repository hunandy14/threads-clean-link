// test/facebook-optional-host.test.js — Facebook 支援做成選用權限，並與 Instagram
// 共用表驅動的站點對帳。
//
// Facebook 與 Instagram 一樣只列在 optional_host_permissions，使用者在設定頁打開
// 開關時才向 Chrome 要權限。背景端以 OPTIONAL_SITES 表逐站依「權限＋開關」對帳，
// 兩站的註冊、撤銷、重注入彼此獨立，一站失敗不影響另一站。
//
//   B1 manifest：選用 host 有 Facebook，必要 host 與靜態 content_scripts 沒有。
//   B2 設定表：TCLCore.SETTINGS_SCHEMA 的 facebookEnabled。
//   B3 background.js：OPTIONAL_SITES 表、兩站對帳互不干擾、各觸發點只動對應站、
//      重注入只打真的 facebook.com 分頁。
//   B4 options 頁：#facebookEnabled 開關在手勢內同步 request 權限、拒絕即退回、
//      授權後提示重新整理、關閉時撤權、與 Instagram 開關互不干擾。
//   B5 i18n：四顆 opFacebook* 文案 key 在 opInstagram* 覆蓋的每個語系皆存在。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createChromeStorage } = require('./support/helpers');
const { loadSwSources } = require('./support/sw-sources');
const { makeDocumentStub } = require('./support/options-dom');

const core = require(path.join(__dirname, '..', 'tcl-core.js'));
const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 150 });
test.beforeEach(reset);

const REPO_ROOT = path.join(__dirname, '..');
const IG_ORIGIN = 'https://*.instagram.com/*';
const FB_ORIGIN = 'https://*.facebook.com/*';
const IG_SCRIPT_ID = 'ig-post-icon';
const FB_SCRIPT_ID = 'fb-post-icon';
const EXT_ID = 'test-extension-id';
const POST_ICON_FILES = ['i18n.js', 'tcl-core.js', 'post-icon.js'];

function readRepo(file) {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function manifest() {
  return JSON.parse(readRepo('manifest.json'));
}

// 沙箱內建立的物件與陣列跟本 realm 的原型不同源，deepEqual 前先搬回本 realm。
function plain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function originsOf(descriptor) {
  return descriptor && Array.isArray(descriptor.origins) ? descriptor.origins : [];
}

function scriptFor(id, origin) {
  return {
    id,
    matches: [origin],
    js: POST_ICON_FILES,
    runAt: 'document_idle',
    world: 'ISOLATED',
    allFrames: false,
    persistAcrossSessions: true,
  };
}

const EXPECTED_IG_SCRIPT = scriptFor(IG_SCRIPT_ID, IG_ORIGIN);
const EXPECTED_FB_SCRIPT = scriptFor(FB_SCRIPT_ID, FB_ORIGIN);

// ============================================================
// B1 manifest
// ============================================================

test('B1-1:optional_host_permissions 含 Facebook 的 host 樣式，Instagram 仍在', () => {
  const opt = manifest().optional_host_permissions;
  assert.ok(opt.includes(FB_ORIGIN), `optional_host_permissions 應含 ${FB_ORIGIN}`);
  assert.ok(opt.includes(IG_ORIGIN), `optional_host_permissions 應保留 ${IG_ORIGIN}`);
});

test('B1-2:host_permissions 與所有 content_scripts[].matches 都不含 facebook(安裝／更新不跳權限提示)', () => {
  const m = manifest();
  m.host_permissions.forEach((p) => {
    assert.doesNotMatch(p, /facebook/i, `host_permissions 不得含 facebook：${p}`);
  });
  m.content_scripts.forEach((cs, i) => {
    (cs.matches || []).forEach((p) => {
      assert.doesNotMatch(p, /facebook/i, `content_scripts[${i}].matches 不得含 facebook：${p}`);
    });
  });
});

// ============================================================
// B2 設定表
// ============================================================

test('B2-1:SETTINGS_SCHEMA 有 facebookEnabled，area local、預設 false、只在 options 頁', () => {
  const entry = core.SETTINGS_SCHEMA.find((s) => s.key === 'facebookEnabled');
  assert.ok(entry, 'SETTINGS_SCHEMA 應有 facebookEnabled');
  assert.equal(entry.area, 'local');
  assert.equal(entry.def, false);
  assert.deepEqual(plain(entry.pages), ['options']);
  assert.deepEqual(plain(entry.label), { options: ['opFacebookName', 'opFacebookDesc'] });
});

test('B2-2:options.html 有 #facebookEnabled 開關列，#instagramEnabled 開關列保留', () => {
  const html = readRepo('options.html');
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="facebookEnabled"[^>]*class="switch"/);
  assert.match(html, /<label[^>]*class="setting-row"[^>]*for="facebookEnabled"/);
  assert.match(html, /data-i18n="opFacebookName"/);
  assert.match(html, /data-i18n="opFacebookDesc"/);
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="instagramEnabled"[^>]*class="switch"/);
});

// ============================================================
// B3 background.js
// ============================================================

// 兩站共用的背景端 chrome 替身。
//   opts.granted        { ig, fb } permissions.contains 對各 origin 的回答
//   opts.enabled        { ig, fb } local 區開關初始值(undefined = 不存在)
//   opts.registered     一開始就已註冊的 script id 陣列
//   opts.registerThrows registerContentScripts 遇到這些 id 時整批拋錯
//   opts.threadsTabs／opts.igTabs／opts.fbTabs  tabs.query 依 url 篩選回傳的分頁
function loadBackground(opts = {}) {
  const listeners = { installed: [], startup: [], permAdded: [], permRemoved: [], storageChanged: [], message: [] };
  const calls = { contains: [], getRegistered: [], register: [], unregister: [], query: [], executeScript: [] };
  const warns = [];
  const registered = (opts.registered || []).map((id) => ({ id }));
  const granted = Object.assign({ ig: false, fb: false }, opts.granted);
  const throwIds = new Set(opts.registerThrows || []);

  const enabled = opts.enabled || {};
  const localSeed = { history: [] };
  if (enabled.ig !== undefined) localSeed.instagramEnabled = enabled.ig;
  if (enabled.fb !== undefined) localSeed.facebookEnabled = enabled.fb;
  const storage = createChromeStorage({}, localSeed);
  const storageApi = Object.assign({}, storage.api, {
    onChanged: { addListener: (fn) => listeners.storageChanged.push(fn) },
  });

  const chrome = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
      onStartup: { addListener: (fn) => listeners.startup.push(fn) },
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
    permissions: {
      contains: async (descriptor) => {
        calls.contains.push(plain(descriptor));
        const origins = originsOf(descriptor);
        if (origins.length === 0) return false;
        return origins.every((o) => (o === IG_ORIGIN && granted.ig) || (o === FB_ORIGIN && granted.fb));
      },
      onAdded: { addListener: (fn) => listeners.permAdded.push(fn) },
      onRemoved: { addListener: (fn) => listeners.permRemoved.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      update: async () => {},
      onClicked: { addListener: () => {} },
    },
    notifications: { create: () => {} },
    scripting: {
      executeScript: async (injection) => {
        calls.executeScript.push(plain(injection));
        return [{}];
      },
      getRegisteredContentScripts: async (filter) => {
        calls.getRegistered.push(plain(filter));
        const ids = filter && filter.ids;
        return registered.filter((s) => !ids || ids.includes(s.id));
      },
      registerContentScripts: async (scripts) => {
        calls.register.push(plain(scripts));
        if (scripts.some((s) => throwIds.has(s.id))) throw new Error('register 失敗');
        scripts.forEach((s) => registered.push({ id: s.id }));
      },
      unregisterContentScripts: async (filter) => {
        calls.unregister.push(plain(filter));
        const ids = (filter && filter.ids) || registered.map((s) => s.id);
        for (let i = registered.length - 1; i >= 0; i--) {
          if (ids.includes(registered[i].id)) registered.splice(i, 1);
        }
      },
    },
    tabs: {
      TAB_ID_NONE: -1,
      query: async (queryInfo) => {
        calls.query.push(plain(queryInfo));
        const urls = [].concat((queryInfo && queryInfo.url) || []);
        if (urls.some((u) => /facebook/.test(u))) return opts.fbTabs || [];
        if (urls.some((u) => /instagram/.test(u))) return opts.igTabs || [];
        return opts.threadsTabs || [];
      },
    },
    storage: storageApi,
  };

  const spyConsole = Object.assign(Object.create(console), {
    warn: (...args) => warns.push(args),
    error: () => {},
    log: () => {},
  });

  const sandbox = loadSwSources({
    chrome,
    fetch: async () => {
      throw new Error('unexpected fetch');
    },
    console: spyConsole,
  });

  return {
    storage,
    calls,
    warns,
    registered,
    granted,
    listeners,
    evaluate(expr) {
      return vm.runInContext(expr, sandbox);
    },
    registeredIds() {
      return registered.map((s) => s.id).sort();
    },
    registerCallsFor(id) {
      return calls.register.filter((batch) => batch.some((s) => s.id === id));
    },
    unregisterCallsFor(id) {
      return calls.unregister.filter((f) => !f || !f.ids || f.ids.includes(id));
    },
    fireInstalled(details) {
      listeners.installed.slice().forEach((fn) => fn(details || { reason: 'update' }));
    },
    fireStartup() {
      listeners.startup.slice().forEach((fn) => fn());
    },
    firePermAdded(perms) {
      listeners.permAdded.slice().forEach((fn) => fn(perms));
    },
    firePermRemoved(perms) {
      listeners.permRemoved.slice().forEach((fn) => fn(perms));
    },
    fireStorageChanged(changes, area) {
      listeners.storageChanged.slice().forEach((fn) => fn(changes, area));
    },
  };
}

test('B3-1:OPTIONAL_SITES 依序列出 Instagram 與 Facebook 兩站，欄位照規格', () => {
  const bg = loadBackground();
  const sites = plain(bg.evaluate('OPTIONAL_SITES'));
  assert.ok(Array.isArray(sites), 'OPTIONAL_SITES 應為陣列');
  assert.equal(sites.length, 2);
  const pick = (s) => ({ key: s.key, scriptId: s.scriptId, matches: s.matches, hostSuffix: s.hostSuffix });
  assert.deepEqual(sites.map(pick), [
    { key: 'instagramEnabled', scriptId: IG_SCRIPT_ID, matches: [IG_ORIGIN], hostSuffix: 'instagram.com' },
    { key: 'facebookEnabled', scriptId: FB_SCRIPT_ID, matches: [FB_ORIGIN], hostSuffix: 'facebook.com' },
  ]);
});

test('B3-2:兩站皆有權限＋開關開 → onInstalled 各註冊一次，內容照規格(js 對齊 IG 組)', async () => {
  const bg = loadBackground({ granted: { ig: true, fb: true }, enabled: { ig: true, fb: true } });
  bg.fireInstalled({ reason: 'update' });
  await settle();
  const fbBatches = bg.registerCallsFor(FB_SCRIPT_ID);
  assert.equal(fbBatches.length, 1, 'fb-post-icon 應註冊一次');
  assert.deepEqual(fbBatches[0].find((s) => s.id === FB_SCRIPT_ID), EXPECTED_FB_SCRIPT);
  const igBatches = bg.registerCallsFor(IG_SCRIPT_ID);
  assert.equal(igBatches.length, 1, 'ig-post-icon 應註冊一次');
  assert.deepEqual(igBatches[0].find((s) => s.id === IG_SCRIPT_ID), EXPECTED_IG_SCRIPT);
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID, IG_SCRIPT_ID]);
  assert.ok(
    bg.calls.contains.some((d) => originsOf(d).includes(FB_ORIGIN)),
    '對帳前應以 permissions.contains({origins}) 確認 Facebook 權限'
  );
});

test('B3-3:只有 Facebook 有權限＋開關開 → 只註冊 fb-post-icon', async () => {
  const bg = loadBackground({ granted: { ig: false, fb: true }, enabled: { ig: true, fb: true } });
  bg.fireStartup();
  await settle();
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID]);
  assert.equal(bg.registerCallsFor(IG_SCRIPT_ID).length, 0, '沒有 Instagram 權限不得註冊 ig-post-icon');
});

test('B3-4:facebookEnabled 缺值時視同關，已註冊的 fb-post-icon 撤銷，ig-post-icon 不動', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true },
    registered: [IG_SCRIPT_ID, FB_SCRIPT_ID],
  });
  bg.fireInstalled({ reason: 'update' });
  await settle();
  assert.deepEqual(bg.registeredIds(), [IG_SCRIPT_ID]);
  assert.equal(bg.unregisterCallsFor(IG_SCRIPT_ID).length, 0, '不得撤銷 ig-post-icon');
  assert.ok(
    bg.calls.unregister.some((f) => f && Array.isArray(f.ids) && f.ids.includes(FB_SCRIPT_ID)),
    '應以 unregisterContentScripts({ids}) 撤銷 fb-post-icon'
  );
});

test('B3-5:Facebook 的 registerContentScripts 拋錯 → Instagram 照常註冊，錯誤只 console.warn', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: true },
    registerThrows: [FB_SCRIPT_ID],
  });
  assert.doesNotThrow(() => bg.fireInstalled({ reason: 'update' }));
  await settle();
  assert.ok(bg.registerCallsFor(FB_SCRIPT_ID).length >= 1, 'fb-post-icon 應嘗試註冊');
  assert.deepEqual(bg.registeredIds(), [IG_SCRIPT_ID], 'ig-post-icon 不受 Facebook 失敗影響');
  assert.ok(bg.warns.length >= 1, '失敗應以 console.warn 記錄');
});

test('B3-6:Instagram 的 registerContentScripts 拋錯 → Facebook 照常註冊', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: true },
    registerThrows: [IG_SCRIPT_ID],
  });
  bg.fireInstalled({ reason: 'update' });
  await settle();
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID], 'fb-post-icon 不受 Instagram 失敗影響');
});

test('B3-7:一站註冊失敗後，後續對另一站的觸發仍會執行(佇列不被卡住)', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: false },
    registerThrows: [IG_SCRIPT_ID],
  });
  bg.fireInstalled({ reason: 'update' });
  await settle();
  await bg.storage.local.set({ facebookEnabled: true });
  bg.fireStorageChanged({ facebookEnabled: { oldValue: false, newValue: true } }, 'local');
  await settle();
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID]);
});

test('B3-8:permissions.onAdded 帶 Facebook origin → 註冊 fb-post-icon', async () => {
  const bg = loadBackground({ granted: { fb: false }, enabled: { fb: true } });
  bg.granted.fb = true;
  bg.firePermAdded({ origins: [FB_ORIGIN], permissions: [] });
  await settle();
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID]);
});

test('B3-9:permissions.onRemoved 帶 Facebook origin → 只撤 fb-post-icon、只把 facebookEnabled 寫回 false', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: true },
    registered: [IG_SCRIPT_ID, FB_SCRIPT_ID],
  });
  bg.granted.fb = false;
  bg.firePermRemoved({ origins: [FB_ORIGIN], permissions: [] });
  await settle();
  assert.deepEqual(bg.registeredIds(), [IG_SCRIPT_ID], '只撤 fb-post-icon');
  assert.equal(bg.unregisterCallsFor(IG_SCRIPT_ID).length, 0, '不得撤銷 ig-post-icon');
  const local = bg.storage.localSnapshot();
  assert.equal(local.facebookEnabled, false, 'facebookEnabled 應寫回 false');
  assert.equal(local.instagramEnabled, true, 'instagramEnabled 不得被改動');
});

test('B3-10:permissions.onRemoved 帶 Instagram origin → fb-post-icon 與 facebookEnabled 不動', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: true },
    registered: [IG_SCRIPT_ID, FB_SCRIPT_ID],
  });
  bg.granted.ig = false;
  bg.firePermRemoved({ origins: [IG_ORIGIN], permissions: [] });
  await settle();
  assert.deepEqual(bg.registeredIds(), [FB_SCRIPT_ID]);
  assert.equal(bg.unregisterCallsFor(FB_SCRIPT_ID).length, 0, '不得撤銷 fb-post-icon');
  const local = bg.storage.localSnapshot();
  assert.equal(local.instagramEnabled, false);
  assert.equal(local.facebookEnabled, true, 'facebookEnabled 不得被改動');
});

test('B3-11:storage.onChanged 的 facebookEnabled 只動 fb-post-icon(開 → 註冊，關 → 撤銷)', async () => {
  // Instagram 刻意放在「有權限＋開關開但未註冊」的狀態：若 facebookEnabled 的變更
  // 連帶對帳 Instagram，就會多出 ig-post-icon 的註冊呼叫。
  const bg = loadBackground({ granted: { ig: true, fb: true }, enabled: { ig: true, fb: false } });
  await bg.storage.local.set({ facebookEnabled: true });
  bg.fireStorageChanged({ facebookEnabled: { oldValue: false, newValue: true } }, 'local');
  await settle();
  assert.equal(bg.registerCallsFor(FB_SCRIPT_ID).length, 1, '打開後應註冊 fb-post-icon');
  assert.deepEqual(bg.registerCallsFor(FB_SCRIPT_ID)[0], [EXPECTED_FB_SCRIPT]);

  await bg.storage.local.set({ facebookEnabled: false });
  bg.fireStorageChanged({ facebookEnabled: { oldValue: true, newValue: false } }, 'local');
  await settle();
  assert.deepEqual(bg.calls.unregister, [{ ids: [FB_SCRIPT_ID] }], '關閉後只撤銷 fb-post-icon');
  assert.equal(bg.registerCallsFor(IG_SCRIPT_ID).length, 0, 'facebookEnabled 變更不得動 ig-post-icon');
});

test('B3-12:storage.onChanged 的 instagramEnabled 不動 fb-post-icon', async () => {
  const bg = loadBackground({ granted: { ig: true, fb: true }, enabled: { ig: false, fb: true } });
  await bg.storage.local.set({ instagramEnabled: true });
  bg.fireStorageChanged({ instagramEnabled: { oldValue: false, newValue: true } }, 'local');
  await settle();
  assert.equal(bg.registerCallsFor(IG_SCRIPT_ID).length, 1);
  assert.equal(bg.registerCallsFor(FB_SCRIPT_ID).length, 0, 'instagramEnabled 變更不得動 fb-post-icon');
});

const THREADS_TABS = [{ id: 1, url: 'https://www.threads.com/' }];
const IG_TABS = [{ id: 21, url: 'https://www.instagram.com/p/AbC123/' }];
const FB_TABS = [
  { id: 31, url: 'https://www.facebook.com/fx_user_a/posts/pfbid0FXAAA' },
  { id: 32, url: 'https://facebook.com/' },
  // 以下都不該被注入：偽造網域、形近網域、非 https、URL 被權限遮蔽、無效 tabId、別站。
  { id: 33, url: 'https://facebook.com.evil.test/' },
  { id: 34, url: 'https://evilfacebook.com/' },
  { id: 35, url: 'http://www.facebook.com/' },
  { id: 36, url: undefined },
  { id: -1, url: 'https://www.facebook.com/' },
  { id: 37, url: 'https://www.instagram.com/' },
];

function isFbQuery(q) {
  return [].concat(q.url || []).some((u) => /facebook/.test(u));
}

function injectedTabIds(bg, lo, hi) {
  return bg.calls.executeScript
    .map((c) => c.target.tabId)
    .filter((id) => id >= lo && id < hi)
    .sort((a, b) => a - b);
}

test('B3-13:重注入：兩站皆開時另查 Facebook 分頁，只注入真的 facebook.com 分頁', async () => {
  const bg = loadBackground({
    granted: { ig: true, fb: true },
    enabled: { ig: true, fb: true },
    threadsTabs: THREADS_TABS,
    igTabs: IG_TABS,
    fbTabs: FB_TABS,
  });
  bg.fireInstalled({ reason: 'update' });
  await settle();

  const fb = bg.calls.query.filter(isFbQuery);
  assert.equal(fb.length, 1, 'Facebook 分頁另查一次');
  assert.deepEqual([].concat(fb[0].url), [FB_ORIGIN]);

  assert.deepEqual(
    injectedTabIds(bg, 30, 40),
    [31, 32],
    '偽造網域、形近網域、非 https、無 URL、無效 tabId、別站分頁一律過濾'
  );
  bg.calls.executeScript
    .filter((c) => c.target.tabId >= 30 && c.target.tabId < 40)
    .forEach((c) => {
      assert.deepEqual(c.files, POST_ICON_FILES);
      assert.equal(c.world, 'ISOLATED');
    });
  assert.deepEqual(injectedTabIds(bg, 20, 30), [21], 'Instagram 重注入不受影響');
  assert.equal(bg.calls.executeScript.filter((c) => c.target.tabId === 1).length, 1, 'threads 重注入不受影響');
});

for (const [granted, enabled] of [[false, true], [true, false], [false, false]]) {
  test(`B3-14:重注入：Facebook 權限 ${granted}／開關 ${enabled} 時不查也不注入 Facebook 分頁，Instagram 照常`, async () => {
    const bg = loadBackground({
      granted: { ig: true, fb: granted },
      enabled: { ig: true, fb: enabled },
      threadsTabs: THREADS_TABS,
      igTabs: IG_TABS,
      fbTabs: FB_TABS,
    });
    bg.fireInstalled({ reason: 'update' });
    await settle();
    assert.equal(bg.calls.query.filter(isFbQuery).length, 0, '不得查詢 Facebook 分頁');
    assert.deepEqual(injectedTabIds(bg, 30, 40), []);
    assert.deepEqual(injectedTabIds(bg, 20, 30), [21], 'Instagram 重注入不受影響');
  });
}

// ============================================================
// B4 options 頁
// ============================================================

// 兩站可觀測的 permissions 替身。log 記錄 storage.set(各站開關)與 permissions.*
// 的先後。
function makePermissions(opts = {}) {
  const log = [];
  const granted = Object.assign({ ig: false, fb: false }, opts.granted);
  const api = {
    containsCalls: [],
    requestCalls: [],
    removeCalls: [],
    contains(descriptor) {
      api.containsCalls.push(descriptor);
      log.push('contains');
      const origins = originsOf(descriptor);
      const ok = origins.length > 0 &&
        origins.every((o) => (o === IG_ORIGIN && granted.ig) || (o === FB_ORIGIN && granted.fb));
      return Promise.resolve(ok);
    },
    request(descriptor) {
      api.requestCalls.push(descriptor);
      log.push('request');
      if (opts.requestThrows) throw new Error('request 同步拋錯');
      if (opts.requestRejects) return Promise.reject(new Error('request reject'));
      return Promise.resolve(opts.accepted === true);
    },
    remove(descriptor) {
      api.removeCalls.push(descriptor);
      log.push('remove');
      return Promise.resolve(true);
    },
  };
  return { api, log, granted };
}

function makeOptionsCtx(perm, localSeed) {
  const storage = createChromeStorage({ langPref: 'zh' }, Object.assign({ history: [] }, localSeed));
  const localStorage = Object.assign({}, storage.local, {
    set(items) {
      for (const k of ['instagramEnabled', 'facebookEnabled']) {
        if (Object.hasOwn(items, k)) perm.log.push(`set:${k}:${items[k]}`);
      }
      return storage.local.set(items);
    },
  });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage,
    i18n,
    now: () => 100000,
    download: () => {},
    permissions: perm.api,
  });
  return { storage, doc, controller };
}

function toggle(ctx, id) {
  return ctx.doc.getElementById(id);
}

function flip(ctx, id, checked) {
  const el = toggle(ctx, id);
  el.checked = checked;
  el.fire('change', { type: 'change', target: el });
}

function writesOf(ctx, key) {
  return ctx.storage.localCalls.set.filter((s) => Object.hasOwn(s, key));
}

test('B4-1:初始：Facebook 有權限＋storage 開 → 開關顯示打開，不寫 storage', async () => {
  const perm = makePermissions({ granted: { fb: true } });
  const ctx = makeOptionsCtx(perm, { facebookEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.ok(
    perm.api.containsCalls.some((d) => originsOf(d).includes(FB_ORIGIN)),
    '初始渲染應以 contains 確認 Facebook 權限'
  );
  assert.equal(toggle(ctx, 'facebookEnabled').checked, true);
  assert.deepEqual(writesOf(ctx, 'facebookEnabled'), []);
});

test('B4-2:初始：storage 開但沒有 Facebook 權限 → 顯示關，storage 寫回 false，Instagram 不受影響', async () => {
  const perm = makePermissions({ granted: { ig: true, fb: false } });
  const ctx = makeOptionsCtx(perm, { facebookEnabled: true, instagramEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.equal(toggle(ctx, 'facebookEnabled').checked, false);
  assert.equal(ctx.storage.localSnapshot().facebookEnabled, false, 'storage 應寫回 false');
  assert.equal(toggle(ctx, 'instagramEnabled').checked, true, 'Instagram 開關維持打開');
  assert.deepEqual(writesOf(ctx, 'instagramEnabled'), []);
});

test('B4-3:打開：change handler 內同步呼叫 permissions.request({origins:[facebook]})(不先 await contains)', async () => {
  const perm = makePermissions({ accepted: true });
  const ctx = makeOptionsCtx(perm, {});
  await ctx.controller.init();
  await settle();
  const containsBefore = perm.api.containsCalls.length;

  flip(ctx, 'facebookEnabled', true);
  // 不經任何 await：request 必須在使用者手勢的同步段內發出。
  assert.equal(perm.api.requestCalls.length, 1, 'change 事件的同步段內就要呼叫 request');
  assert.deepEqual(plain(perm.api.requestCalls[0]), { origins: [FB_ORIGIN] });
  assert.equal(perm.api.containsCalls.length, containsBefore, 'request 之前不得先呼叫 contains');
  await settle();
});

test('B4-4:打開：使用者授權 → 只寫 local 的 facebookEnabled true，toast opFacebookReloadHint', async () => {
  const perm = makePermissions({ accepted: true });
  const ctx = makeOptionsCtx(perm, {});
  await ctx.controller.init();
  await settle();

  flip(ctx, 'facebookEnabled', true);
  await settle();
  assert.equal(ctx.storage.localSnapshot().facebookEnabled, true);
  assert.equal(Object.hasOwn(ctx.storage.snapshot(), 'facebookEnabled'), false, '不得寫進 sync 區');
  assert.deepEqual(writesOf(ctx, 'instagramEnabled'), [], '不得寫 instagramEnabled');
  assert.equal(toggle(ctx, 'facebookEnabled').checked, true);
  assert.equal(ctx.doc.ids.toast.textContent, i18n.t('zh', 'opFacebookReloadHint'));
});

for (const [label, permOpts] of [
  ['回 false', { accepted: false }],
  ['同步拋錯', { requestThrows: true }],
  ['Promise reject', { requestRejects: true }],
]) {
  test(`B4-5:打開：request ${label} → 開關退回關、不寫 storage、toast opFacebookPermDenied`, async () => {
    const perm = makePermissions(permOpts);
    const ctx = makeOptionsCtx(perm, {});
    await ctx.controller.init();
    await settle();

    assert.doesNotThrow(() => flip(ctx, 'facebookEnabled', true));
    await settle();
    assert.equal(perm.api.requestCalls.length, 1);
    assert.equal(toggle(ctx, 'facebookEnabled').checked, false, '開關應退回關');
    assert.deepEqual(writesOf(ctx, 'facebookEnabled'), [], '不得寫 storage(不走通用 bindSettings)');
    assert.equal(ctx.doc.ids.toast.textContent, i18n.t('zh', 'opFacebookPermDenied'));
  });
}

test('B4-6:關閉：先寫 facebookEnabled false，再 permissions.remove({origins:[facebook]})', async () => {
  const perm = makePermissions({ granted: { fb: true } });
  const ctx = makeOptionsCtx(perm, { facebookEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.equal(toggle(ctx, 'facebookEnabled').checked, true, '前提：初始為開');

  flip(ctx, 'facebookEnabled', false);
  await settle();
  assert.equal(ctx.storage.localSnapshot().facebookEnabled, false);
  assert.equal(perm.api.removeCalls.length, 1);
  assert.deepEqual(plain(perm.api.removeCalls[0]), { origins: [FB_ORIGIN] });
  const setIdx = perm.log.indexOf('set:facebookEnabled:false');
  assert.ok(
    setIdx !== -1 && setIdx < perm.log.indexOf('remove'),
    `寫 false 必須先於 remove，實際順序：${perm.log.join(' → ')}`
  );
  assert.equal(perm.api.requestCalls.length, 0, '關閉不得要權限');
});

test('B4-7:打開 Instagram 開關只要 Instagram 權限，不碰 facebookEnabled', async () => {
  const perm = makePermissions({ accepted: true });
  const ctx = makeOptionsCtx(perm, {});
  await ctx.controller.init();
  await settle();

  flip(ctx, 'instagramEnabled', true);
  assert.equal(perm.api.requestCalls.length, 1);
  assert.deepEqual(plain(perm.api.requestCalls[0]), { origins: [IG_ORIGIN] });
  await settle();
  assert.equal(ctx.storage.localSnapshot().instagramEnabled, true);
  assert.deepEqual(writesOf(ctx, 'facebookEnabled'), []);
  assert.equal(toggle(ctx, 'facebookEnabled').checked, false);
});

// ============================================================
// B5 i18n
// ============================================================

const FB_I18N_KEYS = ['opFacebookName', 'opFacebookDesc', 'opFacebookPermDenied', 'opFacebookReloadHint'];

// 以 opInstagramName 存在的語系為基準：Instagram 文案覆蓋到哪，Facebook 就要到哪。
function igLocales() {
  return Object.keys(i18n.STRINGS).filter((loc) => Object.hasOwn(i18n.STRINGS[loc], 'opInstagramName'));
}

test('B5-1:四顆 Facebook 文案 key 在 opInstagram* 覆蓋的每個語系皆存在、非空且提到 Facebook', () => {
  const locales = igLocales();
  assert.ok(locales.includes('zh') && locales.includes('en'), '基準語系至少含 zh 與 en');
  for (const locale of locales) {
    for (const key of FB_I18N_KEYS) {
      const value = i18n.STRINGS[locale][key];
      assert.equal(typeof value, 'string', `${locale}.${key} 應為字串`);
      assert.ok(value.length > 0, `${locale}.${key} 不得為空字串`);
      assert.match(value, /facebook/i, `${locale}.${key} 應提到 Facebook，實際：${value}`);
    }
  }
});

test('B5-2:zh 的 Facebook 文案一律全形逗號「，」，不得出現半形 ","', () => {
  for (const key of FB_I18N_KEYS) {
    const value = i18n.STRINGS.zh[key];
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(','), `zh.${key} 不得含半形逗號，實際：${value}`);
  }
});
