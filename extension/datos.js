// Datos de memoria: totales de RAM y swap, y los programas que más gastan.
// Solo GLib/Gio (más Shell para saber qué ventanas son de qué app), sin interfaz.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const decodificador = new TextDecoder();

// Procesos del escritorio que no se ofrecen para cerrar: cerrarlos rompe la sesión.
const PROTEGIDOS = /^(gnome-|gsd-|mutter|Xwayland|systemd|dbus|pipewire|wireplumber|gvfs|xdg-|at-spi|ibus|evolution-|tracker|dconf|gjs|goa-|polkit|ssh-agent|gpg-agent|sd_|\(sd-pam\))/;

function leer(ruta) {
    try {
        return decodificador.decode(GLib.file_get_contents(ruta)[1]);
    } catch {
        return null;
    }
}

/** RAM y swap de toda la computadora, en bytes. Lectura barata: se hace en cada refresco de la barra. */
export function totales() {
    const info = {};
    for (const linea of (leer('/proc/meminfo') ?? '').split('\n')) {
        const m = linea.match(/^(\w+):\s+(\d+) kB/);
        if (m)
            info[m[1]] = Number(m[2]) * 1024;
    }
    const ramTotal = info.MemTotal ?? 0;
    const swapTotal = info.SwapTotal ?? 0;
    return {
        ramTotal,
        ramUsada: ramTotal - (info.MemAvailable ?? ramTotal),
        swapTotal,
        swapUsada: swapTotal - (info.SwapFree ?? swapTotal),
    };
}

/** Corre procesos.py sin bloquear GNOME y entrega la lista de procesos (o null si falló). */
export function leerProcesos(script, cancelable, alTerminar) {
    let proceso;
    try {
        proceso = Gio.Subprocess.new(['python3', '-I', script],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        logError(e, 'Memoria: no se pudo correr procesos.py');
        alTerminar(null);
        return;
    }
    proceso.communicate_utf8_async(null, cancelable, (p, resultado) => {
        try {
            const [, salida] = p.communicate_utf8_finish(resultado);
            alTerminar(JSON.parse(salida));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'Memoria: no se pudo leer la lista de procesos');
            alTerminar(null);
        }
    });
}

const HOME = GLib.get_home_dir();
// Programas que corren el código de un proyecto: se separan por la carpeta donde corren.
const INTERPRETES = /^(node|nodejs|bun|deno|python[\d.]*|ruby|php[\d.]*|java|claude)$/;

/** Nombre corto de la carpeta de un proceso; vacío si es tu carpeta personal o la raíz (no dice nada). */
function carpetaVisible(ruta) {
    if (!ruta || ruta === '/' || ruta === HOME)
        return '';
    return GLib.path_get_basename(ruta);
}

function limpiarNombre(nombre) {
    return nombre.replace(/-MainThread$/, '').replace(/^\((.*)\)$/, '$1');
}

/**
 * Junta los procesos en grupos:
 *  - Un programa con ventana (Brave, Spotify…) se queda con todos sus procesos hijos del mismo ejecutable.
 *    Los hijos de otro ejecutable (por ejemplo, Claude Code dentro de la terminal) van aparte.
 *  - El resto se agrupa por ejecutable (todos los "node" juntos).
 * @param procesos lista de procesos.py
 * @param apps lista de {app, pids} de las apps con ventana abierta
 */
export function agrupar(procesos, apps) {
    const porPid = new Map(procesos.map(p => [p.pid, p]));
    const appDePid = new Map();
    for (const {app, pids} of apps) {
        for (const pid of pids)
            appDePid.set(pid, app);
    }

    const grupos = new Map();
    for (const p of procesos) {
        if (p.pss + p.swap === 0)
            continue;
        let app = null;
        for (let q = p, i = 0; q && i < 30; q = porPid.get(q.ppid), i++) {
            if (q.exe !== p.exe)
                break;
            if (appDePid.has(q.pid)) {
                app = appDePid.get(q.pid);
                break;
            }
        }
        // Los intérpretes sin ventana se separan también por carpeta: así el "node" de un proyecto
        // no se junta (ni se cierra) con el de otro.
        const porCarpeta = !app && (INTERPRETES.test(p.exe) || INTERPRETES.test(limpiarNombre(p.nombre)));
        const carpeta = porCarpeta ? carpetaVisible(p.carpeta) : '';
        const clave = app ? `app:${app.get_id()}` : `exe:${p.exe || p.nombre}:${carpeta}`;
        if (!grupos.has(clave)) {
            const nombre = app ? app.get_name() : limpiarNombre(p.nombre);
            grupos.set(clave, {
                clave,
                app,
                nombre: carpeta ? `${nombre} · ${carpeta}` : nombre,
                procesos: [],
                pss: 0,
                swap: 0,
            });
        }
        const g = grupos.get(clave);
        g.procesos.push(p);
        g.pss += p.pss;
        g.swap += p.swap;
    }

    for (const g of grupos.values()) {
        // Los procesos "raíz" del grupo: los que no tienen a su padre dentro del grupo. Cerrarlos cierra el resto.
        const pids = new Set(g.procesos.map(p => p.pid));
        g.raices = g.procesos.filter(p => !pids.has(p.ppid));
        g.protegido = !g.app && PROTEGIDOS.test(limpiarNombre(g.procesos[0].nombre));
    }
    return [...grupos.values()].sort((a, b) => (b.pss + b.swap) - (a.pss + a.swap));
}

function arranqueDe(pid) {
    const stat = leer(`/proc/${pid}/stat`);
    return stat ? Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]) : null;
}

function senal(nombre, pid) {
    try {
        Gio.Subprocess.new(['kill', `-${nombre}`, String(pid)], Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        logError(e, 'Memoria: no se pudo mandar la señal');
    }
}

/**
 * Cierra un grupo. Si es una app con ventana, se le pide que cierre como cuando eliges "Salir"
 * (así guarda lo que tenga que guardar). Si no, se manda SIGTERM a sus procesos raíz y,
 * si a los 5 s siguen vivos, SIGKILL. Antes de cada señal se revisa que el pid sea el mismo proceso.
 * Devuelve el id del temporizador (o 0) para poder cancelarlo.
 */
export function cerrar(grupo, alTerminar) {
    if (grupo.app) {
        grupo.app.request_quit();
        return GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            alTerminar();
            return GLib.SOURCE_REMOVE;
        });
    }
    const vivos = () => grupo.raices.filter(p => arranqueDe(p.pid) === p.arranque);
    vivos().forEach(p => senal('TERM', p.pid));
    return GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 5, () => {
        vivos().forEach(p => senal('KILL', p.pid));
        alTerminar();
        return GLib.SOURCE_REMOVE;
    });
}

export function formatoBytes(bytes) {
    const gb = bytes / 1024 ** 3;
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}
