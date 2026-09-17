<#
.SYNOPSIS
    Installs nginx as a Windows service that reverse-proxies the ProjectX backend
    to the LAN.

.DESCRIPTION
    - Downloads nginx (Windows) and nssm (service wrapper) if not already present.
    - Renders the bundled projectx-nginx.conf template (substituting the listen and
      backend ports) into <InstallRoot>\conf\nginx.conf.
    - Validates the config (nginx -t), registers the service via nssm, opens the
      Windows Firewall for the listen port, and starts the service.

    nginx listens on every interface so the app is reachable by the server's LAN
    IP (e.g. http://192.0.0.200). The backend (Kestrel) must be bound to loopback
    (127.0.0.1) — see install-service.ps1 (-ApiUrls http://127.0.0.1:5055).

.NOTES
    Run elevated (admin). Requires internet access for the first install.
#>
param(
    [int]$BackendPort = 5055,
    [int]$ListenPort = 80,
    # Install under ProgramData (no spaces): nssm mangles AppParameters containing
    # quoted spaced paths, so a space-free prefix avoids the whole quoting problem.
    [string]$InstallRoot = "$env:ProgramData\ProjectX\nginx",
    [string]$ServiceName = "ProjectXNginx",
    [string]$ServiceDisplayName = "ADAU Nginx (LAN reverse proxy)",
    [string]$NginxVersion = "1.27.4",
    [string]$NssmVersion = "2.24",
    [string]$ConfTemplate = (Join-Path $PSScriptRoot "nginx\projectx-nginx.conf"),
    [bool]$OpenFirewall = $true,
    [string]$LogPath = "$env:TEMP\ProjectX-install-nginx.log"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not [string]::IsNullOrWhiteSpace($LogPath)) {
    $logDir = Split-Path -Parent $LogPath
    if ($logDir -and -not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Start-Transcript -Path $LogPath -Append | Out-Null
}

function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Download a file trying each URL in order (the nssm.cc server in particular is
# frequently down / returns 503 — fall back to the Wayback Machine mirror).
function Get-FileWithFallback {
    param([string[]]$Urls, [string]$OutFile, [int]$MinBytes = 1)
    foreach ($u in $Urls) {
        try {
            Write-Host "  downloading: $u"
            Invoke-WebRequest -Uri $u -OutFile $OutFile -UseBasicParsing -TimeoutSec 120
            if ((Test-Path $OutFile) -and (Get-Item $OutFile).Length -ge $MinBytes) { return $true }
        }
        catch { Write-Warning "  download failed ($u): $($_.Exception.Message)" }
    }
    return $false
}

try {
    if (-not (Test-Admin)) {
        throw "This script must be run as Administrator (it registers a service and opens the firewall)."
    }
    if (-not (Test-Path $ConfTemplate)) {
        throw "nginx config template not found: $ConfTemplate"
    }

    $nginxDir = Join-Path $InstallRoot "nginx-$NginxVersion"
    $nginxExe = Join-Path $nginxDir "nginx.exe"
    $nssmExe = Join-Path $InstallRoot "nssm.exe"
    New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null

    # ── 1) nginx ──────────────────────────────────────────────────────────────
    if (-not (Test-Path $nginxExe)) {
        $nginxZip = Join-Path $env:TEMP "nginx-$NginxVersion.zip"
        $nginxUrls = @(
            "https://nginx.org/download/nginx-$NginxVersion.zip",
            "https://web.archive.org/web/2id_/https://nginx.org/download/nginx-$NginxVersion.zip"
        )
        Write-Host "Downloading nginx $NginxVersion ..."
        if (-not (Get-FileWithFallback -Urls $nginxUrls -OutFile $nginxZip -MinBytes 500000)) {
            throw "Failed to download nginx $NginxVersion from all sources."
        }
        Write-Host "Extracting nginx ..."
        Expand-Archive -Path $nginxZip -DestinationPath $InstallRoot -Force
        Remove-Item $nginxZip -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host "nginx already present at $nginxDir"
    }
    if (-not (Test-Path $nginxExe)) { throw "nginx.exe not found after extraction: $nginxExe" }

    # ── 2) nssm (service wrapper) ───────────────────────────────────────────────
    if (-not (Test-Path $nssmExe)) {
        $nssmZip = Join-Path $env:TEMP "nssm-$NssmVersion.zip"
        $nssmUrls = @(
            "https://nssm.cc/release/nssm-$NssmVersion.zip",
            "https://web.archive.org/web/2id_/https://nssm.cc/release/nssm-$NssmVersion.zip"
        )
        Write-Host "Downloading nssm $NssmVersion ..."
        if (-not (Get-FileWithFallback -Urls $nssmUrls -OutFile $nssmZip -MinBytes 100000)) {
            throw "Failed to download nssm $NssmVersion from all sources."
        }
        $nssmTmp = Join-Path $env:TEMP "nssm-$NssmVersion-extract"
        if (Test-Path $nssmTmp) { Remove-Item $nssmTmp -Recurse -Force }
        Expand-Archive -Path $nssmZip -DestinationPath $nssmTmp -Force
        $arch = if ([Environment]::Is64BitOperatingSystem) { "win64" } else { "win32" }
        $nssmSrc = Get-ChildItem -Path $nssmTmp -Recurse -Filter "nssm.exe" |
            Where-Object { $_.FullName -match "\\$arch\\" } | Select-Object -First 1
        if (-not $nssmSrc) { throw "nssm.exe ($arch) not found in downloaded archive." }
        Copy-Item $nssmSrc.FullName $nssmExe -Force
        Remove-Item $nssmZip -Force -ErrorAction SilentlyContinue
        Remove-Item $nssmTmp -Recurse -Force -ErrorAction SilentlyContinue
    }
    else {
        Write-Host "nssm already present at $nssmExe"
    }

    # ── 3) render config ────────────────────────────────────────────────────────
    Write-Host "Rendering nginx.conf (listen=$ListenPort, backend=127.0.0.1:$BackendPort) ..."
    $conf = Get-Content $ConfTemplate -Raw
    $conf = $conf.Replace('__LISTEN_PORT__', "$ListenPort").Replace('__BACKEND_PORT__', "$BackendPort")
    $confDir = Join-Path $nginxDir "conf"
    Set-Content -Path (Join-Path $confDir "nginx.conf") -Value $conf -Encoding ascii
    # nginx needs a logs/temp dir; created on first run, but ensure it exists.
    New-Item -ItemType Directory -Path (Join-Path $nginxDir "logs") -Force | Out-Null
    New-Item -ItemType Directory -Path (Join-Path $nginxDir "temp")  -Force | Out-Null

    # ── 4) validate config ──────────────────────────────────────────────────────
    # Use forward slashes with a trailing '/' for the prefix. A trailing backslash
    # before the closing quote (e.g. "...nginx-1.27.4\") is parsed by the Windows
    # command-line as an escaped quote, which merges the path with the next argument
    # and breaks nginx. nginx accepts forward slashes on Windows.
    $prefix = ($nginxDir -replace '\\', '/') + '/'
    Write-Host "Validating nginx config ..."
    # nginx and nssm write even their success messages to stderr; under
    # EAP=Stop PowerShell 5.1 turns each stderr line into a terminating error.
    # Relax it for the native-exe steps below and rely on exit codes / the final
    # service-status check instead (explicit `throw`s still abort as intended).
    $ErrorActionPreference = 'Continue'
    $test = & $nginxExe -p $prefix -t 2>&1
    Write-Host ($test | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "nginx config test failed." }

    # ── 5) (re)register service ─────────────────────────────────────────────────
    $existing = & $nssmExe status $ServiceName 2>$null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "Removing existing service $ServiceName ..."
        & $nssmExe stop $ServiceName 2>$null | Out-Null
        Start-Sleep -Seconds 1
        & $nssmExe remove $ServiceName confirm 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }
    Write-Host "Registering service $ServiceName ..."
    & $nssmExe install $ServiceName $nginxExe | Out-Null
    & $nssmExe set $ServiceName AppDirectory $nginxDir | Out-Null
    # $prefix is a space-free forward-slash path (see InstallRoot), so no quoting is
    # needed — nssm would otherwise drop quotes and nginx would split on a space.
    & $nssmExe set $ServiceName AppParameters "-p $prefix" | Out-Null
    & $nssmExe set $ServiceName DisplayName $ServiceDisplayName | Out-Null
    & $nssmExe set $ServiceName Description "ADAU LAN reverse proxy (nginx) -> 127.0.0.1:$BackendPort" | Out-Null
    & $nssmExe set $ServiceName Start SERVICE_AUTO_START | Out-Null
    # Stop nginx gracefully, then let nssm terminate any stragglers.
    & $nssmExe set $ServiceName AppStopMethodConsole 5000 | Out-Null

    # ── 6) firewall ──────────────────────────────────────────────────────────────
    if ($OpenFirewall) {
        $ruleName = "ProjectX nginx ($ListenPort)"
        Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow `
            -Protocol TCP -LocalPort $ListenPort -Profile Any | Out-Null
        Write-Host "Firewall opened for TCP $ListenPort."
    }

    # ── 7) start ──────────────────────────────────────────────────────────────────
    Write-Host "Starting service $ServiceName ..."
    & $nssmExe start $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    $svc = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($svc.Status -ne 'Running') { throw "Service '$ServiceName' is not running after start." }

    Write-Host ""
    Write-Host "nginx installed and running."
    Write-Host "  Listening on : http://0.0.0.0:$ListenPort  (LAN: http://<server-ip>:$ListenPort)"
    Write-Host "  Proxying to  : http://127.0.0.1:$BackendPort"
    Write-Host "  Service      : $ServiceName"
}
finally {
    if (-not [string]::IsNullOrWhiteSpace($LogPath)) { Stop-Transcript | Out-Null }
}
