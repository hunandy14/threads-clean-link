// test/options-render.test.js — options 頁的 render 分派(onStorageChanged ＋
// VIEWS／VIEW_ORDER／KEY_VIEWS)與帳號區 view-model(accountView ＋
// applyAccountView)的行為契約。
//
// 視圖有沒有重畫，一律從 DOM 存取觀察，不偷看內部函式:
// - i18n     document.querySelectorAll('[data-i18n]') 被呼叫
// - history  getElementById('rows')(renderList 的第一步)
// - scam     getElementById('scamList')(renderScamList)
// - scamBar  getElementById('scamDisabledBar')(renderScamDisabledBar)
// - account  getElementById('acctSignInBtn')(帳號區每次重畫都會寫它的 hidden)
// 由 instrument() 把這些存取依發生順序記進 log。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createChromeStorage } = require('./support/helpers');
const { makeDocumentStub, isPopoverOpen } = require('./support/options-dom');

const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

const NOW = 1767225600000;
const URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const AVATAR = 'https://lh3.googleusercontent.com/a/x';

const SCAM_ID_A = '10000000001';
const SCAM_ID_B = '10987654321';

function blocklist(ids) {
  const entries = {};
  const handleIndex = {};
  ids.forEach((id, i) => {
    const handle = 'author_' + i;
    entries[id] = {
      handle,
      evidence: [{ postUrl: `https://www.threads.com/@${handle}/post/DxSyNtH000${i}`, snippet: '賴：ex01abc', at: NOW - 3600000 }],
      addedAt: NOW - 3600000,
      source: 'auto',
    };
    handleIndex[handle] = id;
  });
  return { version: 1, entries, handleIndex, allowlist: {} };
}

const STATES = {
  signedOut: {
    status: 'signed_out', email: null, displayName: null, avatarUrl: null,
    lastSyncedAt: null, pendingCount: 0, lastError: null, apiBase: '',
  },
  signedIn: {
    status: 'signed_in', email: 'ada@example.com', displayName: 'Ada', avatarUrl: AVATAR,
    lastSyncedAt: NOW - 120000, pendingCount: 3, lastError: null, apiBase: '',
  },
  expired: {
    status: 'signed_out', email: 'ada@example.com', displayName: 'Ada', avatarUrl: AVATAR,
    lastSyncedAt: NOW - 120000, pendingCount: 0, lastError: 'session_expired', apiBase: '',
  },
  syncing: {
    status: 'syncing', email: 'ada@example.com', displayName: 'Ada', avatarUrl: null,
    lastSyncedAt: null, pendingCount: 0, lastError: null, apiBase: '',
  },
};

function makeCtx(opts) {
  const o = opts || {};
  const storage = createChromeStorage(Object.assign({ langPref: 'zh' }, o.sync || {}), o.local || { history: [] });
  const doc = makeDocumentStub();
  const state = o.state || STATES.signedOut;
  const runtime = {
    sendMessage: (m) => Promise.resolve(m && m.type === 'sync.getState' ? state : undefined),
  };
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => NOW,
    runtime,
    download: () => {},
  });
  return { storage, doc, controller };
}

const WATCH = { rows: 'history', scamList: 'scam', scamDisabledBar: 'scamBar', acctSignInBtn: 'account' };

// i18nNodes:要讓 '[data-i18n]' 掃到的節點 id(各自帶上 data-i18n 屬性)。
function instrument(doc, i18nNodes) {
  const log = [];
  const origGet = doc.getElementById.bind(doc);
  doc.getElementById = (id) => {
    if (WATCH[id]) log.push(WATCH[id]);
    return origGet(id);
  };
  doc.querySelectorAll = (sel) => {
    if (sel === '[data-i18n]') {
      log.push('i18n');
      return (i18nNodes || []).map((id) => doc.ids[id]).filter(Boolean);
    }
    return [];
  };
  return {
    log,
    clear() {
      log.length = 0;
    },
    count(name) {
      return log.filter((x) => x === name).length;
    },
    views() {
      return [...new Set(log)];
    },
  };
}

function assertHasOnStorageChanged(controller) {
  assert.equal(typeof controller.onStorageChanged, 'function', 'controller 應匯出 onStorageChanged(changes, area)');
}

// ---- RD1:history 變動只重畫 history 視圖 ----

