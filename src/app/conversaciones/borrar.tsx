"use client";

interface Props {
  nombre: string;
  onConfirm: () => void;
  onCancel: () => void;
  procesando: boolean;
}

export function BorrarDialogo({ nombre, onConfirm, onCancel, procesando }: Props) {
  return (
    <div className="modal-tapiz" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Borrar conversación</h3>
        <p>
          Se eliminarán los mensajes, citas activas en Google y los datos de{" "}
          <strong>{nombre}</strong>. Esta acción no se puede deshacer.
        </p>
        <div className="modal-acciones">
          <button className="btn" onClick={onCancel} disabled={procesando}>
            Cancelar
          </button>
          <button
            className="btn btn-peligro"
            onClick={onConfirm}
            disabled={procesando}
          >
            {procesando ? "Borrando..." : "Borrar"}
          </button>
        </div>
      </div>
    </div>
  );
}