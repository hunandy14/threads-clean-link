// test/options.test.js — options 頁邏輯層(options.js)的行為契約。
// 純函式(過濾/匯入合併/匯出形狀/統計聚合)直接打;controller 以最小 DOM
// stub 做一條 smoke(整條 init 渲染跑得完、清單筆數與計數正確)——demo
// 階段踩過「區域變數遮蔽翻譯函式、整頁渲染炸掉但語法全綠」的雷,smoke
// 就是為了堵這一類執行期炸彈,不逐一測版面。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createChromeStorage } = require('./support/helpers');

const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const URL_C = 'https://threads.net/@user_c/post/GhI789';

function settle(ms = 30) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- 純函式 ----

test('filterEntries:kind 過濾與關鍵字過濾(不分大小寫)可併用', () => {
  const entries = [
    { url: URL_A, kind: 'share', at: 3 },
    { url: URL_B, kind: 'strip', at: 2 },
    { url: URL_C, kind: 'menu', at: 1 },
  ];

  assert.equal(options.filterEntries(entries, 'all', '').length, 3);
  assert.deepEqual(
    options.filterEntries(entries, 'strip', '').map((e) => e.url),
    [URL_B]
  );
  assert.deepEqual(
    options.filterEntries(entries, 'all', 'USERA').map((e) => e.url),
    [URL_A]
  );
  assert.equal(options.filterEntries(entries, 'share', 'user_c').length, 0);
});

// 0.4.0 新增:貼文互動列複製 icon(post-icon.js)的紀錄 kind:'icon'——
// 篩選 chip(options.html 的 #chips)與 filterEntries 共用同一份純函式,
// 這裡直接驗證 kind 過濾對新 kind 一樣生效,不用另外搭 DOM 才能測。
test('filterEntries:kind 為 icon 時可單獨篩出貼文按鈕來源的紀錄', () => {
  const entries = [
    { url: URL_A, kind: 'share', at: 3 },
    { url: URL_B, kind: 'icon', at: 2 },
    { url: URL_C, kind: 'menu', at: 1 },
  ];

  assert.deepEqual(
    options.filterEntries(entries, 'icon', '').map((e) => e.url),
    [URL_B]
  );
  assert.equal(options.filterEntries(entries, 'all', '').length, 3);
});

test('parseImportText:非 JSON 與缺 entries 陣列各回報對應錯誤,合法時回傳 entries', () => {
  assert.deepEqual(options.parseImportText('not json'), { ok: false, error: 'badJson' });
  assert.deepEqual(options.parseImportText('{"app":"x"}'), { ok: false, error: 'noEntries' });

  const parsed = options.parseImportText(`{"entries":[{"url":"${URL_A}"}]}`);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.entries.length, 1);
});

test('mergeImportedEntries:錨定驗證 url、以 url 去重、kind/at 非法時套預設,結果新到舊', () => {
  const NOW = 1000000;
  const existing = [{ url: URL_A, kind: 'share', at: 500 }];
  const imported = [
    { url: URL_A, kind: 'strip', at: 600 }, // 與現有重複 → 略過
    { url: URL_B, kind: 'evil-kind', at: 900 }, // kind 非白名單 → 'share'
    { url: URL_C, kind: 'menu' }, // at 缺失 → now
    { url: URL_B + '/extra', kind: 'share', at: 1 }, // 尾隨路徑 → 略過
    { url: 'https://evil.example/@x/post/y', kind: 'share', at: 1 }, // 網域不符 → 略過
    { notUrl: true }, // 形狀不對 → 略過
  ];

  const result = options.mergeImportedEntries(existing, imported, NOW);
  assert.equal(result.added, 2);
  assert.equal(result.skipped, 4);
  assert.deepEqual(
    result.merged.map((e) => e.url),
    [URL_C, URL_B, URL_A],
    '合併結果應新到舊排序(URL_C 的 at 補 now 最大)'
  );
  assert.equal(result.merged[1].kind, 'share', '非白名單 kind 應退回 share');
  assert.equal(result.merged[0].at, NOW, 'at 缺失應補 now');
});