test('RD1:onStorageChanged({history}, local) 只重畫紀錄視圖，確認框文案不被 i18n 重設、名單節點與帳號區不動', async () => {
  const ctx = makeCtx({
    local: { history: [{ url: URL_A, kind: 'share', at: NOW - 5000 }], scamBlocklist: blocklist([SCAM_ID_A, SCAM_ID_B]) },
  });
  const spy = instrument(ctx.doc);
  await ctx.controller.init();
  await settle();
  assertHasOnStorageChanged(ctx.controller);

  // 從詳細視窗的「刪除」開確認框:標題與確認鈕換成刪除這筆的文案，和它們
  // 在 HTML 裡的 data-i18n 初值(清除全部)不同。
  ctx.doc.getElementById('confirmTitleText').setAttribute('data-i18n', 'opClearAll');
  ctx.doc.getElementById('confirmOk').setAttribute('data-i18n', 'opClearDo');
  ctx.doc.ids.rows.children[0].fire('click');
  ctx.doc.ids.detailDeleteBtn.fire('click');
  assert.equal(ctx.doc.ids.confirmOverlay.open, true, '前提:確認框開著');
  const titleBefore = ctx.doc.ids.confirmTitleText.textContent;
  const okBefore = ctx.doc.ids.confirmOk.textContent;
  assert.equal(titleBefore, i18n.t('zh', 'opDeleteTitle'));
  assert.notEqual(titleBefore, i18n.t('zh', 'opClearAll'), '前提:標題與 data-i18n 初值不同，i18n 一跑就測得出來');

  // 讓 i18n 真的掃得到確認框兩個節點。
  const spy2 = instrument(ctx.doc, ['confirmTitleText', 'confirmOk']);
  const scamRowsBefore = ctx.doc.ids.scamList.children.slice();
  assert.ok(scamRowsBefore.length > 0, '前提:名單有列');
  const cardBefore = ctx.doc.ids.rows.children[0];
  spy.clear();

  ctx.controller.onStorageChanged(
    { history: { newValue: [{ url: URL_B, kind: 'strip', at: NOW - 1000 }, { url: URL_A, kind: 'share', at: NOW - 5000 }] } },
    'local'
  );

  assert.deepEqual(spy2.views(), ['history'], 'history 變動只該重畫紀錄視圖');
  assert.equal(spy2.count('i18n'), 0, 'history 路徑不跑 i18n');
  assert.equal(spy2.count('account'), 0, '帳號區不重畫');
  assert.equal(ctx.doc.ids.confirmTitleText.textContent, titleBefore, '確認框標題不被 data-i18n 初值蓋掉');
  assert.equal(ctx.doc.ids.confirmOk.textContent, okBefore, '確認鈕文案不被 data-i18n 初值蓋掉');
  assert.equal(ctx.doc.ids.confirmOverlay.open, true, '確認框仍開著');
  assert.equal(ctx.doc.ids.rows.children.length, 2, '紀錄清單換成新資料');
  assert.notEqual(ctx.doc.ids.rows.children[1], cardBefore, '紀錄卡片確實重建');
  const scamRowsAfter = ctx.doc.ids.scamList.children;
  assert.equal(scamRowsAfter.length, scamRowsBefore.length);
  scamRowsBefore.forEach((row, i) => assert.equal(scamRowsAfter[i], row, `名單第 ${i} 列節點不得重建`));
});

// ---- RD2:各鍵只重畫自己的視圖 ----

async function initInstrumented(opts) {
  const ctx = makeCtx(opts);
  const spy = instrument(ctx.doc);
  await ctx.controller.init();
  await settle();
  assertHasOnStorageChanged(ctx.controller);
  spy.clear();
  return Object.assign(ctx, { spy });
}

test('RD2:{scamBlocklist} 只重畫名單(含狀態列)，紀錄、帳號、i18n 都不動', async () => {
  const ctx = await initInstrumented({
    local: { history: [{ url: URL_A, kind: 'share', at: NOW - 5000 }], scamBlocklist: blocklist([SCAM_ID_A, SCAM_ID_B]) },
  });
  const cardBefore = ctx.doc.ids.rows.children[0];

  ctx.controller.onStorageChanged({ scamBlocklist: { newValue: blocklist([SCAM_ID_A]) } }, 'local');

  assert.ok(ctx.spy.count('scam') >= 1, '名單應重畫');
  assert.equal(ctx.spy.count('history'), 0, '紀錄視圖不重畫');
  assert.equal(ctx.spy.count('account'), 0, '帳號區不重畫');
  assert.equal(ctx.spy.count('i18n'), 0, '不跑 i18n');
  assert.equal(ctx.doc.ids.scamList.children.length, 1, '名單換成新資料');
  assert.equal(ctx.doc.ids.rows.children[0], cardBefore, '紀錄卡片節點不變');
});

