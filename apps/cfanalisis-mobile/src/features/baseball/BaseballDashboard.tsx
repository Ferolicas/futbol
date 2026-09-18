import { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { ArrowRight, Layers } from 'lucide-react-native';
import { AppText, Banner, EmptyState, SkeletonList } from '@/components/ui';
import { DateStrip } from '@/components/dashboard/DateStrip';
import { StatusDock, type StatusFilter } from '@/components/dashboard/StatusDock';
import { LeaguePicker, SportPicker } from '@/components/dashboard/Pickers';
import { DailyPickRail, type DecoratedSelection } from '@/components/dashboard/DailyPickRail';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { MatchFullscreen } from '@/components/dashboard/MatchFullscreen';
import { CombinationPanel } from '@/components/dashboard/CombinationPanel';
import { SportGameCard, baseballLiveLabel, toHeadMatch } from '@/components/dashboard/SportGameCard';
import { SportAnalysisTabs } from '@/components/analysis/SportAnalysisTabs';
import type { SportKey } from '@/components/dashboard/SportIcons';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { cap } from '@/lib/format';
import { todayInTz } from '@/lib/timezone';
import { effectiveGameStatus, useBaseballDashboard } from './useBaseballDashboard';
import { colors, radius } from '@/theme/tokens';

interface Props { date: string; userTz: string; onDateChange: (date: string) => void; activeSport: SportKey; onSportChange: (sport: SportKey) => void }

export function BaseballDashboard({ date, userTz, onDateChange, activeSport, onSportChange }: Props) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [leagueFilter, setLeagueFilter] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [selectedMarkets, setSelectedMarkets] = useState<Record<string, Record<string, any>>>({});
  const dash = useBaseballDashboard({ date, userTz, statusFilter, leagueFilter, selectedMarkets });
  const totalSel = Object.values(selectedMarkets).reduce((sum, m) => sum + Object.keys(m).length, 0);

  const changeDate = (next: string) => { if (next === date) return; setSelectedMarkets({}); setExpanded(null); onDateChange(next); };

  const toggleMarket = useCallback((fixtureId: number, pick: any) => {
    const marketData = { ...pick, key: pick.id, cat: pick.marketLabel || pick.category, label: pick.name, probability: cap(pick.probability), rawProbability: Number(pick.rawProbability ?? pick.probability), odd: Number(pick.odd) };
    setSelectedMarkets((prev) => {
      const next = { ...prev };
      if (prev[fixtureId]?.[pick.id]) delete next[fixtureId]; else next[fixtureId] = { [pick.id]: marketData };
      return next;
    });
  }, []);

  const decorated = useMemo<DecoratedSelection[]>(() => {
    const byId = new Map(dash.games.map((g) => [String(g.id), g]));
    return (dash.apuestaDelDia?.selections || []).map((selection: any) => {
      if (selection.resultState && selection.outcome) return selection;
      const game = byId.get(String(selection.fixtureId));
      return { ...selection, resultState: marketResultState({ sport: 'baseball', game }), outcome: settleMarketSelection({ sport: 'baseball', selection, game }) };
    });
  }, [dash.apuestaDelDia, dash.games]);

  const currentGame = (game: any) => {
    const finished = ['FT', 'AOT'].includes(game.status?.short);
    const live = game.liveResult;
    return { ...game, status: { ...game.status, short: effectiveGameStatus(game) }, scores: {
      home: { total: finished ? game.scores?.home?.total ?? live?.home_score : live?.home_score ?? game.scores?.home?.total },
      away: { total: finished ? game.scores?.away?.total ?? live?.away_score : live?.away_score ?? game.scores?.away?.total },
    } };
  };

  const expandedGame = expanded != null ? dash.visible.find((g) => g.id === expanded) : null;
  const analyzedIds = useMemo(() => dash.visible.filter((g) => g.analysis).map((g) => g.id), [dash.visible]);
  const stepExpanded = (direction: 1 | -1) => setExpanded((current) => {
    if (current == null) return current;
    const index = analyzedIds.indexOf(current);
    return index < 0 ? current : (analyzedIds[index + direction] ?? current);
  });

  const today = todayInTz(userTz);
  const groups = useMemo(() => {
    const rows: any[] = [];
    let previous: string | null = null;
    for (const g of dash.visible) {
      const key = String(g.league?.id || 0);
      if (key !== previous) { rows.push({ type: 'league', key: `league-${key}`, league: g.league, country: g.country?.name, count: dash.visible.filter((x) => String(x.league?.id || 0) === key).length }); previous = key; }
      rows.push({ type: 'game', key: `game-${g.id}`, game: g });
    }
    return rows;
  }, [dash.visible]);

  const header = (
    <View style={{ gap: 12, paddingBottom: 12 }}>
      <DateStrip today={today} value={date} onChange={changeDate} />
      <View style={styles.filters}>
        <LeaguePicker leagues={dash.leagues} value={leagueFilter} onChange={setLeagueFilter} />
        <SportPicker value={activeSport} onChange={onSportChange} />
      </View>
      {statusFilter !== 'favoritos' && <DailyPickRail selections={decorated} averageProbability={dash.apuestaDelDia?.combinedProbability || 0} sport="baseball" />}
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {dash.error ? <Banner tone="error" message={dash.error} onClose={() => dash.setError('')} /> : null}
        {!dash.loading && statusFilter === 'favoritos' && (
          <CombinationPanel
            combination={dash.customCombinada?.selections?.length ? dash.customCombinada : null}
            totalSelections={totalSel}
            onRemove={(fixtureId, sel) => setSelectedMarkets((prev) => { const next = { ...prev }; delete next[String(fixtureId)]; return next; })}
            onClear={() => setSelectedMarkets({})}
            bookmakerPrefix="Bet365 · "
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
          data={groups}
          keyExtractor={(item: any) => item.key}
          getItemType={(item: any) => item.type}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: 120 }}
          ListEmptyComponent={<View style={{ paddingHorizontal: 16 }}><EmptyState title={statusFilter === 'favoritos' ? 'Sin favoritos para esta fecha' : 'Sin partidos'} description={statusFilter === 'favoritos' ? 'Marca la estrella de un partido para guardarlo aquí junto a tu combinada.' : 'No hay partidos de béisbol para esta fecha y filtro.'} /></View>}
          renderItem={({ item }: { item: any }) => item.type === 'league' ? (
            <View style={styles.leagueHead}>
              <AppText variant="label" tone="secondary">{item.country ? `${item.country} · ` : ''}<AppText variant="label" tone="accent">{item.league?.name}</AppText></AppText>
              <AppText variant="caption" tone="muted">{item.count} {item.count === 1 ? 'partido' : 'partidos'}</AppText>
            </View>
          ) : (
            <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
              <SportGameCard
                game={currentGame(item.game)}
                sport="baseball"
                timeZone={userTz}
                favorite={dash.favorites.includes(item.game.id)}
                onFavorite={(id) => dash.toggleFavorite(Number(id))}
                onDismiss={dash.dismissMatch}
                onOpen={() => setExpanded(item.game.id)}
                liveLabel={baseballLiveLabel(item.game)}
                selectedCount={Object.keys(selectedMarkets[String(item.game.id)] || {}).length}
              />
            </View>
          )}
        />
      )}

      {statusFilter !== 'favoritos' && totalSel > 0 && (
        <Pressable onPress={() => { setExpanded(null); setStatusFilter('favoritos'); }} style={styles.floatBar}>
          <View style={styles.floatIcon}><Layers size={18} color={colors.accent} /></View>
          <View style={{ flex: 1 }}><AppText variant="caption" tone="muted">Tu selección</AppText><AppText variant="label" weight="bold">Mi combinada · {totalSel}</AppText></View>
          <ArrowRight size={18} color={colors.text} />
        </Pressable>
      )}

      <StatusDock value={statusFilter} onChange={setStatusFilter} counts={dash.counts} isToday={date === today} onToday={() => changeDate(today)} />

      {expandedGame && (() => {
        const game = currentGame(expandedGame);
        const match = toHeadMatch(game);
        return (
          <MatchFullscreen
            visible
            title="Partido de béisbol"
            head={<MatchHeadCard match={match} userTz={userTz} sport="baseball" isFavorite={dash.favorites.includes(game.id)} onFavorite={() => dash.toggleFavorite(game.id)} liveLabel={baseballLiveLabel(game)} />}
            body={game.analysis
              ? <SportAnalysisTabs game={game} sport="baseball" scoreLabel="carreras" selected={selectedMarkets[String(game.id)] || {}} onToggle={(pick) => toggleMarket(game.id, pick)} onViewFull={() => { setExpanded(null); router.push({ pathname: '/match/[sport]/[id]', params: { sport: 'baseball', id: String(game.id) } }); }} />
              : <AppText tone="muted">El análisis se está preparando automáticamente.</AppText>}
            onClose={() => setExpanded(null)}
            onStep={stepExpanded}
          />
        );
      })()}
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  leagueHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingBottom: 8, paddingTop: 4 },
  floatBar: { position: 'absolute', left: 16, right: 16, bottom: 92, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.lg, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.accentBorder, elevation: 8 },
  floatIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
