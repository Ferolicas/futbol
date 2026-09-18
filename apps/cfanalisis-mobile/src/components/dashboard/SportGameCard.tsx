import { memo, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { MatchHeadCard } from './MatchHeadCard';
import { isMultisportFinal, isMultisportLive } from '@/lib/format';
import { colors } from '@/theme/tokens';

/** Convierte un juego de béisbol/baloncesto/NFL a la forma de cabecera compartida con fútbol. */
export function toHeadMatch(game: any) {
  const rawStatus = game.status?.short || 'NS';
  const finished = isMultisportFinal(rawStatus);
  const live = !finished && isMultisportLive(rawStatus);
  const status = { ...game.status, short: finished ? 'FT' : live ? '1H' : rawStatus, elapsed: 0 };
  return {
    fixture: { id: game.id, date: game.date, status },
    league: game.league || {},
    teams: game.teams,
    goals: { home: game.scores?.home?.total ?? game.liveResult?.home_score, away: game.scores?.away?.total ?? game.liveResult?.away_score },
    leagueMeta: { country: game.country?.name },
  };
}

export function baseballLiveLabel(game: any): string | null {
  const live = game.liveResult;
  if (!live) return null;
  const arrow = live.inning_half === 'top' ? '↑' : live.inning_half === 'bottom' ? '↓' : '';
  const inning = live.inning ?? game.status?.inning ?? '';
  return `${arrow}${inning}`.trim() || 'En vivo';
}

interface Props {
  game: any;
  sport: string;
  timeZone: string;
  favorite: boolean;
  onFavorite: (id: number | string) => void;
  onDismiss?: ((id: number) => void) | null;
  onOpen: () => void;
  liveLabel?: string | null;
  selectedCount?: number;
}

/** Tarjeta plegada de béisbol, baloncesto y fútbol americano. */
export const SportGameCard = memo(function SportGameCard({ game, sport, timeZone, favorite, onFavorite, onDismiss, onOpen, liveLabel, selectedCount = 0 }: Props) {
  const match = useMemo(() => toHeadMatch(game), [game]);
  const analyzed = !!game.analysis;
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.wrap, pressed && { opacity: 0.9 }]}>
      <MatchHeadCard match={match} userTz={timeZone} sport={sport} isFavorite={favorite} onFavorite={() => onFavorite(game.id)} onDismiss={onDismiss} liveLabel={liveLabel} />
      <View style={styles.foot}>
        <AppText variant="kicker" size={9.5} tone={analyzed ? 'accent' : 'muted'}>{analyzed ? '✓ Analizado' : (game.analysisPending ? 'Análisis en preparación' : 'Sin análisis')}</AppText>
        {selectedCount > 0 && <AppText variant="caption" tone="accent">{selectedCount} sel.</AppText>}
        <ChevronDown size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  wrap: { gap: 4 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 2 },
});
