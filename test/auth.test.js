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
