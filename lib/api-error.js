import { randomUUID } from 'crypto';

/**
 * Respuesta de error que NO filtra internos al cliente (BE-1 / CWE-209).
 *
 * Loguea el error real server-side con un requestId corto para correlacionar en
 * los logs, y devuelve al cliente solo un mensaje genérico + ese requestId.
 *
 * Uso:
 *   } catch (error) {
 *     return jsonError(error);                                  // 500 genérico
 *   }
 *   return jsonError(error, { status: 502 });                   // conserva el status
 *   return jsonError(error, { publicMessage: 'Checkout failed' });
 *
 * NO usar para errores de validación 400 / mensajes públicos intencionales
 * (esos son legibles a propósito y no filtran nada).
 */
export function jsonError(err, { status = 500, publicMessage = 'Error interno del servidor' } = {}) {
  const requestId = randomUUID().slice(0, 8);
  console.error(`[api-error] reqId=${requestId}`, err);
  return Response.json({ error: publicMessage, requestId }, { status });
}
