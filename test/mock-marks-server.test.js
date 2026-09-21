// test/mock-marks-server.test.js — 假後端 test/helpers/mock-sync-server.js 的警示
// 名單（marks）同步端點契約，紅燈先行。
//
// 契約由 PM 凍結（含 R1 修訂），形狀由本檔逐條釘死。
//
// ============================================================================
// 本檔釘定的擴充
// ============================================================================
// - `POST /api/v1/marks/sync` body `{ upserts:[mark], deletes:[key], since?, cursor? }`
//   → 200 `{ cursor, applied, changes, evicted }`：
//   - `cursor` 恆回一個不透明字串；
//   - `applied` ＝ `{ upserts:[key], rejectedIds:[key], deletedIds:[key] }`
//     （子欄位沿用 links 命名，值是 key 字串）。`rejectedIds` 三種來源：整筆驗
//     證不過、同批被 delete 撞掉、比墓碑舊不復活；
//   - `changes` ＝ `null`（沒帶 `since`／`cursor` 時，首次回填走 GET）或
//     `{ marks:[mark], deleted:[{key, deletedAt}], hasMore }`，單頁 200 筆；
//   - `evicted` ＝ 這一輪因配額被淘汰的筆數。
// - `GET /api/v1/marks?since=&cursor=&limit=` → 200 `{ items, nextCursor }`，
//   依 `updatedAt` 升冪分頁，`limit` 預設 50、上限 100。
// - mark 固定九欄：`key`、`state`、`dismissedAt`、`handle`、`displayName`、
//   `source`、`evidence`、`addedAt`、`updatedAt`，可空者輸出 `null`。
//   驗證：`key` `^threads:\d{1,20}$`、`state` `active|dismissed`、
//   `handle` `^[A-Za-z0-9._]{1,80}$`、`addedAt`／`updatedAt` 必填有限數字，
//   任一不符整筆退回 `rejectedIds`；`displayName` 超過 80 截斷、缺席回 null；
//   `dismissedAt` 在 active 狀態一律回 null；`source` 非枚舉退回 auto 不 reject。
// - evidence 固定七欄：`anchorPostUrl`、`threadUrl`、`signals`、`at`、
//   `postedAt`、`rulesVersion`、`deviceId`，可空者輸出 `null`（`signals` 為清
//   單，沒有訊號時是空陣列）。`anchorPostUrl`（Threads 貼文網址）與 `at` 缺一
//   即丟該筆證據；`snippet`／`anchorMatch`／`postUrl` 一律不收，有帶即剝除。
// - 合併：純量 LWW by `updatedAt`（大者勝，相等以伺服器既有為準）；evidence 以
//   `anchorPostUrl` 去重取聯集、依 `at` 降冪留 3；dismissed 保留 evidence。
//   既有列更新時 `addedAt` 由伺服器保管，傳入值一律忽略（但仍須合法，不合法整
//   筆 reject）；新建列與墓碑後復活的列才採用傳入的 `addedAt`。
// - 配額：free 方案滿額時依 `updatedAt` 最舊淘汰且**不寫墓碑**；pro 無上限。
// - 墓碑保留 90 天，超過後不再出現在 `changes.deleted`。
// - 守門沿用 links：Content-Type 早於解析 body、Bearer 未登入 401、批次上限、
//   per-user 限流桶共用。
//
// 備註：批次上限沿用 links 的 50 筆與 422，錯誤碼另立
// `too_many_mark_upserts`／`too_many_mark_deletes`，與連結那邊分得開。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMockSyncServer,
  MAX_SYNC_UPSERTS,
  MAX_SYNC_DELETES,
  CHANGES_LIMIT,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  RATE_LIMIT_MAX,
  MARK_EVIDENCE_MAX,
  MARK_DISPLAY_NAME_MAX,
  MARK_TOMBSTONE_TTL_MS,
} = require('./helpers/mock-sync-server.js');

const BASE = 'https://api.metalinkclearer.workers.dev';
const T0 = 1_700_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const KEY_A = 'threads:1000001';
const KEY_B = 'threads:1000002';
const KEY_C = 'threads:1000003';

const MARK_FIELDS = [
  'addedAt',
  'dismissedAt',
  'displayName',
  'evidence',
  'handle',
  'key',
  'source',
  'state',
  'updatedAt',
];
const EVIDENCE_FIELDS = [
  'anchorPostUrl',
  'at',
  'deviceId',
  'postedAt',
  'rulesVersion',
  'signals',
  'threadUrl',
];

function postUrl(handle, code) {
  return `https://www.threads.com/@${handle}/post/${code}`;
}

function evidenceOf(overrides = {}) {
  return Object.assign(
    {
      anchorPostUrl: postUrl('alice.scam', 'AAAAAAAAAAA'),
      threadUrl: postUrl('alice.scam', 'BBBBBBBBBBB'),
      signals: ['link', 'line'],
      at: T0,
    },
    overrides
  );
}

function markOf(overrides = {}) {
  return Object.assign(
    {
      key: KEY_A,
      state: 'active',
      handle: 'alice.scam',
      displayName: 'Alice',
      source: 'auto',
      addedAt: T0,
      updatedAt: T0,
      evidence: [evidenceOf()],
    },
    overrides
  );
}

/**
 * 一台已登入的假後端 ＋ 可控時鐘 ＋ 警示名單端點的呼叫捷徑。
 * 時間一律由 `at` 驅動（mock 的 `now` 注入），墓碑 90 天過期靠它推進。
 */
