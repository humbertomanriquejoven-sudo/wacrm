import { redirect } from "next/navigation";

// Acceso directo por URL: redirige al panel completo con la conversación
// seleccionada. No se renderiza nada aquí para evitar duplicar la UI.
export default async function ConversacionDirecta({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/conversaciones?seleccion=${encodeURIComponent(id)}`);
}