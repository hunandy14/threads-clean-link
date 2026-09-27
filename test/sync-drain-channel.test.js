// test/sync-drain-channel.test.js — SW-1a：links 與 marks 的「推→拉迴圈」收成
// `drainChannel(ctx, ch)` 共用外殼。
//
// 規格：simplify/design-sw.md §4。
//
// 【外殼契約】
// - ch：path、cursorKey、sinceWhenNone、batches、bodyOf、decorate、apply、
//   pullBatch。
// - 每批 POST 前 takeCall(ctx, true)；額度或期限用完當輪收手，budget.exhausted。
// - 先 apply（落地）再前進游標；apply 失敗時游標不動，後續批不送。
// - 最後一次回應的 changes.hasMore 為 true 時續拉，受 MAX_PULL_ROUNDS 與
//   takeCall 約束。
// - links：無游標送 since:'0'，首個 POST 帶 device 區塊，續拉 body 只有 since。
// - marks：無游標不帶 since，沒有 device，apply 內含 ack 清 dirty。
//
// 本檔除 DC1（結構）外都是行為等價的回歸保護：對照 wave-2 現況錄製，改寫前
// 後都必須綠。
//
// harness：storage 替身沿用 test/sync-marks.test.js 的時序紀律（get／set 一律以
// setImmediate 跨 tick 結算），另加一條事件日誌，把「請求送出」與「storage 寫
// 入」排成同一條時間線，供游標前進時機的斷言使用。後端以腳本化 fetch 代言，
// 每個回應由測試逐頁指定；DC7 改用 test/helpers/mock-sync-server.js。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TCLCore = require('../tcl-core.js');
const { createMockSyncServer } = require('./helpers/mock-sync-server.js');

function loadSync() {
  return require('../sync.js');
}

const SYNC_SOURCE_PATH = path.join(__dirname, '..', 'sync.js');
const API_BASE = 'https://api.metalinkclearer.workers.dev';
const LINKS_PATH = '/api/v1/links/sync';
const MARKS_SYNC_PATH = '/api/v1/marks/sync';
const MARKS_LIST_PATH = '/api/v1/marks';

const T0 = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const DEVICE = { deviceId: '11111111-2222-4333-8444-555555555555', name: 'Chrome on Windows', platform: 'chrome_extension' };

// ---- storage 替身（時序紀律同 test/sync-marks.test.js，另接事件日誌） ----

function createSyncStorage(localSeed, log) {
  const chainDepth = { value: 0 };

  function makeArea(name, seed) {
    const data = JSON.parse(JSON.stringify(seed));

    function read(keys) {
      if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(data));
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
      return JSON.parse(JSON.stringify(out));
    }

    return {
      data,
      api: {
        get(keys) {
          return new Promise((resolve) => setImmediate(() => resolve(read(keys))));
        },
        set(items) {
          const copy = JSON.parse(JSON.stringify(items));
          return new Promise((resolve) =>
            setImmediate(() => {
              Object.assign(data, copy);
              // 落地那一刻才記:游標前進時機要對照的是「真的寫進去」。
              if (name === 'local') log.push({ t: 'write', keys: Object.keys(copy).sort() });
              resolve();
            })
          );
        },
        remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          return new Promise((resolve) =>
            setImmediate(() => {
              list.forEach((k) => delete data[k]);
              resolve();
            })
          );
        },
      },
    };
  }

  const local = makeArea('local', localSeed);
  const session = makeArea('session', {});
  return { api: { local: local.api, session: session.api }, localData: local.data, chainDepth };
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
  };
}

// ---- 腳本化後端 ----

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    json: () => Promise.resolve(body),
  };
}

function ackAllLinks(body) {
  return {
    upserts: (body.upserts || []).map((item) => ({ id: item.id, canonicalId: item.id })),
    deletedIds: (body.deletes || []).slice(),
    rejectedIds: [],
  };
}

function ackAllMarks(body) {
  return { upserts: (body.upserts || []).map((mark) => mark.key), rejectedIds: [] };
}

/**
 * handlers[path] 是依序取用的回應產生器陣列（(body, n) => payload）；取完之後
 * 沿用最後一個。GET /api/v1/marks（回填）預設回空頁、不帶 cursor。
 */