function harness(options = {}) {
  const clock = { at: options.startAt === undefined ? T0 : options.startAt };
  const server = createMockSyncServer(Object.assign({ now: () => clock.at }, options.server));
  const token = server.grantToken();

  function call(method, path, opts = {}) {
    const init = { method, headers: {} };
    const useToken = Object.prototype.hasOwnProperty.call(opts, 'token') ? opts.token : token;
    if (useToken !== null) init.headers.authorization = `Bearer ${useToken}`;
    if (opts.rawBody !== undefined) {
      init.body = opts.rawBody;
      init.headers['content-type'] = opts.contentType || 'application/json';
    } else if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      init.headers['content-type'] = opts.contentType || 'application/json';
    } else if (opts.contentType) {
      init.headers['content-type'] = opts.contentType;
    }
    return server.fetch(`${BASE}${path}`, init);
  }

  return {
    server,
    token,
    clock,
    call,
    advance(ms) {
      clock.at += ms;
      return clock.at;
    },
    sync(body, opts) {
      return call('POST', '/api/v1/marks/sync', Object.assign({ body }, opts));
    },
    list(query, opts) {
      return call('GET', `/api/v1/marks${query || ''}`, opts);
    },
    async syncJson(body, opts) {
      const res = await this.sync(body, opts);
      return { res, body: await res.json() };
    },
    async listJson(query, opts) {
      const res = await this.list(query, opts);
      return { res, body: await res.json() };
    },
    /** 上傳一批 upsert 並回傳回應 body，省掉每個測試三行樣板。 */
    async push(marks, extra = {}) {
      const { res, body } = await this.syncJson(Object.assign({ upserts: marks, deletes: [] }, extra));
      assert.equal(res.status, 200, `upsert 應成功，實得 ${res.status}`);
      return body;
    },
  };
}

// 端點未實作時 byKey 會回 null；先斷言存在，讓失敗停在斷言而不是 TypeError。
function requireMark(h, key) {
  const mark = h.server.marks.byKey(key);
  assert.notEqual(mark, null, `警示 ${key} 應存在於伺服器`);
  return mark;
}

// ============================================================================
// POST /api/v1/marks/sync — 守門
// ============================================================================

