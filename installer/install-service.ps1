param(
    [Parameter(Mandatory = $true)]
    [string]$SourceDir,

    [string]$InstallDir = "$env:ProgramFiles\ProjectX\Backend",
    [string]$ServiceName = "ProjectXBackend",
    [string]$ServiceDisplayName = "ADAU Backend Service",
    [string]$ServiceDescription = "ADAU API and local dashboard service",
    # Kestrel binds loopback only — nginx (install-nginx.ps1) fronts it for LAN access.
    [string]$ApiUrls = "http://127.0.0.1:5055",
    [string]$DashboardUrl = "http://127.0.0.1:5055/system",

    [string]$DbHost = "localhost",
    [int]$DbPort = 5432,
    [string]$DbName = "projectx",
    [string]$DbUser = "projectx_user",
    # Optional when -PreserveConfig is set (update keeps the existing appsettings).
    [string]$DbPassword = "",

    [string]$JwtIssuer = "projectx-api",
    [string]$JwtAudience = "projectx-frontend",
    [string]$JwtKey = "",

    [string]$LocalControlKey = "",
    [string]$PostgresServiceName = "postgresql-x64-16",
    [bool]$EnableTrayMonitor = $true,
    # Update mode: reuse the existing appsettings.Production.json instead of
    # regenerating it from DB/JWT parameters.
    [switch]$PreserveConfig,
    [string]$LogPath = "$env:TEMP\ProjectX-install-service.log"
)

$ErrorActionPreference = "Stop"
if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    $logDir = Split-Path -Parent $LogPath
    if (-not [string]::IsNullOrWhiteSpace($logDir) -and -not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    Start-Transcript -Path $LogPath -Append | Out-Null
}