test('RD2:{scamGuardEnabled} 只重畫狀態列並更新開關', async () => {
  const ctx = await initInstrumented({ local: { history: [], scamBlocklist: blocklist([SCAM_ID_A]) } });
  const rowBefore = ctx.doc.ids.scamList.children[0];

  ctx.controller.onStorageChanged({ scamGuardEnabled: { newValue: false, oldValue: true } }, 'local');

  assert.deepEqual(ctx.spy.views(), ['scamBar'], '只重畫狀態列');
  assert.equal(ctx.doc.ids.scamGuardEnabled.checked, false, '開關跟著反映');
  assert.equal(ctx.doc.ids.scamDisabledBar.hidden, false, '關閉時顯示狀態列');
  assert.equal(ctx.doc.ids.scamList.children[0], rowBefore, '名單列節點不變');
});

test('RD2:{syncState} 不重畫任何視圖，只更新刪除分流用的 syncAccount', async () => {
  const entry = {
    url: URL_A, kind: 'share', at: 1000, seen: [{ at: 1000, kind: 'share' }], id: 'id-1000',
    postKey: 'pk-1000', original: URL_A, receivedAt: 1000, dirty: false, serverUpdatedAt: null, deletedAt: null,
  };
  const signedOutAccount = { userId: null, email: null, cursor: null, lastSyncedAt: null, lastError: null };
  const signedInAccount = { userId: 'user-1', email: 'a@example.com', cursor: null, lastSyncedAt: null, lastError: null };
  const ctx = await initInstrumented({ local: { history: [entry], syncState: signedOutAccount } });

  ctx.controller.onStorageChanged({ syncState: { newValue: signedInAccount, oldValue: signedOutAccount } }, 'local');
  assert.deepEqual(ctx.spy.log, [], 'syncState 變動不重畫任何視圖');

  ctx.doc.ids.rows.children[0].fire('click');
  ctx.doc.ids.detailDeleteBtn.fire('click');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();
  const history = ctx.storage.localSnapshot().history;
  assert.equal(history.length, 1, '已登入走軟刪，墓碑留在陣列');
  assert.equal(typeof history[0].deletedAt, 'number');
});

test('RD2:{langPref} 全部重畫，i18n 最先、帳號區在 i18n 之後且只畫一次', async () => {
  const ctx = await initInstrumented({
    local: { history: [{ url: URL_A, kind: 'share', at: NOW - 5000 }], scamBlocklist: blocklist([SCAM_ID_A]) },
    state: STATES.signedIn,
  });

  ctx.controller.onStorageChanged({ langPref: { newValue: 'en', oldValue: 'zh' } }, 'sync');

  const log = ctx.spy.log;
  const first = (name) => log.indexOf(name);
  ['i18n', 'history', 'scam', 'scamBar', 'account'].forEach((v) => assert.ok(first(v) !== -1, `${v} 應重畫`));
  ['history', 'scam', 'scamBar', 'account'].forEach((v) =>
    assert.ok(first('i18n') < first(v), `i18n 必須排在 ${v} 之前`)
  );
  assert.ok(log.lastIndexOf('i18n') < first('account'), 'account 必須在 i18n 之後(deviceNote 會被 data-i18n 覆寫)');
  assert.equal(ctx.spy.count('i18n'), 1, 'i18n 只跑一次');
  assert.equal(ctx.spy.count('account'), 1, '帳號區只畫一次');
  assert.equal(ctx.doc.ids.langBtn.textContent, 'EN', '語言鈕跟著切換');
  assert.equal(ctx.doc.ids.deviceNote.textContent, i18n.t('en', 'opDeviceNoteSynced'), '已登入文案蓋回 deviceNote');
});

test('RD2:{themePref} 只套主題，不重畫任何視圖', async () => {
  const ctx = await initInstrumented({});

  ctx.controller.onStorageChanged({ themePref: { newValue: 'dark', oldValue: 'auto' } }, 'sync');

  assert.deepEqual(ctx.spy.log, [], 'themePref 不重畫任何視圖');
  assert.equal(ctx.doc.documentElement.dataset.theme, 'dark', '主題已套用');
});

