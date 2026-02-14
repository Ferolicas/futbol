import { createClient } from '@sanity/client';

const projectId = process.env.NEXT_PUBLIC_SANITY_PROJECT_ID;
const token = process.env.SANITY_API_TOKEN;
const dataset = process.env.SANITY_DATASET || 'production';

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
  if (!client) return null;
  const docId = `${type}-${id}`;
  try {
    const doc = await client.getDocument(docId);
    return doc || null;
  } catch {
    return null;
  }
}

export async function queryFromSanity(query, params = {}) {
  if (!client) return null;
  try {
    return await client.fetch(query, params);
  } catch {
    return null;
  }
}

export async function saveToSanity(type, id, data) {
  if (!client || !token) return false;
  const docId = `${type}-${id}`;
  try {
    await client.createOrReplace({
      _id: docId,
      _type: type,
      ...data,
    });
    return true;
  } catch (e) {
    console.error('Sanity write error:', e.message);
    return false;
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
