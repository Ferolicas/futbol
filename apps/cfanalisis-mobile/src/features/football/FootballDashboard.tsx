import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useRouter } from 'expo-router';
import { ArrowRight, ChevronDown, Layers } from 'lucide-react-native';
import { AppText, Banner, EmptyState, SkeletonList } from '@/components/ui';
import { DateStrip } from '@/components/dashboard/DateStrip';
import { StatusDock, type StatusFilter } from '@/components/dashboard/StatusDock';
import { LeagueMultiPicker, SportPicker } from '@/components/dashboard/Pickers';
import { DailyPickRail, type DecoratedSelection } from '@/components/dashboard/DailyPickRail';
import { MatchHeadCard } from '@/components/dashboard/MatchHeadCard';
import { MatchFullscreen } from '@/components/dashboard/MatchFullscreen';
import { CombinationPanel } from '@/components/dashboard/CombinationPanel';
import { DismissConfirmDialog, HiddenFixturesButton, HiddenFixturesPanel } from '@/components/dashboard/HiddenMatches';
import { FootballAnalysisTabs } from '@/components/analysis/FootballAnalysisTabs';
import type { SportKey } from '@/components/dashboard/SportIcons';
import { useFixtureLiveStats, useLiveStatsSnapshot } from '@/lib/realtime/fixture-store';
import { useSelectedMarkets } from '@/lib/selected-markets';
import { marketResultState, settleMarketSelection } from '@/shared/market-settlement';
import { todayInTz } from '@/lib/timezone';
import { useFootballDashboard } from './useFootballDashboard';
import { colors, radius } from '@/theme/tokens';

interface Props { date: string; userTz: string; onDateChange: (date: string) => void; activeSport: SportKey; onSportChange: (sport: SportKey) => void; onComboBarChange?: (visible: boolean) => void }

const FootballRow = memo(function FootballRow({ match, odds, data, standings, userTz, isFavorite, analyzed, selCount, onFavorite, onDismiss, onOpen }: any) {
  const liveStats = useFixtureLiveStats(match.fixture.id);
  return (
    <Pressable onPress={onOpen} style={({ pressed }) => [styles.row, pressed && { opacity: 0.9 }]}>
      <MatchHeadCard match={match} odds={odds} data={data} standings={standings} liveStats={liveStats} userTz={userTz} isFavorite={isFavorite} onFavorite={onFavorite} onDismiss={onDismiss} />
      <View style={styles.foot}>
        <AppText variant="kicker" size={9.5} tone={analyzed ? 'accent' : 'muted'}>{analyzed ? '✓ Analizado' : 'Sin análisis todavía'}</AppText>
        {selCount > 0 && <AppText variant="caption" tone="accent">{selCount} sel.</AppText>}
        <ChevronDown size={16} color={colors.muted} />
      </View>
    </Pressable>
  );
});

function ExpandedFootball({ match, data, odds, standings, userTz, isFavorite, onFavorite, onDismiss, onViewFull }: any) {
  const liveStats = useFixtureLiveStats(match.fixture.id);
  const { selectedMarkets, toggleMarket } = useSelectedMarkets();
  const selected = selectedMarkets[String(match.fixture.id)] || {};
  return {
    head: <MatchHeadCard match={match} odds={odds} data={data} standings={standings} liveStats={liveStats} userTz={userTz} isFavorite={isFavorite} onFavorite={onFavorite} onDismiss={onDismiss} />,
    body: <FootballAnalysisTabs match={match} data={data} liveStats={liveStats} selected={selected} onToggleMarket={(market) => toggleMarket(match.fixture.id, market, market.matchName)} onViewFull={onViewFull} />,
  };
}

function ExpandedFootballView(props: any) {
  const { head, body } = ExpandedFootball(props);
  return <MatchFullscreen visible title="Partido analizado" head={head} body={body} onClose={props.onClose} onStep={props.onStep} overlay={props.overlay} />;
}

function FootballDailyRail({ selections, averageProbability, fixtures }: { selections: any[]; averageProbability: number; fixtures: any[] }) {
  const liveStats = useLiveStatsSnapshot();
  const fixtureMap = useMemo(() => new Map(fixtures.map((f) => [String(f.fixture?.id), f])), [fixtures]);
  const decorated = useMemo<DecoratedSelection[]>(() => selections.map((selection) => {
    const game = fixtureMap.get(String(selection.fixtureId));
    const result = liveStats?.[selection.fixtureId] || liveStats?.[String(selection.fixtureId)] || null;
    return { ...selection, resultState: marketResultState({ sport: 'football', game, liveResult: result }), outcome: settleMarketSelection({ sport: 'football', selection, game, liveResult: result }) };
  }), [fixtureMap, liveStats, selections]);
  return <DailyPickRail selections={decorated} averageProbability={averageProbability} sport="football" />;
}

