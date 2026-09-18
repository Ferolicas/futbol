import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { ArrowRight, Layers, RefreshCw } from 'lucide-react-native';
import { AppText, Banner, Button, EmptyState, SkeletonList } from '@/components/ui';
import { DateStrip } from '@/components/dashboard/DateStrip';
import { StatusDock, type StatusFilter } from '@/components/dashboard/StatusDock';
import { LeaguePicker, SportPicker } from '@/components/dashboard/Pickers';
import { DailyPickRail, type DecoratedSelection } from '@/components/dashboard/DailyPickRail';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { MatchFullscreen } from '@/components/dashboard/MatchFullscreen';
import { CombinationPanel } from '@/components/dashboard/CombinationPanel';
import { SportGameCard, toHeadMatch } from '@/components/dashboard/SportGameCard';
import { SportAnalysisTabs } from '@/components/analysis/SportAnalysisTabs';
import type { SportKey } from '@/components/dashboard/SportIcons';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { cap, oddValue } from '@/lib/format';
import { todayInTz } from '@/lib/timezone';
import { useMultisportDashboard } from './useMultisportDashboard';
import { colors, radius } from '@/theme/tokens';

interface Props { sport: 'basketball' | 'american_football'; slug: string; title: string; scoreLabel: string; date: string; userTz: string; onDateChange: (date: string) => void; activeSport: SportKey; onSportChange: (sport: SportKey) => void }

