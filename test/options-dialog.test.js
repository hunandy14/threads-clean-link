// test/options-dialog.test.js — options 頁的對話框與選單改用原生 <dialog>
// ＋showModal、Popover API 之後的行為契約。
//
// 7 個對話框(匯入、共用確認、裝置、命中 N 篇、說明、詳細、時間軸)一律是
// <dialog class="dlg">;4 個選單(⋯ 紀錄選單、篩選、帳號、警示名單列 ⋯)一律
// 是 auto popover;toast 是 manual popover。開關狀態只讀 dialog.open 與
// :popover-open，焦點歸還、Esc、點外關閉交給原生行為，DOM stub 依規格模擬
// (見 test/support/options-dom.js)。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createChromeStorage } = require('./support/helpers');
const { makeDocumentStub, isPopoverOpen, parseStaticHtml } = require('./support/options-dom');

const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

const ROOT = path.join(__dirname, '..');
function readRoot(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8');
}
function readOptionsAll() {
  return ['options.html', 'theme.css', 'options.css'].map(readRoot).join('\n');
}

// 對話框 id 與 autofocus 落點(保留原 id，見 design-ui §1.1、§1.3)。
const DIALOGS = {
  overlay: 'modalText',
  confirmOverlay: 'confirmCancel',
  devicesOverlay: 'devicesClose',
  scamHitsOverlay: 'scamHitsClose',
  scamInfoOverlay: 'scamInfoClose',
  detailOverlay: 'detailClose',
  timelineOverlay: 'timelineClose',
};

// 靜態選單與觸發鈕。
const STATIC_POPOVERS = {
  moreMenu: 'moreBtn',
  chipsRow: 'filterBtn',
  acctMenu: 'acctTrigger',
};

// ---- 共用 fixture ----

const URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const URL_B = 'https://www.threads.com/@user.b/post/DeF456';

function makeFakeRuntime(handlers) {
  const calls = [];
  return {
    calls,
    sendMessage(message) {
      calls.push(message);
      const handler = handlers && handlers[message.type];
      if (!handler) return Promise.resolve(undefined);
      return Promise.resolve(handler(message));
    },
  };
}

function makeCtx(opts) {
  const o = opts || {};
  const storage = createChromeStorage({ langPref: 'zh' }, o.local || { history: [] });
  const doc = makeDocumentStub();
  (o.ids || []).forEach((id) => doc.getElementById(id));
  const runtime = makeFakeRuntime(o.handlers || {});
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => (o.now === undefined ? 100000 : o.now),
    runtime,
    download: () => {},
  });
  if (o.wire) wireStorageOnChanged(storage, controller);
  return { storage, doc, runtime, controller };
}

// 比照 options-init.js 的 chrome.storage.onChanged 接線。
function wireStorageOnChanged(storage, controller) {
  storage.api.onChanged.addListener((changes, areaName) => {
    if (!changes) return;
    if (areaName === 'local') {
      if (changes.history) controller.setHistory(changes.history.newValue || []);
      controller.setLocalSettings(changes);
    } else if (areaName === 'sync') {
      controller.setSyncSettings(changes);
    }
  });
}

function walkNodes(node, out) {
  out.push(node);
  (node.children || []).forEach((c) => walkNodes(c, out));
  return out;
}
function classListOf(node) {
  const cls = node.className || node.getAttribute('class') || '';
  return String(cls).split(/\s+/);
}
function firstByClass(root, cls) {
  return walkNodes(root, []).filter((n) => classListOf(n).indexOf(cls) !== -1)[0] || null;
}
function byAct(root, act) {
  return walkNodes(root, []).filter((n) => n.dataset && n.dataset.act === act)[0] || null;
}

// 紀錄:A 有三筆 seen(時間軸鈕才會出現)，B 是單筆。
function historyWithTimeline() {
  return [
    {
      url: URL_A,
      kind: 'share',
      at: 3000,
      seen: [
        { at: 1000, kind: 'strip' },
        { at: 3000, kind: 'share' },
        { at: 2000, kind: 'menu' },
      ],
    },
    { url: URL_B, kind: 'strip', at: 1000 },
  ];
}

