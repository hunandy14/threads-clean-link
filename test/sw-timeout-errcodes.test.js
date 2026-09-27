// test/sw-timeout-errcodes.test.js — 車道 SW-1b：逾時（H1）、錯誤碼表（H2）、版本標頭（H3）。
//
// 依據：design-sw §7（AbortSignal.timeout）、§8（錯誤碼表）、§10 的 1b 列與 S7。
//
// 本檔釘定的注入契約（實作時照這個形狀接線）：
//   TCLSync.create({ ..., timeoutSignal, clientVersion })
//     timeoutSignal  (ms) => AbortSignal；background 接成 (ms) => AbortSignal.timeout(ms)。
//                    call() 每個請求以 CALL_TIMEOUT_MS（30000）呼叫一次，回傳值原樣放進 init.signal。
//     clientVersion  字串（manifest 的 version，例如 '0.10.0'）；background 接
//                    chrome.runtime.getManifest().version。每個請求帶
//                    `X-Client-Version: ext/<clientVersion>`，登入交換時以
//                    exchangeWithBackend({ ..., clientVersion }) 轉交 auth。
//   TCLAuth.exchangeWithBackend({ apiBase, idToken, nonce, timeoutMs?, clientVersion? })
//     signal 取 AbortSignal.timeout(timeoutMs || 30000)；逾時（連線或讀本文）一律 network_error。
//   background resolveFinalUrl：signal 取 AbortSignal.timeout(10000)。
//   TCLCore.errorCategoryOf(code) => { category, retryable }。
//
// 各段 harness 抄自 test/sync.test.js（createSyncStorage～settle）與
// test/options.test.js（makeNode～makeDocumentStub、makeFakeRuntime），原樣複製、不改語意。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runInSandbox, createChromeStorage } = require('./support/helpers');
const { postKeyOf } = require('../tcl-core.js');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');
const options = require(path.join(__dirname, '..', 'options.js'));
const i18n = require(path.join(__dirname, '..', 'i18n.js'));

const REPO_ROOT = path.join(__dirname, '..');
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8')).version;
const CLIENT_VERSION_HEADER = `ext/${MANIFEST_VERSION}`;

// options 的 controller 鏈路要等 storage mock 的 setTimeout 落盤，沿用 options.test 的共用等待器。
const optSettle = require('./support/settle').installSettle({ defaultMs: 30 });
test.beforeEach(optSettle.reset);

function loadSync() {
  return require('../sync.js');
}

const POST_A = 'https://www.threads.com/@alice/post/AAAAAAAAAAA';
const T0 = 1_700_000_000_000;

// ============================================================================
// harness（抄自 test/sync.test.js）
// ============================================================================

function createSyncStorage(localSeed = {}, sessionSeed = {}) {
  const chainDepth = { value: 0 };
  const writes = [];
  let seq = 0;

  function later(fn) {
    setTimeout(fn, 0);
  }

  function makeArea(name, seed) {
    const data = Object.assign({}, seed);

    function read(keys) {
      if (keys === null || keys === undefined) return Object.assign({}, data);
      if (typeof keys === 'string') {
        return Object.prototype.hasOwnProperty.call(data, keys) ? { [keys]: data[keys] } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
        });
        return out;
      }
      const out = Object.assign({}, keys);
      Object.keys(keys).forEach((k) => {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
      });
      return out;
    }

    return {
      data,
      api: {
        get(keys) {
          return new Promise((resolve) => later(() => resolve(read(keys))));
        },
        set(items) {
          seq += 1;
          writes.push({
            area: name,
            keys: Object.keys(items),
            value: JSON.parse(JSON.stringify(items)),
            inChain: chainDepth.value > 0,
            seq,
          });
          return new Promise((resolve) =>
            later(() => {
              Object.assign(data, items);
              resolve();
            })
          );
        },
        remove(keys) {
          seq += 1;
          const list = Array.isArray(keys) ? keys : [keys];
          writes.push({ area: name, keys: list, removed: true, inChain: chainDepth.value > 0, seq });
          return new Promise((resolve) =>
            later(() => {
              list.forEach((k) => delete data[k]);
              resolve();
            })
          );
        },
      },
    };
  }

  const local = makeArea('local', localSeed);
  const session = makeArea('session', sessionSeed);

  return {
    api: { local: local.api, session: session.api },
    localData: local.data,
    sessionData: session.data,
    writes,
    chainDepth,
    history() {
      return local.data.history || [];
    },
    syncState() {
      return local.data.syncState || null;
    },
    syncAuth() {
      return local.data.syncAuth || null;
    },
    historyWrites() {
      return writes.filter((w) => w.area === 'local' && w.keys.indexOf('history') !== -1);
    },
  };
}

function createAlarmsMock() {
  const calls = [];
  const table = new Map();
  return {
    calls,
    api: {
      create(name, info) {
        calls.push({ op: 'create', name, info: Object.assign({}, info) });
        table.set(name, Object.assign({ name }, info));
      },
      clear(name) {
        calls.push({ op: 'clear', name });
        table.delete(name);
        return Promise.resolve(true);
      },
      get(name) {
        return Promise.resolve(table.get(name) || undefined);
      },
      getAll() {
        return Promise.resolve([...table.values()]);
      },
    },
    creates() {
      return calls.filter((c) => c.op === 'create');
    },
    clears() {
      return calls.filter((c) => c.op === 'clear');
    },
    lastCreate() {
      const list = calls.filter((c) => c.op === 'create');
      return list[list.length - 1] || null;
    },
    /** 週期 alarm 的排定延遲（毫秒），`when` 與 `periodInMinutes` 兩種寫法皆接受。 */
    delayOf(call, at) {
      if (!call) return null;
      const info = call.info || {};
      if (typeof info.when === 'number') return info.when - at;
      if (typeof info.delayInMinutes === 'number') return info.delayInMinutes * 60_000;
      if (typeof info.periodInMinutes === 'number') return info.periodInMinutes * 60_000;
      return null;
    },
  };
}