test('marks sync：無 bearer 回 401 unauthorized', async () => {
  const h = harness();
  const res = await h.sync({ upserts: [markOf()], deletes: [] }, { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('marks sync：Content-Type 守門早於解析 body，非 JSON 回 415', async () => {
  const h = harness();
  const res = await h.sync({ upserts: [], deletes: [] }, { contentType: 'text/plain' });
  assert.equal(res.status, 415);
  assert.deepEqual(await res.json(), { error: 'unsupported_media_type' });
});

test('marks sync：body 非物件回 400 bad_request', async () => {
  const h = harness();
  const res = await h.sync(undefined, { rawBody: '[]' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_request' });
});

test('marks sync：upserts 超過批次上限回 422 too_many_mark_upserts', async () => {
  const h = harness();
  const upserts = [];
  for (let i = 0; i <= MAX_SYNC_UPSERTS; i += 1) {
    upserts.push(markOf({ key: `threads:200${String(i).padStart(4, '0')}` }));
  }
  const res = await h.sync({ upserts, deletes: [] });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'too_many_mark_upserts', max: MAX_SYNC_UPSERTS });
});

test('marks sync：deletes 超過批次上限回 422 too_many_mark_deletes', async () => {
  const h = harness();
  const deletes = [];
  for (let i = 0; i <= MAX_SYNC_DELETES; i += 1) deletes.push(`threads:300${String(i).padStart(4, '0')}`);
  const res = await h.sync({ upserts: [], deletes });
  assert.equal(res.status, 422);
  assert.deepEqual(await res.json(), { error: 'too_many_mark_deletes', max: MAX_SYNC_DELETES });
});

test('marks sync：壞 since 回 400 bad_since', async () => {
  const h = harness();
  const res = await h.sync({ upserts: [], deletes: [], since: 'not-a-cursor' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_since' });
});

test('marks sync：壞 cursor 回 400 bad_cursor', async () => {
  const h = harness();
  const res = await h.sync({ upserts: [], deletes: [], cursor: 'nope' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_cursor' });
});

test('marks sync：與 links 共用同一個 per-user 限流桶', async () => {
  const h = harness();
  for (let i = 0; i < RATE_LIMIT_MAX - 1; i += 1) {
    const res = await h.call('POST', '/api/v1/links/sync', { body: { upserts: [], deletes: [] } });
    assert.equal(res.status, 200);
  }
  const ok = await h.sync({ upserts: [], deletes: [] });
  assert.equal(ok.status, 200, '第 60 次仍在額度內');
  const limited = await h.sync({ upserts: [], deletes: [] });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
});

// ============================================================================
// POST /api/v1/marks/sync — 驗證與剝欄
// ============================================================================

test('marks sync：合法 mark 原樣落地，applied 帶回 key、cursor 恆回', async () => {
  const h = harness();
  const body = await h.push([markOf()]);
  assert.deepEqual(body.applied, { upserts: [KEY_A], rejectedIds: [], deletedIds: [] });
  assert.equal(body.evicted, 0);
  assert.equal(typeof body.cursor, 'string');
  assert.deepEqual(requireMark(h, KEY_A), {
    key: KEY_A,
    state: 'active',
    dismissedAt: null,
    handle: 'alice.scam',
    displayName: 'Alice',
    source: 'auto',
    evidence: [
      {
        anchorPostUrl: postUrl('alice.scam', 'AAAAAAAAAAA'),
        threadUrl: postUrl('alice.scam', 'BBBBBBBBBBB'),
        signals: ['link', 'line'],
        at: T0,
        postedAt: null,
        rulesVersion: null,
        deviceId: null,
      },
    ],
    addedAt: T0,
    updatedAt: T0,
  });
});

test('marks sync：mark 固定九欄，可空者輸出 null', async () => {
  const h = harness();
  await h.push([markOf({ displayName: undefined, evidence: [] })]);
  const mark = requireMark(h, KEY_A);
  assert.deepEqual(Object.keys(mark).sort(), MARK_FIELDS);
  assert.equal(mark.displayName, null);
  assert.equal(mark.dismissedAt, null);
  assert.deepEqual(mark.evidence, []);
});

test('marks sync：evidence 固定七欄，可空者輸出 null', async () => {
  const h = harness();
  await h.push([markOf({ evidence: [evidenceOf({ threadUrl: undefined, signals: undefined })] })]);
  const [evidence] = requireMark(h, KEY_A).evidence;
  assert.deepEqual(Object.keys(evidence).sort(), EVIDENCE_FIELDS);
  assert.equal(evidence.threadUrl, null);
  assert.equal(evidence.postedAt, null);
  assert.equal(evidence.rulesVersion, null);
  assert.equal(evidence.deviceId, null);
  assert.deepEqual(evidence.signals, [], 'signals 是清單，沒訊號時是空陣列');
});

test('marks sync：回上來的 null 欄位視同缺席，不會被當成髒值擋掉整筆', async () => {
  const h = harness();
  await h.push([
    markOf({
      displayName: null,
      dismissedAt: null,
      evidence: [evidenceOf({ threadUrl: null, postedAt: null, rulesVersion: null, deviceId: null })],
    }),
  ]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.displayName, null);
  assert.equal(mark.evidence.length, 1);
});

test('marks sync：key 形狀不符整筆退回 rejectedIds，不擋同批合法項', async () => {
  const h = harness();
  const bad = ['threads:abc', '1000001', 'threads:', `threads:${'9'.repeat(21)}`, 'instagram:1000001'];
  const upserts = bad.map((key) => markOf({ key })).concat([markOf({ key: KEY_B })]);
  const body = await h.push(upserts);
  assert.deepEqual(body.applied, { upserts: [KEY_B], rejectedIds: bad, deletedIds: [] });
  assert.deepEqual(
    h.server.marks.snapshot().map((m) => m.key),
    [KEY_B]
  );
});

test('marks sync：state／handle／addedAt／updatedAt 不合法同樣退回 rejectedIds', async () => {
  const h = harness();
  const body = await h.push([
    markOf({ key: KEY_A, state: 'blocked' }),
    markOf({ key: KEY_B, handle: 'alice scam' }),
    markOf({ key: KEY_C, updatedAt: Number.POSITIVE_INFINITY }),
    markOf({ key: 'threads:1000004', addedAt: '1700000000000' }),
  ]);
  assert.deepEqual(body.applied.rejectedIds, [KEY_A, KEY_B, KEY_C, 'threads:1000004']);
  assert.deepEqual(body.applied.upserts, []);
  assert.deepEqual(h.server.marks.snapshot(), []);
});

test('marks sync：同一個壞 key 在同批出現多次，rejectedIds 只列一次', async () => {
  const h = harness();
  const body = await h.push([markOf({ state: 'blocked' }), markOf({ handle: 'bad handle' })]);
  assert.deepEqual(body.applied.rejectedIds, [KEY_A]);
});

test('marks sync：key 不是字串時無從回報，整筆丟掉且不進 rejectedIds', async () => {
  const h = harness();
  const body = await h.push([null, {}, markOf({ key: 12345 }), markOf({ key: KEY_B })]);
  assert.deepEqual(body.applied, { upserts: [KEY_B], rejectedIds: [], deletedIds: [] });
});

test('marks sync：state 不在枚舉內整筆不落地', async () => {
  const h = harness();
  await h.push([markOf({ state: 'blocked' }), markOf({ key: KEY_B, state: 'dismissed' })]);
  assert.equal(h.server.marks.byKey(KEY_A), null);
  assert.equal(requireMark(h, KEY_B).state, 'dismissed');
});

test('marks sync：handle 不符形狀整筆不落地', async () => {
  const h = harness();
  await h.push([
    markOf({ handle: 'alice scam' }),
    markOf({ key: KEY_B, handle: '' }),
    markOf({ key: KEY_C, handle: 'a'.repeat(81) }),
  ]);
  assert.deepEqual(h.server.marks.snapshot(), []);
});

test('marks sync：addedAt／updatedAt 非有限數字整筆不落地', async () => {
  const h = harness();
  await h.push([
    markOf({ addedAt: '1700000000000' }),
    markOf({ key: KEY_B, updatedAt: Number.POSITIVE_INFINITY }),
    markOf({ key: KEY_C, updatedAt: undefined }),
  ]);
  assert.deepEqual(h.server.marks.snapshot(), []);
});

test('marks sync：displayName 超過上限截斷，整筆照留', async () => {
  const h = harness();
  await h.push([markOf({ displayName: '字'.repeat(MARK_DISPLAY_NAME_MAX + 10) })]);
  assert.equal(Array.from(requireMark(h, KEY_A).displayName).length, MARK_DISPLAY_NAME_MAX);
});

test('marks sync：source 不在枚舉內退回 auto', async () => {
  const h = harness();
  await h.push([markOf({ source: 'imported' }), markOf({ key: KEY_B, source: 'manual' })]);
  assert.equal(requireMark(h, KEY_A).source, 'auto');
  assert.equal(requireMark(h, KEY_B).source, 'manual');
});

test('marks sync：dismissedAt 有限數字留存，髒值只剝該欄', async () => {
  const h = harness();
  await h.push([
    markOf({ state: 'dismissed', dismissedAt: T0 + MINUTE }),
    markOf({ key: KEY_B, state: 'dismissed', dismissedAt: 'later' }),
  ]);
  assert.equal(requireMark(h, KEY_A).dismissedAt, T0 + MINUTE);
  assert.equal(requireMark(h, KEY_B).dismissedAt, null, '髒值輸出 null，不補 0');
});

test('marks sync：active 狀態的 dismissedAt 一律回 null', async () => {
  const h = harness();
  await h.push([markOf({ state: 'active', dismissedAt: T0 + MINUTE })]);
  assert.equal(requireMark(h, KEY_A).dismissedAt, null, '沒解除封鎖就不該有解除時間');

  // 解除後再重新掛上（active 且 updatedAt 較新）：舊的解除時間不得殘留。
  await h.push([markOf({ state: 'dismissed', dismissedAt: T0 + MINUTE, updatedAt: T0 + MINUTE })]);
  assert.equal(requireMark(h, KEY_A).dismissedAt, T0 + MINUTE);
  await h.push([markOf({ state: 'active', updatedAt: T0 + 2 * MINUTE })]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.state, 'active');
  assert.equal(mark.dismissedAt, null);
});

test('marks sync：signals 輸入 null 或缺席一律視為空陣列', async () => {
  const h = harness();
  await h.push([
    markOf({ evidence: [evidenceOf({ signals: null })] }),
    markOf({ key: KEY_B, evidence: [evidenceOf({ signals: 'link' })] }),
  ]);
  assert.deepEqual(requireMark(h, KEY_A).evidence[0].signals, []);
  assert.deepEqual(requireMark(h, KEY_B).evidence[0].signals, []);
});

test('marks sync：mark 的未知欄位不留存', async () => {
  const h = harness();
  await h.push([markOf({ snippet: '加我賴', anchorMatch: 'lin.ee/x', postUrl: postUrl('alice.scam', 'CCCCCCCCCCC') })]);
  assert.deepEqual(Object.keys(requireMark(h, KEY_A)).sort(), MARK_FIELDS);
});

test('marks sync：evidence 的 snippet／anchorMatch／postUrl 有帶即剝除', async () => {
  const h = harness();
  await h.push([
    markOf({
      evidence: [
        evidenceOf({
          snippet: '想賺錢加我賴',
          anchorMatch: 'lin.ee/abc',
          postUrl: postUrl('alice.scam', 'CCCCCCCCCCC'),
          postedAt: T0 - MINUTE,
          rulesVersion: 3,
          deviceId: 'device-1',
        }),
      ],
    }),
  ]);
  const [evidence] = requireMark(h, KEY_A).evidence;
  assert.deepEqual(Object.keys(evidence).sort(), EVIDENCE_FIELDS);
  assert.equal(evidence.postedAt, T0 - MINUTE);
  assert.equal(evidence.rulesVersion, 3);
  assert.equal(evidence.deviceId, 'device-1');
});

test('marks sync：evidence 缺 anchorPostUrl 或 at 只丟該筆，mark 照留', async () => {
  const h = harness();
  await h.push([
    markOf({
      evidence: [
        evidenceOf({ anchorPostUrl: undefined }),
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'DDDDDDDDDDD'), at: 'now' }),
        evidenceOf({ anchorPostUrl: 'https://evil.example.com/@alice.scam/post/EEEEEEEEEEE' }),
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'FFFFFFFFFFF'), at: T0 + MINUTE }),
      ],
    }),
  ]);
  assert.deepEqual(
    requireMark(h, KEY_A).evidence.map((e) => e.anchorPostUrl),
    [postUrl('alice.scam', 'FFFFFFFFFFF')]
  );
});

test('marks sync：evidence 非陣列時退成空陣列，mark 照留', async () => {
  const h = harness();
  await h.push([markOf({ evidence: 'nope' })]);
  assert.deepEqual(requireMark(h, KEY_A).evidence, []);
});

test('marks sync：signals 白名單外剝除，全剝光時輸出空陣列', async () => {
  const h = harness();
  await h.push([
    markOf({ evidence: [evidenceOf({ signals: ['pitch', 'crypto', 'join', 'link'] })] }),
    markOf({ key: KEY_B, evidence: [evidenceOf({ signals: ['crypto'] })] }),
  ]);
  assert.deepEqual(requireMark(h, KEY_A).evidence[0].signals, ['link', 'join', 'pitch']);
  assert.deepEqual(requireMark(h, KEY_B).evidence[0].signals, []);
});

test('marks sync：單筆 upsert 的 evidence 超過上限，依 at 降冪留最新三筆', async () => {
  const h = harness();
  const evidence = [];
  for (let i = 0; i < MARK_EVIDENCE_MAX + 3; i += 1) {
    evidence.push(evidenceOf({ anchorPostUrl: postUrl('alice.scam', `POST${i}`), at: T0 + i * MINUTE }));
  }
  await h.push([markOf({ evidence })]);
  const kept = requireMark(h, KEY_A).evidence;
  assert.equal(kept.length, MARK_EVIDENCE_MAX);
  assert.deepEqual(
    kept.map((e) => e.at),
    [T0 + 5 * MINUTE, T0 + 4 * MINUTE, T0 + 3 * MINUTE]
  );
});

test('marks sync：rulesVersion 非數字、deviceId 非字串整欄剝除', async () => {
  const h = harness();
  await h.push([markOf({ evidence: [evidenceOf({ rulesVersion: 'v3', deviceId: 42 })] })]);
  const [evidence] = requireMark(h, KEY_A).evidence;
  assert.equal(evidence.rulesVersion, null);
  assert.equal(evidence.deviceId, null);
});

// ============================================================================
// POST /api/v1/marks/sync — LWW 與合併
// ============================================================================

test('marks sync：LWW — updatedAt 較大者覆蓋既有純量', async () => {
  const h = harness();
  await h.push([markOf()]);
  await h.push([markOf({ state: 'dismissed', handle: 'alice.new', displayName: 'Alice 2', updatedAt: T0 + MINUTE })]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.state, 'dismissed');
  assert.equal(mark.handle, 'alice.new');
  assert.equal(mark.displayName, 'Alice 2');
  assert.equal(mark.updatedAt, T0 + MINUTE);
  assert.equal(mark.addedAt, T0, 'addedAt 是首見時間，不隨新版往後跳');
});

test('marks sync：既有列更新時保留原 addedAt，忽略傳入值', async () => {
  const h = harness();
  await h.push([markOf({ addedAt: T0 })]);

  // 較晚的 addedAt 不得把首見時間往後推。
  await h.push([markOf({ addedAt: T0 + 5 * MINUTE, updatedAt: T0 + MINUTE })]);
  assert.equal(requireMark(h, KEY_A).addedAt, T0);

  // 較早的也不採信：伺服器上那一列才是權威，各裝置算出來的首見時間不互相覆蓋。
  await h.push([markOf({ addedAt: T0 - 5 * MINUTE, updatedAt: T0 + 2 * MINUTE })]);
  assert.equal(requireMark(h, KEY_A).addedAt, T0);
});

test('marks sync：新建列採用傳入的 addedAt', async () => {
  const h = harness();
  await h.push([markOf({ addedAt: T0 - DAY, updatedAt: T0 })]);
  assert.equal(requireMark(h, KEY_A).addedAt, T0 - DAY);
});

test('marks sync：更新既有列時 addedAt 不合法照樣整筆 reject', async () => {
  const h = harness();
  await h.push([markOf({ addedAt: T0 })]);
  const body = await h.push([markOf({ addedAt: null, state: 'dismissed', updatedAt: T0 + MINUTE })]);
  assert.deepEqual(body.applied, { upserts: [], rejectedIds: [KEY_A], deletedIds: [] });
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.addedAt, T0, '既有列原封不動');
  assert.equal(mark.state, 'active', '被 reject 的那一筆不得部分套用');
});

test('marks sync：墓碑後復活的列採用傳入的 addedAt', async () => {
  const h = harness();
  await h.push([markOf({ addedAt: T0 })]);
  await h.syncJson({ upserts: [], deletes: [KEY_A] });
  await h.push([markOf({ addedAt: T0 + 10 * MINUTE, updatedAt: T0 + 10 * MINUTE })]);
  assert.equal(requireMark(h, KEY_A).addedAt, T0 + 10 * MINUTE, '伺服器上已無原列，沒有可保管的首見時間');
});

test('marks sync：LWW — updatedAt 較小者不覆蓋', async () => {
  const h = harness();
  await h.push([markOf({ updatedAt: T0 + MINUTE })]);
  await h.push([markOf({ state: 'dismissed', handle: 'alice.old', updatedAt: T0 })]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.state, 'active');
  assert.equal(mark.handle, 'alice.scam');
  assert.equal(mark.updatedAt, T0 + MINUTE);
});

test('marks sync：LWW — updatedAt 相等以伺服器既有為準', async () => {
  const h = harness();
  await h.push([markOf()]);
  await h.push([markOf({ state: 'dismissed', handle: 'alice.tie', displayName: 'Tie' })]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.state, 'active');
  assert.equal(mark.handle, 'alice.scam');
  assert.equal(mark.displayName, 'Alice');
});

test('marks sync：同批同 key 先合併再套用，較新者的純量勝出', async () => {
  const h = harness();
  const body = await h.push([
    markOf({ handle: 'alice.older', updatedAt: T0 }),
    markOf({ handle: 'alice.newer', state: 'dismissed', updatedAt: T0 + MINUTE }),
  ]);
  assert.deepEqual(body.applied.upserts, [KEY_A], '同 key 只算一筆');
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.handle, 'alice.newer');
  assert.equal(mark.state, 'dismissed');
});

