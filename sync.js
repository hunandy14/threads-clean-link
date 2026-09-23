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
  // 舊版的兩把自清守衛鍵。清空水位線已廢除(D50)，這兩把鍵不再讀寫;登入與
  // 刪雲端時一併移除舊版殘留。
  var LEGACY_GUARD_KEYS = ['syncClearGuard', 'syncMarksClearGuard'];
  // 「刪除雲端資料」的單一端點(契約 R11):硬刪該帳號全部雲端資料並撤銷所有
  // session，回 `{ ok, revokedSessions }`。
  var CLOUD_DATA_PATH = '/api/v1/cloud-data';
  // 別台裝置的純顯示快取。登出與刪雲端要清掉(留著就會在下一位使用者眼前秀
  // 出上一個帳號的裝置);本機身分 syncDevice 兩者皆不清。
  var DEVICES_CACHE_KEY = 'syncDevices';
  // 裝置清單快取的新鮮度門檻(§4)。低於此值一律回快取:後端限流桶與手機端
  // 共用，開一次帳號選單再開一次裝置對話框不該是兩次往返。
  var DEVICES_TTL_MS = 30000;

  // 警示名單(marks)通道(D38)。與 links 並存的第二條通道:共用登入態、
  // alarm 排程、退避曲線與錯誤語意，水位線(marksCursor／marksPushedAt)各自
  // 獨立，存在同一包 syncState 裡。
  var BLOCKLIST_KEY = 'scamBlocklist';
  // 詐騙警示總開關(D35 開關 A)。缺席視為開啟，與 background 的
  // isScamGuardEnabled 同一把尺;關閉時整條通道零請求。
  var SCAM_ENABLED_KEY = 'scamGuardEnabled';
  var MARKS_PATH = '/api/v1/marks';
  var MARKS_SYNC_PATH = '/api/v1/marks/sync';
  // 契約 §3.1 的單批上限;超過一律 422，不截斷、不部分處理。
  var MAX_MARK_UPSERTS = 50;
  // 回填分頁的單頁筆數(伺服器夾擠後的最大值)。
  var MARKS_BACKFILL_LIMIT = 100;
  // marksEvicted 的累記上限。這一格只是卡頭提示的筆數，長年累加會變成一個沒有
  // 意義的天文數字。
  var MARKS_EVICTED_MAX = 1000000;

  // storage.session 的鍵。單飛旗標刻意存 session 而非 local:SW 被殺時
  // session 自然消失，旗標不會永久卡死同步;另加時效當第二道保險。
  var INFLIGHT_KEY = 'syncInflight';
  var DEBOUNCE_KEY = 'syncDebounce';
  var INFLIGHT_TTL_MS = 120000;

  // get-session 的節流:SW 每次被喚醒都會啟動驗一次，而喚醒在瀏覽期間非常
  // 頻繁（每一則訊息、每一個 alarm）。後端限流桶(與手機端共用)容量有限，
  // 光是驗 session 就能把它吃光，因此距上次驗證未滿此間隔就跳過。
  var VERIFY_THROTTLE_MS = 5 * 60000;

  // getState 順手補一次同步的門檻(options／popup 開啟時)。低於此值就不打，
  // 避免每次開頁都吃掉後端限流桶的額度(與手機端共用同一桶)。
  var STALE_MS = SYNC_PERIOD_MINUTES * 60000;

  // 登入期失敗的三分類(L3)。分類決定 UI 出不出聲、怎麼出聲:
  //
  //   cancelled 使用者自己中止(關窗、同意頁按拒絕、瀏覽器權限對話框按拒絕)。
  //             他知道自己做了什麼，不必再被通知一次。
  //   transient 等一下再試有機會成功(授權頁載不起來、斷網、後端 503、限流、
  //             未歸類的未知失敗)。只需要一句「請稍後再試」。
  //   config    以上皆非:打包出去就錯的設定問題(client_id 漏配、redirect_uri
  //             未登記、aud／iss 對不上、契約不符)。重試一百次都一樣，要讓
  //             使用者報得出錯誤碼。
  //
  // 兩份清單必須互斥:同一個碼同時算取消又算暫時性的話，UI 端要嘛靜音吞掉
  // 一次真的故障，要嘛對使用者自己按的取消跳錯誤。列不到的一律歸 config——
  // 保守的預設，未知的設定問題至少報得出碼。
  var SIGN_IN_CANCELLED = ['sign_in_cancelled', 'permission_required'];
  var SIGN_IN_TRANSIENT = [
    'interaction_required',
    'auth_page_unreachable',
    'incognito_not_supported',
    'network_error',
    'id_token_expired',
    'misconfigured',
    'rate_limited',
    'sign_in_failed',
  ];

  function signInKindOf(code) {
    if (SIGN_IN_CANCELLED.indexOf(code) !== -1) return 'cancelled';
    if (SIGN_IN_TRANSIENT.indexOf(code) !== -1) return 'transient';
    return 'config';
  }

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

  // 後端 body.error 會原樣變成使用者看得到的錯誤碼(config 類的提示直接把
  // 它印出來)，先夾擠成錯誤碼該有的形狀;不符一律退回泛用碼，不讓任意字串
  // 經由這條路徑落到畫面上。
  var ERROR_CODE_PATTERN = /^[a-z0-9_]{1,40}$/;

  function codeFromExchange(exchange) {
    var raw = exchange && exchange.body ? exchange.body.error : null;
    if (typeof raw === 'string' && ERROR_CODE_PATTERN.test(raw)) return raw;
    return 'sign_in_failed';
  }

  function syncError(code) {
    var err = new Error(code);
    err.code = code;
    return err;
  }

  function keyOfEntry(entry) {
    if (typeof entry.postKey === 'string' && entry.postKey) return entry.postKey;
    return TCLCoreRef.postKeyOf(entry.url);
  }

  function keyOfItem(item) {
    var url = TCLCoreRef.normalizePostUrl(item.cleaned) || item.cleaned;
    return TCLCoreRef.postKeyOf(url);
  }

  // 墓碑判定與 chrome.storage 的容量配額錯誤判定一律走 TCLCore（與
  // background 寫入側、options 讀取／匯入側共用同一份）。

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
    // 本機裝置身分(§12 增補二)。舊版接線沒有這支，整組裝置歸屬功能就靜默
    // 缺席——同步照跑，只是請求不帶 device 區塊。
    var getLocalDevice = typeof deps.getLocalDevice === 'function' ? deps.getLocalDevice : null;

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
    function localRemove(keys) {
      return Promise.resolve(storage.local.remove(keys));
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

    /** 移除舊版殘留的兩把自清守衛鍵(D50 起不再讀寫)。 */
    function removeLegacyGuards() {
      return localRemove(LEGACY_GUARD_KEYS);
    }

    // ---- 狀態與廣播(計劃 5.2／5.3) ----

    // 沒有 token 時 status 只可能是 signed_out(L1)。lastError 描述的是「已
    // 登入的同步出了事」，在沒有帳號的狀態下它至多是一句說明文字(登入過期
    // 卡片靠 session_expired 分辨)，不足以把畫面推成錯誤態——那會畫出一張
    // 空白名字＋紅點＋「同步失敗:」的幽靈帳號卡片，上頭每一顆按鈕都是死的。
    function statusOf(ctx) {
      if (!ctx.token) return 'signed_out';
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
        // finishSignIn／runVerify)，UI 端不必再驗一次。
        displayName: ctx.state.displayName,
        avatarUrl: ctx.state.avatarUrl,
        lastSyncedAt: ctx.state.lastSyncedAt,
        pendingCount: pending,
        lastError: ctx.state.lastError,
        apiBase: ctx.apiBase,
        // D38:marks 通道的水位線原樣帶出。marksEvicted 是 UI 出「雲端額度滿
        // 了，最舊的幾筆已被淘汰」提示的唯一來源——不帶這一格，那張提示就
        // 讀不到筆數。其餘幾格是診斷用的水位線:state 是唯一的對外形狀，少
        // marksBackfillCursor 就沒有任何管道看得出這個帳號卡在回填第幾頁。
        marksCursor: ctx.state.marksCursor,
        marksPushedAt: ctx.state.marksPushedAt,
        marksEvicted: ctx.state.marksEvicted,
        marksRejected: ctx.state.marksRejected,
        marksBackfillCursor: ctx.state.marksBackfillCursor,
      };
    }

    // transientError 是一次性欄位:只掛在這一次廣播上，不落 storage、
    // getState() 也不帶(L4)。重整頁面等於這件事沒發生過。
    function emitState(ctx, history, statusOverride, transientError) {
      var state = buildState(ctx, history, statusOverride);
      if (transientError) state.transientError = transientError;
      broadcast({ type: 'sync.stateChanged', state: state });
    }

    /** 讀最新持久狀態，組出計劃 5.2 形狀並廣播。 */
    function broadcastState(statusOverride, transientError) {
      return loadContext().then(function (ctx) {
        return readHistory().then(function (history) {
          emitState(ctx, history, statusOverride, transientError);
        });
      });
    }

    /**
     * 登入失敗的唯一出口(L4)。不寫 syncState——連把 lastError 清成 null 都
     * 不寫:這一格描述的是「已登入的同步出了事」，登入根本沒成功時動它，要嘛
     * 造出一個沒有帳號的錯誤狀態，要嘛把上一輪真正的同步錯誤抹掉。改為在這
     * 一次廣播上掛一次性的 transientError，由 UI 依 kind 決定出不出聲。
     */
    function failSignIn(err) {
      var code = err && err.code ? err.code : 'sign_in_failed';
      return broadcastState(undefined, { code: code, kind: signInKindOf(code) });
    }

    // ---- HTTP ----

    /**
     * 打一次後端。契約:credentials 一律 omit(D1，不夾帶 cookie)、Bearer、
     * 有 body 才帶 application/json(否則後端回 415)。任何回應帶
     * set-auth-token 就覆寫本地 token(插件端契約第 3 點)。
     */
    /**
     * 這個值算不算一個游標。後端(R6)對 `since` 與 `?cursor=` 是嚴格驗證:空字
     * 串／純空白／負數一律 400 bad_since。空游標與「沒有游標」是同一件事，一
     * 律當成缺席——帶著空字串出門只會每一輪原地撞 400，通道從此推不動。
     * TCLCore.normalizeSyncState 已在讀進來時抹過一次，這裡是同一條規則的第二
     * 道:游標也會從伺服器回應直接落進 ctx.state，那條路徑不經正規化。
     */
    function isCursor(value) {
      return typeof value === 'string' && value.trim().length > 0;
    }

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
          // 【契約要求】api-spec 8.1 第 4 點:「**任何**回應只要帶這個標頭就
          // 覆寫本地存值」——包含 4xx／5xx。後端可能在拒絕這一次請求的同時
          // 完成 token 輪替，只採信 2xx 的話新 token 會漏掉，本地留著的舊值
          // 從下一次請求起全部 401。回應來源已由 redirect:'error' 收窄成後端
          // 本人(轉址後那一站的標頭不會走到這裡)。
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
      // HTTP 狀態碼與錯誤碼分開帶:removeDevice 的冪等判定看的是 404 這個
      // 狀態，不是後端剛好回了哪一個 body.error。
      err.status = res.status;
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
        if (TCLCoreRef.isTombstone(entry)) {
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
    function applyResponse(body, ctx) {
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
            if (TCLCoreRef.isTombstone(entry) && deletedIds[entry.id]) return;
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
              // 拒收的原因一律是「這筆事件早於雲端的墓碑」，原樣
              // 重送永遠會被再拒一次。清掉 dirty 讓它停在本機，不無限重試。
              next.push(Object.assign({}, entry, { dirty: false }));
              return;
            }
            next.push(entry);
          });

          // changes.clearedAt(舊後端的清空水位線)一律忽略(D50):雲端的刪除只
          // 經由墓碑傳到本機，本機不因水位線硬刪任何一筆。
          var changes = body && body.changes;
          if (changes) {
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
          return localSet(items)
            .catch(function (err) {
              // 配額爆掉不是「這一輪失敗、下一輪重來就好」而已:游標一旦前進，
              // 這一頁的增量就再也拉不回來。改成拋出可辨識的錯誤碼，由 runSync
              // 統一記 lastError 並排退避，游標留在原地下一輪重拉同一頁。
              throw syncError(TCLCoreRef.isQuotaExceededError(err) ? 'storage_quota' : 'storage_write_failed');
            })
            .then(function () {
              // D25:拉到沒見過的裝置只留旗標，不在同步途中順手打一次 devices。
              return noteUnknownDevices(body);
            });
        });
      });
    }

    // ---- 一輪推拉往返 ----

    function runRound(ctx) {
      var chain = Promise.resolve();
      // D23:一輪只在**第一個** POST 掛 device 區塊。後端拿它做 upsert，續頁
      // 再帶一次只是重複同一筆寫入。
      var deviceSent = false;
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
                // 沒有游標的首輪送 '0':api-spec 4.3 明訂不帶 since 就不回增
                // 量，首次登入會永遠拉不到雲端既有資料。'0' 是合法的純數字
                // 游標，空字串不是——後端(R6)把空 since 判成 400 bad_since。
                since: isCursor(ctx.state.cursor) ? ctx.state.cursor : '0',
              };
              var block = deviceSent ? null : deviceBlockOf(ctx.device);
              if (block) {
                body.device = block;
                deviceSent = true;
              }
              return call(ctx, 'POST', '/api/v1/links/sync', body).then(function (payload) {
                // 【順序】游標必須等 applyResponse 真的落地才前進。反過來的話，
                // 寫入失敗（配額、storage 壞掉）時失敗路徑的 saveState 會把已
                // 前進的游標寫進去，這一頁的增量從此再也拉不回來——伺服器只認
                // 游標，不會重送。
                return applyResponse(payload, ctx).then(function () {
                  if (payload && isCursor(payload.cursor)) ctx.state.cursor = payload.cursor;
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
              return applyResponse(payload, ctx).then(function () {
                if (payload && isCursor(payload.cursor)) ctx.state.cursor = payload.cursor;
                lastChanges = payload ? payload.changes : null;
                return more();
              });
            });
          }
          return more();
        })
        .then(function () {
          // marks 是並存的第二條通道:links 這一輪收完才輪到它。擺在後面是為
          // 了讓 links 的推拉不受警示名單的成敗影響——marks 失敗時 links 這一
          // 輪已經落地，只是 lastError 記在同一格。
          return runMarksRound(ctx);
        });

      return chain;
    }

    // ---- 警示名單(marks)通道(D38) ----

    /** 總開關(D35 開關 A)。缺席或非 false 一律視為開啟。 */
    function readScamEnabled() {
      var defaults = {};
      defaults[SCAM_ENABLED_KEY] = true;
      return localGet(defaults).then(function (got) {
        return got[SCAM_ENABLED_KEY] !== false;
      });
    }

    /** 讀出本機警示名單，一律先過正規化(storage 是使用者可編輯的地方)。 */
    function readBlocklist() {
      var defaults = {};
      defaults[BLOCKLIST_KEY] = null;
      return localGet(defaults).then(function (got) {
        return TCLCoreRef.normalizeScamBlocklist(got[BLOCKLIST_KEY]);
      });
    }

    /**
     * 這一輪要推的批次(每批 ≤ MAX_MARK_UPSERTS)。兩道過濾:
     *
     * - 水位線:只送**選批時戳嚴格大於** marksPushedAt 的條目(水位線為 null
     *   即全部，首次登入的全量上傳走的就是這一條)。選批時戳是 updatedAt 與
     *   本機推送提示 pushAfter 的較大者——被動再掃到已列名的作者只併證據、不
     *   推進 updatedAt(那是跨裝置 LWW 的判準)，光看 updatedAt 就選不到那筆新
     *   證據。settleMarkAck 推進水位線時用的是同一個值，兩處同源才不會每一輪
     *   重選同一批。送上雲的 mark 仍帶原本的 updatedAt。
     * - 被拒映射:上一輪被伺服器拒收的那一版不重送。單靠水位線擋不住——被拒
     *   條目的 updatedAt 照樣大於水位線，原樣重送只會每一輪再撞一次。本機真
     *   的改動過(updatedAt 前進)才再送，那時兩端版本才對得上。
     *
     * 切批時順手算出**批尾撞值**的上限:本批最大值等於下一批首筆時，這一批的
     * ack 只能把水位線推到該值減一。推到該值本身的話，下一批那筆同值條目的
     * 「嚴格大於」永遠不成立，中途失敗就再也補推不上去。
     *
     * @returns {{rows: {mark: object, updatedAt: number}[], ceiling: number|null}[]}
     */
    function planMarkBatches(list, state) {
      var rejected = state.marksRejected || {};
      var pushedAt = state.marksPushedAt;
      var pending = [];
      Object.keys(list.entries).forEach(function (userId) {
        var entry = list.entries[userId];
        var updatedAt = finiteNumber(entry.updatedAt) ? entry.updatedAt : 0;
        var pushAfter = finiteNumber(entry.pushAfter) ? entry.pushAfter : 0;
        if (pushAfter > updatedAt) updatedAt = pushAfter;
        if (pushedAt !== null && updatedAt <= pushedAt) return;
        // handle 缺席或形狀不合的條目都不進批:後端視 handle 為必填(staging 實
        // 測，送 null 整筆進 rejectedIds)，送上去白佔一次往返，還把 key 記進
        // marksRejected——被拒映射要等本機 updatedAt 前進才會再送，而補建的空
        // dismissed 條目根本不會再被動到，那次解除從此同步不出去。
        if (!TCLCoreRef.isScamMarkHandle(entry.handle)) return;
        var mark = TCLCoreRef.toScamMark(userId, entry);
        if (rejected[mark.key] === updatedAt) return;
        pending.push({ mark: mark, updatedAt: updatedAt });
      });
      // 【切批前先排序】entries 的鍵是作者數字 id，與 updatedAt 的先後無關;照
      // Object.keys 的順序切，第一批可能裝著一整包最新的條目，水位線一推就越過
      // 後面那些比較舊、還沒送出去的條目，中途失敗時它們永久不推。依 updatedAt
      // 升冪(同值以 key 決勝，排序穩定)排過再塞批，批次就單調遞增:失敗時水位線
      // 最多停在上一個完整成功的批，沒送出去的一律還在水位線之上。
      pending.sort(function (a, b) {
        if (a.updatedAt !== b.updatedAt) return a.updatedAt - b.updatedAt;
        return a.mark.key < b.mark.key ? -1 : a.mark.key > b.mark.key ? 1 : 0;
      });
      var batches = [];
      for (var i = 0; i < pending.length; i += MAX_MARK_UPSERTS) {
        var rows = pending.slice(i, i + MAX_MARK_UPSERTS);
        var next = pending[i + MAX_MARK_UPSERTS];
        var last = rows[rows.length - 1];
        var tied = next && last && next.updatedAt === last.updatedAt;
        batches.push({ rows: rows, ceiling: tied ? last.updatedAt - 1 : null });
      }
      return batches;
    }

    /** 推空的那一批(只為了拉增量):沒有 row，也沒有撞值上限。 */
    function emptyMarkBatch() {
      return { rows: [], ceiling: null };
    }

    /**
     * 逐欄深比對，物件鍵序不計。mergeScamEntry 的輸出鍵序與正規化後的條目不
     * 同，拿 JSON.stringify 比會把一筆沒改的條目判成改過。
     */
    function sameShape(a, b) {
      if (a === b) return true;
      if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
      var isArray = Array.isArray(a);
      if (isArray !== Array.isArray(b)) return false;
      var i;
      if (isArray) {
        if (a.length !== b.length) return false;
        for (i = 0; i < a.length; i++) {
          if (!sameShape(a[i], b[i])) return false;
        }
        return true;
      }
      var keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      for (i = 0; i < keys.length; i++) {
        if (!Object.prototype.hasOwnProperty.call(b, keys[i])) return false;
        if (!sameShape(a[keys[i]], b[keys[i]])) return false;
      }
      return true;
    }

    /**
     * 把一頁雲端 mark(與墓碑)併進本機名單。整段讀改寫包在注入的 writeChain
     * 內，與 background 的 recordHistory／handleScamHit 串行:scamBlocklist 只
     * 有 background 寫得到，兩邊的 read-modify-write 會互相覆蓋。
     *
     * 寫前 normalize(readBlocklist)、寫後 cap——與 background 的三支寫入路徑
     * 同一套紀律，handleIndex 一律由 entries 重建，不留孤兒鍵。
     *
     * 【重送即 no-op】伺服器對同毫秒併發寫入的列會在下一次增量重送一次(後端
     * R5 的 now-1 游標)。逐欄相同的重送合併出來與本機現存那一份一模一樣，這時
     * 整段不寫 storage:白寫一次除了燒配額，還會讓所有 storage.onChanged 的讀
     * 者(選項頁的名單)為一件沒發生的事重畫一次。
     */
    function applyMarkChanges(marks, deletions) {
      if (!marks.length && !deletions.length) return Promise.resolve([]);
      // 比墓碑新、因此留在本機的條目。回給呼叫端把推送水位線讓回去，下一輪
      // 才推得到它們。
      var kept = [];
      // 這一頁有沒有真的改到本機那一份。一筆都沒改就不落盤(見函式註解)。
      var changed = false;
      return writeChain(function () {
        return readBlocklist().then(function (list) {
          // 【墓碑守衛】契約 §3.1 R2③「比墓碑舊不復活」的對稱面:本機
          // updatedAt **晚於** deletedAt，代表使用者在別台裝置刪掉這一筆之後
          // 又動過它，那份改動不該被一筆較舊的刪除吃掉。留著並於下一輪重送，
          // 伺服器會以較新的版本撤銷墓碑(D37 的 LWW 在刪除這一側同樣成立)。
          // 不晚於墓碑的才硬刪——留一個本機墓碑會在下一輪被當成待推的條目再
          // 送一次。
          deletions.forEach(function (row) {
            var userId = TCLCoreRef.scamMarkUserId(row.key);
            if (userId === null) return;
            var entry = list.entries[userId];
            if (!entry) return;
            var updatedAt = finiteNumber(entry.updatedAt) ? entry.updatedAt : 0;
            if (updatedAt > row.deletedAt) {
              kept.push({ key: row.key, updatedAt: updatedAt });
              return;
            }
            delete list.entries[userId];
            changed = true;
          });
          marks.forEach(function (mark) {
            var parsed = TCLCoreRef.fromScamMark(mark);
            // key 形狀不對的整筆丟棄:落進 entries 就是一筆永遠查不到的條目。
            if (!parsed) return;
            var local = list.entries[parsed.userId];
            var merged = local ? TCLCoreRef.mergeScamEntry(local, parsed.entry) : parsed.entry;
            // 逐欄相同的重送不算改動(鍵序不計:合併出來的鍵序與正規化後的不同)。
            if (local && sameShape(local, merged)) return;
            list.entries[parsed.userId] = merged;
            changed = true;
          });
          if (!changed) return undefined;
          var items = {};
          items[BLOCKLIST_KEY] = TCLCoreRef.capScamBlocklist(list);
          return localSet(items).catch(function (err) {
            // 比照 links:配額爆掉時游標不得前進，否則這一頁的增量再也拉不回
            // 來(伺服器只認游標，不會重送)。
            throw syncError(TCLCoreRef.isQuotaExceededError(err) ? 'storage_quota' : 'storage_write_failed');
          });
        });
      }).then(function () {
        return kept;
      });
    }

    /**
     * 本輪的「讓位下限」。墓碑守衛留下比墓碑新的條目之後，水位線必須退到它們
     * 之下，下一輪才選得到、推得出去——否則「保留」只是讓兩端永遠不一致。
     *
     * 水位線是整輪共用的一格，讓位卻發生在某一批，因此 floor 必須是**整輪**的
     * 累積值:同一輪後面每一批的 ack 都要守同一條線，不然前面讓出來的空間會被
     * 後面那批推回去。取最小的一個，同時照顧到多筆留存。
     */
    function noteMarkFloor(floor, kept) {
      kept.forEach(function (row) {
        var candidate = row.updatedAt - 1;
        if (floor.value === null || candidate < floor.value) floor.value = candidate;
      });
    }

    /**
     * 整輪結算完的最後一步。settleMarkAck 只夾得住「這一輪推上去的」水位線;
     * 進這一輪之前就已經高於 floor 的舊值(留存的條目本來就在水位線底下，這正
     * 是它沒被推上去的原因)得在這裡退回去。
     *
     * marksPushedAt 為 null 時不動:那代表「全部都要推」，本來就選得到。
     */
    function applyMarkFloor(ctx, floor) {
      if (floor.value === null) return;
      if (ctx.state.marksPushedAt !== null && ctx.state.marksPushedAt > floor.value) {
        ctx.state.marksPushedAt = floor.value;
      }
    }

    /**
     * 一次 POST 的回應結算(只動記憶體裡的 ctx.state，落盤由 runSync 收尾):
     *
     * - marksPushedAt 只吃 applied.upserts:被拒那筆的 updatedAt 不算數，否則
     *   水位線會跨過一筆根本沒上雲的條目，從此再也不補送。
     * - applied.rejectedIds 記進 marksRejected 映射(key → 被拒當下的
     *   updatedAt);推送成功就把該 key 拿掉，映射不無限成長。
     * - evicted 只累記筆數供 UI 提示，本機一筆不動(被淘汰的 key 由下一次回
     *   填自行對帳)。
     * - batch.ceiling 是切批時算出的撞值上限:本批最大值與下一批首筆同值時，
     *   水位線只能推到該值減一，否則下一批那筆永遠選不進推送批。
     */
    function settleMarkAck(ctx, payload, batch, floor, round) {
      var applied = (payload && payload.applied) || {};
      var sentAt = {};
      batch.rows.forEach(function (row) {
        sentAt[row.mark.key] = row.updatedAt;
      });
      var rejected = Object.assign({}, ctx.state.marksRejected || {});
      var touched = false;
      var high = null;
      (applied.upserts || []).forEach(function (key) {
        if (typeof key !== 'string') return;
        if (Object.prototype.hasOwnProperty.call(rejected, key)) {
          delete rejected[key];
          touched = true;
        }
        if (finiteNumber(sentAt[key]) && (high === null || sentAt[key] > high)) high = sentAt[key];
      });
      if ((applied.rejectedIds || []).length) round.rejected = true;
      (applied.rejectedIds || []).forEach(function (key) {
        if (typeof key !== 'string' || !finiteNumber(sentAt[key])) return;
        rejected[key] = sentAt[key];
        touched = true;
      });
      if (touched) ctx.state.marksRejected = rejected;
      // 批尾撞值的上限:下一批的首筆與本批最大值同一個 updatedAt，推到該值就
      // 等於把那一筆卡在水位線底下。
      if (high !== null && batch.ceiling !== null && high > batch.ceiling) high = batch.ceiling;
      // 本輪讓位的上限:墓碑守衛留下來的條目必須留在水位線之上，這一批的 ack
      // 再高也不能蓋過去（同一輪後面每一批都要守同一條線）。
      if (high !== null && floor.value !== null && high > floor.value) high = floor.value;
      if (high !== null && (ctx.state.marksPushedAt === null || high > ctx.state.marksPushedAt)) {
        ctx.state.marksPushedAt = high;
      }
      var evicted = payload && finiteNumber(payload.evicted) ? payload.evicted : 0;
      if (evicted > 0) {
        round.evicted += evicted;
        // 夾上限:這一格是卡頭提示的筆數，跨輪累加沒有上限就會長成天文數字。
        ctx.state.marksEvicted = Math.min(MARKS_EVICTED_MAX, (ctx.state.marksEvicted || 0) + evicted);
      }
    }

    /**
     * 一次推拉往返。推空的也要發:一次 POST 同時處理推與拉，少發這一次就拉不
     * 到別台裝置的新資料(與 links 同一個取向)。
     *
     * 【位置參數】marksCursor 為 null 時不帶——契約 §3.1 的首輪回填走 GET，不
     * 帶位置參數時伺服器回 changes: null，這一次 POST 只是把水位線領回來。
     */
    function postMarks(ctx, batch, floor, round) {
      var body = {
        upserts: batch.rows.map(function (row) {
          return row.mark;
        }),
        // 本機沒有「刪除」動作:解除是 state 翻成 dismissed，不是刪條目。
        deletes: [],
      };
      if (isCursor(ctx.state.marksCursor)) body.since = ctx.state.marksCursor;
      return call(ctx, 'POST', MARKS_SYNC_PATH, body).then(function (payload) {
        var changes = payload && payload.changes;
        var marks = changes && Array.isArray(changes.marks) ? changes.marks : [];
        var deletions = [];
        if (changes && Array.isArray(changes.deleted)) {
          changes.deleted.forEach(function (row) {
            if (!row || typeof row.key !== 'string') return;
            // deletedAt 讀不出來時當成「無限早」，一律交給守衛留下本機那一份
            // ——刪除是不可逆的，形狀不明時不動手。
            deletions.push({ key: row.key, deletedAt: finiteNumber(row.deletedAt) ? row.deletedAt : -Infinity });
          });
        }
        // changes.clearedAt(舊後端的清空水位線)一律忽略(D50):名單只經由墓碑
        // 刪除。
        // 【順序】游標必須等寫入真的落地才前進(比照 links)。
        return applyMarkChanges(marks, deletions).then(function (kept) {
          // 【順序】先記讓位再結算:settleMarkAck 要拿這一輪的 floor 夾住自己
          // 推上去的水位線，floor 晚一步記就夾不到本批的 ack。
          noteMarkFloor(floor, kept);
          settleMarkAck(ctx, payload, batch, floor, round);
          // 【當場落地】讓位不能等到整輪尾端才統一套用:後面那批一斷線，整條鏈
          // 就 reject，尾端那一步輪不到跑，runSync 的失敗路徑會把**進這一輪之前
          // 就存在**的舊水位線原封不動落盤(夾擠只擋得住這一輪推上去的值，擋不到
          // 舊值)，留存的條目下一輪依舊選不到。整輪尾端那次保留著，重複套用冪等。
          applyMarkFloor(ctx, floor);
          if (payload && isCursor(payload.cursor)) ctx.state.marksCursor = payload.cursor;
          return changes;
        });
      });
    }

    /**
     * 首次登入／首次啟用的回填:把雲端既有的警示整份抓回來(GET 分頁，以
     * nextCursor 續頁到 null 為止)。回填只講「現在有哪些警示」，墓碑不入這條
     * 路徑。
     *
     * 【續填位置】單輪最多翻 MAX_PULL_ROUNDS 頁;翻不完時把下一頁的位置記進
     * marksBackfillCursor，下一輪從那裡接著填。不記的話雲端筆數只要多過單輪
     * 翻得完的量，每一輪都從第一頁重來，這個帳號永遠回填不到底，marks 通道就
     * 卡在回填、一筆都推不出去。
     *
     * 【接縫】回填的分頁與增量走的是同一條伺服器寫入時間線(後端 R4)，回應的
     * 頂層 cursor 就是那一頁末端的位置。到底時把**最後一頁**的 cursor 寫進
     * marksCursor，第一個 POST 因此帶得出 since:回填途中寫進雲端的條目，位置
     * 必然落在時間線末端，不是出現在後面的頁，就是排在最後一頁的 cursor 之
     * 後，兩段之間沒有縫隙(重疊的部分由 LWW 吸收)。舊後端不回這一欄時
     * marksCursor 維持 null，行為與加這一格之前相同:第一個 POST 不帶 since，
     * 游標改由 POST 的回應建立。
     *
     * @returns {Promise<boolean>} 這一輪有沒有回填到底。沒到底時回 false，呼
     *   叫端必須整輪收手:一旦讓後面的 POST 把 marksCursor 寫下去，沒拉到的那
     *   些就永遠落在增量水位線之前，再也回填不到。
     */
    function backfillMarks(ctx) {
      var rounds = 0;
      // 目前翻到的那一頁末端的伺服器位置。到底那一刻才落進 marksCursor——中途
      // 停下來時寫進去，「marksCursor 不是 null」就會被讀成「回填過了」。
      var position = null;
      function page(cursor) {
        // 只有「還有下一頁」才遞迴得到這裡，因此撞上限就代表沒拉完。
        if (rounds >= MAX_PULL_ROUNDS) {
          ctx.state.marksBackfillCursor = cursor;
          return Promise.resolve(false);
        }
        rounds += 1;
        var path = MARKS_PATH + '?limit=' + MARKS_BACKFILL_LIMIT;
        if (isCursor(cursor)) path += '&cursor=' + encodeURIComponent(cursor);
        return call(ctx, 'GET', path).then(function (payload) {
          if (payload && isCursor(payload.cursor)) position = payload.cursor;
          var items = payload && Array.isArray(payload.items) ? payload.items : [];
          return applyMarkChanges(items, []).then(function () {
            var next = payload && isCursor(payload.nextCursor) ? payload.nextCursor : null;
            if (next === null) {
              ctx.state.marksBackfillCursor = null;
              if (position !== null) ctx.state.marksCursor = position;
              return true;
            }
            return page(next);
          });
        });
      }
      return page(ctx.state.marksBackfillCursor);
    }

    /** 推拉往返本體:分批推完再把增量拉乾淨(hasMore 同輪續拉)。 */
    function exchangeMarks(ctx, list) {
      var batches = planMarkBatches(list, ctx.state);
      // 推空的也要發一次:一次 POST 同時處理推與拉。
      if (!batches.length) batches.push(emptyMarkBatch());
      var lastChanges = null;
      // 整輪共用一份讓位下限:任何一批留下來的條目都要守到這一輪結束。
      var floor = { value: null };
      // 整輪的結算帳:evicted 累計與「有沒有一筆被拒」決定輪末收不收掉淘汰提
      // 示。
      var round = { evicted: 0, rejected: false };
      var step = Promise.resolve();
      batches.forEach(function (batch) {
        step = step.then(function () {
          return postMarks(ctx, batch, floor, round).then(function (changes) {
            lastChanges = changes;
          });
        });
      });
      return step
        .then(function () {
          // hasMore:積壓要在同一輪拉完，不能等下一個 alarm。
          var rounds = 0;
          function more() {
            if (!lastChanges || !lastChanges.hasMore || rounds >= MAX_PULL_ROUNDS) return Promise.resolve();
            rounds += 1;
            return postMarks(ctx, emptyMarkBatch(), floor, round).then(function (changes) {
              lastChanges = changes;
              return more();
            });
          }
          return more();
        })
        .then(function () {
          applyMarkFloor(ctx, floor);
          // 一輪完整跑完(沒有例外、沒有一筆被拒)且這一輪雲端一筆都沒淘汰時，把
          // 上一輪留下的提示收掉:對完帳那張提示就該收，否則它永遠掛在卡頭上。
          if (!round.rejected && round.evicted === 0) ctx.state.marksEvicted = null;
        });
    }

    /** 一輪 marks:開關 → 回填 → 推 → 拉。 */
    function runMarksRound(ctx) {
      return readScamEnabled().then(function (enabled) {
        // D35 開關 A:關閉時整條通道跳過，零請求、水位線一格不動。
        if (!enabled) return undefined;
        // 回填中的判準是兩格:marksBackfillCursor 非 null 代表上一輪停在分頁
        // 中段，marksCursor 為 null 代表這個帳號還沒回填過(或登入時剛重設)。
        var backfilling = ctx.state.marksBackfillCursor !== null || ctx.state.marksCursor === null;
        var chain = backfilling ? backfillMarks(ctx) : Promise.resolve(true);
        return chain.then(function (backfilled) {
          // 回填沒到底就整輪收手:不推也不拉，marksCursor 留在 null，下一輪從
          // marksBackfillCursor 接著回填。先 POST 的話伺服器會發一個增量游標，
          // 沒回填到的條目從此落在水位線之前，再也拉不回來。
          if (!backfilled) return undefined;
          return readBlocklist().then(function (list) {
            return exchangeMarks(ctx, list);
          });
        });
      });
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
      // Retry-After 同樣夾在退避曲線的上限內:這個值來自後端標頭，一個誤設
      // 的大數字(或惡意中間人)會把下一次同步推遲到幾天以後，等於單一標頭就
      // 能讓同步停擺。封頂之後最壞情況只是提早重試一次，由 429 再退一步。
      var delay = finiteNumber(retryAfterMs) && retryAfterMs > 0
        ? Math.min(retryAfterMs, POLL_BACKOFF_MAX_MS)
        : pollIntervalFor(failures);
      alarms.create(ALARM_NAME, { when: now() + delay });
      return saveFailures(failures);
    }

    // ---- 登出／失效 ----

    /**
     * token 失效的統一出口:清 token、記 session_expired、停掉週期 alarm。
     *
     * 【合併式 patch】session 過期是一次轉場，不是換帳號也不是刪資料:整包
     * 重設會把 userId 一起清掉，下次登入的帳號切換偵測(finishSignIn)就永遠
     * 判不出「換了人」，前一位使用者的本機鏡像會被當成新帳號的資料。游標與
     * history 不動，重建鏡像的標髒統一在 finishSignIn 做。displayName／
     * avatarUrl 留著是 D17 的「登入過期」卡片要顯示的資訊——使用者得看得出
     * 過期的是哪一個帳號。
     * 退避次數歸零:失效不是後端故障，重新登入後該從基礎週期重新開始。
     */
    function handleSessionExpired() {
      return loadContext()
        .then(function (ctx) {
          var patched = Object.assign({}, ctx.state, { lastError: 'session_expired' });
          return saveState(patched);
        })
        .then(function () {
          return saveToken(null);
        })
        .then(function () {
          return saveFailures(0);
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
          // 別台裝置的快取描述的是「這個帳號底下有哪些裝置」。過期後重新登
          // 入的可能是另一個 Google 帳號，留著就會在新使用者眼前先閃出上一
          // 位的裝置名。本機身分 syncDevice 不動(D21)。
          return localRemove(DEVICES_CACHE_KEY);
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
          // 落在 FATAL_ERRORS 的狀態一律跳過:那一類重試永遠不會成功(見常數
          // 註解)，每開一次頁就拿同一份必然失敗的請求去敲共用的限流桶。
          var fatal = ctx.state.lastError !== null && FATAL_ERRORS.indexOf(ctx.state.lastError) !== -1;
          if (ctx.token && !fatal && (ctx.state.lastSyncedAt === null || now() - ctx.state.lastSyncedAt >= STALE_MS)) {
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
            // 使用者在權限對話框按拒絕與關掉授權視窗同一類:自己中止的。
            return failSignIn(syncError('permission_required'));
          }
          // clientId 依 apiBase 對應(D5):白名單只有三個 apiBase，理論上
          // 這裡不可能找不到，但找不到就代表 CLIENT_ID_BY_API_BASE 漏配，
          // 拒絕登入好過拿錯 client 的 id_token 去撞後端的 aud 檢查。
          var clientId = CLIENT_ID_BY_API_BASE[ctx.apiBase];
          if (typeof clientId !== 'string' || !clientId) {
            return failSignIn(syncError('client_id_missing'));
          }
          // nonce 由引擎生成、交給 auth 模組帶進授權請求。**不落 storage**:
          // 重放防護整段在 auth.js 內完成(launch 時送出的那枚與 id_token
          // payload 的 nonce 逐字比對，見 verifyIdTokenPayload)，那次比對只用
          // 得到同一個閉包裡的值。SW 若在授權往返途中被回收，這條 promise 鏈
          // 連同 launchWebAuthFlow 一起消失，回來根本沒有「待比對的登入」——
          // 存一份到 session 再讀回來只是裝飾，不構成第二道防線。
          var nonce = randomUUID();
          return Promise.resolve()
            .then(function () {
              return auth.signInWithGoogle({ clientId: clientId, apiBase: ctx.apiBase, nonce: nonce });
            })
            .then(function (result) {
              // auth 模組是「本次授權實際用了哪枚 nonce」的權威（launch 時傳
              // 進去的那枚已由它比對過 id_token payload），換 token 時帶它
              // 回報的值。
              var effective = typeof result.nonce === 'string' && result.nonce ? result.nonce : nonce;
              return auth
                .exchangeWithBackend({ apiBase: ctx.apiBase, idToken: result.idToken, nonce: effective })
                .then(function (exchange) {
                  return finishSignIn(ctx, result, exchange);
                });
            })
            .catch(failSignIn);
        });
      });
    }

    function finishSignIn(ctx, result, exchange) {
      if (!exchange || !exchange.ok || !exchange.authToken) {
        throw syncError(codeFromExchange(exchange));
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
      // 登入＝重建鏡像(D50):雲端可能已被刪除(本機或別台裝置發動)，也可能
      // 換了帳號，本機無從分辨，因此每次登入都把 history 全部標髒重傳，墓碑
      // 一併進 deletes[]。marks 的四格與回填位置隨下方 saveState 整包重設，
      // 名單同樣全推。伺服器端的 upsert 與墓碑冪等，重傳不會長出重複資料。
      var switched = ctx.state.userId !== null && userId !== null && ctx.state.userId !== userId;
      return resetMirrorFields()
        .then(removeLegacyGuards)
        .then(function () {
          // 別台裝置的清單屬於前一個帳號(D25):換人時這份顯示層快取留著，就是
          // 把上一位使用者的裝置名秀給新使用者看。同帳號重新登入不清。
          if (!switched) return undefined;
          return localRemove(DEVICES_CACHE_KEY);
        })
        .then(function () {
          return saveToken(exchange.authToken);
        })
        .then(function () {
          return saveState({ userId: userId, email: email, displayName: displayName, avatarUrl: avatarUrl });
        })
        .then(function () {
          alarms.create(ALARM_NAME, { periodInMinutes: SYNC_PERIOD_MINUTES });
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
            return localRemove(DEVICES_CACHE_KEY);
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
          // 【死鎖守則】本機身分在整輪的任何 writeChain 之前先取好(§12 增補
          // 四):getLocalDevice 自己也要排進同一條序列鏈。
          return readLocalDevice().then(function (device) {
            ctx.device = device;
            return claimInflight();
          });
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
                  // 同一份必然失敗的請求去敲後端限流桶（與手機端共用同一
                  // 桶）。使用者重新登入或手動同步時會重新建回來。
                  if (FATAL_ERRORS.indexOf(code) !== -1) {
                    return Promise.resolve(alarms.clear(ALARM_NAME)).catch(function () {});
                  }
                  return scheduleBackoff(ctx.failures + 1, err && err.retryAfterMs);
                })
                .then(function () {
                  return broadcastState('error');
                });
            })
            // finally 語意:上面的 catch 自己也會寫 storage、排 alarm，那幾步
            // 一旦失敗就走到這裡的失敗分支——只掛成功回呼的話單飛旗標會留在
            // session 裡，直到 TTL 到期前所有同步全被擋掉。
            .then(
              function (value) {
                return releaseInflight().then(function () {
                  return value;
                });
              },
              function (err) {
                return releaseInflight().then(function () {
                  throw err;
                });
              }
            );
        });
    }

    /**
     * 刪除雲端資料(D50，契約 R11):打單一端點，伺服器硬刪這個帳號的全部雲端
     * 資料並撤銷所有 session。成功(2xx，不看 revokedSessions)即本機登出:
     *
     * 1. history 全部標髒、serverUpdatedAt 歸 null(墓碑的 deletedAt 不動)，
     *    下次登入時全量重傳。先標髒再登出:標髒寫入失敗時整件事走失敗路徑，
     *    token 還在，使用者看得到錯誤而不是一個已登出卻漏標的本機鏡像。
     * 2. 清 token、syncState 整包重設、退避歸零、清別台裝置快取、移除舊版守衛
     *    鍵、停掉兩支 alarm，廣播 signed_out。本機身分 syncDevice 不動。
     *
     * 失敗(非 2xx／斷網)不登出、本機一格不動，只記 lastError;401 走 session
     * 過期的統一出口。
     *
     * @returns {Promise<{ok: boolean, signedOut?: boolean, code?: string}>}
     */
    function deleteCloud() {
      return loadContext().then(function (ctx) {
        if (!ctx.token) return { ok: false, code: 'signed_out' };
        return call(ctx, 'DELETE', CLOUD_DATA_PATH).then(
          function () {
            return resetMirrorFields()
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
                return localRemove(DEVICES_CACHE_KEY);
              })
              .then(removeLegacyGuards)
              .then(function () {
                return Promise.all([
                  Promise.resolve(alarms.clear(ALARM_NAME)).catch(function () {}),
                  Promise.resolve(alarms.clear(DEBOUNCE_ALARM_NAME)).catch(function () {}),
                ]);
              })
              .then(function () {
                return broadcastState('signed_out');
              })
              .then(function () {
                return { ok: true, signedOut: true };
              });
          },
          function (err) {
            var code = err && err.code ? err.code : 'internal_error';
            if (code === 'session_expired') {
              return handleSessionExpired().then(function () {
                return { ok: false, code: code };
              });
            }
            return loadContext().then(function (fresh) {
              fresh.state.lastError = code;
              return saveState(fresh.state)
                .then(function () {
                  return broadcastState('error');
                })
                .then(function () {
                  return { ok: false, code: code };
                });
            });
          }
        );
      });
    }

    // ---- 裝置歸屬(§3／§4／§5) ----

    /**
     * 本機這台的身分。dep 缺席、回 null 或整支拋例外一律回 null——拿不到歸屬
     * 只是這一輪的請求不帶 device 區塊，不該讓整輪同步掛掉。
     *
     * 【死鎖守則】§12 增補四:background 的 getLocalDevice 自己也要佔一段
     * historyWriteChain，因此本函式**只能在進 writeChain 之前**呼叫;在
     * dropUnsendable／applyResponse 的回呼內才取就是在鏈上等自己。
     */
    function readLocalDevice() {
      if (!getLocalDevice) return Promise.resolve(null);
      return Promise.resolve()
        .then(function () {
          return getLocalDevice();
        })
        .then(function (device) {
          return device && typeof device === 'object' ? device : null;
        })
        .catch(function () {
          return null;
        });
    }

    /**
     * sync 請求的頂層 device 區塊(依後端 API 契約的裝置端點)。三欄缺一就整個鍵不輸出——
     * 後端對無效區塊是靜默丟棄，送半套只是白費一次寫入。
     */
    function deviceBlockOf(device) {
      if (!device) return null;
      if (typeof device.deviceId !== 'string' || !device.deviceId) return null;
      if (typeof device.name !== 'string' || !device.name) return null;
      if (typeof device.platform !== 'string' || !device.platform) return null;
      return { deviceId: device.deviceId, name: device.name, platform: device.platform };
    }

    /** 讀出別台裝置的顯示快取;形狀不合(含缺 devices 陣列)一律當沒有。 */
    function readDevicesCache() {
      var defaults = {};
      defaults[DEVICES_CACHE_KEY] = null;
      return localGet(defaults).then(function (got) {
        var raw = got[DEVICES_CACHE_KEY];
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        if (!Array.isArray(raw.devices)) return null;
        return raw;
      });
    }

    function writeDevicesCache(cache) {
      var items = {};
      items[DEVICES_CACHE_KEY] = cache;
      return localSet(items);
    }

    /**
     * devices 三支共用的失敗出口。401 不是「這一支端點失敗」而是整枚 token 死
     * 了，因此比照 runSync／verifySession／deleteCloud 轉進 handleSessionExpired
     * ——清 token、記 lastError、停掉兩支 alarm、廣播 signed_out。只把碼往上丟
     * 的話，使用者會停在「已登入」的畫面，同步在背景一輪一輪地失敗，直到下一
     * 次剛好有別條路徑也撞上 401 才被發現。
     *
     * 除 session_expired 外一律不動 devices 快取:畫面不該一斷網就變空。
     * session_expired 轉進 handleSessionExpired，快取依 4.2 的清除規則在那裡
     * 一併清掉。
     */
    function failDevices(err) {
      var code = err && err.code ? err.code : 'internal_error';
      if (code === 'session_expired') {
        return handleSessionExpired().then(function () {
          return { ok: false, code: code };
        });
      }
      return Promise.resolve({ ok: false, code: code });
    }

    /**
     * 拉回來的 changes 出現快取裡沒有的 deviceId 時，**只**把 stale 旗標寫進
     * 快取(D25)，當場不打 GET:每一輪同步都順手多一次往返，共用的限流桶吃不
     * 消。旗標與快取同一個物件，SW 被回收也還在(§12 增補五);listDevices 見到
     * 就視同 force。
     *
     * 「認得」包含已移除的裝置(§13):快取存的是清單回應的整個陣列，查得到就
     * 不是未知裝置，不必為了一台已移除的裝置多打一輪 GET。
     */
    function noteUnknownDevices(body) {
      var changes = body && body.changes;
      var links = changes && Array.isArray(changes.links) ? changes.links : [];
      var seenIds = [];
      links.forEach(function (item) {
        var events = item && Array.isArray(item.seen) ? item.seen : [];
        events.forEach(function (event) {
          var id = event && typeof event.deviceId === 'string' ? event.deviceId : null;
          if (id && seenIds.indexOf(id) === -1) seenIds.push(id);
        });
      });
      if (!seenIds.length) return Promise.resolve();
      return readDevicesCache().then(function (cache) {
        if (cache && cache.stale === true) return undefined;
        var known = {};
        if (cache) {
          cache.devices.forEach(function (row) {
            if (row && typeof row.deviceId === 'string') known[row.deviceId] = true;
          });
        }
        var unknown = seenIds.some(function (id) {
          return known[id] !== true;
        });
        if (!unknown) return undefined;
        // 還沒有快取時也要留下旗標:fetchedAt 給 0 讓它必然過期，下一次
        // listDevices 照樣會取一次完整清單。
        var base = cache || { fetchedAt: 0, devices: [] };
        return writeDevicesCache(Object.assign({}, base, { stale: true }));
      });
    }

    /**
     * 別台裝置的清單。純顯示層:回應只用來畫清單，**不得**觸發 history、seen
     * 或 syncDevice 的任何寫入(D25)——清單變短代表別台在雲端被移除，不代表本
     * 機那些歸屬不明的事件該跟著消失。
     *
     * 節流(§4):未 force、快取未滿 DEVICES_TTL_MS 且沒被標記 stale 就直接回
     * 快取。失敗一律不動既有快取，畫面不該一斷網就變空。
     *
     * 回應的整個陣列原樣落地(§13):已移除的裝置與活躍的混在一起(removedAt
     * 活躍為 null、已移除為毫秒時戳)，引擎不代客戶端 filter——管理清單只顯示
     * 活躍是 UI 的事，紀錄側 join 名稱反而兩者都要查得到。
     */
    function listDevices(options) {
      var force = !!(options && options.force);
      return loadContext().then(function (ctx) {
        // 未登入是常態不是錯誤:零請求，直接回碼讓 UI 收起清單入口。
        if (!ctx.token) return { ok: false, code: 'signed_out' };
        // 【死鎖守則】身分在任何 storage 讀寫之前先取好(§12 增補四)。
        return readLocalDevice().then(function (device) {
          // currentDeviceId 只認本機身分，不從清單反查(D26):本機這台不在清單
          // 裡時反查會得到 null，於是它在 UI 上變成一台可移除的別台裝置。
          var currentDeviceId = device ? device.deviceId : null;
          return readDevicesCache().then(function (cache) {
            var fresh =
              cache !== null &&
              cache.stale !== true &&
              finiteNumber(cache.fetchedAt) &&
              now() - cache.fetchedAt < DEVICES_TTL_MS;
            if (!force && fresh) {
              return {
                ok: true,
                devices: cache.devices,
                currentDeviceId: currentDeviceId,
                fetchedAt: cache.fetchedAt,
              };
            }
            return call(ctx, 'GET', '/api/v1/devices')
              .then(function (payload) {
                var devices = payload && Array.isArray(payload.devices) ? payload.devices : [];
                var fetchedAt = now();
                // 新快取不帶 stale:旗標留著的話往後每一次開框都強制往返。
                return writeDevicesCache({ fetchedAt: fetchedAt, devices: devices }).then(function () {
                  return {
                    ok: true,
                    devices: devices,
                    currentDeviceId: currentDeviceId,
                    fetchedAt: fetchedAt,
                  };
                });
              })
              .catch(failDevices);
          });
        });
      });
    }

    /**
     * 改名。**PUT 只有這一條路徑**(D24):首次註冊交給 sync 內嵌的 device 區塊，
     * 絕不拿 PUT 當心跳——那會讓每一輪同步都多一次寫入。
     */
    function renameDevice(deviceId, name) {
      return loadContext().then(function (ctx) {
        if (!ctx.token) return { ok: false, code: 'signed_out' };
        return call(ctx, 'PUT', '/api/v1/devices/' + encodeURIComponent(deviceId), { name: name })
          .then(function (payload) {
            var device = payload && payload.device && typeof payload.device === 'object' ? payload.device : null;
            if (!device) return { ok: true, device: device };
            // 快取就地更新:改完名不必為了看到新名字再打一次 GET。
            return readDevicesCache().then(function (cache) {
              if (!cache) return { ok: true, device: device };
              var next = cache.devices.map(function (row) {
                if (!row || row.deviceId !== device.deviceId) return row;
                // PUT 遇已移除的 id 在後端就是復活(§13):快取不得停在已移除
                // 態，否則改完名那一列還是回不到管理清單。
                return Object.assign({}, row, device, { removedAt: null });
              });
              return writeDevicesCache(Object.assign({}, cache, { devices: next })).then(function () {
                return { ok: true, device: device };
              });
            });
          })
          // 失敗不動快取:樂觀更新的還原由 UI 端負責，引擎這邊維持原樣。
          .catch(failDevices);
      });
    }

    /**
     * 移除別台。404 視同成功(冪等):別台早就被移除過＝目的已達成，不該報錯。
     *
     * 移除是軟刪除(§13):快取那一列標上 removedAt 而不是刪掉，紀錄側 join 名稱
     * 時還查得到原名——移除的本意只是整理清單，不該讓舊紀錄的來源全變未知裝置。
     * 時戳優先取回應帶的值，沒有就用本機時鐘;已經標過的保留最初值。
     */
    function removeDevice(deviceId) {
      return loadContext().then(function (ctx) {
        if (!ctx.token) return { ok: false, code: 'signed_out' };
        return call(ctx, 'DELETE', '/api/v1/devices/' + encodeURIComponent(deviceId))
          .catch(function (err) {
            if (err && err.status === 404) return null;
            throw err;
          })
          .then(function (payload) {
            var removedAt =
              payload && finiteNumber(payload.removedAt) ? payload.removedAt : now();
            return readDevicesCache().then(function (cache) {
              if (!cache) return { ok: true };
              var next = cache.devices.map(function (row) {
                if (!row || row.deviceId !== deviceId) return row;
                if (finiteNumber(row.removedAt)) return row;
                return Object.assign({}, row, { removedAt: removedAt });
              });
              return writeDevicesCache(Object.assign({}, cache, { devices: next })).then(function () {
                return { ok: true };
              });
            });
          })
          .catch(failDevices);
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
      listDevices: listDevices,
      renameDevice: renameDevice,
      removeDevice: removeDevice,
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
    SIGN_IN_CANCELLED: SIGN_IN_CANCELLED,
    SIGN_IN_TRANSIENT: SIGN_IN_TRANSIENT,
    signInKindOf: signInKindOf,
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
