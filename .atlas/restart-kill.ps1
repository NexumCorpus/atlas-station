$marker = Get-Content 'E:\atlas-station\.atlas\restart-marker.json' -Raw | ConvertFrom-Json
Start-Sleep -Seconds 75
Stop-Process -Id $marker.targetPid -Force -ErrorAction SilentlyContinue
@{ killedPid = $marker.targetPid; at = (Get-Date).ToUniversalTime().ToString('o') } |
  ConvertTo-Json | Set-Content 'E:\atlas-station\.atlas\restart-kill-done.json'