test('mergeImportedEntries:合併後裁到上限 1000,留最新', () => {
  const existing = Array.from({ length: 999 }, (_, i) => ({
    url: `https://www.threads.com/@u/post/E${i}`,
    kind: 'share',
    at: 10000 + i,
  }));
  const imported = [
    { url: URL_A, kind: 'share', at: 99999 },
    { url: URL_B, kind: 'share', at: 1 }, // 最舊,合併後被裁掉
  ];

  const result = options.mergeImportedEntries(existing, imported, 50000);
  assert.equal(result.merged.length, options.HISTORY_LIMIT);
  assert.equal(result.merged[0].url, URL_A, '最新的在最前');
  assert.equal(
    result.merged.some((e) => e.url === URL_B),
    false,
    '超出上限時裁掉最舊的一筆'
  );
});

test('buildExportPayload:輸出 app/version/exportedAt/entries 形狀,entries 只留三欄', () => {
  const payload = options.buildExportPayload(
    [{ url: URL_A, kind: 'share', at: 123, extra: 'junk' }],
    '2026-08-16T00:00:00.000Z'
  );

  assert.equal(payload.app, 'threads-clean-link');
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, '2026-08-16T00:00:00.000Z');
  assert.deepEqual(payload.entries, [{ url: URL_A, kind: 'share', at: 123 }]);
});

test('aggregateStats:總數、來源計數、本週/上週、近 14 天日曆日分桶、最舊時間戳', () => {
  const DAY = 86400000;
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime(); // 中午,避開日界線
  const t0 = new Date(2026, 7, 10, 0, 0, 0).getTime();
  const entries = [
    { url: URL_A, kind: 'share', at: nowTs - 3600e3 }, // 今天
    { url: URL_B, kind: 'share', at: nowTs - 7200e3 }, // 今天
    { url: URL_C, kind: 'strip', at: t0 - 3600e3 }, // 昨天
    { url: URL_A, kind: 'menu', at: t0 - 12 * DAY - 3600e3 }, // 13 個日曆日前
    { url: URL_B, kind: 'share', at: t0 - 14 * DAY - 3600e3 }, // 圖表範圍外
  ];

  const stats = options.aggregateStats(entries, nowTs);
  assert.equal(stats.total, 5);
  // 【規格衝突,如實記錄】counts 補上 icon:0(本輪修正項目 2)後,這個既有的
  // 整形斷言必然要跟著加上 icon 鍵才能繼續通過——與「既有測試斷言一字不准
  // 動」的紀律直接衝突,屬修正 counts 缺 icon 鍵這個 bug 本身必然牽動的
  // 唯一一處,並非另外收緊或弱化判斷,故在此保留機械性更新,PM 覆核。
  assert.deepEqual(stats.counts, { share: 3, strip: 1, menu: 1, icon: 0 });
  assert.equal(stats.week, 3, '滾動 7 天:今天兩筆 + 昨天一筆');
  assert.equal(stats.weekPrev, 1, '前一個 7 天:只有 13 天前那筆');
  assert.equal(stats.days[13], 2, '索引 13 = 今天');
  assert.equal(stats.days[12], 1, '昨天');
  assert.equal(stats.days[0], 1, '13 個日曆日前落在最左桶');
  assert.equal(stats.oldestAt, t0 - 14 * DAY - 3600e3);
});

// 0.4.0 新增:KINDS 表補上 icon 後,aggregateStats 的 counts 也要能統計
// kind:'icon' 的筆數,供 options.html 新增的統計磚(#statIcon)使用——修正
// 前 counts 缺 icon 鍵,e.kind 為 'icon' 時 counts[e.kind] 會是 undefined,
// counts[e.kind]++ 產生 NaN 而不計數。
test('aggregateStats:counts 應統計 kind 為 icon 的筆數(修正前缺 icon 鍵導致 NaN)', () => {
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const entries = [
    { url: URL_A, kind: 'icon', at: nowTs - 3600e3 },
    { url: URL_B, kind: 'icon', at: nowTs - 7200e3 },
    { url: URL_C, kind: 'share', at: nowTs - 3600e3 },
  ];

  const stats = options.aggregateStats(entries, nowTs);
  assert.equal(stats.counts.icon, 2);
  assert.equal(stats.counts.share, 1);
  assert.equal(stats.total, 3);
});