// ---- RD3:多鍵一次 render ----

test('RD3:local 多鍵同時變動，視圖聯集只各畫一次', async () => {
  const ctx = await initInstrumented({
    local: { history: [{ url: URL_A, kind: 'share', at: NOW - 5000 }], scamBlocklist: blocklist([SCAM_ID_A, SCAM_ID_B]) },
  });

  // 單鍵基準:同一個 controller 上各跑一次，量出單一視圖一次重畫的存取數。
  ctx.controller.onStorageChanged({ history: { newValue: [{ url: URL_B, kind: 'share', at: NOW - 100 }] } }, 'local');
  const historyOnce = ctx.spy.count('history');
  ctx.spy.clear();
  ctx.controller.onStorageChanged({ scamBlocklist: { newValue: blocklist([SCAM_ID_A]) } }, 'local');
  const scamOnce = ctx.spy.count('scam');
  ctx.spy.clear();
  assert.ok(historyOnce >= 1 && scamOnce >= 1, '前提:單鍵各自會重畫');

  ctx.controller.onStorageChanged(
    {
      history: { newValue: [{ url: URL_A, kind: 'share', at: NOW - 50 }] },
      scamBlocklist: { newValue: blocklist([SCAM_ID_B]) },
      syncState: { newValue: null },
    },
    'local'
  );

  assert.equal(ctx.spy.count('history'), historyOnce, '紀錄視圖只畫一次');
  assert.equal(ctx.spy.count('scam'), scamOnce, '名單只畫一次');
  assert.equal(ctx.spy.count('account'), 0);
  assert.equal(ctx.spy.count('i18n'), 0);
  assert.ok(ctx.spy.log.indexOf('history') < ctx.spy.log.indexOf('scam'), '依 VIEW_ORDER:history 在 scam 之前');
});

test('RD3:sync 多鍵(langPref＋themePref＋開關)只觸發一次整頁 render', async () => {
  const ctx = await initInstrumented({ state: STATES.signedIn });

  ctx.controller.onStorageChanged(
    {
      langPref: { newValue: 'en' },
      themePref: { newValue: 'light' },
      autoClean: { newValue: true },
      saveHistory: { newValue: false },
    },
    'sync'
  );

  assert.equal(ctx.spy.count('i18n'), 1, 'i18n 只跑一次');
  assert.equal(ctx.spy.count('account'), 1, '帳號區只畫一次');
  assert.equal(ctx.doc.documentElement.dataset.theme, 'light');
  assert.equal(ctx.doc.ids.autoClean.checked, true);
  assert.equal(ctx.doc.ids.saveHistory.checked, false);
});

test('RD3:options-init.js 的 storage.onChanged 接線是單一呼叫 controller.onStorageChanged(changes, areaName)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'options-init.js'), 'utf8');
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
  };
  const fakeController = {
    init: () => Promise.resolve(),
    onStorageChanged: record('onStorageChanged'),
    setHistory: record('setHistory'),
    setLocalSettings: record('setLocalSettings'),
    setSyncSettings: record('setSyncSettings'),
    setSyncState: record('setSyncState'),
    refresh: () => {},
    focusAccountArea: () => {},
  };
  let onDomReady = null;
  let onChanged = null;
  const loc = { hash: '' };
  const sandbox = {
    document: {
      addEventListener(type, fn) {
        if (type === 'DOMContentLoaded') onDomReady = fn;
      },
      getElementById: () => null,
      visibilityState: 'visible',
    },
    chrome: {
      runtime: { getManifest: () => ({ version: '0.0.0' }), onMessage: { addListener() {} } },
      storage: {
        sync: {},
        local: {},
        onChanged: {
          addListener(fn) {
            onChanged = fn;
          },
        },
      },
    },
    TCLOptions: { createOptionsController: () => fakeController },
    TCLI18N: i18n,
    TCLTheme: { remember() {} },
    window: { location: loc },
    location: loc,
    setInterval() {},
    setTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert.equal(typeof onDomReady, 'function');
  onDomReady();
  assert.equal(typeof onChanged, 'function', 'options-init 應掛 storage.onChanged');

  const localChanges = { history: { newValue: [] }, scamBlocklist: { newValue: null }, scamGuardEnabled: { newValue: false } };
  const syncChanges = { langPref: { newValue: 'en' }, autoClean: { newValue: true } };
  onChanged(localChanges, 'local');
  onChanged(syncChanges, 'sync');

  assert.equal(calls.length, 2, '每次 onChanged 只呼叫 controller 一次');
  assert.equal(calls[0][0], 'onStorageChanged');
  assert.equal(calls[0][1], localChanges, 'changes 原封轉交');
  assert.equal(calls[0][2], 'local');
  assert.equal(calls[1][0], 'onStorageChanged');
  assert.equal(calls[1][1], syncChanges);
  assert.equal(calls[1][2], 'sync');
});