// TCLAuth 的替身：只回傳 signInWithGoogle 的結果形狀（見 auth.js），
// exchangeWithBackend 沿用真實實作的形狀但改打 mock 伺服器。
function createAuthMock(server, opts = {}) {
  const calls = { signIn: [], exchange: [] };
  return {
    calls,
    signInWithGoogle(options) {
      calls.signIn.push(options);
      if (opts.signInError) return Promise.reject(opts.signInError);
      const email = opts.email || 'someone@example.com';
      // D15（車道 A）：id_token payload 的 name／picture 是後端缺席時的退回
      // 來源。顯式傳 `payloadName: null` / `payloadPicture: null` 表示這枚
      // id_token 完全沒有該 claim，省略則用假值，供「payload 備援」與「白
      // 名單拒絕」兩類測試覆寫。
      const payload = { sub: 'user-abc', email: email };
      if (opts.payloadName !== null) payload.name = opts.payloadName || 'Fake Payload Name';
      if (opts.payloadPicture !== null) {
        payload.picture = opts.payloadPicture || 'https://lh3.googleusercontent.com/a/fake-payload-avatar';
      }
      return Promise.resolve({
        idToken: opts.idToken || 'fake.id.token',
        nonce: opts.nonce || 'nonce-from-auth',
        email: email,
        payload: payload,
      });
    },
    exchangeWithBackend(options) {
      calls.exchange.push(options);
      const url = String(options.apiBase).replace(/\/+$/, '') + '/api/auth/sign-in/social';
      return server
        .fetch(url, {
          method: 'POST',
          credentials: 'omit',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'google',
            idToken: { token: options.idToken, nonce: options.nonce },
          }),
        })
        .then((res) =>
          res.json().then((body) => ({
            status: res.status,
            ok: res.ok,
            authToken: res.headers.get('set-auth-token'),
            body,
          }))
        );
    },
    permissionsFor(apiBase) {
      return { permissions: ['identity'], origins: [String(apiBase).replace(/\/$/, '') + '/*'] };
    },
  };
}

function entry(over = {}) {
  const at = over.at !== undefined ? over.at : T0 - 60_000;
  const url = over.url || POST_A;
  return Object.assign(
    {
      id: 'loc-a',
      url,
      postKey: postKeyOf(url),
      original: url,
      kind: 'strip',
      at,
      receivedAt: at,
      seen: [{ at, kind: 'strip' }],
      dirty: true,
      serverUpdatedAt: null,
      deletedAt: null,
    },
    over
  );
}

function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: '0',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
    },
    over
  );
}

/**
 * 組一整套注入環境。`opts.signedIn` 為 true 時預先發一枚有效 token 並寫入
 * syncAuth／syncState，省去每條測試重跑登入往返。
 */
function makeEnv(opts = {}) {
  // opts.shareWith：與另一個 env 共用同一台 mock 伺服器與時鐘（D50 的多裝置
  // 情境）。第二台的 token 走 issueSession，不頂掉第一台那一枚。
  const clock = opts.shareWith ? opts.shareWith.clock : { t: opts.startAt || T0 };
  const now = () => clock.t;
  const server = opts.shareWith ? opts.shareWith.server : createMockSyncServer(Object.assign({ now }, opts.server));
  const localSeed = Object.assign({}, opts.local);
  if (opts.history) localSeed.history = opts.history;
  if (opts.signedIn) {
    const token = opts.shareWith ? server.issueSession() : server.grantToken('tok-seeded');
    localSeed.syncAuth = Object.assign({ token }, opts.syncAuth);
    localSeed.syncState = signedInState(opts.syncState);
  }
  const storage = createSyncStorage(localSeed, opts.session);
  const alarms = createAlarmsMock();
  const broadcasts = [];
  const auth = createAuthMock(server, opts.auth);
  const permissions = {
    granted: opts.granted !== false,
    containsCalls: [],
    requestCalls: [],
    contains(descriptor) {
      permissions.containsCalls.push(descriptor);
      return Promise.resolve(permissions.granted);
    },
    request(descriptor) {
      permissions.requestCalls.push(descriptor);
      return Promise.resolve(true);
    },
  };
  let uuidSeq = 0;
  let timerSeq = 0;
  // 去抖的 SW 存活期路徑（T5 雙保險）：計時器一律注入，測試自己決定何時到期。
  const timers = { calls: [], live: [], cleared: [] };
  const deps = {
    storage: storage.api,
    fetch: server.fetch,
    now,
    alarms: alarms.api,
    broadcast: (message) => broadcasts.push(message),
    auth,
    permissions,
    randomUUID: () => `uuid-${(uuidSeq += 1)}`,
    setTimeout: (fn, ms) => {
      timerSeq += 1;
      const handle = { id: timerSeq, fn, ms, scheduledAt: clock.t };
      timers.calls.push(handle);
      timers.live.push(handle);
      return handle;
    },
    clearTimeout: (handle) => {
      timers.cleared.push(handle);
      const index = timers.live.indexOf(handle);
      if (index !== -1) timers.live.splice(index, 1);
    },
    writeChain: (fn) => {
      storage.chainDepth.value += 1;
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          storage.chainDepth.value -= 1;
        });
    },
  };

  return {
    clock,
    now,
    server,
    storage,
    alarms,
    broadcasts,
    auth,
    permissions,
    deps,
    timers,
    /** 讓目前排定的去抖計時器到期（模擬 SW 還活著、2 秒先到）。 */
    async runTimers() {
      const pending = timers.live.splice(0, timers.live.length);
      for (const handle of pending) await handle.fn();
    },
    advance(ms) {
      clock.t += ms;
    },
    /** 用同一份 storage 重建引擎，模擬 SW 被回收後重新啟動。 */
    recreate(TCLSync, sessionSurvives = true) {
      if (!sessionSurvives) {
        Object.keys(storage.sessionData).forEach((k) => delete storage.sessionData[k]);
      }
      return TCLSync.create(deps);
    },
    stateBroadcasts() {
      return broadcasts.filter((m) => m && m.type === 'sync.stateChanged');
    },
    lastState() {
      const list = broadcasts.filter((m) => m && m.type === 'sync.stateChanged');
      return list.length ? list[list.length - 1].state : null;
    },
    syncPosts() {
      return server.requestsTo('/api/v1/links/sync', 'POST');
    },
  };
}

