param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("ftl", "pz")]
    [string]$Flow
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

$flowName = if ($Flow -eq "ftl") { "FTL" } else { "PZ consolidation" }
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$runRoot = Join-Path $repoRoot "output\playwright\visual-demo-$Flow-$stamp"
New-Item -ItemType Directory -Path $runRoot -Force | Out-Null

if (-not $env:TMS_E2E_CREDENTIALS_JSON -and -not $env:TMS_E2E_CREDENTIALS_FILE) {
    Add-Type -AssemblyName System.Windows.Forms
    $picker = New-Object System.Windows.Forms.OpenFileDialog
    $picker.Title = "Select the TMS test-account Markdown file"
    $picker.Filter = "Markdown files (*.md)|*.md|All files (*.*)|*.*"
    $picker.Multiselect = $false
    if ($picker.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        throw "No credential file was selected."
    }
    $env:TMS_E2E_CREDENTIALS_FILE = $picker.FileName
}

$env:TMS_E2E_VISUAL_DEMO = "1"
$env:TMS_E2E_BROWSER_CHANNEL = "chrome"
$env:TMS_E2E_VIEWPORT_WIDTH = "1920"
$env:TMS_E2E_VIEWPORT_HEIGHT = "1080"
$env:TMS_E2E_ROLE_SWITCH_PAUSE_MS = "900"

$python = (Get-Command python -ErrorAction Stop).Source
$baseArgs = @(
    "--execute",
    "--flow", $Flow,
    "--base-url", "http://127.0.0.1:5189",
    "--output-root", $runRoot,
    "--slow-mo", "110",
    "--timeout-ms", "25000",
    "--navigation-timeout-ms", "45000"
)

function Invoke-UiPhase {
    param(
        [Parameter(Mandatory = $true)][string]$Script,
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$InputName = "",
        [string]$InputPath = ""
    )

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "[$flowName] $Label" -ForegroundColor Cyan
    Write-Host "Chrome will bring the active role to the foreground." -ForegroundColor Yellow
    Write-Host "============================================================" -ForegroundColor Cyan

    $started = Get-Date
    $arguments = @($Script) + $baseArgs
    if ($InputName) {
        $arguments += @($InputName, $InputPath)
    }
    & $python @arguments | Out-Host
    $phaseExitCode = $LASTEXITCODE
    if ($phaseExitCode -ne 0) {
        throw "$Label failed. See the visible blocker and artifacts in $runRoot."
    }

    $summary = Get-ChildItem -LiteralPath $runRoot -Recurse -Filter "summary.json" |
        Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-2) } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if (-not $summary) {
        throw "No summary.json was produced by $Label."
    }
    return $summary.FullName
}

try {
    Write-Host "Starting the $flowName visible full-flow demonstration." -ForegroundColor Green
    Write-Host "Safety: business writes only use visible Chrome controls and native file choosers." -ForegroundColor Green
    Write-Host "No SQL, migration, seed, or direct business HTTP write is executed." -ForegroundColor Green

    $phase1 = Invoke-UiPhase `
        -Script "tests/e2e/tms_full_flow_phase1.py" `
        -Label "Phase 1/4: customer, quote, consignment, approval and assignment"
    $phase2 = Invoke-UiPhase `
        -Script "tests/e2e/tms_full_flow_phase2.py" `
        -Label "Phase 2/4: domestic transport, inbound, packing and loading" `
        -InputName "--phase1-summary" `
        -InputPath $phase1
    $phase3 = Invoke-UiPhase `
        -Script "tests/e2e/tms_full_flow_phase3.py" `
        -Label "Phase 3/4: customs, tracking, overseas inbound and pickup" `
        -InputName "--phase2-summary" `
        -InputPath $phase2
    $phase4 = Invoke-UiPhase `
        -Script "tests/e2e/tms_full_flow_phase4.py" `
        -Label "Phase 4/4: settlement, write-off, review and archive" `
        -InputName "--phase3-summary" `
        -InputPath $phase3

    Write-Host ""
    Write-Host "$flowName full flow completed." -ForegroundColor Green
    Write-Host "Final audit summary: $phase4" -ForegroundColor Green
    Write-Host "Screenshots, traces and handoffs: $runRoot" -ForegroundColor Green
}
catch {
    Write-Host ""
    Write-Host "$flowName demo stopped: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Evidence directory: $runRoot" -ForegroundColor Yellow
    exit 1
}
finally {
    Write-Host ""
    Read-Host "Press Enter to close"
}