// ---- VM1:accountView 形狀與 applyAccountView 的 DOM 等價 ----

// 帳號區逐欄快照。signedOut 不碰「立即同步」鈕，這兩欄只在其餘三態比對。
function accountSnapshot(doc, mode) {
  const g = (id) => doc.getElementById(id);
  const cls = (id, c) => g(id).classList.contains(c);
  const photo = (id) => ({ hidden: g(id).hidden, src: g(id).src || '', srcAttr: g(id).getAttribute('src') });
  const snap = {
    signInHidden: g('acctSignInBtn').hidden,
    triggerHidden: g('acctTrigger').hidden,
    triggerAria: g('acctTrigger').getAttribute('aria-label'),
    menuOpen: isPopoverOpen(g('acctMenu')),
    headerName: g('acctHeaderName').textContent,
    menuName: g('acctMenuName').textContent,
    menuEmail: g('acctMenuEmail').textContent,
    menuSub: g('acctMenuSub').textContent,
    errorRowHidden: g('acctErrorRow').hidden,
    errorText: g('acctErrorText').textContent,
    expiredRowHidden: g('acctExpiredRow').hidden,
    expiredText: g('acctExpiredText').textContent,
    dotHidden: g('statusDot').hidden,
    dotDanger: cls('statusDot', 'is-danger'),
    dotWarning: cls('statusDot', 'is-warning'),
    syncing: cls('avatarWrap', 'is-syncing'),
    syncNowDisabled: g('acctSyncNowBtn').disabled,
    syncLabel: g('acctSyncLabel').textContent,
    manageHidden: g('acctManageDevicesBtn').hidden,
    manageDisabled: g('acctManageDevicesBtn').disabled,
    deviceNote: g('deviceNote').textContent,
    avatarLetter: g('avatarLetter').textContent,
    avatarLetterHidden: g('avatarLetter').hidden,
    avatarPhoto: photo('avatarPhoto'),
    avatarHasPhoto: cls('avatarCircle', 'has-photo'),
    menuAvatarLetter: g('acctMenuAvatarLetter').textContent,
    menuAvatarLetterHidden: g('acctMenuAvatarLetter').hidden,
    menuAvatarPhoto: photo('acctMenuAvatarPhoto'),
    menuAvatarHasPhoto: cls('acctMenuAvatarCircle', 'has-photo'),
  };
  if (mode === 'signedOut') {
    delete snap.syncNowDisabled;
    delete snap.syncLabel;
  }
  return snap;
}

const PHOTO = { hidden: false, src: AVATAR, srcAttr: null };
const NO_PHOTO = { hidden: true, src: '', srcAttr: null };
const EXPIRED_TEXT = '登入已過期，請重新登入';

