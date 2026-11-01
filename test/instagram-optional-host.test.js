// test/instagram-optional-host.test.js — Instagram 支援做成選用權限的行為契約。
//
// 安裝與更新不跳權限提示：Instagram 只列在 optional_host_permissions，不進
// host_permissions，也不進 manifest 的 content_scripts。使用者在設定頁打開
// 開關時才向 Chrome 要權限，背景端依「權限＋開關」兩者對帳，動態註冊或撤銷
// Instagram 的 content script。
//
//   B1 manifest：選用 host 有 Instagram，必要 host 與靜態 content_scripts 沒有。
//   B2 設定表：TCLCore.SETTINGS_SCHEMA 的 instagramEnabled。
//   B3 background.js：IG_SCRIPT／IG_REINJECT_FILES 常數、reconcileInstagramScript
//      的四種組合、各觸發點、權限被撤銷時的收尾、更新後對 Instagram 分頁的重注入。
//   B4 options 頁：開關在手勢內同步 request 權限、拒絕即退回、關閉時撤權、
//      初始渲染以「權限＋開關」雙條件決定勾選。
//   B5 i18n：四顆文案 key 在 zh 與 en 兩份字典皆存在且非空。
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
const IG_SCRIPT_ID = 'ig-post-icon';
const EXT_ID = 'test-extension-id';

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

function hasIgOrigin(descriptor) {
  return !!(descriptor && Array.isArray(descriptor.origins) && descriptor.origins.includes(IG_ORIGIN));
}

// manifest 的 ISOLATED 組(document_idle、不是 MAIN world、含 post-icon.js 的那組)。
function isolatedIdleGroup() {
  const group = manifest().content_scripts.find(
    (cs) => cs.world !== 'MAIN' && Array.isArray(cs.js) && cs.js.includes('post-icon.js')
  );
  assert.ok(group, 'manifest 應有含 post-icon.js 的 ISOLATED world content_scripts 組');
  return group;
}

// ============================================================
// B1 manifest
// ============================================================

test('B1:optional_host_permissions 含 Instagram 的 host 樣式', () => {
  assert.ok(
    manifest().optional_host_permissions.includes(IG_ORIGIN),
    `optional_host_permissions 應含 ${IG_ORIGIN}`
  );
});

test('B1:host_permissions 與所有 content_scripts[].matches 都不含 instagram(安裝／更新不跳權限提示)', () => {
  const m = manifest();
  m.host_permissions.forEach((p) => {
    assert.doesNotMatch(p, /instagram/i, `host_permissions 不得含 instagram：${p}`);
  });
  m.content_scripts.forEach((cs, i) => {
    (cs.matches || []).forEach((p) => {
      assert.doesNotMatch(p, /instagram/i, `content_scripts[${i}].matches 不得含 instagram：${p}`);
    });
  });
});

// ============================================================
// B2 設定表
// ============================================================

test('B2:SETTINGS_SCHEMA 有 instagramEnabled，area local、預設 false、只在 options 頁', () => {
  const entry = core.SETTINGS_SCHEMA.find((s) => s.key === 'instagramEnabled');
  assert.ok(entry, 'SETTINGS_SCHEMA 應有 instagramEnabled');
  assert.equal(entry.area, 'local');
  assert.equal(entry.def, false);
  assert.deepEqual(plain(entry.pages), ['options']);
  assert.deepEqual(plain(entry.label), { options: ['opInstagramName', 'opInstagramDesc'] });
});

test('B2:options.html 的設定卡有 #instagramEnabled 開關，名稱與說明走 i18n', () => {
  const html = readRepo('options.html');
  assert.match(html, /<input[^>]*type="checkbox"[^>]*id="instagramEnabled"[^>]*class="switch"/);
  assert.match(html, /<label[^>]*class="setting-row"[^>]*for="instagramEnabled"/);
  assert.match(html, /data-i18n="opInstagramName"/);
  assert.match(html, /data-i18n="opInstagramDesc"/);
});

// ============================================================
// B3 background.js
// ============================================================

