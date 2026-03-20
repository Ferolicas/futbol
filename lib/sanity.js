import { createClient } from '@sanity/client';

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const token = process.env.SANITY_API_TOKEN;
const dataset = process.env.SANITY_DATASET || 'production';

// Read client — uses CDN for fast reads (30-80ms vs 200-500ms origin)
const readClient = projectId
  ? createClient({
      projectId,
      dataset,
      apiVersion: '2024-07-11',
      token,
      useCdn: true,
    })
  : null;

// Write client — always hits origin (mutations need fresh data)
const client = projectId
  ? createClient({
      projectId,
      dataset,
      apiVersion: '2024-07-11',
      token,
      useCdn: false,
    })
  : null;

export async function getFromSanity(type, id) {
  if (!readClient) return null;
  const docId = `${type}-${id}`;
  try {
    const doc = await readClient.getDocument(docId);
    return doc || null;
  } catch {
    return null;
  }
}

export async function queryFromSanity(query, params = {}) {
  if (!readClient) return null;
  try {
    return await readClient.fetch(query, params);
  } catch {
    return null;
  }
}

// Fresh read bypassing CDN — use only when you need post-write consistency
export async function getFromSanityFresh(type, id) {
  if (!client) return null;
  const docId = `${type}-${id}`;
  try {
    const doc = await client.getDocument(docId);
    return doc || null;
  } catch {
    return null;
  }
}

export async function saveToSanity(type, id, data) {
  if (!client || !token) return false;
  const docId = `${type}-${id}`;
  try {
    // Sanitize: remove Sanity internal fields and undefined values
    const sanitized = {};
    for (const [key, val] of Object.entries(data)) {
      if (key === '_rev' || key === '_createdAt' || key === '_updatedAt') continue;
      if (val === undefined) continue;
      sanitized[key] = val;
    }
    await client.createOrReplace({
      _id: docId,
      _type: type,
      ...sanitized,
    });
    return true;
  } catch (e) {
    console.error(`Sanity write error [${docId}]:`, e.message, e.statusCode || '', e.details?.description || '');
    throw e; // Propagate so callers know save failed
  }
}

export async function deleteFromSanity(type, id) {
  if (!client || !token) return false;
  const docId = `${type}-${id}`;
  try {
    await client.delete(docId);
    return true;
  } catch {
    return false;
  }
}

export default client;