// 帳號與裝置。
const DEV_NOW = 1767225600000;
const DEV_THIS = '11111111-1111-4111-8111-111111111111';
const DEV_PIXEL = '22222222-2222-4222-8222-222222222222';
const SIGNED_IN = {
  status: 'signed_in',
  email: 'user@example.com',
  displayName: 'Hong',
  avatarUrl: null,
  lastSyncedAt: DEV_NOW - 60000,
  pendingCount: 0,
  lastError: null,
  apiBase: '',
};
const SIGNED_OUT = {
  status: 'signed_out',
  email: null,
  displayName: null,
  avatarUrl: null,
  lastSyncedAt: null,
  pendingCount: 0,
  lastError: null,
  apiBase: '',
};
function deviceList() {
  return {
    ok: true,
    devices: [
      {
        deviceId: DEV_PIXEL,
        name: 'Pixel 8',
        platform: 'android',
        createdAt: DEV_NOW - 30 * 86400000,
        lastSeenAt: DEV_NOW - 3 * 3600000,
        removedAt: null,
      },
      {
        deviceId: DEV_THIS,
        name: 'My Laptop',
        platform: 'chrome_extension',
        createdAt: DEV_NOW - 60 * 86400000,
        lastSeenAt: DEV_NOW - 2 * 86400000,
        removedAt: null,
      },
    ],
    currentDeviceId: DEV_THIS,
    defaultName: 'Chrome on Windows',
    fetchedAt: DEV_NOW,
  };
}
function makeAccountCtx() {
  return makeCtx({
    now: DEV_NOW,
    ids: ['acctTrigger', 'acctMenu', 'acctManageDevicesBtn', 'devicesOverlay', 'devicesClose', 'deviceList', 'rows'],
    handlers: {
      'sync.getState': () => SIGNED_IN,
      'sync.devices.list': () => deviceList(),
      'sync.devices.rename': (m) => ({ ok: true, device: { deviceId: m.deviceId, name: m.name } }),
      'sync.devices.remove': () => ({ ok: true }),
      'sync.now': () => ({ ok: true }),
    },
  });
}
function deviceRow(doc, id) {
  return doc.getElementById('deviceList').children.filter((r) => r.dataset && r.dataset.id === id)[0] || null;
}

// 警示名單:A 三筆證據(有「命中 3 篇」pill)，B 一筆。
const SCAM_NOW = 1758240000000;
const SCAM_HOUR = 3600000;
const SCAM_DAY = 86400000;
const SCAM_ID_A = '10000000001';
const SCAM_ID_B = '10987654321';
function scamEvidence(n, at) {
  return {
    postUrl: 'https://www.threads.com/@example_author/post/DxSyNtH000' + n,
    snippet: '合成範例第 ' + n + ' 篇：加 LINE：ab12cd 拉你進群組。',
    at: at,
  };
}
function scamFixture(evidenceCountA, patchA) {
  const evA = [];
  for (let i = 1; i <= evidenceCountA; i++) evA.push(scamEvidence(i, SCAM_NOW - i * SCAM_HOUR));
  return {
    version: 1,
    entries: {
      [SCAM_ID_A]: Object.assign(
        {
          handle: 'example_author',
          displayName: 'Example Author',
          evidence: evA,
          addedAt: SCAM_NOW - SCAM_HOUR,
          source: 'auto',
        },
        patchA || {}
      ),
      [SCAM_ID_B]: {
        handle: 'user.b',
        evidence: [scamEvidence(9, SCAM_NOW - 3 * SCAM_DAY)],
        addedAt: SCAM_NOW - 3 * SCAM_DAY,
        source: 'auto',
      },
    },
    handleIndex: { example_author: SCAM_ID_A, 'user.b': SCAM_ID_B },
    allowlist: {},
  };
}
function makeScamCtx() {
  return makeCtx({
    now: SCAM_NOW,
    wire: true,
    local: { history: [], scamBlocklist: scamFixture(3) },
    ids: ['scamList', 'scamHitsOverlay', 'scamHitsList', 'scamHitsTitle', 'scamHitsClose', 'scamInfoBtn', 'scamInfoOverlay', 'scamInfoClose', 'rows'],
    handlers: { 'sync.getState': () => SIGNED_OUT },
  });
}
function scamRow(doc, id) {
  return doc.getElementById('scamList').children.filter((r) => r.dataset && r.dataset.id === id)[0] || null;
}
function emitBlocklist(ctx, next) {
  ctx.storage.emitChange({ scamBlocklist: { newValue: next, oldValue: null } }, 'local');
}

// ---- 開啟各對話框的使用者路徑 ----
// 每支都回傳 { ctx, opener }:opener 是關閉後焦點該回去的元素。按鈕由使用者
// 點擊，所以先 focus 再 click(比照 Chrome 在 Windows 上點按鈕會取得焦點)。

// 匯入與清除全部都在 ⋯ 選單裡:點項目時選單先以 hidePopover 收起、焦點回
// ⋯ 鈕，對話框記下的開啟前焦點因此是 ⋯ 鈕(選單項目已不可聚焦)。
async function openImport() {
  const ctx = makeCtx({ local: { history: historyWithTimeline() }, ids: ['moreBtn', 'moreMenu', 'overlay', 'modalText'] });
  await ctx.controller.init();
  await settle();
  const moreBtn = ctx.doc.ids.moreBtn;
  moreBtn.focus();
  moreBtn.fire('click');
  const importBtn = ctx.doc.getElementById('importBtn');
  importBtn.focus();
  importBtn.fire('click');
  return { ctx, opener: moreBtn };
}

async function openClearConfirm() {
  const ctx = makeCtx({ local: { history: historyWithTimeline() }, ids: ['moreBtn', 'moreMenu', 'confirmOverlay'] });
  await ctx.controller.init();
  await settle();
  const moreBtn = ctx.doc.ids.moreBtn;
  moreBtn.focus();
  moreBtn.fire('click');
  const clearBtn = ctx.doc.getElementById('clearBtn');
  clearBtn.focus();
  clearBtn.fire('click');
  return { ctx, opener: moreBtn };
}

