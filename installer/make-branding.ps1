<#
.SYNOPSIS
    Generates branded Inno Setup wizard images (BMP) for ADAU.
    Run once (or after a logo/color change). Outputs to installer\branding\.

.DESCRIPTION
    The ADAU logo is a wide white mark (round emblem + wordmark) on a transparent
    background, so it is drawn on the brand gradient. By default only the round
    emblem is used: it is cropped from the left square of the logo (height x height),
    which keeps it legible in the narrow wizard images. Aspect ratio is preserved.
#>
param(
    [string]$Logo = "$PSScriptRoot\..\frontend\public\logos\logo_az.png",
    [string]$OutDir = "$PSScriptRoot\branding",
    [string]$Wordmark = 'ADAU',
    [string]$Tagline = 'Security Platform',
    # Crop the round emblem from the left of the wide logo. Pass -FullLogo to draw the whole mark.
    [switch]$FullLogo
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$primary = [System.Drawing.ColorTranslator]::FromHtml('#aa9ad4')
$dark    = [System.Drawing.ColorTranslator]::FromHtml('#7d6bb0')
$white   = [System.Drawing.Color]::White

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
if (-not (Test-Path $Logo)) { throw "Logo not found: $Logo" }
$logoImg = [System.Drawing.Image]::FromFile((Resolve-Path $Logo))

# Source rectangle inside the logo: the left square (emblem) or the whole image.
$srcSide = [Math]::Min($logoImg.Width, $logoImg.Height)
$srcRect = if ($FullLogo) {
    New-Object System.Drawing.Rectangle 0, 0, $logoImg.Width, $logoImg.Height
} else {
    New-Object System.Drawing.Rectangle 0, 0, $srcSide, $srcSide
}

# Draws the logo fitted into a box (bx, by, bw, bh), centered, aspect ratio preserved.
function Draw-LogoFitted($g, [int]$bx, [int]$by, [int]$bw, [int]$bh) {
    $scale = [Math]::Min($bw / $srcRect.Width, $bh / $srcRect.Height)
    $dw = [int]($srcRect.Width * $scale)
    $dh = [int]($srcRect.Height * $scale)
    $dx = $bx + [int](($bw - $dw) / 2)
    $dy = $by + [int](($bh - $dh) / 2)
    $dest = New-Object System.Drawing.Rectangle $dx, $dy, $dw, $dh
    $g.DrawImage($logoImg, $dest, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
}

function Fill-BrandGradient($g, [int]$w, [int]$h) {
    $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $primary, $dark, 60.0
    $g.FillRectangle($brush, $rect)
    $brush.Dispose()
}

function New-LargeImage([int]$w, [int]$h, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    $g.TextRenderingHint = 'ClearTypeGridFit'
    Fill-BrandGradient $g $w $h
    # Logo in the upper part.
    $ls = [int]($w * 0.62)
    Draw-LogoFitted $g ([int](($w - $ls) / 2)) ([int]($h * 0.17)) $ls $ls
    # Wordmark + tagline.
    $fontMain = New-Object System.Drawing.Font 'Segoe UI', ([single]($w * 0.15)), ([System.Drawing.FontStyle]::Bold)
    $fontSub  = New-Object System.Drawing.Font 'Segoe UI', ([single]($w * 0.052)), ([System.Drawing.FontStyle]::Regular)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = 'Center'
    $wb = New-Object System.Drawing.SolidBrush $white
    $g.DrawString($Wordmark, $fontMain, $wb, (New-Object System.Drawing.RectangleF 0, ([single]($h * 0.55)), $w, ([single]($h * 0.2))), $sf)
    $semi = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(220, 255, 255, 255))
    $g.DrawString($Tagline, $fontSub, $semi, (New-Object System.Drawing.RectangleF 0, ([single]($h * 0.70)), $w, ([single]($h * 0.1))), $sf)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Host "wrote $path ($w x $h)"
}

function New-SmallImage([int]$s, [string]$path) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.InterpolationMode = 'HighQualityBicubic'
    # The logo is white, so it goes on the brand gradient (a white background would hide it).
    Fill-BrandGradient $g $s $s
    $pad = [int]($s * 0.1)
    Draw-LogoFitted $g $pad $pad ($s - 2 * $pad) ($s - 2 * $pad)
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Bmp)
    $bmp.Dispose()
    Write-Host "wrote $path ($s x $s)"
}

New-LargeImage 164 314 (Join-Path $OutDir 'wizard-large.bmp')
New-LargeImage 328 628 (Join-Path $OutDir 'wizard-large@2x.bmp')
New-LargeImage 492 942 (Join-Path $OutDir 'wizard-large@3x.bmp')
New-SmallImage 58  (Join-Path $OutDir 'wizard-small.bmp')
New-SmallImage 116 (Join-Path $OutDir 'wizard-small@2x.bmp')
New-SmallImage 174 (Join-Path $OutDir 'wizard-small@3x.bmp')

$logoImg.Dispose()
Write-Host "Branding images ready in $OutDir"