export function MultisportDashboard({ sport, slug, title, scoreLabel, date, userTz, onDateChange, activeSport, onSportChange }: Props) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [expanded, setExpanded] = useState<string | number | null>(null);
  const [selectedMarkets, setSelectedMarkets] = useState<Record<string, Record<string, any>>>({});
  const dash = useMultisportDashboard({ sport, slug, date, userTz, statusFilter, leagueFilter, selectedMarkets });
  const totalSel = dash.combination?.selections.length || 0;

  const changeDate = (next: string) => { if (next === date) return; setSelectedMarkets({}); setExpanded(null); onDateChange(next); };

  const togglePick = useCallback((game: any, pick: any) => {
    setSelectedMarkets((previous) => {
      const fixtureId = String(game.id);
      const already = !!previous[fixtureId]?.[pick.id];
      const next = { ...previous };
      if (already) delete next[fixtureId];
      else next[fixtureId] = { [pick.id]: { ...pick, probability: cap(pick.probability), odd: oddValue(pick.odd), matchName: `${game.teams.home.name} vs ${game.teams.away.name}` } };
      return next;
    });
  }, []);

  const decorated = useMemo<DecoratedSelection[]>(() => {
    const byId = new Map(dash.games.map((g) => [String(g.id), g]));
    return (dash.apuestaDelDia?.selections || []).map((selection: any) => {
      if (selection.resultState && selection.outcome) return selection;
      const game = byId.get(String(selection.fixtureId));
      return { ...selection, resultState: marketResultState({ sport: slug, game }), outcome: settleMarketSelection({ sport: slug, selection, game }) };
    });
  }, [dash.apuestaDelDia, dash.games, slug]);

  const rows = useMemo(() => {
    const output: any[] = [];
    let previous: string | null = null;
    for (const game of dash.visible) {
      const leagueId = String(game.league?.id || game.league?.name || 'competition');
      if (leagueId !== previous) { output.push({ type: 'league', key: `league-${leagueId}`, league: game.league, count: dash.visible.filter((g) => String(g.league?.id || g.league?.name || 'competition') === leagueId).length }); previous = leagueId; }
      output.push({ type: 'game', key: `game-${game.id}`, game });
    }
    return output;
  }, [dash.visible]);

  const expandedGame = expanded != null ? dash.visible.find((g) => String(g.id) === String(expanded)) : null;
  const analyzedIds = useMemo(() => dash.visible.filter((g) => g.analysis).map((g) => String(g.id)), [dash.visible]);
  const stepExpanded = (direction: 1 | -1) => setExpanded((current) => {
    if (current == null) return current;
    const index = analyzedIds.indexOf(String(current));
    return index < 0 ? current : (analyzedIds[index + direction] ?? current);
  });

  const today = todayInTz(userTz);
  const header = (
    <View style={{ gap: 12, paddingBottom: 12 }}>
      <DateStrip today={today} value={date} onChange={changeDate} />
      <View style={styles.filters}>
        <LeaguePicker leagues={dash.leagues} value={leagueFilter} onChange={setLeagueFilter} />
        <SportPicker value={activeSport} onChange={onSportChange} />
      </View>
      {statusFilter !== 'favoritos' && <DailyPickRail selections={decorated} averageProbability={dash.apuestaDelDia?.combinedProbability || 0} sport={slug} />}
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {dash.message ? <Banner tone="info" message={dash.message} /> : null}
        {dash.error && dash.games.length > 0 ? <Banner tone="warning" message={dash.error} /> : null}
        {!dash.loading && statusFilter === 'favoritos' && (
          <CombinationPanel
            combination={dash.combination}
            totalSelections={totalSel}
            onRemove={(fixtureId) => setSelectedMarkets((prev) => { const next = { ...prev }; delete next[String(fixtureId)]; return next; })}
            onClear={() => setSelectedMarkets({})}
          />
        )}
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {dash.loading ? (
        <View style={{ flex: 1 }}>{header}<View style={{ paddingHorizontal: 16 }}><SkeletonList count={4} height={150} /></View></View>
      ) : (
        <FlashList
          data={rows}
          keyExtractor={(item: any) => item.key}
          getItemType={(item: any) => item.type}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 120 }}
          ListEmptyComponent={(
            <View style={{ paddingHorizontal: 16 }}>
              {dash.error && !dash.games.length
                ? <EmptyState title="No se pudo cargar la jornada" description="Comprueba tu conexión e inténtalo de nuevo." actionLabel="Reintentar" onAction={dash.refresh} />
                : <EmptyState title={statusFilter === 'favoritos' ? 'Sin favoritos para esta fecha' : 'Sin partidos'} description={statusFilter === 'favoritos' ? 'Marca la estrella de un partido para guardarlo aquí junto a tu combinada.' : `No hay partidos de ${title} para esta fecha y filtro.`} />}
            </View>
          )}
          ListFooterComponent={statusFilter !== 'favoritos' && dash.pendingGames > 0 && dash.games.length > 0 ? (
            <View style={styles.pendingRow}>
              <AppText variant="caption" tone="muted" style={{ flex: 1 }}>{dash.pendingGames} {dash.pendingGames === 1 ? 'partido pendiente' : 'partidos pendientes'} de análisis</AppText>
              <Button title={dash.enqueueing ? 'Preparando…' : 'Preparar jornada'} size="sm" variant="secondary" onPress={dash.requestAnalysis} disabled={dash.enqueueing} icon={<RefreshCw size={14} color={colors.accent} />} />
            </View>
          ) : null}
          renderItem={({ item }: { item: any }) => item.type === 'league' ? (
            <View style={styles.leagueHead}>
              <AppText variant="label" tone="accent">{item.league?.name || title}</AppText>
              <AppText variant="caption" tone="muted">{item.count} {item.count === 1 ? 'partido' : 'partidos'}</AppText>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
              <SportGameCard
                game={item.game}
                sport={slug}
                timeZone={userTz}
                favorite={dash.favorites.includes(String(item.game.id))}
                onFavorite={dash.toggleFavorite}
                onOpen={() => setExpanded(item.game.id)}
                liveLabel={item.game.status?.long || null}
                selectedCount={Object.keys(selectedMarkets[String(item.game.id)] || {}).length}
              />
            </View>
          )}
        />
      )}

      {statusFilter !== 'favoritos' && totalSel > 0 && (
        <Pressable onPress={() => { setExpanded(null); setStatusFilter('favoritos'); }} style={styles.floatBar}>
          <View style={styles.floatIcon}><Layers size={18} color={colors.accent} /></View>
          <View style={{ flex: 1 }}><AppText variant="caption" tone="muted">Tu selección</AppText><AppText variant="label" weight="bold">Ver combinada · {totalSel}</AppText></View>
          {dash.combination && <AppText variant="mono" style={{ color: colors.amber }}>{dash.combination.combinedOdd.toFixed(2)}x</AppText>}
          <ArrowRight size={18} color={colors.text} />
        </Pressable>
      )}

      <StatusDock value={statusFilter} onChange={setStatusFilter} counts={dash.counts} isToday={date === today} onToday={() => changeDate(today)} />

      {expandedGame && (
        <MatchFullscreen
          visible
          title={title}
          head={<MatchHeadCard match={toHeadMatch(expandedGame)} userTz={userTz} sport={slug} isFavorite={dash.favorites.includes(String(expandedGame.id))} onFavorite={() => dash.toggleFavorite(expandedGame.id)} liveLabel={expandedGame.status?.long || null} />}
          body={expandedGame.analysis
            ? <SportAnalysisTabs game={expandedGame} sport={slug} scoreLabel={scoreLabel} selected={selectedMarkets[String(expandedGame.id)] || {}} onToggle={(pick) => togglePick(expandedGame, pick)} onViewFull={() => { setExpanded(null); router.push({ pathname: '/match/[sport]/[id]', params: { sport, id: String(expandedGame.id) } }); }} />
            : <AppText tone="muted">El análisis se está preparando automáticamente.</AppText>}
          onClose={() => setExpanded(null)}
          onStep={stepExpanded}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  leagueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, paddingTop: 4 },
  pendingRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginHorizontal: 16, padding: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.03)' },
  floatBar: { position: 'absolute', left: 16, right: 16, bottom: 92, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.lg, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.accentBorder, elevation: 8 },
  floatIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