// 管理裝置在帳號選單裡，同一個道理:關閉後焦點回帳號觸發鈕。
async function openDevices(existingCtx) {
  const ctx = existingCtx || makeAccountCtx();
  if (!existingCtx) {
    await ctx.controller.init();
    await settle();
  }
  const trigger = ctx.doc.ids.acctTrigger;
  trigger.focus();
  trigger.fire('click');
  await settle();
  const manage = ctx.doc.ids.acctManageDevicesBtn;
  manage.focus();
  manage.fire('click');
  await settle();
  return { ctx, opener: trigger };
}

async function openHits(existingCtx) {
  const ctx = existingCtx || makeScamCtx();
  if (!existingCtx) {
    await ctx.controller.init();
    await settle();
  }
  const pill = firstByClass(scamRow(ctx.doc, SCAM_ID_A), 'scam-hit-count');
  assert.ok(pill, '前置:A 有三筆證據，應畫出「命中 N 篇」pill');
  pill.focus();
  pill.fire('click');
  return { ctx, opener: pill };
}

async function openInfo() {
  const ctx = makeScamCtx();
  await ctx.controller.init();
  await settle();
  const btn = ctx.doc.ids.scamInfoBtn;
  btn.focus();
  btn.fire('click');
  return { ctx, opener: btn };
}

async function openDetail(existingCtx) {
  const ctx = existingCtx || makeCtx({ local: { history: historyWithTimeline() }, ids: ['rows', 'detailOverlay', 'timelineOverlay'] });
  if (!existingCtx) {
    await ctx.controller.init();
    await settle();
  }
  const card = ctx.doc.ids.rows.children[0];
  card.focus();
  card.fire('click');
  return { ctx, opener: card };
}

async function openTimeline() {
  const { ctx } = await openDetail();
  const btn = ctx.doc.getElementById('detailTimelineBtn');
  assert.equal(btn.hidden, false, '前置:seen 多筆時應顯示時間軸鈕');
  btn.focus();
  btn.fire('click');
  return { ctx, opener: btn };
}

const OPENERS = {
  overlay: { open: openImport, closeBtn: 'modalClose', label: '匯入' },
  confirmOverlay: { open: openClearConfirm, closeBtn: 'confirmCancel', label: '共用確認' },
  devicesOverlay: { open: openDevices, closeBtn: 'devicesClose', label: '裝置' },
  scamHitsOverlay: { open: openHits, closeBtn: 'scamHitsClose', label: '命中 N 篇' },
  scamInfoOverlay: { open: openInfo, closeBtn: 'scamInfoClose', label: '說明' },
  detailOverlay: { open: openDetail, closeBtn: 'detailClose', label: '詳細' },
  timelineOverlay: { open: openTimeline, closeBtn: 'timelineClose', label: '時間軸' },
};

// ============================================================
// 結構
// ============================================================

test('結構:options.html 有 7 個 dialog.dlg(保留原 id)，沒有 .overlay，dialog 上不得有 hidden', () => {
  const html = readRoot('options.html');
  const parsed = parseStaticHtml(html);
  const dialogs = Object.keys(parsed.byId).filter((id) => parsed.byId[id].tag === 'dialog');
  assert.deepEqual(dialogs.sort(), Object.keys(DIALOGS).sort(), '7 個對話框都改成 <dialog>，id 不變');
  dialogs.forEach((id) => {
    const attrs = parsed.byId[id].attrs;
    assert.ok(String(attrs.class || '').split(/\s+/).includes('dlg'), `#${id} 應帶 class="dlg"`);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(attrs, 'hidden'),
      `#${id} 不得有 hidden 屬性(全域 [hidden]{display:none!important} 會壓過原生行為)`
    );
    assert.ok(attrs['aria-labelledby'], `#${id} 的 aria-labelledby 要搬到 dialog 上`);
  });
  assert.equal((html.match(/<dialog\b[^>]*\bclass="[^"]*\bdlg\b/g) || []).length, 7, '恰好 7 個 dialog.dlg');
  assert.doesNotMatch(html, /class="[^"]*\boverlay\b/, 'options.html 不得再有 .overlay 外框');
  assert.doesNotMatch(html, /aria-modal=/, 'aria-modal 交給 showModal，內層 .modal 不再寫');
  assert.doesNotMatch(html, /class="modal[^"]*"[^>]*role="(dialog|alertdialog)"/, '內層 .modal 不再帶 role');
  const confirm = parsed.byId.confirmOverlay.attrs;
  assert.equal(confirm.role, 'alertdialog', '確認框的 role="alertdialog" 放在 dialog 上');
  assert.equal(confirm['aria-describedby'], 'confirmDesc', '確認框的 aria-describedby 放在 dialog 上');
});