// 以重構前的 renderAccount 在 zh、now=NOW 下實際產出的 DOM 錄製。
const GOLDEN = {
  signedOut: {
    signInHidden: false, triggerHidden: true, triggerAria: '帳號選單', menuOpen: false,
    headerName: '', menuName: '', menuEmail: '', menuSub: '',
    errorRowHidden: true, errorText: '', expiredRowHidden: true, expiredText: '',
    dotHidden: true, dotDanger: false, dotWarning: false, syncing: false,
    manageHidden: true, manageDisabled: false, deviceNote: '紀錄僅保存於這台裝置',
    avatarLetter: '', avatarLetterHidden: false, avatarPhoto: NO_PHOTO, avatarHasPhoto: false,
    menuAvatarLetter: '', menuAvatarLetterHidden: false, menuAvatarPhoto: NO_PHOTO, menuAvatarHasPhoto: false,
  },
  signedIn: {
    signInHidden: true, triggerHidden: false, triggerAria: '帳號選單，已同步', menuOpen: false,
    headerName: 'Ada', menuName: 'Ada', menuEmail: 'ada@example.com', menuSub: '上次同步 2 分鐘前 · 3 筆待上傳',
    errorRowHidden: true, errorText: '', expiredRowHidden: true, expiredText: EXPIRED_TEXT,
    dotHidden: false, dotDanger: false, dotWarning: false, syncing: false,
    syncNowDisabled: false, syncLabel: '立即同步',
    manageHidden: false, manageDisabled: false, deviceNote: '已連線至你的 Google 帳號',
    avatarLetter: 'A', avatarLetterHidden: true, avatarPhoto: PHOTO, avatarHasPhoto: true,
    menuAvatarLetter: 'A', menuAvatarLetterHidden: true, menuAvatarPhoto: PHOTO, menuAvatarHasPhoto: true,
  },
  expired: {
    signInHidden: true, triggerHidden: false, triggerAria: '帳號選單，登入已過期', menuOpen: false,
    headerName: 'Ada', menuName: 'Ada', menuEmail: 'ada@example.com', menuSub: '上次同步 2 分鐘前',
    errorRowHidden: true, errorText: '', expiredRowHidden: false, expiredText: EXPIRED_TEXT,
    dotHidden: false, dotDanger: false, dotWarning: true, syncing: false,
    syncNowDisabled: true, syncLabel: '立即同步',
    manageHidden: true, manageDisabled: false, deviceNote: '紀錄僅保存於這台裝置',
    avatarLetter: 'A', avatarLetterHidden: true, avatarPhoto: PHOTO, avatarHasPhoto: true,
    menuAvatarLetter: 'A', menuAvatarLetterHidden: true, menuAvatarPhoto: PHOTO, menuAvatarHasPhoto: true,
  },
  syncing: {
    signInHidden: true, triggerHidden: false, triggerAria: '帳號選單', menuOpen: false,
    headerName: 'Ada', menuName: 'Ada', menuEmail: 'ada@example.com', menuSub: '上次同步 尚未同步',
    errorRowHidden: true, errorText: '', expiredRowHidden: true, expiredText: EXPIRED_TEXT,
    dotHidden: true, dotDanger: false, dotWarning: false, syncing: true,
    syncNowDisabled: true, syncLabel: '同步中…',
    manageHidden: false, manageDisabled: true, deviceNote: '已連線至你的 Google 帳號',
    avatarLetter: 'A', avatarLetterHidden: false, avatarPhoto: NO_PHOTO, avatarHasPhoto: false,
    menuAvatarLetter: 'A', menuAvatarLetterHidden: false, menuAvatarPhoto: NO_PHOTO, menuAvatarHasPhoto: false,
  },
};

for (const mode of Object.keys(STATES)) {
  test(`VM1 golden:${mode} 態經 init 畫出的帳號區與錄製快照逐欄相同`, async () => {
    const ctx = makeCtx({ state: STATES[mode] });
    await ctx.controller.init();
    await settle();
    assert.deepEqual(accountSnapshot(ctx.doc, mode), GOLDEN[mode]);
  });
}

function assertHasViewModel(controller) {
  assert.equal(typeof controller.accountView, 'function', 'controller 應匯出 accountView(state)');
  assert.equal(typeof controller.applyAccountView, 'function', 'controller 應匯出 applyAccountView(view)');
}

async function viewOf(mode) {
  const ctx = makeCtx({});
  await ctx.controller.init();
  await settle();
  assertHasViewModel(ctx.controller);
  const state = options.normalizeSyncCardState(STATES[mode]);
  return { ctx, view: ctx.controller.accountView(state) };
}

test('VM1:accountView 是純函式，呼叫本身不寫 DOM', async () => {
  const ctx = makeCtx({});
  await ctx.controller.init();
  await settle();
  assertHasViewModel(ctx.controller);
  const before = accountSnapshot(ctx.doc);
  const v = ctx.controller.accountView(options.normalizeSyncCardState(STATES.signedIn));
  assert.deepEqual(accountSnapshot(ctx.doc), before, 'accountView 不得寫 DOM');
  assert.deepEqual(
    ctx.controller.accountView(options.normalizeSyncCardState(STATES.signedIn)),
    v,
    '同一份 state 兩次呼叫結果相同'
  );
});