try {

if (-not (Test-Path $SourceDir)) {
    throw "Source directory not found: $SourceDir"
}

# ── Config preservation (update mode) ──────────────────────────────────────────
# On update, back up the existing appsettings.Production.json (it survives the
# InstallDir wipe below) and restore it afterwards so DB/JWT stay unchanged.
$existingConfig = Join-Path $InstallDir "appsettings.Production.json"
$preservedConfigBackup = $null
if ($PreserveConfig -and (Test-Path $existingConfig)) {
    $preservedConfigBackup = Join-Path $env:TEMP "ProjectX-appsettings-preserve.json"
    Copy-Item $existingConfig $preservedConfigBackup -Force
    Write-Host "PreserveConfig: backed up existing appsettings.Production.json."
}

$willGenerateConfig = ($null -eq $preservedConfigBackup)
if ($willGenerateConfig) {
    if ([string]::IsNullOrWhiteSpace($DbPassword)) {
        throw "DbPassword is required (it is optional only with -PreserveConfig when a previous config exists)."
    }
    # The JWT signing key is internal to the backend — generate a strong one when
    # the caller did not supply it (the installer no longer asks the user for it).
    if ([string]::IsNullOrWhiteSpace($JwtKey)) {
        $jwtBytes = New-Object 'byte[]' 48
        [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($jwtBytes)
        $JwtKey = [Convert]::ToBase64String($jwtBytes)
        Write-Host "Generated a random JWT signing key."
    }
}

$appSettingsProduction = @{
    ConnectionStrings = @{
        DefaultConnection = "Host=$DbHost;Port=$DbPort;Database=$DbName"
    }
    Database = @{
        Username = $DbUser
        Password = $DbPassword
    }
    Jwt = @{
        Issuer = $JwtIssuer
        Audience = $JwtAudience
        Key = $JwtKey
        ExpirationMinutes = 60
    }
    SystemMonitor = @{
        ServiceName = $ServiceName
        LocalControlKey = $LocalControlKey
        ManagedServices = @(
            @{
                Key = "backend"
                ServiceName = $ServiceName
                DisplayName = $ServiceDisplayName
                Port = "5055"
                IsControllable = $true
            },
            @{
                Key = "postgres"
                ServiceName = $PostgresServiceName
                DisplayName = "PostgreSQL"
                Port = "$DbPort"
                IsControllable = $true
            },
            @{
                Key = "nginx"
                ServiceName = "ProjectXNginx"
                DisplayName = "Nginx (LAN proxy)"
                Port = "80"
                IsControllable = $true
            }
        )
    }
}

$exePath = Join-Path $InstallDir "backend.exe"

# ── Step 1: Kill tray monitor first (it holds a handle on $InstallDir as WorkingDirectory)
$trayProcs = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*ProjectXTrayMonitor*' }
foreach ($p in $trayProcs) {
    Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction SilentlyContinue
    Write-Host "Stopped tray monitor PID $($p.ProcessId)."
}
if ($trayProcs) { Start-Sleep -Seconds 2 }

# ── Step 2: Stop and delete the Windows service
$existing = sc.exe query $ServiceName 2>$null
if ($LASTEXITCODE -eq 0) {
    sc.exe stop $ServiceName 2>$null | Out-Null
    # Wait up to 30 seconds for the service to fully stop
    $stopWait = 0
    while ($stopWait -lt 30) {
        Start-Sleep -Seconds 1
        $stopWait++
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -eq 'Stopped') { break }
    }
    sc.exe delete $ServiceName 2>$null | Out-Null
    Start-Sleep -Seconds 2
}

# ── Step 3: Kill any remaining backend.exe processes
$runningBackendProcesses = Get-Process -Name "backend" -ErrorAction SilentlyContinue
if ($runningBackendProcesses) {
    $runningBackendProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

if (Test-Path $InstallDir) {
    # Retry up to 5 times in case files are still briefly locked after service stop
    $removeRetry = 0
    while ($true) {
        try {
            Remove-Item $InstallDir -Recurse -Force -ErrorAction Stop
            break
        }
        catch {
            $removeRetry++
            if ($removeRetry -ge 5) { throw }
            Write-Host "InstallDir still locked, retrying in 3s... ($removeRetry/5)"
            Start-Sleep -Seconds 3
        }
    }
}
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item (Join-Path $SourceDir "*") $InstallDir -Recurse -Force

# A dev .env would override Production config at runtime — never keep it in the install.
$strayEnv = Join-Path $InstallDir ".env"
if (Test-Path $strayEnv) {
    Remove-Item $strayEnv -Force
    Write-Host "Removed stray .env from install directory."
}

if ($willGenerateConfig) {
    $json = $appSettingsProduction | ConvertTo-Json -Depth 8
    Set-Content -Path (Join-Path $InstallDir "appsettings.Production.json") -Value $json -Encoding UTF8
    Write-Host "Generated appsettings.Production.json."
}
else {
    Copy-Item $preservedConfigBackup (Join-Path $InstallDir "appsettings.Production.json") -Force
    Write-Host "PreserveConfig: restored existing appsettings.Production.json (DB/JWT unchanged)."
}

if (-not (Test-Path $exePath)) {
    throw "backend.exe not found in install dir: $exePath"
}

function Resolve-PostgresServiceName {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PreferredServiceName
    )

    $preferred = Get-Service -Name $PreferredServiceName -ErrorAction SilentlyContinue
    if ($preferred) {
        return $PreferredServiceName
    }

    $fallback = Get-Service | Where-Object {
        $_.Name -like "postgres*" -or $_.DisplayName -like "PostgreSQL*"
    } | Select-Object -First 1

    if ($fallback) {
        return $fallback.Name
    }

    return $null
}

$resolvedPostgresServiceName = Resolve-PostgresServiceName -PreferredServiceName $PostgresServiceName
if (-not [string]::IsNullOrWhiteSpace($resolvedPostgresServiceName)) {
    $pgService = Get-Service -Name $resolvedPostgresServiceName -ErrorAction SilentlyContinue
    if ($pgService -and $pgService.Status -ne 'Running') {
        Write-Host "Starting PostgreSQL service '$resolvedPostgresServiceName'..."
        Start-Service -Name $resolvedPostgresServiceName -ErrorAction Continue
        Start-Sleep -Seconds 2
    }
}
else {
    Write-Warning "PostgreSQL service not found. Backend service may fail until PostgreSQL is installed and running."
}

function Test-TcpPortOpen {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostName,
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutMs = 2000
    )

    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $asyncResult = $tcp.BeginConnect($HostName, $Port, $null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }

        $tcp.EndConnect($asyncResult)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $tcp.Dispose()
    }
}

