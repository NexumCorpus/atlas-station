Start-Sleep -Seconds 75
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'fleethost' } | Select-Object -First 1
if ($p) { Stop-Process -Id $p.ProcessId -Force; "$($p.ProcessId) killed at $(Get-Date -Format o)" | Out-File 'E:\atlas-station\.atlas\gen5-kill-receipt.txt' -Encoding utf8 }
