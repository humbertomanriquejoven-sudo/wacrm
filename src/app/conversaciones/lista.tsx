"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  toggleBot,
  enviarMensaje,
  borrarConversacion,
} from "./acciones";
import { Redactor } from "./redactor";
import { BorrarDialogo } from "./borrar";

type ContactoLista = {
  id: number;
  waId: string;
  nombre: string | null;
  botActivo: boolean;
  ventanaExpira: string | null;
  tieneCita: boolean;
  ultimoMensaje: {
    texto: string | null;
    tipo: string;
    direccion: string;
    creadoEn: string;
  } | null;
};

type MensajeHilo = {
  id: number;
  texto: string | null;
  tipo: string;
  direccion: string;
  creadoEn: string;
};

type ContactoSeleccion = {
  id: number;
  waId: string;
  nombre: string | null;
  botActivo: boolean;
  ventanaExpira: string | null;
};

type CitaSeleccion = {
  id: number;
  inicio: string;
  fin: string;
};

interface Props {
  contactos: ContactoLista[];
  seleccion: {
    contacto: ContactoSeleccion;
    mensajes: MensajeHilo[];
    citas: CitaSeleccion[];
  } | null;
  filtro: "todas" | "ventana" | "cita";
  busqueda: string;
  ahora: string;
}

function textoPreview(m: ContactoLista["ultimoMensaje"]): string {
  if (!m) return "Sin mensajes";
  if (m.tipo === "nota_de_voz") return "Nota de voz";
  if (m.tipo === "imagen") return "Imagen";
  if (m.tipo === "video") return "Video";
  if (m.tipo === "documento") return "Documento";
  if (m.direccion === "saliente") return m.texto ?? "(sin texto)";
  return m.texto ?? "(sin texto)";
}