if (-not (Test-TcpPortOpen -HostName $DbHost -Port $DbPort)) {
    throw "Database endpoint '${DbHost}:${DbPort}' is unreachable. Install/start PostgreSQL and verify credentials before installing ADAU service."
}

$serviceBinaryPath = "`"$exePath`" --urls `"$ApiUrls`""
New-Service -Name $ServiceName -BinaryPathName $serviceBinaryPath -DisplayName $ServiceDisplayName -Description $ServiceDescription -StartupType Automatic
try {
    Start-Service -Name $ServiceName -ErrorAction Stop
}
catch {
    $recentRuntimeError = Get-WinEvent -FilterHashtable @{
        LogName = 'Application'
        ProviderName = '.NET Runtime'
        StartTime = (Get-Date).AddMinutes(-5)
    } -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'Application: backend.exe' } | Select-Object -First 1

    if ($recentRuntimeError) {
        throw "Service '$ServiceName' failed to start. .NET Runtime: $($recentRuntimeError.Message)"
    }

    throw
}

$backendService = Get-Service -Name $ServiceName -ErrorAction Stop
if ($backendService.Status -ne 'Running') {
    throw "Service '$ServiceName' is not running after start attempt."
}

if ($EnableTrayMonitor) {
    $trayScriptPath = Join-Path $InstallDir "ProjectXTrayMonitor.ps1"
    $trayScriptContent = @"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

`$serviceName = "$ServiceName"
`$dashboardUrl = "$DashboardUrl"

function Get-ServiceStateSafe {
    try {
        `$service = Get-Service -Name `$serviceName -ErrorAction Stop
        return `$service.Status.ToString()
    }
    catch {
        return "NotInstalled"
    }
}

function Invoke-ElevatedServiceAction {
    param(
        [Parameter(Mandatory = `$true)]
        [string]`$Action
    )

    try {
        Start-Process -FilePath "sc.exe" -Verb RunAs -ArgumentList @("`$Action", "`$serviceName")
    }
    catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Failed to run service action `${Action}: `$(`$_.Exception.Message)",
            "ADAU Tray",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    }
}

`$iconPath = "$InstallDir\wwwroot\favicon.ico"
`$exePath  = "$InstallDir\backend.exe"
`$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
try {
    if (Test-Path `$iconPath) { `$notifyIcon.Icon = New-Object System.Drawing.Icon(`$iconPath) }
    else { `$notifyIcon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(`$exePath) }
}
catch {
    try { `$notifyIcon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon(`$exePath) }
    catch { `$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application }
}
`$notifyIcon.Visible = `$true
`$notifyIcon.Text = "ADAU Server: initializing"

`$contextMenu = New-Object System.Windows.Forms.ContextMenuStrip
`$openItem = `$contextMenu.Items.Add("Open ADAU")
`$openItem.add_Click({
    Start-Process `$dashboardUrl | Out-Null
})

`$startItem = `$contextMenu.Items.Add("Start Server")
`$startItem.add_Click({
    Invoke-ElevatedServiceAction -Action "start"
})

`$stopItem = `$contextMenu.Items.Add("Stop Server")
`$stopItem.add_Click({
    Invoke-ElevatedServiceAction -Action "stop"
})

`$restartItem = `$contextMenu.Items.Add("Restart Server")
`$restartItem.add_Click({
    Invoke-ElevatedServiceAction -Action "stop"
    Start-Sleep -Seconds 1
    Invoke-ElevatedServiceAction -Action "start"
})

`$null = `$contextMenu.Items.Add("-")

`$exitItem = `$contextMenu.Items.Add("Stop server and exit")
`$exitItem.add_Click({
    `$confirm = [System.Windows.Forms.MessageBox]::Show(
        "Stop the ADAU server and exit?",
        "ADAU",
        [System.Windows.Forms.MessageBoxButtons]::YesNo,
        [System.Windows.Forms.MessageBoxIcon]::Question)
    if (`$confirm -eq [System.Windows.Forms.DialogResult]::Yes) {
        try {
            Start-Process -FilePath "sc.exe" -Verb RunAs -ArgumentList @("stop", "`$serviceName") -Wait
        }
        catch {
            [System.Windows.Forms.MessageBox]::Show(
                "Failed to stop the server: `$(`$_.Exception.Message)",
                "ADAU Tray",
                [System.Windows.Forms.MessageBoxButtons]::OK,
                [System.Windows.Forms.MessageBoxIcon]::Error) | Out-Null
        }
        `$notifyIcon.Visible = `$false
        [System.Windows.Forms.Application]::Exit()
    }
})

