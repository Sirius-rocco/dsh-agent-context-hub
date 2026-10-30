<#
.SYNOPSIS
    Refresh the DSH agent-context-hub index for the "Agent Context Hub" panel.

.DESCRIPTION
    Runs:  node <pkg>\scripts\sync-remote.mjs --host <host> --quiet
           node <pkg>\lib\cli.mjs scan --out <index> --quiet
    where <index> is the file reported by `node <pkg>\lib\cli.mjs paths --json`
    (default: ~/.dsh/agent-context/index.json), so the scheduled task and the
    panel always read the same file.

    Appends a structured run record (timestamp, node used, exit code, elapsed,
    stdout, stderr) to <index dir>\sync.log. The remote step only refreshes the
    metadata fragment of sessions living on the ssh host (remote\remote-<host>.json);
    their bodies are read over ssh on demand and never copied locally.

    Designed for Windows Task Scheduler ("AgentContextSync", daily 09:45), but is
    safe to run manually and is idempotent: every run regenerates the index from
    the read-only Codex rollout files and never mutates ~/.codex.

    Exit codes:
        0   scan succeeded (cli exit 0)
        2   lib\cli.mjs is missing (e.g. plugin install incomplete) - safe no-op
        4   no node.exe available (neither the fixed DSH runtime node nor PATH)
        1   unexpected script error (the cli exit code is passed through otherwise)
        3   cli reported "no sessions" (passed through from cli.mjs)
        *   any other value is the cli.mjs exit code, passed through unchanged

    The log self-rotates: when sync.log exceeds -MaxLogBytes (default 1 MiB) the
    file is truncated to its last -KeepTailBytes bytes (default 256 KiB) at the
    start of a run, with a rotation header line.

.PARAMETER OutFile
    Index output path. Defaults to <pkg>\cache\index.json.

.PARAMETER NodePath
    Explicit node.exe to use. Defaults to the fixed DSH runtime node, then PATH.

.PARAMETER MaxLogBytes
    Rotate sync.log when it is larger than this many bytes. Default 1048576.

.PARAMETER KeepTailBytes
    Number of trailing bytes to keep on rotation. Default 262144.

.PARAMETER SkipUpstreamCheck
    Skip the upstream "obsidian hook" check. By default every run records the
    state of the Codex `obsidian` automation (09:30 Asia/Shanghai, which
    maintains the handoff library) and how long ago that library was last
    refreshed, so the 09:45 slot provably still follows it. The check is
    read-only and never changes the exit code.

.PARAMETER SkipRemote
    Skip refreshing the metadata of sessions that live on the ssh host
    (cache\remote-<host>.json, written by scripts\sync-remote.mjs). By default
    the remote fragment is refreshed before the local scan so one scan indexes
    both. A remote failure is logged as a WARN and keeps the previous fragment;
    it never changes the exit code.

.PARAMETER RemoteHost
    ssh host (or ~/.ssh/config alias) holding the remote Codex sessions.
    Defaults to rag_research.

.PARAMETER RemoteTimeoutSeconds
    Per-host budget for the remote metadata scan. Defaults to 120 seconds.

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync.ps1

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\sync.ps1 -OutFile C:\Temp\index.json
#>
[CmdletBinding()]
param(
    [string]$OutFile,
    [string]$NodePath,
    [int64]$MaxLogBytes = 1048576,
    [int]$KeepTailBytes = 262144,
    [switch]$SkipUpstreamCheck,
    [switch]$SkipRemote,
    [string]$RemoteHost = 'rag_research',
    [int]$RemoteTimeoutSeconds = 120
)

$ErrorActionPreference = 'Stop'

# --- Resolve package layout from the script's own location -------------------
$scriptDir = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
}
$pkgRoot = Split-Path -Parent $scriptDir
$libDir = Join-Path $pkgRoot 'lib'
$cacheDir = Join-Path $pkgRoot 'cache'
$cliPath = Join-Path $libDir 'cli.mjs'
# Fallback only: the real log lives next to the index once `cli.mjs paths` answers.
$logPath = Join-Path $cacheDir 'sync.log'

# Fixed node shipped with the DSH primary runtime (matches the task registration).
$FixedNodePath = 'D:\Users\80407921\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $cacheDir)) {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
}

function Write-SyncLog {
    param([string]$Message)
    $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') + '] ' + $Message + "`r`n"
    [System.IO.File]::AppendAllText($logPath, $line, $Utf8NoBom)
}

