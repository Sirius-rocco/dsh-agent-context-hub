<#
.SYNOPSIS
    Register (or update) the "AgentContextSync" scheduled task for the agent-context-hub plugin.

.DESCRIPTION
    Creates or updates a Windows Task Scheduler task that runs
        powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <pkg>\scripts\sync.ps1
    daily at 09:45 local time, plus a 2 minute delayed trigger at user logon.
    The task runs as the current interactive user with least privilege and has
    "Start when available" enabled so a missed 09:45 run is picked up later.

    Safety rules:
      * Never deletes other tasks.
      * If a task with the same name exists and does NOT point at this package's
        scripts\sync.ps1, the script aborts instead of overwriting it.
      * Re-running is idempotent (update in place with -Force).

    After registration the script:
      * queries the task with schtasks /Query /TN AgentContextSync /V /FO LIST
        and stores the raw output at <pkg>\cache\task-query.txt,
      * prints an ASCII summary (state, next/last run time, last result, action,
        working directory, triggers).

.PARAMETER TaskName
    Task name. Default AgentContextSync.

.PARAMETER StartTime
    Daily trigger time. Default 09:45.

.PARAMETER LogonDelayMinutes
    Delay of the optional logon trigger. Default 2. Use 0 to skip the logon trigger.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-task.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-task.ps1 -StartTime 10:00
#>
[CmdletBinding()]
param(
    [string]$TaskName = 'AgentContextSync',
    [string]$StartTime = '09:45',
    [int]$LogonDelayMinutes = 2
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$pkgRoot = Split-Path -Parent $scriptDir
$syncPath = Join-Path $scriptDir 'sync.ps1'
$cacheDir = Join-Path $pkgRoot 'cache'
$queryPath = Join-Path $cacheDir 'task-query.txt'
$psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$userId = $env:USERDOMAIN + '\' + $env:USERNAME
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step {
    param([string]$Message)
    Write-Output ('[register-task] ' + $Message)
}

if (-not (Test-Path -LiteralPath $syncPath -PathType Leaf)) {
    Write-Error ('sync.ps1 not found at ' + $syncPath)
    exit 1
}
if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) {
    Write-Error ('powershell.exe not found at ' + $psExe)
    exit 1
}
if (-not (Test-Path -LiteralPath $cacheDir)) {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
}

# --- Guard: refuse to overwrite a same-named task owned by something else ----
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $existingTask) {
    $belongsToUs = $false
    foreach ($act in $existingTask.Actions) {
        $blob = [string]$act.Execute + ' ' + [string]$act.Arguments
        if ($blob -match 'agent-context-hub' -and $blob -match 'sync\.ps1') {
            $belongsToUs = $true
        }
    }
    if (-not $belongsToUs) {
        Write-Error ('A scheduled task named "' + $TaskName + '" already exists but does not point at this package (existing action: ' + (($existingTask.Actions | ForEach-Object { [string]$_.Execute + ' ' + [string]$_.Arguments }) -join ' | ') + '). Aborting WITHOUT changing it. Re-run with -TaskName <other-name> if needed.')
        exit 5
    }
    Write-Step ('existing task "' + $TaskName + '" belongs to this package, it will be updated in place (not deleted).')
}
else {
    Write-Step ('no existing task named "' + $TaskName + '"; it will be created.')
}

# --- Build action / triggers / settings --------------------------------------
$argument = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $syncPath + '"'
$action = New-ScheduledTaskAction -Execute $psExe -Argument $argument -WorkingDirectory $pkgRoot

$triggers = New-Object System.Collections.ArrayList
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $StartTime
[void]$triggers.Add($dailyTrigger)
$triggerSummary = @('daily at ' + $StartTime)

if ($LogonDelayMinutes -gt 0) {
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $userId
    $logonTrigger.Delay = 'PT' + $LogonDelayMinutes + 'M'
    [void]$triggers.Add($logonTrigger)
    $triggerSummary += ('logon + ' + $LogonDelayMinutes + 'm')
}

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$settings.Hidden = $true