function formatoFecha(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function formatoFechaCorta(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  if (
    d.getFullYear() === hoy.getFullYear() &&
    d.getMonth() === hoy.getMonth() &&
    d.getDate() === hoy.getDate()
  ) {
    return formatoFecha(iso);
  }
  return `${d.getDate()}/${d.getMonth() + 1} ${formatoFecha(iso)}`;
}

function agruparPorDia(mensajes: MensajeHilo[]): { clave: string; fecha: string; items: MensajeHilo[] }[] {
  const grupos = new Map<string, MensajeHilo[]>();
  for (const m of mensajes) {
    const d = new Date(m.creadoEn);
    const clave = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
    const lista = grupos.get(clave) ?? [];
    lista.push(m);
    grupos.set(clave, lista);
  }
  return [...grupos.entries()].map(([clave, items]) => {
    const d = new Date(items[0].creadoEn);
    const nombres = [
      "Domingo", "Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado",
    ];
    const meses = [
      "ene", "feb", "mar", "abr", "may", "jun",
      "jul", "ago", "sep", "oct", "nov", "dic",
    ];
    const fecha = `${nombres[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]}`;
    return { clave, fecha, items };
  });
}

export function Conversaciones({
  contactos,
  seleccion,
  filtro,
  busqueda,
  ahora,
}: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const [enviando, setEnviando] = useState(false);
  const [showBorrar, setShowBorrar] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const hiloRef = useRef<HTMLDivElement>(null);

  const ventanaAbierta = seleccion
    ? seleccion.contacto.ventanaExpira &&
      new Date(seleccion.contacto.ventanaExpira).getTime() > new Date(ahora).getTime()
    : false;

  const scrollToBottom = useCallback(() => {
    if (!hiloRef.current) return;
    hiloRef.current.scrollTop = hiloRef.current.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [seleccion?.mensajes?.length, scrollToBottom]);

  function seleccionar(id: number) {
    const p = new URLSearchParams(params.toString());
    p.set("seleccion", String(id));
    router.push(`/conversaciones?${p.toString()}`);
  }

  function cambiarFiltro(f: string) {
    const p = new URLSearchParams(params.toString());
    p.set("filtro", f);
    p.delete("seleccion");
    router.push(`/conversaciones?${p.toString()}`);
  }

  function cambiarBusqueda(valor: string) {
    const p = new URLSearchParams(params.toString());
    if (valor) p.set("busqueda", valor);
    else p.delete("busqueda");
    router.push(`/conversaciones?${p.toString()}`);
  }

  async function handleEnviar(texto: string) {
    if (!seleccion || !ventanaAbierta) return;
    setEnviando(true);
    try {
      await enviarMensaje(seleccion.contacto.waId, texto);
      router.refresh();
    } catch (e) {
      window.alert(e instanceof Error ? e.message : "No se pudo enviar");
    } finally {
      setEnviando(false);
    }
  }

  async function handleToggleBot() {
    if (!seleccion) return;
    await toggleBot(seleccion.contacto.waId);
    router.refresh();
  }

  async function handleBorrar() {
    if (!seleccion) return;
    setBorrando(true);
    try {
      await borrarConversacion(seleccion.contacto.waId);
    } catch {
      setBorrando(false);
      setShowBorrar(false);
    }
  }

  const grupos = seleccion ? agruparPorDia(seleccion.mensajes) : [];

  return (
    <>
      <div className="cabecera-pagina">
        <h1>Conversaciones</h1>
      </div>

      <div className="bandeja">
        {/* Columna izquierda: lista */}
        <div className="bandeja-lista">
          <div className="bandeja-buscar">
            <input
              className="campo-buscar"
              placeholder="Buscar por nombre o número"
              defaultValue={busqueda}
              onChange={(e) => cambiarBusqueda(e.target.value)}
            />
          </div>
          <div className="filtros">
            {(["todas", "ventana", "cita"] as const).map((f) => (
              <button
                key={f}
                className={`filtro${filtro === f ? " filtro-activo" : ""}`}
                onClick={() => cambiarFiltro(f)}
              >
                {f === "todas" ? "Todas" : f === "ventana" ? "Ventana abierta" : "Con cita"}
              </button>
            ))}
          </div>
          <div className="lista-conversaciones">
            {contactos.length === 0 ? (
              <div className="vacio" style={{ margin: 12, padding: 20 }}>
                No hay conversaciones.
              </div>
            ) : (
              contactos.map((c) => (
                <button
                  key={c.id}
                  className={`conversacion${seleccion?.contacto.id === c.id ? " conversacion-activa" : ""}`}
                  onClick={() => seleccionar(c.id)}
                >
                  <div className="conversacion-avatar">
                    {(c.nombre ?? c.waId).charAt(0).toUpperCase()}
                  </div>
                  <div className="conversacion-cuerpo">
                    <div className="conversacion-nombre">
                      <span>{c.nombre ?? c.waId}</span>
                      {c.ultimoMensaje ? (
                        <span className="conversacion-fecha">
                          {formatoFechaCorta(c.ultimoMensaje.creadoEn)}
                        </span>
                      ) : null}
                    </div>
                    <div className="conversacion-preview">
                      {c.ultimoMensaje?.direccion === "saliente" ? "→ " : ""}
                      {textoPreview(c.ultimoMensaje)}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Columna central: hilo */}
        <div className="bandeja-hilo">
          {seleccion ? (
            <>
              <div className="hilo-info">
                <div className="conversacion-avatar">
                  {(seleccion.contacto.nombre ?? seleccion.contacto.waId)
                    .charAt(0)
                    .toUpperCase()}
                </div>
                <div>
                  <div className="hilo-info-nombre">
                    {seleccion.contacto.nombre ?? seleccion.contacto.waId}
                  </div>
                  <div className="hilo-info-sub">{seleccion.contacto.waId}</div>
                </div>
              </div>

              {!seleccion.contacto.botActivo ? (
                <div className="banda-bot">
                  <span>Bot en pausa para esta conversación.</span>
                  <button className="btn" onClick={handleToggleBot}>
                    Reactivar
                  </button>
                </div>
              ) : null}

              <div className="hilo-mensajes" ref={hiloRef}>
                {grupos.map((grupo) => (
                  <div key={grupo.clave}>
                    <div className="separador-dia">{grupo.fecha}</div>
                    {grupo.items.map((m) => (
                      <div
                        key={m.id}
                        className={`burbuja ${
                          m.direccion === "saliente"
                            ? "burbuja-saliente"
                            : "burbuja-entrante"
                        }`}
                      >
                        {m.tipo === "nota_de_voz" ? (
                          <>
                            <span className="etiqueta-media">Nota de voz</span>
                            <br />
                            {m.texto ?? "(transcripción pendiente)"}
                          </>
                        ) : m.tipo === "imagen" ? (
                          <>
                            <span className="etiqueta-media">Imagen</span>
                            <br />
                            {m.texto ?? "(descripción pendiente)"}
                          </>
                        ) : m.tipo === "video" ? (
                          <>
                            <span className="etiqueta-media">Video</span>
                            <br />
                            {m.texto ?? ""}
                          </>
                        ) : m.tipo === "documento" ? (
                          <>
                            <span className="etiqueta-media">Documento</span>
                            <br />
                            {m.texto ?? ""}
                          </>
                        ) : (
                          m.texto
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              <Redactor
                key={seleccion.contacto.id}
                contactId={seleccion.contacto.id}
                disabled={!ventanaAbierta || enviando}
                onSend={handleEnviar}
              />
              {!ventanaAbierta ? (
                <div className="redactor-bloqueo">
                  La ventana de 24 h ha expirado. Espera a que el cliente escriba.
                </div>
              ) : null}
            </>
          ) : (
            <div className="vacio" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
              Selecciona una conversación.
            </div>
          )}
        </div>

        {/* Columna derecha: ficha */}
        <div className="bandeja-ficha">
          {seleccion ? (
            <>
              <div className="ficha-cabecera">
                <div className="ficha-avatar">
                  {(seleccion.contacto.nombre ?? seleccion.contacto.waId)
                    .charAt(0)
                    .toUpperCase()}
                </div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>
                  {seleccion.contacto.nombre ?? "(sin nombre)"}
                </div>
                <div className="hilo-info-sub">{seleccion.contacto.waId}</div>
              </div>

              <div className="ficha-campo">
                <div className="ficha-campo-titulo">Nombre</div>
                <div className="ficha-campo-valor">
                  {seleccion.contacto.nombre ?? "—"}
                </div>
              </div>

              <div className="ficha-campo">
                <div className="ficha-campo-titulo">Teléfono</div>
                <div className="ficha-campo-valor">{seleccion.contacto.waId}</div>
              </div>

              <div className="ficha-campo">
                <div className="ficha-campo-titulo">Ventana de respuesta</div>
                <div className="ficha-campo-valor">
                  {ventanaAbierta ? "Abierta" : "Cerrada"}
                </div>
              </div>

              {seleccion.citas.length > 0 ? (
                <div className="ficha-campo">
                  <div className="ficha-campo-titulo">
                    {seleccion.citas.length === 1 ? "Cita próxima" : "Citas próximas"}
                  </div>
                  {seleccion.citas.map((c) => (
                    <div key={c.id} className="ficha-campo-valor" style={{ marginBottom: 4 }}>
                      {new Date(c.inicio).toLocaleDateString("es-PE", {
                        day: "numeric",
                        month: "short",
                      })}{" "}
                      {new Date(c.inicio).toLocaleTimeString("es-PE", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="ficha-campo">
                <div className="ficha-campo-titulo">Agente automático</div>
                <label className="interruptor">
                  <input
                    type="checkbox"
                    checked={seleccion.contacto.botActivo}
                    onChange={handleToggleBot}
                  />
                  <span className="interruptor-pista" />
                  {seleccion.contacto.botActivo ? "Activo" : "Pausado"}
                </label>
              </div>

              <div className="ficha-campo">
                <button
                  className="btn btn-peligro"
                  style={{ width: "100%" }}
                  onClick={() => setShowBorrar(true)}
                >
                  Borrar conversación
                </button>
              </div>
            </>
          ) : (
            <div className="vacio" style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", margin: 12, padding: 20 }}>
              Selecciona una conversación para ver la ficha.
            </div>
          )}
        </div>
      </div>

      {showBorrar && seleccion ? (
        <BorrarDialogo
          nombre={seleccion.contacto.nombre ?? seleccion.contacto.waId}
          onConfirm={handleBorrar}
          onCancel={() => {
            setShowBorrar(false);
            setBorrando(false);
          }}
          procesando={borrando}
        />
      ) : null}
    </>
  );
}