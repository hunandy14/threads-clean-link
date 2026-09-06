// test/helpers/mock-sync-server.js — meta-link-clearer 雲端後端的純函式狀態機
// 替身（T8）。不開任何 port、不碰網路：只提供一支 `fetch(url, init)`，行為逐條
// 對齊後端契約，讓車道 D 的同步引擎在測試裡跑完整往返。
//
// ============================================================================
// 契約依據（C:\gitRepos\meta-link-clearer\docs\api-spec.md，行號為該檔行號）
// ============================================================================
// | 本檔實作                                   | 依據章節 | 行號       |
// |--------------------------------------------|----------|------------|
// | `POST /api/auth/sign-in/social` 請求 body   | 2.1      | 92-105     |
// | `GET /api/auth/get-session` 未登入回 `null` | 2.2      | 121-124    |
// | `POST /api/auth/sign-out`                   | 2.2      | 121-124    |
// | `ShareHistoryItem` 欄位與長度上限           | 3.1      | 276-313    |
// | `normalizeItem`：缺必填欄位整筆靜默丟棄     | 3.1      | 306-312    |
// | `seen` 缺席時以 `receivedAt` 補一筆         | 3.1      | 310-312    |
// | `post_key` 身分鍵規則                       | 3.2      | 315-338    |
// | `GET /api/v1/links` 分頁與 `nextCursor`     | 4.2      | 346-368    |
// | `POST /api/v1/links/sync` 請求 body 形狀    | 4.3      | 369-382    |
// | 驗證順序：Content-Type 守門早於解析 body    | 4.3      | 384-386    |
// | 415／400／422／401／503 對照表              | 4.3      | 388-397    |
// | 處理規則 1-7（批內合併／拒收／canonicalId／ |          |            |
// | id 碰撞／刪除撞更新／配額淘汰）             | 4.3      | 403-422    |
// | 回應形狀（cursor／applied／changes／evicted）| 4.3     | 424-443    |
// | `since`／`cursor` 語意與 `hasMore`          | 4.3      | 444-458    |
// | `DELETE /api/v1/links`（寫 cleared_at）     | 4.4      | 459-467    |
// | 錯誤格式總表（`{ "error": "<code>" }`）     | 4.5      | 468-492    |
// | `DELETE /api/v1/account`                    | 4.6      | 520-540    |
// | 合併規則（逐欄位）                          | 5        | 560-593    |
// | free 方案 1000 筆滾動淘汰、不寫墓碑         | 7.1      | 687-718    |
// | 讀寫上限常數（50／50／250／200／50／100）   | 7.2      | 719-732    |
// | 速率限制 60 次／60 秒 ＋ `Retry-After`      | 7.4      | 758-770    |
//
// 插件端契約（docs/cloud-sync.md 第 3 節）另補：登入回應的
// `set-auth-token` 標頭、`Authorization: Bearer`、`credentials: "omit"`。
//
// ============================================================================
// 裝置歸屬（0.7）——依據 tmp/cloud-sync-plan-full.md 第 9 節（api-spec §4.7）
// ============================================================================
// - `GET /api/v1/devices`：`{ devices: [...] }`，嚴格五欄、lastSeenAt DESC、不分頁。
// - `PUT /api/v1/devices/:deviceId`：建立時 platform 必填、改名可省；每次都更新
//   lastSeenAt（30 分鐘節流只套 sync 內嵌路徑）。
// - `DELETE /api/v1/devices/:deviceId`：驗證先於冪等，`link_seen.deviceId` 不動。
// - sync 頂層 `device` 區塊與 `seen[].deviceId`：upsert 不覆寫 name、無效靜默丟棄、
//   回應不帶 `devices`。
// - deviceId UUID 形狀（大小寫不敏感、不驗版本位、存小寫）；name 剝控制字元＋trim
//   ＋截 80 code point，空即 422 `bad_device_name`。
// - 每帳號 200 台上限，PUT 與 sync 內嵌皆觸發淘汰 lastSeenAt 最舊者，不回錯。
// - 裝置三端點與 `/api/v1/links` 共用同一個 per-user 限流桶。
//
// ============================================================================
// 契約備註（PM 已裁決）
// ============================================================================
// - api-spec 4.3 的 `SyncRequest` **沒有** `clearedAt` 欄位。「清空全部」的
//   雲端語意就是 `DELETE /api/v1/links`（4.4:459-467）：伺服器自己寫
//   `cleared_at`，之後 `sync` 拒收早於它的資料，並在 `changes.clearedAt`
//   回給其他裝置據以清本機。body 若帶了 `clearedAt`，本 mock 只記錄不理會。
// - api-spec 2.2 明寫 `get-session` 未登入回 `null`（200），**不是** 401。
//   預設行為照此；要模擬 401 請用 `failNext({ status: 401 })`。
'use strict';

const { postKeyOf } = require('../../tcl-core.js');

// ---- 協定常數（api-spec 7.2:719-732、7.1:687-718、7.4:758-770） ----
const MAX_SYNC_UPSERTS = 50;
const MAX_SYNC_DELETES = 50;
const MAX_SYNC_SEEN_ROWS = 250;
const SEEN_MAX = 50;
const CHANGES_LIMIT = 200;
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;
const FREE_QUOTA = 1000;
const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_PERIOD_MS = 60_000;

