# Runs the bot with no console window and a tray icon instead of a taskbar entry.
# Right-click the icon: Show log / Restart / Quit. Quit stays quit until next logon.
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$dir  = $PSScriptRoot
$log  = Join-Path $dir 'bot.log'
$node = (Get-Command node).Source
$script:proc = $null
$script:quitting = $false

function Start-Bot {
  # cmd only exists to append stdout+stderr to bot.log; CreateNoWindow keeps it invisible
  $psi = New-Object System.Diagnostics.ProcessStartInfo $env:ComSpec, "/c `"`"$node`" --env-file=.env bot.js >> bot.log 2>&1`""
  $psi.WorkingDirectory = $dir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $script:proc = [System.Diagnostics.Process]::Start($psi)
}

function Stop-Bot {
  # /T: killing cmd alone would orphan node, leaving the bot running with no tray
  if ($script:proc -and -not $script:proc.HasExited) { & taskkill.exe /PID $script:proc.Id /T /F *> $null }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($node)
$tray.Text = 'Coursework bot'
$menu = New-Object System.Windows.Forms.ContextMenuStrip
[void]$menu.Items.Add('Show log', $null, {
  Start-Process powershell -ArgumentList '-NoProfile', '-NoExit', '-Command', "Get-Content '$log' -Tail 30 -Wait"
})
[void]$menu.Items.Add('Restart', $null, { Stop-Bot })  # the watchdog below starts it again
[void]$menu.Items.Add('Quit', $null, {
  $script:quitting = $true
  Stop-Bot
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$tray.ContextMenuStrip = $menu
$tray.Visible = $true

# Watchdog: replaces the scheduler's 2-minute poll, and recovers in seconds instead.
# ponytail: nothing supervises this tray process itself; if it dies, the bot is down until next logon.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ if (-not $script:quitting -and $script:proc.HasExited) { Start-Bot } })

Start-Bot
$timer.Start()
[System.Windows.Forms.Application]::Run()
$tray.Dispose()
