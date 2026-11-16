@echo off
rem Abre la web en http://localhost:8765 con el botón de actualizar activo
cd /d "%~dp0"
python -I scripts\servidor.py
