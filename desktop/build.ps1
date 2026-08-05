# Builds dist/RoundTuit.exe — a single portable file with the web app inside it.
# Run from anywhere:   ./desktop/build.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$build = Join-Path $root 'desktop/build'
$dist  = Join-Path $root 'dist'
$exe   = Join-Path $dist 'RoundTuit.exe'

New-Item -ItemType Directory -Force -Path $build, $dist | Out-Null

# $ErrorActionPreference doesn't apply to native executables — they report
# failure through the exit code, which is silently ignored unless checked. An
# earlier version of this script printed "Built ..." after two failed steps.
function Assert-LastExit($what) {
  if ($LASTEXITCODE -ne 0) { throw "$what failed with exit code $LASTEXITCODE" }
}

# A running copy holds a lock on the file and every write below would fail.
$running = Get-Process -Name 'RoundTuit' -ErrorAction SilentlyContinue |
           Where-Object { $_.Path -eq $exe }
if ($running) {
  Write-Host '0/4  Stopping the running copy...' -ForegroundColor DarkGray
  $running | Stop-Process -Force
  Start-Sleep -Milliseconds 700
}

Write-Host '1/4  Bundling app files into a SEA blob...' -ForegroundColor Cyan
node --experimental-sea-config desktop/sea-config.json
Assert-LastExit 'SEA blob'

Write-Host '2/4  Copying the Node runtime...' -ForegroundColor Cyan
Copy-Item -Path (Get-Command node).Source -Destination $exe -Force

# node.exe ships Authenticode-signed, and injection invalidates that signature.
# Stripping it first avoids a corrupt-signature warning. Cosmetic — if signtool
# isn't installed the exe still works, so this one is allowed to fail.
$signtool = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Recurse -Filter 'signtool.exe' -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match 'x64' } | Select-Object -First 1
if ($signtool) {
  & $signtool.FullName remove /s $exe 2>&1 | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host '     stripped the Node signature' -ForegroundColor DarkGray
  } else {
    Write-Warning 'Could not strip the Node signature; continuing.'
  }
}

Write-Host '3/4  Injecting the app into the executable...' -ForegroundColor Cyan
npx --yes postject $exe NODE_SEA_BLOB (Join-Path $build 'sea-prep.blob') `
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
Assert-LastExit 'postject injection'

# After injection, so postject's section rewriting can't undo it.
Write-Host '4/4  Hiding the console window...' -ForegroundColor Cyan
node desktop/set-gui-subsystem.js $exe
Assert-LastExit 'subsystem patch'

$mb = [math]::Round((Get-Item $exe).Length / 1MB, 1)
Write-Host ''
Write-Host "Built $exe  ($mb MB)" -ForegroundColor Green
Write-Host 'Copy that one file to any Windows PC and double-click it.'