function createScriptedFetch(handlers, log, hooks = {}) {
  const requests = [];
  const counts = {};
  function fetchImpl(input, init) {
    const url = new URL(String(input));
    const method = ((init && init.method) || 'GET').toUpperCase();
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const record = { method, path: url.pathname, search: url.search, body };
    requests.push(record);
    log.push({ t: 'req', method, path: url.pathname, since: body && Object.prototype.hasOwnProperty.call(body, 'since') ? body.since : '(none)' });
    const key = method + ' ' + url.pathname;
    counts[key] = (counts[key] || 0) + 1;
    if (hooks.onRequest) hooks.onRequest(record, counts[key]);
    if (method === 'GET' && url.pathname === MARKS_LIST_PATH) {
      return Promise.resolve(jsonResponse(200, { items: [], nextCursor: null }));
    }
    const list = handlers[url.pathname];
    if (!list || !list.length) return Promise.resolve(jsonResponse(404, { error: 'not_found' }));
    const n = counts[key];
    const handler = list[Math.min(n, list.length) - 1];
    return Promise.resolve(jsonResponse(200, handler(body, n)));
  }
  return { fetch: fetchImpl, requests };
}

// ---- 本機資料 ----

function postUrl(i) {
  return `https://www.threads.com/@user${i}/post/P${String(i).padStart(10, '0')}`;
}

function linkEntry(i, over = {}) {
  const url = postUrl(i);
  const at = T0 - DAY + i * 1000;
  return Object.assign(
    {
      id: `loc-${i}`,
      url,
      postKey: TCLCore.postKeyOf(url),
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

function dirtyHistory(count, base = 0) {
  const list = [];
  for (let i = 0; i < count; i += 1) list.push(linkEntry(base + i));
  return list;
}

function incomingLink(i) {
  const url = postUrl(i);
  const at = T0 - 2 * DAY + i * 1000;
  return { id: `srv-${i}`, original: url, cleaned: url, receivedAt: at, seen: [{ at }] };
}

function markEntry(i, over = {}) {
  const updatedAt = T0 - 3 * DAY + i;
  return Object.assign(
    {
      state: 'active',
      handle: `bulk${i}`,
      source: 'auto',
      addedAt: T0 - 5 * DAY,
      updatedAt,
      evidence: [],
      dirty: true,
      dirtyAt: updatedAt,
    },
    over
  );
}

function blocklist(entries) {
  const handleIndex = {};
  Object.keys(entries).forEach((id) => {
    const handle = entries[id].handle;
    if (typeof handle === 'string') handleIndex[handle.toLowerCase()] = id;
  });
  return { version: 2, entries, handleIndex };
}

function dirtyBlocklist(count, base) {
  const entries = {};
  for (let i = 0; i < count; i += 1) entries[String(base + i)] = markEntry(base + i);
  return blocklist(entries);
}

function incomingMark(i) {
  const id = String(i);
  const entry = markEntry(i, { handle: `cloud${i}`, updatedAt: T0 - DAY + i });
  delete entry.dirty;
  delete entry.dirtyAt;
  return TCLCore.toScamMark(id, entry);
}

function signedInState(over = {}) {
  return Object.assign(
    {
      userId: 'user-abc',
      email: 'someone@example.com',
      cursor: 'c0',
      lastSyncedAt: T0 - 10 * 60_000,
      lastError: null,
      marksCursor: 'm0',
      marksEvicted: null,
      marksBackfillCursor: null,
    },
    over
  );
}

/**
 * 組一套注入環境。opts.handlers 交給腳本化 fetch；opts.failWrite(key, n) 回
 * true 時讓該鍵第 n 次寫入以配額錯誤失敗（模擬撞到 chrome.storage 上限）。
 */
function makeEnv(opts = {}) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const log = [];
  const localSeed = {
    syncAuth: { token: 'tok-seeded' },
    syncApiBase: API_BASE,
    syncState: signedInState(opts.syncState),
    history: opts.history || [],
    scamBlocklist: opts.blocklist || blocklist({}),
  };
  const storage = createSyncStorage(localSeed, log);
  const alarms = createAlarmsMock();
  const scripted = createScriptedFetch(opts.handlers || {}, log, { onRequest: opts.onRequest ? (r, n) => opts.onRequest(r, n, clock) : null });

  let local = storage.api.local;
  if (opts.failWrite) {
    const seen = {};
    const inner = local;
    local = Object.assign({}, inner, {
      set(items) {
        for (const key of Object.keys(items)) {
          seen[key] = (seen[key] || 0) + 1;
          if (opts.failWrite(key, seen[key])) return Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
        }
        return inner.set(items);
      },
    });
  }

  const deps = {
    storage: { local, session: storage.api.session },
    fetch: scripted.fetch,
    now,
    alarms: alarms.api,
    broadcast: () => {},
    auth: {},
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
    randomUUID: () => 'uuid-x',
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
    writeChain: (fn) => {
      storage.chainDepth.value += 1;
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          storage.chainDepth.value -= 1;
        });
    },
  };
  if (opts.device !== false) deps.getLocalDevice = () => Promise.resolve(Object.assign({}, DEVICE));

  return {
    clock,
    log,
    deps,
    alarms,
    requests: scripted.requests,
    local: storage.localData,
    syncState() {
      return storage.localData.syncState;
    },
    posts(p) {
      return scripted.requests.filter((r) => r.method === 'POST' && r.path === p);
    },
  };
}

