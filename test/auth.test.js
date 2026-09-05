// test/auth.test.js — auth.js 的純函式部分(不碰 chrome API):nonce 生成、
// 授權 URL 組裝、id_token 解析與 aud/nonce/iss/exp 驗證。
//
// 簽章驗證刻意不在測試範圍內——那是後端的責任，用戶端只擋「拿錯 client 的
// token」與重放，因此測試用未簽章的假 JWT 就足以涵蓋此檔的全部判定。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const TCLAuth = require('../auth.js');

const CLIENT_ID = '17054024593-p003rp6cqmm9ks4r8mdphal1ahr3rhum.apps.googleusercontent.com';
const REDIRECT_URI = 'https://hehokicokbgajpanjcajhmflaennnmdj.chromiumapp.org/';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// 假 JWT:簽章段填任意字串,decodeJwtPayload 只讀中段。
function fakeJwt(payload) {
  return [b64url({ alg: 'RS256', typ: 'JWT' }), b64url(payload), 'not-a-real-signature'].join('.');
}

function validPayload(overrides) {
  return Object.assign(
    {
      iss: 'https://accounts.google.com',
      aud: CLIENT_ID,
      sub: '1234567890',
      email: 'someone@example.com',
      email_verified: true,
      nonce: 'nonce-abc',
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    overrides
  );
}

// ---- nonce ----

test('nonce:43 字元 base64url，且不重複', () => {
  const seen = new Set();
  for (let i = 0; i < 64; i += 1) {
    const nonce = TCLAuth.generateNonce();
    assert.match(nonce, /^[A-Za-z0-9_-]{43}$/, 'nonce 應為 URL 安全的 base64url');
    assert.equal(seen.has(nonce), false, 'nonce 不得重複');
    seen.add(nonce);
  }
});

// ---- 授權 URL ----

test('授權 URL:endpoint 與各查詢參數齊備', () => {
  const url = new URL(
    TCLAuth.buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      nonce: 'nonce-abc',
    })
  );

  assert.equal(url.origin + url.pathname, TCLAuth.GOOGLE_AUTH_ENDPOINT);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('response_type'), 'id_token');
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  assert.equal(url.searchParams.get('nonce'), 'nonce-abc');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

test('授權 URL:prompt 可覆寫', () => {
  const url = new URL(
    TCLAuth.buildAuthorizeUrl({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      nonce: 'n',
      prompt: 'none',
    })
  );
  assert.equal(url.searchParams.get('prompt'), 'none');
});

// ---- 從 redirect 取 id_token ----

test('redirect:從 fragment 取出 id_token', () => {
  const token = fakeJwt(validPayload());
  const redirect = `${REDIRECT_URI}#id_token=${token}&token_type=bearer`;
  assert.equal(TCLAuth.extractIdTokenFromRedirect(redirect), token);
});

test('redirect:query 帶 id_token 不算數(implicit flow 只認 fragment)', () => {
  assert.throws(
    () => TCLAuth.extractIdTokenFromRedirect(`${REDIRECT_URI}?id_token=x`),
    /沒有 fragment/
  );
});

test('redirect:fragment 帶 error 時丟錯', () => {
  assert.throws(
    () => TCLAuth.extractIdTokenFromRedirect(`${REDIRECT_URI}#error=access_denied`),
    /授權失敗/
  );
});

test('redirect:fragment 缺 id_token 時丟錯', () => {
  assert.throws(
    () => TCLAuth.extractIdTokenFromRedirect(`${REDIRECT_URI}#token_type=bearer`),
    /缺少 id_token/
  );
});

// ---- payload 解析 ----

test('payload:解出 JWT 中段，含非 ASCII 欄位', () => {
  const payload = validPayload({ name: '測試帳號' });
  assert.deepEqual(TCLAuth.decodeJwtPayload(fakeJwt(payload)), payload);
});

test('payload:非三段式 JWT 丟錯', () => {
  assert.throws(() => TCLAuth.decodeJwtPayload('a.b'), /三段式/);
});

