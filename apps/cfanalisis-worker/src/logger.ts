// @ts-nocheck
/**
 * Logger Pino — JSON estructurado a stdout + opcionalmente a archivo.
 *
 * Configuracion via env:
 *   LOG_LEVEL  default 'info' (trace|debug|info|warn|error|fatal)
 *   LOG_FILE   ruta absoluta para escribir los logs (ej. /var/log/cfanalisis/worker.log)
 *              Si no se setea, solo stdout.
 *   NODE_ENV   si != 'production' → pretty-print a stdout (color, legible).
 *
 * Rotacion: el archivo NO se rota desde el codigo. Usa logrotate del sistema
 * con `copytruncate` (ver INSTALL.md → "Bloque 4 — Pino + Telegram").
 */
import pino from 'pino';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const level = process.env.LOG_LEVEL || 'info';
const logFile = process.env.LOG_FILE;
const isProd = process.env.NODE_ENV === 'production';

const streams: { stream: NodeJS.WritableStream; level?: string }[] = [];

// stdout: pretty en dev, JSON crudo en prod.
if (!isProd) {
  // pino-pretty es devDep — solo se intenta cargar en dev.
  try {
    const PinoPretty = require('pino-pretty');
    streams.push({ stream: PinoPretty({ colorize: true, translateTime: 'SYS:HH:MM:ss' }) });
  } catch {
    streams.push({ stream: process.stdout });
  }
} else {
  streams.push({ stream: process.stdout });
}

// Archivo: solo si LOG_FILE esta seteado. Crea el directorio si no existe.
if (logFile) {
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    streams.push({ stream: pino.destination({ dest: logFile, sync: false, mkdir: true }) });
  } catch (e) {
    console.error(`[logger] no se pudo abrir LOG_FILE=${logFile}:`, (e as Error).message);
  }
}

export const logger = pino(
  { level, base: { svc: 'cfanalisis-worker' } },
  pino.multistream(streams),
);

// Console.log redirect (opcional). Mantenemos console.log/error tal cual para
// que los modulos legacy sigan funcionando; el pm2 stdout sigue capturandolos.
// Si en el futuro quieres convertir todo a Pino, descomenta:
// console.log   = (...args) => logger.info(args.join(' '));
// console.error = (...args) => logger.error(args.join(' '));