function Write-SyncLogBlock {
    param([string]$Header, [string]$Text)
    if ([string]::IsNullOrEmpty($Text)) {
        $Text = '(empty)'
    }
    if (-not $Text.EndsWith("`n")) {
        $Text = $Text + "`r`n"
    }
    [System.IO.File]::AppendAllText($logPath, $Header + "`r`n" + $Text + "`r`n", $Utf8NoBom)
}

function Invoke-LogRotation {
    param(
        [string]$Path,
        [int64]$LimitBytes,
        [int]$TailBytes
    )
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $item = Get-Item -LiteralPath $Path
    $len = $item.Length
    if ($len -le $LimitBytes) { return }

    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $start = $bytes.Length - $TailBytes
    if ($start -lt 0) { $start = 0 }

    # Start the kept tail at a line boundary when possible.
    if ($start -gt 0) {
        $newlineIndex = [Array]::IndexOf($bytes, [byte]10, $start)
        if ($newlineIndex -ge 0 -and ($newlineIndex + 1) -lt $bytes.Length) {
            $start = $newlineIndex + 1
        }
    }

    $tailLength = $bytes.Length - $start
    $tail = New-Object byte[] $tailLength
    [Array]::Copy($bytes, $start, $tail, 0, $tailLength)

    $header = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz') + '] log rotated: previous size ' + $len + ' bytes exceeded ' + $LimitBytes + ' bytes; kept last ' + $tailLength + ' bytes' + "`r`n"
    $headerBytes = $Utf8NoBom.GetBytes($header)
    $combined = New-Object byte[] ($headerBytes.Length + $tailLength)
    [Array]::Copy($headerBytes, 0, $combined, 0, $headerBytes.Length)
    [Array]::Copy($tail, 0, $combined, $headerBytes.Length, $tailLength)
    [System.IO.File]::WriteAllBytes($Path, $combined)
}

function Write-UpstreamCheck {
    param(
        [string]$AutomationToml,
        [string]$LibraryRoot
    )
    # Read-only "obsidian hook": the Codex automation at 09:30 maintains the
    # handoff library; this task at 09:45 refreshes the session index after it.
    # Record both sides so a silent upstream stop is visible in sync.log.
    try {
        if (Test-Path -LiteralPath $AutomationToml) {
            $toml = [System.IO.File]::ReadAllText($AutomationToml, [System.Text.Encoding]::UTF8)
            if ($toml -match '(?m)^status\s*=\s*"([^"]+)"') { $status = $Matches[1] } else { $status = 'unknown' }
            if ($toml -match '(?m)^rrule\s*=\s*"([^"]+)"') { $rrule = $Matches[1] } else { $rrule = 'unknown' }
            Write-SyncLog ('upstream obsidian automation: status=' + $status + ' | rrule=' + $rrule)
            if ($status -ne 'ACTIVE') {
                Write-SyncLog ('WARN upstream obsidian automation is not ACTIVE (status=' + $status + '); the handoff library may be stale.')
            }
            if ($rrule -notmatch 'BYHOUR=9' -or $rrule -notmatch 'BYMINUTE=30') {
                Write-SyncLog ('WARN upstream obsidian rrule changed to "' + $rrule + '"; the 09:45 slot may no longer follow it.')
            }
        }
        else {
            Write-SyncLog ('WARN upstream obsidian automation not found at ' + $AutomationToml)
        }

        $newest = $null
        foreach ($name in @('START_HERE.md', 'COVERAGE.md')) {
            $candidate = Join-Path $LibraryRoot $name
            if (Test-Path -LiteralPath $candidate) {
                $stamp = (Get-Item -LiteralPath $candidate).LastWriteTime
                if ($null -eq $newest -or $stamp -gt $newest) { $newest = $stamp }
            }
        }
        if ($null -ne $newest) {
            $ageHours = [math]::Round(((Get-Date) - $newest).TotalHours, 1)
            Write-SyncLog ('upstream handoff library last refreshed: ' + $newest.ToString('yyyy-MM-dd HH:mm:ss') + ' (' + $ageHours + 'h ago)')
            if ($ageHours -gt 48) {
                Write-SyncLog ('WARN upstream handoff library has not changed for ' + $ageHours + 'h; check the Codex obsidian automation before trusting it as current.')
            }
        }
        else {
            Write-SyncLog ('WARN upstream handoff library entry files not found under ' + $LibraryRoot)
        }
    }
    catch {
        Write-SyncLog ('upstream check skipped: ' + $_.Exception.Message)
    }
}

