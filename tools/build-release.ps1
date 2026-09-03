<#
.SYNOPSIS
    打包 Threads Clean Link 成 Chrome Web Store 上架用的 zip。

.DESCRIPTION
    只封裝上架必要的檔案:manifest.json、四支執行腳本(background/guard/
    bridge/i18n)、popup 三件套、options 三件套，以及 icons/ 資料夾底下的
    圖示檔(*.png / *.svg / *.ico)，還有 _locales/ 資料夾底下每個語系的
    messages.json(雙語門面:en 為 fallback、zh_TW 為繁中)。
    白名單與 manifest/HTML 實際引用的對齊由 test/package.test.js 靜態把關,
    新增執行檔時漏改這裡會直接紅燈。
    README.md、LICENSE、tools/、tmp/、icons/gen-icons.ps1 等開發用檔案一律
    不打包，避免非必要內容混進上架用的壓縮檔。

    輸出到 repo 根目錄的 dist/threads-clean-link-v{版本}.zip，版本號直接讀
    manifest.json 的 "version" 欄位，避免手動打錯版號。dist/ 已加入
    .gitignore，不會被提交進版本控制。

.NOTES
    執行方式(於任何目錄皆可，腳本會自行定位 repo 根目錄):
        pwsh -File tools/build-release.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

# repo 根目錄 = 這支腳本所在目錄(tools/)的上一層
$repoRoot = Split-Path -Parent $PSScriptRoot

$manifestPath = Join-Path $repoRoot 'manifest.json'
if (-not (Test-Path $manifestPath)) {
    throw "找不到 manifest.json:$manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$version = $manifest.version
if (-not $version) {
    throw 'manifest.json 沒有 version 欄位，無法決定輸出檔名'
}

# 防止 dev-browser.mjs 為 --env local 注入的 http://localhost:8787/* 這類
# 開發用 host 權限，因 dev-build-loaded 副本內容被誤當成正式 manifest 打包
# 進上架 zip——打包前先擋，命中就直接中止，不產出 zip。
$devHostPatterns = @('localhost', '127\.0\.0\.1', '^http://')
$hostPermissionEntries = @($manifest.host_permissions) + @($manifest.optional_host_permissions) | Where-Object { $_ }
foreach ($hostEntry in $hostPermissionEntries) {
    foreach ($pattern in $devHostPatterns) {
        if ($hostEntry -imatch $pattern) {
            throw "manifest.json 的 host 權限混入開發用網域，禁止打包:$hostEntry(命中樣式:$pattern)"
        }
    }
}

# 直接複製的檔案(非資料夾)
$includeFiles = @(
    'manifest.json',
    'background.js',
    'clipboard-guard.js',
    'bridge.js',
    'i18n.js',
    'tcl-core.js',
    'auth.js',
    'sync.js',
    'post-icon.js',
    'popup.html',
    'popup.js',
    'popup-init.js',
    'options.html',
    'options.js',
    'options-init.js'
)

foreach ($file in $includeFiles) {
    $filePath = Join-Path $repoRoot $file
    if (-not (Test-Path $filePath -PathType Leaf)) {
        throw "缺少必要檔案，無法打包:$file"
    }
}

$iconsDir = Join-Path $repoRoot 'icons'
if (-not (Test-Path $iconsDir -PathType Container)) {
    throw "缺少必要資料夾，無法打包:icons/"
}

# icons/ 內只取圖示檔，排除 gen-icons.ps1 這類開發用腳本
$iconFiles = Get-ChildItem -Path $iconsDir -File | Where-Object {
    $_.Extension -in @('.png', '.svg', '.ico')
}
if (-not $iconFiles -or $iconFiles.Count -eq 0) {
    throw 'icons/ 底下找不到任何圖示檔(*.png / *.svg / *.ico)'
}

$localesDir = Join-Path $repoRoot '_locales'
if (-not (Test-Path $localesDir -PathType Container)) {
    throw "缺少必要資料夾，無法打包:_locales/"
}

# _locales/ 底下每個語系資料夾各自的 messages.json 都要整包收進去，manifest.json
# 的 name/description 才能靠 __MSG_xxx__ 依瀏覽器語言顯示對應文案(雙語門面)。
$localeMessageFiles = Get-ChildItem -Path $localesDir -Recurse -File -Filter 'messages.json'
if (-not $localeMessageFiles -or $localeMessageFiles.Count -eq 0) {
    throw '_locales/ 底下找不到任何 messages.json'
}

$distDir = Join-Path $repoRoot 'dist'
if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

$zipName = "threads-clean-link-v$version.zip"
$zipPath = Join-Path $distDir $zipName

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force -Confirm:$false
}

# 用暫存資料夾組裝要打包的內容，確保 zip 內檔案在根目錄，而不是多包一層
# 路徑，符合 Chrome Web Store 對 zip 結構的要求。
$stagingDir = Join-Path ([System.IO.Path]::GetTempPath()) ('tcl-release-' + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stagingDir | Out-Null

try {
    foreach ($file in $includeFiles) {
        Copy-Item -Path (Join-Path $repoRoot $file) -Destination (Join-Path $stagingDir $file)
    }

    $stagingIconsDir = Join-Path $stagingDir 'icons'
    New-Item -ItemType Directory -Path $stagingIconsDir | Out-Null
    foreach ($iconFile in $iconFiles) {
        Copy-Item -Path $iconFile.FullName -Destination (Join-Path $stagingIconsDir $iconFile.Name)
    }

    $stagingLocalesDir = Join-Path $stagingDir '_locales'
    foreach ($localeFile in $localeMessageFiles) {
        $localeName = Split-Path -Path (Split-Path -Path $localeFile.FullName -Parent) -Leaf
        $localeDestDir = Join-Path $stagingLocalesDir $localeName
        New-Item -ItemType Directory -Path $localeDestDir -Force | Out-Null
        Copy-Item -Path $localeFile.FullName -Destination (Join-Path $localeDestDir $localeFile.Name)
    }

    Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $zipPath -Force
}
finally {
    Remove-Item -Path $stagingDir -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "打包完成:$zipPath"
Write-Host ''
Write-Host '壓縮包內容:'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
    $archive.Entries | Sort-Object FullName | ForEach-Object {
        Write-Host ('  {0} ({1} bytes)' -f $_.FullName, $_.Length)
    }
}
finally {
    $archive.Dispose()
}
