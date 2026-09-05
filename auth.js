// auth.js — Google 登入(OIDC implicit flow)取得 id_token，交給後端換取工作階段。
// 載入環境比照 tcl-core.js:
//   - service worker:background.js 以 importScripts('auth.js') 載入(全域 self)
//   - Node 測試:CommonJS require(純函式部分不碰 chrome API,crypto/btoa/atob
//     取自 globalThis)
//
// 為何是 implicit flow(response_type=id_token)而非授權碼:擴充功能沒有可
// 保管 client secret 的地方，且後端只需要一枚可驗簽的 id_token 來認人。
// redirect_uri 固定為 https://<擴充 ID>.chromiumapp.org/,由 manifest 的 key
// 欄位把擴充 ID 釘死，Console 端才登記得起來。
//
// nonce 是這條流程的重放防線:由呼叫端(sync.js 的同步引擎)在同一個閉包裡產生
// 並傳入，**不落 storage**;本模組把它放進授權請求，回來時與 id_token payload
// 的 nonce 逐字比對(verifyIdTokenPayload)，一次比對就是全部的防線。SW 在授權
// 往返中途被回收時，launchWebAuthFlow 的 promise 鏈整條消失，沒有「待比對的
// 登入」可接，存一份到 storage 也接不回來。
//
// 權限:identity 與後端 host 都是 optional 權限。chrome.permissions.request
// 只能在使用者手勢中呼叫，SW 自行發起一律失敗，因此本模組只提供「探」的一半
// (containsPermissions);「求」的一半在 options 頁的登入按鈕 click handler 內。
(function (root) {
  'use strict';

  var GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
  var GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

  // 授權回呼 fragment 裡屬於「授權伺服器自己出的事」的 error 值(RFC 6749
  // 4.1.2.1)，歸暫時性;其餘非 access_denied 的 error 一律是設定問題。
  var OAUTH_TRANSIENT_ERRORS = ['server_error', 'temporarily_unavailable'];
  var SCOPE = 'openid email profile';

  // 失敗一律帶 err.code——分類的唯一來源(對照表見 sync.js 的
  // SIGN_IN_CANCELLED／SIGN_IN_TRANSIENT)。訊息文字給人看，code 給程式分流，
  // 兩者互不取代:UI 端絕不解析訊息，回報端也拿得到原始描述。detail 留給
  // 「原因值本身有情報」的失敗(例如 OAuth 回呼帶的 error 參數)。
  function authError(code, message, detail) {
    var err = new Error(message || code);
    err.code = code;
    if (detail !== undefined) err.detail = detail;
    return err;
  }

  // chrome.identity.launchWebAuthFlow 的失敗只有一句英文訊息可判讀(API 不給
  // 錯誤碼)，逐條對照;對不上的退回泛用碼 sign_in_failed。
  var LAST_ERROR_CODES = [
    { re: /did not approve|cancel/i, code: 'sign_in_cancelled' },
    { re: /user interaction required/i, code: 'interaction_required' },
    { re: /could not be loaded|timed out/i, code: 'auth_page_unreachable' },
    { re: /incognito/i, code: 'incognito_not_supported' },
    // Chromium 的 kInvalidClientId／kInvalidRedirect:client 沒登記、redirect
    // URI 對不上，都是打包出去就錯的設定問題，重試一百次都一樣。
    { re: /invalid oauth2|did not redirect/i, code: 'oauth_config_error' },
  ];

  function codeForLastError(message) {
    var text = String(message === undefined || message === null ? '' : message);
    for (var i = 0; i < LAST_ERROR_CODES.length; i += 1) {
      if (LAST_ERROR_CODES[i].re.test(text)) return LAST_ERROR_CODES[i].code;
    }
    return 'sign_in_failed';
  }

  // 256 bits 的隨機值，以 base64url 呈現(無填充,URL 安全)。
  function generateNonce() {
    var bytes = new Uint8Array(32);
    root.crypto.getRandomValues(bytes);
    var binary = '';
    for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return root.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function buildAuthorizeUrl(options) {
    var params = new URLSearchParams({
      client_id: options.clientId,
      response_type: 'id_token',
      redirect_uri: options.redirectUri,
      scope: SCOPE,
      nonce: options.nonce,
      prompt: options.prompt || 'select_account',
    });
    return GOOGLE_AUTH_ENDPOINT + '?' + params.toString();
  }

  // id_token 走 URL fragment 回來(implicit flow 不把權杖放進 query),因此
  // 從 # 之後解析;沒有 fragment 或缺 id_token 一律視為失敗。
  //
  // expectedRedirectUri 有給就先比對前綴:launchWebAuthFlow 回傳的網址必須是
  // 本擴充的 chromiumapp.org 位址，換成別的來源就代表這串 fragment 不是我們
  // 發起的那一次授權的產物，整條拒收。
  function extractIdTokenFromRedirect(redirectUrl, expectedRedirectUri) {
    if (typeof redirectUrl !== 'string' || redirectUrl.indexOf('#') === -1) {
      throw authError('sign_in_failed', '授權回呼沒有 fragment，取不到 id_token');
    }
    if (typeof expectedRedirectUri === 'string' && expectedRedirectUri) {
      if (redirectUrl.indexOf(expectedRedirectUri) !== 0) {
        throw authError('redirect_mismatch', '授權回呼的 redirect 前綴與本次請求不符');
      }
    }
    var fragment = redirectUrl.slice(redirectUrl.indexOf('#') + 1);
    var params = new URLSearchParams(fragment);
    var oauthError = params.get('error');
    if (oauthError) {
      // access_denied 是使用者在同意頁按了拒絕，與關掉視窗同一類。
      if (oauthError === 'access_denied') {
        throw authError('sign_in_cancelled', '授權失敗:' + oauthError);
      }
      // server_error／temporarily_unavailable 是授權伺服器自己出的事(RFC 6749
      // 4.1.2.1)，與授權頁載不起來同一類:等一下再試有機會成功。
      if (OAUTH_TRANSIENT_ERRORS.indexOf(oauthError) !== -1) {
        throw authError('auth_page_unreachable', '授權失敗:' + oauthError, oauthError);
      }
      // 其餘一律是 OAuth 設定對不上(client 未登記、redirect_uri 未授權……)，
      // 重試無用，原始值留在 detail 供回報。
      throw authError('oauth_config_error', '授權失敗:' + oauthError, oauthError);
    }
    var idToken = params.get('id_token');
    if (!idToken) throw authError('sign_in_failed', '授權回呼缺少 id_token');
    return idToken;
  }

  function decodeJwtPayload(token) {
    var parts = String(token).split('.');
    if (parts.length !== 3) throw authError('id_token_invalid', 'id_token 不是三段式 JWT');
    var b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var binary = root.atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // 用戶端側的健全性檢查。簽章驗證是後端的責任(擴充功能拿不到也不該保管
  // Google 的公鑰輪替狀態),這裡只擋「拿錯 client 的 token」與重放。
  function verifyIdTokenPayload(payload, expected) {
    if (!payload || typeof payload !== 'object') {
      throw authError('id_token_invalid', 'id_token payload 解析失敗');
    }
    // 預期值本身缺漏時前置拒絕:aud/nonce 比對在 expected 為空字串或 undefined
    // 時會因為 payload 也缺該欄位而「意外相符」，等於整道檢查被繞過。
    if (typeof expected !== 'object' || !expected) {
      throw authError('id_token_invalid', '缺少 id_token 的預期值');
    }
    if (typeof expected.clientId !== 'string' || !expected.clientId) {
      throw authError('client_id_missing', '缺少預期的 client ID，無法驗 aud');
    }
    if (typeof expected.nonce !== 'string' || !expected.nonce) {
      throw authError('nonce_missing', '缺少本次請求的 nonce，無法擋重放');
    }
    if (payload.aud !== expected.clientId) {
      throw authError('client_id_mismatch', 'id_token 的 aud 不是預期的 client ID');
    }
    if (payload.nonce !== expected.nonce) {
      throw authError('nonce_mismatch', 'id_token 的 nonce 與本次請求不符');
    }
    if (GOOGLE_ISSUERS.indexOf(payload.iss) === -1) {
      throw authError('issuer_mismatch', 'id_token 的 iss 不是 Google');
    }
    // exp 是必要欄位:缺漏或型別不對時「跳過過期檢查」等於接受一枚永不過期
    // 的 token，那正是重放攻擊要的東西。
    // 缺 exp 與已過期共用一個碼:兩者說的是同一件事——這枚 token 的有效期
    // 不可信。
    if (typeof payload.exp !== 'number' || !isFinite(payload.exp)) {
      throw authError('id_token_expired', 'id_token 缺少有效的 exp');
    }
    if (payload.exp * 1000 <= Date.now()) {
      throw authError('id_token_expired', 'id_token 已過期');
    }
    return payload;
  }

  function permissionsFor(apiBase) {
    return { permissions: ['identity'], origins: [apiBase.replace(/\/+$/, '') + '/*'] };
  }

  // SW 端的權限探測:只回報「有沒有」，不發起 request(見檔頭「權限」段落)。
  // 同步引擎拿到 false 就把狀態轉成 error/permission_required，由 options 頁
  // 的登入按鈕在使用者手勢內補請求。
  function containsPermissions(descriptor) {
    return new Promise(function (resolve, reject) {
      chrome.permissions.contains(descriptor, function (granted) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(Boolean(granted));
      });
    });
  }

  function launchWebAuthFlow(url) {
    return new Promise(function (resolve, reject) {
      chrome.identity.launchWebAuthFlow({ url: url, interactive: true }, function (redirectUrl) {
        if (chrome.runtime.lastError) {
          var message = chrome.runtime.lastError.message;
          reject(authError(codeForLastError(message), message));
          return;
        }
        if (!redirectUrl) {
          // callback 收到空值而 lastError 沒設，是使用者關掉授權視窗最常見的
          // 形狀:視為取消，不是系統故障。
          reject(authError('sign_in_cancelled', '授權流程未回傳 redirect URL(使用者取消?)'));
          return;
        }
        resolve(redirectUrl);
      });
    });
  }

  // nonce 由呼叫端傳入(引擎生成);本模組不自行生成——授權請求送出的那一枚與
  // 底下驗 payload 用的必須是同一個值，來源只能有一個。
  function signInWithGoogle(options) {
    var clientId = options.clientId;
    var nonce = options.nonce;
    var redirectUri;
    return Promise.resolve()
      .then(function () {
        if (typeof clientId !== 'string' || !clientId) {
          throw authError('client_id_missing', 'signInWithGoogle 缺少 clientId');
        }
        if (typeof nonce !== 'string' || !nonce) {
          throw authError('nonce_missing', 'signInWithGoogle 缺少 nonce');
        }
        redirectUri = chrome.identity.getRedirectURL();
        return launchWebAuthFlow(
          buildAuthorizeUrl({ clientId: clientId, redirectUri: redirectUri, nonce: nonce })
        );
      })
      .then(function (redirectUrl) {
        var idToken = extractIdTokenFromRedirect(redirectUrl, redirectUri);
        var payload = verifyIdTokenPayload(decodeJwtPayload(idToken), {
          clientId: clientId,
          nonce: nonce,
        });
        return { idToken: idToken, nonce: nonce, email: payload.email, payload: payload };
      });
  }

  // credentials:'omit' — 工作階段憑證由呼叫端保管，不讓瀏覽器自動夾帶 cookie。
  // redirect:'error' — 後端不該對這支回 3xx。放任 fetch 自動跟隨的話，轉址後
  // 那一站的回應照樣會被當成後端回應處理(包含採信它的 set-auth-token 標頭)，
  // 等於把整個工作階段的來源交給任何能讓後端轉址的人;與 sync.js 的 call()
  // 同一條紀律，登入這支更是 token 的第一個入口。
  function exchangeWithBackend(options) {
    var url = options.apiBase.replace(/\/+$/, '') + '/api/auth/sign-in/social';
    return fetch(url, {
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'google',
        idToken: { token: options.idToken, nonce: options.nonce },
      }),
    })
      .catch(function (err) {
        // 斷網、DNS 失敗，以及 redirect:'error' 攔下的 3xx，在 fetch 這一層都
        // 是同一種例外。三者都不是設定錯誤，重試有機會成功。
        throw authError('network_error', '連線後端失敗:' + ((err && err.message) || err));
      })
      .then(function (res) {
        return res
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return {
              status: res.status,
              ok: res.ok,
              authToken: res.headers.get('set-auth-token'),
              body: body,
            };
          });
      });
  }

  var api = {
    GOOGLE_AUTH_ENDPOINT: GOOGLE_AUTH_ENDPOINT,
    SCOPE: SCOPE,
    permissionsFor: permissionsFor,
    containsPermissions: containsPermissions,
    generateNonce: generateNonce,
    codeForLastError: codeForLastError,
    buildAuthorizeUrl: buildAuthorizeUrl,
    extractIdTokenFromRedirect: extractIdTokenFromRedirect,
    decodeJwtPayload: decodeJwtPayload,
    verifyIdTokenPayload: verifyIdTokenPayload,
    signInWithGoogle: signInWithGoogle,
    exchangeWithBackend: exchangeWithBackend,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.TCLAuth = api;
})(typeof self !== 'undefined' ? self : globalThis);
