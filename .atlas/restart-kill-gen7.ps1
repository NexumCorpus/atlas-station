Start-Sleep -Seconds 8
try { Stop-Process -Id 33128 -Force } catch {}
@{ killedPid = 33128; at = (Get-Date).ToUniversalTime().ToString('o'); armedFor = 'gen-7 vision activation d005c8b' } | ConvertTo-Json | Set-Content 'E:\atlas-station\.atlas\restart-kill-done-gen7.json'
