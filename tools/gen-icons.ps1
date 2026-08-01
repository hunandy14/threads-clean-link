<#
  產生擴充功能佔位圖示(icons/icon16.png、icon48.png、icon128.png)。
  純色圓角底 + 簡單白色圖形，不追求美術，純粹讓 manifest.json 的 icons 欄位有檔案可指。
  用法:pwsh -File tools/gen-icons.ps1
#>

Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath {
    param(
        [System.Drawing.RectangleF]$Rect,
        [float]$Radius
    )
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
    $path.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-IconPng {
    param(
        [int]$Size,
        [string]$OutPath
    )

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    # 底色:近黑圓角方塊(呼應 Threads 品牌黑白配色)
    $bgColor = [System.Drawing.Color]::FromArgb(255, 16, 16, 16)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $margin = [Math]::Max(1, [int]($Size * 0.04))
    $rect = New-Object System.Drawing.RectangleF($margin, $margin, ($Size - 2 * $margin), ($Size - 2 * $margin))
    $radius = $Size * 0.22
    $path = New-RoundedRectPath -Rect $rect -Radius $radius
    $g.FillPath($bgBrush, $path)

    # 簡單圖形:代表「乾淨連結」的白色實心圓
    $fgBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $dotSize = $Size * 0.4
    $dotOffset = ($Size - $dotSize) / 2
    $g.FillEllipse($fgBrush, $dotOffset, $dotOffset, $dotSize, $dotSize)

    $g.Flush()

    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)

    $fgBrush.Dispose()
    $bgBrush.Dispose()
    $path.Dispose()
    $g.Dispose()
    $bmp.Dispose()
}

$iconsDir = Join-Path $PSScriptRoot '..\icons'
if (-not (Test-Path $iconsDir)) {
    New-Item -ItemType Directory -Path $iconsDir -Force | Out-Null
}

$sizes = @(16, 48, 128)
foreach ($size in $sizes) {
    $outPath = Join-Path $iconsDir "icon$size.png"
    New-IconPng -Size $size -OutPath $outPath
    Write-Output "已產生 $outPath"
}