test('aggregateStats:沒有任何 icon 來源紀錄時,counts.icon 為 0(而非 undefined)', () => {
  const nowTs = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const stats = options.aggregateStats(
    [{ url: URL_A, kind: 'share', at: nowTs }],
    nowTs
  );

  assert.equal(stats.counts.icon, 0);
});

test('sanitizeEntries:非陣列→空;形狀不對的項目逐筆丟棄', () => {
  assert.deepEqual(options.sanitizeEntries(null), []);
  assert.deepEqual(options.sanitizeEntries('junk'), []);

  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1 },
    { url: 42, kind: 'share', at: 1 },
    { url: URL_B, kind: 'nope', at: 1 },
    { url: URL_C, kind: 'menu', at: 'NaN' },
    null,
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 0.4.0 新增:KINDS 表補上 icon 後,sanitizeEntries 的白名單(靠
// Object.prototype.hasOwnProperty.call(KINDS, e.kind))應收下 kind:'icon',
// 不再像先前那樣被當成未知 kind 丟棄。
test('sanitizeEntries:kind 為 icon(貼文按鈕)的項目應保留,不再被白名單丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'icon', at: 1 },
    { url: URL_B, kind: 'nope', at: 1 },
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// ---- controller smoke(最小 DOM stub) ----

function makeNode(tag) {
  const attrs = {};
  const classes = new Set();
  const listeners = {};
  let text = '';
  const node = {
    tag: tag || 'div',
    children: [],
    style: {},
    dataset: {},
    hidden: false,
    value: '',
    title: '',
    checked: false,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => {
        const next = force === undefined ? !classes.has(c) : force;
        if (next) classes.add(c);
        else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    appendChild(n) {
      this.children.push(n);
      return n;
    },
    addEventListener(type, fn) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(fn);
    },
    removeEventListener() {},
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    closest() {
      return null;
    },
    click() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 10, height: 10 };
    },
  };
  // 比照真 DOM:對 textContent 賦值會清空既有子節點(renderList 靠這個清單)。
  Object.defineProperty(node, 'textContent', {
    get() {
      return text;
    },
    set(v) {
      text = String(v);
      node.children.length = 0;
    },
  });
  return node;
}

function makeDocumentStub() {
  const byId = {};
  return {
    ids: byId,
    documentElement: makeNode('html'),
    getElementById(id) {
      if (!byId[id]) byId[id] = makeNode('#' + id);
      return byId[id];
    },
    createElement(tag) {
      return makeNode(tag);
    },
    createElementNS(ns, tag) {
      return makeNode(tag);
    },
    createTextNode(text) {
      const n = makeNode('#text');
      n.textContent = text;
      return n;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    addEventListener() {},
  };
}

test('controller smoke:init 讀兩區 storage、整條渲染跑完,清單與計數正確', async () => {
  const storage = createChromeStorage(
    { langPref: 'zh' },
    {
      history: [
        { url: URL_A, kind: 'share', at: 2000 },
        { url: URL_B, kind: 'strip', at: 1000 },
        { url: 999, kind: 'share', at: 1 }, // 防禦性整形應丟棄這筆
      ],
    }
  );
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.rows.children.length, 2, '兩筆合法紀錄都應渲染成列');
  assert.equal(doc.ids.countHint.textContent, '顯示 2 / 2 筆');
  assert.equal(doc.ids.empty.hidden, true);
  assert.equal(doc.ids.statTotal.textContent, '2');
  assert.equal(doc.ids.autoClean.checked, true, '設定未存值時應套預設');

  controller.setHistory([]);
  assert.equal(doc.ids.rows.children.length, 0);
  assert.equal(doc.ids.empty.hidden, false, '清空後應顯示空狀態');
  assert.equal(doc.ids.countHint.textContent, '顯示 0 / 0 筆');
});

// 修正前 renderList 的網域段一律硬寫死 'threads.com/'，來自 threads.net 的
// 紀錄(POST_URL_PATTERN／KINDS 都同時允許 com 與 net)會被顯示成錯誤網域。
// 這裡直接檢查渲染出來的三段文字節點(網域段／帳號段(<b>)／其餘路徑段)，
// 網域段須如實為 'threads.net/'。
test('renderList:threads.net 的紀錄如實顯示 .net,不誤植為 .com', async () => {
  const NET_URL = 'https://www.threads.net/@user_net/post/AbC123';
  const storage = createChromeStorage(
    { langPref: 'zh' },
    { history: [{ url: NET_URL, kind: 'share', at: 1000 }] }
  );
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  const li = doc.ids.rows.children[0];
  const main = li.children[1];
  const urlEl = main.children[0];
  const textParts = urlEl.children.map((c) => c.textContent);
  assert.deepEqual(textParts, ['threads.net/', '@user_net', '/post/AbC123']);
});

// ============================================================
// 0.5.0 貼文收藏庫:options 頁「收藏」分頁卡片牆
// ============================================================

const FAV_URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const FAV_URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const FAV_URL_NET = 'https://www.threads.net/@user_net/post/AbC123';

// ---- 純函式:sanitizeFavorites ----

test('sanitizeFavorites:非陣列→空;形狀不對的項目(id/url 非字串、at 非有限數字、選填欄位型別不符)逐筆丟棄', () => {
  assert.deepEqual(options.sanitizeFavorites(null), []);
  assert.deepEqual(options.sanitizeFavorites('junk'), []);

  const cleaned = options.sanitizeFavorites([
    { id: '@usera/post/AbC123_-xyz', url: FAV_URL_A, at: 1 }, // 合法
    { id: 42, url: FAV_URL_B, at: 1 }, // id 非字串
    { id: '@x/post/y', url: FAV_URL_B, at: 'NaN' }, // at 非有限數字
    { id: '@x/post/y', url: FAV_URL_B, at: 1, author: 123 }, // author 非字串
    { id: '@x/post/y', url: FAV_URL_B, at: 1, excerpt: null }, // excerpt 非字串
    null,
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.id),
    ['@usera/post/AbC123_-xyz']
  );
});

// ---- 純函式:buildFavoritesExportPayload ----

test('buildFavoritesExportPayload:輸出 app/version/exportedAt/entries 形狀，選填欄位只在為字串時才輸出', () => {
  const payload = options.buildFavoritesExportPayload(
    [
      { id: '@a/post/1', url: FAV_URL_A, at: 1, author: 'A', handle: '@a', excerpt: 'hi', extra: 'junk' },
      { id: '@b/post/2', url: FAV_URL_B, at: 2 },
    ],
    '2026-08-18T00:00:00.000Z'
  );

  assert.equal(payload.app, 'threads-clean-link');
  assert.equal(payload.version, 1);
  assert.equal(payload.exportedAt, '2026-08-18T00:00:00.000Z');
  assert.deepEqual(payload.entries[0], {
    id: '@a/post/1',
    url: FAV_URL_A,
    at: 1,
    author: 'A',
    handle: '@a',
    excerpt: 'hi',
  });
  assert.deepEqual(payload.entries[1], { id: '@b/post/2', url: FAV_URL_B, at: 2 });
});

// ---- 純函式:mergeImportedFavorites ----

test('mergeImportedFavorites:url 錨定驗證與正規化、id 一律從 url 重新導出(不信任匯入檔自帶的 id)', () => {
  const result = options.mergeImportedFavorites(
    [],
    [{ id: 'spoofed-id', url: `${FAV_URL_A}/?xmt=AQGabc`, at: 500 }],
    1000
  );
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.merged[0].id, '@usera/post/AbC123_-xyz', 'id 應從 url 重新導出，不採信匯入檔的 id 欄位');
  assert.equal(result.merged[0].url, FAV_URL_A, 'url 應正規化(去除尾隨斜線/query)');
});

