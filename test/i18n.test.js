// test/i18n.test.js — 共用 i18n 模組(i18n.js)的行為契約:語言解析的
// fallback 鏈、查無 key 的退路、樣板插值，以及 zh/en 兩份字典的 key 對齊
// (漏translate 一鍵就紅燈，不必逐 key 寫斷言)。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const i18n = require(path.join(__dirname, '..', 'i18n.js'));

test('resolveLocale:明確偏好 zh/en 直接採用，不看 fallback', () => {
  assert.equal(i18n.resolveLocale('zh', 'en-US'), 'zh');
  assert.equal(i18n.resolveLocale('en', 'zh-TW'), 'en');
});

test('resolveLocale:偏好未設定時依 fallback 語言偵測，zh 開頭歸 zh、其餘歸 en', () => {
  assert.equal(i18n.resolveLocale(null, 'zh-TW'), 'zh');
  assert.equal(i18n.resolveLocale(null, 'zh-Hant-TW'), 'zh');
  assert.equal(i18n.resolveLocale(undefined, 'en-US'), 'en');
  assert.equal(i18n.resolveLocale(null, 'ja'), 'en');
  // 偏好值非法(不是 'zh'/'en')視同未設定。
  assert.equal(i18n.resolveLocale('auto', 'zh-TW'), 'zh');
  // fallback 也拿不到語言時，安全預設為 en(測試環境無 chrome/navigator)。
  assert.equal(i18n.resolveLocale(null, ''), 'en');
});

test('t:查無 key 退回 zh 字典，再退回 key 本身，不丟例外', () => {
  assert.equal(i18n.t('en', 'ppHistorySettings'), 'History & settings');
  assert.equal(i18n.t('zh', 'ppHistorySettings'), '紀錄與設定');
  assert.equal(i18n.t('en', 'no-such-key'), 'no-such-key');
  // 未知 locale 退回 zh 字典。
  assert.equal(i18n.t('ja', 'ppHistorySettings'), '紀錄與設定');
});

test('fmt:{name} 逐一插值，缺對應值時保留原樣', () => {
  assert.equal(
    i18n.fmt('zh', 'bgClipboardError', { url: 'https://www.threads.com/@x/post/y' }),
    '目前分頁無法寫入剪貼簿(可能是瀏覽器限制頁面)，乾淨網址為:https://www.threads.com/@x/post/y'
  );
  assert.equal(i18n.fmt('en', 'opShowing', { a: 20, b: 34 }), 'Showing 20 / 34');
  assert.equal(i18n.fmt('zh', 'opShowing', { a: 20 }), '顯示 20 / {b} 筆');
});

test('字典對齊:zh 與 en 的 key 集合完全一致', () => {
  const zhKeys = Object.keys(i18n.STRINGS.zh).sort();
  const enKeys = Object.keys(i18n.STRINGS.en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 字典的 key 必須一一對應，不得漏翻');
});

// 貼文互動列複製 icon(post-icon.js)的淨化紀錄 kind 標籤，options 頁篩選
// chip 與紀錄列都靠這個 key 顯示文案。
test('opKindIcon:zh 與 en 兩份字典皆有此 key，且皆非空字串', () => {
  assert.equal(typeof i18n.STRINGS.zh.opKindIcon, 'string');
  assert.ok(i18n.STRINGS.zh.opKindIcon.length > 0);
  assert.equal(typeof i18n.STRINGS.en.opKindIcon, 'string');
  assert.ok(i18n.STRINGS.en.opKindIcon.length > 0);
});

// 字典裡收藏相關的 key 只剩 favContextLost 這顆孤兒提示(移交複製路徑使
// 用)，其餘 fav* 基座 key 都已隨收藏分頁與書籤功能移除，這裡鎖它的存在性。
test('favContextLost:zh 與 en 兩份字典皆有此 key，且皆非空字串(孤兒提示，移交複製路徑使用)', () => {
  assert.equal(typeof i18n.STRINGS.zh.favContextLost, 'string');
  assert.ok(i18n.STRINGS.zh.favContextLost.length > 0);
  assert.equal(typeof i18n.STRINGS.en.favContextLost, 'string');
  assert.ok(i18n.STRINGS.en.favContextLost.length > 0);
});

// ---- 投資詐騙串文警示(v1 計畫 §3／§6)的文案 ----
//
// 上面的 parity 測試只保證「zh 與 en 的鍵集合一致」——兩邊同時漏掉同一顆
// key 依然全綠。詐騙警示這六顆散落在三個消費端(詳情頁/河道的標籤與
// tooltip、首次命中的 toast、選項頁總開關的名稱與說明)，漏一顆的症狀是
// UI 上直接顯示裸 key，這裡逐顆釘住存在性。
const SCAM_GUARD_KEYS = [
  // 貼文互動列上方那顆 .tcl-scam-tag 的標籤與原生 tooltip。
  'scamTagLabel',
  'scamTagTooltip',
  // 某作者第一次被判定命中、自動加入本機黑名單時的提示。
  'scamFirstHitToast',
  // 作者已在黑名單中(非本次命中)時，標籤改顯示的理由。
  'scamBlockedByList',
  // 選項頁設定卡的總開關 #scamGuardEnabled 的名稱與說明。
  'opScamGuardName',
  'opScamGuardDesc',
];

test('scamGuard:六顆警示文案 key 在 zh 與 en 兩份字典皆存在且非空', () => {
  for (const locale of ['zh', 'en']) {
    for (const key of SCAM_GUARD_KEYS) {
      const value = i18n.STRINGS[locale][key];
      assert.equal(typeof value, 'string', `${locale}.${key} 應為字串`);
      assert.ok(value.length > 0, `${locale}.${key} 不得為空字串`);
    }
  }
});

test('scamGuard:zh 文案一律全形逗號「，」，不得出現半形 ","', () => {
  for (const key of SCAM_GUARD_KEYS) {
    const value = i18n.STRINGS.zh[key];
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(','), `zh.${key} 不得含半形逗號 ","，實際:${value}`);
  }
});
