import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Image } from 'expo-image';
import { Flag, Star, X } from 'lucide-react-native';
import { AppText, TeamLogo } from '@/components/ui';
import { BaseballResultStats, BasketballResultStats } from '@/components/analysis/SportAnalysisTabs';
import { FLAGS } from '@/shared/leagues';
import { assetUrl } from '@/lib/config';
import { FOOTBALL_STATUS_LABEL, eventPersonName, isAwaitingOfficialResult, isCoveredCounter, isFinished, isLive } from '@/lib/format';
import { fmtShortDate, fmtTimeInTz } from '@/lib/timezone';
import { colors, radius } from '@/theme/tokens';

interface Props {
  match: any;
  odds?: { home?: number; draw?: number; away?: number } | null;
  data?: any;
  standings?: Record<string, number> | null;
  liveStats?: any;
  userTz: string;
  isFavorite?: boolean;
  onFavorite?: ((fixtureId: number) => void) | null;
  onDismiss?: ((fixtureId: number) => void) | null;
  sport?: string;
  /** Texto en vivo alternativo (p.ej. entrada de béisbol o cuarto). */
  liveLabel?: string | null;
}

function MatchTimer({ status }: { status: any }) {
  if (status.short === 'HT') return <AppText variant="kicker" size={10} tone="white">Descanso</AppText>;
  if (status.short === 'BT') return <AppText variant="kicker" size={10} tone="white">Descanso ET</AppText>;
  if (status.short === 'P') return <AppText variant="kicker" size={10} tone="white">Penales</AppText>;
  const base = Number(status.elapsed) || 0;
  const add = Number(status.extra) || 0;
  const half = status.short === '1H' ? '1T' : status.short === '2H' ? '2T' : status.short === 'ET' ? 'TE' : null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {half && <AppText variant="kicker" size={9} tone="white" style={styles.halfTag}>{half}</AppText>}
      <AppText variant="mono" size={12} tone="white" weight="bold">{base + add}&apos;</AppText>
    </View>
  );
}

function PlayerFace({ id }: { id?: number | string | null }) {
  const uri = id ? assetUrl(`/api/player-photo/${id}`) : null;
  if (!uri) return <View style={styles.facePlaceholder} />;
  return <Image source={{ uri }} style={styles.face} contentFit="cover" cachePolicy="disk" />;
}

function ScorerLine({ item, side, missed }: { item: any; side: 'home' | 'away'; missed?: boolean }) {
  const suffix = item.type === 'Penalty' ? ' (P)' : item.type === 'Own Goal' ? ' (AG)' : '';
  const minute = `${missed ? '✗ ' : ''}${item.minute}${item.extra ? `+${item.extra}` : ''}'`;
  return (
    <View style={[styles.scorer, side === 'away' && { flexDirection: 'row-reverse' }]}>
      <PlayerFace id={item.playerId} />
      <AppText variant="caption" numberOfLines={1} style={{ color: missed ? '#fb923c' : side === 'home' ? '#6ee7b7' : colors.text, flexShrink: 1 }}>
        <AppText variant="mono" size={10.5} tone="cyan">{minute}</AppText> {eventPersonName(item.player)}{suffix}
      </AppText>
    </View>
  );
}

