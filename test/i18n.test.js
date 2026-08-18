// test/i18n.test.js — 共用 i18n 模組(i18n.js)的行為契約:語言解析的
// fallback 鏈、查無 key 的退路、樣板插值,以及 zh/en 兩份字典的 key 對齊
// (漏translate 一鍵就紅燈,不必逐 key 寫斷言)。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const i18n = require(path.join(__dirname, '..', 'i18n.js'));

test('resolveLocale:明確偏好 zh/en 直接採用,不看 fallback', () => {
  assert.equal(i18n.resolveLocale('zh', 'en-US'), 'zh');
  assert.equal(i18n.resolveLocale('en', 'zh-TW'), 'en');
});

test('resolveLocale:偏好未設定時依 fallback 語言偵測,zh 開頭歸 zh、其餘歸 en', () => {
  assert.equal(i18n.resolveLocale(null, 'zh-TW'), 'zh');
  assert.equal(i18n.resolveLocale(null, 'zh-Hant-TW'), 'zh');
  assert.equal(i18n.resolveLocale(undefined, 'en-US'), 'en');
  assert.equal(i18n.resolveLocale(null, 'ja'), 'en');
  // 偏好值非法(不是 'zh'/'en')視同未設定。
  assert.equal(i18n.resolveLocale('auto', 'zh-TW'), 'zh');
  // fallback 也拿不到語言時,安全預設為 en(測試環境無 chrome/navigator)。
  assert.equal(i18n.resolveLocale(null, ''), 'en');
});

test('t:查無 key 退回 zh 字典,再退回 key 本身,不丟例外', () => {
  assert.equal(i18n.t('en', 'ppHistorySettings'), 'History & settings');
  assert.equal(i18n.t('zh', 'ppHistorySettings'), '紀錄與設定');
  assert.equal(i18n.t('en', 'no-such-key'), 'no-such-key');
  // 未知 locale 退回 zh 字典。
  assert.equal(i18n.t('ja', 'ppHistorySettings'), '紀錄與設定');
});

test('fmt:{name} 逐一插值,缺對應值時保留原樣', () => {
  assert.equal(
    i18n.fmt('zh', 'bgSuccess', { url: 'https://www.threads.com/@x/post/y' }),
    '已複製乾淨網址:https://www.threads.com/@x/post/y'
  );
  assert.equal(i18n.fmt('en', 'opShowing', { a: 20, b: 34 }), 'Showing 20 / 34');
  assert.equal(i18n.fmt('zh', 'opShowing', { a: 20 }), '顯示 20 / {b} 筆');
});

test('字典對齊:zh 與 en 的 key 集合完全一致', () => {
  const zhKeys = Object.keys(i18n.STRINGS.zh).sort();
  const enKeys = Object.keys(i18n.STRINGS.en).sort();
  assert.deepEqual(enKeys, zhKeys, 'zh/en 字典的 key 必須一一對應,不得漏翻');
});

// 0.4.0 新增:貼文互動列複製 icon(post-icon.js)的淨化紀錄 kind 標籤，
// options 頁篩選 chip 與紀錄列都靠這個 key 顯示文案。
test('opKindIcon:zh 與 en 兩份字典皆有此 key，且皆非空字串', () => {
  assert.equal(typeof i18n.STRINGS.zh.opKindIcon, 'string');
  assert.ok(i18n.STRINGS.zh.opKindIcon.length > 0);
  assert.equal(typeof i18n.STRINGS.en.opKindIcon, 'string');
  assert.ok(i18n.STRINGS.en.opKindIcon.length > 0);
});

// 0.5.0 方案甲(歷史即收藏，撤獨立收藏分頁):options 收藏分頁專用的 8 個
// 基座 key(favTabLabel/favEmpty/favExport/favImport 等)已隨分頁移除，原本
// 鎖這批 key 存在性的測試跟著撤除。互動列書籤 icon(post-icon.js，另一
// 車道)仍在用 favIconTooltip/favSaved/favRemoved/favFull，這裡刻意不動
// post-icon.js，故該 4 個 key 仍保留在字典裡(見 i18n.js 對應註解)；
// favContextLost 為孤兒提示，移交複製路徑使用，一併鎖存在性。
test('favContextLost:zh 與 en 兩份字典皆有此 key，且皆非空字串(孤兒提示，移交複製路徑使用)', () => {
  assert.equal(typeof i18n.STRINGS.zh.favContextLost, 'string');
  assert.ok(i18n.STRINGS.zh.favContextLost.length > 0);
  assert.equal(typeof i18n.STRINGS.en.favContextLost, 'string');
  assert.ok(i18n.STRINGS.en.favContextLost.length > 0);
});
