<#
  依品牌來源 SVG(assets/store/icon/app-icon.svg)重新產生擴充功能圖示
  (icons/icon16.png、icon48.png、icon128.png)。

  來源 SVG 是使用者手機 app 的 icon:橘底方塊 + 黑色盾牌 + 白鏈節(Lucide
  link-2 圖形)，盾牌路徑含大量三次貝茲曲線與橢圓弧(SVG 的 c/a 指令)。
  GDI+(System.Drawing)本身不解析 SVG，硬要手刻等價的貝茲/弧形路徑風險
  高、失真也難察覺，因此改借重本機既有的 Chrome/Edge headless 模式做離
  屏渲染——這與本專案既有工具鏈一致(hover 樣式等視覺細節本來就是用
  CDP/headless 模擬 prefers-color-scheme 實機量測校正過，見 post-icon.js
  hover 圓底的量測註解)，沿用同一套機制而非另闢爐灶。

  用法:pwsh -File tools/gen-icons.ps1

  跨平台盡力而為:Join-Path/$PSScriptRoot 本身跨平台，但腳本需要本機有
  Chrome 或 Edge 才能離屏渲染——找不到瀏覽器執行檔時印出訊息並正常結束
  (exit 0)，不丟例外中斷，僅回報「這台機器不支援」。
#>

$ErrorActionPreference = 'Stop'

# Join-Path 一次只接受兩個位置參數(-Path/-ChildPath);多引數的
# -AdditionalChildPath 是 PS6+ 才有的語法，PS 5.1(Windows 內建版本)會直接
# 丟例外。改用 [IO.Path]::Combine——純 .NET 方法呼叫，不受 PowerShell 版本
# 的 cmdlet 參數集限制，多節路徑一次組完，PS 5.1 與 PS6+/pwsh 都能跑。
$iconsDir = [IO.Path]::Combine($PSScriptRoot, '..', 'icons')
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir -Force | Out-Null
}

$svgPath = [IO.Path]::Combine($PSScriptRoot, '..', 'assets', 'store', 'icon', 'app-icon.svg')
if (-not (Test-Path $svgPath)) {
    throw "找不到品牌來源 SVG:$svgPath"
}
$svgContent = Get-Content -Path $svgPath -Raw

# 找本機可用的 headless 瀏覽器:優先 Windows 常見安裝位置的 Chrome/Edge，
# 額外嘗試 Linux/macOS 常見執行檔名稱與路徑，找不到就回傳 $null，讓呼叫
# 端自行決定跳過而非拋例外。
function Find-HeadlessBrowser {
    $candidates = @()
    if ($env:ProgramFiles) {
        $candidates += Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'
        $candidates += Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'
    }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86) {
        $candidates += Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe'
        $candidates += Join-Path $programFilesX86 'Microsoft\Edge\Application\msedge.exe'
    }
    $candidates += @(
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    return $null
}

$browser = Find-HeadlessBrowser
if (-not $browser) {
    Write-Output '找不到本機 Chrome/Edge 執行檔，略過圖示產生(此腳本僅在裝有 Chrome 或 Edge 的環境可用)。'
    exit 0
}

# 把來源 SVG 根 <svg> 標籤的 width/height 換成目標尺寸(viewBox 不動，等
# 比縮放)；只動根標籤一次，避免誤傷內層 <rect>/<path> 自己的 width/height
# 屬性(例如 <rect width="32" height="32">，那是 viewBox 座標系內的尺
# 寸，不能被目標像素尺寸覆蓋)。
function Resize-SvgMarkup {
    param(
        [string]$Markup,
        [int]$Size
    )
    $openTagMatch = [regex]::Match($Markup, '<svg\b[^>]*>')
    if (-not $openTagMatch.Success) {
        throw 'SVG 內容找不到根 <svg> 標籤'
    }
    $openTag = $openTagMatch.Value
    $openTag = $openTag -replace '\s+width="[^"]*"', ''
    $openTag = $openTag -replace '\s+height="[^"]*"', ''
    $openTag = $openTag -replace '>$', " width=`"$Size`" height=`"$Size`">"
    return $Markup.Substring(0, $openTagMatch.Index) + $openTag + $Markup.Substring($openTagMatch.Index + $openTagMatch.Length)
}

function New-IconPngFromSvg {
    param(
        [int]$Size,
        [string]$OutPath,
        [string]$SvgMarkup,
        [string]$Browser
    )

    $sizedSvg = Resize-SvgMarkup -Markup $SvgMarkup -Size $Size
    $html = "<!doctype html><html><head><meta charset=`"utf-8`">" +
        "<style>html,body{margin:0;padding:0;background:transparent;}</style>" +
        "</head><body>$sizedSvg</body></html>"

    $tmpHtml = [System.IO.Path]::ChangeExtension([System.IO.Path]::GetTempFileName(), '.html')
    Set-Content -Path $tmpHtml -Value $html -Encoding UTF8

    try {
        if (Test-Path $OutPath) {
            Remove-Item -Path $OutPath -Force
        }
        $fileUri = 'file:///' + ($tmpHtml -replace '\\', '/')
        & $Browser --headless=new --disable-gpu --hide-scrollbars `
            --screenshot="$OutPath" --window-size="$Size,$Size" `
            --default-background-color=00000000 $fileUri 2>$null | Out-Null
    } finally {
        Remove-Item -Path $tmpHtml -Force -ErrorAction SilentlyContinue
    }

    if (-not (Test-Path $OutPath)) {
        throw "產生失敗，headless 瀏覽器沒有寫出檔案:$OutPath"
    }
}

$sizes = @(16, 48, 128)
foreach ($size in $sizes) {
    $outPath = Join-Path $iconsDir "icon$size.png"
    New-IconPngFromSvg -Size $size -OutPath $outPath -SvgMarkup $svgContent -Browser $browser
    Write-Output "已產生 $outPath"
}
