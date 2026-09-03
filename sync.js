// sync.js — 雲端同步引擎:認證狀態機、推拉往返、退避與 alarms 排程。
// 載入環境比照 tcl-core.js／auth.js:
//   - service worker:background.js 以 importScripts('sync.js') 載入(全域 self)
//   - Node 測試:CommonJS require
//
// 全部外部依賴一律由 create() 注入(storage／fetch／now／alarms／broadcast／
// auth／permissions／randomUUID／writeChain／setTimeout／clearTimeout)，模組本
// 身不碰全域 chrome／fetch／Date——SW 隨時被回收，測試要能在 node 內以假時鐘
// 跑完整往返，兩者都靠這條紀律。
//
// history 的讀改寫一律包進注入的 writeChain(background.js 的
// historyWriteChain)，與 recordHistory／遷移共用同一條序列鏈，否則兩邊的
// read-modify-write 會互相覆蓋。
(function (root) {
  'use strict';

  var TCLCoreRef =
    root.TCLCore ||
    (typeof module !== 'undefined' && module.exports && typeof require === 'function'
      ? require('./tcl-core.js')
      : null);

  // ---- 協定與排程常數 ----

  // D9:apiBase 只有這三個合法值，syncApiBase 覆寫成其他值一律忽略——
  // 覆寫鍵是 storage.local 的普通鍵，被寫入任意 origin 就等於把 bearer
  // token 送去別人家。local 指向開發機自己跑的 wrangler dev，只有
  // tools/dev-browser.mjs 產出的 manifest 副本才宣告 localhost 的 host
  // 權限，商店版連要求該權限都做不到，因此白名單多這一項不擴大攻擊面。
  var API_BASE_PRODUCTION = 'https://api.metalinkclearer.workers.dev';
  var API_BASE_STAGING = 'https://api-staging.metalinkclearer.workers.dev';
  var API_BASE_LOCAL = 'http://localhost:8787';
  var API_BASE_ALLOWED = [API_BASE_PRODUCTION, API_BASE_STAGING, API_BASE_LOCAL];

  // D5:Google Web client(公開值)。後端把 staging 與 production 的 client
  // 分家了，插件必須依 apiBase 送對應的 client_id，否則 id_token 的 aud
  // 對不上該環境的驗證清單。local 沒有自己的 client——本機後端的
  // .dev.vars 仍設定舊(production)client，因此併到 production 那組。
  var CLIENT_ID_PRODUCTION = '17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com';
  var CLIENT_ID_STAGING = '17054024593-846tl3brfgd5f09ouavituflf5b7v6qi.apps.googleusercontent.com';
  var CLIENT_ID_BY_API_BASE = {};
  CLIENT_ID_BY_API_BASE[API_BASE_PRODUCTION] = CLIENT_ID_PRODUCTION;
  CLIENT_ID_BY_API_BASE[API_BASE_STAGING] = CLIENT_ID_STAGING;
  CLIENT_ID_BY_API_BASE[API_BASE_LOCAL] = CLIENT_ID_PRODUCTION;

  // D12:週期 alarm 不低於 1 分鐘(MV3 硬性下限)，新紀錄去抖 2 秒。
  var ALARM_NAME = 'tcl-sync';
  var SYNC_PERIOD_MINUTES = 5;
  var DEBOUNCE_MS = 2000;
  // 去抖的保底 alarm:SW 可能在 2 秒內就被回收，setTimeout 會跟著消失。
  // Chrome 的 alarm 最小間隔是 30 秒，2 秒排不出來，因此排 30 秒保底;名稱
  // 必須與週期 alarm 不同——同名建立會把週期排程整個蓋掉。
  var DEBOUNCE_ALARM_NAME = 'tcl-sync-debounce';
  var DEBOUNCE_GUARD_MS = 30000;

  // 退避曲線逐字對齊手機端 src/lib/sync/scheduler.ts 的 pollIntervalFor:
  // 30s(正常)→ 30s(第一次失敗，刻意不加倍)→ 60s → 120s → 240s → 480s →
  // 600s(封頂)。一瞬間的失敗不值得把使用者的下一次同步推遲一分鐘。
  var POLL_INTERVAL_MS = 30000;
  var POLL_BACKOFF_MAX_MS = 600000;

  // api-spec 7.2 的單次請求上限。upserts 筆數與 seen 總筆數是兩條獨立的切批
  // 條件，只看其中一條會在「少量卡片但每張 seen 很長」時撞 422 too_many_seen。
  var MAX_UPSERTS = 50;
  var MAX_DELETES = 50;
  var MAX_SEEN_ROWS = 250;

  // hasMore 續拉的迴圈上限:游標每頁必定嚴格前進，但伺服器若因故不前進，
  // 這道保險讓一輪同步不會無限打下去。
  var MAX_PULL_ROUNDS = 20;

  // storage.local 的鍵(計劃 4.2)。syncBackoff 是排程狀態:連續失敗次數必須
  // 落地，否則 SW 每次被殺退避就重來，等於沒有退避。
  var HISTORY_KEY = 'history';
  var STATE_KEY = 'syncState';
  var AUTH_KEY = 'syncAuth';
  var API_BASE_KEY = 'syncApiBase';
  var BACKOFF_KEY = 'syncBackoff';
  var VERIFIED_AT_KEY = 'syncVerifiedAt';

  // storage.session 的鍵。單飛旗標刻意存 session 而非 local:SW 被殺時
  // session 自然消失，旗標不會永久卡死同步;另加時效當第二道保險。
  var INFLIGHT_KEY = 'syncInflight';
  var NONCE_KEY = 'syncNonce';
  var DEBOUNCE_KEY = 'syncDebounce';
  var INFLIGHT_TTL_MS = 120000;

  // get-session 的節流:SW 每次被喚醒都會啟動驗一次，而喚醒在瀏覽期間非常
  // 頻繁（每一則訊息、每一個 alarm）。60 次／60 秒的限流桶與手機端共用，
  // 光是驗 session 就能把它吃光，因此距上次驗證未滿此間隔就跳過。
  var VERIFY_THROTTLE_MS = 5 * 60000;

  // getState 順手補一次同步的門檻(options／popup 開啟時)。低於此值就不打，
  // 避免每次開頁都吃掉 60 次／60 秒的限流額度(與手機端共用同一桶)。
  var STALE_MS = SYNC_PERIOD_MINUTES * 60000;

  // 「已登出」與「出錯」的分野:session_expired 描述的是一次正常的登出轉場
  // (token 到期／被撤銷)，UI 該顯示未登入卡片而非錯誤;其餘 lastError 都是
  // 真的出了事，狀態為 error。
  var SIGNED_OUT_ERRORS = ['session_expired'];

  // 重試永遠不會成功的錯誤:forbidden_origin 是「沒帶 Bearer 且來源不對」，
  // 亦即程式錯誤或後端 allowlist 設定錯誤（契約第 7 點明寫「別重試」）。
  // 這一類只記錯誤碼，不進退避曲線、也不排下一次 alarm——排了只是每隔幾分鐘
  // 用同一份必然失敗的請求去敲限流桶。
  var FATAL_ERRORS = ['forbidden_origin'];

  function pollIntervalFor(failures) {
    if (failures <= 0) return POLL_INTERVAL_MS;
    return Math.min(POLL_INTERVAL_MS * Math.pow(2, failures - 1), POLL_BACKOFF_MAX_MS);
  }

  function defaultCodeFor(status) {
    if (status === 400) return 'bad_request';
    if (status === 403) return 'forbidden_origin';
    if (status === 415) return 'unsupported_media_type';
    if (status === 422) return 'unprocessable';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'misconfigured';
    return 'internal_error';
  }

  function syncError(code) {
    var err = new Error(code);
    err.code = code;
    return err;
  }

  // 這張卡「最新的一次事件」時間。伺服器以此判定早於 clearedAt／墓碑的舊
  // 資料(api-spec 4.3 規則 2、3)，本機套用雲端水位線時必須用同一個判準。
  function eventTimeOf(entry) {
    var latest = typeof entry.receivedAt === 'number' && isFinite(entry.receivedAt) ? entry.receivedAt : 0;
    var seen = Array.isArray(entry.seen) ? entry.seen : [];
    for (var i = 0; i < seen.length; i += 1) {
      if (seen[i] && typeof seen[i].at === 'number' && seen[i].at > latest) latest = seen[i].at;
    }
    return latest;
  }

  function keyOfEntry(entry) {
    if (typeof entry.postKey === 'string' && entry.postKey) return entry.postKey;
    return TCLCoreRef.postKeyOf(entry.url);
  }

  function keyOfItem(item) {
    var url = TCLCoreRef.normalizePostUrl(item.cleaned) || item.cleaned;
    return TCLCoreRef.postKeyOf(url);
  }

  function isTombstone(entry) {
    return typeof entry.deletedAt === 'number' && isFinite(entry.deletedAt);
  }

  // chrome.storage 的容量配額錯誤（與 background.js 的同名判定同一條規則）。
  function isQuotaExceededError(err) {
    var message = (err && err.message) || String(err || '');
    return /QUOTA_BYTES/i.test(message);
  }

  function finiteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  /**
   * 這筆 entry 送得上雲嗎?判準逐條對齊伺服器的 normalizeItem(api-spec 3.1):
   * 缺 id／original／cleaned，或 receivedAt 不是有限正數，整筆會被**靜默丟棄**
   * ——不進 applied 也不進 rejectedIds。送這種資料上去等於永遠拿不到 ack，
   * dirty 清不掉，每一輪重送一次，活鎖。損毀資料經遷移後真的可能長成這樣
   * (receivedAt 為 null)，所以在 outbox 這一關就攔下來。
   */
  function isUploadable(entry) {
    if (typeof entry.id !== 'string' || entry.id.length < 1 || entry.id.length > 64) return false;
    if (typeof entry.url !== 'string' || TCLCoreRef.normalizePostUrl(entry.url) === null) return false;
    return finiteNumber(entry.receivedAt) && entry.receivedAt > 0;
  }

  /** 墓碑只送 id;伺服器對 deletes 的要求是長度 1-64 的字串。 */
  function isDeletable(entry) {
    return typeof entry.id === 'string' && entry.id.length >= 1 && entry.id.length <= 64;
  }

  /**
   * 雲端 item 的形狀閘門。TCLCore.fromSyncItem 是純映射、不做輸入驗證，形狀
   * 不對的欄位會原樣寫進 entry;而 options 讀取端的 sanitizeEntries 是有損
   * 閘門(url 無法正規化／at 非有限數字／kind 不在白名單就整筆丟掉)，寫進去
   * 的壞資料會在使用者眼前直接消失。信任邊界在這裡:後端回來的東西一律先驗。
   */
  function acceptIncomingItem(item) {
    if (!item || typeof item !== 'object') return false;
    if (typeof item.id !== 'string' || item.id.length < 1) return false;
    if (typeof item.cleaned !== 'string' || TCLCoreRef.normalizePostUrl(item.cleaned) === null) return false;
    return finiteNumber(item.receivedAt);
  }

  /**
   * 合併結果的收尾整形:核心欄位(url／at)不合格就整筆不收，選填欄位型別不對
   * 就丟掉該欄。判準與 options 的 sanitizeEntries 一致，避免「同步寫得進去、
   * 頁面讀不出來」的分岔。
   */
  function repairMergedEntry(entry) {
    if (!entry || typeof entry.url !== 'string' || TCLCoreRef.normalizePostUrl(entry.url) === null) return null;
    if (!finiteNumber(entry.at)) return null;
    if (!finiteNumber(entry.receivedAt)) entry.receivedAt = entry.at;
    entry.seen = TCLCoreRef.sanitizeSeenList(entry.seen);
    ['author', 'handle', 'excerpt', 'original'].forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(entry, key) && typeof entry[key] !== 'string') {
        delete entry[key];
      }
    });
    if (Object.prototype.hasOwnProperty.call(entry, 'removedParams')) {
      var params = TCLCoreRef.sanitizeRemovedParams(entry.removedParams);
      if (params === undefined) delete entry.removedParams;
      else entry.removedParams = params;
    }
    return entry;
  }

  /**
   * 建立一台同步引擎。所有依賴注入，見檔頭。
   */
  function create(deps) {
    var storage = deps.storage;
    var fetchImpl = deps.fetch;
    var now = deps.now;
    var alarms = deps.alarms;
    var broadcast = typeof deps.broadcast === 'function' ? deps.broadcast : function () {};
    var auth = deps.auth;
    var permissions = deps.permissions;
    var randomUUID = deps.randomUUID;
    var writeChain = typeof deps.writeChain === 'function' ? deps.writeChain : function (fn) {
      return Promise.resolve().then(fn);
    };
    // 容量上限:由 background 注入 capHistoryForStorage（位元組軟預算＋筆數硬
    // 保險，並優先淘汰墓碑）。拉取是唯一會把 history 變長的寫入路徑，沒有這
    // 一道就會在雲端資料多於本機上限時直接把 storage 寫爆。
    var capHistory = typeof deps.capHistory === 'function' ? deps.capHistory : function (list) {
      return list;
    };
    var setTimer = deps.setTimeout;
    var clearTimer = deps.clearTimeout;

    // 同一個 SW 實例內的單飛:三次 syncNow 同時進來時共用同一個 promise。
    // 跨實例的單飛靠 session 旗標(claimInflight)。
    var inflight = null;
    // 去抖計時器 handle(SW 存活期路徑)，只留最後一次排程。
    var debounceTimer = null;

    // ---- storage 小工具 ----

    function localGet(defaults) {
      return Promise.resolve(storage.local.get(defaults));
    }
    function localSet(items) {
      return Promise.resolve(storage.local.set(items));
    }
    function sessionGet(defaults) {
      return Promise.resolve(storage.session.get(defaults));
    }
    function sessionSet(items) {
      return Promise.resolve(storage.session.set(items));
    }
    function sessionRemove(keys) {
      return Promise.resolve(storage.session.remove(keys));
    }

    function readHistory() {
      var defaults = {};
      defaults[HISTORY_KEY] = [];
      return localGet(defaults).then(function (got) {
        return Array.isArray(got && got[HISTORY_KEY]) ? got[HISTORY_KEY] : [];
      });
    }

    /** 讀出這一輪需要的全部持久狀態(不含 history)。 */
    function loadContext() {
      var defaults = {};
      defaults[STATE_KEY] = null;
      defaults[AUTH_KEY] = null;
      defaults[API_BASE_KEY] = null;
      defaults[BACKOFF_KEY] = null;
      defaults[VERIFIED_AT_KEY] = null;
      return localGet(defaults).then(function (got) {
        var authRecord = got[AUTH_KEY];
        var backoff = got[BACKOFF_KEY];
        return {
          state: TCLCoreRef.normalizeSyncState(got[STATE_KEY]),
          token:
            authRecord && typeof authRecord.token === 'string' && authRecord.token
              ? authRecord.token
              : null,
          apiBase:
            API_BASE_ALLOWED.indexOf(got[API_BASE_KEY]) === -1
              ? API_BASE_PRODUCTION
              : got[API_BASE_KEY],
          failures: backoff && typeof backoff.failures === 'number' ? backoff.failures : 0,
          verifiedAt: finiteNumber(got[VERIFIED_AT_KEY]) ? got[VERIFIED_AT_KEY] : null,
        };
      });
    }

    function saveState(state) {
      var items = {};
      items[STATE_KEY] = TCLCoreRef.normalizeSyncState(state);
      return localSet(items);
    }

    function saveToken(token) {
      var items = {};
      items[AUTH_KEY] = { token: token };
      return localSet(items);
    }

    function saveFailures(failures) {
      var items = {};
      items[BACKOFF_KEY] = { failures: failures };
      return localSet(items);
    }

    // ---- 狀態與廣播(計劃 5.2／5.3) ----

    function statusOf(ctx) {
      if (!ctx.token) {
        var code = ctx.state.lastError;
        return code && SIGNED_OUT_ERRORS.indexOf(code) === -1 ? 'error' : 'signed_out';
      }
      if (inflight) return 'syncing';
      return ctx.state.lastError ? 'error' : 'signed_in';
    }

    function buildState(ctx, history, statusOverride) {
      var pending = 0;
      for (var i = 0; i < history.length; i += 1) {
        if (history[i] && history[i].dirty === true) pending += 1;
      }
      return {
        status: statusOverride || statusOf(ctx),
        email: ctx.state.email,
        // D15:帳號入口顯示用，已經過 tcl-core.js 的 sanitize 把關(見
        // finishSignIn／runVerify),UI 端不必再驗一次。
        displayName: ctx.state.displayName,
        avatarUrl: ctx.state.avatarUrl,
        lastSyncedAt: ctx.state.lastSyncedAt,
        pendingCount: pending,
        lastError: ctx.state.lastError,
        apiBase: ctx.apiBase,
      };
    }

    function emitState(ctx, history, statusOverride) {
      broadcast({ type: 'sync.stateChanged', state: buildState(ctx, history, statusOverride) });
    }

    /** 讀最新持久狀態，組出計劃 5.2 形狀並廣播。 */
    function broadcastState(statusOverride) {
      return loadContext().then(function (ctx) {
        return readHistory().then(function (history) {
          emitState(ctx, history, statusOverride);
        });
      });
    }

    // ---- HTTP ----

    /**
     * 打一次後端。契約:credentials 一律 omit(D1，不夾帶 cookie)、Bearer、
     * 有 body 才帶 application/json(否則後端回 415)。任何回應帶
     * set-auth-token 就覆寫本地 token(插件端契約第 3 點)。
     */
    function call(ctx, method, path, body) {
      // redirect:'error' — 後端不該對這些端點回 3xx。放任 fetch 自動跟隨，
      // 轉址後那一站的回應照樣會被下面當成後端回應處理（包含採信它的
      // set-auth-token 標頭），等於把 token 的來源交給任何能讓後端轉址的人。
      var init = { method: method, credentials: 'omit', headers: {}, redirect: 'error' };
      init.headers.Authorization = 'Bearer ' + ctx.token;
      if (body !== undefined) {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      var res;
      return Promise.resolve()
        .then(function () {
          return fetchImpl(ctx.apiBase + path, init);
        })
        .catch(function () {
          throw syncError('network_error');
        })
        .then(function (response) {
          res = response;
          return Promise.resolve(res.json()).catch(function () {
            return null;
          });
        })
        .then(function (payload) {
          var rotated = res.headers && typeof res.headers.get === 'function'
            ? res.headers.get('set-auth-token')
            : null;
          var carry = rotated ? saveToken(rotated) : Promise.resolve();
          if (rotated) ctx.token = rotated;
          return carry.then(function () {
            if (res.status === 401) throw syncError('session_expired');
            if (!res.ok) throw httpError(res, payload);
            return payload;
          });
        });
    }

    function httpError(res, payload) {
      var code =
        payload && typeof payload.error === 'string' && payload.error
          ? payload.error
          : defaultCodeFor(res.status);
      var err = syncError(code);
      var header = res.headers && typeof res.headers.get === 'function' ? res.headers.get('retry-after') : null;
      var seconds = header !== null && header !== undefined && isFinite(Number(header)) ? Number(header) : null;
      if (seconds === null && payload && typeof payload.retryAfter === 'number' && isFinite(payload.retryAfter)) {
        seconds = payload.retryAfter;
      }
      if (typeof seconds === 'number' && isFinite(seconds) && seconds > 0) err.retryAfterMs = seconds * 1000;
      return err;
    }

    // ---- 切批(api-spec 7.2) ----

    /**
     * @returns {{batches: object[], dropped: string[]}} dropped 是送不上雲的
     *   entry id(見 isUploadable):它們的 dirty 必須就地清掉，否則每一輪重送
     *   一次卻永遠等不到 ack。
     */
    function buildBatches(history) {
      var upserts = [];
      var deletes = [];
      var dropped = [];
      history.forEach(function (entry) {
        if (!entry || entry.dirty !== true) return;
        if (isTombstone(entry)) {
          if (isDeletable(entry)) deletes.push(entry.id);
          else if (typeof entry.id === 'string') dropped.push(entry.id);
          return;
        }
        if (!isUploadable(entry)) {
          if (typeof entry.id === 'string') dropped.push(entry.id);
          return;
        }
        upserts.push(TCLCoreRef.toSyncItem(entry));
      });

      var batches = [];
      var current = null;
      function open() {
        if (!current) current = { upserts: [], deletes: [], seenRows: 0 };
      }
      function flush() {
        if (current) batches.push(current);
        current = null;
      }
      upserts.forEach(function (item) {
        var rows = Array.isArray(item.seen) ? item.seen.length : 0;
        if (current && (current.upserts.length + 1 > MAX_UPSERTS || current.seenRows + rows > MAX_SEEN_ROWS)) {
          flush();
        }
        open();
        current.upserts.push(item);
        current.seenRows += rows;
      });
      deletes.forEach(function (id) {
        if (current && current.deletes.length + 1 > MAX_DELETES) flush();
        open();
        current.deletes.push(id);
      });
      flush();
      // 沒有待推的東西也要發一次:一次往返同時處理推與拉，少發這一次就拉不
      // 到別台裝置的新資料。
      if (!batches.length) batches.push({ upserts: [], deletes: [], seenRows: 0 });
      return { batches: batches, dropped: dropped };
    }

    /** 把送不上雲的 entry 就地標乾淨(本機資料保留，只是不再嘗試上傳)。 */
    function dropUnsendable(ids) {
      if (!ids.length) return Promise.resolve();
      var drop = {};
      ids.forEach(function (id) {
        drop[id] = true;
      });
      return writeChain(function () {
        return readHistory().then(function (list) {
          var next = list.map(function (entry) {
            return entry && drop[entry.id] && entry.dirty === true
              ? Object.assign({}, entry, { dirty: false })
              : entry;
          });
          var items = {};
          items[HISTORY_KEY] = next;
          return localSet(items);
        });
      });
    }

    // ---- 套用一次往返的回應 ----

    /**
     * 把 applied(ack)與 changes(增量)套回本機 history。整段讀改寫包在注入
     * 的 writeChain 內，與 recordHistory 串行。
     *
     * 【只清本輪快照】ack 一律以「伺服器回報的 id」比對，往返期間 recordHistory
     * 新寫入的 entry 不在回應裡，自然保持 dirty，下一輪才上雲。
     */
    function applyResponse(body) {
      return writeChain(function () {
        return readHistory().then(function (list) {
          var applied = (body && body.applied) || {};
          var canonical = {};
          var deletedIds = {};
          var rejectedIds = {};
          (applied.upserts || []).forEach(function (row) {
            if (row && typeof row.id === 'string') {
              canonical[row.id] = typeof row.canonicalId === 'string' && row.canonicalId ? row.canonicalId : row.id;
            }
          });
          (applied.deletedIds || []).forEach(function (id) {
            if (typeof id === 'string') deletedIds[id] = true;
          });
          (applied.rejectedIds || []).forEach(function (id) {
            if (typeof id === 'string') rejectedIds[id] = true;
          });

          var stamp = now();
          var next = [];
          list.forEach(function (entry) {
            if (!entry) return;
            // 墓碑被 ack 之後才真正從 storage 移除，在此之前必須保留——SW 中途
            // 被殺時墓碑還在，下次照樣送得出去。
            if (isTombstone(entry) && deletedIds[entry.id]) return;
            if (canonical[entry.id] !== undefined) {
              next.push(
                Object.assign({}, entry, {
                  // canonicalId:雲端同一篇貼文早有一張卡時就地改名，否則下
                  // 次同步又分裂一張。
                  id: canonical[entry.id],
                  dirty: false,
                  // serverUpdatedAt 只是「這一輪已上傳」的標記，不是比較用的
                  // 判準——後端契約(api-spec 3.1)的 ShareHistoryItem 沒有
                  // updatedAt 欄位。新舊一律以 SyncResponse.cursor 與 changes
                  // 為準，本欄不參與任何比較。
                  serverUpdatedAt: stamp,
                })
              );
              return;
            }
            if (rejectedIds[entry.id]) {
              // 拒收的原因一律是「這筆事件早於雲端的清空水位線或墓碑」，原樣
              // 重送永遠會被再拒一次。清掉 dirty 讓它停在本機，不無限重試。
              next.push(Object.assign({}, entry, { dirty: false }));
              return;
            }
            next.push(entry);
          });

          var changes = body && body.changes;
          if (changes) {
            if (typeof changes.clearedAt === 'number' && isFinite(changes.clearedAt)) {
              // 別台裝置清空了雲端:早於水位線的本機紀錄一併硬刪。
              next = next.filter(function (entry) {
                return eventTimeOf(entry) > changes.clearedAt;
              });
            }
            var tombKeys = {};
            var tombIds = {};
            (changes.deleted || []).forEach(function (row) {
              if (!row) return;
              if (typeof row.postKey === 'string') tombKeys[row.postKey] = true;
              if (typeof row.id === 'string') tombIds[row.id] = true;
            });
            if (changes.deleted && changes.deleted.length) {
              // 雲端墓碑在本機是硬刪，不是再留一個本機墓碑——留下來會被下一輪
              // 當成待送出的刪除意圖再送一次。
              next = next.filter(function (entry) {
                return !(tombKeys[keyOfEntry(entry)] || tombIds[entry.id]);
              });
            }
            (changes.links || []).forEach(function (item) {
              if (!acceptIncomingItem(item)) return;
              var key = keyOfItem(item);
              var index = -1;
              for (var i = 0; i < next.length; i += 1) {
                if (keyOfEntry(next[i]) === key) {
                  index = i;
                  break;
                }
              }
              var merged = repairMergedEntry(
                TCLCoreRef.fromSyncItem(item, index === -1 ? null : next[index])
              );
              // 整形後仍不合格就維持本機原樣(有既有卡)或整筆不收(沒有):寫進
              // 一筆 options 讀不出來的資料，比不寫更糟。
              if (!merged) return;
              if (index === -1) next.push(merged);
              else next[index] = merged;
            });
          }

          next.sort(function (a, b) {
            return (b.at || 0) - (a.at || 0);
          });
          var items = {};
          items[HISTORY_KEY] = capHistory(next);
          return localSet(items).catch(function (err) {
            // 配額爆掉不是「這一輪失敗、下一輪重來就好」而已:游標一旦前進，
            // 這一頁的增量就再也拉不回來。改成拋出可辨識的錯誤碼，由 runSync
            // 統一記 lastError 並排退避，游標留在原地下一輪重拉同一頁。
            throw syncError(isQuotaExceededError(err) ? 'storage_quota' : 'storage_write_failed');
          });
        });
      });
    }

    // ---- 一輪推拉往返 ----

    function runRound(ctx) {
      var chain = Promise.resolve();

      // 「清除全部」的雲端語意就是 DELETE /api/v1/links(api-spec 4.4):伺服器
      // 自己寫 cleared_at。必須早於推送，否則剛推上去的資料立刻被自己清掉。
      if (ctx.state.clearedAt !== null) {
        chain = chain
          .then(function () {
            return call(ctx, 'DELETE', '/api/v1/links');
          })
          .then(function () {
            ctx.state.clearedAt = null;
            // 舊游標對清空後的雲端已無意義，歸零重拉。
            ctx.state.cursor = null;
            return saveState(ctx.state);
          });
      }

      var lastChanges = null;

      chain = chain
        .then(readHistory)
        .then(function (history) {
          // 「開始同步」的廣播沿用這一次已經讀好的 ctx 與 history:SW 隨時會
          // 被殺，第一次請求要盡快發出去，不為了一則廣播多跑兩趟 storage。
          emitState(ctx, history, 'syncing');
          var planned = buildBatches(history);
          var step = dropUnsendable(planned.dropped);
          planned.batches.forEach(function (batch) {
            step = step.then(function () {
              var body = {
                upserts: batch.upserts,
                deletes: batch.deletes,
                // cursor 為 null 的首輪送 '0':api-spec 4.3 明訂不帶 since 就
                // 不回增量，首次登入會永遠拉不到雲端既有資料。
                since: ctx.state.cursor === null ? '0' : ctx.state.cursor,
              };
              return call(ctx, 'POST', '/api/v1/links/sync', body).then(function (payload) {
                // 【順序】游標必須等 applyResponse 真的落地才前進。反過來的話，
                // 寫入失敗（配額、storage 壞掉）時失敗路徑的 saveState 會把已
                // 前進的游標寫進去，這一頁的增量從此再也拉不回來——伺服器只認
                // 游標，不會重送。
                return applyResponse(payload).then(function () {
                  if (payload && typeof payload.cursor === 'string') ctx.state.cursor = payload.cursor;
                  lastChanges = payload ? payload.changes : null;
                });
              });
            });
          });
          return step;
        })
        .then(function () {
          // hasMore:積壓要在同一輪拉完，不能等下一個 alarm。
          var rounds = 0;
          function more() {
            if (!lastChanges || !lastChanges.hasMore || rounds >= MAX_PULL_ROUNDS) return Promise.resolve();
            rounds += 1;
            return call(ctx, 'POST', '/api/v1/links/sync', { since: ctx.state.cursor }).then(function (payload) {
              // 同上:先落地再前進游標。
              return applyResponse(payload).then(function () {
                if (payload && typeof payload.cursor === 'string') ctx.state.cursor = payload.cursor;
                lastChanges = payload ? payload.changes : null;
                return more();
              });
            });
          }
          return more();
        });

      return chain;
    }

    // ---- 單飛旗標 ----

    function claimInflight() {
      var defaults = {};
      defaults[INFLIGHT_KEY] = null;
      return sessionGet(defaults).then(function (got) {
        var record = got[INFLIGHT_KEY];
        // 時效是第二道保險:SW 在往返途中被殺時 session 通常整區消失，但萬一
        // 旗標留了下來，過期後照樣解除，不讓同步永久卡死。
        if (record && typeof record.at === 'number' && now() - record.at < INFLIGHT_TTL_MS) {
          return false;
        }
        var items = {};
        items[INFLIGHT_KEY] = { at: now() };
        return sessionSet(items).then(function () {
          return true;
        });
      });
    }

    function releaseInflight() {
      return sessionRemove(INFLIGHT_KEY).catch(function () {});
    }

    // ---- 排程 ----

    function scheduleSuccess() {
      alarms.create(ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });
      return saveFailures(0);
    }

    function scheduleBackoff(failures, retryAfterMs) {
      var delay = typeof retryAfterMs === 'number' && isFinite(retryAfterMs) && retryAfterMs > 0
        ? retryAfterMs
        : pollIntervalFor(failures);
      alarms.create(ALARM_NAME, { when: now() + delay });
      return saveFailures(failures);
    }

    // ---- 登出／失效 ----

    /** token 失效的統一出口:清 token、狀態回預設、停掉週期 alarm。 */
    function handleSessionExpired() {
      return saveToken(null)
        .then(function () {
          return saveState({ lastError: 'session_expired' });
        })
        .then(function () {
          // 週期與去抖保底兩支都要清:留著去抖 alarm 會在登出後照樣喚醒 SW，
          // 白跑一輪什麼也做不了。
          return Promise.all([
            Promise.resolve(alarms.clear(ALARM_NAME)).catch(function () {}),
            Promise.resolve(alarms.clear(DEBOUNCE_ALARM_NAME)).catch(function () {}),
          ]);
        })
        .then(function () {
          return broadcastState('signed_out');
        });
    }

    // ---- 對外介面 ----

    function getState() {
      return loadContext().then(function (ctx) {
        return readHistory().then(function (history) {
          var state = buildState(ctx, history);
          // options／popup 開啟時順手補一次(D12)。fire-and-forget:狀態以廣播
          // 回傳，這裡不等它跑完，也不因它失敗而讓 getState 失敗。
          if (ctx.token && (ctx.state.lastSyncedAt === null || now() - ctx.state.lastSyncedAt >= STALE_MS)) {
            syncNow().catch(function () {});
          }
          return state;
        });
      });
    }

    function signIn() {
      return loadContext().then(function (ctx) {
        var descriptor = auth.permissionsFor(ctx.apiBase);
        return Promise.resolve(permissions.contains(descriptor)).then(function (granted) {
          if (!granted) {
            // SW 端只探不求:chrome.permissions.request 必須在使用者手勢內
            // 呼叫，SW 自行發起一律失敗。請求端在 options 頁的登入按鈕。
            ctx.state.lastError = 'permission_required';
            return saveState(ctx.state).then(function () {
              return broadcastState('error');
            });
          }
          // clientId 依 apiBase 對應(D5):白名單只有三個 apiBase，理論上
          // 這裡不可能找不到，但找不到就代表 CLIENT_ID_BY_API_BASE 漏配，
          // 拒絕登入好過拿錯 client 的 id_token 去撞後端的 aud 檢查。
          var clientId = CLIENT_ID_BY_API_BASE[ctx.apiBase];
          if (typeof clientId !== 'string' || !clientId) {
            ctx.state.lastError = 'client_id_missing';
            return saveState(ctx.state).then(function () {
              return broadcastState('error');
            });
          }
          // nonce 由引擎生成並落 chrome.storage.session，授權往返期間 SW 若
          // 被回收，回來仍比對得出這一次的 nonce（擋重放）。
          var nonce = randomUUID();
          var items = {};
          items[NONCE_KEY] = nonce;
          return sessionSet(items)
            .then(function () {
              return auth.signInWithGoogle({ clientId: clientId, apiBase: ctx.apiBase, nonce: nonce });
            })
            .then(function (result) {
              // auth 模組是「本次授權實際用了哪枚 nonce」的權威（launch 時傳
              // 進去的那枚已由它比對過 id_token payload），以它回傳的值寫回
              // session。
              var effective = typeof result.nonce === 'string' && result.nonce ? result.nonce : nonce;
              var record = {};
              record[NONCE_KEY] = effective;
              return sessionSet(record)
                .then(function () {
                  // 送出前真的從 session 讀回來對一次。session 是這枚 nonce 的
                  // 權威存放處;寫進去又沒讀回來的話，這段往返只是裝飾——SW 被
                  // 回收重建時也是靠這裡的值，讀不回同一枚就代表狀態已經不可信。
                  var want = {};
                  want[NONCE_KEY] = null;
                  return sessionGet(want);
                })
                .then(function (stored) {
                  if (stored[NONCE_KEY] !== effective) throw syncError('nonce_mismatch');
                  return auth
                    .exchangeWithBackend({ apiBase: ctx.apiBase, idToken: result.idToken, nonce: stored[NONCE_KEY] })
                    .then(function (exchange) {
                      return finishSignIn(ctx, result, exchange);
                    });
                });
            })
            .catch(function (err) {
              ctx.state.lastError = err && err.code ? err.code : 'sign_in_failed';
              return saveState(ctx.state).then(function () {
                return broadcastState('error');
              });
            });
        });
      });
    }

    function finishSignIn(ctx, result, exchange) {
      if (!exchange || !exchange.ok || !exchange.authToken) {
        throw syncError(
          exchange && exchange.body && typeof exchange.body.error === 'string'
            ? exchange.body.error
            : 'sign_in_failed'
        );
      }
      var user = (exchange.body && exchange.body.user) || {};
      var userId = typeof user.id === 'string' ? user.id : null;
      var email = typeof user.email === 'string' ? user.email : result.email || null;
      // D15 來源優先序:後端 sign-in/social 回應的 user.name／user.image 優
      // 先;缺席才退回 id_token payload(result.payload)的 name／picture。
      // payload 由 auth.js 驗過 aud／nonce／iss／exp，是這次登入唯一另一個
      // 可信來源。兩欄一律經 sanitize 把關才落地(80 字元上限／
      // googleusercontent.com 白名單)。
      var claims = (result && result.payload) || {};
      var rawName = typeof user.name === 'string' ? user.name : claims.name;
      var rawAvatar = typeof user.image === 'string' ? user.image : claims.picture;
      var displayName = TCLCoreRef.sanitizeDisplayName(rawName);
      var avatarUrl = TCLCoreRef.sanitizeAvatarUrl(rawAvatar);
      // 帳號切換:上一位使用者的雲端鏡像欄位對新帳號毫無意義，全部重置成
      // 「本機新資料」，由這次登入重新全量上傳(比照手機端 active-owner)。
      var switched = ctx.state.userId !== null && userId !== null && ctx.state.userId !== userId;
      var reset = switched ? resetMirrorFields() : Promise.resolve();
      return reset
        .then(function () {
          return saveToken(exchange.authToken);
        })
        .then(function () {
          return saveState({ userId: userId, email: email, displayName: displayName, avatarUrl: avatarUrl });
        })
        .then(function () {
          alarms.create(ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });
          return sessionRemove(NONCE_KEY).catch(function () {});
        })
        .then(function () {
          return broadcastState('signed_in');
        })
        .then(function () {
          // 登入完成就跑一次:首次綁定的全量上傳(D3)與雲端既有資料的首輪拉
          // 取都在這一次完成，不必等第一個 alarm。
          return syncNow();
        });
    }

    /** 把 history 的雲端鏡像欄位重置成「未同步過的本機資料」。 */
    function resetMirrorFields() {
      return writeChain(function () {
        return readHistory().then(function (list) {
          var next = list.map(function (entry) {
            return Object.assign({}, entry, { dirty: true, serverUpdatedAt: null });
          });
          var items = {};
          items[HISTORY_KEY] = next;
          return localSet(items);
        });
      });
    }

    function signOut() {
      return loadContext().then(function (ctx) {
        var revoke = ctx.token
          ? call(ctx, 'POST', '/api/auth/sign-out', {}).catch(function () {})
          : Promise.resolve();
        // 後端 sign-out 失敗(503／斷網)也要完成本機清理:留著一枚可能已失效
        // 的 token 只會讓使用者卡在「看起來還登入著」。
        return revoke
          .then(resetMirrorFields)
          .then(function () {
            return saveToken(null);
          })
          .then(function () {
            return saveState(null);
          })
          .then(function () {
            return saveFailures(0);
          })
          .then(function () {
            return Promise.all([
              Promise.resolve(alarms.clear(ALARM_NAME)).catch(function () {}),
              Promise.resolve(alarms.clear(DEBOUNCE_ALARM_NAME)).catch(function () {}),
            ]);
          })
          .then(function () {
            return broadcastState('signed_out');
          });
      });
    }

    function verifySession() {
      return loadContext().then(function (ctx) {
        if (!ctx.token) return undefined;
        // 節流:SW 每次喚醒都會叫這支，距上次驗證未滿門檻就跳過（見
        // VERIFY_THROTTLE_MS）。token 真的失效時，任何 /api/v1/* 的 401 走的是
        // 同一條失效處理，不會因為跳過驗證而漏掉。
        if (ctx.verifiedAt !== null && now() - ctx.verifiedAt < VERIFY_THROTTLE_MS) return undefined;
        var stamp = {};
        stamp[VERIFIED_AT_KEY] = now();
        return localSet(stamp).then(function () {
          return runVerify(ctx);
        });
      });
    }

    function runVerify(ctx) {
      return Promise.resolve()
        .then(function () {
          return call(ctx, 'GET', '/api/auth/get-session');
        })
        .then(function (payload) {
          // api-spec 2.2:session 已被撤銷時回的是 200 ＋ null，不是 401。
          // 把 null 當成「還登入著」會讓失效的 token 一直留在本機。
          if (!payload || !payload.session) return handleSessionExpired();
          var user = payload.user || {};
          if (typeof user.id === 'string') ctx.state.userId = user.id;
          if (typeof user.email === 'string') ctx.state.email = user.email;
          // D15:驗 token 時用 get-session 回應更新一次。只在後端這次真的帶
          // 了該欄位才覆寫，缺席就沿用既有值(id_token 只在登入當下拿得到，
          // 這裡沒有第二個來源可退)。
          if (typeof user.name === 'string') ctx.state.displayName = TCLCoreRef.sanitizeDisplayName(user.name);
          if (typeof user.image === 'string') ctx.state.avatarUrl = TCLCoreRef.sanitizeAvatarUrl(user.image);
          return saveState(ctx.state).then(function () {
            return broadcastState();
          });
        })
        .catch(function (err) {
          if (err && err.code === 'session_expired') return handleSessionExpired();
          return undefined;
        });
    }

    function syncNow() {
      if (inflight) return inflight;
      inflight = runSync().then(
        function (value) {
          inflight = null;
          return value;
        },
        function (err) {
          inflight = null;
          throw err;
        }
      );
      return inflight;
    }

    function runSync() {
      var ctx;
      return loadContext()
        .then(function (loaded) {
          ctx = loaded;
          // 未登入是常態，不是錯誤:零請求、不廣播 error(D6)。
          if (!ctx.token) return false;
          return claimInflight();
        })
        .then(function (claimed) {
          if (!claimed) return undefined;
          return runRound(ctx)
            .then(function () {
              ctx.state.lastSyncedAt = now();
              ctx.state.lastError = null;
              return saveState(ctx.state)
                .then(scheduleSuccess)
                .then(function () {
                  return broadcastState('signed_in');
                });
            })
            .catch(function (err) {
              if (err && err.code === 'session_expired') return handleSessionExpired();
              var code = err && err.code ? err.code : 'internal_error';
              ctx.state.lastError = code;
              return saveState(ctx.state)
                .then(function () {
                  // 不可重試的錯誤只記碼，並且要把既有的週期 alarm 一起清掉:
                  // 只跳過 scheduleBackoff 是不夠的——登入成功那一輪建的
                  // periodInMinutes 重複 alarm 還在，403 之後就變成每 5 分鐘拿
                  // 同一份必然失敗的請求去敲 60 次／60 秒的限流桶（與手機端共
                  // 用同一桶）。使用者重新登入或手動同步時會重新建回來。
                  if (FATAL_ERRORS.indexOf(code) !== -1) {
                    return Promise.resolve(alarms.clear(ALARM_NAME)).catch(function () {});
                  }
                  return scheduleBackoff(ctx.failures + 1, err && err.retryAfterMs);
                })
                .then(function () {
                  return broadcastState('error');
                });
            })
            .then(function (value) {
              return releaseInflight().then(function () {
                return value;
              });
            });
        });
    }

    function deleteCloud() {
      return loadContext().then(function (ctx) {
        if (!ctx.token) return undefined;
        return call(ctx, 'DELETE', '/api/v1/links')
          .then(function () {
            // 本機紀錄原樣保留但全部標乾淨:刪完雲端若還留著 dirty，下一輪同步
            // 立刻把資料推回去，使用者的刪除等於完全無效。
            return writeChain(function () {
              return readHistory().then(function (list) {
                var next = list.map(function (entry) {
                  return Object.assign({}, entry, { dirty: false, serverUpdatedAt: null });
                });
                var items = {};
                items[HISTORY_KEY] = next;
                return localSet(items);
              });
            });
          })
          .then(function () {
            // 游標歸零:舊游標指向的增量在清空後的雲端已不存在。
            ctx.state.cursor = null;
            ctx.state.clearedAt = null;
            ctx.state.lastError = null;
            // D15:使用者主動刪雲端資料是明確的隱私動作，即便帳號仍保持登入
            // (userId／email 不動)，快取的名字與大頭照也一併清空，不留在本
            // 機造成「資料已刪但畫面還秀著」的錯覺。
            ctx.state.displayName = null;
            ctx.state.avatarUrl = null;
            return saveState(ctx.state);
          })
          .then(function () {
            return broadcastState('signed_in');
          })
          .catch(function (err) {
            if (err && err.code === 'session_expired') return handleSessionExpired();
            return loadContext().then(function (fresh) {
              fresh.state.lastError = err && err.code ? err.code : 'internal_error';
              return saveState(fresh.state).then(function () {
                return broadcastState('error');
              });
            });
          });
      });
    }

    // ---- 去抖(D12) ----

    /**
     * recordHistory 之後的掛鉤。雙保險:注入的 setTimeout 走 SW 存活期的 2 秒
     * 去抖，另排一個 30 秒的 alarm 當 SW 被回收時的保底;待辦旗標落 session，
     * 兩條路任一先到就清掉旗標並跑同步，另一條到期時看到旗標已清就不重跑。
     * 連續寫入只留最後一次排程(計時器與保底 alarm 一起重排)。
     */
    function notifyRecorded() {
      if (debounceTimer !== null) {
        clearTimer(debounceTimer);
        debounceTimer = null;
      }
      debounceTimer = setTimer(function () {
        debounceTimer = null;
        return fireDebounce();
      }, DEBOUNCE_MS);
      alarms.create(DEBOUNCE_ALARM_NAME, { when: now() + DEBOUNCE_GUARD_MS });
      var items = {};
      items[DEBOUNCE_KEY] = { at: now() };
      return sessionSet(items);
    }

    /** 認領去抖待辦。搶到才跑同步，另一條路到期時就會撲空。 */
    function claimDebounce() {
      var defaults = {};
      defaults[DEBOUNCE_KEY] = null;
      return sessionGet(defaults).then(function (got) {
        if (!got[DEBOUNCE_KEY]) return false;
        return sessionRemove(DEBOUNCE_KEY).then(function () {
          return true;
        });
      });
    }

    function fireDebounce() {
      return claimDebounce().then(function (claimed) {
        if (!claimed) return undefined;
        return Promise.resolve(alarms.clear(DEBOUNCE_ALARM_NAME))
          .catch(function () {})
          .then(function () {
            return syncNow();
          });
      });
    }

    function onAlarm(alarm) {
      if (!alarm || typeof alarm.name !== 'string') return Promise.resolve();
      if (alarm.name === DEBOUNCE_ALARM_NAME) {
        if (debounceTimer !== null) {
          clearTimer(debounceTimer);
          debounceTimer = null;
        }
        return fireDebounce();
      }
      // 別人的 alarm(其他功能、其他擴充的殘留)一律忽略。
      if (alarm.name !== ALARM_NAME) return Promise.resolve();
      return syncNow();
    }

    return {
      getState: getState,
      signIn: signIn,
      signOut: signOut,
      syncNow: syncNow,
      deleteCloud: deleteCloud,
      verifySession: verifySession,
      notifyRecorded: notifyRecorded,
      onAlarm: onAlarm,
    };
  }

  var api = {
    create: create,
    ALARM_NAME: ALARM_NAME,
    DEBOUNCE_ALARM_NAME: DEBOUNCE_ALARM_NAME,
    DEBOUNCE_MS: DEBOUNCE_MS,
    SYNC_PERIOD_MINUTES: SYNC_PERIOD_MINUTES,
    API_BASE_PRODUCTION: API_BASE_PRODUCTION,
    API_BASE_STAGING: API_BASE_STAGING,
    API_BASE_LOCAL: API_BASE_LOCAL,
    CLIENT_ID_PRODUCTION: CLIENT_ID_PRODUCTION,
    CLIENT_ID_STAGING: CLIENT_ID_STAGING,
    CLIENT_ID_BY_API_BASE: CLIENT_ID_BY_API_BASE,
    MAX_UPSERTS: MAX_UPSERTS,
    MAX_DELETES: MAX_DELETES,
    MAX_SEEN_ROWS: MAX_SEEN_ROWS,
    pollIntervalFor: pollIntervalFor,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLSync = api;
})(typeof self !== 'undefined' ? self : globalThis);
