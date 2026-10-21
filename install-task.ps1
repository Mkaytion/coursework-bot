# Registers the bot as a Windows scheduled task that starts at logon, windowless, with a
# tray icon (see tray.ps1). Run this once. To remove it:  Unregister-ScheduledTask -TaskName MyCoursesBot
#
# Deliberately "run only when logged on": running whether-logged-on-or-not requires
# storing your Windows password in the task, which is not worth it for a Discord bot.

$ErrorActionPreference = 'Stop'

$TaskName = 'MyCoursesBot'
$Dir      = $PSScriptRoot

if (-not (Test-Path (Join-Path $Dir '.env'))) { throw "No .env in $Dir" }

# conhost --headless: on Windows 11 a console app launched by the scheduler opens in Windows
# Terminal, which ignores -WindowStyle Hidden. Headless conhost gives it no window at all.
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
  -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Dir\tray.ps1`"" `
  -WorkingDirectory $Dir

# Logon only. Crash recovery lives in tray.ps1's watchdog; a repeating trigger here would
# also resurrect the bot two minutes after you chose Quit from the tray.
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -MultipleInstances IgnoreNew `
  -Hidden

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $atLogon `
  -Settings $settings -Description 'MyCourses/A+ coursework Discord bot' -Force | Out-Null

Write-Output "Registered '$TaskName'. Starts at logon as a tray icon; no window, no taskbar entry."
Write-Output "Logs: $(Join-Path $Dir 'bot.log')"
