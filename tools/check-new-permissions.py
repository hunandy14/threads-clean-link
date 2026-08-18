"""比對兩份 manifest.json 的 permissions／host_permissions，找出新增項目。

供 .github/workflows/release.yml 的「檢查是否新增權限」步驟呼叫，也可以在
本機單獨執行以驗證比對邏輯(不需要 GitHub Actions 環境、不呼叫任何網路
API)。

用法:
    python tools/check-new-permissions.py <前一版 manifest.json 路徑> <本次 manifest.json 路徑>

輸出:
    只印出「本次比前一版新增」的項目，每行一個；若無新增則不輸出任何東西。
    只看新增——被移除的項目不影響 CI 的自動送審把關，不算數。

兩份檔案中 permissions／host_permissions 任一欄位都可能缺席(field 不存在
於 JSON 裡)，一律視為空陣列處理，不會因缺欄位而丟例外。
"""
import json
import sys


def added_permissions(prev: dict, curr: dict) -> list[str]:
    added: list[str] = []
    for field in ('permissions', 'host_permissions'):
        prev_set = set(prev.get(field) or [])
        curr_set = set(curr.get(field) or [])
        added.extend(sorted(curr_set - prev_set))
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
