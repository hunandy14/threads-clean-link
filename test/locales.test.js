// test/locales.test.js — _locales/ 雙語門面的靜態防回歸測試(車道 B)。
//
// 只做靜態檢查，不啟動瀏覽器、不驗證 Chrome 實際挑語系的行為:
//   1. en / zh_TW 兩份 messages.json 皆可被 JSON.parse(順帶驗證無 BOM，
//      有 BOM 時 JSON.parse 在 Node 也會直接丟錯)。
//   2. 兩份檔案的鍵集合一致(extName、extDesc)。
//   3. manifest.json 的 name / description 為 __MSG_xxx__ 參照，且
//      default_locale 欄位存在。
//   4. zh_TW 的 extDesc 不含半形逗號(全域中文標點規範:一律全形「，」)。
//   5. extName / extDesc 皆不超過 Chrome Web Store 的字數上限
//      (name ≤ 45、description ≤ 132)。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const EN_PATH = path.join(REPO_ROOT, '_locales', 'en', 'messages.json');
const ZH_TW_PATH = path.join(REPO_ROOT, '_locales', 'zh_TW', 'messages.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'manifest.json');

const CWS_NAME_MAX = 45;
const CWS_DESC_MAX = 132;

function readRaw(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function parseMessages(filePath) {
  return JSON.parse(readRaw(filePath));
}

// ---- 1. 兩份 messages.json 皆可被 JSON.parse(順帶驗證無 BOM) ----

test('locales:_locales/en/messages.json 可被 JSON.parse', () => {
  assert.doesNotThrow(() => parseMessages(EN_PATH));
});

test('locales:_locales/zh_TW/messages.json 可被 JSON.parse', () => {
  assert.doesNotThrow(() => parseMessages(ZH_TW_PATH));
});

test('locales:兩份 messages.json 開頭皆無 UTF-8 BOM', () => {
  for (const filePath of [EN_PATH, ZH_TW_PATH]) {
    const buf = fs.readFileSync(filePath);
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
    assert.equal(hasBom, false, `${filePath} 不得帶 UTF-8 BOM`);
  }
});

// ---- 2. 鍵集合一致 ----

test('locales:en 與 zh_TW 的鍵集合皆為 extName、extDesc，且彼此一致', () => {
  const en = parseMessages(EN_PATH);
  const zhTW = parseMessages(ZH_TW_PATH);

  const expectedKeys = ['extDesc', 'extName'];
  assert.deepEqual(Object.keys(en).sort(), expectedKeys);
  assert.deepEqual(Object.keys(zhTW).sort(), expectedKeys);

  for (const key of expectedKeys) {
    assert.equal(typeof en[key].message, 'string');
    assert.ok(en[key].message.length > 0, `en.${key}.message 不得為空字串`);
    assert.equal(typeof zhTW[key].message, 'string');
    assert.ok(zhTW[key].message.length > 0, `zh_TW.${key}.message 不得為空字串`);
  }
});

// ---- 3. manifest.json 的 __MSG_ 參照與 default_locale ----

test('locales:manifest.json 的 name/description 為 __MSG_ 參照，且 default_locale 存在', () => {
  const manifest = JSON.parse(readRaw(MANIFEST_PATH));

  assert.equal(manifest.name, '__MSG_extName__');
  assert.equal(manifest.description, '__MSG_extDesc__');
  assert.equal(manifest.default_locale, 'en');
});

// ---- 4. zh_TW 的 extDesc 不含半形逗號 ----

test('locales:zh_TW 的 extDesc 不含半形逗號(中文語句一律全形「，」)', () => {
  const zhTW = parseMessages(ZH_TW_PATH);

  assert.ok(
    !zhTW.extDesc.message.includes(','),
    'zh_TW.extDesc.message 不得含半形逗號 ","'
  );
});

// ---- 5. CWS 字數上限(name ≤ 45、description ≤ 132) ----

test('locales:extName 與 extDesc 皆未超過 Chrome Web Store 字數上限', () => {
  const en = parseMessages(EN_PATH);
  const zhTW = parseMessages(ZH_TW_PATH);

  for (const [label, messages] of [['en', en], ['zh_TW', zhTW]]) {
    const nameLen = [...messages.extName.message].length;
    const descLen = [...messages.extDesc.message].length;
    assert.ok(
      nameLen <= CWS_NAME_MAX,
      `${label}.extName 長度 ${nameLen} 超過上限 ${CWS_NAME_MAX}`
    );
    assert.ok(
      descLen <= CWS_DESC_MAX,
      `${label}.extDesc 長度 ${descLen} 超過上限 ${CWS_DESC_MAX}`
    );
  }
});
