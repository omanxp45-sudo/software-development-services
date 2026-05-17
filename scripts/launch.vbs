Set fso    = CreateObject("Scripting.FileSystemObject")
Set sh     = CreateObject("WScript.Shell")
Dim appDir : appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Dim bat    : bat    = appDir & "\launch.bat"
sh.Run "cmd /c " & Chr(34) & Chr(34) & bat & Chr(34) & Chr(34), 0, False