function bodyShape(body) {
  if (!body) return null;
  return {
    keys: Object.keys(body).sort(),
    since: Object.prototype.hasOwnProperty.call(body, 'since') ? body.since : '(none)',
    upserts: Array.isArray(body.upserts) ? body.upserts.length : '(none)',
    deletes: Array.isArray(body.deletes) ? body.deletes.length : '(none)',
    device: body.device ? Object.keys(body.device).sort() : '(none)',
  };
}

function requestShapes(env) {
  return env.requests.map((r) => ({ method: r.method, path: r.path, search: r.search, body: bodyShape(r.body) }));
}

// ---- 原始碼切片（DC1） ----

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
}

/** 取出 `function <name>(` 的函式本體（含外層大括號）；找不到回 null。 */
function functionBody(code, name) {
  const re = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const match = re.exec(code);
  if (!match) return null;
  let i = code.indexOf('{', match.index + match[0].length);
  // 跳過參數列裡的預設值大括號不在本檔範圍:sync.js 不用預設參數。
  const start = i;
  let depth = 0;
  for (; i < code.length; i += 1) {
    const ch = code[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(start, i + 1);
    }
  }
  return null;
}

// ============================================================================
// DC1 — 結構:共用外殼 drainChannel
// ============================================================================

test('DC1 sync.js 有 drainChannel，runRound 與 exchangeMarks 都呼叫它，推拉迴圈只剩一份', () => {
  const code = stripComments(fs.readFileSync(SYNC_SOURCE_PATH, 'utf8'));
  // 不用 assert.match:失敗時會把整份原始碼倒進報告。
  assert.ok(/(?:async\s+)?function\s+drainChannel\s*\(/.test(code), 'sync.js 應定義 drainChannel');

  const drain = functionBody(code, 'drainChannel');
  const runRound = functionBody(code, 'runRound');
  const exchange = functionBody(code, 'exchangeMarks');
  assert.ok(runRound, 'runRound 仍應存在');
  assert.ok(exchange, 'exchangeMarks 仍應存在');
  assert.match(runRound, /\bdrainChannel\s*\(/, 'runRound 應呼叫 drainChannel');
  assert.match(exchange, /\bdrainChannel\s*\(/, 'exchangeMarks 應呼叫 drainChannel');

  // 推拉迴圈的指紋:hasMore 續拉與 MAX_PULL_ROUNDS 上限只能出現在外殼裡。
  assert.doesNotMatch(runRound, /hasMore/, 'runRound 不得再有自己的 hasMore 續拉迴圈');
  assert.doesNotMatch(exchange, /hasMore/, 'exchangeMarks 不得再有自己的 hasMore 續拉迴圈');
  assert.doesNotMatch(runRound, /MAX_PULL_ROUNDS/, 'runRound 不得再自管續拉上限');
  assert.doesNotMatch(exchange, /MAX_PULL_ROUNDS/, 'exchangeMarks 不得再自管續拉上限');
  assert.doesNotMatch(runRound, /takeCall\s*\(/, 'runRound 的額度檢查應交給外殼');
  assert.doesNotMatch(exchange, /takeCall\s*\(/, 'exchangeMarks 的額度檢查應交給外殼');

  // 全檔讀 changes.hasMore 的地方只剩外殼那一處(回填走 nextCursor，不讀 hasMore)。
  const hasMoreReads = code.match(/\.hasMore\b/g) || [];
  assert.equal(hasMoreReads.length, 1, `全檔讀 .hasMore 應只剩一處，實得 ${hasMoreReads.length}`);
  assert.match(drain, /\.hasMore\b/, '唯一的 hasMore 讀取應在 drainChannel 內');
  assert.match(drain, /MAX_PULL_ROUNDS/, '續拉上限由 drainChannel 把關');
  assert.match(drain, /takeCall\s*\(/, '每批前的額度檢查由 drainChannel 把關');
});

// ============================================================================
// DC2 — 行為等價 golden(對照 wave-2 現況錄製)
// ============================================================================

// links:120 筆 dirty → 50／50／20 三批；最後一批回 hasMore，續拉兩頁。
// marks:60 筆 dirty → 50／10 兩批；最後一批回 hasMore，續拉三頁。
function goldenHandlers() {
  return {
    [LINKS_PATH]: [
      (body) => ({ cursor: 'c1', applied: ackAllLinks(body), changes: { links: [], deleted: [], hasMore: false } }),
      (body) => ({ cursor: 'c2', applied: ackAllLinks(body), changes: { links: [], deleted: [], hasMore: false } }),
      (body) => ({ cursor: 'c3', applied: ackAllLinks(body), changes: { links: [incomingLink(900)], deleted: [], hasMore: true } }),
      () => ({ cursor: 'c4', applied: {}, changes: { links: [incomingLink(901)], deleted: [{ id: 'loc-0' }], hasMore: true } }),
      () => ({ cursor: 'c5', applied: {}, changes: { links: [incomingLink(902)], deleted: [], hasMore: false } }),
    ],
    [MARKS_SYNC_PATH]: [
      (body) => ({ cursor: 'm1', applied: ackAllMarks(body), changes: { marks: [], deleted: [], hasMore: false } }),
      (body) => ({ cursor: 'm2', applied: ackAllMarks(body), changes: { marks: [incomingMark(7001)], deleted: [], hasMore: true } }),
      () => ({ cursor: 'm3', applied: {}, changes: { marks: [incomingMark(7002)], deleted: [], hasMore: true } }),
      () => ({ cursor: 'm4', applied: {}, changes: { marks: [], deleted: [{ key: 'threads:5000', deletedAt: T0 }], hasMore: true } }),
      () => ({ cursor: 'm5', applied: {}, evicted: 2, changes: { marks: [incomingMark(7003)], deleted: [], hasMore: false } }),
    ],
  };
}

const LINK_BATCH_KEYS = ['deletes', 'device', 'since', 'upserts'];
const LINK_BATCH_KEYS_NO_DEVICE = ['deletes', 'since', 'upserts'];
const MARK_KEYS_WITH_SINCE = ['deletes', 'since', 'upserts'];

const GOLDEN_REQUESTS = [
  { method: 'POST', path: LINKS_PATH, search: '', body: { keys: LINK_BATCH_KEYS, since: 'c0', upserts: 50, deletes: 0, device: ['deviceId', 'name', 'platform'] } },
  { method: 'POST', path: LINKS_PATH, search: '', body: { keys: LINK_BATCH_KEYS_NO_DEVICE, since: 'c1', upserts: 50, deletes: 0, device: '(none)' } },
  { method: 'POST', path: LINKS_PATH, search: '', body: { keys: LINK_BATCH_KEYS_NO_DEVICE, since: 'c2', upserts: 20, deletes: 0, device: '(none)' } },
  { method: 'POST', path: LINKS_PATH, search: '', body: { keys: ['since'], since: 'c3', upserts: '(none)', deletes: '(none)', device: '(none)' } },
  { method: 'POST', path: LINKS_PATH, search: '', body: { keys: ['since'], since: 'c4', upserts: '(none)', deletes: '(none)', device: '(none)' } },
  { method: 'POST', path: MARKS_SYNC_PATH, search: '', body: { keys: MARK_KEYS_WITH_SINCE, since: 'm0', upserts: 50, deletes: 0, device: '(none)' } },
  { method: 'POST', path: MARKS_SYNC_PATH, search: '', body: { keys: MARK_KEYS_WITH_SINCE, since: 'm1', upserts: 10, deletes: 0, device: '(none)' } },
  { method: 'POST', path: MARKS_SYNC_PATH, search: '', body: { keys: MARK_KEYS_WITH_SINCE, since: 'm2', upserts: 0, deletes: 0, device: '(none)' } },
  { method: 'POST', path: MARKS_SYNC_PATH, search: '', body: { keys: MARK_KEYS_WITH_SINCE, since: 'm3', upserts: 0, deletes: 0, device: '(none)' } },
  { method: 'POST', path: MARKS_SYNC_PATH, search: '', body: { keys: MARK_KEYS_WITH_SINCE, since: 'm4', upserts: 0, deletes: 0, device: '(none)' } },
];

// 請求與落地寫入的交錯:每一次回應都先把對應的鍵寫進去，下一個請求才出發。
// links 每頁寫一次 history；marks 每頁有變動才寫 scamBlocklist(m3 那頁只有
// 一筆新 mark，照樣寫)。最後 saveState 才把兩個游標一起落盤。
const GOLDEN_TIMELINE = [
  'req POST /api/v1/links/sync since=c0',
  'write history',
  'req POST /api/v1/links/sync since=c1',
  'write history',
  'req POST /api/v1/links/sync since=c2',
  'write history',
  'req POST /api/v1/links/sync since=c3',
  'write history',
  'req POST /api/v1/links/sync since=c4',
  'write history',
  'req POST /api/v1/marks/sync since=m0',
  'write scamBlocklist',
  'req POST /api/v1/marks/sync since=m1',
  'write scamBlocklist',
  'req POST /api/v1/marks/sync since=m2',
  'write scamBlocklist',
  'req POST /api/v1/marks/sync since=m3',
  'write scamBlocklist',
  'req POST /api/v1/marks/sync since=m4',
  'write scamBlocklist',
  'write syncState',
];

function timelineOf(env) {
  return env.log
    .filter((e) => e.t === 'req' || (e.t === 'write' && e.keys.some((k) => k === 'history' || k === 'scamBlocklist' || k === 'syncState')))
    .map((e) => (e.t === 'req' ? `req ${e.method} ${e.path} since=${e.since}` : `write ${e.keys.join(',')}`));
}

test('DC2 golden:links 三批推＋兩頁拉、marks 兩批推＋三頁拉，請求形狀、游標時機與最終狀態不變', async () => {
  const TCLSync = loadSync();
  const history = dirtyHistory(120);
  const env = makeEnv({ history, blocklist: dirtyBlocklist(60, 5000), handlers: goldenHandlers() });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  assert.deepEqual(requestShapes(env), GOLDEN_REQUESTS, '每個請求的 method／path／body 形狀與 since 必須與現況逐一相同');
  assert.deepEqual(timelineOf(env), GOLDEN_TIMELINE, '游標只在該頁落地之後才前進，下一個請求才帶新 since');

  // 最終本機狀態。
  const state = env.syncState();
  assert.equal(state.cursor, 'c5');
  assert.equal(state.marksCursor, 'm5');
  assert.equal(state.marksEvicted, 2, 'evicted 累記進 marksEvicted');
  assert.equal(state.lastError, null);

  const hist = env.local.history;
  assert.equal(hist.length, 122, '120 筆本機 − 1 筆雲端墓碑 + 3 筆雲端新卡');
  assert.equal(hist.filter((e) => e.dirty === true).length, 0, '三批全數 ack，沒有殘留 dirty');
  assert.ok(!hist.some((e) => e.id === 'loc-0'), '續拉頁的墓碑要硬刪本機那一筆');
  ['srv-900', 'srv-901', 'srv-902'].forEach((id) => {
    assert.ok(hist.some((e) => e.id === id), `${id} 應合併進 history`);
  });
  assert.deepEqual(
    hist.map((e) => e.at),
    hist.map((e) => e.at).slice().sort((a, b) => b - a),
    'history 維持依 at 降冪'
  );

  const entries = env.local.scamBlocklist.entries;
  const ids = Object.keys(entries).sort();
  assert.equal(ids.length, 62, '60 筆本機 − 1 筆雲端墓碑 + 3 筆雲端新 mark');
  assert.ok(!entries['5000'], '墓碑不晚於本機 updatedAt 的那一筆硬刪');
  ['7001', '7002', '7003'].forEach((id) => assert.ok(entries[id], `${id} 應併進名單`));
  assert.equal(Object.values(entries).filter((e) => e.dirty === true).length, 0, '兩批全數 ack，dirty 清空');
  Object.values(entries).forEach((e) => assert.ok(!('dirtyAt' in e), '清 dirty 時 dirtyAt 一併移除'));

  // 本輪沒用完額度，不排 continue。
  assert.ok(!env.alarms.calls.some((c) => c.op === 'create' && c.info && c.info.when === T0 + 30000), '不應排 continue');
});

// ============================================================================
// DC3 — apply 失敗:游標不前進、後續批不送
// ============================================================================

test('DC3 links 第二批落地撞 storage_quota:cursor 停在第一批、第三批與續拉都不送、marks 整條不跑', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: dirtyHistory(120),
    blocklist: dirtyBlocklist(3, 5000),
    handlers: goldenHandlers(),
    // 第一次 history 寫入照常，之後(含收緊重試)一律撞配額。
    failWrite: (key, n) => key === 'history' && n >= 2,
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const links = env.posts(LINKS_PATH);
  assert.equal(links.length, 2, '第二批落地失敗，第三批與續拉都不得送出');
  assert.deepEqual(links.map((r) => r.body.since), ['c0', 'c1']);
  assert.equal(env.posts(MARKS_SYNC_PATH).length, 0, 'links 失敗整輪收手，marks 不跑');
  const state = env.syncState();
  assert.equal(state.cursor, 'c1', '第二批沒落地，游標停在第一批的回應');
  assert.equal(state.marksCursor, 'm0');
  assert.equal(state.lastError, 'storage_quota');
  assert.equal(env.local.history.filter((e) => e.dirty === true).length, 70, '只有第一批 ack 落地');
});

test('DC3 marks 第二批落地撞 storage_quota:marksCursor 停在第一批、續拉不送', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: [],
    blocklist: dirtyBlocklist(60, 5000),
    handlers: {
      [LINKS_PATH]: [() => ({ cursor: 'c1', applied: {}, changes: { links: [], deleted: [], hasMore: false } })],
      [MARKS_SYNC_PATH]: goldenHandlers()[MARKS_SYNC_PATH],
    },
    failWrite: (key, n) => key === 'scamBlocklist' && n >= 2,
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const marks = env.posts(MARKS_SYNC_PATH);
  assert.equal(marks.length, 2, '第二批落地失敗，續拉不得送出');
  assert.deepEqual(marks.map((r) => r.body.since), ['m0', 'm1']);
  const state = env.syncState();
  assert.equal(state.marksCursor, 'm1', '第二批沒落地，marksCursor 停在第一批的回應');
  assert.equal(state.cursor, 'c1', 'links 那一段已落地，游標照常前進');
  assert.equal(state.lastError, 'storage_quota');
  const dirty = Object.values(env.local.scamBlocklist.entries).filter((e) => e.dirty === true).length;
  assert.equal(dirty, 10, '只有第一批 50 筆的 ack 落地');
});

// ============================================================================
// DC4 — device 區塊只掛 links 首個 POST
// ============================================================================

test('DC4 links 首個 POST 帶 device、後續批與續拉不帶；marks 一律不帶', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: dirtyHistory(120), blocklist: dirtyBlocklist(60, 5000), handlers: goldenHandlers() });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const links = env.posts(LINKS_PATH);
  assert.equal(links.length, 5);
  assert.deepEqual(links[0].body.device, DEVICE, '首個 POST 帶完整 device 區塊');
  links.slice(1).forEach((r, i) => assert.ok(!('device' in r.body), `links 第 ${i + 2} 個 POST 不得帶 device`));
  const marks = env.posts(MARKS_SYNC_PATH);
  assert.equal(marks.length, 5);
  marks.forEach((r, i) => assert.ok(!('device' in r.body), `marks 第 ${i + 1} 個 POST 不得帶 device`));
});

test('DC4 links 首批只有空推時照樣掛 device，續拉不掛', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: [],
    handlers: {
      [LINKS_PATH]: [
        () => ({ cursor: 'c1', applied: {}, changes: { links: [], deleted: [], hasMore: true } }),
        () => ({ cursor: 'c2', applied: {}, changes: { links: [], deleted: [], hasMore: false } }),
      ],
      [MARKS_SYNC_PATH]: [() => ({ cursor: 'm1', applied: {}, changes: { marks: [], deleted: [], hasMore: false } })],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const links = env.posts(LINKS_PATH);
  assert.equal(links.length, 2);
  assert.deepEqual(links[0].body, { upserts: [], deletes: [], since: 'c0', device: DEVICE });
  assert.deepEqual(links[1].body, { since: 'c1' }, '續拉 body 只有 since');
  assert.deepEqual(env.posts(MARKS_SYNC_PATH)[0].body, { upserts: [], deletes: [], since: 'm0' });
});

test('DC4 沒有本機裝置身分時 links 不掛 device 區塊', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ device: false, history: dirtyHistory(2), handlers: goldenHandlers() });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();
  env.posts(LINKS_PATH).forEach((r) => assert.ok(!('device' in r.body)));
});

