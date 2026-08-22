Start-Sleep -Seconds 7
try { Stop-Process -Id 44412 -Force } catch {}
@{ killedPid = 44412; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content 'E:\atlas-station\.atlas\restart-kill-done-gen6.json'
