# ─────────────────────────────────────────────────────────────────────────────
#  Dental Clinic Management System – Create desktop icon + shortcut
# ─────────────────────────────────────────────────────────────────────────────
param([string]$AppDir)

if (-not $AppDir) { $AppDir = Split-Path -Parent $PSScriptRoot }
$AppDir  = $AppDir.TrimEnd('\')
$desktop = [Environment]::GetFolderPath('Desktop')
$pngPath = Join-Path $AppDir 'public\img\logo.png'
$icoSrc  = Join-Path $AppDir 'public\img\dental.ico'
$icoData = "$env:ProgramData\DentalClinic\dental.ico"   # space-free path required by WScript.Shell
$iconPath = $icoData

# ── 1.  Build multi-size ICO from logo.png (matches the browser tab icon) ────
try {
    Add-Type -AssemblyName System.Drawing

    if (-not (Test-Path $pngPath)) { throw "logo.png not found: $pngPath" }

    $source = New-Object System.Drawing.Bitmap($pngPath)

    # Render three sizes: 16, 32, 48 px
    $sizes = @(16, 32, 48)
    $pngBlobs = @()

    foreach ($sz in $sizes) {
        $bmp = New-Object System.Drawing.Bitmap($sz, $sz)
        $g   = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $g.DrawImage($source, 0, 0, $sz, $sz)
        $g.Dispose()

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngBlobs += ,($sz, $ms.ToArray())
        $bmp.Dispose(); $ms.Dispose()
    }
    $source.Dispose()

    # Write multi-entry ICO: ICONDIR + n×ICONDIRENTRY + PNG data
    $count      = $pngBlobs.Count
    $dataOffset = 6 + $count * 16

    $stream = New-Object System.IO.MemoryStream
    $bw     = New-Object System.IO.BinaryWriter($stream)

    # ICONDIR
    $bw.Write([uint16]0)       # reserved
    $bw.Write([uint16]1)       # type = ICO
    $bw.Write([uint16]$count)

    # ICONDIRENTRY for each size
    $offset = $dataOffset
    foreach ($entry in $pngBlobs) {
        $sz  = $entry[0]
        $dat = $entry[1]
        $bw.Write([byte]$sz)           # width
        $bw.Write([byte]$sz)           # height
        $bw.Write([byte]0)             # colour count
        $bw.Write([byte]0)             # reserved
        $bw.Write([uint16]1)           # planes
        $bw.Write([uint16]32)          # bit count
        $bw.Write([uint32]$dat.Length) # size
        $bw.Write([uint32]$offset)     # offset
        $offset += $dat.Length
    }

    # PNG image data
    foreach ($entry in $pngBlobs) { $bw.Write($entry[1]) }
    $bw.Flush()
    $icoBytes = $stream.ToArray()
    $bw.Dispose(); $stream.Dispose()

    # Save to app folder and to space-free ProgramData path
    [System.IO.File]::WriteAllBytes($icoSrc, $icoBytes)
    New-Item -ItemType Directory -Force -Path "$env:ProgramData\DentalClinic" | Out-Null
    [System.IO.File]::WriteAllBytes($icoData, $icoBytes)

    Write-Host "  [OK] Icon created ($count sizes: $($sizes -join '/')px)" -ForegroundColor Green
}
catch {
    Write-Host "  [WARN] Could not create custom icon: $_" -ForegroundColor Yellow
    $iconPath = "$env:SystemRoot\System32\shell32.dll,13"
}

# ── 2.  Desktop shortcut (.lnk) — silent launch via launch.vbs ───────────────
try {
    $lnkPath = "$desktop\Dental Clinic.lnk"
    $vbsPath = Join-Path $AppDir 'scripts\launch.vbs'
    $wscript = "$env:SystemRoot\System32\wscript.exe"

    # Remove stale shortcut first to avoid icon cache bleed
    if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }

    $shell    = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($lnkPath)
    $shortcut.TargetPath       = $wscript
    $shortcut.Arguments        = "`"$vbsPath`""
    $shortcut.WorkingDirectory = $AppDir
    $shortcut.Description      = 'Dental Clinic Management System'
    $shortcut.IconLocation     = "$iconPath,0"
    $shortcut.Save()

    Write-Host "  [OK] Desktop shortcut: $lnkPath" -ForegroundColor Green
}
catch {
    Write-Host "  [WARN] Could not create shortcut: $_" -ForegroundColor Yellow
}

# Remove legacy URL shortcut if it exists from an older install
$oldUrl = "$desktop\Dental Clinic - Open.url"
if (Test-Path $oldUrl) { Remove-Item $oldUrl -Force }

# Flush Windows icon cache so the new icon appears immediately
try {
    Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 600
    Remove-Item "$env:LOCALAPPDATA\IconCache.db" -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*" -Force -ErrorAction SilentlyContinue
    Start-Process explorer.exe
    Start-Sleep -Milliseconds 400
} catch {}

Write-Host ''
Write-Host '  Shortcut is ready on your Desktop!' -ForegroundColor Cyan
