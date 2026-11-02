// Memoria: muestra en la barra de GNOME cuánta RAM llevas usada y, al hacer clic, la RAM, la swap
// y los programas que más gastan, con un botón para cerrar alguno.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {agrupar, cerrar, formatoBytes, leerProcesos, totales} from './datos.js';

const REVISAR_BARRA = 5; // s: el porcentaje de la barra (lectura barata)
const REVISAR_LISTA = 5; // s: la lista de programas, solo mientras el menú está abierto
const CUANTOS = 8; // programas que se muestran
const NIVELES = [80, 90]; // % de RAM desde el que el texto pasa a amarillo y a rojo
const CONFIRMAR_DURANTE = 4; // s que el botón espera el segundo clic
const ANCHO_BARRA = 300; // px
const SWAP_VISIBLE = 50 * 1024 ** 2; // a partir de aquí se menciona la swap de un programa

function etiqueta(texto, clase = null, params = {}) {
    const l = new St.Label({text: texto, y_align: Clutter.ActorAlign.CENTER, ...params});
    if (clase)
        l.style_class = clase;
    return l;
}

function filaFija() {
    return new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
}

function nivel(pct) {
    if (pct >= NIVELES[1])
        return 'mm-critico';
    if (pct >= NIVELES[0])
        return 'mm-alto';
    return null;
}

