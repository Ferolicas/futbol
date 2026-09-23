import { z } from 'zod';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import { CF_ASSISTANT_TOOLS, executeAssistantTool, localDate, safeTimeZone } from '../../../../lib/cf-assistant';

export const dynamic = 'force-dynamic';

// context = filtros de la última búsqueda (lo devuelve esta ruta y el chat
// lo reenvía): permite "de esas, las de más del 80%" o "¿y las del cali?"
// sin que el usuario repita fecha, deporte ni umbral.
const contextSchema = z.object({
  date: z.string().max(20).nullish(),
  sport: z.string().max(30).nullish(),
  team: z.string().max(80).nullish(),
  minProbability: z.number().min(0).max(100).nullish(),
  marketNameLike: z.string().max(80).nullish(),
  timing: z.string().max(12).nullish(),
}).partial();

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().min(1).max(3000) })).min(1).max(16),
  timeZone: z.string().max(64).optional(),
  context: contextSchema.nullish(),
});

function buildSystemPrompt({ timeZone, context }) {
  const now = new Date();
  const clock = new Intl.DateTimeFormat('es', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(now);
  const [today, yesterday, tomorrow] = [localDate(timeZone, 0, now), localDate(timeZone, -1, now), localDate(timeZone, 1, now)];
  const active = context && Object.values(context).some((value) => value != null && value !== '' && value !== 0)
    ? `\n\nFILTROS ACTIVOS DE LA CONVERSACIÓN (última búsqueda): ${JSON.stringify(context)}.`
    : '';
  return `Eres el asistente de CF Análisis: un agente que ENTIENDE lo que el usuario quiere y usa sus herramientas de solo lectura para encontrarlo. Responde en español claro usando exclusivamente datos devueltos por las herramientas. Nunca inventes partidos, cuotas, probabilidades ni pronósticos; no calcules pronósticos nuevos ni presentes una apuesta como segura. Las probabilidades son estimaciones, no garantías. Respeta el nivel de acceso devuelto por la herramienta.

AHORA: ${clock} (zona ${timeZone}). Hoy=${today}, ayer=${yesterday}, mañana=${tomorrow}. Traducí siempre "hoy/ayer/mañana/el sábado" a su fecha.

CÓMO PENSAR:
1. Momento (el servidor lo aplica solo si dejás timing en null): pedido general de hoy SIN equipo ("qué opciones hay hoy", "lo mejor de hoy", "qué hay con más probabilidad") = solo lo que AÚN NO EMPIEZA. Con equipo ("las del cali") = todo lo de ese equipo, jugado o por jugar, buscando en los últimos 7 días y los próximos 3 si no dio fecha. Con otra fecha ("ayer", "el sábado") = todo ese día. Poné date SOLO si el usuario nombró un día. Si pregunta en pasado por hoy ("cuáles fueron las de hoy"), usá timing="all".
2. Equipos: el usuario escribe nombres incompletos o mal escritos ("el cali", "atlanta", "medellin"). Pasá ese texto en "team" (search_recommendations o search_existing_matches); la búsqueda es parcial y sin tildes. Si coincide con UN solo partido, ese es. Si coincide con varios, preguntá cuál de ellos (listándolos con hora), no respondas por todos ni digas que no existe.
3. Hilo de la conversación: cada pregunta continúa la anterior salvo que cambie de tema. "De esas, las de más del 80%" = misma búsqueda anterior + minProbability 80. "¿Y para el cali?" = mismos filtros (fecha, umbral, mercado) + team "cali". Solo reiniciá filtros si dice "en general", "todas", "otro día" o cambia claramente de tema.${active}
4. Si una búsqueda de mercado vuelve vacía, no te quedes en "no hay": buscá con un filtro más amplio (solo el tipo de mercado, ej. "goles") y ofrecé lo que sí existe aclarando que no es exactamente lo pedido. Si el resultado trae alreadyStarted, decí que los de hoy ya empezaron y ofrecé mostrarlos.
5. Para una línea o número puntual de UN partido que no está entre sus recomendaciones, usá get_calculated_frequency; un "dato_estadistico" es frecuencia histórica, NUNCA una recomendación — decilo explícitamente.
6. Si piden algo que existe en el dashboard (ej. cambiar la contraseña), usá get_app_action_link y da el enlace en markdown, ej. [Cambiar contraseña](url). Nunca inventes URLs.

FORMATO (se lee en un teléfono): sin tablas ni encabezados (#). Un partido por línea: "• Local vs Visitante (hora) — mercado — 82% @1.45 [Ver análisis completo](matchUrl)". Máximo 10 líneas; si hay más, decí cuántas quedaron fuera y cómo filtrarlas. Breve y directo.`;
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
  const timeZone = safeTimeZone(parsed.data.timeZone);
  let context = parsed.data.context || null;
  const messages = [{ role: 'system', content: buildSystemPrompt({ timeZone, context }) }, ...parsed.data.messages.slice(-10)];
  const state = { modelIndex: 0 };
  try {
    for (let round = 0; round < 4; round++) {
      const answer = await groq(messages, CF_ASSISTANT_TOOLS, state);
      if (!answer) throw new Error('Groq no devolvió respuesta');
      // Groq rechaza campos extra (reasoning, etc.) al reenviar el turno del asistente.
      messages.push({ role: 'assistant', content: answer.content || '', ...(answer.tool_calls?.length ? { tool_calls: answer.tool_calls } : {}) });
      if (!answer.tool_calls?.length) return Response.json({ answer: answer.content || 'No encontré información para responder.', context });
      for (const call of answer.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const result = await executeAssistantTool(call.function?.name, args, { paidAccess, timeZone });
        // La última búsqueda de recomendaciones pasa a ser el contexto del hilo.
        if (call.function?.name === 'search_recommendations' && result?.filter) {
          const { date, sport, team, minProbability, marketNameLike, timing } = result.filter;
          context = { date, sport, team, minProbability, marketNameLike, timing };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: toolContent(result) });
      }
    }
    return Response.json({ answer: 'No pude completar la consulta con los datos disponibles.', context });
  } catch (error) {
    console.error('[assistant/chat]', error.message);
    return Response.json({ error: 'El asistente no está disponible temporalmente.' }, { status: 502 });
  }
}
