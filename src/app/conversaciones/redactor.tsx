"use client";

import { useEffect, useRef, useCallback } from "react";

interface Props {
  contactId: number;
  disabled: boolean;
  onSend: (texto: string) => void;
}

export function Redactor({ contactId, disabled, onSend }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const clave = `borrador_conversacion_${contactId}`;

  useEffect(() => {
    const previo = sessionStorage.getItem(clave);
    if (previo && ref.current) {
      ref.current.value = previo;
    }
  }, [clave]);

  const handleInput = useCallback(() => {
    if (!ref.current) return;
    sessionStorage.setItem(clave, ref.current.value);
    // Auto-crecer.
    ref.current.style.height = "auto";
    ref.current.style.height = `${Math.min(ref.current.scrollHeight, 140)}px`;
  }, [clave]);

  function handleEnviar() {
    if (!ref.current) return;
    const texto = ref.current.value.trim();
    if (!texto) return;
    onSend(texto);
    ref.current.value = "";
    ref.current.style.height = "auto";
    sessionStorage.removeItem(clave);
  }

  function handleTecla(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleEnviar();
    }
  }

  return (
    <div className="redactor">
      <textarea
        ref={ref}
        placeholder="Escribe un mensaje..."
        disabled={disabled}
        rows={1}
        onInput={handleInput}
        onKeyDown={handleTecla}
      />
      <button className="btn btn-primario" onClick={handleEnviar} disabled={disabled}>
        Enviar
      </button>
    </div>
  );
}