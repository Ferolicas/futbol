import { z } from 'zod';
import { getCurrentUser } from '../../../../lib/auth-pg';
import { userHasActivePlan } from '../../../../lib/require-active-plan';
import { redisRateLimit } from '../../../../lib/ratelimit-redis';
import { CF_ASSISTANT_TOOLS, executeAssistantTool } from '../../../../lib/cf-assistant';

export const dynamic = 'force-dynamic';

const schema = z.object({
  messages: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string().min(1).max(3000) })).min(1).max(16),
});

const SYSTEM = `Eres el asistente de CF Análisis. Responde en español claro usando exclusivamente datos devueltos por tus herramientas de solo lectura. Nunca inventes partidos, cuotas, probabilidades ni pronósticos. No calcules pronósticos nuevos, no modifiques el motor y no presentes una apuesta como segura. Si no existe información, dilo. Respeta el nivel de acceso devuelto por la herramienta. Las probabilidades son estimaciones, no garantías.

Si te preguntan algo que no está entre las recomendaciones de get_existing_prediction (ej. "cuántos goles habrá", una línea o mercado puntual), usa get_calculated_frequency antes de decir que no existe: trae TODOS los mercados calculados. Cada uno viene con type="recomendacion" o type="dato_estadistico" — un "dato_estadistico" es frecuencia histórica calculada, NUNCA la presentes como recomendación de apuesta; acláralo explícitamente ("no es una recomendación, es un dato estadístico calculado").

Cuando una respuesta se apoye en el pronóstico o la frecuencia de un partido concreto y la herramienta te devuelva matchUrl, ofrecé el enlace al análisis completo como markdown: [Ver análisis completo](matchUrl). No lo repitas si ya lo diste en la respuesta anterior de la misma conversación.

Si te piden hacer algo que existe como función del dashboard (por ejemplo cambiar la contraseña) pero vos no podés ejecutarla, usa get_app_action_link para dar el enlace real como markdown — ej. [Cambiar contraseña](url) — en vez de simplemente decir que no podés. Nunca inventes una URL que no venga de una herramienta.`;

async function groq(messages, tools) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.GROQ_MODEL || 'openai/gpt-oss-20b', messages, tools, tool_choice: 'auto', temperature: 0.1, max_completion_tokens: 900 }),
    signal: AbortSignal.timeout(25_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Groq ${response.status}: ${body.error?.message || 'error de servicio'}`);
  return body.choices?.[0]?.message;
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
  const messages = [{ role: 'system', content: SYSTEM }, ...parsed.data.messages];
  try {
    for (let round = 0; round < 4; round++) {
      const answer = await groq(messages, CF_ASSISTANT_TOOLS);
      if (!answer) throw new Error('Groq no devolvió respuesta');
      messages.push(answer);
      if (!answer.tool_calls?.length) return Response.json({ answer: answer.content || 'No encontré información para responder.' });
      for (const call of answer.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const result = await executeAssistantTool(call.function?.name, args, { paidAccess });
        messages.push({ role: 'tool', tool_call_id: call.id, name: call.function?.name, content: JSON.stringify(result) });
      }
    }
    return Response.json({ answer: 'No pude completar la consulta con los datos disponibles.' });
  } catch (error) {
    console.error('[assistant/chat]', error.message);
    return Response.json({ error: 'El asistente no está disponible temporalmente.' }, { status: 502 });
  }
}