test('marks sync：evidence 取聯集，同一錨點貼文只留一筆', async () => {
  const h = harness();
  await h.push([markOf({ evidence: [evidenceOf({ at: T0 })] })]);
  await h.push([
    markOf({
      updatedAt: T0 + MINUTE,
      evidence: [
        evidenceOf({ at: T0 + MINUTE }),
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'GGGGGGGGGGG'), at: T0 + 2 * MINUTE }),
      ],
    }),
  ]);
  const evidence = requireMark(h, KEY_A).evidence;
  assert.equal(evidence.length, 2, '同 anchorPostUrl 去重，另一篇併入');
  assert.deepEqual(
    evidence.map((e) => e.anchorPostUrl),
    [postUrl('alice.scam', 'GGGGGGGGGGG'), postUrl('alice.scam', 'AAAAAAAAAAA')],
    '依 at 降冪'
  );
});

test('marks sync：合併後的 evidence 一樣只留最新三筆', async () => {
  const h = harness();
  await h.push([
    markOf({
      evidence: [
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'P1'), at: T0 + 1 }),
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'P2'), at: T0 + 2 }),
      ],
    }),
  ]);
  await h.push([
    markOf({
      updatedAt: T0 + MINUTE,
      evidence: [
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'P3'), at: T0 + 3 }),
        evidenceOf({ anchorPostUrl: postUrl('alice.scam', 'P4'), at: T0 + 4 }),
      ],
    }),
  ]);
  assert.deepEqual(
    requireMark(h, KEY_A).evidence.map((e) => e.anchorPostUrl),
    [postUrl('alice.scam', 'P4'), postUrl('alice.scam', 'P3'), postUrl('alice.scam', 'P2')]
  );
});