test('VM1:accountView signedOut 形狀', async () => {
  const { view: v } = await viewOf('signedOut');
  assert.equal(v.mode, 'signedOut');
  assert.equal(v.signedOut, true);
  assert.deepEqual(v.text, {
    acctHeaderName: '', acctMenuName: '', acctMenuEmail: '', acctMenuSub: '', acctErrorText: '', acctExpiredText: '',
  });
  assert.deepEqual(v.hidden, {
    acctSignInBtn: false, acctTrigger: true, acctErrorRow: true, acctExpiredRow: true, acctManageDevicesBtn: true, statusDot: true,
  });
  assert.equal(v.disabled.acctManageDevicesBtn, false);
  assert.deepEqual(v.avatar, { initial: '', url: null });
  assert.equal(v.dotClass, '');
  assert.equal(v.syncing, false);
  assert.equal(v.triggerAria, i18n.t('zh', 'opAccountMenuLabel'));
  assert.equal(v.deviceNoteKey, 'opDeviceNote');
  assert.equal(v.devices, 'reset');
  assert.equal(v.closeDevices, true);
  assert.equal(v.closeMenu, true);
});

test('VM1:accountView signedIn 形狀', async () => {
  const { view: v } = await viewOf('signedIn');
  assert.equal(v.mode, 'signedIn');
  assert.equal(v.signedOut, false);
  assert.deepEqual(v.text, {
    acctHeaderName: 'Ada', acctMenuName: 'Ada', acctMenuEmail: 'ada@example.com',
    acctMenuSub: GOLDEN.signedIn.menuSub, acctErrorText: '', acctExpiredText: EXPIRED_TEXT,
  });
  assert.deepEqual(v.hidden, {
    acctSignInBtn: true, acctTrigger: false, acctErrorRow: true, acctExpiredRow: true, acctManageDevicesBtn: false, statusDot: false,
  });
  assert.deepEqual(v.disabled, { acctSyncNowBtn: false, acctManageDevicesBtn: false });
  assert.deepEqual(v.avatar, { initial: 'A', url: AVATAR });
  assert.equal(v.dotClass, '');
  assert.equal(v.syncing, false);
  assert.equal(v.triggerAria, GOLDEN.signedIn.triggerAria);
  assert.equal(v.syncLabelKey, 'opAccountSyncNow');
  assert.equal(v.deviceNoteKey, 'opDeviceNoteSynced');
  assert.equal(v.devices, null);
  assert.equal(v.closeDevices, false);
  assert.equal(v.closeMenu, false);
});

test('VM1:accountView expired 形狀', async () => {
  const { view: v } = await viewOf('expired');
  assert.equal(v.mode, 'expired');
  assert.equal(v.signedOut, false);
  assert.equal(v.text.acctExpiredText, EXPIRED_TEXT);
  assert.equal(v.text.acctMenuSub, GOLDEN.expired.menuSub);
  assert.deepEqual(v.hidden, {
    acctSignInBtn: true, acctTrigger: false, acctErrorRow: true, acctExpiredRow: false, acctManageDevicesBtn: true, statusDot: false,
  });
  assert.deepEqual(v.disabled, { acctSyncNowBtn: true, acctManageDevicesBtn: false });
  assert.equal(v.dotClass, 'is-warning');
  assert.equal(v.syncing, false);
  assert.equal(v.triggerAria, GOLDEN.expired.triggerAria);
  assert.equal(v.syncLabelKey, 'opAccountSyncNow');
  assert.equal(v.deviceNoteKey, 'opDeviceNote');
  assert.equal(v.devices, 'refetch');
  assert.equal(v.closeDevices, true);
  assert.equal(v.closeMenu, false);
});

test('VM1:accountView syncing 形狀', async () => {
  const { view: v } = await viewOf('syncing');
  assert.equal(v.mode, 'syncing');
  assert.deepEqual(v.hidden, {
    acctSignInBtn: true, acctTrigger: false, acctErrorRow: true, acctExpiredRow: true, acctManageDevicesBtn: false, statusDot: true,
  });
  assert.deepEqual(v.disabled, { acctSyncNowBtn: true, acctManageDevicesBtn: true });
  assert.deepEqual(v.avatar, { initial: 'A', url: null });
  assert.equal(v.dotClass, '');
  assert.equal(v.syncing, true);
  assert.equal(v.triggerAria, i18n.t('zh', 'opAccountMenuLabel'));
  assert.equal(v.syncLabelKey, 'opAccountSyncing');
  assert.equal(v.deviceNoteKey, 'opDeviceNoteSynced');
  assert.equal(v.devices, null);
  assert.equal(v.closeDevices, false);
});

