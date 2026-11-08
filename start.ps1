param(
    [switch]$NoOpen
)

$ErrorActionPreference = 'Stop'
$Port = 4317
$HealthUrl = "http://127.0.0.1:$Port/api/health"
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([char[]]@('\', '/'))
$CliPath = Join-Path $ProjectRoot 'server\cli.mjs'
$UserProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($UserProfilePath)) {
    $UserProfilePath = $env:USERPROFILE
}
$StateDirectory = Join-Path $UserProfilePath '.claudex'
$PidFile = Join-Path $StateDirectory 'launcher.json'
$StdoutLog = Join-Path $StateDirectory 'launcher-stdout.log'
$StderrLog = Join-Path $StateDirectory 'launcher-stderr.log'
$StartedProcess = $null

function Normalize-ProjectPath([string]$PathValue) {
    if ([string]::IsNullOrWhiteSpace($PathValue)) { return '' }
    try {
        return [System.IO.Path]::GetFullPath($PathValue).TrimEnd([char[]]@('\', '/'))
    } catch {
        return ''
    }
}

function Test-SameProjectRoot([string]$CandidateRoot) {
    $candidate = Normalize-ProjectPath $CandidateRoot
    return -not [string]::IsNullOrEmpty($candidate) -and
        [string]::Equals($candidate, $ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-ServiceHealth {
    try {
        $body = Invoke-RestMethod -Uri $HealthUrl -Method Get -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        return [pscustomobject]@{ Responded = $true; Body = $body }
    } catch {
        return [pscustomobject]@{ Responded = $false; Body = $null }
    }
}

function Test-PortOpen {
    $client = New-Object System.Net.Sockets.TcpClient
    $asyncResult = $null
    try {
        $asyncResult = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(500)) { return $false }
        $client.EndConnect($asyncResult)
        return $client.Connected
    } catch {
        return $false
    } finally {
        if ($asyncResult -and $asyncResult.AsyncWaitHandle) {
            $asyncResult.AsyncWaitHandle.Close()
        }
        $client.Close()
    }
}

function Save-ServerPid([int]$ProcessId) {
    if ($ProcessId -le 0) { throw '健康检查没有返回有效的服务 PID。' }
    if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    }
    $record = [ordered]@{
        pid = $ProcessId
        root = $ProjectRoot
    }
    $temporaryFile = "$PidFile.tmp"
    $record | ConvertTo-Json -Compress | Set-Content -LiteralPath $temporaryFile -Encoding UTF8
    Move-Item -LiteralPath $temporaryFile -Destination $PidFile -Force
}

function Get-HealthProcessId($HealthBody) {
    if ($null -eq $HealthBody) { return 0 }
    $parsedPid = 0
    if ([int]::TryParse([string]$HealthBody.pid, [ref]$parsedPid) -and $parsedPid -gt 0) {
        return $parsedPid
    }
    return 0
}

function Get-HealthConflictMessage($HealthResult) {
    $body = $HealthResult.Body
    if ($HealthResult.Responded -and $null -ne $body) {
        $appName = [string]$body.app
        $otherRoot = [string]$body.root
        $otherPid = [string]$body.pid
        if ($appName -eq 'Claudex' -and -not [string]::IsNullOrWhiteSpace($otherRoot)) {
            return "本机端口 $Port 已运行另一份 Claudex（目录：$otherRoot，PID：$otherPid）。本次不会启动或结束该服务。"
        }
        if (-not [string]::IsNullOrWhiteSpace($appName)) {
            return "本机端口 $Port 正被 $appName 占用，本次不会启动或结束该服务。"
        }
        return "本机端口 $Port 已有服务响应，但没有返回有效的 Claudex 健康信息；本次不会结束该服务。"
    }
    return "本机端口 $Port 已被其他服务占用，但它没有返回 Claudex 健康信息；本次不会结束该服务。"
}

function Test-ManagedProcess([int]$ProcessId) {
    try {
        $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
        if ($null -eq $process) { return $false }
        if ([string]$process.ExecutablePath -notmatch '(?i)\\node\.exe$') { return $false }
        if ([string]$process.CommandLine -notlike "*$CliPath*") { return $false }
        if ([string]$process.CommandLine -notmatch '(?i)(^|\s)serve(\s|$)') { return $false }
        if ([string]$process.CommandLine -notmatch '(?i)--port(?:\s+|=)4317(?:\s|$)') { return $false }
        return $true
    } catch {
        return $false
    }
}

function Stop-StartedProcessIfOwned {
    if ($null -eq $StartedProcess) { return }
    $processId = [int]$StartedProcess.Id
    if (Test-ManagedProcess $processId) {
        Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
}

function Get-NodeCandidates {
    $candidates = New-Object 'System.Collections.Generic.List[string]'
    [void]$candidates.Add((Join-Path $ProjectRoot 'runtime\node.exe'))
    $commands = @(Get-Command node -All -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($command in $commands) {
        if (-not [string]::IsNullOrWhiteSpace([string]$command.Source)) {
            [void]$candidates.Add([string]$command.Source)
        }
    }

    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    $portablePaths = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path $programFilesX86 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'nodejs\node.exe'),
        (Join-Path $env:USERPROFILE 'scoop\apps\nodejs\current\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'hermes\node\node.exe')
    )
    foreach ($path in $portablePaths) {
        if (-not [string]::IsNullOrWhiteSpace([string]$path)) {
            [void]$candidates.Add([string]$path)
        }
    }
    return $candidates
}

function Find-Node22 {
    $seen = @{}
    foreach ($candidate in (Get-NodeCandidates)) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or $seen.ContainsKey($candidate)) { continue }
        $seen[$candidate] = $true
        if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
        try {
            $output = @(& $candidate --version 2>$null)
            $exitCode = $LASTEXITCODE
            $versionLine = ($output -join ' ').Trim()
            if ($exitCode -eq 0 -and $versionLine -match '^v?(\d+)\.(\d+)\.(\d+)') {
                if ([int]$Matches[1] -ge 22) { return $candidate }
            }
        } catch {
            continue
        }
    }
    throw '没有找到 Node.js 22 或更高版本。请安装 Node.js 22+，或确认它可从 PATH、常见本机 Node 目录中找到。'
}

function Open-AppWindow {
    if ($NoOpen) { return }
    & (Join-Path $PSScriptRoot 'open-ego.ps1') -Port $Port
}

function Show-StartupError([string]$Message) {
    if ($NoOpen) { [Console]::Error.WriteLine($Message); return }
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show(
            $Message,
            'Claudex 启动失败',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } catch {
        Write-Error $Message
    }
}

try {
    if (-not (Test-Path -LiteralPath $CliPath -PathType Leaf)) {
        throw "没有找到服务入口：$CliPath"
    }

    $health = Get-ServiceHealth
    if ($health.Responded) {
        if ($health.Body.app -eq 'Claudex' -and (Test-SameProjectRoot ([string]$health.Body.root))) {
            $existingPid = Get-HealthProcessId $health.Body
            if ($existingPid -le 0) {
                throw "端口 $Port 的 Claudex 健康信息缺少有效 PID，无法安全保存停止信息。"
            }
            Save-ServerPid $existingPid
            Open-AppWindow
            exit 0
        }
        throw (Get-HealthConflictMessage $health)
    }
    if (Test-PortOpen) {
        throw (Get-HealthConflictMessage $health)
    }

    $nodePath = Find-Node22
    if (-not (Test-Path -LiteralPath $StateDirectory -PathType Container)) {
        New-Item -ItemType Directory -Path $StateDirectory -Force | Out-Null
    }

    $cliArgument = '"' + $CliPath + '"'
    $startParameters = @{
        FilePath = $nodePath
        ArgumentList = @($cliArgument, 'serve', '--port', "$Port")
        WorkingDirectory = $ProjectRoot
        WindowStyle = 'Hidden'
        RedirectStandardOutput = $StdoutLog
        RedirectStandardError = $StderrLog
        PassThru = $true
    }
    $StartedProcess = Start-Process @startParameters
    Save-ServerPid ([int]$StartedProcess.Id)

    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while ([DateTime]::UtcNow -lt $deadline) {
        $health = Get-ServiceHealth
        if ($health.Responded) {
            if ($health.Body.app -eq 'Claudex' -and (Test-SameProjectRoot ([string]$health.Body.root))) {
                $servicePid = Get-HealthProcessId $health.Body
                if ($servicePid -le 0) {
                    throw "端口 $Port 的 Claudex 健康信息缺少有效 PID，无法安全保存停止信息。"
                }
                Save-ServerPid $servicePid
                if ($servicePid -ne [int]$StartedProcess.Id) {
                    Stop-StartedProcessIfOwned
                }
                Open-AppWindow
                exit 0
            }
            throw (Get-HealthConflictMessage $health)
        }
        if (-not (Get-Process -Id $StartedProcess.Id -ErrorAction SilentlyContinue)) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    if (Test-PortOpen) {
        throw (Get-HealthConflictMessage (Get-ServiceHealth))
    }
    throw ("Claudex 未能在 30 秒内启动。" + [Environment]::NewLine + "请检查日志：" + [Environment]::NewLine + $StdoutLog + [Environment]::NewLine + $StderrLog)
} catch {
    Stop-StartedProcessIfOwned
    Show-StartupError $_.Exception.Message
    exit 1
}