const SEEN_SOURCES = ['share', 'clipboard'];

// ---- 裝置歸屬常數（plan-full §9／api-spec 4.7） ----
const DEVICE_PLATFORMS = ['android', 'ios', 'chrome_extension'];
const DEVICE_NAME_MAX = 80; // code point，emoji 算 1
const MAX_DEVICES = 200; // 每帳號上限，溢位淘汰 lastSeenAt 最舊者
const DEVICE_LAST_SEEN_THROTTLE_MS = 30 * 60_000; // 只套用在 sync 內嵌路徑
// UUID 形狀：大小寫不敏感、不驗版本／變體位，全零亦合法。
const DEVICE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- 小工具 ----

// deviceId 正規化：合法 UUID 形狀回小寫，否則 undefined（＝視為未提供）。
function normalizeDeviceId(value) {
  if (typeof value !== 'string' || !DEVICE_ID_RE.test(value)) return undefined;
  return value.toLowerCase();
}

// 判斷控制字元：C0（0x00-0x1F）、DEL（0x7F）、C1（0x80-0x9F）。
function isControlCodePoint(code) {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// 裝置名稱正規化：剝控制字元 → trim → 以 code point 截斷至 80（emoji 算 1）。
// 零寬字元不剝，剝了會拆散 emoji 的 ZWJ 序列。回空字串代表 422 bad_device_name。
function normalizeDeviceName(value) {
  if (typeof value !== 'string') return '';
  const stripped = Array.from(value)
    .filter((ch) => !isControlCodePoint(ch.codePointAt(0)))
    .join('')
    .trim();
  return Array.from(stripped).slice(0, DEVICE_NAME_MAX).join('');
}

// URL 路徑片段解碼：壞編碼不炸，原樣回傳交給 UUID 驗證擋下。
function decodePathSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function headersView(map) {
  const lower = {};
  Object.keys(map || {}).forEach((k) => {
    lower[k.toLowerCase()] = map[k];
  });
  return {
    get(name) {
      const v = lower[String(name).toLowerCase()];
      return v === undefined ? null : v;
    },
    // 測試斷言用：整份標頭（鍵一律小寫）。
    all() {
      return Object.assign({}, lower);
    },
  };
}

function normalizeRequestHeaders(init) {
  const raw = (init && init.headers) || {};
  const out = {};
  if (typeof raw.forEach === 'function' && typeof raw.get === 'function') {
    raw.forEach((value, key) => {
      out[String(key).toLowerCase()] = value;
    });
    return out;
  }
  Object.keys(raw).forEach((k) => {
    out[String(k).toLowerCase()] = raw[k];
  });
  return out;
}

function jsonResponse(status, body, extraHeaders) {
  const headers = headersView(Object.assign({ 'content-type': 'application/json' }, extraHeaders));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// api-spec 4.3:384-386——Content-Type 守門在最前面，大小寫不敏感，允許
// `;charset=` 等參數後綴。
function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  return value.toLowerCase().split(';')[0].trim() === 'application/json';
}

// api-spec 4.3:444-458——游標是 `(時間, id)` 的不透明字串；純數字是舊格式
// （嚴格 `時間 > since`）。
function encodeCursor(at, id) {
  return `${at}~${id}`;
}

function decodeSince(since) {
  if (since === undefined || since === null || since === '') return null;
  if (typeof since === 'number') {
    if (!Number.isFinite(since)) return undefined; // 400 bad_since
    return { at: since, id: '\uffff' };
  }
  if (typeof since !== 'string') return undefined;
  if (/^\d+$/.test(since)) return { at: Number(since), id: '\uffff' };
  const m = since.match(/^(\d+)~(.*)$/);
  if (!m) return undefined;
  return { at: Number(m[1]), id: m[2] };
}

function afterPosition(pos, since) {
  if (!since) return true;
  if (pos.at !== since.at) return pos.at > since.at;
  return pos.id > since.id;
}

function comparePosition(a, b) {
  if (a.at !== b.at) return a.at - b.at;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// api-spec 3.1:310-312 ＋ 5:566-580——去重、排序、上限 50，同 `at` 保留有
// `source` 的那筆。plan-full §9：`deviceId` 非 UUID 視為未提供（只丟該欄，整筆
// 事件仍保留）；同一毫秒的歸屬先到者勝。缺欄位一律不輸出該鍵。
function dedupeSeen(list) {
  const byAt = new Map();
  list.forEach((rec) => {
    if (!rec || typeof rec.at !== 'number' || !Number.isFinite(rec.at)) return;
    const source = SEEN_SOURCES.indexOf(rec.source) === -1 ? undefined : rec.source;
    const deviceId = normalizeDeviceId(rec.deviceId);
    const prev = byAt.get(rec.at);
    if (!prev) {
      const next = { at: rec.at };
      if (source !== undefined) next.source = source;
      if (deviceId !== undefined) next.deviceId = deviceId;
      byAt.set(rec.at, next);
      return;
    }
    if (prev.source === undefined && source !== undefined) prev.source = source;
    if (prev.deviceId === undefined && deviceId !== undefined) prev.deviceId = deviceId;
  });
  return [...byAt.values()].sort((a, b) => a.at - b.at).slice(-SEEN_MAX);
}

// api-spec 3.1:306-312——缺 `id`／`original`／`cleaned`，或 `receivedAt` 非
// 有限正數，整筆靜默丟棄（不進 applied、也不進 rejectedIds）。
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || raw.id === '') return null;
  if (typeof raw.original !== 'string' || raw.original === '') return null;
  if (typeof raw.cleaned !== 'string' || raw.cleaned === '') return null;
  if (typeof raw.receivedAt !== 'number' || !Number.isFinite(raw.receivedAt) || raw.receivedAt <= 0) {
    return null;
  }
  const seen = dedupeSeen(Array.isArray(raw.seen) && raw.seen.length ? raw.seen : [{ at: raw.receivedAt }]);
  const item = {
    id: raw.id,
    original: raw.original,
    cleaned: raw.cleaned,
    receivedAt: raw.receivedAt,
    seen,
  };
  ['failReason', 'author', 'handle', 'excerpt'].forEach((k) => {
    if (typeof raw[k] === 'string') item[k] = raw[k];
  });
  if (Array.isArray(raw.removedParams)) item.removedParams = raw.removedParams;
  return item;
}