test('marks sync：轉為 dismissed 不清空既有 evidence', async () => {
  const h = harness();
  await h.push([markOf()]);
  await h.push([
    markOf({ state: 'dismissed', dismissedAt: T0 + MINUTE, updatedAt: T0 + MINUTE, evidence: [] }),
  ]);
  const mark = requireMark(h, KEY_A);
  assert.equal(mark.state, 'dismissed');
  assert.equal(mark.dismissedAt, T0 + MINUTE);
  assert.equal(mark.evidence.length, 1, 'dismissed 保留證據，解除封鎖時才看得到當初憑什麼掛');
});

// ============================================================================
// POST /api/v1/marks/sync — 刪除與墓碑
// ============================================================================

test('marks sync：刪除寫墓碑，changes.deleted 帶 key 與 deletedAt', async () => {
  const h = harness();
  await h.push([markOf()]);
  const { res, body } = await h.syncJson({ upserts: [], deletes: [KEY_A], since: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(body.applied, { upserts: [], rejectedIds: [], deletedIds: [KEY_A] });
  assert.equal(h.server.marks.byKey(KEY_A), null);
  assert.deepEqual(body.changes.marks, []);
  assert.equal(body.changes.deleted.length, 1);
  assert.equal(body.changes.deleted[0].key, KEY_A);
  assert.equal(typeof body.changes.deleted[0].deletedAt, 'number');
  assert.deepEqual(Object.keys(body.changes.deleted[0]).sort(), ['deletedAt', 'key']);
});

test('marks sync：同批 delete 撞 upsert，刪除勝且該 key 進 rejectedIds', async () => {
  const h = harness();
  const { res, body } = await h.syncJson({ upserts: [markOf()], deletes: [KEY_A], since: 0 });
  assert.equal(res.status, 200);
  assert.deepEqual(body.applied, { upserts: [], rejectedIds: [KEY_A], deletedIds: [KEY_A] });
  assert.equal(h.server.marks.byKey(KEY_A), null);
  assert.deepEqual(body.changes.marks, []);
  assert.deepEqual(
    body.changes.deleted.map((row) => row.key),
    [KEY_A]
  );
});

test('marks sync：刪除不存在的 key 照樣冪等成功', async () => {
  const h = harness();
  const { body } = await h.syncJson({ upserts: [], deletes: [KEY_C] });
  assert.deepEqual(body.applied.deletedIds, [KEY_C]);
  assert.equal(h.server.marks.byKey(KEY_C), null);
});

test('marks sync：墓碑之後較新的 upsert 復活，較舊的進 rejectedIds', async () => {
  const h = harness();
  h.server.marks.seedTombstone(KEY_A, T0);
  const rejected = await h.push([markOf({ updatedAt: T0 - MINUTE })]);
  assert.deepEqual(rejected.applied, { upserts: [], rejectedIds: [KEY_A], deletedIds: [] });
  assert.equal(h.server.marks.byKey(KEY_A), null, '比墓碑舊的版本不復活');

  const revived = await h.push([markOf({ updatedAt: T0 + MINUTE })]);
  assert.deepEqual(revived.applied.upserts, [KEY_A]);
  assert.equal(requireMark(h, KEY_A).updatedAt, T0 + MINUTE);
  assert.equal(h.server.marks.tombstoneCount(), 0, '復活後撤掉墓碑');
});

test('marks sync：墓碑超過保留期後不再出現在 changes', async () => {
  const h = harness();
  await h.push([markOf()]);
  await h.syncJson({ upserts: [], deletes: [KEY_A] });

  const fresh = (await h.syncJson({ upserts: [], deletes: [], since: 0 })).body;
  assert.equal(
    fresh.changes.deleted.some((row) => row.key === KEY_A),
    true
  );

  h.advance(MARK_TOMBSTONE_TTL_MS + DAY);
  const expired = (await h.syncJson({ upserts: [], deletes: [], since: 0 })).body;
  assert.deepEqual(expired.changes.deleted, []);
});

// ============================================================================
// POST /api/v1/marks/sync — 配額
// ============================================================================

test('marks sync：free 方案滿額時淘汰最舊的 updatedAt，evicted 回筆數且不寫墓碑', async () => {
  const h = harness({ server: { plan: 'free', marksQuota: 2 } });
  h.server.marks.seed([
    markOf({ key: KEY_A, updatedAt: T0 }),
    markOf({ key: KEY_B, updatedAt: T0 + MINUTE }),
  ]);
  const body = await h.push([markOf({ key: KEY_C, updatedAt: T0 + 2 * MINUTE })]);
  assert.equal(body.evicted, 1);
  assert.deepEqual(
    h.server.marks.snapshot().map((m) => m.key),
    [KEY_B, KEY_C]
  );
  assert.equal(h.server.marks.tombstoneCount(), 0, '淘汰不寫墓碑，別的裝置才不會跟著刪');
});

test('marks sync：pro 方案不淘汰', async () => {
  const h = harness({ server: { plan: 'pro', marksQuota: 2 } });
  h.server.marks.seed([markOf({ key: KEY_A }), markOf({ key: KEY_B })]);
  const body = await h.push([markOf({ key: KEY_C })]);
  assert.equal(body.evicted, 0);
  assert.equal(h.server.marks.count(), 3);
});

test('marks sync：setPlan 可在同一台伺服器上切換方案', async () => {
  const h = harness({ server: { plan: 'pro', marksQuota: 1 } });
  h.server.marks.seed([markOf({ key: KEY_A, updatedAt: T0 })]);
  await h.push([markOf({ key: KEY_B, updatedAt: T0 + MINUTE })]);
  assert.equal(h.server.marks.count(), 2);
  h.server.marks.setPlan('free');
  const body = await h.push([markOf({ key: KEY_C, updatedAt: T0 + 2 * MINUTE })]);
  assert.equal(body.evicted, 2);
  assert.deepEqual(
    h.server.marks.snapshot().map((m) => m.key),
    [KEY_C]
  );
});

// ============================================================================
// POST /api/v1/marks/sync — changes 與 cursor
// ============================================================================

test('marks sync：沒帶 since 與 cursor 時 changes 為 null，仍回 cursor', async () => {
  const h = harness();
  const body = await h.push([markOf()]);
  assert.equal(body.changes, null);
  assert.equal(typeof body.cursor, 'string');
});

test('marks sync：帶 since 回增量，cursor 可續傳且不重發舊資料', async () => {
  const h = harness();
  const first = (await h.syncJson({ upserts: [markOf()], deletes: [], since: 0 })).body;
  assert.deepEqual(
    first.changes.marks.map((row) => row.key),
    [KEY_A]
  );
  assert.equal(first.changes.hasMore, false);

  const second = (await h.syncJson({ upserts: [], deletes: [], cursor: first.cursor })).body;
  assert.deepEqual(second.changes, { marks: [], deleted: [], hasMore: false }, '同一個游標續傳不重發');

  const third = (await h.syncJson({ upserts: [markOf({ key: KEY_B })], deletes: [], cursor: second.cursor })).body;
  assert.deepEqual(
    third.changes.marks.map((row) => row.key),
    [KEY_B]
  );
});

test('marks sync：changes 單頁上限截斷時 hasMore 為真，游標續傳拿得到其餘', async () => {
  const h = harness();
  const seeds = [];
  for (let i = 0; i < CHANGES_LIMIT + 20; i += 1) {
    seeds.push(markOf({ key: `threads:40${String(i).padStart(5, '0')}`, updatedAt: T0 + i }));
  }
  h.server.marks.seed(seeds);

  const first = (await h.syncJson({ upserts: [], deletes: [], since: 0 })).body;
  assert.equal(first.changes.marks.length, CHANGES_LIMIT);
  assert.equal(first.changes.hasMore, true);

  const second = (await h.syncJson({ upserts: [], deletes: [], cursor: first.cursor })).body;
  assert.equal(second.changes.marks.length, 20);
  assert.equal(second.changes.hasMore, false);

  const firstKeys = new Set(first.changes.marks.map((row) => row.key));
  assert.equal(
    second.changes.marks.some((row) => firstKeys.has(row.key)),
    false,
    '兩頁不重疊'
  );
});

test('marks sync：changes.marks 帶完整 mark 形狀', async () => {
  const h = harness();
  const body = (await h.syncJson({ upserts: [markOf()], deletes: [], since: 0 })).body;
  assert.deepEqual(body.changes.marks, [requireMark(h, KEY_A)]);
});

// ============================================================================
// GET /api/v1/marks — 回填分頁
// ============================================================================

test('GET /api/v1/marks：無 bearer 回 401 unauthorized', async () => {
  const h = harness();
  const res = await h.list('', { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
});

test('GET /api/v1/marks：空清單回 items 空陣列與 nextCursor null', async () => {
  const h = harness();
  const { res, body } = await h.listJson();
  assert.equal(res.status, 200);
  assert.deepEqual(body, { items: [], nextCursor: null });
});

test('GET /api/v1/marks：依 updatedAt 升冪，預設頁大小與 nextCursor 續頁', async () => {
  const h = harness();
  const seeds = [];
  for (let i = 0; i < PAGE_SIZE_DEFAULT + 10; i += 1) {
    seeds.push(markOf({ key: `threads:50${String(i).padStart(5, '0')}`, updatedAt: T0 + i }));
  }
  h.server.marks.seed(seeds);

  const first = (await h.listJson()).body;
  assert.equal(first.items.length, PAGE_SIZE_DEFAULT);
  assert.equal(first.items[0].updatedAt, T0, '升冪：最舊的排前面');
  assert.equal(first.items[PAGE_SIZE_DEFAULT - 1].updatedAt, T0 + PAGE_SIZE_DEFAULT - 1);
  assert.equal(typeof first.nextCursor, 'string');

  const second = (await h.listJson(`?cursor=${encodeURIComponent(first.nextCursor)}`)).body;
  assert.equal(second.items.length, 10);
  assert.equal(second.items[0].updatedAt, T0 + PAGE_SIZE_DEFAULT);
  assert.equal(second.nextCursor, null);

  const firstKeys = new Set(first.items.map((m) => m.key));
  assert.equal(
    second.items.some((m) => firstKeys.has(m.key)),
    false
  );
});

test('GET /api/v1/marks：limit 受上限節制', async () => {
  const h = harness();
  const seeds = [];
  for (let i = 0; i < PAGE_SIZE_MAX + 5; i += 1) {
    seeds.push(markOf({ key: `threads:60${String(i).padStart(5, '0')}`, updatedAt: T0 + i }));
  }
  h.server.marks.seed(seeds);
  const body = (await h.listJson(`?limit=${PAGE_SIZE_MAX + 50}`)).body;
  assert.equal(body.items.length, PAGE_SIZE_MAX);
});

test('GET /api/v1/marks：壞 cursor 回 400 bad_cursor', async () => {
  const h = harness();
  const res = await h.list('?cursor=nope');
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'bad_cursor' });
});

test('GET /api/v1/marks：since 只回比它新的項目', async () => {
  const h = harness();
  h.server.marks.seed([
    markOf({ key: KEY_A, updatedAt: T0 }),
    markOf({ key: KEY_B, updatedAt: T0 + MINUTE }),
  ]);
  const body = (await h.listJson(`?since=${T0}`)).body;
  assert.deepEqual(
    body.items.map((m) => m.key),
    [KEY_B]
  );
});

test('GET /api/v1/marks：已刪除的項目不在回填清單裡', async () => {
  const h = harness();
  await h.push([markOf(), markOf({ key: KEY_B })]);
  await h.syncJson({ upserts: [], deletes: [KEY_A] });
  const body = (await h.listJson()).body;
  assert.deepEqual(
    body.items.map((m) => m.key),
    [KEY_B]
  );
});

test('GET /api/v1/marks：每項與 sync 同一套 mark 形狀', async () => {
  const h = harness();
  await h.push([markOf()]);
  const body = (await h.listJson()).body;
  assert.deepEqual(body.items, [requireMark(h, KEY_A)]);
});

// ============================================================================
// 測試輔助 API
// ============================================================================

test('marks 輔助 API：seed 拒收不符形狀的資料', () => {
  const h = harness();
  assert.throws(() => h.server.marks.seed([markOf({ key: 'threads:abc' })]), /marks\.seed/);
});

test('marks 輔助 API：snapshot 依 key 排序且回的是副本', () => {
  const h = harness();
  h.server.marks.seed([markOf({ key: KEY_B }), markOf({ key: KEY_A })]);
  const snapshot = h.server.marks.snapshot();
  assert.deepEqual(
    snapshot.map((m) => m.key),
    [KEY_A, KEY_B]
  );
  snapshot[0].state = 'dismissed';
  snapshot[0].evidence.length = 0;
  assert.equal(h.server.marks.byKey(KEY_A).state, 'active', 'snapshot 改不動伺服器狀態');
  assert.equal(h.server.marks.byKey(KEY_A).evidence.length, 1);
});

test('marks 輔助 API：setQuota 可覆寫配額', async () => {
  const h = harness({ server: { plan: 'free' } });
  h.server.marks.setQuota(1);
  assert.equal(h.server.marks.quota(), 1);
  h.server.marks.seed([markOf({ key: KEY_A, updatedAt: T0 })]);
  const body = await h.push([markOf({ key: KEY_B, updatedAt: T0 + MINUTE })]);
  assert.equal(body.evicted, 1);
  assert.deepEqual(
    h.server.marks.snapshot().map((m) => m.key),
    [KEY_B]
  );
});

// ============================================================================
// R3 — DELETE /api/v1/marks 與 marks 的清空水位線（後端 2026-09-22 契約）
// ----------------------------------------------------------------------------
// 安全審查抓到「刪除雲端資料」只打 `DELETE /api/v1/links`，警示名單整份留在後
// 端。後端補的 R3 契約：
//
// - `DELETE /api/v1/marks` 硬刪該使用者的 marks ＋墓碑並寫下 `clearedAt`，回
//   `{ ok:true, clearedAt }`（毫秒）。守門沿用 links（Bearer、限流）。
// - `POST /api/v1/marks/sync` 對 `updatedAt <= clearedAt` 的 upsert 一律退進
//   `applied.rejectedIds`（與 links 的「早於 cleared_at 一律拒收」同一條規則），
//   這是插件端刪完雲端後本機名單留著也不會被推回去的保證。
// - 回應的 `changes` 物件補一格 `clearedAt`（null 或毫秒）。`changes` 為 null
//   （請求沒帶 since／cursor，首輪回填走 GET）時整個物件就是 null，不另立鍵：
//   插件端因此只在帶位置參數的增量請求才得知清空。
// - `DELETE /api/v1/links` 不碰 marks（現況即如此，在此釘住，免得日後被順手
//   改成連帶清空而讓兩條通道的清空語意糊在一起）。
// ============================================================================

// 清空雲端警示並回傳水位線。端點未實作時 body 沒有 clearedAt，先斷言形狀，讓
// 紅燈停在「端點還沒做」而不是後面一路拿 undefined 去比較的假綠燈。
async function clearMarks(h) {
  const res = await h.call('DELETE', '/api/v1/marks');
  assert.equal(res.status, 200, 'DELETE /api/v1/marks 應回 200');
  const body = await res.json();
  assert.equal(typeof body.clearedAt, 'number', 'DELETE /api/v1/marks 應回 clearedAt 毫秒');
  return body.clearedAt;
}

test('R3-4 DELETE /api/v1/marks：硬刪 marks 與墓碑並回 { ok:true, clearedAt }', async () => {
  const h = harness();
  await h.push([markOf({ key: KEY_A }), markOf({ key: KEY_B })]);
  await h.syncJson({ upserts: [], deletes: [KEY_C] });
  assert.equal(h.server.marks.count(), 2, '前置條件:雲端有兩筆警示');
  assert.equal(h.server.marks.tombstoneCount(), 1, '前置條件:雲端有一個墓碑');

  const res = await h.call('DELETE', '/api/v1/marks');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ['clearedAt', 'ok'], '回應只有 ok 與 clearedAt 兩把鍵');
  assert.equal(body.ok, true);
  assert.equal(typeof body.clearedAt, 'number');
  assert.ok(Number.isFinite(body.clearedAt) && body.clearedAt > 0, 'clearedAt 是毫秒時戳');
  assert.equal(h.server.marks.count(), 0, '警示整份硬刪');
  assert.equal(h.server.marks.tombstoneCount(), 0, '墓碑一併硬刪，不留下會被當成刪除意圖再送一次的殘渣');
});

test('R3-4 DELETE /api/v1/marks：守門沿用 links——無 bearer 回 401 且一筆不刪', async () => {
  const h = harness();
  await h.push([markOf()]);
  const res = await h.call('DELETE', '/api/v1/marks', { token: null });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'unauthorized' });
  assert.equal(h.server.marks.count(), 1, '未授權的請求不得動到資料');
});

