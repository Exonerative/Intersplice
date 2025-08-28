Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Utility: run a command in a working directory and stream output to a textbox
function Start-Proc {
    param(
        [string]$Cmd,
        [string]$Args = "",
        [string]$Cwd = ".",
        [System.Windows.Forms.TextBox]$OutBox
    )
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Cmd
    $psi.Arguments = $Args
    $psi.WorkingDirectory = $Cwd
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError  = $true
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $null = $p.Start()
    $handler = {
        param($sender, $e)
        $OutBox.AppendText($e.Data + [Environment]::NewLine)
    }
    $p.BeginOutputReadLine()
    $p.BeginErrorReadLine()
    $p.add_OutputDataReceived($handler)
    $p.add_ErrorDataReceived($handler)
    return $p
}

# Locate repo root (folder where this script is)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$RepoRoot  = $ScriptDir

# UI and Server folders
$UiDir     = Join-Path $RepoRoot "ui"

# Build the form
$form                 = New-Object System.Windows.Forms.Form
$form.Text            = "Intersplice Launcher"
$form.Size            = New-Object System.Drawing.Size(820, 560)
$form.StartPosition   = "CenterScreen"
$form.BackColor       = [System.Drawing.Color]::FromArgb(12,14,26)

$font = New-Object System.Drawing.Font("Segoe UI", 9)
$form.Font = $font

# Labels/inputs
$lblServer = New-Object System.Windows.Forms.Label
$lblServer.Text = "Server URL:"
$lblServer.ForeColor = "White"
$lblServer.Location = New-Object System.Drawing.Point(16, 16)
$lblServer.AutoSize = $true
$form.Controls.Add($lblServer)

$txtServer = New-Object System.Windows.Forms.TextBox
$txtServer.Text = "http://localhost:3000"
$txtServer.Location = New-Object System.Drawing.Point(100, 12)
$txtServer.Width = 260
$form.Controls.Add($txtServer)

$lblRoom = New-Object System.Windows.Forms.Label
$lblRoom.Text = "Room:"
$lblRoom.ForeColor = "White"
$lblRoom.Location = New-Object System.Drawing.Point(380, 16)
$lblRoom.AutoSize = $true
$form.Controls.Add($lblRoom)

$txtRoom = New-Object System.Windows.Forms.TextBox
$txtRoom.Text = "default"
$txtRoom.Location = New-Object System.Drawing.Point(430, 12)
$txtRoom.Width = 140
$form.Controls.Add($txtRoom)

# Output TextBox
$txtOut = New-Object System.Windows.Forms.TextBox
$txtOut.Multiline = $true
$txtOut.ScrollBars = "Both"
$txtOut.ReadOnly = $true
$txtOut.BackColor = [System.Drawing.Color]::FromArgb(18,20,34)
$txtOut.ForeColor = "Gainsboro"
$txtOut.Location = New-Object System.Drawing.Point(16, 160)
$txtOut.Size = New-Object System.Drawing.Size(780, 340)
$form.Controls.Add($txtOut)

# Buttons
function MakeButton([string]$text, [int]$x, [int]$y) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $text
    $btn.Location = New-Object System.Drawing.Point($x, $y)
    $btn.Size = New-Object System.Drawing.Size(180, 34)
    $btn.BackColor = [System.Drawing.Color]::FromArgb(34,36,58)
    $btn.ForeColor = "White"
    return $btn
}

$btnInstall = MakeButton "Install UI (npm ci / install)" 16 56
$btnBuild   = MakeButton "Build UI (npm run build)"     206 56
$btnStart   = MakeButton "Start Server (npm start)"     396 56
$btnStop    = MakeButton "Stop Server"                  586 56
$btnHost    = MakeButton "Open Host /ui/host"           16 100
$btnJoin    = MakeButton "Open Player /ui/join"         206 100
$btnQuick   = MakeButton "Quick Start: All + Host"      396 100

$form.Controls.AddRange(@($btnInstall, $btnBuild, $btnStart, $btnStop, $btnHost, $btnJoin, $btnQuick))

# State
$global:ServerProc = $null

# Button handlers
$btnInstall.Add_Click({
    $txtOut.AppendText("==> Running npm ci (fallback npm install) in /ui ..." + [Environment]::NewLine)
    $proc = Start-Proc -Cmd "cmd.exe" -Args "/c npm ci || npm install" -Cwd $UiDir -OutBox $txtOut
    $proc.WaitForExit()
    $txtOut.AppendText("==> Install complete (exit $($proc.ExitCode))" + [Environment]::NewLine)
})

$btnBuild.Add_Click({
    $txtOut.AppendText("==> Building UI (npm run build) ..." + [Environment]::NewLine)
    $proc = Start-Proc -Cmd "cmd.exe" -Args "/c npm run build" -Cwd $UiDir -OutBox $txtOut
    $proc.WaitForExit()
    $txtOut.AppendText("==> Build complete (exit $($proc.ExitCode))" + [Environment]::NewLine)
})

$btnStart.Add_Click({
    if ($global:ServerProc -ne $null -and -not $global:ServerProc.HasExited) {
        $txtOut.AppendText("Server already running (PID $($global:ServerProc.Id))." + [Environment]::NewLine)
        return
    }
    $txtOut.AppendText("==> Starting server (npm start) in repo root ..." + [Environment]::NewLine)
    $global:ServerProc = Start-Proc -Cmd "cmd.exe" -Args "/c npm start" -Cwd $RepoRoot -OutBox $txtOut
    Start-Sleep -Milliseconds 600
    if ($global:ServerProc -ne $null) {
        $txtOut.AppendText("==> Server started, PID $($global:ServerProc.Id)" + [Environment]::NewLine)
    }
})

$btnStop.Add_Click({
    if ($global:ServerProc -ne $null -and -not $global:ServerProc.HasExited) {
        $txtOut.AppendText("==> Stopping server PID $($global:ServerProc.Id) ..." + [Environment]::NewLine)
        try { $global:ServerProc.Kill() } catch {}
        Start-Sleep -Milliseconds 300
        $txtOut.AppendText("==> Server stopped." + [Environment]::NewLine)
    } else {
        $txtOut.AppendText("==> No server process to stop." + [Environment]::NewLine)
    }
})

$btnHost.Add_Click({
    $url = ($txtServer.Text.TrimEnd('/')) + "/ui/host"
    Start-Process $url
})

$btnJoin.Add_Click({
    $base = $txtServer.Text.TrimEnd('/')
    $room = [uri]::EscapeDataString($txtRoom.Text)
    $url  = \"$base/ui/join?room=$room\"
    Start-Process $url
})

$btnQuick.Add_Click({
    $btnInstall.PerformClick()
    $btnBuild.PerformClick()
    $btnStart.PerformClick()
    Start-Sleep -Seconds 1
    $btnHost.PerformClick()
})

[void]$form.ShowDialog()