const Indicador = GObject.registerClass(
class Indicador extends PanelMenu.Button {
    _init(script, icono) {
        super._init(0.0, 'Memoria');
        this._script = script;
        this._cancelable = new Gio.Cancellable();
        this._leyendo = false;
        this._grupos = null; // null = todavía no se ha leído la lista
        this._error = false;
        this._porConfirmar = null; // clave del grupo cuyo botón espera el segundo clic
        this._idConfirmar = 0;
        this._cerrando = new Set();
        this._temporizadores = new Set();

        const caja = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        caja.add_child(new St.Icon({gicon: Gio.icon_new_for_string(icono), style_class: 'system-status-icon'}));
        this._texto = etiqueta('', 'mm-barra-texto');
        caja.add_child(this._texto);
        this.add_child(caja);
        this.accessible_name = 'Memoria RAM';

        this._seccionTotales = new PopupMenu.PopupMenuSection();
        this._seccionLista = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._seccionTotales);
        this.menu.addMenuItem(this._separador('Lo que más gasta'));
        this.menu.addMenuItem(this._seccionLista);

        this.menu.connect('open-state-changed', (_m, abierto) => {
            if (abierto) {
                this._pintarTotales();
                this._pintarLista();
                this._leerLista();
                this._idLista = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REVISAR_LISTA, () => {
                    this._leerLista();
                    return GLib.SOURCE_CONTINUE;
                });
            } else {
                this._quitarTemporizador('_idLista');
                this._cancelarConfirmacion();
            }
        });

        this._idBarra = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REVISAR_BARRA, () => {
            this._pintarBarra();
            if (this.menu.isOpen)
                this._pintarTotales();
            return GLib.SOURCE_CONTINUE;
        });
        this._pintarBarra();
    }

    _quitarTemporizador(nombre) {
        if (this[nombre])
            GLib.source_remove(this[nombre]);
        this[nombre] = 0;
    }

    // ---------- Barra de arriba ----------

    _pintarBarra() {
        const t = totales();
        const pct = t.ramTotal ? Math.round(t.ramUsada / t.ramTotal * 100) : 0;
        this._texto.text = `${pct}%`;
        this.accessible_name = `Memoria RAM usada: ${pct} %`;
        this._texto.remove_style_class_name('mm-alto');
        this._texto.remove_style_class_name('mm-critico');
        if (nivel(pct))
            this._texto.add_style_class_name(nivel(pct));
    }

    // ---------- Menú ----------

    _separador(texto) {
        const fila = filaFija();
        const caja = new St.BoxLayout({x_expand: true});
        caja.add_child(etiqueta(texto, 'mm-seccion'));
        caja.add_child(new St.Widget({style_class: 'mm-linea', x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        fila.add_child(caja);
        return fila;
    }

    _filaTotal(titulo, usada, total) {
        const pct = total ? usada / total * 100 : 0;
        const fila = filaFija();
        const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const arriba = new St.BoxLayout({x_expand: true});
        arriba.add_child(etiqueta(titulo, 'mm-titulo', {x_expand: true}));
        arriba.add_child(etiqueta(`${formatoBytes(usada)} de ${formatoBytes(total)}`, nivel(pct) ?? 'mm-titulo'));
        columna.add_child(arriba);
        const barra = new St.Widget({style_class: 'mm-barra', width: ANCHO_BARRA});
        const relleno = new St.Widget({style_class: 'mm-relleno', width: Math.round(ANCHO_BARRA * Math.min(pct, 100) / 100)});
        if (nivel(pct))
            relleno.add_style_class_name(`${nivel(pct)}-fondo`);
        barra.add_child(relleno);
        columna.add_child(barra);
        fila.add_child(columna);
        return fila;
    }

    _pintarTotales() {
        const t = totales();
        this._seccionTotales.removeAll();
        this._seccionTotales.addMenuItem(this._filaTotal('RAM', t.ramUsada, t.ramTotal));
        if (t.swapTotal > 0)
            this._seccionTotales.addMenuItem(this._filaTotal('Swap', t.swapUsada, t.swapTotal));
    }

    _leerLista() {
        if (this._leyendo)
            return;
        this._leyendo = true;
        leerProcesos(this._script, this._cancelable, procesos => {
            this._leyendo = false;
            if (this._cancelable.is_cancelled())
                return;
            this._error = procesos === null;
            if (procesos) {
                const apps = Shell.AppSystem.get_default().get_running().map(app => ({app, pids: app.get_pids()}));
                this._grupos = agrupar(procesos, apps).slice(0, CUANTOS);
                const vigentes = new Set(this._grupos.map(g => g.clave));
                for (const clave of this._cerrando) {
                    if (!vigentes.has(clave))
                        this._cerrando.delete(clave);
                }
            }
            this._pintarLista();
        });
    }

    _pintarLista() {
        this._seccionLista.removeAll();
        if (this._error) {
            this._seccionLista.addMenuItem(this._filaAviso('No se pudo leer la lista de programas.', 'Reintentar'));
            return;
        }
        if (this._grupos === null) {
            // Cargando: filas con la forma de las reales.
            for (let i = 0; i < 3; i++) {
                const fila = filaFija();
                const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
                columna.add_child(new St.Widget({style_class: 'mm-esqueleto', width: 140}));
                columna.add_child(new St.Widget({style_class: 'mm-esqueleto mm-esqueleto-chico', width: 90}));
                fila.add_child(columna);
                this._seccionLista.addMenuItem(fila);
            }
            return;
        }
        for (const g of this._grupos)
            this._seccionLista.addMenuItem(this._filaGrupo(g));
    }

    _filaAviso(texto, accion) {
        const fila = filaFija();
        fila.add_child(etiqueta(texto, 'mm-detalle', {x_expand: true}));
        const b = new St.Button({style_class: 'mm-boton-texto', label: accion, can_focus: true});
        b.connect('clicked', () => {
            this._error = false;
            this._grupos = null;
            this._repintarLuego();
            this._leerLista();
        });
        fila.add_child(b);
        return fila;
    }

    _filaGrupo(g) {
        const fila = filaFija();
        const icono = g.app
            ? g.app.create_icon_texture(24)
            : new St.Icon({icon_name: 'application-x-executable-symbolic', icon_size: 24});
        icono.add_style_class_name('mm-icono');
        fila.add_child(icono);

        const columna = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true});
        const arriba = new St.BoxLayout({x_expand: true});
        arriba.add_child(etiqueta(g.nombre, 'mm-nombre', {x_expand: true}));
        arriba.add_child(etiqueta(formatoBytes(g.pss + g.swap), 'mm-cifra'));
        columna.add_child(arriba);
        const detalles = [g.procesos.length === 1 ? '1 proceso' : `${g.procesos.length} procesos`];
        if (g.swap >= SWAP_VISIBLE)
            detalles.push(`${formatoBytes(g.swap)} en swap`);
        if (this._cerrando.has(g.clave))
            detalles.push('cerrando…');
        columna.add_child(etiqueta(detalles.join(' · '), 'mm-detalle'));
        fila.add_child(columna);

        // Columna de ancho fijo para el botón: las cifras quedan alineadas aunque la fila no tenga
        // botón o el botón diga "¿Cerrar?".
        const lugarBoton = new St.Bin({style_class: 'mm-lugar-boton', x_align: Clutter.ActorAlign.END});
        if (!g.protegido)
            lugarBoton.child = this._botonCerrar(g);
        fila.add_child(lugarBoton);
        return fila;
    }

    /** Primer clic: el botón pregunta "¿Cerrar?". Segundo clic (antes de 4 s): cierra. */
    _botonCerrar(g) {
        const confirmando = this._porConfirmar === g.clave;
        const b = new St.Button({
            style_class: confirmando ? 'mm-boton mm-confirmar' : 'mm-boton',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: confirmando ? `Confirmar: cerrar ${g.nombre}` : `Cerrar ${g.nombre}`,
        });
        if (confirmando)
            b.label = '¿Cerrar?';
        else
            b.child = new St.Icon({icon_name: 'window-close-symbolic', style_class: 'popup-menu-icon'});
        b.reactive = !this._cerrando.has(g.clave);

        b.connect('clicked', () => {
            if (this._porConfirmar !== g.clave) {
                this._cancelarConfirmacion();
                this._porConfirmar = g.clave;
                this._idConfirmar = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, CONFIRMAR_DURANTE, () => {
                    this._idConfirmar = 0;
                    this._porConfirmar = null;
                    this._repintarLuego();
                    return GLib.SOURCE_REMOVE;
                });
                this._repintarLuego();
                return;
            }
            this._cancelarConfirmacion();
            this._cerrando.add(g.clave);
            this._repintarLuego();
            const id = cerrar(g, () => {
                this._temporizadores.delete(id);
                this._leerLista();
            });
            this._temporizadores.add(id);
        });
        return b;
    }

    /** Repinta en el siguiente ciclo: así un botón no se destruye mientras atiende su propio clic. */
    _repintarLuego() {
        if (this._idRepintar)
            return;
        this._idRepintar = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._idRepintar = 0;
            this._pintarLista();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelarConfirmacion() {
        this._quitarTemporizador('_idConfirmar');
        this._porConfirmar = null;
    }

    destroy() {
        this._cancelable.cancel();
        this._quitarTemporizador('_idBarra');
        this._quitarTemporizador('_idLista');
        this._quitarTemporizador('_idConfirmar');
        this._quitarTemporizador('_idRepintar');
        for (const id of this._temporizadores)
            GLib.source_remove(id);
        this._temporizadores.clear();
        super.destroy();
    }
});

export default class Memoria extends Extension {
    enable() {
        this._indicador = new Indicador(GLib.build_filenamev([this.path, 'procesos.py']),
            GLib.build_filenamev([this.path, 'iconos', 'memoria.svg']));
        // A la izquierda, al final: junto al nombre de la app abierta.
        Main.panel.addToStatusArea(this.uuid, this._indicador, -1, 'left');
    }

    disable() {
        this._indicador?.destroy();
        this._indicador = null;
    }
}
