import type { QueueName } from './queues.js';

// BullMQ renueva el lock mientras el Promise del handler siga pendiente. Sin un
// techo externo, una consulta que nunca responde puede mantener el job "active"
// durante días y bloquear todos los ticks posteriores de esa cola.
//
// Solo acotamos jobs periódicos que deben terminar bastante antes de su siguiente
// ejecución. Los entrenamientos/capturas maratón conservan sus límites internos.
export const JOB_EXECUTION_TIMEOUTS_MS: Partial<Record<QueueName, number>> = {
  'futbol-finalize': 12 * 60_000,
  'futbol-lineups': 8 * 60_000,
  'baseball-coverage': 10 * 60_000,
};

export async function runWithJobTimeout<T>(
  queue: QueueName,
  jobId: string | number | undefined,
  task: () => Promise<T>,
): Promise<T> {
  const timeoutMs = JOB_EXECUTION_TIMEOUTS_MS[queue];
  if (!timeoutMs) return task();

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(
        `${queue} excedió ${Math.round(timeoutMs / 60_000)} min (job ${jobId ?? 'sin-id'})`,
      );
      (error as Error & { code?: string }).code = 'JOB_EXECUTION_TIMEOUT';
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });

  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