// api-spec 5:560-593——逐欄位合併規則。
function mergeItem(existing, incoming) {
  const incomingIsNewer = incoming.receivedAt >= existing.receivedAt;
  const newer = incomingIsNewer ? incoming : existing;
  const older = incomingIsNewer ? existing : incoming;

  let original = newer.original;
  if (newer.original === newer.cleaned && older.original !== older.cleaned) {
    original = older.original;
  }

  const merged = {
    id: existing.id, // 固定沿用既有 id，避免主鍵漂移
    receivedAt: newer.receivedAt,
    cleaned: newer.cleaned,
    original,
    seen: dedupeSeen((existing.seen || []).concat(incoming.seen || [])),
  };
  if (typeof newer.failReason === 'string') merged.failReason = newer.failReason;
  ['author', 'handle', 'excerpt'].forEach((k) => {
    const value = newer[k] !== undefined && newer[k] !== null ? newer[k] : older[k];
    if (value !== undefined && value !== null) merged[k] = value;
  });
  const newerParams = newer.removedParams;
  merged.removedParams = newerParams && newerParams.length ? newerParams : older.removedParams;
  if (!merged.removedParams) delete merged.removedParams;
  return merged;
}

function publicItem(row) {
  const item = {
    id: row.id,
    original: row.original,
    cleaned: row.cleaned,
    receivedAt: row.receivedAt,
    seen: row.seen && row.seen.length ? row.seen : [{ at: row.receivedAt }],
  };
  ['failReason', 'author', 'handle', 'excerpt'].forEach((k) => {
    if (row[k] !== undefined) item[k] = row[k];
  });
  if (row.removedParams) item.removedParams = row.removedParams;
  return item;
}

function eventTimeOf(item) {
  const seenMax = (item.seen || []).reduce((max, rec) => (rec.at > max ? rec.at : max), 0);
  return Math.max(item.receivedAt, seenMax);
}

/**
 * 建立一台假後端。
 *
 * @param {object} [options]
 * @param {() => number} [options.now]        時鐘（預設 `Date.now`，測試一律注入假時鐘）
 * @param {string} [options.apiBase]          只接受這個 base 的請求（預設 production）
 * @param {string} [options.userId]
 * @param {string} [options.email]
 * @param {string|null} [options.name]         登入／get-session 回應的 user.name（車道 A，D15）。
 *   顯式傳 `null` 表示這次回應完全不帶這個鍵（供「後端缺席、退回 id_token
 *   payload」的測試情境），省略則用假值。
 * @param {string|null} [options.image]        同上，user.image（頭像網址）。
 * @param {'free'|'pro'} [options.plan]       free 才做配額淘汰（api-spec 7.1）
 * @param {number} [options.quota]            覆寫 free 配額（預設 1000）
 */
