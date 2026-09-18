import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { AppText, Card } from '@/components/ui';
import { colors, radius } from '@/theme/tokens';

const PERIOD_LABELS: Record<string, string> = {
  match: 'Partido completo', full: 'Partido completo', firstHalf: '1.ª parte', secondHalf: '2.ª parte',
  quarter1: '1.er cuarto', quarter2: '2.º cuarto', quarter3: '3.er cuarto', quarter4: '4.º cuarto',
  first3: 'Primeras 3 entradas', first4_5: 'Primeras 4,5 entradas', first5: 'Primeras 5 entradas', first7: 'Primeras 7 entradas',
};
const METRIC_LABELS: Record<string, string> = { goals: 'Goles', cards: 'Tarjetas', corners: 'Córners', shots: 'Remates', sot: 'Remates a puerta' };

const fmt = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(2);
const pct = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? '—' : `${Math.min(95, Number(value)).toFixed(2).replace(/\.00$/, '')}%`;

function ExpectedRows({ verdict, homeName, awayName }: { verdict: any; homeName: string; awayName: string }) {
  const rows: any[] = [];
  const expected = verdict?.expected || {};
  if (expected.match) rows.push({ period: 'match', metric: 'Puntos/carreras', ...expected.match });
  for (const [period, value] of Object.entries<any>(expected.periods || {})) {
    if (value && Object.values(value).some((item) => item != null)) rows.push({ period, metric: 'Puntos/carreras', ...value });
  }
  for (const period of ['full', 'firstHalf', 'secondHalf']) {
    for (const [metric, value] of Object.entries<any>(expected[period] || {})) {
      if (value && Object.values(value).some((item) => item != null)) rows.push({ period, metric: METRIC_LABELS[metric] || metric, ...value });
    }
  }
  if (!rows.length) return null;
  return (
    <View style={{ gap: 6 }}>
      {rows.map((row) => (
        <View key={`${row.period}-${row.metric}`} style={styles.expectedRow}>
          <AppText variant="caption" tone="muted">{PERIOD_LABELS[row.period] || row.period} · {row.metric}</AppText>
          <View style={styles.expectedNums}>
            <AppText variant="caption" tone="secondary">{homeName} <AppText variant="mono" size={12}>{fmt(row.home)}</AppText></AppText>
            <AppText variant="caption" tone="secondary">Total <AppText variant="mono" size={12}>{fmt(row.total)}</AppText></AppText>
            <AppText variant="caption" tone="secondary">{awayName} <AppText variant="mono" size={12}>{fmt(row.away)}</AppText></AppText>
          </View>
        </View>
      ))}
    </View>
  );
}

interface Props { verdict: any; homeName?: string; awayName?: string; compact?: boolean; embedded?: boolean }

/** Veredicto final: producto descriptivo aislado (Bet365, cuota ≥ 1,50). */
export function FinalVerdictPanel({ verdict, homeName = 'Local', awayName = 'Visitante', compact = false, embedded = false }: Props) {
  const [open, setOpen] = useState(embedded);
  const picks: any[] = Array.isArray(verdict?.picks) ? verdict.picks : [];
  const h2h: any[] = Array.isArray(verdict?.h2h) ? verdict.h2h.slice(0, 2) : [];

  const body = (
    <View style={{ gap: 10 }}>
      {embedded && (
        <View>
          <AppText variant="kicker" tone="muted">Pronóstico aislado</AppText>
          <AppText variant="label" style={{ color: colors.amber }}>Bet365 · cuota ≥ 1,50</AppText>
        </View>
      )}
      <AppText variant="caption" tone="muted">
        Solo partidos oficiales de la competición y temporada indicadas. Si la temporada aún no tiene partidos, usa los primeros 5 y los últimos 5 de la anterior. H2H: misma competición primero y otras solo para completar dos.
      </AppText>
      {verdict && (
        <View style={styles.samples}>
          <AppText variant="caption" tone="secondary">{homeName}: {verdict.samples?.home?.count ?? 0} oficiales</AppText>
          <AppText variant="caption" tone="secondary">{awayName}: {verdict.samples?.away?.count ?? 0} oficiales</AppText>
          <AppText variant="caption" tone="secondary">H2H: {h2h.length}/2</AppText>
        </View>
      )}
      {!compact && <ExpectedRows verdict={verdict} homeName={homeName} awayName={awayName} />}
      <View style={{ gap: 8 }}>
        {!verdict ? (
          <AppText variant="caption" tone="muted">El Veredicto final se está preparando con los partidos oficiales y las líneas reales de Bet365. El análisis actual permanece disponible.</AppText>
        ) : picks.length ? picks.map((pick) => (
          <View key={pick.id} style={styles.pick}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="caption" tone="muted">{pick.market}</AppText>
              <AppText variant="label" weight="bold">{pick.name}</AppText>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <AppText variant="caption" tone="muted">Probabilidad</AppText>
              <AppText variant="mono" weight="bold" tone="accent">{pct(pick.rawProbability ?? pick.probability)}</AppText>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <AppText variant="caption" tone="muted">Cuota</AppText>
              <AppText variant="mono" style={{ color: colors.amber }}>@{Number(pick.odd).toFixed(2)}</AppText>
            </View>
          </View>
        )) : (
          <AppText variant="caption" tone="muted">No existe ahora una opción Bet365 que coincida con el cálculo, sea “Más de” cuando aplica y tenga cuota mínima de 1,50.</AppText>
        )}
      </View>
      {!compact && h2h.length > 0 && (
        <View style={{ gap: 4 }}>
          <AppText variant="kicker" tone="muted">Últimos H2H oficiales · {h2h.length}</AppText>
          {h2h.map((match) => (
            <View key={match.fixtureId}>
              <AppText variant="label">{match.homeTeam || homeName} {match.homeScore ?? '—'}–{match.awayScore ?? '—'} {match.awayTeam || awayName}</AppText>
              <AppText variant="caption" tone="muted">{match.date ? new Date(match.date).toLocaleDateString('es-ES') : ''} · {match.competition || `Competición ${match.competitionId}`}{match.sameCompetition ? ' · misma competición' : ' · complemento'}</AppText>
            </View>
          ))}
        </View>
      )}
    </View>
  );

  if (embedded) return <Card tone="accent">{body}</Card>;
  return (
    <Card tone="accent" padded={false}>
      <Pressable onPress={() => setOpen((value) => !value)} style={styles.head} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <View>
          <AppText variant="kicker" tone="muted">Pronóstico aislado</AppText>
          <AppText variant="heading">Veredicto final</AppText>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <AppText variant="caption" style={{ color: colors.amber }}>Bet365 · cuota ≥ 1,50</AppText>
          <ChevronDown size={18} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
        </View>
      </Pressable>
      {open && <View style={{ padding: 14, paddingTop: 0 }}>{body}</View>}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 14 },
  samples: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  expectedRow: { gap: 3, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
  expectedNums: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  pick: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: radius.md, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: colors.border },
});