// 背景端的完整 chrome 替身：權限、動態註冊、分頁查詢、執行注入全部可觀測。
//   opts.granted       permissions.contains 對 Instagram origin 的回答
//   opts.enabled       local 區 instagramEnabled 的初始值(undefined = 不存在)
//   opts.registered    一開始就已註冊 ig-post-icon
//   opts.threadsTabs／opts.igTabs   tabs.query 依 url 篩選回傳的分頁
//   opts.registerThrows  registerContentScripts 拋錯
function loadBackground(opts = {}) {
  const listeners = {
    installed: [],
    startup: [],
    permAdded: [],
    permRemoved: [],
    storageChanged: [],
    message: [],
  };
  const calls = {
    contains: [],
    getRegistered: [],
    register: [],
    unregister: [],
    query: [],
    executeScript: [],
  };
  const warns = [];
  const registered = opts.registered ? [{ id: IG_SCRIPT_ID }] : [];
  const state = { granted: opts.granted === true };

  const localSeed = { history: [] };
  if (opts.enabled !== undefined) localSeed.instagramEnabled = opts.enabled;
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
        return hasIgOrigin(descriptor) ? state.granted : false;
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
        if (opts.registerThrows) throw new Error('register 失敗');
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
    chrome,
    sandbox,
    storage,
    calls,
    warns,
    registered,
    state,
    listeners,
    evaluate(expr) {
      return vm.runInContext(expr, sandbox);
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

const EXPECTED_IG_SCRIPT = {
  id: 'ig-post-icon',
  matches: ['https://*.instagram.com/*'],
  js: ['i18n.js', 'tcl-core.js', 'post-icon.js'],
  runAt: 'document_idle',
  world: 'ISOLATED',
  allFrames: false,
  persistAcrossSessions: true,
};

test('B3:IG_SCRIPT 常數照規格，js 順序等於 manifest ISOLATED 組的前三支', () => {
  const bg = loadBackground();
  const igScript = plain(bg.evaluate('siteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))'));
  assert.deepEqual(igScript, EXPECTED_IG_SCRIPT);
  assert.deepEqual(igScript.js, isolatedIdleGroup().js.slice(0, 3), 'js 需對齊 manifest ISOLATED 組的前三支');
});

test('B3:IG_REINJECT_FILES 等於 IG_SCRIPT.js', () => {
  const bg = loadBackground();
  assert.deepEqual(plain(bg.evaluate('OPTIONAL_SITE_FILES')), plain(bg.evaluate('siteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon")).js')));
});

test('B3 對帳:有權限＋開關開 → 未註冊就註冊一次，內容等於 IG_SCRIPT', async () => {
  const bg = loadBackground({ granted: true, enabled: true });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.ok(
    bg.calls.contains.some((d) => hasIgOrigin(d)),
    '對帳前應以 permissions.contains({origins}) 確認 Instagram 權限'
  );
  assert.equal(bg.calls.register.length, 1, 'registerContentScripts 應呼叫一次');
  assert.deepEqual(bg.calls.register[0], [EXPECTED_IG_SCRIPT]);
  assert.equal(bg.calls.unregister.length, 0);
});

test('B3 對帳:有權限＋開關開，但 ID 已註冊 → 不重複註冊', async () => {
  const bg = loadBackground({ granted: true, enabled: true, registered: true });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.ok(
    bg.calls.getRegistered.some((f) => f && Array.isArray(f.ids) && f.ids.includes(IG_SCRIPT_ID)),
    '應以 getRegisteredContentScripts({ids}) 查詢既有註冊'
  );
  assert.equal(bg.calls.register.length, 0, '已註冊時不得再呼叫 registerContentScripts(重複 id 會整批失敗)');
  assert.equal(bg.calls.unregister.length, 0);
});

test('B3 對帳:有權限＋開關關 → 已註冊就撤銷', async () => {
  const bg = loadBackground({ granted: true, enabled: false, registered: true });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.equal(bg.calls.register.length, 0);
  assert.equal(bg.calls.unregister.length, 1);
  assert.deepEqual(bg.calls.unregister[0], { ids: [IG_SCRIPT_ID] });
});

test('B3 對帳:沒權限＋開關開 → 已註冊就撤銷', async () => {
  const bg = loadBackground({ granted: false, enabled: true, registered: true });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.equal(bg.calls.register.length, 0);
  assert.equal(bg.calls.unregister.length, 1);
  assert.deepEqual(bg.calls.unregister[0], { ids: [IG_SCRIPT_ID] });
});

test('B3 對帳:沒權限＋開關關(未註冊) → 註冊與撤銷都不呼叫', async () => {
  const bg = loadBackground({ granted: false, enabled: false });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.equal(bg.calls.register.length, 0);
  assert.equal(bg.calls.unregister.length, 0, '本來就沒註冊，不需撤銷');
});

test('B3 對帳:開關缺值時視同關(預設 false)', async () => {
  const bg = loadBackground({ granted: true, registered: true });
  await bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))');
  await settle();
  assert.equal(bg.calls.register.length, 0);
  assert.equal(bg.calls.unregister.length, 1);
});

