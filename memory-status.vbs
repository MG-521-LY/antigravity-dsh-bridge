Option Explicit
Dim service, rows, row
Set service = GetObject("winmgmts:\\.\root\cimv2")
Set rows = service.ExecQuery("SELECT FreePhysicalMemory, FreeVirtualMemory FROM Win32_OperatingSystem")
For Each row In rows
  WScript.StdOut.WriteLine "{""freePhysicalKB"":" & row.FreePhysicalMemory & ",""freeVirtualKB"":" & row.FreeVirtualMemory & "}"
Next