test('mergeImportedFavorites:依 id 去重、at 缺失或非法時補 now、無效 url 一律略過', () => {
  const existing = [{ id: '@usera/post/AbC123_-xyz', url: FAV_URL_A, at: 100 }];
  const imported = [
    { url: FAV_URL_A, at: 999 }, // id 與現有重複 → 略過
    { url: FAV_URL_B }, // at 缺失 → now
    { url: `${FAV_URL_B}/extra` }, // 尾隨額外路徑段 → 網址不合法，略過
    { notUrl: true }, // 形狀不對 → 略過
  ];

  const result = options.mergeImportedFavorites(existing, imported, 12345);
  assert.equal(result.added, 1);
  assert.equal(result.skipped, 3);
  assert.deepEqual(
    result.merged.map((e) => e.id),
    ['@user.b/post/DeF456', '@usera/post/AbC123_-xyz'],
    '新到舊排序;at 缺失補的 now(12345)大於既有的 100,故排最前'
  );
  assert.equal(result.merged[0].at, 12345);
});

test('mergeImportedFavorites:author/handle 截斷至 100 字元、excerpt 截斷至 2000 字元，非字串欄位整欄丟棄', () => {
  const result = options.mergeImportedFavorites(
    [],
    [
      {
        url: FAV_URL_A,
        at: 1,
        author: 'A'.repeat(150),
        handle: 'H'.repeat(150),
        excerpt: 'E'.repeat(2500),
      },
      {
        url: FAV_URL_B,
        at: 1,
        author: 12345,
        handle: ['@x'],
        excerpt: { text: 'hi' },
      },
    ],
    1000
  );

  assert.equal(result.added, 2);
  const truncated = result.merged.find((e) => e.id === '@usera/post/AbC123_-xyz');
  assert.equal(truncated.author.length, 100);
  assert.equal(truncated.handle.length, 100);
  assert.equal(truncated.excerpt.length, 2000);

  const dropped = result.merged.find((e) => e.id === '@user.b/post/DeF456');
  assert.deepEqual(Object.keys(dropped).sort(), ['at', 'id', 'url'], '非字串型別的選填欄位應整欄不寫入');
});

