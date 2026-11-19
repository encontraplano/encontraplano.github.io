@echo off
rem Actualización manual: sesiones por cine (solo vie-dom) + taquilla + web
cd /d "%~dp0"
python -m pip install --quiet --disable-pip-version-check "pdfplumber>=0.11,<0.12"
python -I scripts\sesiones.py
python -I scripts\ingesta.py
pause