// ---- aud / nonce / iss / exp 驗證 ----

test('驗證:aud 與 nonce 相符時通過', () => {
  const payload = validPayload();
  assert.equal(
    TCLAuth.verifyIdTokenPayload(payload, { clientId: CLIENT_ID, nonce: 'nonce-abc' }),
    payload
  );
});

test('驗證:aud 是別的 client 時拒收', () => {
  assert.throws(
    () =>
      TCLAuth.verifyIdTokenPayload(validPayload({ aud: 'other.apps.googleusercontent.com' }), {
        clientId: CLIENT_ID,
        nonce: 'nonce-abc',
      }),
    /aud 不是預期/
  );
});

test('驗證:nonce 不符時拒收(擋重放)', () => {
  assert.throws(
    () =>
      TCLAuth.verifyIdTokenPayload(validPayload(), {
        clientId: CLIENT_ID,
        nonce: 'another-nonce',
      }),
    /nonce 與本次請求不符/
  );
});

test('驗證:payload 缺 nonce 時拒收', () => {
  const payload = validPayload();
  delete payload.nonce;
  assert.throws(
    () => TCLAuth.verifyIdTokenPayload(payload, { clientId: CLIENT_ID, nonce: 'nonce-abc' }),
    /nonce 與本次請求不符/
  );
});

test('驗證:iss 不是 Google 時拒收', () => {
  assert.throws(
    () =>
      TCLAuth.verifyIdTokenPayload(validPayload({ iss: 'https://evil.example' }), {
        clientId: CLIENT_ID,
        nonce: 'nonce-abc',
      }),
    /iss 不是 Google/
  );
});

test('驗證:兩種合法 iss 皆接受', () => {
  for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
    assert.doesNotThrow(() =>
      TCLAuth.verifyIdTokenPayload(validPayload({ iss }), {
        clientId: CLIENT_ID,
        nonce: 'nonce-abc',
      })
    );
  }
});

test('驗證:已過期的 token 拒收', () => {
  assert.throws(
    () =>
      TCLAuth.verifyIdTokenPayload(validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }), {
        clientId: CLIENT_ID,
        nonce: 'nonce-abc',
      }),
    /已過期/
  );
});

// ---- 權限描述子 ----

test('權限描述子:identity 加上後端 host,尾隨斜線不重複', () => {
  const expected = {
    permissions: ['identity'],
    origins: ['https://api-staging.metalinkclearer.workers.dev/*'],
  };
  assert.deepEqual(TCLAuth.permissionsFor('https://api-staging.metalinkclearer.workers.dev'), expected);
  assert.deepEqual(TCLAuth.permissionsFor('https://api-staging.metalinkclearer.workers.dev/'), expected);
});

test('權限描述子:origins 落在 manifest 宣告的 optional_host_permissions 內', () => {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'manifest.json'), 'utf8')
  );
  for (const base of [
    'https://api.metalinkclearer.workers.dev',
    'https://api-staging.metalinkclearer.workers.dev',
  ]) {
    const [origin] = TCLAuth.permissionsFor(base).origins;
    assert.ok(
      manifest.optional_host_permissions.includes(origin),
      `${origin} 應已在 manifest 的 optional_host_permissions 宣告`
    );
  }
  assert.ok(manifest.optional_permissions.includes('identity'));
});

// local（http://localhost:8787）刻意不進商店版 manifest:它是 dev-browser
// 產出的 manifest 副本才注入的開發用權限，混進上架版等於平白多要一項審查
// 委員會會問、使用者也看得到的權限。
test('權限描述子:localhost 不得出現在商店版 manifest 的 optional_host_permissions', () => {
  const manifest = JSON.parse(
    require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'manifest.json'), 'utf8')
  );
  const [origin] = TCLAuth.permissionsFor('http://localhost:8787').origins;
  assert.equal(origin, 'http://localhost:8787/*');
  assert.ok(
    !manifest.optional_host_permissions.some((h) => h.includes('localhost')),
    '商店版 manifest 不得宣告 localhost 權限'
  );
});

