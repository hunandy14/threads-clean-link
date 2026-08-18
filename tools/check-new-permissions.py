"""比對兩份 manifest.json，找出「擴權」的新增項目。

供 .github/workflows/release.yml 的「檢查是否新增權限」步驟呼叫，也可以在
本機單獨執行以驗證比對邏輯(不需要 GitHub Actions 環境、不呼叫任何網路
API)。

用法:
    python tools/check-new-permissions.py <前一版 manifest.json 路徑> <本次 manifest.json 路徑>

輸出:
    只印出「本次比前一版新增」的項目，每行一個；若無新增則不輸出任何東西。
    只看新增——被移除的項目不影響 CI 的自動送審把關，不算數。

比對範圍(審查滲透實測指出:只比 permissions/host_permissions 兩個欄位可
以被繞過——改動 optional_permissions/optional_host_permissions，或不動
permission 陣列、只在 content_scripts 裡新增 match pattern 擴大實際生效
範圍，兩者都不會被抓到，因此擴大成四個欄位 + content_scripts matches 聯
集):
    - permissions
    - host_permissions
    - optional_permissions
    - optional_host_permissions
    - content_scripts[*].matches 的聯集(新增 match pattern 等同擴權，即使
      沒有動任何 permissions 相關欄位；用聯集而非逐一 script 比對，是因為
      同一個 URL pattern 換了組(從第一個 content_scripts entry 移到新增
      的 entry)不構成新增，只有「聯集裡真的多出從沒出現過的 pattern」才算)

以上每個欄位在新舊 manifest 裡都可能缺席(field 不存在於 JSON 裡)，一律
視為空陣列/空清單處理，不會因缺欄位而丟例外。
"""
import json
import sys


def _matches_union(manifest: dict) -> set[str]:
    union: set[str] = set()
    for entry in manifest.get('content_scripts') or []:
        union.update(entry.get('matches') or [])
    return union


def added_permissions(prev: dict, curr: dict) -> list[str]:
    added: list[str] = []
    for field in (
        'permissions',
        'host_permissions',
        'optional_permissions',
        'optional_host_permissions',
    ):
        prev_set = set(prev.get(field) or [])
        curr_set = set(curr.get(field) or [])
        added.extend(sorted(curr_set - prev_set))

    prev_matches = _matches_union(prev)
    curr_matches = _matches_union(curr)
    added.extend(sorted(curr_matches - prev_matches))

    return added


def main() -> None:
    if len(sys.argv) != 3:
        print('用法: python tools/check-new-permissions.py <prev.json> <curr.json>', file=sys.stderr)
        sys.exit(2)

    prev_path, curr_path = sys.argv[1], sys.argv[2]

    with open(prev_path, encoding='utf-8') as f:
        prev = json.load(f)
    with open(curr_path, encoding='utf-8') as f:
        curr = json.load(f)

    for item in added_permissions(prev, curr):
        print(item)


if __name__ == '__main__':
    main()
