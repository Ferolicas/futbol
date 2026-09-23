import { z } from 'zod';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import { CF_ASSISTANT_TOOLS, executeAssistantTool } from '../../../../lib/cf-assistant';

export const dynamic = 'force-dynamic';

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().min(1).max(3000) })).min(1).max(16),
});

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  return `Eres el asistente de CF Análisis. Responde en español claro usando exclusivamente datos devueltos por tus herramientas de solo lectura. Nunca inventes partidos, cuotas, probabilidades ni pronósticos. No calcules pronósticos nuevos, no modifiques el motor y no presentes una apuesta como segura. Si no existe información, dilo. Respeta el nivel de acceso devuelto por la herramienta. Las probabilidades son estimaciones, no garantías.

Hoy es ${today} (usa esta fecha cuando el usuario diga "hoy"; search_recommendations y get_calculated_frequency ya la usan por defecto si no la das explícitamente).

Si te preguntan por recomendaciones que abarcan VARIOS partidos a la vez (ej. "dame las de más de 80% de hoy", "qué hay recomendado para mañana en fútbol", "cuáles tienen más de 2.5 goles", "cuáles tienen córners"), usa search_recommendations — nunca respondas "no hay nada" sin haberla llamado, y nunca intentes armar esa respuesta llamando get_existing_prediction partido por partido (no sabés de antemano los fixtureId). Si el pedido junta VARIOS criterios distintos en una sola pregunta (ej. "las de más de 2.5 goles, las de más de 6.5 córners y las de gol en la primera parte"), llamá search_recommendations UNA VEZ POR CADA criterio (varias tool_calls en la misma respuesta) y después presentá cada lista por separado, aclarando cuando alguna quedó vacía.

Si te preguntan algo de UN partido concreto que no está entre sus recomendaciones de get_existing_prediction (ej. "cuántos goles habrá", una línea o mercado puntual), usa get_calculated_frequency antes de decir que no existe: trae TODOS los mercados calculados de ese partido. Cada uno viene con type="recomendacion" o type="dato_estadistico" — un "dato_estadistico" es frecuencia histórica calculada, NUNCA la presentes como recomendación de apuesta; acláralo explícitamente ("no es una recomendación, es un dato estadístico calculado").

Cuando una respuesta se apoye en el pronóstico o la frecuencia de un partido concreto y la herramienta te devuelva matchUrl, ofrecé el enlace al análisis completo como markdown: [Ver análisis completo](matchUrl). No lo repitas si ya lo diste en la respuesta anterior de la misma conversación.

Si te piden hacer algo que existe como función del dashboard (por ejemplo cambiar la contraseña) pero vos no podés ejecutarla, usa get_app_action_link para dar el enlace real como markdown — ej. [Cambiar contraseña](url) — en vez de simplemente decir que no podés. Nunca inventes una URL que no venga de una herramienta.`;
}

// Groq en tier gratuito limita tokens por minuto (8k en gpt-oss-20b). Ante un
// 429 se espera lo que pide Groq (si es poco) y se reintenta; si sigue
// saturado o la petición no cabe (413), se pasa al siguiente modelo, que
// tiene su propio cupo. Así una pregunta normal no termina en "no disponible".
const MODELS = [process.env.GROQ_MODEL || 'openai/gpt-oss-20b', ...(process.env.GROQ_FALLBACK_MODELS || 'openai/gpt-oss-120b,qwen/qwen3.8-27b').split(',')]
  .map((model) => model.trim()).filter((model, index, all) => model && all.indexOf(model) === index);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GroqError extends Error {
  constructor(status, message) { super(`Groq ${status}: ${message}`); this.status = status; }
}

async function groqOnce(model, messages, tools) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools, tool_choice: 'auto', temperature: 0.1, max_completion_tokens: 900 }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new GroqError(response.status, body.error?.message || 'error de servicio');
  return body.choices?.[0]?.message;
}

async function groq(messages, tools, state) {
  let lastError = null;
  for (let index = state.modelIndex; index < MODELS.length; index++) {
    const model = MODELS[index];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const message = await groqOnce(model, messages, tools);
        state.modelIndex = index; // el resto de rondas sigue con el modelo que respondió
        return message;
      } catch (error) {
        lastError = error;
        const waitSeconds = Number(String(error.message).match(/try again in ([\d.]+)s/i)?.[1]);
        if (error.status === 429 && attempt === 0 && Number.isFinite(waitSeconds) && waitSeconds <= 8) {
          await sleep(Math.ceil(waitSeconds * 1000) + 250);
          continue;
        }
        if (error.status === 429 || error.status === 413 || error.status >= 500 || error.status === 400) break;
        throw error;
      }
    }
    console.warn('[assistant/chat] modelo sin cupo, se prueba el siguiente:', model, lastError?.message);
  }
  throw lastError || new Error('Groq no respondió');
}

// Un resultado de herramienta nunca debe superar ~1.5k tokens: si una lista
// es muy larga se recorta y se avisa al modelo cuántas quedaron fuera.
function toolContent(result) {
  let text = JSON.stringify(result);
  if (text.length <= 6000) return text;
  const listKey = ['recommendations', 'markets'].find((key) => Array.isArray(result?.[key]));
  if (listKey) {
    const list = result[listKey];
    let keep = list.length;
    while (keep > 1 && text.length > 6000) {
      keep = Math.floor(keep * 0.75);
      text = JSON.stringify({ ...result, [listKey]: list.slice(0, keep), truncated: `Se muestran ${keep} de ${list.length}, ordenados por probabilidad.` });
    }
    return text;
  }
  return text.slice(0, 6000);
}

export async function POST(request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  const limit = await redisRateLimit('cf-assistant', user.id, 20, 60, { failClosed: true });
  if (!limit.success) return Response.json({ error: 'Has enviado demasiadas consultas. Espera un minuto.' }, { status: 429 });
  if (!process.env.GROQ_API_KEY) return Response.json({ error: 'El asistente todavía no está configurado.' }, { status: 503 });
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Conversación inválida' }, { status: 400 });
  const paidAccess = await userHasActivePlan(user);
  // Solo las últimas 10 intervenciones: el historial completo gastaba el cupo por minuto.
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...parsed.data.messages.slice(-10)];
  const state = { modelIndex: 0 };
  try {
    for (let round = 0; round < 4; round++) {
      const answer = await groq(messages, CF_ASSISTANT_TOOLS, state);
      if (!answer) throw new Error('Groq no devolvió respuesta');
      // Groq rechaza campos extra (reasoning, etc.) al reenviar el turno del asistente.
      messages.push({ role: 'assistant', content: answer.content || '', ...(answer.tool_calls?.length ? { tool_calls: answer.tool_calls } : {}) });
      if (!answer.tool_calls?.length) return Response.json({ answer: answer.content || 'No encontré información para responder.' });
      for (const call of answer.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const result = await executeAssistantTool(call.function?.name, args, { paidAccess });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: toolContent(result) });
      }
    }
    return Response.json({ answer: 'No pude completar la consulta con los datos disponibles.' });
  } catch (error) {
    console.error('[assistant/chat]', error.message);
    return Response.json({ error: 'El asistente no está disponible temporalmente.' }, { status: 502 });
  }
}