// ---- exp 為必要欄位 ----
//
// 缺 exp 時「跳過過期檢查」等於接受一枚永不過期的 id_token，那正是重放要的
// 東西;型別不對(字串秒數、null)同樣不能放行。

test('驗證:payload 缺 exp 時拒收', () => {
  const payload = validPayload();
  delete payload.exp;
  assert.throws(
    () => TCLAuth.verifyIdTokenPayload(payload, { clientId: CLIENT_ID, nonce: 'nonce-abc' }),
    /缺少有效的 exp/
  );
});

test('驗證:exp 非數字時拒收', () => {
  for (const exp of [String(Math.floor(Date.now() / 1000) + 3600), null, NaN, Infinity]) {
    assert.throws(
      () => TCLAuth.verifyIdTokenPayload(validPayload({ exp }), { clientId: CLIENT_ID, nonce: 'nonce-abc' }),
      /缺少有效的 exp/,
      `exp 為 ${String(exp)} 時應拒收`
    );
  }
});

// ---- 預期值空值的前置拒絕 ----
//
// expected.clientId／nonce 為空時，payload 也缺該欄位就會「意外相符」
// (undefined === undefined),整道 aud/nonce 檢查等於被繞過。

test('驗證:expected.clientId 空值時前置拒絕，不落入 aud 比對', () => {
  const payload = validPayload();
  delete payload.aud;
  for (const clientId of [undefined, '', null]) {
    assert.throws(
      () => TCLAuth.verifyIdTokenPayload(payload, { clientId, nonce: 'nonce-abc' }),
      /缺少預期的 client ID/,
      `clientId 為 ${String(clientId)} 時應前置拒絕`
    );
  }
});

test('驗證:expected.nonce 空值時前置拒絕，不落入 nonce 比對', () => {
  const payload = validPayload();
  delete payload.nonce;
  for (const nonce of [undefined, '', null]) {
    assert.throws(
      () => TCLAuth.verifyIdTokenPayload(payload, { clientId: CLIENT_ID, nonce }),
      /缺少本次請求的 nonce/,
      `nonce 為 ${String(nonce)} 時應前置拒絕`
    );
  }
});

test('驗證:expected 整個缺席時拒收', () => {
  assert.throws(() => TCLAuth.verifyIdTokenPayload(validPayload(), null), /缺少 id_token 的預期值/);
});

// ---- redirect 前綴比對 ----
//
// launchWebAuthFlow 回來的網址必須是本擴充的 chromiumapp.org 位址;換成別的
// 來源就代表這串 fragment 不是我們發起的那一次授權的產物。

test('redirect:前綴與本次請求相符時取得 id_token', () => {
  const token = fakeJwt(validPayload());
  assert.equal(
    TCLAuth.extractIdTokenFromRedirect(`${REDIRECT_URI}#id_token=${token}`, REDIRECT_URI),
    token
  );
});

test('redirect:前綴不是本次的 redirect_uri 時拒收', () => {
  const token = fakeJwt(validPayload());
  assert.throws(
    () =>
      TCLAuth.extractIdTokenFromRedirect(
        `https://evil.example/callback#id_token=${token}`,
        REDIRECT_URI
      ),
    /redirect 前綴與本次請求不符/
  );
});

test('redirect:另一個擴充 ID 的 chromiumapp 位址同樣拒收', () => {
  const token = fakeJwt(validPayload());
  assert.throws(
    () =>
      TCLAuth.extractIdTokenFromRedirect(
        `https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/#id_token=${token}`,
        REDIRECT_URI
      ),
    /redirect 前綴與本次請求不符/
  );
});

test('redirect:不給預期前綴時維持原行為(呼叫端自行把關)', () => {
  const token = fakeJwt(validPayload());
  assert.equal(TCLAuth.extractIdTokenFromRedirect(`https://other.example/#id_token=${token}`), token);
});

