import { PrismaClient } from "@prisma/client";

// La caché en globalThis va SIEMPRE, también en producción: el server
// standalone carga este módulo por separado para el webhook y para las
// páginas, y sin la caché acabas con varios clientes de Prisma en el mismo
// proceso, cada uno con su conexión al mismo archivo SQLite.
const g = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaPreparado?: boolean;
};

function crearCliente(): PrismaClient {
  const cliente = new PrismaClient();
  preparar(cliente).catch((err) => {
    // El fallo se registra pero no tumba la app: puede pasar durante el build
    // del Dockerfile, cuando /app/data todavía no existe.
    console.error("[prisma] no se pudieron aplicar los PRAGMA", err);
  });
  return cliente;
}

// PRAGMA journal_mode y busy_timeout devuelven una fila, así que hay que
// llamarlos con $queryRawUnsafe. Con $executeRawUnsafe fallan con
// "Execute returned results, which is not allowed in SQLite".
async function preparar(cliente: PrismaClient): Promise<void> {
  if (g.prismaPreparado) return;
  await cliente.$queryRawUnsafe("PRAGMA journal_mode = WAL");
  await cliente.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
  g.prismaPreparado = true;
}

export const prisma: PrismaClient = g.prisma ?? (g.prisma = crearCliente());