test('結構:每個 dialog 內有且只有指定的 autofocus 節點(取代 focusInto)', () => {
  const parsed = parseStaticHtml(readRoot('options.html'));
  Object.keys(DIALOGS).forEach((id) => {
    assert.equal(parsed.autofocusIn[id], DIALOGS[id], `#${id} 的 autofocus 應落在 #${DIALOGS[id]}`);
  });
  const all = Object.keys(parsed.byId).filter((id) =>
    Object.prototype.hasOwnProperty.call(parsed.byId[id].attrs, 'autofocus')
  );
  assert.deepEqual(all.sort(), Object.values(DIALOGS).sort(), 'autofocus 只出現在這 7 顆');
});

test('結構:三個靜態選單是 auto popover、沒有 hidden;觸發鈕不得寫死 aria-expanded;toast 是 manual popover', () => {
  const parsed = parseStaticHtml(readRoot('options.html'));
  Object.keys(STATIC_POPOVERS).forEach((id) => {
    const attrs = parsed.byId[id].attrs;
    assert.ok(Object.prototype.hasOwnProperty.call(attrs, 'popover'), `#${id} 應帶 popover 屬性`);
    assert.ok(attrs.popover === '' || attrs.popover === 'auto', `#${id} 應為 auto popover`);
    assert.ok(!Object.prototype.hasOwnProperty.call(attrs, 'hidden'), `#${id} 不得再用 hidden 控制開合`);
    const trigger = parsed.byId[STATIC_POPOVERS[id]].attrs;
    assert.ok(
      !Object.prototype.hasOwnProperty.call(trigger, 'aria-expanded'),
      `#${STATIC_POPOVERS[id]} 不得寫死 aria-expanded(會蓋掉瀏覽器依 popover 目標算出的展開狀態)`
    );
  });
  assert.equal(parsed.byId.toast.attrs.popover, 'manual', '#toast 要是 popover="manual"，才能疊在 modal 之上');
});

test('結構:CSS 改用 dialog.dlg::backdrop 與 :popover-open，刪掉 .overlay 與帳號選單的 JS 動畫依賴', () => {
  const css = readOptionsAll();
  assert.doesNotMatch(css, /(^|[\s,}])\.overlay\b/m, '不得再有 .overlay 規則');
  assert.match(css, /dialog\.dlg::backdrop\s*\{/, '遮罩改由 dialog.dlg::backdrop 畫');
  assert.match(css, /\.menu\[popover\]\s*\{[^}]*inset\s*:\s*auto/, '.menu[popover] 要蓋掉 UA 的 inset:0');
  assert.match(css, /@starting-style/, '帳號選單淡入改用 @starting-style');
  assert.match(css, /\.acct-menu:popover-open/, '帳號選單開啟態以 :popover-open 表達');
  assert.doesNotMatch(css, /\.acct-menu\.is-open/, '不再靠 JS 補 .is-open');
  assert.doesNotMatch(
    css,
    /\.account-trigger\[aria-expanded="true"\]/,
    '觸發鈕的展開樣式改成 .account-area:has(.acct-menu:popover-open) .account-trigger'
  );
  assert.match(css, /#toast\s*\{[^}]*inset\s*:\s*auto/, '#toast 要蓋掉 popover 的 UA inset:0');
});

test('結構:options.js 刪除手寫的焦點管理、逐層 Esc 鏈與選單狀態', () => {
  const src = readRoot('options.js');
  [
    'overlayPrevFocus',
    'rememberFocus',
    'restoreFocus',
    'focusInto',
    'trapTabInOverlay',
    'topmostOverlayId',
    'FOCUSABLE_SEL',
    'openScamMenu',
    'closeScamMenu',
    'ACCT_MENU_ANIM_MS',
  ].forEach((name) => {
    assert.ok(!src.includes(name), `options.js 不得再出現 ${name}`);
  });
  assert.doesNotMatch(src, /setAttribute\(\s*'aria-expanded'/, 'aria-expanded 交給瀏覽器，JS 不再手寫');
  assert.doesNotMatch(src, /'aria-expanded'\s*:/, '動態節點也不得寫 aria-expanded');
  assert.match(src, /\.showModal\(\)/, '對話框以 showModal 開啟');
  assert.match(src, /popoverTargetElement/, '選單以 popoverTargetElement 接線');
});

// ============================================================
// 7 個對話框:開啟、三種關法、焦點歸還
// ============================================================

for (const id of Object.keys(OPENERS)) {
  const spec = OPENERS[id];
  const autofocusId = DIALOGS[id];

  test(`對話框 ${spec.label}(#${id}):showModal 開啟、焦點落在 autofocus;✕、點遮罩、Esc 都能關，焦點回開啟前的元素`, async () => {
    for (const how of ['button', 'backdrop', 'escape']) {
      const { ctx, opener } = await spec.open();
      const dlg = ctx.doc.ids[id];
      assert.equal(dlg.open, true, `[${how}] 開啟後 dialog.open 應為 true`);
      assert.ok(ctx.doc._modal.includes(dlg), `[${how}] 應以 showModal 開啟(進 top layer，底層 inert)`);
      assert.equal(ctx.doc.activeElement, ctx.doc.ids[autofocusId], `[${how}] 焦點應落在 #${autofocusId}`);

      if (how === 'button') {
        ctx.doc.ids[spec.closeBtn].fire('click');
      } else if (how === 'backdrop') {
        dlg.fire('click', { target: ctx.doc.ids[autofocusId] });
        assert.equal(dlg.open, true, '[backdrop] 點對話框內容不得關閉');
        dlg.fire('click', { target: dlg });
      } else {
        const closed = ctx.doc.pressEscape();
        assert.equal(closed, dlg, '[escape] Esc 的 close request 應落在這個對話框');
      }
      await settle();

      assert.equal(dlg.open, false, `[${how}] 關閉後 dialog.open 應為 false`);
      assert.equal(ctx.doc._modal.length, id === 'timelineOverlay' ? 1 : 0, `[${how}] 只關這一層`);
      assert.equal(ctx.doc.activeElement, opener, `[${how}] 焦點應回到開啟前的元素`);
    }
  });
}

// 善後一律寫在 close 事件:Esc 由瀏覽器直接關，不經任何按鈕 handler。
test('對話框善後:Esc 關掉確認框後 confirmAction 已清空，再點確定不執行清除', async () => {
  const { ctx } = await openClearConfirm();
  assert.equal(ctx.doc.ids.confirmOverlay.open, true, '前置:確認框以 showModal 開啟');
  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.confirmOverlay.open, false, '前置:Esc 已關閉確認框');
  ctx.doc.ids.confirmOk.fire('click');
  await settle();
  assert.equal(ctx.storage.localSnapshot().history.length, 2, 'close 事件要清掉 confirmAction，紀錄不得被清除');
});

test('對話框善後:Esc 關掉詳細視窗後 detailEntry 已清空，刪除鈕不再開確認框', async () => {
  const { ctx } = await openDetail();
  assert.equal(ctx.doc.ids.detailOverlay.open, true, '前置:詳細視窗以 showModal 開啟');
  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.detailOverlay.open, false, '前置:Esc 已關閉詳細視窗');
  ctx.doc.getElementById('detailDeleteBtn').fire('click');
  assert.equal(ctx.doc.ids.confirmOverlay.open, false, 'close 事件要清掉 detailEntry');
});