function Invoke-RemoteSync {
    param(
        [string]$ScriptPath,
        [string]$NodePath,
        [string]$WorkingDirectory,
        [string]$HostName,
        [int]$TimeoutSeconds
    )
    # Remote sessions (bodies stay on the ssh host) are indexed from a metadata
    # fragment. Refresh it before the local scan so one scan covers both; a
    # failure keeps the previous fragment and only warns.
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Write-SyncLog ('remote sync skipped: ' + $ScriptPath + ' not present')
        return
    }
    $tempOut = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-remote-' + [guid]::NewGuid().ToString('N') + '.out')
    $tempErr = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-remote-' + [guid]::NewGuid().ToString('N') + '.err')
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $code = 1
    $failure = $null
    try {
        $argumentList = @('"' + $ScriptPath + '"', '--host', ('"' + $HostName + '"'), '--timeout', $TimeoutSeconds, '--quiet')
        $process = Start-Process -FilePath $NodePath -ArgumentList $argumentList -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr
        $code = $process.ExitCode
    }
    catch {
        $failure = $_.Exception.Message
        $code = 1
    }
    $watch.Stop()
    $elapsed = [math]::Round($watch.Elapsed.TotalSeconds, 3)

    $outText = ''
    $errText = ''
    if (Test-Path -LiteralPath $tempOut) {
        $outText = [System.IO.File]::ReadAllText($tempOut, [System.Text.Encoding]::UTF8)
        Remove-Item -LiteralPath $tempOut -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempErr) {
        $errText = [System.IO.File]::ReadAllText($tempErr, [System.Text.Encoding]::UTF8)
        Remove-Item -LiteralPath $tempErr -Force -ErrorAction SilentlyContinue
    }

    Write-SyncLog ('remote sync | host=' + $HostName + ' | exit=' + $code + ' | elapsed=' + $elapsed + 's')
    if ($null -ne $failure) {
        Write-SyncLog ('WARN remote sync could not start: ' + $failure + ' (previous fragment kept)')
    }
    elseif ($code -ne 0) {
        Write-SyncLog ('WARN remote sync failed for ' + $HostName + ' (exit=' + $code + '; previous fragment kept if any)')
    }
    Write-SyncLogBlock -Header ('--- remote stdout (' + $HostName + ') ---') -Text $outText
    Write-SyncLogBlock -Header ('--- remote stderr (' + $HostName + ') ---') -Text $errText
}

function Resolve-Node {
    param([string]$ExplicitPath, [string]$FixedPath)
    $notes = @()
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
            return [pscustomobject]@{ Path = $ExplicitPath; Source = 'parameter'; Notes = @("using -NodePath $ExplicitPath") }
        }
        $notes += "explicit -NodePath not found: $ExplicitPath"
    }
    if (-not [string]::IsNullOrWhiteSpace($FixedPath) -and (Test-Path -LiteralPath $FixedPath -PathType Leaf)) {
        return [pscustomobject]@{ Path = $FixedPath; Source = 'fixed-dsh-runtime'; Notes = $notes }
    }
    $notes += "fixed node missing: $FixedPath"
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $cmd) {
        $notes += 'falling back to node.exe from PATH'
        return [pscustomobject]@{ Path = $cmd.Source; Source = 'PATH'; Notes = $notes }
    }
    $notes += 'node.exe not found on PATH'
    return [pscustomobject]@{ Path = $null; Source = 'none'; Notes = $notes }
}

function Get-HubPaths {
    param([string]$NodeExe)
    # The data directory is decided by lib/paths.mjs (overridable with
    # DSH_AGENT_CONTEXT_HOME), so ask the CLI instead of duplicating that rule
    # here: a wrong guess would write an index nobody reads.
    $empty = [pscustomobject]@{ dataHome = $null; indexPath = $null; remoteDir = $null; logPath = $null }
    if ([string]::IsNullOrWhiteSpace($NodeExe)) { return $empty }
    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) { return $empty }
    try {
        $json = & $NodeExe $cliPath 'paths' '--json' 2>$null
        if ([string]::IsNullOrWhiteSpace($json)) { return $empty }
        $parsed = $json | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($parsed.indexPath)) { return $empty }
        $logDir = Split-Path -Parent $parsed.indexPath
        return [pscustomobject]@{
            dataHome  = $parsed.dataHome
            indexPath = $parsed.indexPath
            remoteDir = $parsed.remoteDir
            logPath   = Join-Path $logDir 'sync.log'
        }
    }
    catch {
        return $empty
    }
}