for (const mode of Object.keys(STATES)) {
  test(`VM1:applyAccountView(accountView(${mode})) 畫出的 DOM 與錄製快照逐欄相同`, async () => {
    const ctx = makeCtx({});
    await ctx.controller.init();
    await settle();
    assertHasViewModel(ctx.controller);
    ctx.controller.applyAccountView(ctx.controller.accountView(options.normalizeSyncCardState(STATES[mode])));
    assert.deepEqual(accountSnapshot(ctx.doc, mode), GOLDEN[mode]);
  });
}

// ---- VM2:兩個既有漏洞 ----

test('VM2:從同步中直接登出，avatarWrap 的 is-syncing 要清掉', async () => {
  const ctx = makeCtx({ state: STATES.syncing });
  await ctx.controller.init();
  await settle();
  assert.equal(ctx.doc.ids.avatarWrap.classList.contains('is-syncing'), true, '前提:同步中外圈轉圈');

  ctx.controller.setSyncState(STATES.signedOut);

  assert.equal(ctx.doc.ids.avatarWrap.classList.contains('is-syncing'), false, '登出後不得殘留轉圈');
});

test('VM2:已登入但不用照片時，photo.src 清空且沒有 src 屬性', async () => {
  const ctx = makeCtx({ state: STATES.signedIn });
  await ctx.controller.init();
  await settle();
  assert.equal(ctx.doc.ids.avatarPhoto.src, AVATAR, '前提:先顯示大頭照');

  ctx.controller.setSyncState(Object.assign({}, STATES.signedIn, { avatarUrl: null }));

  for (const id of ['avatarPhoto', 'acctMenuAvatarPhoto']) {
    const photo = ctx.doc.ids[id];
    assert.equal(photo.hidden, true, `${id} 收起`);
    assert.equal(photo.src, '', `${id} 的 src 要清空，不留舊圖`);
    assert.equal(photo.getAttribute('src'), null, `${id} 不留 src 屬性`);
  }
  assert.equal(ctx.doc.ids.avatarLetter.hidden, false, '改顯示字母');
});

// ---- 共用 stub:isConnected 與 getClientRects ----

test('stub:節點有 isConnected 與 getClientRects，反映在不在文件裡、有沒有版面', () => {
  const doc = makeDocumentStub();
  const btn = doc.getElementById('scamInfoBtn');
  assert.equal(btn.isConnected, true, '靜態節點在文件裡');
  assert.equal(btn.getClientRects().length, 1, '可見節點有 box');
  btn.hidden = true;
  assert.equal(btn.getClientRects().length, 0, 'hidden 節點沒有 box');

  const list = doc.getElementById('scamList');
  const row = doc.createElement('div');
  list.appendChild(row);
  assert.equal(row.isConnected, true, '掛進靜態容器的動態節點在文件裡');
  list.textContent = '';
  assert.equal(row.isConnected, false, '容器被清空後離開文件');
  assert.equal(row.getClientRects().length, 0, '離開文件就沒有 box');
});

test('stub 釘樁:點遮罩關閉對話框後，焦點回到開啟前的元素', async () => {
  const ctx = makeCtx({ local: { history: [], scamBlocklist: blocklist([SCAM_ID_A]) } });
  await ctx.controller.init();
  await settle();
  const opener = ctx.doc.getElementById('scamInfoBtn');
  const dlg = ctx.doc.getElementById('scamInfoOverlay');
  opener.focus();
  opener.fire('click');
  assert.equal(dlg.open, true, '前提:對話框開著');

  // 點遮罩的 mousedown 落在 dialog 本身，焦點先掉到 body。規格上瀏覽器只在
  // 焦點仍在對話框內時才還原開啟前的焦點，stub 的 close() 不分情況都還原，
  // 這裡清掉 stub 記的開啟前節點，模擬瀏覽器這時不還原，只剩產品碼的 close
  // 善後能把焦點補回去。
  ctx.doc.activeElement = ctx.doc.body;
  dlg._opener = null;
  dlg.fire('click', { type: 'click', target: dlg });

  assert.equal(dlg.open, false, '點遮罩關閉');
  assert.equal(ctx.doc.activeElement, opener, '焦點回到開啟前的元素');
});