/** Tarjeta de cabecera de fútbol: liga, escudos, posición, marcador/hora, córners y tarjetas. */
export const MatchHeadCard = memo(function MatchHeadCard({ match, odds, data, standings, liveStats, userTz, isFavorite, onFavorite, onDismiss, sport = 'football', liveLabel = null }: Props) {
  const status = match.fixture.status || { short: 'NS' };
  const live = isLive(status.short);
  const finished = isFinished(status.short);
  const hasScore = live || finished;
  const awaiting = isAwaitingOfficialResult(match);
  const flag = (FLAGS as Record<string, string>)[String((match.leagueMeta || {}).country || '')] || '';
  const homePos = data?.homePosition || standings?.[match.teams.home.id];
  const awayPos = data?.awayPosition || standings?.[match.teams.away.id];
  const label = awaiting ? 'PENDIENTE' : (FOOTBALL_STATUS_LABEL[status.short] || status.short);
  const goals = liveStats?.goals || match.goals || {};
  const homeGoals = liveStats?.goalScorers?.filter((g: any) => g.teamId === match.teams.home.id) || [];
  const awayGoals = liveStats?.goalScorers?.filter((g: any) => g.teamId !== match.teams.home.id) || [];
  const homeMissed = liveStats?.missedPenalties?.filter((p: any) => p.teamId === match.teams.home.id) || [];
  const awayMissed = liveStats?.missedPenalties?.filter((p: any) => p.teamId !== match.teams.home.id) || [];
  const cornersCovered = isCoveredCounter(liveStats?.corners);
  const yellowCovered = isCoveredCounter(liveStats?.yellowCards);
  const redCovered = isCoveredCounter(liveStats?.redCards);

  return (
    <View style={[styles.card, live && styles.cardLive]}>
      <View style={styles.leagueRow}>
        {match.league?.logo ? <TeamLogo src={match.league.logo} name={match.league.name} size={18} /> : <AppText size={13}>{flag}</AppText>}
        <AppText variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>{match.league?.name}</AppText>
        <AppText variant="caption" tone="muted">{fmtShortDate(match.fixture.date, userTz)}</AppText>
        {onFavorite && (
          <Pressable onPress={() => onFavorite(match.fixture.id)} hitSlop={8} accessibilityLabel={isFavorite ? 'Quitar de favoritos' : 'Agregar a favoritos'}>
            <Star size={17} color={isFavorite ? colors.warning : colors.muted} fill={isFavorite ? colors.warning : 'transparent'} />
          </Pressable>
        )}
        {onDismiss && (
          <Pressable onPress={() => onDismiss(match.fixture.id)} hitSlop={8} accessibilityLabel="Descartar partido">
            <X size={16} color={colors.muted} />
          </Pressable>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.team}>
          <TeamLogo src={match.teams.home.logo} name={match.teams.home.name} size={40} />
          <AppText variant="label" weight="bold" align="center" numberOfLines={3} size={12.5}>{match.teams.home.name}</AppText>
          {(homePos != null || odds?.home != null) && (
            <View style={styles.meta}>
              {homePos != null && <AppText variant="caption" tone="muted">{homePos}°</AppText>}
              {odds?.home != null && <AppText variant="mono" size={11} tone="accent">{Number(odds.home).toFixed(2)}</AppText>}
            </View>
          )}
        </View>

        <View style={styles.center}>
          {live ? (
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              {liveLabel ? <AppText variant="kicker" size={9.5} tone="white">{liveLabel}</AppText> : (
                <>
                  {(status.short !== 'HT' && status.short !== 'BT') && <AppText variant="kicker" size={9.5} tone="white">En vivo</AppText>}
                  {status.elapsed > 0 && <MatchTimer status={status} />}
                </>
              )}
            </View>
          ) : (
            <AppText variant="kicker" size={9.5} tone={finished ? 'muted' : 'accent'}>{label}</AppText>
          )}
          {hasScore ? (
            <View style={styles.score}>
              <AppText variant="mono" weight="bold" size={30}>{goals.home ?? 0}</AppText>
              <AppText variant="mono" size={20} tone="faint">–</AppText>
              <AppText variant="mono" weight="bold" size={30}>{goals.away ?? 0}</AppText>
            </View>
          ) : awaiting ? (
            <AppText variant="caption" tone="warning" align="center">Esperando marcador oficial</AppText>
          ) : (
            <AppText variant="mono" weight="bold" size={22} tone="accent">{fmtTimeInTz(match.fixture.date, userTz)}</AppText>
          )}
        </View>

        <View style={styles.team}>
          <TeamLogo src={match.teams.away.logo} name={match.teams.away.name} size={40} />
          <AppText variant="label" weight="bold" align="center" numberOfLines={3} size={12.5}>{match.teams.away.name}</AppText>
          {(awayPos != null || odds?.away != null) && (
            <View style={styles.meta}>
              {awayPos != null && <AppText variant="caption" tone="muted">{awayPos}°</AppText>}
              {odds?.away != null && <AppText variant="mono" size={11} tone="accent">{Number(odds.away).toFixed(2)}</AppText>}
            </View>
          )}
        </View>
      </View>

      {sport === 'football' && (hasScore || odds?.draw != null) && (
        <View style={styles.statsRow}>
          <View style={[styles.statChip, !cornersCovered && styles.statUnavailable]}>
            <Flag size={11} color={colors.muted} />
            <AppText variant="caption" tone="muted">Córners</AppText>
            <AppText variant="mono" size={12}>{cornersCovered ? `${liveStats.corners.home}-${liveStats.corners.away}` : '—'}</AppText>
          </View>
          {odds?.draw != null && (
            <View style={styles.statChip}>
              <AppText variant="caption" tone="muted">Empate</AppText>
              <AppText variant="mono" size={12} tone="accent">{Number(odds.draw).toFixed(2)}</AppText>
            </View>
          )}
          <View style={[styles.statChip, !(yellowCovered || redCovered) && styles.statUnavailable]}>
            <View style={styles.yellowCard} />
            <AppText variant="mono" size={12}>{yellowCovered ? `${liveStats.yellowCards.home}-${liveStats.yellowCards.away}` : '—'}</AppText>
            <View style={styles.redCard} />
            <AppText variant="mono" size={12}>{redCovered ? `${liveStats.redCards.home}-${liveStats.redCards.away}` : '—'}</AppText>
          </View>
        </View>
      )}

      {sport === 'baseball' && hasScore && liveStats && (
        <BaseballResultStats compact result={liveStats} homeName={match.teams.home.name} awayName={match.teams.away.name} />
      )}

      {sport === 'basketball' && hasScore && liveStats?.periods && (
        <BasketballResultStats periods={liveStats.periods} homeName={match.teams.home.name} awayName={match.teams.away.name} />
      )}

      {(homeGoals.length + awayGoals.length + homeMissed.length + awayMissed.length) > 0 && (
        <View style={styles.scorers}>
          <View style={{ flex: 1, gap: 3 }}>
            {homeGoals.map((g: any, i: number) => <ScorerLine key={`g${i}`} item={g} side="home" />)}
            {homeMissed.map((p: any, i: number) => <ScorerLine key={`m${i}`} item={p} side="home" missed />)}
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            {awayGoals.map((g: any, i: number) => <ScorerLine key={`g${i}`} item={g} side="away" />)}
            {awayMissed.map((p: any, i: number) => <ScorerLine key={`m${i}`} item={p} side="away" missed />)}
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { gap: 10, padding: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  cardLive: { borderColor: 'rgba(239,68,68,0.4)' },
  leagueRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  body: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  team: { flex: 1, alignItems: 'center', gap: 5 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  center: { width: 104, alignItems: 'center', gap: 6, paddingTop: 4 },
  score: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 3, paddingHorizontal: 8, borderRadius: radius.pill, backgroundColor: colors.live },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.white },
  halfTag: { paddingHorizontal: 4, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, justifyContent: 'center' },
  statChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 4, paddingHorizontal: 9, borderRadius: radius.pill, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: colors.border },
  statUnavailable: { opacity: 0.55 },
  yellowCard: { width: 8, height: 11, borderRadius: 2, backgroundColor: colors.warning },
  redCard: { width: 8, height: 11, borderRadius: 2, backgroundColor: colors.live },
  scorers: { flexDirection: 'row', gap: 12 },
  scorer: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  face: { width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.08)' },
  facePlaceholder: { width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.08)' },
});
