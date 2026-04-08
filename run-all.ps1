# run-all.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Run-Step($name, $cmd) {
  Write-Host "`n=== $name ===" -ForegroundColor Cyan
  $t0 = Get-Date
  & $cmd
  $dt = (Get-Date) - $t0
  Write-Host "OK: $name ($([int]$dt.TotalSeconds)s)" -ForegroundColor Green
}

# Folder where this script lives
$ROOT = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ROOT

# Optional: ensure node is available
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "node not found in PATH. Install Node.js or fix PATH."
}

# Outputs
$OUT = Join-Path $ROOT "out"
New-Item -ItemType Directory -Force -Path $OUT | Out-Null

# Timestamped run folder (keeps history)
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$RUN   = Join-Path $OUT $STAMP
New-Item -ItemType Directory -Force -Path $RUN | Out-Null

# Common files (latest)
$LATEST_CASES         = Join-Path $ROOT "cases.json"
$LATEST_DETAILS       = Join-Path $ROOT "case_details.json"
$LATEST_TIMESERIES    = Join-Path $ROOT "case_timeseries.json"
$LATEST_CSMONEY_EUR   = Join-Path $ROOT "csmoney_prices_eur.json"
$LATEST_CSFLOAT_EUR   = Join-Path $ROOT "csfloat_prices_eur.json"

# 1) csstonks universe snapshot (cases.json)
Run-Step "scrape-csstonks (cases.json)" {
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scrape-csstonks.ps1"
}

# 2) case details (extinction + deltas)
Run-Step "scrape-case-details (case_details.json)" {
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scrape-case-details.ps1"
}

# 3) timeseries (optional but you listed it)
Run-Step "scrape-case-timeseries (case_timeseries.json)" {
  powershell -NoProfile -ExecutionPolicy Bypass -File ".\scrape-case-timeseries.ps1"
}

# 4) PriceEmpire map (CSMONEY EUR) — interactive (headless 0) + slowmo
Run-Step "scrape-pricempire (csmoney_prices_eur.json)" {
  node ".\scrape-pricempire-map-once-eur.cjs" `
    --out ".\csmoney_prices_eur.json" `
    --headless 0 `
    --slowmo 50
}

# 5) PriceEmpire map (CSFLOAT EUR) — interactive (headless 0) + slowmo
Run-Step "scrape-pricempire (csfloat_prices_eur.json)" {
  node ".\scrape-pricempire-map-once-eur-csfloat.cjs" `
    --out ".\csfloat_prices_eur.json" `
    --headless 0 `
    --slowmo 50
}

# Copy a snapshot of outputs into timestamped folder
$toCopy = @(
  $LATEST_CASES,
  $LATEST_DETAILS,
  $LATEST_TIMESERIES,
  $LATEST_CSMONEY_EUR,
  $LATEST_CSFLOAT_EUR
)

foreach ($f in $toCopy) {
  if (Test-Path $f) {
    Copy-Item -Force $f $RUN
  } else {
    Write-Warning "Missing output (not copied): $f"
  }
}

Write-Host "`nAll done. Outputs:" -ForegroundColor Cyan
Write-Host "  Latest: $ROOT" -ForegroundColor Gray
Write-Host "  Snapshot: $RUN" -ForegroundColor Gray
