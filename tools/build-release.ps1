<#
.SYNOPSIS
    打包 Threads Clean Link 成 Chrome Web Store 上架用的 zip。

.DESCRIPTION
    只封裝上架必要的檔案:manifest.json、background.js、clipboard-guard.js、
    bridge.js，以及 icons/ 資料夾底下的圖示檔(*.png / *.svg / *.ico)。
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

# 直接複製的檔案(非資料夾)
$includeFiles = @(
    'manifest.json',
    'background.js',
    'clipboard-guard.js',
    'bridge.js'
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
