// test/theme.test.js — 共用主題樣式（theme.css）、主題鏡像（theme-init.js）
// 與兩頁接線的契約。
//
// 兩頁共用一份 token：theme.css 以 light-dark() 把深淺兩色寫在同一條宣告，
// 由 color-scheme 決定取哪一邊；[data-theme] 只切 color-scheme，不再重列
// token。theme-init.js 是 head 裡第一支 script，同步讀 localStorage 的主題
// 鏡像（tcl.themePref）套上 data-theme，讓開頁第一幀就是正確配色；兩頁的
// 邏輯層在讀到 chrome.storage.sync 的 themePref 後，經注入的 themeMirror
// 回寫鏡像。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createChromeStorage } = require('./support/helpers');

const REPO_ROOT = path.join(__dirname, '..');
const NEW_FILES = ['theme.css', 'theme-init.js', 'options.css', 'popup.css'];

const { settle, reset } = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(reset);

function readRepo(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function readRepoOrEmpty(rel) {
  const full = path.join(REPO_ROOT, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

// 深淺色 token（原 options.html 三份重複區塊的 21 個變數）。
const THEME_TOKENS = [
  '--plane', '--surface', '--ink-1', '--ink-2', '--ink-3', '--grid', '--baseline',
  '--border', '--accent', '--accent-soft', '--accent-contrast', '--card-outline',
  '--card-selected-border', '--good', '--danger', '--danger-soft', '--warn', '--warn-soft',
  '--switch-track-off', '--switch-thumb', '--shadow',
];
// 深淺同值，合一後寫單值，不必包 light-dark()。
const SINGLE_VALUE_TOKENS = ['--ink-3', '--accent-contrast', '--card-selected-border'];

// 取出「--name: 值;」宣告（值不含分號）。
function tokenDecls(css, name) {
  const re = new RegExp('(?:^|[\\s;{])' + name.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;}]*)', 'g');
  return [...stripComments(css).matchAll(re)].map((m) => m[1].trim());
}

// 以選擇器取出規則本體（只處理不巢狀的規則）。
function ruleBodies(css, selectorRe) {
  const out = [];
  const src = stripComments(css);
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (selectorRe.test(m[1].trim())) out.push(m[2]);
  }
  return out;
}

// ============================================================
// T1 theme.css：light-dark() 合一的 token 與 color-scheme 切換
// ============================================================

test('T1:theme.css 存在，:root 宣告 color-scheme: light dark', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'theme.css')), 'repo 根目錄應有 theme.css');
  const css = stripComments(readRepo('theme.css'));
  const rootBodies = ruleBodies(css, /^:root$/);
  assert.ok(rootBodies.length >= 1, 'theme.css 應有 :root 規則');
  assert.ok(
    rootBodies.some((b) => /color-scheme\s*:\s*light\s+dark\s*(;|$)/.test(b)),
    ':root 應宣告 color-scheme: light dark，light-dark() 才會跟系統深淺色走'
  );
});

