// test/settings-schema.test.js — 兩頁共用的設定開關表(TCLCore.SETTINGS_SCHEMA)
// 與 i18n 的 DOM 套用(TCLI18N.applyDom)的行為契約。
//
// HTML 維持靜態開關列，schema 只負責讀值、綁定與 onChanged:options 綁
// pages 含 'options' 的四顆，popup 綁含 'popup' 的兩顆，各自寫回 schema 指定
// 的 storage 區。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createChromeStorage, createCheckboxDocument } = require('./support/helpers');
const { makeDocumentStub } = require('./support/options-dom');

const core = require(path.join(__dirname, '..', 'tcl-core.js'));
const options = require(path.join(__dirname, '..', 'options.js'));
const popup = require(path.join(__dirname, '..', 'popup.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

function readRepo(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

const EXPECTED_SCHEMA = [
  {
    key: 'autoClean', area: 'sync', def: false, pages: ['options', 'popup'],
    label: { options: ['opAutoCleanName', 'opAutoCleanDesc'], popup: 'ppAutoClean' },
  },
  {
    key: 'postCopyEnabled', area: 'sync', def: true, pages: ['options', 'popup'],
    label: { options: ['opPostCopyName', 'opPostCopyDesc'], popup: 'popPostCopyLabel' },
  },
  {
    key: 'saveHistory', area: 'sync', def: true, pages: ['options'],
    label: { options: ['opSaveName', 'opSaveDesc'] },
  },
  {
    key: 'scamGuardEnabled', area: 'local', def: true, pages: ['options'],
    label: { options: ['opScamGuardName', 'opScamGuardDesc'] }, view: 'scamBar',
  },
];

function schema() {
  assert.ok(Array.isArray(core.SETTINGS_SCHEMA), 'TCLCore 應匯出 SETTINGS_SCHEMA 陣列');
  return core.SETTINGS_SCHEMA;
}

function syncDefaultsFor(page) {
  return Object.fromEntries(
    schema().filter((s) => s.pages.includes(page) && s.area === 'sync').map((s) => [s.key, s.def])
  );
}

// ---- SS1:schema 形狀與預設值推導 ----

test('SS1:TCLCore.SETTINGS_SCHEMA 四筆，key／area／def／pages／label／view 照規格', () => {
  assert.deepEqual(schema(), EXPECTED_SCHEMA);
  schema().forEach((s) => {
    Object.values(s.label).flat().forEach((k) => {
      assert.ok(Object.hasOwn(i18n.STRINGS.zh, k), `${s.key} 的 label 鍵 ${k} 應存在於 i18n`);
    });
    if (s.area === 'sync') assert.equal(s.def, core.DEFAULT_SETTINGS[s.key], `${s.key} 的 def 與 DEFAULT_SETTINGS 一致`);
  });
});

test('SS1:OPTIONS_DEFAULT_SETTINGS 與 popup DEFAULT_SETTINGS 由 schema 推導，值不變', () => {
  assert.deepEqual(options.OPTIONS_DEFAULT_SETTINGS, { autoClean: false, saveHistory: true, postCopyEnabled: true });
  assert.deepEqual(popup.DEFAULT_SETTINGS, { autoClean: false, postCopyEnabled: true });
  assert.deepEqual(options.OPTIONS_DEFAULT_SETTINGS, syncDefaultsFor('options'));
  assert.deepEqual(popup.DEFAULT_SETTINGS, syncDefaultsFor('popup'));
});

test('SS1:options.js 與 popup.js 改用 schema，手寫的開關清單與預設值表刪除', () => {
  const opt = readRepo('options.js');
  const pop = readRepo('popup.js');
  for (const name of ['SETTING_IDS', 'LOCAL_SETTING_IDS', 'LOCAL_SETTING_DEFAULTS']) {
    assert.equal(new RegExp('\\b' + name + '\\b').test(opt), false, `options.js 不應再有 ${name}`);
  }
  assert.equal(/\bSETTING_IDS\b/.test(pop), false, 'popup.js 不應再有 SETTING_IDS');
  assert.ok(/SETTINGS_SCHEMA/.test(opt), 'options.js 應讀 TCLCore.SETTINGS_SCHEMA');
  assert.ok(/SETTINGS_SCHEMA/.test(pop), 'popup.js 應讀 TCLCore.SETTINGS_SCHEMA');
});

// ---- SS1:options 頁的讀值、綁定、onChanged ----

function makeOptionsCtx(syncSeed, localSeed) {
  const storage = createChromeStorage(Object.assign({ langPref: 'zh' }, syncSeed), Object.assign({ history: [] }, localSeed));
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    download: () => {},
  });
  return { storage, doc, controller };
}

test('SS1:options init 依 schema 的 area 讀值，缺值或非布林退回 def', async () => {
  // scamGuardEnabled 故意也放一份在 sync 區:只該讀 local 區那一份。
  const ctx = makeOptionsCtx(
    { autoClean: true, saveHistory: false, postCopyEnabled: 'yes', scamGuardEnabled: true },
    { scamGuardEnabled: false }
  );
  await ctx.controller.init();
  await settle();
  assert.equal(ctx.doc.ids.autoClean.checked, true);
  assert.equal(ctx.doc.ids.saveHistory.checked, false);
  assert.equal(ctx.doc.ids.postCopyEnabled.checked, true, '非布林退回 def');
  assert.equal(ctx.doc.ids.scamGuardEnabled.checked, false, 'scamGuardEnabled 只讀 local 區');
});

test('SS1:options 綁定 pages 含 options 的每一顆，change 寫進 schema 指定的 area', async () => {
  const mine = schema().filter((s) => s.pages.includes('options'));
  assert.equal(mine.length, 4, 'options 頁四顆全收');
  for (const s of mine) {
    const ctx = makeOptionsCtx({}, {});
    await ctx.controller.init();
    await settle();
    const next = !s.def;
    ctx.doc.ids[s.key].checked = next;
    ctx.doc.ids[s.key].fire('change', { type: 'change', target: ctx.doc.ids[s.key] });
    await settle();
    const own = s.area === 'sync' ? ctx.storage.snapshot() : ctx.storage.localSnapshot();
    const other = s.area === 'sync' ? ctx.storage.localSnapshot() : ctx.storage.snapshot();
    assert.equal(own[s.key], next, `${s.key} 寫進 ${s.area}`);
    assert.equal(Object.hasOwn(other, s.key), false, `${s.key} 不得寫進另一區`);
  }
});

test('SS1:scamGuardEnabled 的 change 立即重畫狀態列(schema 的 view)', async () => {
  const ctx = makeOptionsCtx({}, {});
  await ctx.controller.init();
  await settle();
  assert.equal(ctx.doc.ids.scamDisabledBar.hidden, true, '前提:開著時狀態列收起');
  ctx.doc.ids.scamGuardEnabled.checked = false;
  ctx.doc.ids.scamGuardEnabled.fire('change', { type: 'change', target: ctx.doc.ids.scamGuardEnabled });
  assert.equal(ctx.doc.ids.scamDisabledBar.hidden, false, '關掉後狀態列立即出現');
});

test('SS1:onStorageChanged 依 area 更新 checked，別區同名鍵不理，非布林退回 def', async () => {
  const ctx = makeOptionsCtx({}, {});
  await ctx.controller.init();
  await settle();
  assert.equal(typeof ctx.controller.onStorageChanged, 'function', 'controller 應匯出 onStorageChanged');

  ctx.controller.onStorageChanged(
    { autoClean: { newValue: true }, saveHistory: { newValue: false }, postCopyEnabled: { newValue: false } },
    'sync'
  );
  assert.equal(ctx.doc.ids.autoClean.checked, true);
  assert.equal(ctx.doc.ids.saveHistory.checked, false);
  assert.equal(ctx.doc.ids.postCopyEnabled.checked, false);

  ctx.controller.onStorageChanged({ autoClean: { newValue: false } }, 'local');
  assert.equal(ctx.doc.ids.autoClean.checked, true, 'autoClean 在 sync 區，local 區的同名鍵不理');
  ctx.controller.onStorageChanged({ scamGuardEnabled: { newValue: false } }, 'sync');
  assert.equal(ctx.doc.ids.scamGuardEnabled.checked, true, 'scamGuardEnabled 在 local 區，sync 區的同名鍵不理');

  ctx.controller.onStorageChanged({ postCopyEnabled: { newValue: undefined } }, 'sync');
  assert.equal(ctx.doc.ids.postCopyEnabled.checked, true, '被移除時退回 def');
});

test('SS1:onStorageChanged({scamGuardEnabled}, local) 觸發狀態列重畫', async () => {
  const ctx = makeOptionsCtx({}, {});
  await ctx.controller.init();
  await settle();
  assert.equal(typeof ctx.controller.onStorageChanged, 'function', 'controller 應匯出 onStorageChanged');
  ctx.controller.onStorageChanged({ scamGuardEnabled: { newValue: false } }, 'local');
  assert.equal(ctx.doc.ids.scamGuardEnabled.checked, false);
  assert.equal(ctx.doc.ids.scamDisabledBar.hidden, false, '狀態列跟著出現');
  ctx.controller.onStorageChanged({ scamGuardEnabled: { newValue: true } }, 'local');
  assert.equal(ctx.doc.ids.scamDisabledBar.hidden, true, '重新開啟後收起');
});

// ---- SS1:popup 只綁 pages 含 popup 的兩顆 ----

test('SS1:popup 只綁 pages 含 popup 的開關，options 專屬的兩顆不讀不綁', async () => {
  const ids = ['autoClean', 'postCopyEnabled', 'saveHistory', 'scamGuardEnabled'];
  const storage = createChromeStorage({ autoClean: true, postCopyEnabled: false, saveHistory: true, scamGuardEnabled: true });
  const doc = createCheckboxDocument(ids);
  const controller = popup.createPopupController({ document: doc, storage: storage.sync });
  await controller.init();
  await settle();

  const mine = schema().filter((s) => s.pages.includes('popup')).map((s) => s.key);
  assert.deepEqual(mine.sort(), ['autoClean', 'postCopyEnabled']);
  assert.equal(doc.elements.autoClean.checked, true);
  assert.equal(doc.elements.postCopyEnabled.checked, false);
  for (const id of ['saveHistory', 'scamGuardEnabled']) {
    assert.equal(doc.elements[id].checked, false, `${id} 不在 popup 的 schema，不讀值`);
    assert.equal(doc.elements[id].listenerCount('change'), 0, `${id} 不綁 change`);
  }
  doc.elements.autoClean.fireChange(false);
  await settle();
  assert.equal(storage.snapshot().autoClean, false, 'popup 的開關寫回 sync 區');
});

// ---- I18N1:TCLI18N.applyDom ----

function makeI18nDoc() {
  const node = (attrs) => {
    const a = Object.assign({}, attrs);
    return {
      textContent: 'orig',
      getAttribute: (k) => (Object.hasOwn(a, k) ? a[k] : null),
      setAttribute: (k, v) => {
        a[k] = String(v);
      },
      attrs: a,
    };
  };
  const nodes = {
    text: node({ 'data-i18n': 'opAutoCleanName' }),
    ph: node({ 'data-i18n-ph': 'opSaveName' }),
    title: node({ 'data-i18n-title': 'opSaveDesc' }),
    aria: node({ 'data-i18n-aria': 'opAccountMenuLabel' }),
  };
  const map = {
    '[data-i18n]': [nodes.text],
    '[data-i18n-ph]': [nodes.ph],
    '[data-i18n-title]': [nodes.title],
    '[data-i18n-aria]': [nodes.aria],
  };
  return {
    nodes,
    documentElement: { lang: '' },
    querySelectorAll: (sel) => map[sel] || [],
  };
}

test('I18N1:TCLI18N.applyDom 套四組 data-i18n 屬性與 documentElement.lang', () => {
  assert.equal(typeof i18n.applyDom, 'function', 'i18n.js 應匯出 applyDom(doc, locale)');
  const doc = makeI18nDoc();
  i18n.applyDom(doc, 'en');
  assert.equal(doc.nodes.text.textContent, i18n.t('en', 'opAutoCleanName'));
  assert.equal(doc.nodes.ph.attrs.placeholder, i18n.t('en', 'opSaveName'));
  assert.equal(doc.nodes.title.attrs.title, i18n.t('en', 'opSaveDesc'));
  assert.equal(doc.nodes.aria.attrs['aria-label'], i18n.t('en', 'opAccountMenuLabel'));
  assert.equal(doc.documentElement.lang, 'en');

  i18n.applyDom(doc, 'zh');
  assert.equal(doc.nodes.text.textContent, i18n.t('zh', 'opAutoCleanName'));
  assert.equal(doc.documentElement.lang, 'zh-Hant');
});

test('I18N1:TCLI18N.applyDom 遇到沒有 querySelectorAll 的 document 直接返回，不丟例外', () => {
  assert.equal(typeof i18n.applyDom, 'function', 'i18n.js 應匯出 applyDom(doc, locale)');
  const doc = { documentElement: { lang: 'x' }, getElementById: () => null };
  assert.doesNotThrow(() => i18n.applyDom(doc, 'en'));
  assert.equal(doc.documentElement.lang, 'x', '直接返回，不動 lang');
});

function spyI18n() {
  const calls = [];
  const wrapped = Object.assign({}, i18n, {
    applyDom(doc, locale) {
      calls.push({ doc, locale });
      if (typeof i18n.applyDom === 'function') i18n.applyDom(doc, locale);
    },
  });
  return { calls, wrapped };
}

test('I18N1:options 透過注入的 i18n.applyDom 套文案，語言鈕照舊補上', async () => {
  const spy = spyI18n();
  const storage = createChromeStorage({ langPref: 'en' }, { history: [] });
  const doc = makeDocumentStub();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n: spy.wrapped,
    now: () => 100000,
    download: () => {},
  });
  await controller.init();
  await settle();
  assert.ok(spy.calls.length >= 1, 'options 應呼叫 i18n.applyDom');
  assert.equal(spy.calls[0].doc, doc, '傳入的是注入的 document');
  assert.equal(spy.calls[0].locale, 'en');
  assert.equal(doc.ids.langBtn.textContent, 'EN', 'langBtn 由 options 自己補');
});

test('I18N1:popup 透過注入的 i18n.applyDom 套文案', async () => {
  const spy = spyI18n();
  const storage = createChromeStorage({ langPref: 'en' });
  const doc = createCheckboxDocument(['autoClean', 'postCopyEnabled']);
  doc.querySelectorAll = () => [];
  doc.documentElement = { lang: '' };
  const controller = popup.createPopupController({ document: doc, storage: storage.sync, i18n: spy.wrapped });
  await controller.init();
  await settle();
  assert.equal(spy.calls.length, 1, 'popup 應呼叫 i18n.applyDom 一次');
  assert.equal(spy.calls[0].doc, doc);
  assert.equal(spy.calls[0].locale, 'en');
  assert.equal(doc.documentElement.lang, 'en');
});

test('I18N1:options.js 與 popup.js 不再各自掃 [data-i18n]', () => {
  for (const file of ['options.js', 'popup.js']) {
    assert.equal(/\[data-i18n/.test(readRepo(file)), false, `${file} 不應再有自己的 [data-i18n*] 迴圈`);
  }
  assert.ok(/\[data-i18n\]/.test(readRepo('i18n.js')), 'i18n.js 的 applyDom 負責掃 [data-i18n]');
});