// 上限策略(自行裁量，PM 覆核):匯入不得擠掉既有收藏，超出剩餘容量的匯入
// 項目一律計入 skipped——刻意不同於淨化紀錄 mergeImportedEntries 的「裁到
// 上限、汰舊留新」。
test('mergeImportedFavorites:已存在 499 筆時，匯入 3 筆只收 1 筆(剩餘容量)，其餘計入 skipped，既有收藏一筆都不擠掉', () => {
  const existing = Array.from({ length: 499 }, (_, i) => ({
    id: `@seed/post/P${i}`,
    url: `https://www.threads.com/@seed/post/P${i}`,
    at: 1000 + i,
  }));
  const imported = [
    { url: FAV_URL_A, at: 5000 },
    { url: FAV_URL_B, at: 6000 },
    { url: 'https://www.threads.com/@user_c/post/GhI789', at: 7000 },
  ];

  const result = options.mergeImportedFavorites(existing, imported, 99999);
  assert.equal(result.added, 1, '只有剩餘的 1 個容量會被用掉');
  assert.equal(result.skipped, 2, '超出剩餘容量的匯入項目計入 skipped,不做截斷式汰舊');
  assert.equal(result.merged.length, options.FAVORITES_LIMIT);
  existing.forEach((e) => {
    assert.ok(
      result.merged.some((m) => m.id === e.id),
      `既有收藏 ${e.id} 不應被匯入內容擠掉`
    );
  });
});