test('對話框善後:Esc 關掉命中對話框後，名單變動不得把它重新打開', async () => {
  const { ctx } = await openHits();
  assert.equal(ctx.doc.ids.scamHitsOverlay.open, true, '前置:命中對話框以 showModal 開啟');
  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.scamHitsOverlay.open, false, '前置:Esc 已關閉命中對話框');
  emitBlocklist(ctx, scamFixture(4));
  await settle();
  assert.equal(ctx.doc.ids.scamHitsOverlay.open, false, 'close 事件要清掉 scamHitsUserId');
});

test('對話框:詳細視窗 setHistory 原地刷新只更新內容，不會把已關閉的視窗重新打開', async () => {
  const { ctx } = await openDetail();
  assert.equal(ctx.doc.ids.detailOverlay.open, true, '前置:詳細視窗以 showModal 開啟');
  ctx.doc.ids.detailClose.fire('click');
  ctx.controller.setHistory(historyWithTimeline().map((e) => Object.assign({}, e, { at: e.at + 1 })));
  await settle();
  assert.equal(ctx.doc.ids.detailOverlay.open, false, 'refreshDetail 只在 dialog.open 時重畫');
});

// ============================================================
// 疊放
// ============================================================

test('疊放:詳細→時間軸，Esc 只關時間軸;底層在子層開著時是 inert;再按 Esc 關詳細', async () => {
  const { ctx, opener: timelineBtn } = await openTimeline();
  const card = ctx.doc.ids.rows.children[0];
  assert.deepEqual(ctx.doc._modal, [ctx.doc.ids.detailOverlay, ctx.doc.ids.timelineOverlay], '原生巢狀 showModal');
  assert.equal(ctx.doc.isInert(ctx.doc.ids.detailClose), true, '時間軸開著時詳細視窗的 ✕ 不可操作');

  ctx.doc.pressEscape();
  assert.equal(ctx.doc.ids.timelineOverlay.open, false, '第一次 Esc 關時間軸');
  assert.equal(ctx.doc.ids.detailOverlay.open, true, '詳細視窗仍開著');
  assert.equal(ctx.doc.activeElement, timelineBtn, '焦點回時間軸鈕');

  ctx.doc.pressEscape();
  assert.equal(ctx.doc.ids.detailOverlay.open, false, '第二次 Esc 關詳細視窗');
  assert.equal(ctx.doc.activeElement, card, '焦點回卡片');
});

