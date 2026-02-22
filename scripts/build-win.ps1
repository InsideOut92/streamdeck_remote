$ErrorActionPreference = "Stop"

$createdConfig = $false
if (-not (Test-Path -LiteralPath "config.json")) {
  Copy-Item -LiteralPath "config.example.json" -Destination "config.json"
  $createdConfig = $true
}

try {
  node ./node_modules/@yao-pkg/pkg/lib-es5/bin.js . --targets node18-win-x64 --output dist/streamdeck_remote.exe
}
finally {
  if ($createdConfig -and (Test-Path -LiteralPath "config.json")) {
    Remove-Item -LiteralPath "config.json" -Force
  }
}
