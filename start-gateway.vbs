Set WshShell = CreateObject("WScript.Shell")
WshShell.CurrentDirectory = "C:\Users\haixun\Documents\OpenCodex"
Set env = WshShell.Environment("Process")
env.Item("HOST") = "0.0.0.0"
env.Item("PORT") = "3737"
WshShell.Run "cmd /c node gateway/dev/run-gateway.cjs > gw-out.log 2> gw-err.log", 0, False
