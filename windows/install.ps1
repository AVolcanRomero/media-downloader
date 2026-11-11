# Media Downloader — Windows installer.
# Copies the app to %LOCALAPPDATA%\Media Downloader, downloads its engine
# (portable Node.js, yt-dlp, ffmpeg) and adds Start-menu and Desktop shortcuts.
# No admin rights needed. Run again to update; settings and history are kept.
# Usage: install.ps1            install or update
#        install.ps1 -Uninstall remove the app (your downloaded files stay)
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads 10x slower in PowerShell 5
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Name     = 'Media Downloader'
$Root     = Join-Path $env:LOCALAPPDATA $Name
$Bin      = Join-Path $Root 'bin'
$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartLnk = Join-Path ([Environment]::GetFolderPath('Programs')) "$Name.lnk"
$DeskLnk  = Join-Path ([Environment]::GetFolderPath('Desktop')) "$Name.lnk"

function Step($text) { Write-Host "  $text" }
function Done($text) { Write-Host "  $text" -ForegroundColor Green }

function Stop-App {
  # Ends the engine and the app window if they are running.
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Root*" -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
Write-Host "  $Name" -ForegroundColor White
Write-Host ''

if ($Uninstall) {
  Stop-App
  Remove-Item $StartLnk, $DeskLnk -Force -ErrorAction SilentlyContinue
  Remove-Item $Root -Recurse -Force -ErrorAction SilentlyContinue
  Done 'Removed. Files you downloaded are still in Downloads\Media Downloader.'
  exit 0
}

function Get-File($url, $dest) {
  Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing -Headers @{ 'User-Agent' = 'MediaDownloader-Installer' }
}

try {
  Stop-App
  New-Item -ItemType Directory -Force -Path $Root, $Bin | Out-Null
  $tmp = Join-Path $env:TEMP ("md-setup-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  # 1. App files (replaced on every install so updates land).
  Step 'Copying the app…'
  $appDir = Join-Path $Root 'app'
  if (Test-Path $appDir) { Remove-Item $appDir -Recurse -Force }
  Copy-Item (Join-Path $Here 'app') $appDir -Recurse
  foreach ($f in 'launch.ps1', 'launch.vbs', 'icon.ico', 'install.ps1') { Copy-Item (Join-Path $Here $f) $Root -Force }
  Get-ChildItem $Root -Recurse -File | Unblock-File

  $arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'

  # 2. Node.js (portable, latest LTS) — runs the app's engine.
  if (-not (Test-Path (Join-Path $Bin 'node.exe'))) {
    Step 'Downloading Node.js…'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $plat = if ($arm) { 'win-arm64' } else { 'win-x64' }
    $zip = Join-Path $tmp 'node.zip'
    Get-File "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-$plat.zip" $zip
    Expand-Archive $zip (Join-Path $tmp 'node') -Force
    Get-ChildItem (Join-Path $tmp 'node') -Recurse -Filter node.exe | Select-Object -First 1 |
      Copy-Item -Destination $Bin -Force
  }

  # 3. yt-dlp — the downloader. It updates itself later from Settings → Update engine.
  if (-not (Test-Path (Join-Path $Bin 'yt-dlp.exe'))) {
    Step 'Downloading yt-dlp…'
    Get-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $Bin 'yt-dlp.exe')
  }

  # 4. ffmpeg + ffprobe — merging, trimming, previews.
  if (-not (Test-Path (Join-Path $Bin 'ffmpeg.exe')) -or -not (Test-Path (Join-Path $Bin 'ffprobe.exe'))) {
    Step 'Downloading ffmpeg (about 100 MB)…'
    $zip = Join-Path $tmp 'ffmpeg.zip'
    $url = if ($arm) { 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-winarm64-gpl.zip' }
           else { 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip' }
    Get-File $url $zip
    Expand-Archive $zip (Join-Path $tmp 'ffmpeg') -Force
    foreach ($exe in 'ffmpeg.exe', 'ffprobe.exe') {
      Get-ChildItem (Join-Path $tmp 'ffmpeg') -Recurse -Filter $exe | Select-Object -First 1 |
        Copy-Item -Destination $Bin -Force
    }
  }
  Get-ChildItem $Bin -File | Unblock-File

  # 5. Shortcuts.
  Step 'Adding shortcuts…'
  $shell = New-Object -ComObject WScript.Shell
  foreach ($lnk in $StartLnk, $DeskLnk) {
    $s = $shell.CreateShortcut($lnk)
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = '"' + (Join-Path $Root 'launch.vbs') + '"'
    $s.WorkingDirectory = $Root
    $s.IconLocation = (Join-Path $Root 'icon.ico') + ',0'
    $s.Description = 'Download and trim video and audio from almost any site'
    $s.Save()
  }

  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host ''
  Done "Installed. Open $Name from the Start menu or the Desktop."
  Write-Host ''
  Start-Process (Join-Path $env:WINDIR 'System32\wscript.exe') -ArgumentList ('"' + (Join-Path $Root 'launch.vbs') + '"')
} catch {
  Write-Host ''
  Write-Host "  Setup stopped: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '  Check your internet connection and run Install again.'
  Write-Host ''
  exit 1
}
