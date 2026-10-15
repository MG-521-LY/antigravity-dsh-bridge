Option Explicit
Dim shell, files, folder, runtime, command, reader
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
If Not files.FileExists(folder & "\node-path.txt") Then
  WScript.Echo "Run setup.ps1 before starting the API entry."
  WScript.Quit 1
End If
Set reader = files.OpenTextFile(folder & "\node-path.txt", 1, False, -1)
runtime = Trim(reader.ReadLine)
reader.Close
If Not files.FileExists(runtime) Then
  WScript.Echo "The configured Node.js runtime was not found. Run setup.ps1 again."
  WScript.Quit 1
End If
shell.CurrentDirectory = folder
command = Chr(34) & runtime & Chr(34) & " " & Chr(34) & folder & "\lazy-api.cjs" & Chr(34)
shell.Run command, 0, False
