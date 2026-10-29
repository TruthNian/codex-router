$ErrorActionPreference = "Stop"
$Command = if ($args.Count) { [string]$args[0] } else { "status" }
$Action = if ($args.Count -gt 1) { [string]$args[1] } else { "install" }
# Status stays read-only. Every mutation reaches the private dispatcher only
# after the one kernel owner has acquired the complete update transaction.
if ($Command -in @("tray", "companion") -and $Action -ne "status") {
  & node (Join-Path $PSScriptRoot "src/tray-update-owner.mjs") windows @args
  exit $LASTEXITCODE
}
& (Join-Path $PSScriptRoot "src/router-commands-windows.ps1") @args
exit $LASTEXITCODE