test('B3 對帳:registerContentScripts 拋錯只 console.warn，不外拋', async () => {
  const bg = loadBackground({ granted: true, enabled: true, registerThrows: true });
  await assert.doesNotReject(Promise.resolve(bg.evaluate('reconcileSiteScript(OPTIONAL_SITES.find((s) => s.scriptId === "ig-post-icon"))')));
  await settle();
  assert.equal(bg.calls.register.length, 1);
  assert.ok(bg.warns.length >= 1, '失敗應以 console.warn 記錄');
});

test('B3 觸發:runtime.onInstalled 會對帳', async () => {
  const bg = loadBackground({ granted: true, enabled: true });
  bg.fireInstalled({ reason: 'update' });
  await settle();
  assert.equal(bg.calls.register.length, 1);
});

test('B3 觸發:runtime.onStartup 會對帳', async () => {
  const bg = loadBackground({ granted: true, enabled: true });
  assert.ok(bg.listeners.startup.length >= 1, '應在頂層掛 runtime.onStartup');
  bg.fireStartup();
  await settle();
  assert.equal(bg.calls.register.length, 1);
});

test('B3 觸發:permissions.onAdded 帶 Instagram origin 會對帳', async () => {
  const bg = loadBackground({ granted: false, enabled: true });
  assert.ok(bg.listeners.permAdded.length >= 1, '應在頂層掛 permissions.onAdded');
  bg.state.granted = true;
  bg.firePermAdded({ origins: [IG_ORIGIN], permissions: [] });
  await settle();
  assert.equal(bg.calls.register.length, 1);
});

test('B3 觸發:storage.onChanged 的 instagramEnabled 會對帳(開 → 註冊，關 → 撤銷)', async () => {
  const bg = loadBackground({ granted: true, enabled: false });
  await bg.storage.local.set({ instagramEnabled: true });
  bg.fireStorageChanged({ instagramEnabled: { oldValue: false, newValue: true } }, 'local');
  await settle();
  assert.equal(bg.calls.register.length, 1, '打開後應註冊');

  await bg.storage.local.set({ instagramEnabled: false });
  bg.fireStorageChanged({ instagramEnabled: { oldValue: true, newValue: false } }, 'local');
  await settle();
  assert.equal(bg.calls.unregister.length, 1, '關閉後應撤銷');
  assert.deepEqual(bg.calls.unregister[0], { ids: [IG_SCRIPT_ID] });
});

test('B3 觸發:permissions.onRemoved 帶 Instagram origin → 撤銷註冊並把 instagramEnabled 寫回 false', async () => {
  const bg = loadBackground({ granted: true, enabled: true, registered: true });
  assert.ok(bg.listeners.permRemoved.length >= 1, '應在頂層掛 permissions.onRemoved');
  bg.state.granted = false;
  bg.firePermRemoved({ origins: [IG_ORIGIN], permissions: [] });
  await settle();
  assert.ok(
    bg.calls.unregister.some((f) => f && Array.isArray(f.ids) && f.ids.includes(IG_SCRIPT_ID)),
    '權限被撤銷時應 unregister ig-post-icon'
  );
  assert.equal(bg.storage.localSnapshot().instagramEnabled, false, '開關應寫回 false');
});

