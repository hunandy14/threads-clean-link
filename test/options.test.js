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

// 0.5.0 方案甲(歷史即收藏):entries 擴充選填 author/handle/excerpt，為字串
// 時才輸出，規則與 sanitizeEntries/mergeImportedEntries 一致。
test('buildExportPayload:author/handle/excerpt 為字串時一併輸出，非字串或缺席則不輸出該欄', () => {
  const payload = options.buildExportPayload(
    [
      { url: URL_A, kind: 'share', at: 1, author: 'Dafu', handle: '@dafucoding', excerpt: 'hi' },
      { url: URL_B, kind: 'strip', at: 2, author: 12345 },
    ],
    '2026-08-18T00:00:00.000Z'
  );

  assert.deepEqual(payload.entries[0], {
    url: URL_A,
    kind: 'share',
    at: 1,
    author: 'Dafu',
    handle: '@dafucoding',
    excerpt: 'hi',
  });
  assert.deepEqual(payload.entries[1], { url: URL_B, kind: 'strip', at: 2 }, '非字串的 author 不輸出該欄');
});

// 0.5.0 方案甲:匯入的 url 額外容忍尾隨斜線/query/hash 並正規化(前身是
// 收藏庫基座的 FAVORITE_URL_PATTERN，方案甲改名為通用的貼文 url 驗證);
// 這裡直接驗證這個新增的容忍度，不影響既有「嚴格格式才收」的斷言。
test('mergeImportedEntries:url 容忍尾隨斜線/query/hash 並正規化(前身收藏庫的網址驗證邏輯)', () => {
  const result = options.mergeImportedEntries([], [{ url: `${URL_A}/?xmt=AQGabc`, kind: 'share', at: 1 }], 1000);
  assert.equal(result.added, 1);
  assert.equal(result.merged[0].url, URL_A, 'url 應正規化為不含尾隨斜線/query 的乾淨網址');
});

// 0.5.0 方案甲:匯入的 author/handle/excerpt 逐條 sanitize(截斷 100/100/
// 2000，非字串整欄丟棄)，規則與 background.js 落盤前的處理對齊。
test('mergeImportedEntries:author/handle 截斷至 100 字元、excerpt 截斷至 2000 字元，非字串欄位整欄丟棄', () => {
  const result = options.mergeImportedEntries(
    [],
    [
      {
        url: URL_A,
        kind: 'share',
        at: 1,
        author: 'A'.repeat(150),
        handle: 'H'.repeat(150),
        excerpt: 'E'.repeat(2500),
      },
      {
        url: URL_B,
        kind: 'share',
        at: 1,
        author: 12345,
        handle: ['@x'],
        excerpt: { text: 'hi' },
      },
    ],
    1000
  );

  assert.equal(result.added, 2);
  const truncated = result.merged.find((e) => e.url === URL_A);
  assert.equal(truncated.author.length, 100);
  assert.equal(truncated.author, 'A'.repeat(100));
  assert.equal(truncated.handle.length, 100);
  assert.equal(truncated.excerpt.length, 2000);

  const dropped = result.merged.find((e) => e.url === URL_B);
  assert.deepEqual(Object.keys(dropped).sort(), ['at', 'kind', 'url'], '非字串型別的選填欄位應整欄不寫入');
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

// 縱深防禦(PM 審查後補):url 額外過 POST_URL_PATTERN 形狀驗證——渲染層
// buildEntryCard 的 openLink.href = e.url、複製到剪貼簿都是 url sink,
// 讀取階段就該擋掉形狀不對的 url，不依賴「寫入端永遠沒漏」的假設。上一輪
// 收藏庫基座的 sanitizeFavorites 有這道檢查，方案甲把收藏搬進
// sanitizeEntries 時漏了，這裡補回來。
test('sanitizeEntries:url 形狀不對(非 threads 網域、缺 /post/ 區段、夾帶非法字元等)的條目整筆丟棄', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1 }, // 合法
    { url: 'https://www.evil.com/@evil/post/x', kind: 'share', at: 1 }, // 非 threads 網域
    { url: 'https://www.threads.com/@user/post', kind: 'share', at: 1 }, // 缺貼文 id
    { url: 'not-a-url', kind: 'share', at: 1 }, // 完全不是網址
    { url: 'https://www.threads.com/@user/post/x<y>', kind: 'share', at: 1 }, // 夾帶非法字元
  ]);
  assert.deepEqual(
    cleaned.map((e) => e.url),
    [URL_A]
  );
});