// ============================================================================
// DC5 — sinceWhenNone
// ============================================================================

test("DC5 沒有游標:links 送 since:'0'，marks 不帶 since；拿到游標後續拉照常帶", async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    syncState: { cursor: null, marksCursor: null },
    history: [],
    blocklist: dirtyBlocklist(2, 5000),
    handlers: {
      [LINKS_PATH]: [
        () => ({ cursor: 'c1', applied: {}, changes: { links: [], deleted: [], hasMore: true } }),
        () => ({ cursor: 'c2', applied: {}, changes: { links: [], deleted: [], hasMore: false } }),
      ],
      [MARKS_SYNC_PATH]: [
        (body) => ({ cursor: 'm1', applied: ackAllMarks(body), changes: null }),
        () => ({ cursor: 'm2', applied: {}, changes: { marks: [], deleted: [], hasMore: false } }),
      ],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const links = env.posts(LINKS_PATH);
  assert.equal(links[0].body.since, '0', "links 沒有游標送 '0'");
  assert.equal(links[1].body.since, 'c1');
  // 回填(GET)回空頁且不帶 cursor:marksCursor 維持 null，第一個 POST 不帶 since。
  assert.equal(env.requests.filter((r) => r.method === 'GET' && r.path === MARKS_LIST_PATH).length, 1);
  const marks = env.posts(MARKS_SYNC_PATH);
  assert.equal(marks.length, 1, 'changes 為 null 時沒有續拉');
  assert.ok(!('since' in marks[0].body), 'marks 沒有游標時 body 不帶 since 鍵');
  assert.equal(env.syncState().marksCursor, 'm1', '回應的 cursor 照樣寫回');
  assert.equal(Object.values(env.local.scamBlocklist.entries).filter((e) => e.dirty === true).length, 0);
});

