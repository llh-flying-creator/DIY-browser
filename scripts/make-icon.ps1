<#
.SYNOPSIS
    把原始方图 build\icon-src.png 处理成圆角透明图标并打包成多尺寸 build\icon.ico。

.DESCRIPTION
    1. 按圆角矩形裁剪原始方图，四角处理为透明（避免深色任务栏/启动页出现白角）；
    2. 输出 build\icon.png 作为启动页 logo（带透明通道）；
    3. 生成 16/24/32/48/64/128/256 七种尺寸，按 ICO 规范写入 build\icon.ico。

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icon.ps1
#>

param(
    [string]$Source,
    [string]$Preview,
    [string]$Output,
    [double]$RadiusRatio = 0.19
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
if (-not $Source) { $Source = Join-Path $root 'build\icon-src.png' }
if (-not $Preview) { $Preview = Join-Path $root 'build\icon.png' }
if (-not $Output) { $Output = Join-Path $root 'build\icon.ico' }

Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) {
    Write-Host "[icon] 未找到源图：$Source" -ForegroundColor Red
    exit 1
}

function New-RoundedPath {
    param([int]$Width, [int]$Height, [int]$Radius)

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $Radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($Width - $d, 0, $d, $d, 270, 90)
    $path.AddArc($Width - $d, $Height - $d, $d, $d, 0, 90)
    $path.AddArc(0, $Height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# ---------- 1. 圆角 + 透明 ----------
$src = [System.Drawing.Image]::FromFile((Resolve-Path $Source).Path)
$width = $src.Width
$height = $src.Height

$rounded = New-Object System.Drawing.Bitmap $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($rounded)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$graphics.Clear([System.Drawing.Color]::Transparent)
$clip = New-RoundedPath -Width $width -Height $height -Radius ([int]($width * $RadiusRatio))
$graphics.SetClip($clip)
$graphics.DrawImage($src, 0, 0, $width, $height)
$graphics.Dispose()
$clip.Dispose()
$src.Dispose()

$rounded.Save($Preview, [System.Drawing.Imaging.ImageFormat]::Png)

# ---------- 2. 多尺寸 ICO ----------
$sizes = 16, 24, 32, 48, 64, 128, 256
$entries = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($rounded, 0, 0, $size, $size)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()

    $entries += ,@{ Size = $size; Data = $ms.ToArray() }
    $ms.Dispose()
}
$rounded.Dispose()

$dir = Split-Path -Parent $Output
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$file = [System.IO.File]::Create($Output)
$writer = New-Object System.IO.BinaryWriter $file

# ICONDIR
$writer.Write([UInt16]0)                 # reserved
$writer.Write([UInt16]1)                 # type = 1 (icon)
$writer.Write([UInt16]$entries.Count)    # image count

# ICONDIRENTRY * N
$offset = 6 + 16 * $entries.Count
foreach ($entry in $entries) {
    $dim = if ($entry.Size -ge 256) { 0 } else { $entry.Size }
    $writer.Write([Byte]$dim)            # width  (0 = 256)
    $writer.Write([Byte]$dim)            # height (0 = 256)
    $writer.Write([Byte]0)               # color palette
    $writer.Write([Byte]0)               # reserved
    $writer.Write([UInt16]1)             # color planes
    $writer.Write([UInt16]32)            # bits per pixel
    $writer.Write([UInt32]$entry.Data.Length)
    $writer.Write([UInt32]$offset)
    $offset += $entry.Data.Length
}

foreach ($entry in $entries) { $writer.Write($entry.Data) }

$writer.Flush()
$writer.Dispose()
$file.Dispose()

$sizeKb = [Math]::Round((Get-Item $Output).Length / 1KB, 1)
Write-Host "[icon] 启动页 logo：$Preview（$width x $height，圆角透明）"
Write-Host "[icon] 图标文件  ：$Output（$($entries.Count) 种尺寸，$sizeKb KB）"