$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType Interactive -RunLevel Limited

$description = 'Refresh the DSH agent-context-hub index (node lib\cli.mjs paths shows the file) by running lib\cli.mjs scan. Safe no-op while lib\cli.mjs is missing. Registered by agent-context-hub\scripts\register-task.ps1.'

$registered = $false
try {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggers) -Settings $settings -Principal $principal -Description $description -Force | Out-Null
    $registered = $true
    Write-Step 'registered via Register-ScheduledTask.'
}
catch {
    Write-Step ('Register-ScheduledTask failed: ' + $_.Exception.Message)
    Write-Step 'falling back to schtasks /Create /F (note: WorkingDirectory is not supported by schtasks; sync.ps1 resolves its own paths, so this is acceptable).'
    $quotedSync = '"' + $syncPath + '"'
    $taskRun = '"' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + $quotedSync
    $schtasksArgs = @('/Create', '/F', '/TN', $TaskName, '/SC', 'DAILY', '/ST', $StartTime, '/TR', $taskRun, '/RL', 'LIMITED', '/IT')
    & schtasks.exe @schtasksArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-Error ('schtasks fallback failed with exit code ' + $LASTEXITCODE + '; the task was not registered.')
        exit $LASTEXITCODE
    }
    $registered = $true
    Write-Step 'registered via schtasks fallback.'
}

if (-not $registered) {
    Write-Error 'task registration failed.'
    exit 1
}

# --- Verify with schtasks /Query /V /FO LIST (raw saved for humans) ----------
$rawQuery = ''
$schtasksOk = $false
try {
    $rawQuery = (& schtasks.exe /Query /TN $TaskName /V /FO LIST 2>&1 | Out-String)
    $schtasksOk = ($LASTEXITCODE -eq 0)
    [System.IO.File]::WriteAllText($queryPath, $rawQuery, $Utf8NoBom)
    Write-Step ('schtasks query saved to ' + $queryPath + ' (exit ' + ($LASTEXITCODE) + ')')
}
catch {
    Write-Step ('schtasks query failed: ' + $_.Exception.Message)
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$info = Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $task -or $null -eq $info) {
    Write-Error 'task was registered but cannot be read back; verification failed.'
    exit 6
}

Write-Output ''
Write-Output '=== AgentContextSync verification ==='
Write-Output ('TaskName        : ' + $task.TaskName)
Write-Output ('TaskPath        : ' + $task.TaskPath)
Write-Output ('State           : ' + $task.State)
Write-Output ('Action.Execute  : ' + $task.Actions[0].Execute)
Write-Output ('Action.Arguments: ' + $task.Actions[0].Arguments)
Write-Output ('Action.WorkingDir: ' + $task.Actions[0].WorkingDirectory)
Write-Output ('Triggers        : ' + ($triggerSummary -join '; '))
$triggerIndex = 0
foreach ($t in $task.Triggers) {
    $triggerIndex++
    Write-Output ('Trigger[' + $triggerIndex + ']     : ' + [string]$t.CimClass.CimClassName + ' | Enabled=' + [string]$t.Enabled + ' | StartBoundary=' + [string]$t.StartBoundary + ' | Delay=' + [string]$t.Delay + ' | Repetition=' + [string]$t.Repetition.Interval)
}
Write-Output ('NextRunTime     : ' + $info.NextRunTime)
Write-Output ('LastRunTime     : ' + $info.LastRunTime)
Write-Output ('LastTaskResult  : ' + $info.LastTaskResult)
Write-Output ('NumberOfMissedRuns: ' + $info.NumberOfMissedRuns)
Write-Output ('Principal       : ' + $task.Principal.UserId + ' / ' + $task.Principal.LogonType)

Write-Output ('schtasksQueryExit: ' + $schtasksOk)
Write-Output '=== end verification ==='