test('疊放:詳細→確認(刪這筆)，Esc 只關確認框，紀錄不刪、詳細視窗仍開著', async () => {
  const { ctx } = await openDetail();
  const delBtn = ctx.doc.getElementById('detailDeleteBtn');
  delBtn.focus();
  delBtn.fire('click');
  assert.equal(ctx.doc.ids.confirmOverlay.open, true, '前置:確認框疊在詳細視窗上');
  assert.deepEqual(ctx.doc._modal, [ctx.doc.ids.detailOverlay, ctx.doc.ids.confirmOverlay]);

  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.confirmOverlay.open, false, 'Esc 只關確認框');
  assert.equal(ctx.doc.ids.detailOverlay.open, true, '詳細視窗仍開著');
  assert.equal(ctx.doc.activeElement, delBtn, '焦點回刪除鈕');
  assert.equal(ctx.storage.localSnapshot().history.length, 2, '取消不得刪除');
});

test('疊放:裝置→確認(移除裝置)，Esc 只關確認框，裝置對話框仍開著', async () => {
  const { ctx } = await openDevices();
  const row = deviceRow(ctx.doc, DEV_PIXEL);
  assert.ok(row, '前置:應畫出 Pixel 8 那一列');
  const removeBtn = byAct(row, 'remove');
  removeBtn.focus();
  removeBtn.fire('click');
  assert.equal(ctx.doc.ids.confirmOverlay.open, true, '前置:確認框疊在裝置對話框上');

  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.confirmOverlay.open, false, 'Esc 只關確認框');
  assert.equal(ctx.doc.ids.devicesOverlay.open, true, '裝置對話框仍開著');
  assert.equal(ctx.doc.activeElement, removeBtn, '焦點回移除鈕');
  assert.equal(ctx.runtime.calls.filter((c) => c.type === 'sync.devices.remove').length, 0, '取消不得送出移除');
});

test('疊放:程式關詳細視窗(紀錄被別處刪掉)時先關時間軸子層，再關詳細', async () => {
  const { ctx } = await openTimeline();
  const order = [];
  ctx.doc.ids.timelineOverlay.addEventListener('close', () => order.push('timelineOverlay'));
  ctx.doc.ids.detailOverlay.addEventListener('close', () => order.push('detailOverlay'));

  ctx.controller.setHistory([{ url: URL_B, kind: 'strip', at: 1000 }]);
  await settle();

  assert.equal(ctx.doc.ids.timelineOverlay.open, false, '時間軸一併關閉');
  assert.equal(ctx.doc.ids.detailOverlay.open, false, '詳細視窗關閉');
  assert.deepEqual(order, ['timelineOverlay', 'detailOverlay'], '子層先關，焦點歸還鏈才正確');
  assert.equal(ctx.doc._modal.length, 0, 'top layer 不殘留 modal');
});

test('裝置改名 input 按 Esc 只取消編輯，不關裝置對話框(cancel 被擋);再按一次才關', async () => {
  const { ctx } = await openDevices();
  const row = deviceRow(ctx.doc, DEV_PIXEL);
  byAct(row, 'rename').fire('click');
  const input = walkNodes(deviceRow(ctx.doc, DEV_PIXEL), []).filter((n) => n.tag === 'input')[0];
  assert.ok(input, '前置:進入行內編輯');
  assert.equal(ctx.doc.activeElement, input, '前置:焦點在 input');

  ctx.doc.pressEscape();
  await settle();
  assert.equal(ctx.doc.ids.devicesOverlay.open, true, '改名 input 的 Esc 不得關掉裝置對話框');
  assert.equal(
    walkNodes(deviceRow(ctx.doc, DEV_PIXEL), []).filter((n) => n.tag === 'input').length,
    0,
    'Esc 取消編輯、撤掉 input'
  );
  assert.equal(ctx.runtime.calls.filter((c) => c.type === 'sync.devices.rename').length, 0, '不送改名');

  ctx.doc.pressEscape();
  assert.equal(ctx.doc.ids.devicesOverlay.open, false, '編輯結束後的 Esc 才關對話框');
});

// ============================================================
// toast
// ============================================================

test('toast:對話框開著時跳 toast，toast 重新排到 top layer 最上層(不被遮罩蓋住)', async () => {
  const { ctx } = await openImport();
  ctx.doc.ids.modalText.value = 'not json';
  ctx.doc.getElementById('modalPrimary').fire('click');
  await settle();
  const toastEl = ctx.doc.getElementById('toast');

  assert.equal(ctx.doc.ids.overlay.open, true, '匯入失敗不關框');
  assert.equal(toastEl.textContent, i18n.t('zh', 'opToastBadJson'), '前置:跳出失敗提示');
  assert.equal(toastEl.matches(':popover-open'), true, 'toast 以 showPopover 顯示');
  assert.equal(ctx.doc._topLayer[ctx.doc._topLayer.length - 1], toastEl, 'toast 在 top layer 最上層');
  assert.equal(ctx.doc.isInert(toastEl), false, 'toast 不受底下 modal 的 inert 影響');
});

