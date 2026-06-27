$env:HOST = "0.0.0.0"
$env:PORT = "3737"
Set-Location "C:\Users\haixun\Documents\OpenCodex"
node gateway/dev/run-gateway.cjs
