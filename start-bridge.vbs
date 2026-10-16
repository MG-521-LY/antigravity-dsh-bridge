Option Explicit
Dim shell, files, folder, runtime, command, reader, exitCode, pauseMs
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
command = Chr(34) & runtime & Chr(34) & " --max-old-space-size=32 --max-semi-space-size=2 " & Chr(34) & folder & "\bridge-supervisor.cjs" & Chr(34)
pauseMs = 1000
Do
  If files.FileExists(folder & "\.bridge-maintenance") Then WScript.Quit 0
  exitCode = shell.Run(command, 0, True)
  If exitCode = 0 Then WScript.Quit 0
  If files.FileExists(folder & "\.bridge-maintenance") Then WScript.Quit 0
  WScript.Sleep pauseMs
  If pauseMs < 30000 Then pauseMs = pauseMs * 2
  If pauseMs > 30000 Then pauseMs = 30000
Loop
