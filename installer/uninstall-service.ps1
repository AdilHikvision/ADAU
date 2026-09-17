param(
    [string]$ServiceName = "ProjectXBackend",
    [string]$InstallDir = "$env:ProgramFiles\ProjectX\Backend"
)

$ErrorActionPreference = "Continue"

sc.exe stop $ServiceName | Out-Null
Start-Sleep -Seconds 2
sc.exe delete $ServiceName | Out-Null

# Tray shortcuts: current ADAU name plus the legacy ProjectX name (install over an old version).
$shortcutFolders = @([Environment]::GetFolderPath("Startup"), [Environment]::GetFolderPath("Programs"))
foreach ($folder in $shortcutFolders) {
    foreach ($name in @("ADAU Tray Monitor.lnk", "ProjectX Tray Monitor.lnk")) {
        $shortcut = Join-Path $folder $name
        if (Test-Path $shortcut) {
            Remove-Item $shortcut -Force
        }
    }
}

if (Test-Path $InstallDir) {
    Remove-Item $InstallDir -Recurse -Force
}

Write-Host "Service '$ServiceName' removed."