test('B3 容錯:chrome 缺 permissions／onStartup／動態註冊 API 時照樣載入，onInstalled 不拋錯', async () => {
  const onInstalled = [];
  const chrome = {
    runtime: {
      id: EXT_ID,
      onInstalled: { addListener: (fn) => onInstalled.push(fn) },
      onMessage: { addListener: () => {} },
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{}] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
    storage: createChromeStorage({}, { history: [], instagramEnabled: true }).api,
  };
  const quiet = Object.assign(Object.create(console), { warn: () => {}, error: () => {}, log: () => {} });
  assert.doesNotThrow(() =>
    loadSwSources({ chrome, fetch: async () => { throw new Error('unexpected fetch'); }, console: quiet })
  );
  assert.doesNotThrow(() => onInstalled.forEach((fn) => fn({ reason: 'update' })));
  await settle();
});

test('B3 容錯:permissions 物件存在但沒有 onAdded／onRemoved 時照樣載入', () => {
  const chrome = {
    runtime: { id: EXT_ID, onInstalled: { addListener: () => {} }, onMessage: { addListener: () => {} } },
    permissions: { contains: async () => false },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{}] },
    tabs: { TAB_ID_NONE: -1 },
    storage: createChromeStorage({}, {}).api,
  };
  assert.doesNotThrow(() =>
    loadSwSources({ chrome, fetch: async () => { throw new Error('unexpected fetch'); }, console })
  );
});

const THREADS_TABS = [{ id: 1, url: 'https://www.threads.com/' }];
const IG_TABS = [
  { id: 21, url: 'https://www.instagram.com/p/AbC123/' },
  { id: 22, url: 'https://instagram.com/' },
  // 以下都不該被注入：偽造網域、形近網域、非 https、URL 被權限遮蔽、無效 tabId。
  { id: 23, url: 'https://instagram.com.evil.test/' },
  { id: 24, url: 'https://evilinstagram.com/' },
  { id: 25, url: 'http://www.instagram.com/' },
  { id: 26, url: undefined },
  { id: -1, url: 'https://www.instagram.com/' },
];

function isIgQuery(q) {
  return [].concat(q.url || []).some((u) => /instagram/.test(u));
}

function igQueries(bg) {
  return bg.calls.query.filter(isIgQuery);
}

test('B3 重注入:有權限＋開關開時，onInstalled 另查 Instagram 分頁並只注入真的 instagram.com 分頁', async () => {
  const bg = loadBackground({ granted: true, enabled: true, threadsTabs: THREADS_TABS, igTabs: IG_TABS });
  bg.fireInstalled({ reason: 'update' });
  await settle();

  const ig = igQueries(bg);
  assert.equal(ig.length, 1, 'Instagram 分頁另查一次');
  assert.deepEqual([].concat(ig[0].url), [IG_ORIGIN]);

  const threadsQueries = bg.calls.query.filter((q) => !isIgQuery(q));
  assert.equal(threadsQueries.length, 1, 'threads 那次查詢維持一次，不與 Instagram 合併');
  assert.deepEqual([].concat(threadsQueries[0].url), ['https://*.threads.com/*', 'https://*.threads.net/*']);

  const igInjections = bg.calls.executeScript.filter((c) => c.target.tabId >= 20);
  assert.deepEqual(
    igInjections.map((c) => c.target.tabId).sort((a, b) => a - b),
    [21, 22],
    '偽造網域、形近網域、非 https、無 URL、無效 tabId 一律過濾'
  );
  igInjections.forEach((c) => {
    assert.deepEqual(c.files, EXPECTED_IG_SCRIPT.js, 'Instagram 分頁注入 IG_REINJECT_FILES');
    assert.equal(c.world, 'ISOLATED');
  });

  const threadsInjections = bg.calls.executeScript.filter((c) => c.target.tabId === 1);
  assert.equal(threadsInjections.length, 1, 'threads 分頁照舊重注入');
  assert.deepEqual(threadsInjections[0].files, ['bridge.js', 'i18n.js', 'tcl-core.js', 'post-icon.js', 'scam-guard.js']);
});