function createMockSyncServer(options = {}) {
  const now = options.now || (() => Date.now());
  const apiBase = (options.apiBase || 'https://api.metalinkclearer.workers.dev').replace(/\/$/, '');
  const includeName = options.name !== null;
  const includeImage = options.image !== null;
  const user = {
    id: options.userId || 'user-abc',
    email: options.email || 'someone@example.com',
    // D15：假值，供「syncState 記錄名字與大頭照」的測試使用。image 預設就是
    // 白名單接受的 googleusercontent.com 網域，非白名單案例由測試顯式覆寫。
    name: includeName ? options.name || 'Fake User' : undefined,
    image: includeImage ? options.image || 'https://lh3.googleusercontent.com/a/fake-mock-user' : undefined,
    plan: options.plan || 'free',
  };
  const quota = options.quota || FREE_QUOTA;

  const state = {
    token: options.token || null,
    /** postKey → row（row 另帶 createdAt／updatedAt，不外流） */
    links: new Map(),
    /** postKey → { id, postKey, deletedAt } */
    tombstones: new Map(),
    /** deviceId（小寫）→ { deviceId, name, platform, createdAt, lastSeenAt } */
    devices: new Map(),
    clearedAt: null,
    accountDeleted: false,
  };

  /** 每次請求的完整側錄，供標頭／body 斷言。 */
  const requests = [];
  /** FIFO 的注入故障佇列。 */
  const failures = [];
  /** 待釋放的延遲回應（競態測試用）。 */
  const held = [];
  /** 下一次回應要附掛的 `set-auth-token`（token 輪替）。 */
  let pendingRotation = null;
  /** 速率限制桶：`links:<userId>` 的請求時間戳。 */
  let rateWindow = [];
  let tokenSeq = 0;
  let idSeq = 0;
  let clock = 0;

  // 每次寫入推進一格邏輯時鐘，讓 `(updatedAt, id)` 游標必定嚴格前進。
  function tick() {
    clock = Math.max(clock + 1, now());
    return clock;
  }

  function issueToken() {
    tokenSeq += 1;
    state.token = `tok-${tokenSeq}`;
    return state.token;
  }

  function bearerOf(headers) {
    const auth = headers.authorization;
    if (typeof auth !== 'string') return null;
    const m = auth.match(/^Bearer (.+)$/);
    return m ? m[1] : null;
  }

  function authed(headers) {
    const token = bearerOf(headers);
    return token !== null && state.token !== null && token === state.token && !state.accountDeleted;
  }

  function unauthorized() {
    return jsonResponse(401, { error: 'unauthorized' });
  }

  // api-spec 7.4:758-770——每使用者 60 次／60 秒。plan-full §9：裝置三端點與
  // /api/v1/links 共用同一個 per-user 桶。
  function rateLimited(at) {
    rateWindow = rateWindow.filter((t) => at - t < RATE_LIMIT_PERIOD_MS);
    if (rateWindow.length >= RATE_LIMIT_MAX) return true;
    rateWindow.push(at);
    return false;
  }

  function rateLimitedResponse() {
    return jsonResponse(429, { error: 'rate_limited', retryAfter: 60 }, { 'retry-after': '60' });
  }

  function withRotation(response) {
    if (pendingRotation === null) return response;
    const token = pendingRotation;
    pendingRotation = null;
    state.token = token;
    const merged = headersView(Object.assign(response.headers.all(), { 'set-auth-token': token }));
    return Object.assign({}, response, { headers: merged });
  }

  // ---- 裝置歸屬（plan-full §9／api-spec 4.7） ----

  // 對外視圖：嚴格五欄，不外流任何內部欄位。
  function deviceView(row) {
    return {
      deviceId: row.deviceId,
      name: row.name,
      platform: row.platform,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
    };
  }

  // 每帳號上限 200 台：溢位時淘汰 lastSeenAt 最舊者，不回錯、不通知客戶端。
  function evictDevices() {
    while (state.devices.size > MAX_DEVICES) {
      let oldest = null;
      state.devices.forEach((row) => {
        if (oldest === null || compareDeviceAge(row, oldest) < 0) oldest = row;
      });
      state.devices.delete(oldest.deviceId);
    }
  }

  // 淘汰順序：lastSeenAt → createdAt → deviceId，皆升冪（越前面越舊）。
  function compareDeviceAge(a, b) {
    if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0;
  }

  /**
   * sync 頂層 `device` 區塊的 upsert。無效區塊（非物件／deviceId 非 UUID／
   * platform 缺或不在枚舉／name 正規化後為空）靜默丟棄，不影響連結同步。
   * 已存在的裝置不覆寫 name（改名一律走 PUT）；lastSeenAt 只在距上次嚴格
   * 超過 30 分鐘、或 platform 改變時寫入。
   */
  function upsertDeviceFromSync(raw, at) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const deviceId = normalizeDeviceId(raw.deviceId);
    if (deviceId === undefined) return;
    if (DEVICE_PLATFORMS.indexOf(raw.platform) === -1) return;
    const name = normalizeDeviceName(raw.name);
    if (name === '') return;

    const existing = state.devices.get(deviceId);
    if (!existing) {
      state.devices.set(deviceId, {
        deviceId,
        name,
        platform: raw.platform,
        createdAt: at,
        lastSeenAt: at,
      });
      evictDevices();
      return;
    }
    if (existing.platform !== raw.platform) {
      existing.platform = raw.platform;
      existing.lastSeenAt = at;
      return;
    }
    if (at - existing.lastSeenAt > DEVICE_LAST_SEEN_THROTTLE_MS) existing.lastSeenAt = at;
  }

  // ---- 端點：GET /api/v1/devices（lastSeenAt DESC，不分頁） ----
  function handleListDevices(headers, at) {
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();
    const devices = [...state.devices.values()]
      .sort((a, b) => -compareDeviceAge(a, b))
      .map(deviceView);
    return jsonResponse(200, { devices });
  }

  // ---- 端點：PUT /api/v1/devices/:deviceId ----
  function handlePutDevice(rawDeviceId, headers, body, at) {
    if (!isJsonContentType(headers['content-type'])) {
      return jsonResponse(415, { error: 'unsupported_media_type' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(400, { error: 'bad_request' });
    }
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();

    const deviceId = normalizeDeviceId(rawDeviceId);
    if (deviceId === undefined) return jsonResponse(422, { error: 'bad_device_id' });

    const existing = state.devices.get(deviceId);
    // platform 建立時必填、改名可省（省略時沿用既有值）。
    const platform = body.platform === undefined && existing ? existing.platform : body.platform;
    if (DEVICE_PLATFORMS.indexOf(platform) === -1) {
      return jsonResponse(422, { error: 'bad_device_platform' });
    }
    const name = normalizeDeviceName(body.name);
    if (name === '') return jsonResponse(422, { error: 'bad_device_name' });

    if (existing) {
      existing.name = name;
      existing.platform = platform;
      existing.lastSeenAt = at; // PUT 每次都更新，30 分鐘節流只套 sync 內嵌路徑
      return jsonResponse(200, { device: deviceView(existing) });
    }
    const row = { deviceId, name, platform, createdAt: at, lastSeenAt: at };
    state.devices.set(deviceId, row);
    evictDevices();
    return jsonResponse(200, { device: deviceView(row) });
  }

  // ---- 端點：DELETE /api/v1/devices/:deviceId（冪等；link_seen.deviceId 不動） ----
  function handleDeleteDevice(rawDeviceId, headers, at) {
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();
    // 驗證先於冪等：爛 id 回 422，不當成「不存在」吞掉。
    const deviceId = normalizeDeviceId(rawDeviceId);
    if (deviceId === undefined) return jsonResponse(422, { error: 'bad_device_id' });
    state.devices.delete(deviceId);
    return jsonResponse(200, { ok: true });
  }

  // ---- 端點：POST /api/v1/links/sync（api-spec 4.3:369-458） ----
  function handleSync(headers, body, at) {
    // 1. Content-Type 守門在最前面（4.3:384-386）
    if (!isJsonContentType(headers['content-type'])) {
      return jsonResponse(415, { error: 'unsupported_media_type' });
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonResponse(400, { error: 'bad_request' });
    }
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();

    const upserts = Array.isArray(body.upserts) ? body.upserts : [];
    const deletes = [...new Set(Array.isArray(body.deletes) ? body.deletes : [])].filter(
      (id) => typeof id === 'string' && id.length >= 1 && id.length <= 64
    );
    if (upserts.length > MAX_SYNC_UPSERTS) {
      return jsonResponse(422, { error: 'too_many_upserts', max: MAX_SYNC_UPSERTS });
    }
    if (deletes.length > MAX_SYNC_DELETES) {
      return jsonResponse(422, { error: 'too_many_deletes', max: MAX_SYNC_DELETES });
    }
    const seenRows = upserts.reduce((n, it) => n + (Array.isArray(it && it.seen) ? it.seen.length : 0), 0);
    if (seenRows > MAX_SYNC_SEEN_ROWS) {
      return jsonResponse(422, { error: 'too_many_seen', max: MAX_SYNC_SEEN_ROWS });
    }
    const since = decodeSince(body.since);
    if (since === undefined) return jsonResponse(400, { error: 'bad_since' });

    // plan-full §9：頂層 device 區塊 upsert，回應不帶 devices。
    upsertDeviceFromSync(body.device, at);

    const applied = { upserts: [], rejectedIds: [], deletedIds: [] };
    let created = 0;

    // 規則 1：批內先依 post_key 合併（沿用第一筆的 id）
    const batch = new Map();
    upserts.forEach((raw) => {
      const item = normalizeItem(raw);
      if (!item) return; // 3.1:306-312 靜默丟棄
      const key = postKeyOf(item.cleaned);
      const prev = batch.get(key);
      if (!prev) {
        batch.set(key, { key, sentId: item.id, item });
        return;
      }
      prev.item = mergeItem(prev.item, item);
      prev.item.id = prev.sentId;
    });

    batch.forEach((entry) => {
      const key = entry.key;
      const incoming = entry.item;
      const eventAt = eventTimeOf(incoming);

      // 規則 2：早於 clearedAt 一律拒收
      if (state.clearedAt !== null && eventAt <= state.clearedAt) {
        applied.rejectedIds.push(entry.sentId);
        return;
      }
      // 規則 3：早於墓碑拒收；比墓碑新則撤銷墓碑
      const tomb = state.tombstones.get(key);
      if (tomb) {
        if (eventAt <= tomb.deletedAt) {
          applied.rejectedIds.push(entry.sentId);
          return;
        }
        state.tombstones.delete(key);
      }

      const existing = state.links.get(key);
      if (existing) {
        // 規則 4：與既有卡合併，canonicalId 為既有卡的 id
        const merged = mergeItem(existing, incoming);
        merged.createdAt = existing.createdAt;
        merged.updatedAt = tick();
        state.links.set(key, merged);
        applied.upserts.push({ id: entry.sentId, canonicalId: existing.id });
        return;
      }

      // 規則 5：新卡的 id 碰撞防禦
      let id = incoming.id;
      const taken = new Set([...state.links.values()].map((row) => row.id));
      while (taken.has(id)) {
        idSeq += 1;
        id = `${incoming.receivedAt}-srv${idSeq}`;
      }
      const row = Object.assign({}, incoming, { id, createdAt: tick(), updatedAt: clock });
      state.links.set(key, row);
      applied.upserts.push({ id: entry.sentId, canonicalId: id });
      created += 1;
    });

    // deletes：找雲端 id → 寫墓碑
    deletes.forEach((id) => {
      let hitKey = null;
      state.links.forEach((row, key) => {
        if (row.id === id) hitKey = key;
      });
      applied.deletedIds.push(id); // 含原本就不存在、視為已刪的
      if (hitKey === null) return;
      const row = state.links.get(hitKey);
      state.links.delete(hitKey);
      state.tombstones.set(hitKey, { id: row.id, postKey: hitKey, deletedAt: tick() });
    });

    // 規則 6：刪除撞上更新——刪除獲勝
    if (deletes.length) {
      const deleteSet = new Set(deletes);
      applied.upserts = applied.upserts.filter((entry) => {
        if (!deleteSet.has(entry.canonicalId) && !deleteSet.has(entry.id)) return true;
        applied.rejectedIds.push(entry.id);
        return false;
      });
    }

    // 規則 7：配額淘汰（free；不寫墓碑）
    let evicted = 0;
    if (created > 0 && user.plan === 'free' && state.links.size > quota) {
      const ordered = [...state.links.entries()].sort(
        (a, b) => a[1].createdAt - b[1].createdAt || (a[1].id < b[1].id ? -1 : 1)
      );
      const overflow = state.links.size - quota;
      ordered.slice(0, overflow).forEach(([key]) => state.links.delete(key));
      evicted = overflow;
    }

    // 增量段（沒帶 since 時 changes 為 null）
    let changes = null;
    let cursor = String(tick());
    if (since !== null) {
      const linkRows = [...state.links.values()]
        .map((row) => ({ pos: { at: row.updatedAt, id: row.id }, row }))
        .filter((x) => afterPosition(x.pos, since))
        .sort((a, b) => comparePosition(a.pos, b.pos));
      const tombRows = [...state.tombstones.values()]
        .map((row) => ({ pos: { at: row.deletedAt, id: row.id }, row }))
        .filter((x) => afterPosition(x.pos, since))
        .sort((a, b) => comparePosition(a.pos, b.pos));

      const linkPage = linkRows.slice(0, CHANGES_LIMIT);
      const tombPage = tombRows.slice(0, CHANGES_LIMIT);
      const hasMore = linkRows.length > CHANGES_LIMIT || tombRows.length > CHANGES_LIMIT;

      changes = {
        links: linkPage.map((x) => publicItem(x.row)),
        deleted: tombPage.map((x) => ({ id: x.row.id, postKey: x.row.postKey, deletedAt: x.row.deletedAt })),
        clearedAt: state.clearedAt,
        hasMore,
      };

      if (hasMore) {
        const ends = [];
        if (linkPage.length) ends.push(linkPage[linkPage.length - 1].pos);
        if (tombPage.length) ends.push(tombPage[tombPage.length - 1].pos);
        // 停在兩條時間線本頁最後一筆位置的較小者（4.3:450-456）
        const min = ends.sort(comparePosition)[0];
        cursor = encodeCursor(min.at, min.id);
      }
    }

    return jsonResponse(200, { cursor, applied, changes, evicted });
  }

  // ---- 端點：GET /api/v1/links（api-spec 4.2:346-368） ----
  function handleList(url, headers, at) {
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();
    const params = url.searchParams;
    let limit = Number(params.get('limit'));
    if (!Number.isInteger(limit) || limit <= 0) limit = PAGE_SIZE_DEFAULT;
    limit = Math.min(limit, PAGE_SIZE_MAX);

    const cursorRaw = params.get('cursor');
    let cursor = null;
    if (cursorRaw !== null) {
      const m = cursorRaw.match(/^(\d+)~(.*)$/);
      if (!m) return jsonResponse(400, { error: 'bad_cursor' });
      cursor = { at: Number(m[1]), id: m[2] };
    }

    // received_at DESC, id DESC
    const rows = [...state.links.values()].sort(
      (a, b) => b.receivedAt - a.receivedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
    const after = cursor
      ? rows.filter((row) => row.receivedAt < cursor.at || (row.receivedAt === cursor.at && row.id < cursor.id))
      : rows;
    const page = after.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = after.length > limit && last ? encodeCursor(last.receivedAt, last.id) : null;
    return jsonResponse(200, { items: page.map(publicItem), nextCursor });
  }

  // ---- 端點：DELETE /api/v1/links（api-spec 4.4:459-467） ----
  function handleDeleteLinks(headers, at) {
    if (!authed(headers)) return unauthorized();
    if (rateLimited(at)) return rateLimitedResponse();
    state.links.clear();
    state.tombstones.clear();
    state.clearedAt = tick();
    return jsonResponse(200, { ok: true, clearedAt: state.clearedAt });
  }

  // ---- 端點：DELETE /api/v1/account（api-spec 4.6:520-540） ----
  function handleDeleteAccount(headers) {
    if (!authed(headers)) return unauthorized();
    state.links.clear();
    state.tombstones.clear();
    state.devices.clear();
    state.clearedAt = null;
    state.token = null;
    state.accountDeleted = true;
    return jsonResponse(200, { ok: true });
  }

  // D15（車道 A）：回應內 user 物件的公開視圖。name／image 缺席（options 顯
  // 式傳 null）時整個鍵不輸出，讓插件端「後端缺席、退回 id_token payload」
  // 的分支測得到。
  function publicUser(withPlan) {
    const out = { id: user.id, email: user.email };
    if (user.name !== undefined) out.name = user.name;
    if (user.image !== undefined) out.image = user.image;
    if (withPlan) out.plan = user.plan;
    return out;
  }

  // ---- 認證端點（api-spec 2.1:92-105、2.2:121-124） ----
  function handleSignIn(headers, body) {
    if (!isJsonContentType(headers['content-type'])) {
      return jsonResponse(415, { error: 'unsupported_media_type' });
    }
    if (!body || body.provider !== 'google' || !body.idToken || !body.idToken.token) {
      return jsonResponse(400, { error: 'bad_request' });
    }
    state.accountDeleted = false;
    const token = issueToken();
    // 插件端契約第 3 點：token 從 `set-auth-token` 回應標頭取得。
    return jsonResponse(200, { user: publicUser(false), redirect: false }, {
      'set-auth-token': token,
    });
  }

  function handleGetSession(headers) {
    // api-spec 2.2:123——未登入回 `null`（200），不是錯誤。
    if (!authed(headers)) return jsonResponse(200, null);
    return jsonResponse(200, {
      session: { userId: user.id, expiresAt: now() + 90 * 24 * 60 * 60 * 1000 },
      user: publicUser(true),
    });
  }

  function handleSignOut(headers) {
    if (!authed(headers)) return unauthorized();
    state.token = null;
    return jsonResponse(200, { success: true });
  }

  // ---- 路由 ----
  function route(method, url, headers, body, at) {
    const path = url.pathname;
    // 打到非預期 base（例如 apiBase 覆寫被錯誤接受）時明確炸掉，不靜默通過。
    if (url.origin !== apiBase) {
      throw new Error(`mock-sync-server: 未預期的 origin ${url.origin}（預期 ${apiBase}）`);
    }
    if (method === 'POST' && path === '/api/auth/sign-in/social') return handleSignIn(headers, body);
    if (method === 'GET' && path === '/api/auth/get-session') return handleGetSession(headers);
    if (method === 'POST' && path === '/api/auth/sign-out') return handleSignOut(headers);
    if (method === 'POST' && path === '/api/v1/links/sync') return handleSync(headers, body, at);
    if (method === 'GET' && path === '/api/v1/links') return handleList(url, headers, at);
    if (method === 'DELETE' && path === '/api/v1/links') return handleDeleteLinks(headers, at);
    if (method === 'DELETE' && path === '/api/v1/account') return handleDeleteAccount(headers);
    if (method === 'GET' && path === '/api/v1/devices') return handleListDevices(headers, at);
    const deviceIdMatch = path.match(/^\/api\/v1\/devices\/([^/]+)$/);
    if (deviceIdMatch) {
      const rawDeviceId = decodePathSegment(deviceIdMatch[1]);
      if (method === 'PUT') return handlePutDevice(rawDeviceId, headers, body, at);
      if (method === 'DELETE') return handleDeleteDevice(rawDeviceId, headers, at);
    }
    if (method === 'GET' && path === '/health') return jsonResponse(200, { ok: true, service: 'api' });
    return jsonResponse(404, { error: 'not_found' });
  }

  // ---- fetch 替身 ----
  async function fetchImpl(input, init) {
    const method = ((init && init.method) || 'GET').toUpperCase();
    const url = new URL(String(input));
    const headers = normalizeRequestHeaders(init);
    let body = null;
    if (init && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch (e) {
        body = { __unparsable: init.body };
      }
    }
    const at = now();
    const record = {
      method,
      url: String(input),
      path: url.pathname,
      search: url.search,
      headers,
      credentials: init ? init.credentials : undefined,
      body,
      at,
    };
    requests.push(record);

    // 注入故障優先於任何業務邏輯（模擬邊緣層／網路層失敗）。
    const failure = failures.length ? failures.shift() : null;
    const produce = () => {
      if (failure && failure.kind === 'network') {
        throw new TypeError('Failed to fetch');
      }
      if (failure && failure.status) {
        const extra = {};
        if (failure.retryAfter !== undefined) extra['retry-after'] = String(failure.retryAfter);
        const errorBody =
          failure.body !== undefined
            ? failure.body
            : Object.assign(
                { error: failure.code || defaultCodeFor(failure.status) },
                failure.retryAfter !== undefined ? { retryAfter: failure.retryAfter } : {}
              );
        return withRotation(jsonResponse(failure.status, errorBody, extra));
      }
      return withRotation(route(method, url, headers, body, at));
    };

    if (!held.length) return produce();

    // 延遲回應：等測試呼叫 release() 才結算（跨 tick，不同 tick 假綠燈）。
    held.shift();
    return new Promise((resolve, reject) => {
      pendingReleases.push(() => {
        try {
          resolve(produce());
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  const pendingReleases = [];

  function defaultCodeFor(status) {
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden_origin';
    if (status === 415) return 'unsupported_media_type';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'misconfigured';
    return 'internal';
  }

  return {
    fetch: fetchImpl,
    requests,
    apiBase,
    user,
    state,

    /** 目前有效的 bearer token（尚未登入為 null）。 */
    currentToken() {
      return state.token;
    },

    /** 下一次（或連續 n 次）回應改成注入的故障。 */
    failNext(failure, times = 1) {
      for (let i = 0; i < times; i += 1) failures.push(Object.assign({}, failure));
      return this;
    },
    clearFailures() {
      failures.length = 0;
      return this;
    },

    /** 下一次回應附掛新的 `set-auth-token`（token 輪替），舊 token 立刻失效。 */
    rotateTokenOnNextResponse(token) {
      tokenSeq += 1;
      pendingRotation = token || `tok-rotated-${tokenSeq}`;
      return pendingRotation;
    },

    /** 讓伺服器端 session 失效（模擬 90 天到期／被撤銷）。 */
    expireSession() {
      state.token = null;
      return this;
    },

    /**
     * 讓接下來 n 次請求的回應暫緩結算，回傳 `release()`：呼叫一次放行一筆
     * （FIFO）。競態測試（單飛、往返期間新寫入）一律用它，不在同一個 tick
     * 解析回應。
     */
    holdNext(n = 1) {
      for (let i = 0; i < n; i += 1) held.push(true);
      return function release(count = 1) {
        for (let i = 0; i < count; i += 1) {
          const fn = pendingReleases.shift();
          if (fn) fn();
        }
      };
    },
    pendingCount() {
      return pendingReleases.length;
    },

    /** 直接種雲端資料（不經 API），供拉取測試備料。 */
    seed(items, opts = {}) {
      items.forEach((raw) => {
        const item = normalizeItem(raw);
        if (!item) throw new Error('mock-sync-server.seed: 資料不符 ShareHistoryItem 必填欄位');
        const key = postKeyOf(item.cleaned);
        state.links.set(key, Object.assign({}, item, { createdAt: tick(), updatedAt: clock }));
      });
      if (opts.clearedAt !== undefined) state.clearedAt = opts.clearedAt;
      return this;
    },

    /** 直接種墓碑（不經 API）。 */
    seedTombstone(cleanedUrl, id, deletedAt) {
      const key = postKeyOf(cleanedUrl);
      state.links.delete(key);
      state.tombstones.set(key, { id, postKey: key, deletedAt: deletedAt === undefined ? tick() : deletedAt });
      return this;
    },

    /**
     * 換掉這台伺服器認得的使用者（`sign-in/social` 與 `get-session` 都回它）。
     * 供「同一份 storage 上換帳號登入」的測試使用：只帶要改的欄位。
     */
    setUser(patch) {
      Object.assign(user, patch || {});
      return this;
    },

    /** 直接發一枚有效 token（略過登入往返）。 */
    grantToken(token) {
      state.token = token || issueToken();
      state.accountDeleted = false;
      return state.token;
    },

    /** 目前雲端卡片（依 postKey）。 */
    linkByPostKey(cleanedUrl) {
      const row = state.links.get(postKeyOf(cleanedUrl));
      return row ? publicItem(row) : null;
    },
    linkCount() {
      return state.links.size;
    },
    tombstoneCount() {
      return state.tombstones.size;
    },
    clearedAt() {
      return state.clearedAt;
    },

    /** 側錄查詢：最後一次請求／依路徑過濾。 */
    lastRequest() {
      return requests[requests.length - 1] || null;
    },
    requestsTo(path, method) {
      return requests.filter((r) => r.path === path && (!method || r.method === method.toUpperCase()));
    },
  };
}

module.exports = {
  createMockSyncServer,
  // 協定常數也一併外露，測試不重複硬編（api-spec 7.2:719-732）。
  MAX_SYNC_UPSERTS,
  MAX_SYNC_DELETES,
  MAX_SYNC_SEEN_ROWS,
  SEEN_MAX,
  CHANGES_LIMIT,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  FREE_QUOTA,
  RATE_LIMIT_MAX,
  RATE_LIMIT_PERIOD_MS,
  DEVICE_PLATFORMS,
  DEVICE_NAME_MAX,
  MAX_DEVICES,
  DEVICE_LAST_SEEN_THROTTLE_MS,
  isJsonContentType,
  normalizeDeviceId,
  normalizeDeviceName,
  normalizeItem,
  mergeItem,
  encodeCursor,
  decodeSince,
};