export function FootballDashboard({ date, userTz, onDateChange, activeSport, onSportChange, onComboBarChange }: Props) {
  const router = useRouter();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<number | null>(null);
  const { selectedMarkets, toggleMarket, clearMarkets, totalSelections } = useSelectedMarkets();
  const dash = useFootballDashboard({ date, userTz, statusFilter });
  // La X solo pide confirmación; se oculta al confirmar (igual que la web).
  const [pendingDismiss, setPendingDismiss] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const askDismiss = useCallback((id: number) => setPendingDismiss(id), []);
  const pendingMatch = pendingDismiss != null ? dash.fixtures.find((f) => f.fixture.id === pendingDismiss) : null;
  const confirmDismiss = () => {
    if (pendingDismiss == null) return;
    dash.dismissMatch(pendingDismiss);
    setExpanded((current) => (current === pendingDismiss ? null : current));
    setPendingDismiss(null);
  };
  const comboBar = totalSelections > 0 && statusFilter !== 'favoritos';
  useEffect(() => { onComboBarChange?.(comboBar); }, [comboBar, onComboBarChange]);
  useEffect(() => () => onComboBarChange?.(false), [onComboBarChange]);

  const changeDate = useCallback((next: string) => {
    if (next === date) return;
    dash.markDateChange();
    setExpanded(null);
    clearMarkets();
    onDateChange(next);
  }, [date, dash, onDateChange, clearMarkets]);

  const customCombinada = useMemo(() => {
    const all = Object.entries(selectedMarkets).map(([fid, markets]) => ({ ...Object.values(markets)[0], fixtureId: fid })).filter((m) => m && m.id);
    if (!all.length) return null;
    const co = all.reduce((acc, m: any) => (m.odd ? acc * m.odd : acc), 1);
    const cp = all.reduce((acc, m: any) => acc * (Number(m.rawProbability ?? m.probability) / 100), 1) * 100;
    return { selections: all as any[], combinedOdd: +co.toFixed(2), combinedProbability: +cp.toFixed(2), highRisk: cp < 60 };
  }, [selectedMarkets]);

  const analyzedIds = useMemo(() => dash.sorted.filter((m) => dash.analyzedSet.has(m.fixture.id)).map((m) => m.fixture.id), [dash.sorted, dash.analyzedSet]);
  const stepExpanded = useCallback((direction: 1 | -1) => {
    setExpanded((current) => {
      if (current == null) return current;
      const index = analyzedIds.indexOf(current);
      return index < 0 ? current : (analyzedIds[index + direction] ?? current);
    });
  }, [analyzedIds]);
  const expandedMatch = expanded != null ? dash.sorted.find((m) => m.fixture.id === expanded) : null;

  const openMatch = useCallback((match: any) => {
    if (dash.analyzedSet.has(match.fixture.id)) setExpanded(match.fixture.id);
    else router.push({ pathname: '/match/[sport]/[id]', params: { sport: 'football', id: String(match.fixture.id), date } });
  }, [dash.analyzedSet, router, date]);

  const today = todayInTz(userTz);
  const header = (
    <View style={{ gap: 12, paddingBottom: 12 }}>
      <DateStrip today={today} value={date} onChange={changeDate} />
      <View style={styles.filters}>
        <LeagueMultiPicker leagues={dash.leagues} value={dash.leagueFilter} onChange={dash.updateLeagueFilter} allLeagueIds={dash.allLeagueIds} disabled={!dash.leagueFilterReady} saving={dash.leagueFilterSaving} />
        <SportPicker value={activeSport} onChange={onSportChange} />
        <HiddenFixturesButton count={dash.hiddenFixtures.length} onPress={() => setShowHidden(true)} />
      </View>
      {statusFilter !== 'favoritos' && dash.apuestaDelDia && (
        <FootballDailyRail selections={dash.apuestaDelDia.selections} averageProbability={dash.apuestaDelDia.combinedProbability} fixtures={dash.fixtures} />
      )}
      <View style={{ paddingHorizontal: 16, gap: 8 }}>
        {dash.error && dash.fixtures.length > 0 ? <Banner tone="warning" message={dash.error} onClose={() => dash.setError('')} /> : null}
        {dash.batchRunning && !dash.loading && dash.fixtures.length > 0 && <Banner tone="success" message="Analizando partidos del día... Los datos se actualizan automáticamente." />}
        {!dash.loading && statusFilter === 'favoritos' && (
          <CombinationPanel
            combination={customCombinada}
            totalSelections={totalSelections}
            onRemove={(fixtureId, sel) => toggleMarket(fixtureId, sel, sel.matchName || '')}
            onClear={clearMarkets}
            onSave={() => dash.saveCombinada(customCombinada)}
            saving={dash.savingComb}
            savedCombinadas={dash.savedCombinadas}
            onDeleteSaved={dash.deleteSavedCombinada}
          />
        )}
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {dash.loading ? (
        <View style={{ flex: 1 }}>
          {header}
          <View style={{ paddingHorizontal: 16 }}><SkeletonList count={4} height={150} /></View>
        </View>
      ) : (
        <FlashList
          data={dash.sorted}
          keyExtractor={(item: any) => String(item.fixture.id)}
          ListHeaderComponent={header}
          contentContainerStyle={{ paddingBottom: comboBar ? 200 : 120 }}
          ListEmptyComponent={(
            <View style={{ paddingHorizontal: 16 }}>
              {dash.error && !dash.fixtures.length ? (
                <EmptyState title="Sin conexión" description={dash.error} actionLabel="Reintentar" onAction={dash.refresh} />
              ) : (
                <EmptyState
                  title={statusFilter === 'favoritos' ? 'Sin favoritos para esta fecha' : Array.isArray(dash.leagueFilter) && dash.leagueFilter.length === 0 ? 'Ninguna liga seleccionada' : 'Sin partidos'}
                  description={statusFilter === 'favoritos' ? 'Marca la estrella de un partido para guardarlo aquí junto a tu combinada.' : Array.isArray(dash.leagueFilter) && dash.leagueFilter.length === 0 ? 'Abre el filtro de competición y marca las ligas que quieras ver.' : 'No hay partidos que coincidan con los filtros de esta fecha.'}
                />
              )}
            </View>
          )}
          renderItem={({ item }: { item: any }) => (
            <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
              <FootballRow
                match={item}
                odds={dash.analyzedOdds[item.fixture.id]}
                data={dash.analyzedData[item.fixture.id]}
                standings={dash.standings}
                userTz={userTz}
                isFavorite={dash.favoritesSet.has(item.fixture.id)}
                analyzed={dash.analyzedSet.has(item.fixture.id)}
                selCount={Object.keys(selectedMarkets[String(item.fixture.id)] || {}).length}
                onFavorite={dash.toggleFavorite}
                onDismiss={askDismiss}
                onOpen={() => openMatch(item)}
              />
            </View>
          )}
        />
      )}

      {comboBar && (
        <Pressable onPress={() => { setExpanded(null); setStatusFilter('favoritos'); }} style={styles.floatBar}>
          <View style={styles.floatIcon}><Layers size={18} color={colors.accent} /></View>
          <View style={{ flex: 1 }}>
            <AppText variant="caption" tone="muted">Tu selección</AppText>
            <AppText variant="label" weight="bold">Ver combinada · {totalSelections}</AppText>
          </View>
          {customCombinada && <AppText variant="mono" style={{ color: colors.amber }}>{customCombinada.combinedOdd}x</AppText>}
          <ArrowRight size={18} color={colors.text} />
        </Pressable>
      )}

      <StatusDock value={statusFilter} onChange={setStatusFilter} counts={dash.counts} isToday={date === today} onToday={() => changeDate(today)} />

      {expandedMatch && (
        <ExpandedFootballView
          match={expandedMatch}
          data={dash.analyzedData[expandedMatch.fixture.id]}
          odds={dash.analyzedOdds[expandedMatch.fixture.id]}
          standings={dash.standings}
          userTz={userTz}
          isFavorite={dash.favoritesSet.has(expandedMatch.fixture.id)}
          onFavorite={dash.toggleFavorite}
          onDismiss={askDismiss}
          onViewFull={() => { setExpanded(null); router.push({ pathname: '/match/[sport]/[id]', params: { sport: 'football', id: String(expandedMatch.fixture.id), date } }); }}
          onClose={() => setExpanded(null)}
          onStep={stepExpanded}
          overlay={<DismissConfirmDialog inline visible={pendingDismiss != null} home={pendingMatch?.teams?.home?.name} away={pendingMatch?.teams?.away?.name} onCancel={() => setPendingDismiss(null)} onConfirm={confirmDismiss} />}
        />
      )}

      <DismissConfirmDialog visible={pendingDismiss != null && !expandedMatch} home={pendingMatch?.teams?.home?.name} away={pendingMatch?.teams?.away?.name} onCancel={() => setPendingDismiss(null)} onConfirm={confirmDismiss} />
      <HiddenFixturesPanel visible={showHidden} fixtures={dash.hiddenFixtures} userTz={userTz} onUnhide={dash.unhideMatch} onClose={() => setShowHidden(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 8, paddingHorizontal: 16 },
  row: { gap: 4 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 2 },
  floatBar: { position: 'absolute', left: 16, right: 16, bottom: 92, flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.lg, backgroundColor: colors.surfaceStrong, borderWidth: 1, borderColor: colors.accentBorder, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, elevation: 8 },
  floatIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: colors.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
