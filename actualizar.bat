@echo off
rem Actualización manual: sesiones por cine (solo vie-dom) + taquilla + web
cd /d "%~dp0"
python -I scripts\sesiones.py
python -I scripts\ingesta.py
pause
