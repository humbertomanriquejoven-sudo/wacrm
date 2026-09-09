-- CreateTable
CREATE TABLE "Contacto" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "waId" TEXT NOT NULL,
    "nombre" TEXT,
    "ventanaExpira" DATETIME,
    "botActivo" BOOLEAN NOT NULL DEFAULT true,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Mensaje" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contactoId" INTEGER NOT NULL,
    "waMessageId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "direccion" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "creadoEn" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Mensaje_contactoId_fkey" FOREIGN KEY ("contactoId") REFERENCES "Contacto" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Media" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER NOT NULL,
    "tipo" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "datos" BLOB NOT NULL,
    CONSTRAINT "Media_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Mensaje" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Cita" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "contactoId" INTEGER NOT NULL,
    "googleEventId" TEXT NOT NULL,
    "inicio" DATETIME NOT NULL,
    "fin" DATETIME NOT NULL,
    "cancelada" BOOLEAN NOT NULL DEFAULT false,
    "notas" TEXT,
    CONSTRAINT "Cita_contactoId_fkey" FOREIGN KEY ("contactoId") REFERENCES "Contacto" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "tipo" TEXT NOT NULL,
    "clave" TEXT NOT NULL,
    "correrEn" DATETIME NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "intentos" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "error" TEXT,
    "actualizadoEn" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Contacto_waId_key" ON "Contacto"("waId");

-- CreateIndex
CREATE UNIQUE INDEX "Mensaje_waMessageId_key" ON "Mensaje"("waMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "Media_messageId_key" ON "Media"("messageId");

-- CreateIndex
CREATE INDEX "Job_tipo_clave_estado_idx" ON "Job"("tipo", "clave", "estado");

-- CreateIndex
CREATE INDEX "Job_estado_correrEn_idx" ON "Job"("estado", "correrEn");