// 0.5.0 方案甲(歷史即收藏):entries 擴充選填 author/handle/excerpt。核心
// 欄位(url/kind/at)合法時，選填欄位為字串則截斷至長度上限，非字串則整欄
// 丟棄(不影響核心欄位本身，entry 仍保留)——與 mergeImportedEntries 的
// sanitizeTextField 規則一致，縱深防禦不依賴 background.js 寫入端沒漏。
test('sanitizeEntries:author/handle/excerpt 為字串時截斷至長度上限，非字串則整欄丟棄(entry 仍保留)', () => {
  const cleaned = options.sanitizeEntries([
    { url: URL_A, kind: 'share', at: 1, author: 'A'.repeat(150), handle: 'H'.repeat(150), excerpt: 'E'.repeat(2500) },
    { url: URL_B, kind: 'share', at: 1, author: 12345, handle: ['@x'], excerpt: { text: 'hi' } },
  ]);

  assert.equal(cleaned[0].author.length, 100);
  assert.equal(cleaned[0].handle.length, 100);
  assert.equal(cleaned[0].excerpt.length, 2000);

  assert.deepEqual(Object.keys(cleaned[1]).sort(), ['at', 'kind', 'url'], '非字串型別的選填欄位應整欄不寫入，但 entry 本身仍保留');
});

// ---- 純函式:hasCardPreview ----
//
// 與手機版 history-card.tsx 的 hasPreview 邏輯對齊(author 或 excerpt 任一
// 存在即算有預覽，單獨 handle 不算);紀錄卡片渲染(帶/不帶預覽兩形狀)靠
// 這個判定式決定要畫作者列+excerpt，還是降級成網址列。
test('hasCardPreview:author 或 excerpt 任一存在即為 true;皆缺席或僅有 handle 時為 false', () => {
  assert.equal(options.hasCardPreview({ author: 'Dafu' }), true);
  assert.equal(options.hasCardPreview({ excerpt: 'hello' }), true);
  assert.equal(options.hasCardPreview({ author: 'Dafu', excerpt: 'hello' }), true);
  assert.equal(options.hasCardPreview({}), false);
  assert.equal(options.hasCardPreview({ handle: '@onlyhandle' }), false, '單獨 handle 不算有預覽，對齊手機版邏輯');
  assert.equal(options.hasCardPreview({ author: '' }), false, '空字串視同缺席');
});

// ---- 設定頁不再出現 notifySuccess 控件(PM 審查後補) ----
//
// R1 同輪已把成功通知整組拆光，notifySuccess 合併後零讀取端;上一輪誤以
// 「另一車道尚未拆通知」為由保留這顆開關，是過期情報，變成誤導使用者的
// 死 UI。這裡從兩個角度釘住它不會再出現:純函式層的 SETTING_IDS/
// OPTIONS_DEFAULT_SETTINGS 不含這顆鍵，以及 options.html 原文不再有
// id="notifySuccess" 的控件(靜態檢查，照 popup.test.js 既有的 R1-3 慣例)。
test('notifySuccess:OPTIONS_DEFAULT_SETTINGS 與 SETTING_IDS 皆不含這顆鍵(成功通知已整組移除)', () => {
  assert.equal(Object.prototype.hasOwnProperty.call(options.OPTIONS_DEFAULT_SETTINGS, 'notifySuccess'), false);
});

test('notifySuccess:options.html 原文不再有 id="notifySuccess" 的控件', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'options.html'), 'utf8');
  assert.equal(/\bid\s*=\s*["']notifySuccess["']/i.test(html), false, 'options.html 不應再有 notifySuccess 控件');
  assert.equal(/\bopNotify(Name|Desc)\b/.test(html), false, 'options.html 不應再引用 opNotifyName/opNotifyDesc');
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
    // 測試專用(比照 support/helpers.js 的 createCheckboxDocument):派送
    // 任意型別的事件給已註冊的監聽器，用來模擬使用者點擊卡片動作按鈕。
    fire(type, event) {
      (listeners[type] || []).slice().forEach((fn) => fn(event || { type, target: node }));
    },
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
  // 0.5.0 方案甲:autoClean 預設值改 false(配合另一車道調整
  // background.js 的預設，popup/options 兩側鏡像同一個 fallback)。
  assert.equal(doc.ids.autoClean.checked, false, '設定未存值時應套新預設 false');

  controller.setHistory([]);
  assert.equal(doc.ids.rows.children.length, 0);
  assert.equal(doc.ids.empty.hidden, false, '清空後應顯示空狀態');
  assert.equal(doc.ids.countHint.textContent, '顯示 0 / 0 筆');
});

