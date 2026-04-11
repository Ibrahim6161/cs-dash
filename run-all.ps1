# run-all.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-PowerShellExe {
  if (Get-Command pwsh -ErrorAction SilentlyContinue) {
    return "pwsh"
  }
  if (Get-Command powershell -ErrorAction SilentlyContinue) {
    return "powershell"
  }
  throw "Neither 'pwsh' nor 'powershell' was found in PATH."
}

function Assert-Exists($path, $label) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw ("Missing {0}: {1}" -f $label, $path)
  }
}

function Run-Step($name, [scriptblock]$cmd) {
  Write-Host ""
  Write-Host "=== $name ===" -ForegroundColor Cyan
  $t0 = Get-Date
  try {
    & $cmd
    $dt = (Get-Date) - $t0
    Write-Host "OK: $name ($([int]$dt.TotalSeconds)s)" -ForegroundColor Green
  }
  catch {
    $dt = (Get-Date) - $t0
    Write-Host "FAILED: $name ($([int]$dt.TotalSeconds)s)" -ForegroundColor Red
    throw
  }
}

# Folder where this script lives
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH. Install Node.js or fix PATH."
}

$PSExe = Get-PowerShellExe

# Outputs
$OUT = Join-Path $ROOT "out"
New-Item -ItemType Directory -Force -Path $OUT | Out-Null

# Timestamped run folder
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$RUN   = Join-Path $OUT $STAMP
New-Item -ItemType Directory -Force -Path $RUN | Out-Null

# Script files
$SCRIPT_CSSTONKS        = Join-Path $ROOT "scrapers\csstonks\scrape-csstonks.js"
$SCRIPT_CASE_DETAILS    = Join-Path $ROOT "scrapers\csstonks\scrape-case-details.js"
$SCRIPT_CASE_TIMESERIES = Join-Path $ROOT "scrapers\csstonks\scrape-case-timeseries.js"
$SCRIPT_SKINBARON       = Join-Path $ROOT "scrapers\marketplaces\scrape-skinbaron-containers-eur.cjs"
$SCRIPT_STEAM           = Join-Path $ROOT "scrapers\steam\scrape-steam-market-data.cjs"

# Latest outputs
$LATEST_CASES       = Join-Path $ROOT "cases.json"
$LATEST_DETAILS     = Join-Path $ROOT "case_details.json"
$LATEST_TIMESERIES  = Join-Path $ROOT "case-timeseries.json"
$LATEST_MARKETS_EUR = Join-Path $ROOT "pricempire_prices_eur.json"
$LATEST_STEAM       = Join-Path $ROOT "steam_market_data.json"

if (Test-Path -LiteralPath $SCRIPT_CSSTONKS) {
  Run-Step "scrape-csstonks (cases.json)" {
    & node $SCRIPT_CSSTONKS $LATEST_CASES
  }
} else {
  Write-Warning "Skipping CSStonks universe: missing $SCRIPT_CSSTONKS"
}

if (Test-Path -LiteralPath $SCRIPT_CASE_DETAILS) {
  Run-Step "scrape-case-details (case_details.json)" {
    & node $SCRIPT_CASE_DETAILS `
      --cases $LATEST_CASES `
      --out $LATEST_DETAILS `
      --shots (Join-Path $ROOT "shots") `
      --headless
  }
} else {
  Write-Warning "Skipping case details: missing $SCRIPT_CASE_DETAILS"
}

if (Test-Path -LiteralPath $SCRIPT_CASE_TIMESERIES) {
  Run-Step "scrape-case-timeseries (case-timeseries.json)" {
    & node $SCRIPT_CASE_TIMESERIES
  }
} else {
  Write-Warning "Skipping case timeseries: missing $SCRIPT_CASE_TIMESERIES"
}

Assert-Exists $SCRIPT_SKINBARON "script"
Run-Step "scrape-skinbaron (pricempire_prices_eur.json)" {
  & node $SCRIPT_SKINBARON `
    --out $LATEST_MARKETS_EUR `
    --headless 0 `
    --slowmo 50 `
    --limit 500 `
    --max-pages 12
}

if (Test-Path -LiteralPath $SCRIPT_STEAM) {
  Run-Step "scrape-steam (steam_market_data.json)" {
    & node $SCRIPT_STEAM `
      --out $LATEST_STEAM `
      --source $LATEST_MARKETS_EUR `
      --cases $LATEST_CASES `
      --limit 500 `
      --concurrency 2
  }
} else {
  Write-Warning "Skipping Steam scrape: missing $SCRIPT_STEAM"
}

# Copy outputs into timestamped snapshot folder
$toCopy = @(
  $LATEST_CASES,
  $LATEST_DETAILS,
  $LATEST_TIMESERIES,
  $LATEST_MARKETS_EUR,
  $LATEST_STEAM
)

foreach ($f in $toCopy) {
  if (Test-Path -LiteralPath $f) {
    Copy-Item -LiteralPath $f -Destination $RUN -Force
  }
  else {
    Write-Warning "Missing output (not copied): $f"
  }
}

Write-Host ""
Write-Host "All done. Outputs:" -ForegroundColor Cyan
Write-Host "  Latest:   $ROOT" -ForegroundColor Gray
Write-Host "  Snapshot: $RUN" -ForegroundColor Gray
