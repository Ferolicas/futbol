import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { AppText } from '@/components/ui';
import { assetUrl } from '@/lib/config';

const ACCENTS = ['#00d4ff', '#ec4899'];
const PLAYER_W = 54;

/** Foto del jugador (/api/player-photo, mismo almacén que la web) con círculo de respaldo. */
export function PlayerFace({ id, size = 22, ring }: { id?: number | string | null; size?: number; ring?: string }) {
  const [failed, setFailed] = useState(false);
  const uri = id ? assetUrl(`/api/player-photo/${id}`) : null;
  const base = { width: size, height: size, borderRadius: size / 2 };
  if (!uri || failed) return <View style={[base, { backgroundColor: 'rgba(255,255,255,0.1)', borderWidth: 1, borderColor: ring || 'rgba(255,255,255,0.18)' }]} />;
  return (
    <Image
      source={{ uri }}
      style={[base, { backgroundColor: 'rgba(255,255,255,0.08)', borderWidth: ring ? 1.5 : 0, borderColor: ring }]}
      contentFit="cover"
      cachePolicy="disk"
      onError={() => setFailed(true)}
    />
  );
}

// Reparte los 11 en coordenadas % a partir de player.grid "fila:columna":
// local abajo (ataca arriba), visitante arriba espejado — igual que la web.
function place(team: any, isHome: boolean) {
  const rows: Record<number, Array<{ pl: any; c: number }>> = {};
  for (const pl of team.startXI) {
    const [r, c] = String(pl.player.grid).split(':').map(Number);
    (rows[r] = rows[r] || []).push({ pl, c });
  }
  const rowNums = Object.keys(rows).map(Number).sort((a, b) => a - b);
  const maxRow = rowNums[rowNums.length - 1];
  const nodes: Array<{ pl: any; x: number; y: number }> = [];
  for (const r of rowNums) {
    const inRow = rows[r].sort((a, b) => a.c - b.c);
    const depth = maxRow > 1 ? (r - 1) / (maxRow - 1) : 0;
    inRow.forEach((item, i) => {
      let x = ((i + 1) / (inRow.length + 1)) * 100;
      if (!isHome) x = 100 - x;
      nodes.push({ pl: item.pl, x, y: isHome ? 94 - depth * 42 : 6 + depth * 42 });
    });
  }
  return nodes;
}

/** Campo con la formación visual (tipo Sofascore). Null si falta el grid de algún titular. */
export function FormationPitch({ teams }: { teams: any[] }) {
  const [width, setWidth] = useState(0);
  if (!Array.isArray(teams) || teams.length < 2) return null;
  const hasGrid = teams.slice(0, 2).every((t) => (t.startXI || []).length > 0 && t.startXI.every((p: any) => p.player?.grid));
  if (!hasGrid) return null;
  const height = width * 1.5;
  return (
    <View style={styles.pitch} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
      {Array.from({ length: 12 }).map((_, i) => (
        <View key={i} style={[styles.stripe, { top: `${(i * 100) / 12}%`, backgroundColor: i % 2 ? 'transparent' : 'rgba(255,255,255,0.04)' }]} />
      ))}
      <View style={styles.lines} pointerEvents="none">
        <View style={styles.halfway} />
        <View style={[styles.circle, { width: width * 0.22, height: width * 0.22, marginLeft: -(width * 0.11), marginTop: -(width * 0.11) }]} />
        <View style={[styles.box, styles.boxTop]} />
        <View style={[styles.box, styles.boxBottom]} />
      </View>
      {width > 0 && teams.slice(0, 2).map((team, idx) => (
        <View key={idx} style={StyleSheet.absoluteFill} pointerEvents="none">
          <AppText variant="caption" weight="bold" numberOfLines={1} style={[styles.tag, idx === 0 ? { bottom: 7 } : { top: 7 }, { color: ACCENTS[idx] }]}>
            {team.team?.name} · {team.formation}
          </AppText>
          {place(team, idx === 0).map((node, i) => {
            const p = node.pl.player || {};
            const surname = (p.name || '').split(' ').slice(-1)[0] || p.name || '';
            return (
              <View key={i} style={[styles.player, { left: (node.x / 100) * width - PLAYER_W / 2, top: (node.y / 100) * height - 24 }]}>
                <View>
                  <PlayerFace id={p.id} size={32} ring={ACCENTS[idx]} />
                  <View style={[styles.num, { backgroundColor: ACCENTS[idx] }]}><AppText variant="mono" size={8.5} weight="bold" style={{ color: '#06121f' }}>{p.number}</AppText></View>
                </View>
                <AppText variant="caption" size={9} weight="bold" numberOfLines={1} style={styles.name}>{surname}</AppText>
              </View>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const LINE = 'rgba(255,255,255,0.22)';
const styles = StyleSheet.create({
  pitch: { width: '100%', aspectRatio: 2 / 3, borderRadius: 16, overflow: 'hidden', backgroundColor: '#0d4f31', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)' },
  stripe: { position: 'absolute', left: 0, right: 0, height: `${100 / 12}%` },
  lines: { position: 'absolute', top: 6, left: 6, right: 6, bottom: 6, borderWidth: 2, borderColor: LINE, borderRadius: 10 },
  halfway: { position: 'absolute', left: 0, right: 0, top: '50%', height: 2, backgroundColor: LINE },
  circle: { position: 'absolute', left: '50%', top: '50%', borderRadius: 999, borderWidth: 2, borderColor: LINE },
  box: { position: 'absolute', left: '27%', width: '46%', height: '13%', borderWidth: 2, borderColor: 'rgba(255,255,255,0.2)' },
  boxTop: { top: -2, borderTopWidth: 0, borderBottomLeftRadius: 8, borderBottomRightRadius: 8 },
  boxBottom: { bottom: -2, borderBottomWidth: 0, borderTopLeftRadius: 8, borderTopRightRadius: 8 },
  tag: { position: 'absolute', left: 8, maxWidth: '62%', textShadowColor: 'rgba(0,0,0,0.85)', textShadowRadius: 4 },
  player: { position: 'absolute', width: PLAYER_W, alignItems: 'center', gap: 2 },
  num: { position: 'absolute', right: -5, bottom: -3, minWidth: 15, height: 15, paddingHorizontal: 3, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  name: { color: '#fff', maxWidth: 56, textAlign: 'center', textShadowColor: 'rgba(0,0,0,0.9)', textShadowRadius: 3 },
});