// ---- exchangeWithBackend 的請求形狀 ----
//
// 契約見 docs/cloud-sync.md 第 3 節「登入」「帶入方式」:POST
// /api/auth/sign-in/social、application/json、credentials:"omit"、body 為
// { provider:"google", idToken:{ token, nonce } }。錯一項後端就回 400/415,
// 或(credentials 沒關掉)夾帶 cookie 擴大 CSRF 風險面。

test('exchangeWithBackend:端點、標頭與 body 形狀逐條符合契約', async () => {
  const calls = [];
  const savedFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'set-auth-token' ? 'tok-xyz' : null) },
      json: async () => ({ user: { id: 'user-1', email: 'someone@example.com' }, redirect: false }),
    });
  };
  try {
    const result = await TCLAuth.exchangeWithBackend({
      apiBase: 'https://api-staging.metalinkclearer.workers.dev/',
      idToken: 'fake.id.token',
      nonce: 'nonce-abc',
    });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://api-staging.metalinkclearer.workers.dev/api/auth/sign-in/social',
      'apiBase 的尾隨斜線不得變成雙斜線'
    );
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'omit', 'D1:一律不夾帶 cookie');
    assert.equal(
      calls[0].init.redirect,
      'error',
      '跟著轉址走的話，轉址目的地的 set-auth-token 也會被當成後端發的 token'
    );
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json', '否則後端回 415');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      provider: 'google',
      idToken: { token: 'fake.id.token', nonce: 'nonce-abc' },
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(result.authToken, 'tok-xyz', 'token 取自 set-auth-token 標頭');
    assert.equal(result.body.user.id, 'user-1');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('exchangeWithBackend:回應不是 JSON 時 body 為 null，不整個丟例外', async () => {
  const savedFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => {
        throw new Error('not json');
      },
    });
  try {
    const result = await TCLAuth.exchangeWithBackend({
      apiBase: 'https://api.metalinkclearer.workers.dev',
      idToken: 'x',
      nonce: 'n',
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.body, null);
    assert.equal(result.authToken, null);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// ============================================================================
// L2 — 登入失敗一律帶 err.code(分類的唯一來源)
// ============================================================================
//
// 使用者把 Google 視窗關掉、授權頁載不起來、id_token 的 aud 對不上……在
// auth.js 眼裡全部只是「一個 Error」，訊息還是中文散文;引擎接到之後只能一
// 律記成 sign_in_failed，UI 端因此分不出「使用者自己取消」與「設定錯了」。
// 分類的唯一來源是 `err.code`:本節逐條釘住 launchWebAuthFlow 的
// chrome.runtime.lastError 對照、redirect fragment 的錯誤、payload 驗證的四
// 種不符，以及後端交換的網路例外。訊息文字不在契約內(既有斷言仍以中文訊息
// 比對，兩者並存)。

const AUTH_REDIRECT_URI = REDIRECT_URI;

// chrome 全域只在呼叫當下被讀取(auth.js 內是裸 `chrome` 參照)，因此逐條
// 測試各自注入自己的替身，跑完還原——測試檔共用同一個 Node realm。
function withFakeChrome(impl, fn) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'chrome');
  const saved = globalThis.chrome;
  globalThis.chrome = impl;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (had) globalThis.chrome = saved;
      else delete globalThis.chrome;
    });
}

// 假 chrome.identity:launchWebAuthFlow 依 opts 決定「回一串 redirectUrl」或
// 「設 chrome.runtime.lastError 後回 undefined」(真實 API 的失敗形狀)。
function identityChrome(opts) {
  return {
    runtime: { lastError: opts.lastError || undefined },
    identity: {
      getRedirectURL: () => AUTH_REDIRECT_URI,
      launchWebAuthFlow(details, callback) {
        callback(opts.redirectUrl);
      },
    },
  };
}