test('R3-4 輔助 API：server.marks.clearedAt() 讀得到清空水位線', async () => {
  const h = harness();
  assert.equal(typeof h.server.marks.clearedAt, 'function', 'marks 輔助 API 應有 clearedAt()');
  assert.equal(h.server.marks.clearedAt(), null, '沒清空過時是 null');
  const body = await (await h.call('DELETE', '/api/v1/marks')).json();
  assert.equal(h.server.marks.clearedAt(), body.clearedAt, '輔助 API 看到的水位線與回應一致');
});

test('R3-4 marks sync：updatedAt 不大於 clearedAt 的 upsert 退進 rejectedIds，一筆不寫', async () => {
  const h = harness();
  const cleared = await clearMarks(h);

  const { res, body } = await h.syncJson({
    upserts: [markOf({ key: KEY_A, updatedAt: cleared - 1 }), markOf({ key: KEY_B, updatedAt: cleared })],
    deletes: [],
  });
  assert.equal(res.status, 200);
  assert.deepEqual(body.applied.upserts, [], '早於（含等於）水位線的一律不收');
  assert.deepEqual(body.applied.rejectedIds.sort(), [KEY_A, KEY_B]);
  assert.equal(h.server.marks.count(), 0, '被拒的一筆都不得落地');
});

