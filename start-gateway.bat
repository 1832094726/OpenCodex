@echo off
cd /d C:\Users\haixun\Documents\OpenCodex
set HOST=0.0.0.0
set PORT=3737
node gateway/dev/run-gateway.cjs
