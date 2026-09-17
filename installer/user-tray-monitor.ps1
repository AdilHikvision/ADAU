Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$serviceName = "ProjectXBackend"
$dashboardUrl = "http://localhost:5055/system"

function Get-ServiceStateSafe {
    try {
        return (Get-Service -Name $serviceName -ErrorAction Stop).Status.ToString()
    }
    catch {
        return "NotInstalled"
    }
}

function Invoke-ElevatedServiceAction {
    param([Parameter(Mandatory = $true)][string]$Action)
    Start-Process -FilePath "sc.exe" -Verb RunAs -ArgumentList @($Action, $serviceName)
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.SystemIcons]::Application
$notifyIcon.Visible = $true
$notifyIcon.Text = "ADAU Server: initializing"

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open Service Manager")
$openItem.add_Click({ Start-Process $dashboardUrl | Out-Null })

$startItem = $menu.Items.Add("Start Server")
$startItem.add_Click({ Invoke-ElevatedServiceAction -Action "start" })

$stopItem = $menu.Items.Add("Stop Server")
$stopItem.add_Click({ Invoke-ElevatedServiceAction -Action "stop" })

$restartItem = $menu.Items.Add("Restart Server")
$restartItem.add_Click({
    Invoke-ElevatedServiceAction -Action "stop"
    Start-Sleep -Seconds 1
    Invoke-ElevatedServiceAction -Action "start"
})

$null = $menu.Items.Add("-")
$exitItem = $menu.Items.Add("Exit")
$exitItem.add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

$notifyIcon.ContextMenuStrip = $menu
$notifyIcon.add_MouseClick({
    param($sender, $args)
    if ($args.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
        Start-Process $dashboardUrl | Out-Null
    }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
    $notifyIcon.Text = "ADAU Server: $(Get-ServiceStateSafe)"
})
$timer.Start()
$notifyIcon.Text = "ADAU Server: $(Get-ServiceStateSafe)"
[System.Windows.Forms.Application]::Run()