/** 讓所有 setTimeout(0) 排程的 storage 結算跑完。 */
async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ============================================================================
// harness（抄自 test/options.test.js）
// ============================================================================

function makeNode(tag, ownerDoc) {
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
      // 比照真實 DOM 的 classList.add/remove:可變參數，一次收多個
      // class(options.js 的 statusDot 重設就是 remove('is-danger',
      // 'is-warning') 一次兩個，只認單一參數會漏清第二個)。
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
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
    removeAttribute(k) {
      delete attrs[k];
    },
    contains(other) {
      // 淺層足夠:帳號選單的「點外關閉」只需要判斷目標是否為容器自身或
      // 其直接子節點(測試以 fire('click', { target }) 模擬，不會構造更深的
      // 巢狀節點)。
      if (other === node) return true;
      return node.children.indexOf(other) !== -1;
    },
    appendChild(n) {
      this.children.push(n);
      n.parentNode = node;
      return n;
    },
    // 行內編輯(裝置改名)要在既有節點前插入 input、收尾再把 input 拔掉;
    // parentNode 也一併記錄，讓「拿到 input 就能移除自己」這種真實 DOM
    // 寫法在 stub 下也成立。ref 不在子節點內時退化成 append(比照真 DOM
    // 會丟 NotFoundError 過於嚴苛，測試只需要順序正確)。
    insertBefore(n, ref) {
      const idx = this.children.indexOf(ref);
      if (idx === -1) this.children.push(n);
      else this.children.splice(idx, 0, n);
      n.parentNode = node;
      return n;
    },
    removeChild(n) {
      const idx = this.children.indexOf(n);
      if (idx !== -1) this.children.splice(idx, 1);
      if (n.parentNode === node) n.parentNode = null;
      return n;
    },
    // <input> 進入編輯態時的全選，行為上對測試無影響，補上避免炸。
    select() {},
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
    // 帳號選單的鍵盤導覽/開合測試需要 focus 落點:owner document 存在時
    // 才記錄(比照真 DOM 的 document.activeElement)，沒有 owner 時(獨立
    // 建立的節點，如既有測試直接呼叫 makeNode() 者)安靜 no-op。
    focus() {
      if (ownerDoc) ownerDoc.activeElement = node;
    },
    blur() {
      if (ownerDoc && ownerDoc.activeElement === node) ownerDoc.activeElement = null;
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

// options.html 的靜態巢狀關係:key 是子節點的 id，value 是它在 HTML 裡所屬
// 的容器 id。真實 document.getElementById 只找得到「還在文件樹裡」的節點——
// 容器被 textContent='' 清空後，原本掛在裡面的靜態節點就查不到了(回 null)。
// 扁平 id 表的 stub 永遠回同一個物件，看不見這個差異，會把「節點被清掉之後
// 再也拿不回來」這類 bug 一路放行(回歸:renderDetailDeviceRow 先清空
// #detailDeviceRow 再判 null 早退，第二次開帶歸屬的紀錄時「裝置」列永久消失)。
// 需要這種保真度的 id 逐一登記在這裡，其餘 id 維持原本的扁平行為。
const STATIC_PARENT_ID = {
  detailDeviceName: 'detailDeviceRow',
};

function isInSubtree(root, node) {
  if (!root || !node) return false;
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (cur === node) return true;
    (cur.children || []).forEach((c) => stack.push(c));
  }
  return false;
}

function makeDocumentStub() {
  const byId = {};
  const docListeners = {};
  const doc = {
    ids: byId,
    documentElement: makeNode('html'),
    activeElement: null,
    getElementById(id) {
      const parentId = STATIC_PARENT_ID[id];
      if (!byId[id]) {
        byId[id] = makeNode('#' + id, doc);
        // 比照 options.html 掛進靜態容器，讓「被搬離容器」這件事測得出來。
        if (parentId) doc.getElementById(parentId).appendChild(byId[id]);
      }
      // 已經不在容器的子樹裡 → 比照真實 DOM 回 null。doc.ids 仍握有節點
      // 參照，測試要斷言殘留內容時可直接讀 doc.ids[id]。
      if (parentId && !isInSubtree(byId[parentId], byId[id])) return null;
      return byId[id];
    },
    createElement(tag) {
      return makeNode(tag, doc);
    },
    createElementNS(ns, tag) {
      return makeNode(tag, doc);
    },
    createTextNode(text) {
      const n = makeNode('#text', doc);
      n.textContent = text;
      return n;
    },
    querySelectorAll() {
      return [];
    },
    querySelector() {
      return null;
    },
    // 帳號選單的「點外關閉」/Esc 監聽掛在 document 層級(見 options.js 的
    // bindAccount)，比照節點的 addEventListener/fire 慣例真的登記/派送，
    // 而不是像既有多數測試那樣留白 no-op——這兩個行為只能靠 document 層級
    // 事件驗證，其餘既有的對話框 Esc 處理仍是留白(見各處「由人工/CDP
    // 驗證」註解)，這裡只為帳號選單新增的兩條路徑補上最小可行的派送。
    addEventListener(type, fn) {
      if (!docListeners[type]) docListeners[type] = [];
      docListeners[type].push(fn);
    },
    removeEventListener() {},
    fire(type, event) {
      (docListeners[type] || []).slice().forEach((fn) => fn(event || { type }));
    },
  };
  return doc;
}

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

// ============================================================================
// 本檔共用小工具
// ============================================================================

// 可控的逾時 signal：記下 ms，測試自己決定何時 abort（reason 比照 AbortSignal.timeout 的 TimeoutError）。
function makeTimeoutRecorder() {
  const records = [];
  function timeout(ms) {
    const controller = new AbortController();
    const rec = {
      ms,
      signal: controller.signal,
      abort() {
        controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
      },
    };
    records.push(rec);
    return controller.signal;
  }
  return { records, timeout };
}

// 掛著直到 signal abort 才 reject；沒帶 signal 立刻 reject（舊實作不得因此卡死整個測試檔）。
function hangUntilAbort(signal) {
  return new Promise((resolve, reject) => {
    if (!signal) {
      reject(new Error('no-signal'));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

// 等一個 promise 結算，最多 ms 毫秒；逾時就讓測試失敗而不是整檔掛住。
function within(promise, ms = 3000, label = '操作') {
  let timer;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 在 ${ms}ms 內沒有結算`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function headerOf(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') {
    const v = headers.get(name);
    return v === null ? undefined : v;
  }
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

// sync 引擎的注入：在 makeEnv 的 deps 上補 timeoutSignal 與 clientVersion。
function withSw1bDeps(env, extra = {}) {
  const recorder = makeTimeoutRecorder();
  const deps = Object.assign({}, env.deps, { timeoutSignal: recorder.timeout, clientVersion: MANIFEST_VERSION }, extra);
  return { deps, timeouts: recorder.records };
}

// ============================================================================
// H1 — sync.js call()：timeoutSignal 注入
// ============================================================================

test('H1 sync call：每個請求以 30000 呼叫注入的 timeoutSignal，回傳的 signal 原樣帶進 fetch', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const inits = [];
  const { deps, timeouts } = withSw1bDeps(env, {
    fetch(url, init) {
      inits.push(init);
      return env.server.fetch(url, init);
    },
  });
  const engine = TCLSync.create(deps);
  await within(engine.syncNow(), 3000, 'syncNow');
  await settle(10);

  assert.ok(inits.length >= 1, '前置：同步至少發一個請求');
  assert.equal(timeouts.length, inits.length, '每個請求各呼叫一次 timeoutSignal');
  timeouts.forEach((rec) => assert.equal(rec.ms, 30000, 'CALL_TIMEOUT_MS 維持 30 秒'));
  inits.forEach((init, i) => assert.equal(init.signal, timeouts[i].signal, 'timeoutSignal 的回傳值原樣放進 init.signal'));
  assert.equal(env.storage.syncState().lastError, null, '正常往返不受影響');
});

test('H1 sync call：連線階段逾時（signal abort 使 fetch reject）→ 該輪 network_error，不採信任何 token', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const inits = [];
  const { deps, timeouts } = withSw1bDeps(env, {
    fetch(url, init) {
      inits.push(init);
      return hangUntilAbort(init && init.signal);
    },
  });
  const engine = TCLSync.create(deps);
  const running = engine.syncNow().catch(() => {});
  await settle(10);

  assert.ok(timeouts.length >= 1, 'call() 必須呼叫注入的 timeoutSignal（舊實作自建 AbortController＋setTimeout）');
  assert.equal(timeouts[0].ms, 30000);
  assert.equal(inits[0].signal, timeouts[0].signal);

  timeouts.forEach((rec) => rec.abort());
  await within(running, 3000, '逾時後的 syncNow');
  await settle(10);

  assert.equal(env.storage.syncState().lastError, 'network_error');
  assert.equal(env.storage.syncAuth().token, 'tok-seeded', '逾時沒有回應，token 原封不動');
  assert.equal(env.lastState().status, 'error');
});

test('H1 sync call：讀本文途中逾時（res.json() 被 abort）→ network_error，不得回 null 當成功，也不採信 set-auth-token', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const inits = [];
  const { deps, timeouts } = withSw1bDeps(env, {
    fetch(url, init) {
      inits.push(init);
      const signal = init && init.signal;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'set-auth-token' ? 'tok-from-timed-out-response' : null;
          },
        },
        json: () => hangUntilAbort(signal),
      });
    },
  });
  const engine = TCLSync.create(deps);
  const running = engine.syncNow().catch(() => {});
  await settle(10);

  assert.ok(timeouts.length >= 1, 'call() 必須呼叫注入的 timeoutSignal');
  assert.equal(inits[0].signal, timeouts[0].signal);

  timeouts.forEach((rec) => rec.abort());
  await within(running, 3000, '讀本文逾時後的 syncNow');
  await settle(10);

  assert.equal(env.storage.syncState().lastError, 'network_error', '2xx 讀本文逾時不能被當成 payload=null 的成功');
  assert.equal(env.storage.syncAuth().token, 'tok-seeded', '逾時的回應不得採信 set-auth-token');
  assert.equal(env.lastState().status, 'error');
});

// ============================================================================
// H1 — auth.js exchangeWithBackend：AbortSignal.timeout(options.timeoutMs || 30000)
// ============================================================================

async function withStubbedAuthGlobals(fetchImpl, fn) {
  const savedFetch = globalThis.fetch;
  const savedTimeout = AbortSignal.timeout;
  const recorder = makeTimeoutRecorder();
  globalThis.fetch = fetchImpl;
  AbortSignal.timeout = recorder.timeout;
  try {
    return await fn(recorder.records);
  } finally {
    globalThis.fetch = savedFetch;
    AbortSignal.timeout = savedTimeout;
  }
}

const EXCHANGE_OPTS = { apiBase: 'https://api.metalinkclearer.workers.dev', idToken: 'fake.id.token', nonce: 'n-1' };

test('H1 auth exchange：未指定 timeoutMs 時以 30000 取 AbortSignal.timeout，signal 帶進 fetch', async () => {
  const TCLAuth = require('../auth.js');
  const inits = [];
  await withStubbedAuthGlobals(
    async (url, init) => {
      inits.push(init);
      return { ok: true, status: 200, headers: { get: () => 'tok-x' }, json: async () => ({ user: {} }) };
    },
    async (timeouts) => {
      await within(TCLAuth.exchangeWithBackend(Object.assign({}, EXCHANGE_OPTS)), 3000, 'exchange');
      assert.equal(timeouts.length, 1, 'exchangeWithBackend 要呼叫 AbortSignal.timeout 一次');
      assert.equal(timeouts[0].ms, 30000);
      assert.equal(inits[0].signal, timeouts[0].signal);
    }
  );
});

test('H1 auth exchange：連線階段逾時 → network_error（timeoutMs 可覆寫）', async () => {
  const TCLAuth = require('../auth.js');
  const inits = [];
  await withStubbedAuthGlobals(
    (url, init) => {
      inits.push(init);
      return hangUntilAbort(init && init.signal);
    },
    async (timeouts) => {
      const pending = TCLAuth.exchangeWithBackend(Object.assign({ timeoutMs: 5 }, EXCHANGE_OPTS));
      pending.catch(() => {});
      await Promise.resolve();
      assert.equal(timeouts.length, 1, 'exchangeWithBackend 要以 AbortSignal.timeout 設逾時（目前完全沒有）');
      assert.equal(timeouts[0].ms, 5, 'options.timeoutMs 覆寫預設的 30000');
      assert.equal(inits[0].signal, timeouts[0].signal);
      timeouts[0].abort();
      await assert.rejects(within(pending, 3000, 'exchange'), (err) => err && err.code === 'network_error');
    }
  );
});

test('H1 auth exchange：讀本文途中逾時 → network_error，不得回 body:null 的正常結果', async () => {
  const TCLAuth = require('../auth.js');
  const inits = [];
  await withStubbedAuthGlobals(
    async (url, init) => {
      inits.push(init);
      const signal = init && init.signal;
      return {
        ok: true,
        status: 200,
        headers: { get: (n) => (String(n).toLowerCase() === 'set-auth-token' ? 'tok-timed-out' : null) },
        json: () => hangUntilAbort(signal),
      };
    },
    async (timeouts) => {
      const pending = TCLAuth.exchangeWithBackend(Object.assign({ timeoutMs: 5 }, EXCHANGE_OPTS));
      pending.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(timeouts.length, 1, 'exchangeWithBackend 要以 AbortSignal.timeout 設逾時');
      timeouts[0].abort();
      await assert.rejects(within(pending, 3000, 'exchange'), (err) => err && err.code === 'network_error');
    }
  );
});

// ============================================================================
// H1 — background resolveFinalUrl：AbortSignal.timeout(10000)，對 Threads 請求數不變
// ============================================================================

const BG_SRC =
  fs.readFileSync(path.join(REPO_ROOT, 'i18n.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(REPO_ROOT, 'tcl-core.js'), 'utf8') +
  '\n' +
  fs.readFileSync(path.join(REPO_ROOT, 'background.js'), 'utf8');

const BG_EXT_ID = 'test-extension-id';
const BG_OWN_SENDER = { id: BG_EXT_ID };
const SHARE_URL = 'https://www.threads.com/share/DHuf91XTf/';
const CLEAN_POST_URL = 'https://www.threads.com/@dafucoding/post/DbezfB0gYvP';
const NO_OG_HTML = '<html><head></head><body></body></html>';

// 精簡版 background 沙箱（比照 background.test.js 的 makeChrome／loadBackground）：注入可控的
// AbortSignal 假件，fetch 由呼叫端決定。
function loadBgForResolve(fetchFor) {
  const recorder = makeTimeoutRecorder();
  const onMessageListeners = [];
  const onClickedListeners = [];
  const notifications = [];
  const fetchCalls = [];
  const storage = createChromeStorage({ saveHistory: true, langPref: 'zh' });
  const chrome = {
    runtime: {
      id: BG_EXT_ID,
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: (fn) => onMessageListeners.push(fn) },
    },
    contextMenus: {
      removeAll: async () => {},
      create: () => {},
      onClicked: { addListener: (fn) => onClickedListeners.push(fn) },
    },
    notifications: {
      create: (id, opts) => {
        notifications.push({ id, opts });
      },
    },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1 },
    storage: storage.api,
  };
  const fetchImpl = (url, init) => {
    fetchCalls.push({ url, init });
    return fetchFor(url, init);
  };
  runInSandbox(BG_SRC, {
    chrome,
    fetch: fetchImpl,
    AbortSignal: { timeout: recorder.timeout },
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
  });
  return {
    timeouts: recorder.records,
    fetchCalls,
    notifications,
    shareFetches: () => fetchCalls.filter((c) => c.url === SHARE_URL),
    resolveShare(url) {
      return new Promise((resolve) => {
        onMessageListeners.slice().forEach((fn) => fn({ type: 'resolveShare', url }, BG_OWN_SENDER, resolve));
      });
    },
    click(info, tab) {
      onClickedListeners.slice().forEach((fn) => fn(info, tab));
    },
  };
}

test('H1 resolveFinalUrl：以 AbortSignal.timeout(10000) 取 signal；headers 階段逾時 → resolveShare 回 network-error，且只 fetch 一次', async () => {
  const bg = loadBgForResolve((url, init) => {
    if (url === SHARE_URL) return hangUntilAbort(init && init.signal);
    return Promise.resolve({ url, text: async () => NO_OG_HTML });
  });
  const pending = bg.resolveShare(SHARE_URL);
  await settle(4);

  const share = bg.shareFetches();
  assert.equal(share.length, 1, '一次使用者動作只 fetch 一次');
  const rec = bg.timeouts.find((r) => r.ms === 10000);
  assert.ok(rec, 'resolveFinalUrl 要呼叫 AbortSignal.timeout(10000)（RESOLVE_FETCH_TIMEOUT_MS）');
  assert.equal(share[0].init.signal, rec.signal, 'signal 原樣帶進短碼解析的 fetch');
  assert.equal(share[0].init.redirect, 'follow', 'redirect 行為不動');
  assert.equal(share[0].init.credentials, 'omit', 'credentials 不動');

  rec.abort();
  const response = await within(pending, 3000, 'resolveShare');
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: false, reason: 'network-error' });
  await settle(4);
  assert.equal(bg.shareFetches().length, 1, '逾時後不重試，對 Threads 的請求數不變');
});

test('H1 resolveFinalUrl：讀本文途中逾時 → ogFields 空、finalUrl 照回，resolveShare 仍成功，且只 fetch 一次', async () => {
  const bg = loadBgForResolve((url, init) => {
    const signal = init && init.signal;
    if (url === SHARE_URL) {
      return Promise.resolve({ url: `${CLEAN_POST_URL}?xmt=AQGabc`, text: () => hangUntilAbort(signal) });
    }
    return Promise.resolve({ url, text: async () => NO_OG_HTML });
  });
  const pending = bg.resolveShare(SHARE_URL);
  await settle(4);

  const rec = bg.timeouts.find((r) => r.ms === 10000);
  assert.ok(rec, 'resolveFinalUrl 要呼叫 AbortSignal.timeout(10000)');
  assert.equal(bg.shareFetches()[0].init.signal, rec.signal);

  rec.abort();
  const response = await within(pending, 3000, 'resolveShare');
  assert.deepEqual(JSON.parse(JSON.stringify(response)), { ok: true, cleanUrl: CLEAN_POST_URL });
  await settle(4);
  assert.equal(bg.shareFetches().length, 1, '讀本文逾時不補抓');
});

test('H1 resolveFinalUrl：右鍵路徑 headers 階段逾時 → bgNetworkError 通知，只 fetch 一次', async () => {
  const bg = loadBgForResolve((url, init) => {
    if (url === SHARE_URL) return hangUntilAbort(init && init.signal);
    return Promise.resolve({ url, text: async () => NO_OG_HTML });
  });
  bg.click({ menuItemId: 'threads-clean-link', linkUrl: SHARE_URL }, { id: 7 });
  await settle(4);

  const rec = bg.timeouts.find((r) => r.ms === 10000);
  assert.ok(rec, '右鍵路徑同樣經 resolveFinalUrl 取 AbortSignal.timeout(10000)');
  rec.abort();
  await settle(20);

  assert.ok(
    bg.notifications.some((n) => n.id === 'threads-clean-link-network-error'),
    `逾時走既有的網路錯誤通知，實得：${JSON.stringify(bg.notifications.map((n) => n.id))}`
  );
  assert.equal(bg.shareFetches().length, 1, '一次右鍵只 fetch 一次');
});

// ============================================================================
// H1＋H3 — background 接線：timeoutSignal 與 clientVersion
// ============================================================================

function loadBgForSyncWiring() {
  const recorder = makeTimeoutRecorder();
  const createCalls = [];
  const engine = {};
  ['getState', 'signIn', 'signOut', 'syncNow', 'deleteCloud', 'verifySession', 'notifyRecorded', 'onAlarm'].forEach(
    (name) => {
      engine[name] = () => Promise.resolve({ status: 'signed_out' });
    }
  );
  const TCLSync = {
    ALARM_NAME: 'tcl-sync',
    DEBOUNCE_MS: 2000,
    SYNC_PERIOD_MINUTES: 5,
    API_BASE_PRODUCTION: 'https://api.metalinkclearer.workers.dev',
    API_BASE_STAGING: 'https://api-staging.metalinkclearer.workers.dev',
    CLIENT_ID: '17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com',
    create(deps) {
      createCalls.push(deps);
      return engine;
    },
  };
  const storage = createChromeStorage({ saveHistory: true });
  const chrome = {
    runtime: {
      id: 'hehokicokbgajpanjcajhmflaennnmdj',
      onInstalled: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      getManifest: () => ({ manifest_version: 3, version: MANIFEST_VERSION }),
    },
    contextMenus: { removeAll: async () => {}, create: () => {}, onClicked: { addListener: () => {} } },
    notifications: { create: () => {} },
    scripting: { executeScript: async () => [{ result: { ok: true } }] },
    tabs: { TAB_ID_NONE: -1, query: async () => [] },
    alarms: {
      create: () => {},
      clear: async () => true,
      get: async () => undefined,
      getAll: async () => [],
      onAlarm: { addListener: () => {} },
    },
    permissions: { contains: (d, cb) => cb(true), request: (d, cb) => cb(true) },
    storage: storage.api,
  };
  runInSandbox(BG_SRC, {
    chrome,
    TCLSync,
    fetch: async (url) => ({ url, text: async () => NO_OG_HTML }),
    AbortSignal: { timeout: recorder.timeout },
    console: { log() {}, warn() {}, error() {} },
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    crypto,
  });
  return { createCalls, timeouts: recorder.records };
}

test('H1＋H3 background 接線：TCLSync.create 收到 timeoutSignal=(ms)=>AbortSignal.timeout(ms) 與 clientVersion=manifest version', () => {
  const bg = loadBgForSyncWiring();
  assert.equal(bg.createCalls.length, 1, '前置：依賴齊備時建立引擎');
  const deps = bg.createCalls[0];

  assert.equal(typeof deps.timeoutSignal, 'function', 'deps.timeoutSignal 要注入');
  const signal = deps.timeoutSignal(30000);
  const rec = bg.timeouts[bg.timeouts.length - 1];
  assert.ok(rec && rec.ms === 30000, 'timeoutSignal(ms) 轉呼叫 AbortSignal.timeout(ms)');
  assert.equal(signal, rec.signal, '原樣回傳 AbortSignal.timeout 的 signal');

  assert.equal(deps.clientVersion, MANIFEST_VERSION, 'clientVersion 取自 chrome.runtime.getManifest().version');
});

// ============================================================================
// H2 — TCLCore.errorCategoryOf
// ============================================================================

test('H2 errorCategoryOf：六類各自的碼與可重試旗標', () => {
  const TCLCore = require('../tcl-core.js');
  assert.equal(typeof TCLCore.errorCategoryOf, 'function', 'TCLCore.errorCategoryOf 要匯出');
  const table = [
    ['session_expired', 'auth', false],
    ['unauthorized', 'auth', false],
    ['storage_quota', 'quota', false],
    ['rate_limited', 'rate_limit', true],
    ['network_error', 'network', true],
    ['internal_error', 'server', true],
    ['misconfigured', 'server', true],
    ['gone', 'server', true],
  ];
  table.forEach(([code, category, retryable]) => {
    assert.deepEqual(TCLCore.errorCategoryOf(code), { category, retryable }, code);
  });
});

test('H2 errorCategoryOf：其他碼與非字串一律歸 unknown', () => {
  const TCLCore = require('../tcl-core.js');
  assert.equal(typeof TCLCore.errorCategoryOf, 'function', 'TCLCore.errorCategoryOf 要匯出');
  [
    'bad_request',
    'unsupported_media_type',
    'unprocessable',
    'too_many_upserts',
    'bad_since',
    'bad_cursor',
    'bad_device_id',
    'not_found',
    'forbidden_origin',
    'storage_write_failed',
    'some_future_code',
    '',
    null,
    undefined,
    42,
  ].forEach((code) => {
    const got = TCLCore.errorCategoryOf(code);
    assert.equal(got && got.category, 'unknown', `${String(code)} → unknown`);
    assert.equal(typeof got.retryable, 'boolean', `${String(code)} 的 retryable 要是布林`);
  });
  assert.equal(TCLCore.errorCategoryOf('forbidden_origin').retryable, false, 'forbidden_origin 屬 FATAL_ERRORS，不可重試');
});

// ============================================================================
// H2 — sync.js httpError：body.error 以 ERROR_CODE_PATTERN 夾擠
// ============================================================================

async function lastErrorAfterFailure(failure) {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  env.server.failNext(failure);
  const { deps } = withSw1bDeps(env);
  const engine = TCLSync.create(deps);
  await within(engine.syncNow().catch(() => {}), 3000, 'syncNow');
  await settle(10);
  return env.storage.syncState().lastError;
}

test('H2 httpError 夾擠：body.error 帶 HTML 字串 → 退回狀態碼預設碼', async () => {
  assert.equal(await lastErrorAfterFailure({ status: 400, body: { error: '<b>x</b>' } }), 'bad_request');
});

test('H2 httpError 夾擠：body.error 41 字元 → 退回狀態碼預設碼', async () => {
  assert.equal(await lastErrorAfterFailure({ status: 422, body: { error: 'a'.repeat(41) } }), 'unprocessable');
});

test('H2 httpError 夾擠：body.error 非字串 → 退回狀態碼預設碼（回歸保護）', async () => {
  assert.equal(await lastErrorAfterFailure({ status: 503, body: { error: 42 } }), 'misconfigured');
});

test('H2 httpError 夾擠：40 字元內的合法碼照收（回歸保護）', async () => {
  const code = 'a'.repeat(40);
  assert.equal(await lastErrorAfterFailure({ status: 400, body: { error: code } }), code);
});

// ============================================================================
// H2 — options：toast 與 lastError 文案先查類別
// ============================================================================

const OPT_NOW = 1000000;

function optState(over) {
  return Object.assign(
    {
      status: 'signed_in',
      email: 'user@example.com',
      displayName: 'Synthetic',
      avatarUrl: null,
      lastSyncedAt: OPT_NOW - 5 * 60 * 1000,
      pendingCount: 0,
      lastError: null,
      apiBase: 'https://api.example/',
    },
    over
  );
}

async function mountOptions(state, extraHandlers = {}) {
  const storage = createChromeStorage({ langPref: 'zh' }, { history: [] });
  const doc = makeDocumentStub();
  const runtime = makeFakeRuntime(Object.assign({ 'sync.getState': () => state }, extraHandlers));
  const controller = options.createOptionsController({
    document: doc,
    syncStorage: storage.sync,
    localStorage: storage.local,
    i18n,
    now: () => OPT_NOW,
    runtime,
  });
  await controller.init();
  await optSettle.settle();
  return { doc, runtime, controller };
}

// [碼, 期望文案]
const CATEGORY_TEXT_CASES = [
  ['storage_quota', () => i18n.t('zh', 'opSyncErrQuota')],
  ['rate_limited', () => i18n.t('zh', 'opSyncErrRateLimit')],
  ['network_error', () => i18n.t('zh', 'opSyncErrNetwork')],
  ['internal_error', () => i18n.fmt('zh', 'opSyncErrServer', { code: 'internal_error' })],
  ['misconfigured', () => i18n.fmt('zh', 'opSyncErrServer', { code: 'misconfigured' })],
];

for (const [code, expected] of CATEGORY_TEXT_CASES) {
  test(`H2 options lastError：${code} 顯示所屬類別的文案，不再是「同步失敗：${code}」`, async () => {
    const { doc } = await mountOptions(optState({ status: 'error', lastError: code }));
    assert.equal(doc.ids.acctErrorRow.hidden, false, '前置：錯誤列顯示');
    assert.notEqual(expected(), i18n.t('zh', 'opAccountErrorPrefix') + code);
    assert.equal(doc.ids.acctErrorText.textContent, expected());
  });

  test(`H2 options 刪雲端 toast：回應 {ok:false, code:'${code}'} 顯示所屬類別的文案`, async () => {
    let resolveDelete;
    const deferred = new Promise((resolve) => {
      resolveDelete = resolve;
    });
    const { doc } = await mountOptions(optState({ pendingCount: 2 }), { 'sync.deleteCloud': () => deferred });
    doc.ids.acctDeleteBtn.fire('click');
    doc.ids.confirmOk.fire('click');
    resolveDelete({ ok: false, code });
    await optSettle.settle();
    assert.equal(doc.ids.toast.textContent, expected());
  });
}

test('H2 options：server 類文案帶出原始碼（{code} 插值）', async () => {
  const { doc } = await mountOptions(optState({ status: 'error', lastError: 'gone' }));
  assert.ok(doc.ids.acctErrorText.textContent.includes('gone'), `實得：${doc.ids.acctErrorText.textContent}`);
  assert.equal(doc.ids.acctErrorText.textContent, i18n.fmt('zh', 'opSyncErrServer', { code: 'gone' }));
});

test('H2 options 刪雲端 toast：auth 類（unauthorized）走登入過期文案', async () => {
  let resolveDelete;
  const deferred = new Promise((resolve) => {
    resolveDelete = resolve;
  });
  const { doc } = await mountOptions(optState({ pendingCount: 2 }), { 'sync.deleteCloud': () => deferred });
  doc.ids.acctDeleteBtn.fire('click');
  doc.ids.confirmOk.fire('click');
  resolveDelete({ ok: false, code: 'unauthorized' });
  await optSettle.settle();
  assert.equal(doc.ids.toast.textContent, i18n.t('zh', 'opAccountExpired'));
});

test('H2 options：unknown 類維持「前綴＋碼」（回歸保護）', async () => {
  const { doc } = await mountOptions(optState({ status: 'error', lastError: 'bad_request' }));
  assert.equal(doc.ids.acctErrorText.textContent, i18n.t('zh', 'opAccountErrorPrefix') + 'bad_request');
});

// ============================================================================
// H2 — i18n 四個新鍵
// ============================================================================

test('H2 i18n：opSyncErrQuota／RateLimit／Network／Server 在 zh 與 en 都有，且 zh≠en≠鍵名', () => {
  ['opSyncErrQuota', 'opSyncErrRateLimit', 'opSyncErrNetwork', 'opSyncErrServer'].forEach((key) => {
    const zh = i18n.t('zh', key);
    const en = i18n.t('en', key);
    assert.notEqual(zh, key, `zh 缺 ${key}`);
    assert.notEqual(en, key, `en 缺 ${key}`);
    assert.notEqual(zh, en, `${key} 的 en 不得退回 zh`);
  });
  assert.match(i18n.t('zh', 'opSyncErrServer'), /\{code\}/, 'zh 的 server 文案帶 {code}');
  assert.match(i18n.t('en', 'opSyncErrServer'), /\{code\}/, 'en 的 server 文案帶 {code}');
});

// ============================================================================
// H3 — X-Client-Version: ext/<manifest version>
// ============================================================================

test('H3 sync：同步與登出的每個請求都帶 X-Client-Version: ext/<manifest version>', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ signedIn: true, history: [entry()] });
  const { deps } = withSw1bDeps(env);
  const engine = TCLSync.create(deps);
  await within(engine.syncNow(), 3000, 'syncNow');
  await settle(10);
  await within(engine.signOut(), 3000, 'signOut');
  await settle(10);

  assert.ok(env.server.requests.length >= 2, '前置：同步與登出都有請求');
  env.server.requests.forEach((r) => {
    assert.equal(r.headers['x-client-version'], CLIENT_VERSION_HEADER, `${r.method} ${r.path} 缺版本標頭`);
  });
});

test('H3 sync：登入時把 clientVersion 交給 auth.exchangeWithBackend', async () => {
  const TCLSync = loadSync();
  const env = makeEnv();
  const { deps } = withSw1bDeps(env);
  const engine = TCLSync.create(deps);
  await within(engine.signIn(), 3000, 'signIn');
  await settle(10);

  assert.equal(env.auth.calls.exchange.length, 1, '前置：走到交換');
  assert.equal(env.auth.calls.exchange[0].clientVersion, MANIFEST_VERSION);
});

test('H3 auth exchange：請求帶 X-Client-Version: ext/<clientVersion>', async () => {
  const TCLAuth = require('../auth.js');
  const inits = [];
  await withStubbedAuthGlobals(
    async (url, init) => {
      inits.push(init);
      return { ok: true, status: 200, headers: { get: () => 'tok-x' }, json: async () => ({ user: {} }) };
    },
    async () => {
      await within(
        TCLAuth.exchangeWithBackend(Object.assign({ clientVersion: MANIFEST_VERSION }, EXCHANGE_OPTS)),
        3000,
        'exchange'
      );
      assert.equal(headerOf(inits[0].headers, 'X-Client-Version'), CLIENT_VERSION_HEADER);
      assert.equal(headerOf(inits[0].headers, 'Content-Type'), 'application/json', '既有標頭不動');
    }
  );
});

test('H3 mock-sync-server：記錄請求的 X-Client-Version 標頭（回歸保護）', async () => {
  const server = createMockSyncServer({ now: () => T0 });
  await server.fetch(`${server.apiBase}/api/auth/get-session`, {
    method: 'GET',
    headers: { 'X-Client-Version': CLIENT_VERSION_HEADER },
  });
  assert.equal(server.requests[0].headers['x-client-version'], CLIENT_VERSION_HEADER);
});