/** 跑一次 signInWithGoogle，回傳它丟出來的例外(沒丟就丟測試用的哨兵)。 */
async function signInFailure(opts, overrides) {
  let thrown = null;
  let resolved = false;
  await withFakeChrome(identityChrome(opts), async () => {
    try {
      await TCLAuth.signInWithGoogle(
        Object.assign({ clientId: CLIENT_ID, nonce: 'nonce-abc' }, overrides)
      );
      resolved = true;
    } catch (err) {
      thrown = err;
    }
  });
  assert.equal(resolved, false, 'signInWithGoogle 應該失敗，測試前提不成立');
  return thrown;
}

/** 同步呼叫的錯誤碼取用器。 */
function codeOfThrow(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.code;
  }
  assert.fail('應丟例外');
}

test('L2 launchWebAuthFlow:chrome.runtime.lastError 逐條對照成 err.code', async () => {
  const cases = [
    // 使用者在 Google 同意頁按「取消」／直接關掉視窗。
    { message: 'The user did not approve access.', code: 'sign_in_cancelled' },
    { message: 'canceled', code: 'sign_in_cancelled' },
    { message: 'User interaction required.', code: 'interaction_required' },
    { message: 'Authorization page could not be loaded.', code: 'auth_page_unreachable' },
    { message: 'The operation timed out.', code: 'auth_page_unreachable' },
    { message: 'Cannot use identity API in incognito mode.', code: 'incognito_not_supported' },
    // 對不上任何一條的訊息才退回泛用碼。
    { message: 'Unexpected wobble', code: 'sign_in_failed' },
  ];
  for (const c of cases) {
    const err = await signInFailure({ lastError: { message: c.message } });
    assert.equal(err.code, c.code, `lastError「${c.message}」應對照成 ${c.code}`);
  }
});

test('L2 launchWebAuthFlow:沒有 lastError 但 redirectUrl 為空 → sign_in_cancelled', async () => {
  // 關掉授權視窗最常見的形狀:callback 收到 undefined，lastError 沒設。
  for (const redirectUrl of [undefined, null, '']) {
    const err = await signInFailure({ redirectUrl });
    assert.equal(
      err.code,
      'sign_in_cancelled',
      `redirectUrl 為 ${String(redirectUrl)} 時應判為使用者取消，不是系統故障`
    );
  }
});

test('L2 redirect fragment:access_denied 是取消，其他 error 是設定錯誤(帶 detail)', () => {
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.extractIdTokenFromRedirect(`${AUTH_REDIRECT_URI}#error=access_denied`, AUTH_REDIRECT_URI)
    ),
    'sign_in_cancelled',
    'access_denied 是使用者在同意頁按了拒絕，不該報成故障'
  );

  let configErr = null;
  try {
    TCLAuth.extractIdTokenFromRedirect(
      `${AUTH_REDIRECT_URI}#error=invalid_client`,
      AUTH_REDIRECT_URI
    );
  } catch (err) {
    configErr = err;
  }
  assert.ok(configErr, '應丟例外');
  assert.equal(configErr.code, 'oauth_config_error');
  assert.equal(configErr.detail, 'invalid_client', '原始 error 值要留在 detail，回報時才問得出所以然');
});

test('L2 redirect fragment:前綴不符 → redirect_mismatch，缺 id_token → sign_in_failed', () => {
  const token = fakeJwt(validPayload());
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.extractIdTokenFromRedirect(`https://evil.example/callback#id_token=${token}`, AUTH_REDIRECT_URI)
    ),
    'redirect_mismatch'
  );
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.extractIdTokenFromRedirect(`${AUTH_REDIRECT_URI}#token_type=bearer`, AUTH_REDIRECT_URI)
    ),
    'sign_in_failed'
  );
});

