"""Lista tus procesos con la memoria que de verdad usan, para la extensión Memoria de GNOME.

Usa PSS (la memoria propia más la parte que le toca de la compartida), así los programas con muchos
procesos, como Brave, no cuentan dos veces la misma memoria. Imprime un JSON en una sola línea.
"""
import json
import os

UID = os.getuid()
procesos = []
for nombre in os.listdir("/proc"):
    if not nombre.isdigit():
        continue
    base = f"/proc/{nombre}"
    try:
        if os.stat(base).st_uid != UID:
            continue
        with open(f"{base}/stat", encoding="utf-8", errors="replace") as f:
            stat = f.read()
        pss = swap = 0
        with open(f"{base}/smaps_rollup", encoding="utf-8") as f:
            for linea in f:
                if linea.startswith("Pss:"):
                    pss = int(linea.split()[1])
                elif linea.startswith("SwapPss:"):
                    swap = int(linea.split()[1])
        try:
            exe = os.path.basename(os.readlink(f"{base}/exe")).removesuffix(" (deleted)")
        except OSError:
            exe = ""
        try:
            carpeta = os.readlink(f"{base}/cwd")
        except OSError:
            carpeta = ""
    except (OSError, ValueError):
        continue  # el proceso terminó mientras se leía, o no se puede leer: se salta
    cierre = stat.rfind(")")
    campos = stat[cierre + 2:].split()
    procesos.append({
        "pid": int(nombre),
        "ppid": int(campos[1]),
        "arranque": int(campos[19]),
        "nombre": stat[stat.find("(") + 1:cierre],
        "exe": exe,
        "carpeta": carpeta,
        "pss": pss * 1024,
        "swap": swap * 1024,
    })
print(json.dumps(procesos, separators=(",", ":")))
