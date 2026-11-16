# Crea (o reemplaza) la tarea programada "Taquilla Espana - actualizar".
# Martes 11:00 -> taquilla del fin de semana (segundos)
# Viernes 12:00 -> sesiones por cine del fin de semana (~30-45 min de descargas ligeras) + taquilla
# Si el ordenador está apagado a esa hora, se ejecuta en cuanto se encienda.
# Para quitarla:  Unregister-ScheduledTask -TaskName "Taquilla Espana - actualizar" -Confirm:$false

$raiz    = Split-Path -Parent $PSScriptRoot
$pythonw = (& python -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))").Trim()
if (-not (Test-Path $pythonw)) { throw "No encuentro pythonw.exe junto a python.exe" }

$accion   = New-ScheduledTaskAction -Execute $pythonw -Argument "-I `"$raiz\scripts\tarea.py`"" -WorkingDirectory $raiz
$disparos = @(
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Tuesday -At 11:00
  New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday  -At 12:00
)
$ajustes  = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable `
              -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
              -ExecutionTimeLimit (New-TimeSpan -Hours 3) -Priority 7 -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "Taquilla Espana - actualizar" -Action $accion -Trigger $disparos `
  -Settings $ajustes -Description "Descarga taquilla (eCartelera) y sesiones por cine; regenera la web de _ENTRENADOR" -Force |
  Select-Object TaskName, State