test('DC5 marks 沒有游標且回應也不給 cursor 時，續拉同樣不帶 since', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    syncState: { marksCursor: null },
    history: [],
    handlers: {
      [LINKS_PATH]: [() => ({ cursor: 'c1', applied: {}, changes: { links: [], deleted: [], hasMore: false } })],
      [MARKS_SYNC_PATH]: [
        () => ({ applied: {}, changes: { marks: [], deleted: [], hasMore: true } }),
        () => ({ cursor: 'm2', applied: {}, changes: { marks: [], deleted: [], hasMore: false } }),
      ],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const marks = env.posts(MARKS_SYNC_PATH);
  assert.equal(marks.length, 2);
  assert.deepEqual(marks[0].body, { upserts: [], deletes: [] });
  assert.deepEqual(marks[1].body, { upserts: [], deletes: [] }, '續拉沿用空批形狀，沒有游標就不帶 since');
  assert.equal(env.syncState().marksCursor, 'm2');
});

// ============================================================================
// DC6 — takeCall 在每個 POST 與續拉前檢查
// ============================================================================

function forever(prefix, extra) {
  return (body, n) => Object.assign({ cursor: `${prefix}${n}`, applied: {} }, extra(body, n));
}

function continueScheduled(env) {
  return env.alarms.calls.some((c) => c.op === 'create' && c.info && c.info.when === T0 + 30000);
}

