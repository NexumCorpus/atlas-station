Start-Sleep -Seconds 12
try { Stop-Process -Id 32468 -Force } catch {}
@{ killedPid = 32468; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json | Set-Content 'E:\atlas-station\.atlas\restart-kill-done-gen5.json'
