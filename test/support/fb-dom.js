// test/support/fb-dom.js — Facebook 站點設定測試用的 ig-dom 包裝。
//
// 沿用 ig-dom 的迷你 DOM 與 createSiteEnv，只新增 Facebook 需要的東西：
//   - readFbFixture／fbDocument：讀 test/fixtures/facebook/*.html。
//   - createFbEnv：預設來源 https://www.facebook.com 的頁面環境；pathname
//     可帶 query（例如 '/photo/?fbid=…'），location.search 會跟著設定。
//   - clearRects／setRect：增刪 data-fx-top／data-fx-height，控制 ig-dom
//     getBoundingClientRect 替身回傳的版面（無 data-fx-top 的元素 rect 全 0）。
// ig-dom 的既有行為一律不動。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const igDom = require('./ig-dom');

const FB_ORIGIN = 'https://www.facebook.com';
const FB_FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'facebook');

function readFbFixture(name) {
  return fs.readFileSync(path.join(FB_FIXTURE_DIR, name), 'utf8');
}

function fbDocument(name) {
  return igDom.createDocument(readFbFixture(name));
}

function createFbEnv(options) {
  return igDom.createSiteEnv(Object.assign({ origin: FB_ORIGIN }, options || {}));
}

// 移除 node（含）與所有後代的版面 stub，讓它們的 rect 回到全 0。
function clearRects(node) {
  [node].concat(node.querySelectorAll('[data-fx-top]')).forEach((n) => {
    n.removeAttribute('data-fx-top');
    n.removeAttribute('data-fx-height');
  });
}

// 設定 node 的版面 stub：top 與 height（寬固定 400，見 ig-dom）。
function setRect(node, top, height) {
  node.setAttribute('data-fx-top', String(top));
  node.setAttribute('data-fx-height', String(height));
}

module.exports = Object.assign({}, igDom, {
  FB_ORIGIN,
  readFbFixture,
  fbDocument,
  createFbEnv,
  clearRects,
  setRect,
});