# --- Main --------------------------------------------------------------------
try {
    $nodeInfo = Resolve-Node -ExplicitPath $NodePath -FixedPath $FixedNodePath
    foreach ($note in $nodeInfo.Notes) {
        Write-SyncLog ('node resolution: ' + $note)
    }

    $hubPaths = Get-HubPaths -NodeExe $nodeInfo.Path
    if (-not [string]::IsNullOrWhiteSpace($hubPaths.logPath)) {
        $logPath = $hubPaths.logPath
        $logDir = Split-Path -Parent $logPath
        if (-not (Test-Path -LiteralPath $logDir)) {
            New-Item -ItemType Directory -Path $logDir -Force | Out-Null
        }
    }
    if ([string]::IsNullOrWhiteSpace($OutFile)) {
        if (-not [string]::IsNullOrWhiteSpace($hubPaths.indexPath)) { $OutFile = $hubPaths.indexPath }
        else { $OutFile = Join-Path $cacheDir 'index.json' }
    }

    Invoke-LogRotation -Path $logPath -LimitBytes $MaxLogBytes -TailBytes $KeepTailBytes

    Write-SyncLog ('sync start | pkg=' + $pkgRoot + ' | node=' + $nodeInfo.Path + ' | nodeSource=' + $nodeInfo.Source + ' | out=' + $OutFile + ' | log=' + $logPath)

    if (-not $SkipUpstreamCheck) {
        Write-UpstreamCheck -AutomationToml 'D:\Users\80407921\.codex\automations\obsidian\automation.toml' -LibraryRoot 'D:\Users\80407921\.codex\knowledge\agent-handoff'
    }

    if ([string]::IsNullOrWhiteSpace($nodeInfo.Path)) {
        Write-SyncLog 'ERROR node missing: neither the fixed DSH runtime node.exe nor node.exe on PATH is available; nothing was scanned.'
        exit 4
    }

    if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
        Write-SyncLog ('cli missing: ' + $cliPath + ' (lib\cli.mjs not installed yet; index NOT refreshed, this is a safe no-op)')
        exit 2
    }

    $tempOut = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-sync-' + [guid]::NewGuid().ToString('N') + '.out')
    $tempErr = Join-Path ([System.IO.Path]::GetTempPath()) ('codex-sync-' + [guid]::NewGuid().ToString('N') + '.err')
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $exitCode = 1
    $runError = $null

    if (-not $SkipRemote) {
        Invoke-RemoteSync -ScriptPath (Join-Path $scriptDir 'sync-remote.mjs') -NodePath $nodeInfo.Path -WorkingDirectory $pkgRoot -HostName $RemoteHost -TimeoutSeconds $RemoteTimeoutSeconds
    }

    try {
        # Always quote node paths/arguments: Start-Process does not quote array items.
        $argumentList = @('"' + $cliPath + '"', 'scan', '--out', '"' + $OutFile + '"', '--quiet')
        $process = Start-Process -FilePath $nodeInfo.Path -ArgumentList $argumentList -WorkingDirectory $pkgRoot -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $tempOut -RedirectStandardError $tempErr
        $exitCode = $process.ExitCode
    }
    catch {
        $runError = $_.Exception.Message
        $exitCode = 1
    }

    $stopwatch.Stop()

    $stdoutText = ''
    $stderrText = ''
    if (Test-Path -LiteralPath $tempOut) {
        $stdoutText = [System.IO.File]::ReadAllText($tempOut, [System.Text.Encoding]::UTF8)
        Remove-Item -LiteralPath $tempOut -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $tempErr) {
        $stderrText = [System.IO.File]::ReadAllText($tempErr, [System.Text.Encoding]::UTF8)
        Remove-Item -LiteralPath $tempErr -Force -ErrorAction SilentlyContinue
    }

    $elapsed = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
    $meaning = 'unknown'
    switch ($exitCode) {
        0 { $meaning = 'ok' }
        1 { $meaning = 'failure (see stderr)' }
        3 { $meaning = 'no sessions found' }
        default { $meaning = 'cli specific exit code' }
    }

    Write-SyncLog ('sync end | exit=' + $exitCode + ' (' + $meaning + ') | elapsed=' + $elapsed + 's | out=' + $OutFile)
    if (-not [string]::IsNullOrWhiteSpace($runError)) {
        Write-SyncLog ('run error: ' + $runError)
    }

    Write-SyncLogBlock -Header '--- stdout ---' -Text $stdoutText
    Write-SyncLogBlock -Header '--- stderr ---' -Text $stderrText

    if (-not [string]::IsNullOrWhiteSpace($runError)) {
        exit 1
    }

    exit $exitCode
}
catch {
    try {
        Write-SyncLog ('FATAL unhandled error: ' + $_.Exception.Message)
        Write-SyncLog ('FATAL stack: ' + $_.ScriptStackTrace)
    }
    catch {
        # Last resort: never throw from a scheduled task.
    }
    exit 1
}