test('toast:已經顯示中的 toast 在開了新對話框後再跳一次，要先 hidePopover 再 showPopover 重新排到最上層', async () => {
  const ctx = makeCtx({ local: { history: historyWithTimeline() }, ids: ['rows', 'toast', 'detailOverlay'] });
  await ctx.controller.init();
  await settle();
  const toastEl = ctx.doc.ids.toast;

  // 先在沒有對話框時跳一次(匯出)。
  ctx.doc.getElementById('exportBtn').fire('click');
  assert.equal(toastEl.matches(':popover-open'), true, '前置:toast 已顯示');

  // 開詳細視窗後再跳一次(複製)。
  await openDetail(ctx);
  ctx.doc.getElementById('detailCopyBtn').fire('click');
  await settle();
  assert.equal(toastEl.matches(':popover-open'), true, 'toast 仍顯示');
  assert.equal(ctx.doc._topLayer[ctx.doc._topLayer.length - 1], toastEl, '重新排到詳細視窗之上');
});

// ============================================================
// 4 個 popover
// ============================================================

async function initRecordsPage() {
  const ctx = makeCtx({ local: { history: historyWithTimeline() }, ids: ['moreBtn', 'moreMenu', 'filterBtn', 'chipsRow', 'rows'] });
  await ctx.controller.init();
  await settle();
  return ctx;
}

async function checkPopoverCycle(ctx, trigger, pop, label) {
  assert.equal(trigger.popoverTargetElement, pop, `${label}:觸發鈕以 popoverTargetElement 指向選單`);
  assert.equal(isPopoverOpen(pop), false, `${label}:預設關閉`);

  trigger.focus();
  trigger.fire('click');
  assert.equal(isPopoverOpen(pop), true, `${label}:點觸發鈕開啟`);
  assert.equal(trigger.getAttribute('aria-expanded'), null, `${label}:JS 不得手寫 aria-expanded`);
  trigger.fire('click');
  assert.equal(isPopoverOpen(pop), false, `${label}:再點一次關閉(不會關了又重開)`);

  trigger.fire('click');
  ctx.doc.lightDismiss(ctx.doc.ids.rows);
  assert.equal(isPopoverOpen(pop), false, `${label}:點選單外面 light dismiss`);

  trigger.focus();
  trigger.fire('click');
  assert.equal(isPopoverOpen(pop), true, `${label}:前置:重新開啟`);
  ctx.doc.pressEscape();
  assert.equal(isPopoverOpen(pop), false, `${label}:Esc 關閉`);
  assert.equal(trigger.getAttribute('aria-expanded'), null, `${label}:關閉後也不手寫 aria-expanded`);
}

test('popover ⋯ 紀錄選單(#moreMenu):點開、再點關、點外關、Esc 關;開啟時定位在觸發鈕下緣右對齊', async () => {
  const ctx = await initRecordsPage();
  await checkPopoverCycle(ctx, ctx.doc.ids.moreBtn, ctx.doc.ids.moreMenu, '#moreMenu');

  ctx.doc.ids.moreBtn.fire('click');
  // stub 的 getBoundingClientRect:bottom=10、right=10;clientWidth=1000;沒注入 window 時捲動量為 0。
  assert.equal(ctx.doc.ids.moreMenu.style.top, '16px', 'beforetoggle 定位:top = 觸發鈕 bottom + 6');
  assert.equal(ctx.doc.ids.moreMenu.style.right, '990px', 'beforetoggle 定位:right = clientWidth - 觸發鈕 right');
});

test('popover 篩選(#chipsRow):點開、再點關、點外關、Esc 關', async () => {
  const ctx = await initRecordsPage();
  await checkPopoverCycle(ctx, ctx.doc.ids.filterBtn, ctx.doc.ids.chipsRow, '#chipsRow');
});

test('popover 帳號選單(#acctMenu):點開聚焦第一項、再點關、點外關、Esc 關並把焦點還給觸發鈕', async () => {
  const ctx = makeAccountCtx();
  await ctx.controller.init();
  await settle();
  await checkPopoverCycle(ctx, ctx.doc.ids.acctTrigger, ctx.doc.ids.acctMenu, '#acctMenu');

  ctx.doc.ids.acctTrigger.focus();
  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(
    ctx.doc.activeElement,
    ctx.doc.getElementById('acctSyncNowBtn'),
    'toggle(newState=open)時聚焦第一個可用項目'
  );
  ctx.doc.pressEscape();
  assert.equal(ctx.doc.activeElement, ctx.doc.ids.acctTrigger, 'Esc 關閉後焦點回觸發鈕');
});

test('popover 帳號選單:開著時轉為登出，選單以 hidePopover 收起', async () => {
  const ctx = makeAccountCtx();
  await ctx.controller.init();
  await settle();
  ctx.doc.ids.acctTrigger.fire('click');
  assert.equal(isPopoverOpen(ctx.doc.ids.acctMenu), true, '前置:選單開著');
  ctx.controller.setSyncState(SIGNED_OUT);
  assert.equal(isPopoverOpen(ctx.doc.ids.acctMenu), false, '登出分支要收起選單');
});