test('L2 verifyIdTokenPayload:aud／nonce／iss／exp 四種不符各有自己的 code', () => {
  const expected = { clientId: CLIENT_ID, nonce: 'nonce-abc' };
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.verifyIdTokenPayload(validPayload({ aud: 'other.apps.googleusercontent.com' }), expected)
    ),
    'client_id_mismatch'
  );
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.verifyIdTokenPayload(validPayload(), { clientId: CLIENT_ID, nonce: 'another-nonce' })
    ),
    'nonce_mismatch'
  );
  assert.equal(
    codeOfThrow(() => TCLAuth.verifyIdTokenPayload(validPayload({ iss: 'https://evil.example' }), expected)),
    'issuer_mismatch'
  );
  assert.equal(
    codeOfThrow(() =>
      TCLAuth.verifyIdTokenPayload(validPayload({ exp: Math.floor(Date.now() / 1000) - 1 }), expected)
    ),
    'id_token_expired'
  );
  const noExp = validPayload();
  delete noExp.exp;
  assert.equal(
    codeOfThrow(() => TCLAuth.verifyIdTokenPayload(noExp, expected)),
    'id_token_expired',
    '缺 exp 與已過期同屬一類:這枚 token 的有效期不可信'
  );
});

test('L2 signInWithGoogle:驗證失敗的 code 原樣往上丟，不被吞成泛用碼', async () => {
  const token = fakeJwt(validPayload({ aud: 'other.apps.googleusercontent.com' }));
  const err = await signInFailure({ redirectUrl: `${AUTH_REDIRECT_URI}#id_token=${token}` });
  assert.equal(err.code, 'client_id_mismatch');
});

test('L2 exchangeWithBackend:fetch 例外(含 redirect:"error" 被拒)→ network_error', async () => {
  const savedFetch = globalThis.fetch;
  // 斷網與「後端回了 3xx，redirect:'error' 讓 fetch 直接 reject」在這一層是
  // 同一種形狀:fetch 丟 TypeError。兩者都不是設定錯誤，重試有機會成功。
  for (const boom of [new TypeError('Failed to fetch'), new TypeError('Failed to fetch: redirect')]) {
    globalThis.fetch = () => Promise.reject(boom);
    let thrown = null;
    try {
      await TCLAuth.exchangeWithBackend({
        apiBase: 'https://api.metalinkclearer.workers.dev',
        idToken: 'fake.id.token',
        nonce: 'nonce-abc',
      });
    } catch (err) {
      thrown = err;
    } finally {
      globalThis.fetch = savedFetch;
    }
    assert.ok(thrown, 'fetch 失敗時應丟例外');
    assert.equal(thrown.code, 'network_error');
  }
});

test('L2 launchWebAuthFlow:Chromium 的設定錯誤訊息歸 oauth_config_error', async () => {
  // kInvalidClientId／kInvalidRedirect:client 沒登記、redirect URI 對不上。
  // 這兩串與「授權頁載不起來」長得像，但重試永遠不會成功，不能歸暫時性。
  for (const message of ['Invalid OAuth2 Client ID.', 'Did not redirect to the right URL.']) {
    const err = await signInFailure({ lastError: { message } });
    assert.equal(err.code, 'oauth_config_error', `lastError「${message}」是設定錯誤，不是暫時性`);
  }
});

test('L2 redirect fragment:授權伺服器自己出的事歸 auth_page_unreachable', () => {
  // RFC 6749 4.1.2.1:server_error／temporarily_unavailable 描述的是授權端
  // 的暫時狀況，與我們的設定無關，等一下再試有機會成功。
  for (const oauthError of ['server_error', 'temporarily_unavailable']) {
    let thrown = null;
    try {
      TCLAuth.extractIdTokenFromRedirect(
        `${AUTH_REDIRECT_URI}#error=${oauthError}`,
        AUTH_REDIRECT_URI
      );
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, '應丟例外');
    assert.equal(thrown.code, 'auth_page_unreachable', `${oauthError} 應歸暫時性`);
    assert.equal(thrown.detail, oauthError, '原始 error 值仍要留在 detail');
  }
});