test('T1:21 個主題 token 在 theme.css 各只宣告一次，深淺不同值者一律用 light-dark()', () => {
  const css = readRepo('theme.css');
  THEME_TOKENS.forEach((name) => {
    const decls = tokenDecls(css, name);
    assert.equal(decls.length, 1, `${name} 在 theme.css 應恰好宣告一次，實際 ${decls.length} 次`);
    if (!SINGLE_VALUE_TOKENS.includes(name)) {
      assert.ok(/light-dark\(/.test(decls[0]), `${name} 應以 light-dark() 合寫深淺兩色：${decls[0]}`);
    }
  });
});

test('T1:theme.css 不得再有 prefers-color-scheme: dark 的 token 覆寫區塊', () => {
  const css = stripComments(readRepo('theme.css'));
  assert.equal(
    /@media\s*\([^)]*prefers-color-scheme\s*:\s*dark/i.test(css),
    false,
    '深色改由 light-dark() 取值，不得再以媒體查詢重列 token'
  );
});

test('T1:[data-theme="light"]／[data-theme="dark"] 只設 color-scheme，不重列 token', () => {
  const css = readRepo('theme.css');
  [
    ['light', /^:root\[data-theme=["']?light["']?\]$/],
    ['dark', /^:root\[data-theme=["']?dark["']?\]$/],
  ].forEach(([mode, selRe]) => {
    const bodies = ruleBodies(css, selRe);
    assert.equal(bodies.length, 1, `theme.css 應恰有一條 :root[data-theme="${mode}"] 規則`);
    const decls = bodies[0]
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);
    assert.deepEqual(
      decls.map((d) => d.replace(/\s+/g, ' ')),
      [`color-scheme: ${mode}`],
      `[data-theme="${mode}"] 只切 color-scheme，實際為：${decls.join('; ')}`
    );
  });
});

test('T1:options.css／popup.css 不得另外宣告主題 token，popup 舊變數 --bg／--fg／--muted 已併入', () => {
  ['options.css', 'popup.css'].forEach((file) => {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, file)), `repo 根目錄應有 ${file}`);
    const css = readRepo(file);
    THEME_TOKENS.forEach((name) => {
      assert.equal(tokenDecls(css, name).length, 0, `${file} 不得重新宣告 ${name}（token 只在 theme.css）`);
    });
    assert.equal(
      /@media\s*\([^)]*prefers-color-scheme\s*:\s*dark/i.test(stripComments(css)),
      false,
      `${file} 不得再有深色媒體查詢`
    );
  });
  const popupCss = readRepo('popup.css');
  ['--bg', '--fg', '--muted'].forEach((name) => {
    assert.equal(tokenDecls(popupCss, name).length, 0, `popup 的 ${name} 應併入 theme.css 的 token`);
    assert.equal(new RegExp('var\\(\\s*' + name + '\\s*\\)').test(popupCss), false, `popup.css 不得再引用 ${name}`);
  });
});

test('T1:.switch 開關樣式只在 theme.css 一份，兩頁 css 不重複', () => {
  const theme = stripComments(readRepo('theme.css'));
  assert.ok(ruleBodies(theme, /(^|,)\s*\.switch\s*(,|$)/).length >= 1, 'theme.css 應有 .switch 規則');
  assert.ok(/\.switch[^{]*:checked/.test(theme), 'theme.css 應有 .switch 的 :checked 開啟態');
  ['options.css', 'popup.css'].forEach((file) => {
    const css = stripComments(readRepoOrEmpty(file));
    assert.equal(
      ruleBodies(css, /(^|,)\s*\.switch\s*(,|$)/).length,
      0,
      `${file} 不得再重複定義 .switch（已收進 theme.css）`
    );
  });
});

// ============================================================
// T2 兩頁 head：不再內嵌 <style>，載入順序固定
// ============================================================

[
  ['options.html', 'options.css'],
  ['popup.html', 'popup.css'],
].forEach(([page, pageCss]) => {
  test(`T2:${page} 不再有內嵌 <style>，也不在 HTML 內定義主題 token`, () => {
    const html = readRepo(page);
    assert.equal(/<style\b/i.test(html), false, `${page} 的樣式應全數搬到外部 css`);
    ['--plane', '--surface', '--ink-1', '--bg', '--fg'].forEach((name) => {
      assert.equal(
        new RegExp(name.replace(/-/g, '\\-') + '\\s*:').test(html),
        false,
        `${page} 不得再宣告 ${name}`
      );
    });
  });

  test(`T2:${page} head 順序為 charset → theme-init.js → theme.css → ${pageCss}`, () => {
    const html = readRepo(page);
    const headEnd = html.search(/<\/head>/i);
    assert.ok(headEnd > 0, `${page} 應有 </head>`);
    const head = html.slice(0, headEnd);

    const charset = head.search(/<meta\b[^>]*\bcharset\s*=/i);
    const init = head.search(/<script\b[^>]*\bsrc\s*=\s*["']theme-init\.js["'][^>]*>\s*<\/script>/i);
    const themeLink = head.search(/<link\b(?=[^>]*\brel\s*=\s*["']?stylesheet)(?=[^>]*\bhref\s*=\s*["']theme\.css["'])[^>]*>/i);
    const pageLink = head.search(
      new RegExp(
        '<link\\b(?=[^>]*\\brel\\s*=\\s*["\']?stylesheet)(?=[^>]*\\bhref\\s*=\\s*["\']' +
          pageCss.replace('.', '\\.') +
          '["\'])[^>]*>',
        'i'
      )
    );

    assert.ok(charset >= 0, `${page} head 應有 <meta charset>`);
    assert.ok(init >= 0, `${page} head 應有 <script src="theme-init.js"></script>`);
    assert.ok(themeLink >= 0, `${page} head 應有 <link rel="stylesheet" href="theme.css">`);
    assert.ok(pageLink >= 0, `${page} head 應有 <link rel="stylesheet" href="${pageCss}">`);
    assert.ok(charset < init, 'charset 必須在 theme-init.js 之前');
    assert.ok(init < themeLink, 'theme-init.js 必須在 theme.css 之前，第一幀就帶 data-theme');
    assert.ok(themeLink < pageLink, `theme.css 必須在 ${pageCss} 之前，頁面樣式才能覆寫共用外觀`);
  });

  test(`T2:${page} 的 theme-init.js 是整份文件第一支 script`, () => {
    const html = readRepo(page);
    const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    assert.ok(scripts.length >= 1);
    assert.ok(
      /\bsrc\s*=\s*["']theme-init\.js["']/i.test(scripts[0]),
      `第一支 script 應為 theme-init.js，實際為：${scripts[0]}`
    );
    assert.equal(
      scripts.filter((s) => /theme-init\.js/.test(s)).length,
      1,
      'theme-init.js 只載入一次'
    );
  });
});

// ============================================================
// T3 theme-init.js：vm 沙箱內同步套用鏡像
// ============================================================

function makeLocalStorage(seed, { throws = false } = {}) {
  const data = Object.assign({}, seed);
  const guard = () => {
    if (throws) throw new Error('SecurityError: localStorage 不可用');
  };
  return {
    data,
    getItem(k) {
      guard();
      return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null;
    },
    setItem(k, v) {
      guard();
      data[k] = String(v);
    },
    removeItem(k) {
      guard();
      delete data[k];
    },
  };
}

function loadThemeInit(localStorage) {
  const src = readRepo('theme-init.js');
  const documentElement = { dataset: {} };
  const sandbox = { document: { documentElement }, localStorage };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { sandbox, documentElement };
}

test('T3:theme-init.js 載入時讀到 tcl.themePref=dark，同步設 data-theme="dark"', () => {
  const { documentElement } = loadThemeInit(makeLocalStorage({ 'tcl.themePref': 'dark' }));
  assert.equal(documentElement.dataset.theme, 'dark');
});

test('T3:theme-init.js 讀到 tcl.themePref=light，同步設 data-theme="light"', () => {
  const { documentElement } = loadThemeInit(makeLocalStorage({ 'tcl.themePref': 'light' }));
  assert.equal(documentElement.dataset.theme, 'light');
});

test('T3:沒有鏡像時不設 data-theme（跟系統走）', () => {
  const { documentElement } = loadThemeInit(makeLocalStorage({}));
  assert.equal('theme' in documentElement.dataset, false);
});

test('T3:鏡像值不是 light／dark 時不設 data-theme', () => {
  const { documentElement } = loadThemeInit(makeLocalStorage({ 'tcl.themePref': 'purple' }));
  assert.equal('theme' in documentElement.dataset, false);
});

test('T3:localStorage 拋錯時載入不炸，TCLTheme 仍可用', () => {
  let loaded;
  assert.doesNotThrow(() => {
    loaded = loadThemeInit(makeLocalStorage({}, { throws: true }));
  });
  assert.equal('theme' in loaded.documentElement.dataset, false);
  assert.equal(typeof loaded.sandbox.TCLTheme, 'object');
  assert.doesNotThrow(() => loaded.sandbox.TCLTheme.remember('dark'), 'remember 在 localStorage 不可用時也不得拋錯');
  assert.equal(loaded.documentElement.dataset.theme, 'dark', 'remember 仍應套用到當頁');
});

test('T3:TCLTheme.KEY 為 tcl.themePref', () => {
  const { sandbox } = loadThemeInit(makeLocalStorage({}));
  assert.equal(sandbox.TCLTheme.KEY, 'tcl.themePref');
});

test('T3:TCLTheme.remember("light") 寫回鏡像並套用到當頁', () => {
  const ls = makeLocalStorage({});
  const { sandbox, documentElement } = loadThemeInit(ls);
  sandbox.TCLTheme.remember('light');
  assert.equal(ls.data['tcl.themePref'], 'light');
  assert.equal(documentElement.dataset.theme, 'light');
});

test('T3:TCLTheme.remember("dark") 寫回鏡像', () => {
  const ls = makeLocalStorage({ 'tcl.themePref': 'light' });
  const { sandbox, documentElement } = loadThemeInit(ls);
  sandbox.TCLTheme.remember('dark');
  assert.equal(ls.data['tcl.themePref'], 'dark');
  assert.equal(documentElement.dataset.theme, 'dark');
});

test('T3:TCLTheme.remember("system")／("auto") 移除鏡像並拿掉 data-theme', () => {
  ['system', 'auto'].forEach((pref) => {
    const ls = makeLocalStorage({ 'tcl.themePref': 'dark' });
    const { sandbox, documentElement } = loadThemeInit(ls);
    assert.equal(documentElement.dataset.theme, 'dark');
    sandbox.TCLTheme.remember(pref);
    assert.equal('tcl.themePref' in ls.data, false, `remember(${pref}) 應移除鏡像`);
    assert.equal('theme' in documentElement.dataset, false, `remember(${pref}) 應拿掉 data-theme`);
  });
});

test('T3:theme-init.js 不碰 chrome.*，也不含 ES module 語法（classic script）', () => {
  const src = stripComments(readRepo('theme-init.js'));
  assert.equal(/\bchrome\./.test(src), false, 'head 同步階段只讀 localStorage 鏡像');
  assert.equal(/^\s*(import|export)\b/m.test(src), false);
});

// ============================================================
// T4 popup：init 讀 themePref，經注入的 themeMirror 回寫鏡像
// ============================================================

function loadPopup() {
  return require(path.join(REPO_ROOT, 'popup.js'));
}

// 兩顆 checkbox 加上 documentElement 的最小 popup 文件。
function makePopupDoc({ withRoot = true } = {}) {
  const { createCheckboxDocument } = require('./support/helpers');
  const doc = createCheckboxDocument(['autoClean', 'postCopyEnabled']);
  if (withRoot) doc.documentElement = { dataset: {}, lang: '' };
  return doc;
}

test('T4:popup init 讀 sync.themePref，呼叫注入的 themeMirror(pref)', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ themePref: 'dark' });
  const calls = [];
  const controller = popup.createPopupController({
    document: makePopupDoc(),
    storage: storage.sync,
    themeMirror: (pref) => calls.push(pref),
  });

  await controller.init();
  await settle();

  assert.deepEqual(calls, ['dark'], 'popup 應以 storage 的 themePref 呼叫 themeMirror 一次');
  const requested = storage.calls.get.flatMap((keys) =>
    keys && typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : [].concat(keys || [])
  );
  assert.ok(requested.includes('themePref'), 'popup 的 storage 讀取應含 themePref');
});

test('T4:popup 沒存 themePref 時，themeMirror 收到的不是 light／dark（鏡像會被清掉）', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({});
  const calls = [];
  const controller = popup.createPopupController({
    document: makePopupDoc(),
    storage: storage.sync,
    themeMirror: (pref) => calls.push(pref),
  });

  await controller.init();
  await settle();

  assert.equal(calls.length, 1, 'themeMirror 應被呼叫一次，才能清掉過期鏡像');
  assert.ok(!['light', 'dark'].includes(calls[0]), `未設定時不得寫入深淺色鏡像，實際為 ${calls[0]}`);
});

test('T4:popup 的文件沒有 documentElement 時略過 themeMirror，開關照常運作', async () => {
  const popup = loadPopup();
  const storage = createChromeStorage({ themePref: 'dark', autoClean: true });
  const doc = makePopupDoc({ withRoot: false });
  const calls = [];
  const controller = popup.createPopupController({
    document: doc,
    storage: storage.sync,
    themeMirror: (pref) => calls.push(pref),
  });

  await controller.init();
  await settle();

  assert.deepEqual(calls, [], '沒有 documentElement 時不呼叫 themeMirror');
  assert.equal(doc.elements.autoClean.checked, true);
});

test('T4:popup-init.js 注入 themeMirror: TCLTheme.remember', () => {
  const src = readRepo('popup-init.js');
  assert.ok(/themeMirror\s*:[^,}]*TCLTheme\.remember/.test(src), 'popup-init.js 應把 TCLTheme.remember 接成 themeMirror');
});

// ============================================================
// T5 options：applyTheme 末尾呼叫 deps.themeMirror(themePref)
// ============================================================

// options controller 所需的最小 DOM：任意 id 都回一個可掛監聽、可設屬性的節點。
function makeOptionsNode(tag, ownerDoc) {
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
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      toggle: (c, force) => {
        const next = force === undefined ? !classes.has(c) : force;
        if (next) classes.add(c);
        else classes.delete(c);
        return next;
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(k, v) {
      attrs[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null;
    },
    removeAttribute(k) {
      delete attrs[k];
    },
    contains(other) {
      return other === node || node.children.includes(other);
    },
    appendChild(n) {
      node.children.push(n);
      n.parentNode = node;
      return n;
    },
    insertBefore(n, ref) {
      const idx = node.children.indexOf(ref);
      if (idx === -1) node.children.push(n);
      else node.children.splice(idx, 0, n);
      n.parentNode = node;
      return n;
    },
    removeChild(n) {
      const idx = node.children.indexOf(n);
      if (idx !== -1) node.children.splice(idx, 1);
      return n;
    },
    remove() {},
    select() {},
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    fire(type, event) {
      (listeners[type] || []).slice().forEach((fn) => fn(event || { type, target: node }));
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    click() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 10, height: 10, bottom: 10, right: 10 }),
    focus() {
      if (ownerDoc) ownerDoc.activeElement = node;
    },
    blur() {},
  };
  Object.defineProperty(node, 'textContent', {
    get: () => text,
    set(v) {
      text = String(v);
      node.children.length = 0;
    },
  });
  return node;
}

function makeOptionsDoc() {
  const byId = {};
  const doc = {
    ids: byId,
    documentElement: makeOptionsNode('html'),
    activeElement: null,
    getElementById(id) {
      if (!byId[id]) byId[id] = makeOptionsNode('#' + id, doc);
      return byId[id];
    },
    createElement: (tag) => makeOptionsNode(tag, doc),
    createElementNS: (ns, tag) => makeOptionsNode(tag, doc),
    createTextNode(t) {
      const n = makeOptionsNode('#text', doc);
      n.textContent = t;
      return n;
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

async function setupOptions(syncSeed) {
  const options = require(path.join(REPO_ROOT, 'options.js'));
  const i18n = require(path.join(REPO_ROOT, 'i18n.js'));
  const storage = createChromeStorage(Object.assign({ langPref: 'zh' }, syncSeed), { history: [] });
  const doc = makeOptionsDoc();
  const calls = [];
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
    themeMirror: (pref) => calls.push(pref),
  });
  await controller.init();
  await settle();
  return { controller, doc, calls, storage };
}

test('T5:options init 套用 themePref 後呼叫 themeMirror(themePref)', async () => {
  const { doc, calls } = await setupOptions({ themePref: 'dark' });
  assert.equal(doc.documentElement.dataset.theme, 'dark', '前提：init 已套用 dark');
  assert.ok(calls.length >= 1, 'applyTheme 應呼叫 themeMirror');
  assert.equal(calls[calls.length - 1], 'dark');
});

test('T5:options 未設定主題時，themeMirror 收到 auto', async () => {
  const { calls } = await setupOptions({});
  assert.ok(calls.length >= 1, 'applyTheme 應呼叫 themeMirror');
  assert.equal(calls[calls.length - 1], 'auto');
});

test('T5:options 點主題鈕輪替後，themeMirror 收到新的 themePref', async () => {
  const { doc, calls } = await setupOptions({ themePref: 'auto' });
  doc.ids.themeBtn.fire('click');
  assert.equal(doc.documentElement.dataset.theme, 'light', '前提：auto → light');
  assert.equal(calls[calls.length - 1], 'light');
  doc.ids.themeBtn.fire('click');
  assert.equal(calls[calls.length - 1], 'dark');
});

test('T5:options 收到別處的 themePref 變更時，themeMirror 跟著回寫', async () => {
  const { controller, calls } = await setupOptions({ themePref: 'dark' });
  controller.setSyncSettings({ themePref: { newValue: 'light', oldValue: 'dark' } });
  assert.equal(calls[calls.length - 1], 'light');
});

test('T5:options 沒注入 themeMirror 時照常運作（選配 dep）', async () => {
  const options = require(path.join(REPO_ROOT, 'options.js'));
  const i18n = require(path.join(REPO_ROOT, 'i18n.js'));
  const storage = createChromeStorage({ langPref: 'zh', themePref: 'dark' }, { history: [] });
  const doc = makeOptionsDoc();
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => 100000,
  });
  await controller.init();
  await settle();
  assert.equal(doc.documentElement.dataset.theme, 'dark');
});

test('T5:options-init.js 注入 themeMirror: TCLTheme.remember', () => {
  const src = readRepo('options-init.js');
  assert.ok(/themeMirror\s*:[^,}]*TCLTheme\.remember/.test(src), 'options-init.js 應把 TCLTheme.remember 接成 themeMirror');
});

// ============================================================
// T6 打包：四個新檔進白名單，manifest 推導也認得到
// ============================================================

function readIncludeFiles() {
  const ps1 = readRepo(path.join('tools', 'build-release.ps1'));
  const match = ps1.match(/\$includeFiles\s*=\s*@\(([\s\S]*?)\)/);
  assert.ok(match, 'build-release.ps1 應有 $includeFiles = @(...) 白名單');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('T6:build-release.ps1 的 $includeFiles 含 theme.css、theme-init.js、options.css、popup.css', () => {
  const included = readIncludeFiles();
  const missing = NEW_FILES.filter((f) => !included.includes(f));
  assert.deepEqual(missing, [], `白名單缺：${missing.join(', ')}`);
});

test('T6:manifest 推導的必要檔案含四個新檔（<link rel=stylesheet> 與 <script src> 都有推導）', async () => {
  const mod = await import(pathToFileURL(path.join(REPO_ROOT, 'tools', 'manifest-files.mjs')).href);
  const required = mod.manifestRequiredFiles(REPO_ROOT);
  const missing = NEW_FILES.filter((f) => !required.includes(f));
  assert.deepEqual(missing, [], `推導清單缺：${missing.join(', ')}`);
});
