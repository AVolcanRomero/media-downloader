# Starts the Media Downloader engine and opens its window (Edge app mode).
# Closing the window stops the engine. Started hidden by launch.vbs.
$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent $MyInvocation.MyCommand.Path
$Bin     = Join-Path $Root 'bin'
$Port    = 4865
$Url     = "http://localhost:$Port/"
$WinProfile = Join-Path $Root 'window'   # separate browser profile: its own window, taskbar entry and settings

function Test-Engine {
  try { (Invoke-WebRequest "${Url}api/state" -UseBasicParsing -TimeoutSec 1).StatusCode -eq 200 } catch { $false }
}

function Show-Error($text) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show($text, 'Media Downloader', 'OK', 'Error') | Out-Null
}

$browser = @(
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { Show-Error 'Microsoft Edge was not found. Install Edge, then open Media Downloader again.'; exit 1 }

$windowArgs = @(
  "--app=$Url", "--user-data-dir=`"$WinProfile`"", '--window-size=1240,840',
  '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
  '--disable-features=msEdgeSidebarV2,msHubApps,msUndersideButton'
)

# Already running: just bring up another window on the same engine.
if (Test-Engine) { Start-Process $browser -ArgumentList $windowArgs; exit 0 }

if (-not (Test-Path (Join-Path $Bin 'node.exe'))) {
  Show-Error 'The engine is missing. Run "Install Media Downloader" again.'; exit 1
}

# Start the engine with no console window. It exits by itself when this script ends.
$env:MD_BIN = $Bin
$env:MD_DATA = Join-Path $Root 'data'
$env:PORT = "$Port"
$env:MD_PARENT_PID = "$PID"
$log = Join-Path $Root 'server.log'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = Join-Path $env:WINDIR 'System32\cmd.exe'
$psi.Arguments = '/d /c ""' + (Join-Path $Bin 'node.exe') + '" "' + (Join-Path $Root 'app\server.js') + '" > "' + $log + '" 2>&1"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$psi.WorkingDirectory = Join-Path $Root 'app'
$engine = [System.Diagnostics.Process]::Start($psi)

$ready = $false
for ($i = 0; $i -lt 80; $i++) {
  if (Test-Engine) { $ready = $true; break }
  if ($engine.HasExited) { break }
  Start-Sleep -Milliseconds 250
}
if (-not $ready) { Show-Error "The engine did not start. Details: $log"; exit 1 }

Start-Process $browser -ArgumentList $windowArgs | Out-Null

# Keep the engine alive while any app window is open.
function Get-AppBrowsers {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$WinProfile*" }
}
function Test-WindowOpen {
  foreach ($p in Get-AppBrowsers) {
    $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { return $true }
  }
  $false
}
for ($i = 0; $i -lt 60 -and -not (Test-WindowOpen); $i++) { Start-Sleep -Milliseconds 500 }
while (Test-WindowOpen) { Start-Sleep -Seconds 2 }

# Window closed: stop leftover browser helpers and the engine (and its yt-dlp/ffmpeg children).
Get-AppBrowsers | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (-not $engine.HasExited) { & taskkill.exe /PID $engine.Id /T /F | Out-Null }
