import { createClient } from '@sanity/client';

const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID,
  dataset: process.env.SANITY_DATASET || 'production',
  apiVersion: '2024-07-11',
  token: process.env.SANITY_API_TOKEN,
  useCdn: false,
});

// --- READ ---
export async function getFromSanity(type, id) {
  const docId = `${type}-${id}`;
  try {
    const doc = await client.getDocument(docId);
    return doc || null;
  } catch {
    return null;
  }
}

export async function queryFromSanity(query, params = {}) {
  try {
    return await client.fetch(query, params);
  } catch {
    return null;
  }
}

// --- WRITE ---
export async function saveToSanity(type, id, data) {
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

// --- DELETE ---
export async function deleteFromSanity(type, id) {
  const docId = `${type}-${id}`;
  try {
    await client.delete(docId);
    return true;
  } catch {
    return false;
  }
}

export default client;