test('DC6 links 續拉吃滿本輪額度(12 個 POST):第 13 個不發、marks 不發、exhausted 排 continue', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: dirtyHistory(120),
    blocklist: dirtyBlocklist(3, 5000),
    handlers: {
      [LINKS_PATH]: [forever('c', (body) => ({ changes: { links: [], deleted: [], hasMore: true }, applied: ackAllLinks(body || {}) }))],
      [MARKS_SYNC_PATH]: [forever('m', () => ({ changes: { marks: [], deleted: [], hasMore: false } }))],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  const links = env.posts(LINKS_PATH);
  assert.equal(links.length, 12, '3 批推＋9 頁續拉，額度 12 用完即停');
  assert.equal(links.filter((r) => Array.isArray(r.body.upserts)).length, 3);
  assert.equal(env.posts(MARKS_SYNC_PATH).length, 0, '額度用完，marks 的每一批前檢查都擋下');
  assert.equal(env.syncState().cursor, 'c12', '最後一頁落地後的游標');
  assert.ok(continueScheduled(env), 'exhausted 時排 continue 續跑');
  assert.equal(Object.values(env.local.scamBlocklist.entries).filter((e) => e.dirty === true).length, 3, 'marks 沒送出的維持 dirty');
});

test('DC6 marks 推到一半額度用完:沒送的批維持 dirty、續拉不發、exhausted', async () => {
  const TCLSync = loadSync();
  // links 用掉 11 個(1 批＋10 頁)，marks 只剩 1 個額度:第一批送出、第二批被擋。
  const env = makeEnv({
    history: [],
    blocklist: dirtyBlocklist(60, 5000),
    handlers: {
      [LINKS_PATH]: [forever('c', (body, n) => ({ changes: { links: [], deleted: [], hasMore: n < 11 } }))],
      [MARKS_SYNC_PATH]: [forever('m', (body) => ({ applied: ackAllMarks(body), changes: { marks: [], deleted: [], hasMore: true } }))],
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  assert.equal(env.posts(LINKS_PATH).length, 11);
  const marks = env.posts(MARKS_SYNC_PATH);
  assert.equal(marks.length, 1, '第二批與續拉都被額度擋下');
  assert.equal(marks[0].body.upserts.length, 50);
  assert.equal(env.syncState().marksCursor, 'm1');
  assert.equal(Object.values(env.local.scamBlocklist.entries).filter((e) => e.dirty === true).length, 10);
  assert.ok(continueScheduled(env));
});

test('DC6 本輪期限在批與批之間用完:下一批前的檢查擋下，不再發任何 POST', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: dirtyHistory(120),
    blocklist: dirtyBlocklist(3, 5000),
    handlers: goldenHandlers(),
    // 第二批送出時把時鐘推到期限邊上:之後任何請求都等不滿一次 CALL_TIMEOUT_MS。
    onRequest: (record, n, clock) => {
      if (record.path === LINKS_PATH && n === 2) clock.t += 12 * 30000;
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  assert.equal(env.posts(LINKS_PATH).length, 2, '第三批前的期限檢查擋下');
  assert.equal(env.posts(MARKS_SYNC_PATH).length, 0);
  assert.equal(env.syncState().cursor, 'c2', '已送出的第二批照常落地前進');
  assert.ok(env.alarms.calls.some((c) => c.op === 'create' && c.info && typeof c.info.when === 'number' && c.info.when === env.clock.t + 30000), 'exhausted 時排 continue');
});

test('DC6 續拉前的期限檢查:最後一批回 hasMore 但期限已到，不續拉', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({
    history: dirtyHistory(2),
    handlers: {
      [LINKS_PATH]: [(body) => ({ cursor: 'c1', applied: ackAllLinks(body), changes: { links: [], deleted: [], hasMore: true } })],
    },
    // 首批送出時把時鐘推到期限邊上:回應照常落地，續拉前的檢查擋下。
    onRequest: (record, n, clock) => {
      if (record.path === LINKS_PATH && n === 1) clock.t += 12 * 30000;
    },
  });
  const engine = TCLSync.create(env.deps);
  await engine.syncNow();

  assert.equal(env.posts(LINKS_PATH).length, 1, 'hasMore 但期限已到，續拉被擋');
  assert.equal(env.posts(MARKS_SYNC_PATH).length, 0);
  assert.equal(env.syncState().cursor, 'c1');
  assert.equal(env.local.history.filter((e) => e.dirty === true).length, 0);
});

// ============================================================================
// DC7 — tick 漂移護欄
// ============================================================================

// 引擎改成 async 函式後，await 會多出微任務，但 storage 的每一次讀寫仍是一個
// setImmediate 輪次。這裡不 await syncNow，只給定數量的 setImmediate 輪次，斷
// 言整輪(links 推拉＋marks 推拉＋收尾 saveState)在輪次內跑完：改寫若多塞了
// 巨集任務等待，這裡會先紅。輪次上限沿用 test/sync-marks.test.js 的 settle 預設
// (24)的倍數；wave-2 現況實測：小規模 12 輪、golden 規模 28 輪。
async function settleRounds(rounds, done) {
  for (let i = 0; i < rounds; i += 1) {
    if (done()) return i;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return done() ? rounds : -1;
}

function makeMockEnv(opts) {
  const clock = { t: T0 };
  const now = () => clock.t;
  const server = createMockSyncServer({ now });
  const token = server.grantToken('tok-seeded');
  const log = [];
  const storage = createSyncStorage(
    {
      syncAuth: { token },
      syncState: signedInState({ cursor: '0', marksCursor: null }),
      history: opts.history,
      scamBlocklist: opts.blocklist,
    },
    log
  );
  const alarms = createAlarmsMock();
  const deps = {
    storage: storage.api,
    fetch: server.fetch,
    now,
    alarms: alarms.api,
    broadcast: () => {},
    auth: {},
    permissions: { contains: () => Promise.resolve(true), request: () => Promise.resolve(true) },
    randomUUID: () => 'uuid-x',
    setTimeout: (fn, ms) => ({ fn, ms }),
    clearTimeout: () => {},
    writeChain: (fn) => Promise.resolve().then(fn),
    getLocalDevice: () => Promise.resolve(Object.assign({}, DEVICE)),
  };
  return { server, storage, deps, log };
}

test('DC7 tick 漂移護欄:links＋marks 各一批的一輪在 settle(24) 的輪次內跑完', async () => {
  const TCLSync = loadSync();
  const env = makeMockEnv({ history: dirtyHistory(3), blocklist: dirtyBlocklist(3, 5000) });
  const engine = TCLSync.create(env.deps);
  let finished = false;
  engine.syncNow().then(() => {
    finished = true;
  });
  const used = await settleRounds(24, () => finished);
  assert.notEqual(used, -1, '一輪同步應在 24 個 setImmediate 輪次內跑完');
  assert.equal(env.server.requestsTo(LINKS_PATH, 'POST').length, 1);
  assert.equal(env.server.requestsTo(MARKS_SYNC_PATH, 'POST').length, 1);
  assert.equal(env.storage.localData.syncState.lastError, null);
  assert.equal(env.storage.localData.history.filter((e) => e.dirty === true).length, 0);
});

test('DC7 tick 漂移護欄:golden 規模(links 5 往返＋marks 5 往返)在 settle(24)×2 的輪次內跑完', async () => {
  const TCLSync = loadSync();
  const env = makeEnv({ history: dirtyHistory(120), blocklist: dirtyBlocklist(60, 5000), handlers: goldenHandlers() });
  const engine = TCLSync.create(env.deps);
  let finished = false;
  engine.syncNow().then(() => {
    finished = true;
  });
  const used = await settleRounds(48, () => finished);
  assert.notEqual(used, -1, '十個往返的一輪應在 48 個 setImmediate 輪次內跑完');
  assert.equal(env.requests.length, 10);
});