`$hideItem = `$contextMenu.Items.Add("Hide tray (keep server running)")
`$hideItem.add_Click({
    `$notifyIcon.Visible = `$false
    [System.Windows.Forms.Application]::Exit()
})

`$notifyIcon.ContextMenuStrip = `$contextMenu
`$notifyIcon.add_MouseClick({
    param(`$sender, `$args)
    if (`$args.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process `$dashboardUrl | Out-Null
    }
})

`$timer = New-Object System.Windows.Forms.Timer
`$timer.Interval = 4000
`$timer.add_Tick({
    `$state = Get-ServiceStateSafe
    `$notifyIcon.Text = "ADAU Server: `$state"
})
`$timer.Start()

`$notifyIcon.Text = "ADAU Server: `$(Get-ServiceStateSafe)"
[System.Windows.Forms.Application]::Run()
"@

    Set-Content -Path $trayScriptPath -Value $trayScriptContent -Encoding UTF8

    $shortcutTarget = "powershell.exe"
    $shortcutArguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$trayScriptPath`""

    $wsh = New-Object -ComObject WScript.Shell
    $startupFolder = [Environment]::GetFolderPath("Startup")
    $programsFolder = [Environment]::GetFolderPath("Programs")

    # Remove shortcuts under the legacy ProjectX name (install over an old version) so the tray does not start twice.
    foreach ($legacy in @((Join-Path $startupFolder "ProjectX Tray Monitor.lnk"), (Join-Path $programsFolder "ProjectX Tray Monitor.lnk"))) {
        if (Test-Path $legacy) { Remove-Item $legacy -Force -ErrorAction SilentlyContinue }
    }

    $startupShortcut = $wsh.CreateShortcut((Join-Path $startupFolder "ADAU Tray Monitor.lnk"))
    $startupShortcut.TargetPath = $shortcutTarget
    $startupShortcut.Arguments = $shortcutArguments
    $startupShortcut.WorkingDirectory = $InstallDir
    $startupShortcut.Save()

    $menuShortcut = $wsh.CreateShortcut((Join-Path $programsFolder "ADAU Tray Monitor.lnk"))
    $menuShortcut.TargetPath = $shortcutTarget
    $menuShortcut.Arguments = $shortcutArguments
    $menuShortcut.WorkingDirectory = $InstallDir
    $menuShortcut.Save()

    # Launch the tray now, de-elevated via explorer.exe — a NotifyIcon created by an
    # elevated process is frequently not shown by the shell. The Startup shortcut
    # relaunches it (non-elevated) on every login.
    Start-Process "explorer.exe" -ArgumentList ('"' + (Join-Path $programsFolder "ADAU Tray Monitor.lnk") + '"')
}

Write-Host "Service '$ServiceName' installed and started."
Write-Host "Dashboard URL: $ApiUrls"
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
        Stop-Transcript | Out-Null
    }
}