test('R3-4 marks sync：updatedAt 大於 clearedAt 的 upsert 照常收下', async () => {
  const h = harness();
  const cleared = await clearMarks(h);

  const body = await h.push([markOf({ key: KEY_A, addedAt: cleared + 1, updatedAt: cleared + 1 })]);
  assert.deepEqual(body.applied.upserts, [KEY_A], '晚於水位線的新警示照收，否則清空後名單永遠長不回來');
  assert.deepEqual(body.applied.rejectedIds, []);
  assert.equal(h.server.marks.count(), 1);
});

test('R3-4 marks sync：changes 物件必帶 clearedAt（沒清空過時為 null）', async () => {
  const h = harness();
  await h.push([markOf()]);
  const body = (await h.syncJson({ upserts: [], deletes: [], since: 0 })).body;
  assert.notEqual(body.changes, null, '前置條件:帶 since 就有 changes');
  assert.deepEqual(
    Object.keys(body.changes).sort(),
    ['clearedAt', 'deleted', 'hasMore', 'marks'],
    'changes 固定四欄'
  );
  assert.equal(body.changes.clearedAt, null, '沒清空過時是 null，不是缺鍵');
});

test('R3-4 marks sync：清空之後 changes.clearedAt 帶回水位線毫秒', async () => {
  const h = harness();
  const cleared = await clearMarks(h);
  const body = (await h.syncJson({ upserts: [], deletes: [], since: 0 })).body;
  assert.equal(body.changes.clearedAt, cleared, '其他裝置靠這一格得知雲端被清空');
});

test('R3-4 marks sync：沒帶 since／cursor 時 changes 整個為 null，不另立 clearedAt 鍵', async () => {
  const h = harness();
  await clearMarks(h);
  const body = (await h.syncJson({ upserts: [], deletes: [] })).body;
  assert.equal(body.changes, null, '首輪回填走 GET，這一次 POST 只領游標');
});

test('R3-4 DELETE /api/v1/links 不碰 marks（兩條通道的清空各自獨立）', async () => {
  const h = harness();
  await h.push([markOf({ key: KEY_A })]);
  const res = await h.call('DELETE', '/api/v1/links');
  assert.equal(res.status, 200);
  assert.equal(h.server.marks.count(), 1, '刪連結不得順手清掉警示名單');
  assert.equal(h.server.marks.clearedAt(), null, 'marks 的水位線不隨 links 的清空前進');
});
