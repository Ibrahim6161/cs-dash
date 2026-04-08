# ==============================
# scrape-case-details.ps1 (FULL)
# Folder : C:\Users\Assassin61\Documents\CSGO
# Input  : .\cases.json   (29 cases; high-quality only)
# Output : .\case_details.json
# Shots  : .\shots\  (chart + fallback fullpage)
#
# Requires:
#   npm i playwright
#   npx playwright install chromium
# ==============================

$ErrorActionPreference = "Stop"

Set-Location "C:\Users\Assassin61\Documents\CSGO"

$casesFile = Join-Path $PWD "cases.json"
$outFile   = Join-Path $PWD "case_details.json"
$shotsDir  = Join-Path $PWD "shots"

if (!(Test-Path $casesFile)) {
  throw "Missing input: $casesFile"
}

if (!(Test-Path $shotsDir)) {
  New-Item -ItemType Directory -Path $shotsDir | Out-Null
}

node .\scrape-case-details.js --cases "$casesFile" --out "$outFile" --shots "$shotsDir" --headless
Write-Host "DONE. Output: $outFile"
Write-Host "Screenshots: $shotsDir"