// 修正前 renderList 的網域段一律硬寫死 'threads.com/'，來自 threads.net 的
// 紀錄(POST_URL_PATTERN／KINDS 都同時允許 com 與 net)會被顯示成錯誤網域。
// 這裡直接檢查渲染出來的三段文字節點(網域段／帳號段(<b>)／其餘路徑段)，
// 網域段須如實為 'threads.net/'。
//
// 【必然的結構性更新，PM 覆核】0.5.0 方案甲把紀錄清單從 <li class="row">
// 改渲染成 <div class="entry-card">，原本 li → main → urlEl 的巢狀路徑不
// 復存在;這筆條目沒有 author/excerpt(hasCardPreview 為 false)，降級網址
// 節點現在是卡片(entry-header 之後)的直接子節點。行為斷言(三段文字节点
// 拆解結果)完全不變，只是 DOM 路徑跟著新結構調整，並非放寬或收緊判斷。
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

  const card = doc.ids.rows.children[0];
  const urlEl = card.children[1];
  assert.equal(urlEl.className, 'entry-url');
  const textParts = urlEl.children.map((c) => c.textContent);
  assert.deepEqual(textParts, ['threads.net/', '@user_net', '/post/AbC123']);
});

// ============================================================
// 0.5.0 方案甲(歷史即收藏):紀錄卡片牆——帶預覽 / 降級網址兩種形狀
// ============================================================

const CARD_URL_A = 'https://www.threads.com/@usera/post/AbC123_-xyz';
const CARD_URL_B = 'https://www.threads.com/@user.b/post/DeF456';
const CARD_URL_NET = 'https://www.threads.net/@user_net/post/AbC123';

test('controller smoke:紀錄卡片牆渲染——帶預覽(author+handle+excerpt)與降級網址兩種形狀', async () => {
  const history = [
    {
      url: CARD_URL_A,
      kind: 'icon',
      author: 'Dafu',
      handle: '@dafucoding',
      excerpt: 'hello world',
      at: 3000,
    },
    { url: CARD_URL_NET, kind: 'share', at: 1000 },
  ];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
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

  assert.equal(doc.ids.rows.children.length, 2);

  // 卡片一:有預覽(author+handle+excerpt)——卡頭(徽章+時間)→ 作者列 →
  // excerpt，三個動作(複製/開啟/刪除)常駐於 entry-actions。
  const card0 = doc.ids.rows.children[0];
  assert.equal(card0.className, 'entry-card');
  const header0 = card0.children[0];
  assert.equal(header0.className, 'entry-header');
  const meta0 = header0.children[0];
  assert.equal(meta0.children[0].className, 'entry-badge');
  assert.equal(meta0.children[0].textContent, '貼文按鈕', 'kind:icon 的徽章文案沿用既有 opKindIcon');
  assert.equal(meta0.children[1].className, 'entry-time');

  const authorRow0 = card0.children[1];
  assert.equal(authorRow0.className, 'entry-author-row');
  assert.equal(authorRow0.children[0].textContent, 'Dafu');
  assert.equal(authorRow0.children[1].textContent, '@dafucoding');
  const excerptEl0 = card0.children[2];
  assert.equal(excerptEl0.className, 'entry-excerpt');
  assert.equal(excerptEl0.textContent, 'hello world');

  const actions0 = card0.children[3];
  assert.equal(actions0.className, 'entry-actions');
  assert.equal(actions0.children.length, 3, '複製/開啟/刪除三個動作固定常駐 DOM(CSS 控制 hover 才顯示)');
  const openLink0 = actions0.children[1];
  assert.equal(openLink0.tag, 'a');
  assert.equal(openLink0.href, CARD_URL_A);
  assert.equal(openLink0.target, '_blank');
  assert.equal(openLink0.rel, 'noopener');

  // 卡片二:無 author/excerpt → 降級顯示網址(threads.net 如實顯示，不誤植 .com)。
  const card1 = doc.ids.rows.children[1];
  const urlEl1 = card1.children[1];
  assert.equal(urlEl1.className, 'entry-url');
  assert.deepEqual(
    urlEl1.children.map((c) => c.textContent),
    ['threads.net/', '@user_net', '/post/AbC123']
  );
});

test('controller smoke:卡片刪除動作直接改 storage 並重新渲染', async () => {
  const history = [{ url: CARD_URL_A, kind: 'share', at: 1000 }];
  const storage = createChromeStorage({ langPref: 'zh' }, { history });
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

  assert.equal(doc.ids.rows.children.length, 1);

  const card = doc.ids.rows.children[0];
  const actions = card.children[card.children.length - 1];
  const delBtn = actions.children[2];
  delBtn.fire('click');
  await settle();

  assert.equal(doc.ids.rows.children.length, 0, '刪除後卡片牆應重新渲染為空');
});
