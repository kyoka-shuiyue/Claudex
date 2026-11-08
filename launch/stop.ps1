$ErrorActionPreference = 'Stop'
$Port = 4317
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd([char[]]@('\', '/'))
$CliPath = Join-Path $ProjectRoot 'server\cli.mjs'
$UserProfilePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
if ([string]::IsNullOrWhiteSpace($UserProfilePath)) {
    $UserProfilePath = $env:USERPROFILE
}
$StateDirectory = Join-Path $UserProfilePath '.claudex'
$PidFile = Join-Path $StateDirectory 'launcher.json'

try {
    if (-not (Test-Path -LiteralPath $PidFile -PathType Leaf)) {
        Write-Output '没有找到 Claudex 启动 PID 记录；没有结束任何进程。'
        exit 0
    }

    $record = Get-Content -LiteralPath $PidFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $ProcessId = 0
    if (-not [int]::TryParse([string]$record.pid, [ref]$ProcessId) -or $ProcessId -le 0) {
        throw '启动 PID 记录格式不正确；没有结束任何进程。'
    }
    $recordRoot = ''
    try {
        $recordRoot = [System.IO.Path]::GetFullPath([string]$record.root).TrimEnd([char[]]@('\', '/'))
    } catch {
        throw '启动 PID 记录缺少有效项目目录；没有结束任何进程。'
    }
    if (-not [string]::Equals($recordRoot, $ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "PID 记录属于另一个项目目录（$recordRoot）；没有结束任何进程。"
    }

    $process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if ($null -eq $process) {
        Remove-Item -LiteralPath $PidFile -Force
        Write-Output 'Claudex 服务进程已退出，已清理过期 PID 记录。'
        exit 0
    }

    $commandLine = [string]$process.CommandLine
    $isNode = [string]$process.ExecutablePath -match '(?i)\\node\.exe$'
    $hasThisCli = $commandLine.IndexOf($CliPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    $isServe = $commandLine -match '(?i)(^|\s)serve(\s|$)'
    $hasPort = $commandLine -match '(?i)--port(?:\s+|=)4317(?:\s|$)'
    if (-not ($isNode -and $hasThisCli -and $isServe -and $hasPort)) {
        throw "PID $ProcessId 当前不对应本项目的 server/cli.mjs serve --port $Port；没有结束任何进程。"
    }

    Stop-Process -Id $ProcessId -Force -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        Start-Sleep -Milliseconds 200
        $stillRunning = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    } while ($stillRunning -and [DateTime]::UtcNow -lt $deadline)
    if ($stillRunning) {
        throw "已请求停止 Claudex PID $ProcessId，但进程仍在运行；PID 记录已保留。"
    }

    Remove-Item -LiteralPath $PidFile -Force
    Write-Output "已停止 Claudex 服务（PID $ProcessId）。"
} catch {
    Write-Error $_.Exception.Message
    exit 1
}
