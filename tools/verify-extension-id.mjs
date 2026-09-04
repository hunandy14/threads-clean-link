// tools/verify-extension-id.mjs — 由 manifest.json 的 key 推導擴充 ID 並比對。
//
// Chrome 的擴充 ID = 公鑰 DER 的 SHA-256，取前 16 bytes(32 個 hex 字元)，
// 每個 hex digit 0-f 平移為字母 a-p。manifest 帶 key 欄位時，unpacked dev
// build 與 Chrome Web Store 版本會算出同一個 ID——OAuth redirect URI
// (https://<id>.chromiumapp.org/)綁死在這個 ID 上，key 掉了或被換掉，登入
// 流程會整條斷掉，因此由測試與 CI 常態把關。
//
// 用法:
//     node tools/verify-extension-id.mjs [manifest 路徑]
// 退出碼 0 表示相符，非 0 表示不符或 manifest 缺 key。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const EXPECTED_EXTENSION_ID = 'hehokicokbgajpanjcajhmflaennnmdj';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// hex digit → a-p:'0'→'a'、'f'→'p'。
export function extensionIdFromKey(base64Key) {
  const der = Buffer.from(base64Key, 'base64');
  const digest = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...digest].map((c) => String.fromCharCode(parseInt(c, 16) + 0x61)).join('');
}

export function extensionIdFromManifest(manifestPath = path.join(REPO_ROOT, 'manifest.json')) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!manifest.key) {
    throw new Error(`manifest 缺少 key 欄位:${manifestPath}`);
  }
  return extensionIdFromKey(manifest.key);
}

// 僅在直接執行時輸出並決定退出碼;被 import 時純粹當函式庫。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const id = extensionIdFromManifest(process.argv[2]);
    console.log(id);
    if (id !== EXPECTED_EXTENSION_ID) {
      console.error(`擴充 ID 不符:預期 ${EXPECTED_EXTENSION_ID}，實得 ${id}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
