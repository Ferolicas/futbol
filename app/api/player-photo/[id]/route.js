// Sirve la foto de un jugador desde el almacén permanente (lib/player-photos):
// RAM → disco (sobrevive deploys, lo sirve Caddy) → api-sports (1 sola vez).
// El cron de alineaciones pre-calienta estas fotos a T-45min (warmPlayerPhotos)
// para que un gol en vivo muestre la foto al instante.

import { getPlayerPhoto } from '../../../../lib/player-photos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const IMMUTABLE = 'public, max-age=2592000, s-maxage=2592000, immutable';

export async function GET(_req, { params }) {
  const id = String(params?.id || '').replace(/[^0-9]/g, '');
  if (!id) return new Response(null, { status: 400 });

  const photo = await getPlayerPhoto(id);
  if (!photo) {
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'public, max-age=86400' } });
  }
  return new Response(photo.body, {
    status: 200,
    headers: { 'Content-Type': 'image/png', 'Cache-Control': IMMUTABLE },
  });
}
