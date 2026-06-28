' ATLAS // station launcher — opens the persistent fleet station with no console
' window. Double-click the desktop shortcut that points here, any time, to
' continue. The agents load ~/.claude, so the station wakes into the standing
' frame and the memory journal — it resumes us, not a blank slate.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\atlas-station"
Dim electron
electron = "E:\atlas-station\node_modules\electron\dist\electron.exe"
Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
If fso.FileExists(electron) Then
  sh.Run """" & electron & """ .", 0, False
Else
  sh.Run "cmd /c npm start", 0, False
End If