test('popover 帳號選單:開裝置對話框時選單收起(showModal 收掉 auto popover)', async () => {
  const { ctx } = await openDevices();
  assert.equal(ctx.doc.ids.devicesOverlay.open, true, '前置:裝置對話框開著');
  assert.equal(isPopoverOpen(ctx.doc.ids.acctMenu), false, '帳號選單已收起');
  assert.equal(ctx.doc._popovers.filter((p) => p._popoverType === 'auto').length, 0, '沒有殘留的選單');
});

test('popover 警示名單列 ⋯:點開、再點關、點外關、Esc 關;⋯ 鈕沒有 aria-expanded', async () => {
  const ctx = makeScamCtx();
  await ctx.controller.init();
  await settle();
  const row = scamRow(ctx.doc, SCAM_ID_A);
  const btn = firstByClass(row, 'scam-menu-btn');
  const menu = firstByClass(row, 'scam-menu');
  assert.ok(btn && menu, '前置:列上有 ⋯ 鈕與選單');
  const popAttr = typeof menu.popover === 'string' ? menu.popover : menu.getAttribute('popover');
  assert.ok(popAttr === 'auto' || popAttr === '', '動態選單要設成 auto popover(以 IDL el.popover 設定)');
  assert.notEqual(menu.hidden, true, '選單不得再用 hidden 控制開合');
  assert.equal(btn.getAttribute('aria-expanded'), null, '⋯ 鈕不得寫 aria-expanded');
  await checkPopoverCycle(ctx, btn, menu, '名單列 ⋯');
});

test('popover 警示名單列 ⋯:整份重畫後舊選單自動隱藏，新列的選單可正常開啟(不殘留 openScamMenu 狀態)', async () => {
  const ctx = makeScamCtx();
  await ctx.controller.init();
  await settle();
  const oldRow = scamRow(ctx.doc, SCAM_ID_A);
  const oldMenu = firstByClass(oldRow, 'scam-menu');
  firstByClass(oldRow, 'scam-menu-btn').fire('click');
  assert.equal(isPopoverOpen(oldMenu), true, '前置:⋯ 選單開著');

  emitBlocklist(ctx, scamFixture(4));
  await settle();

  const newRow = scamRow(ctx.doc, SCAM_ID_A);
  assert.notEqual(newRow, oldRow, '前置:名單列已整份重畫');
  assert.equal(isPopoverOpen(oldMenu), false, '被移出文件的舊選單自動隱藏');
  assert.equal(ctx.doc._popovers.filter((p) => p._popoverType === 'auto').length, 0, '沒有殘留開著的選單');
  const newMenu = firstByClass(newRow, 'scam-menu');
  assert.equal(isPopoverOpen(newMenu), false, '新列的選單預設關閉');
  firstByClass(newRow, 'scam-menu-btn').fire('click');
  assert.equal(isPopoverOpen(newMenu), true, '新列的 ⋯ 一次就能打開');
});

// ============================================================
// 命中對話框就地更新(B2 延伸)
// ============================================================

test('B2 延伸:命中對話框開著時 scamBlocklist 變動，條目仍在就地更新內容且保持開啟;關閉後焦點回新 pill', async () => {
  const { ctx, opener: oldPill } = await openHits();
  const dlg = ctx.doc.ids.scamHitsOverlay;
  assert.equal(firstByClass(ctx.doc.ids.scamHitsList, 'scam-evidence-text') !== null, true, '前置:對話框有證據');
  const before = walkNodes(ctx.doc.ids.scamHitsList, []).filter((n) => classListOf(n).includes('scam-evidence-text')).length;
  assert.equal(before, 3, '前置:三筆證據');

  emitBlocklist(ctx, scamFixture(4));
  await settle();

  assert.equal(dlg.open, true, '條目仍在時不得關閉命中對話框');
  const after = walkNodes(ctx.doc.ids.scamHitsList, []).filter((n) => classListOf(n).includes('scam-evidence-text')).length;
  assert.equal(after, 4, '內容就地更新成四筆');
  assert.ok(
    ctx.doc.ids.scamHitsTitle.textContent.includes(i18n.fmt('zh', 'opScamHitCount', { n: 4 })),
    '標題的篇數跟著更新'
  );

  ctx.doc.ids.scamHitsClose.fire('click');
  const newPill = firstByClass(scamRow(ctx.doc, SCAM_ID_A), 'scam-hit-count');
  assert.notEqual(newPill, oldPill, '前置:pill 已隨重畫換新');
  assert.equal(ctx.doc.activeElement, newPill, '舊 pill 已離開文件，焦點改落在同一位作者的新 pill');
});

test('B2 延伸:命中對話框開著時該條目被解除(dismissed)，對話框關閉', async () => {
  const { ctx } = await openHits();
  assert.equal(ctx.doc.ids.scamHitsOverlay.open, true, '前置:命中對話框以 showModal 開啟');
  emitBlocklist(ctx, scamFixture(3, { state: 'dismissed', dismissedAt: SCAM_NOW - 60000 }));
  await settle();
  assert.equal(ctx.doc.ids.scamHitsOverlay.open, false, '條目已不在名單上，命中對話框要關閉');
  assert.equal(ctx.doc._modal.length, 0, 'top layer 不殘留 modal');
});