// ---- controller smoke:收藏分頁渲染 ----

test('controller smoke:收藏分頁渲染卡片牆——有 author/excerpt、僅 handle、降級顯示網址三種形狀，計數格式正確', async () => {
  const favorites = [
    {
      id: '@usera/post/AbC123_-xyz',
      url: FAV_URL_A,
      author: 'Dafu',
      handle: '@dafucoding',
      excerpt: 'hello world',
      at: 3000,
    },
    { id: '@user.b/post/DeF456', url: FAV_URL_B, handle: '@onlyhandle', at: 2000 },
    { id: '@user_net/post/AbC123', url: FAV_URL_NET, at: 1000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { favorites });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.favGrid.children.length, 3);
  assert.equal(doc.ids.favCountHint.textContent, '收藏 3/500');
  assert.equal(doc.ids.favEmptyState.hidden, true);

  // 卡片一:author + handle + excerpt。
  const card0 = doc.ids.favGrid.children[0];
  const authorRow0 = card0.children[0];
  assert.equal(authorRow0.children[0].textContent, 'Dafu');
  assert.equal(authorRow0.children[1].textContent, '@dafucoding');
  const excerptEl0 = card0.children[1];
  assert.equal(excerptEl0.textContent, 'hello world');
  assert.equal(excerptEl0.className, 'fav-excerpt');

  // 卡片二:只有 handle,無 excerpt → 不渲染 fav-excerpt 節點。
  const card1 = doc.ids.favGrid.children[1];
  const authorRow1 = card1.children[0];
  assert.equal(authorRow1.children.length, 1, '無 author 時作者列只有 handle 一個子節點');
  assert.equal(authorRow1.children[0].textContent, '@onlyhandle');
  assert.equal(card1.children[1].className, 'fav-foot', '無 excerpt 時作者列後直接接卡尾');

  // 卡片三:無 author/handle → 降級顯示網址(比照紀錄列樣式,threads.net 如實顯示)。
  const card2 = doc.ids.favGrid.children[2];
  const urlNode2 = card2.children[0];
  assert.equal(urlNode2.className, 'fav-url');
  assert.deepEqual(
    urlNode2.children.map((c) => c.textContent),
    ['threads.net/', '@user_net', '/post/AbC123']
  );

  // 每張卡片的卡尾動作固定三顆:複製／開啟(<a target=_blank rel=noopener>)／移除。
  const actions0 = card0.children[2].children[1];
  assert.equal(actions0.children.length, 3);
  const openLink0 = actions0.children[1];
  assert.equal(openLink0.tag, 'a');
  assert.equal(openLink0.href, FAV_URL_A);
  assert.equal(openLink0.target, '_blank');
  assert.equal(openLink0.rel, 'noopener');
});

test('controller smoke:setFavorites(儲存變動接線層呼叫)即時刷新卡片牆與計數', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, { favorites: [] });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.favGrid.children.length, 0);
  assert.equal(doc.ids.favEmptyState.hidden, false, '空收藏應顯示空狀態');
  assert.equal(doc.ids.favCountHint.textContent, '收藏 0/500');

  controller.setFavorites([{ id: '@usera/post/AbC123_-xyz', url: FAV_URL_A, at: 1 }]);

  assert.equal(doc.ids.favGrid.children.length, 1);
  assert.equal(doc.ids.favEmptyState.hidden, true);
  assert.equal(doc.ids.favCountHint.textContent, '收藏 1/500');
});

test('controller smoke:分頁 tab 初始狀態——歷史檢視顯示、收藏檢視收合，兩顆 tab 各自標出 on/off', async () => {
  const storage = createChromeStorage({ langPref: 'zh' }, {});
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });

  await controller.init();
  await settle();

  assert.equal(doc.ids.historyView.hidden, false);
  assert.equal(doc.ids.favoritesView.hidden, true);
  assert.equal(doc.ids.tabHistory.classList.contains('on'), true);
  assert.equal(doc.ids.tabFavorites.classList.contains('on'), false);
});