for (const [granted, enabled] of [[false, true], [true, false], [false, false]]) {
  test(`B3 重注入:權限 ${granted}／開關 ${enabled} 時不查也不注入 Instagram 分頁`, async () => {
    const bg = loadBackground({ granted, enabled, threadsTabs: THREADS_TABS, igTabs: IG_TABS });
    bg.fireInstalled({ reason: 'update' });
    await settle();
    assert.equal(igQueries(bg).length, 0, '不得查詢 Instagram 分頁');
    assert.equal(bg.calls.executeScript.filter((c) => c.target.tabId >= 20).length, 0);
    assert.equal(bg.calls.executeScript.filter((c) => c.target.tabId === 1).length, 1, 'threads 重注入不受影響');
  });
}

// ============================================================
// B4 options 頁
// ============================================================

// 可觀測的 permissions 替身。log 記錄 storage.set(instagramEnabled)與
// permissions.* 的先後。
function makeIgPermissions(opts = {}) {
  const log = [];
  const state = { granted: opts.granted === true };
  const api = {
    containsCalls: [],
    requestCalls: [],
    removeCalls: [],
    contains(descriptor) {
      api.containsCalls.push(descriptor);
      log.push('contains');
      return Promise.resolve(hasIgOrigin(descriptor) ? state.granted : false);
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
  return { api, log, state };
}

function makeIgOptionsCtx(perm, localSeed) {
  const storage = createChromeStorage({ langPref: 'zh' }, Object.assign({ history: [] }, localSeed));
  const localStorage = Object.assign({}, storage.local, {
    set(items) {
      if (Object.hasOwn(items, 'instagramEnabled')) perm.log.push('set:' + items.instagramEnabled);
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

function igToggle(ctx) {
  return ctx.doc.getElementById('instagramEnabled');
}

function flip(ctx, checked) {
  const el = igToggle(ctx);
  el.checked = checked;
  el.fire('change', { type: 'change', target: el });
}

function igWrites(ctx) {
  return ctx.storage.localCalls.set.filter((s) => Object.hasOwn(s, 'instagramEnabled'));
}

test('B4 初始:有權限＋storage 開 → 開關顯示打開', async () => {
  const perm = makeIgPermissions({ granted: true });
  const ctx = makeIgOptionsCtx(perm, { instagramEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.ok(perm.api.containsCalls.some(hasIgOrigin), '初始渲染應以 contains 確認 Instagram 權限');
  assert.equal(igToggle(ctx).checked, true);
  assert.deepEqual(igWrites(ctx), [], '狀態一致時不寫 storage');
});

test('B4 初始:storage 開但沒有權限 → 顯示關，並把 storage 寫回 false', async () => {
  const perm = makeIgPermissions({ granted: false });
  const ctx = makeIgOptionsCtx(perm, { instagramEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.equal(igToggle(ctx).checked, false);
  assert.equal(ctx.storage.localSnapshot().instagramEnabled, false, 'storage 應寫回 false');
});

test('B4 初始:有權限但 storage 關 → 顯示關，不寫 storage', async () => {
  const perm = makeIgPermissions({ granted: true });
  const ctx = makeIgOptionsCtx(perm, { instagramEnabled: false });
  await ctx.controller.init();
  await settle();
  assert.equal(igToggle(ctx).checked, false);
  assert.deepEqual(igWrites(ctx), []);
});

test('B4 打開:change handler 內同步呼叫 permissions.request(不先 await contains)', async () => {
  const perm = makeIgPermissions({ granted: false, accepted: true });
  const ctx = makeIgOptionsCtx(perm, {});
  await ctx.controller.init();
  await settle();
  const containsBefore = perm.api.containsCalls.length;

  flip(ctx, true);
  // 不經任何 await：request 必須在使用者手勢的同步段內發出。
  assert.equal(perm.api.requestCalls.length, 1, 'change 事件的同步段內就要呼叫 request');
  assert.deepEqual(plain(perm.api.requestCalls[0]), { origins: [IG_ORIGIN] });
  assert.equal(perm.api.containsCalls.length, containsBefore, 'request 之前不得先呼叫 contains');
  await settle();
});

test('B4 打開:使用者授權 → 寫 instagramEnabled true(只寫 local)，並提示重新整理既開分頁', async () => {
  const perm = makeIgPermissions({ granted: false, accepted: true });
  const ctx = makeIgOptionsCtx(perm, {});
  await ctx.controller.init();
  await settle();

  flip(ctx, true);
  await settle();
  assert.equal(ctx.storage.localSnapshot().instagramEnabled, true);
  assert.equal(Object.hasOwn(ctx.storage.snapshot(), 'instagramEnabled'), false, '不得寫進 sync 區');
  assert.equal(igToggle(ctx).checked, true);
  assert.equal(ctx.doc.ids.toast.textContent, i18n.t('zh', 'opInstagramReloadHint'));
});

for (const [label, permOpts] of [
  ['回 false', { accepted: false }],
  ['同步拋錯', { requestThrows: true }],
  ['Promise reject', { requestRejects: true }],
]) {
  test(`B4 打開:request ${label} → 開關退回關、不寫 storage、toast 權限被拒`, async () => {
    const perm = makeIgPermissions(Object.assign({ granted: false }, permOpts));
    const ctx = makeIgOptionsCtx(perm, {});
    await ctx.controller.init();
    await settle();

    assert.doesNotThrow(() => flip(ctx, true));
    await settle();
    assert.equal(perm.api.requestCalls.length, 1);
    assert.equal(igToggle(ctx).checked, false, '開關應退回關');
    assert.deepEqual(igWrites(ctx), [], '不得寫 storage(不走通用 bindSettings)');
    assert.equal(ctx.doc.ids.toast.textContent, i18n.t('zh', 'opInstagramPermDenied'));
  });
}

test('B4 關閉:先寫 instagramEnabled false，再 permissions.remove', async () => {
  const perm = makeIgPermissions({ granted: true });
  const ctx = makeIgOptionsCtx(perm, { instagramEnabled: true });
  await ctx.controller.init();
  await settle();
  assert.equal(igToggle(ctx).checked, true, '前提:初始為開');

  flip(ctx, false);
  await settle();
  assert.equal(ctx.storage.localSnapshot().instagramEnabled, false);
  assert.equal(perm.api.removeCalls.length, 1);
  assert.deepEqual(plain(perm.api.removeCalls[0]), { origins: [IG_ORIGIN] });
  assert.ok(
    perm.log.indexOf('set:false') !== -1 && perm.log.indexOf('set:false') < perm.log.indexOf('remove'),
    `寫 false 必須先於 remove，實際順序：${perm.log.join(' → ')}`
  );
  assert.equal(perm.api.requestCalls.length, 0, '關閉不得要權限');
});

test('B4 接線:options-init.js 把 chrome.permissions.remove 接進 permissions 依賴', () => {
  const src = readRepo('options-init.js');
  assert.match(src, /chrome\.permissions\.remove\(/);
});

// ============================================================
// B5 i18n
// ============================================================

const IG_I18N_KEYS = ['opInstagramName', 'opInstagramDesc', 'opInstagramPermDenied', 'opInstagramReloadHint'];

test('B5:四顆 Instagram 文案 key 在 zh 與 en 兩份字典皆存在且非空', () => {
  for (const locale of ['zh', 'en']) {
    for (const key of IG_I18N_KEYS) {
      const value = i18n.STRINGS[locale][key];
      assert.equal(typeof value, 'string', `${locale}.${key} 應為字串`);
      assert.ok(value.length > 0, `${locale}.${key} 不得為空字串`);
    }
  }
});

test('B5:zh 文案一律全形逗號「，」，不得出現半形 ","', () => {
  for (const key of IG_I18N_KEYS) {
    const value = i18n.STRINGS.zh[key];
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(','), `zh.${key} 不得含半形逗號，實際：${value}`);
  }
});
