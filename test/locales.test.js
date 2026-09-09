// test/locales.test.js — _locales/ 雙語門面的靜態防回歸測試。
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

test('locales:兩份 messages.json 皆可被 JSON.parse', () => {
  for (const filePath of [EN_PATH, ZH_TW_PATH]) {
    assert.doesNotThrow(() => parseMessages(filePath), `${filePath} 應為合法 JSON`);
  }
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

// ---- 6. 裝置管理(0.7 裝置歸屬)的 i18n key 兩語齊備 ----
//
// i18n.test.js 既有的 parity 測試只保證「zh 與 en 的鍵集合一致」——兩邊
// 同時漏掉某個 key 一樣全綠。這裡按計畫 §6 的清單逐一釘住存在性，讓漏加
// 文案在測試階段就爆，而不是等到 UI 上顯示出裸 key。
// 文案本身走 i18n.js 的內建字典(非 _locales/，後者只給 manifest 的
// extName/extDesc)，故從 i18n.js 讀。
test('locales:裝置管理的 i18n key(計畫 §6)在 zh 與 en 皆存在且非空', () => {
  const i18n = require(path.join(REPO_ROOT, 'i18n.js'));

  const DEVICE_KEYS = [
    'opAccountManageDevices',
    'opDeviceCount',
    'opDeviceThisDevice',
    'opDeviceRename',
    'opDeviceRemove',
    'opDeviceRemoveDisabled',
    'opDeviceRemoveTitle',
    'opDeviceRemoveDesc',
    'opDeviceEmpty',
    'opDeviceLastSync',
    'opDeviceUnknown',
    'opDeviceRegisteredToast',
    // §12 增補一／三後才補進 i18n.js 的那批，當初漏了掛進本清單——沒被
    // parity 覆蓋的 key 就是「哪天只加了 zh、en 缺一顆」不會有人發現。
    'opDevicesTitle',
    'opDevicesSubtitle',
    'opDeviceAddedOn',
    'opDeviceNameAria',
    'opDevicesLoadError',
    'opDeviceRenameFailed',
    'opDeviceRemoveFailed',
  ];

  for (const locale of ['zh', 'en']) {
    for (const key of DEVICE_KEYS) {
      const value = i18n.STRINGS[locale][key];
      assert.equal(typeof value, 'string', `${locale}.${key} 應為字串`);
      assert.ok(value.length > 0, `${locale}.${key} 不得為空字串`);
    }
  }

  // 中文語句一律全形逗號(全域規範)。
  for (const key of DEVICE_KEYS) {
    const value = i18n.STRINGS.zh[key];
    if (typeof value !== 'string') continue;
    assert.ok(!value.includes(','), `zh.${key} 不得含半形逗號 ","`);
  }
});

// ---- 6.1 移除確認框內文(§13) ----
//
// 軟刪除定案後，移除的語意是「從清單拿掉」，紀錄與紀錄上留下的裝置名稱都
// 不動。內文得把這件事講出來，否則使用者會以為按下去連歷史紀錄的來源都
// 一起沒了。zh 與 en 兩邊都要有，en 只驗這句在不在(語氣由文案決定)。
test('locales:opDeviceRemoveDesc 兩語都要講明「紀錄上的裝置名稱會保留」(§13)', () => {
  const i18n = require(path.join(REPO_ROOT, 'i18n.js'));

  assert.ok(
    i18n.STRINGS.zh.opDeviceRemoveDesc.includes('紀錄上的裝置名稱會保留'),
    `zh.opDeviceRemoveDesc 應補上名稱保留的說明，實際:${i18n.STRINGS.zh.opDeviceRemoveDesc}`
  );
  assert.ok(
    /device names on your records are kept/i.test(i18n.STRINGS.en.opDeviceRemoveDesc),
    `en.opDeviceRemoveDesc 應補上名稱保留的說明，實際:${i18n.STRINGS.en.opDeviceRemoveDesc}`
  );
});

// ---- 7. 英文文案的單複數(R4) ----
//
// opDevicesSubtitle 是裝置對話框標題列右側的副標，n 由清單長度代入。英文
// 直接寫死複數的 devices，只有一台時就會印出「1 devices syncing」——這是
// 使用者第一次登入、只註冊了這台裝置時必定看到的畫面。
test('locales:en 的 opDevicesSubtitle 在只有一台時不得印出「1 devices」', () => {
  const i18n = require(path.join(REPO_ROOT, 'i18n.js'));

  const one = i18n.fmt('en', 'opDevicesSubtitle', { n: 1 });
  assert.ok(
    !one.includes('1 devices'),
    `en.opDevicesSubtitle 在 n=1 時不得出現「1 devices」，實際:${one}`
  );
});
