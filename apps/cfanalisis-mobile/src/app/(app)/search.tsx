import { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { ArrowRight, Search, X } from 'lucide-react-native';
import { AppText, Chip, Screen } from '@/components/ui';
import { DASHBOARD_SPORTS, SPORT_ICONS, type SportKey } from '@/components/dashboard/SportIcons';
import { api } from '@/lib/api';
import { fmtDateTime, getUserTz } from '@/lib/timezone';
import { colors, fonts, radius } from '@/theme/tokens';

const STATUS_LABELS: Record<string, string> = {
  NS: 'Próximo', TBD: 'Por confirmar', FT: 'Finalizado', AET: 'Finalizado', PEN: 'Finalizado', FINAL: 'Finalizado',
  LIVE: 'En vivo', IN: 'En vivo', '1H': 'En vivo', '2H': 'En vivo', HT: 'Descanso', POST: 'Aplazado', PST: 'Aplazado', CANC: 'Cancelado', SUSP: 'Suspendido',
};

interface Result { id: string; sport: SportKey; sportLabel: string; homeTeam: string; awayTeam: string; league?: string | null; kickoff?: string; status?: string | null; statusLabel?: string | null; homeScore?: number | null; awayScore?: number | null }

/** Spotlight: búsqueda DB-only de equipos, ligas y partidos en los cuatro deportes. */
export default function SearchScreen() {
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<SportKey[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const tz = getUserTz();

  useEffect(() => { const t = setTimeout(() => inputRef.current?.focus(), 200); return () => clearTimeout(t); }, []);

  useEffect(() => {
    const normalized = query.trim();
    if (normalized.length < 2) { setResults([]); setLoading(false); setError(''); return; }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setLoading(true); setError('');
      try {
        const params = new URLSearchParams({ q: normalized });
        if (selected.length) params.set('sports', selected.join(','));
        const payload = await api.get<{ results: Result[] }>(`/api/dashboard-search?${params}`);
        if (!cancelled) setResults(Array.isArray(payload.results) ? payload.results : []);
      } catch (cause: any) {
        if (!cancelled) { setResults([]); setError(cause?.message || 'No se pudo completar la búsqueda.'); }
      } finally { if (!cancelled) setLoading(false); }
    }, 220);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, selected]);

  const open = (result: Result) => {
    router.back();
    setTimeout(() => router.push({ pathname: '/match/[sport]/[id]', params: { sport: result.sport, id: result.id } }), 50);
  };

  return (
    <Screen>
      <View style={styles.head}>
        <View style={styles.inputWrap}>
          <Search size={20} color={colors.muted} />
          <TextInput ref={inputRef} value={query} onChangeText={setQuery} placeholder="Buscar equipo, liga o partido" placeholderTextColor={colors.faint} style={styles.input} autoCorrect={false} returnKeyType="search" />
          {query ? <Pressable onPress={() => setQuery('')} hitSlop={8}><X size={16} color={colors.muted} /></Pressable> : null}
        </View>
        <Pressable onPress={() => router.back()} style={styles.close} accessibilityLabel="Cerrar búsqueda"><X size={20} color={colors.text} /></Pressable>
      </View>
      <View style={styles.filters}>
        <Chip label="Todos" active={selected.length === 0} onPress={() => setSelected([])} small />
        {DASHBOARD_SPORTS.map((sport) => {
          const Icon = SPORT_ICONS[sport.value];
          const active = selected.includes(sport.value);
          return <Chip key={sport.value} label={sport.label} active={active} small icon={<Icon size={14} color={active ? colors.accent : colors.muted} />} onPress={() => setSelected((current) => current.includes(sport.value) ? current.filter((v) => v !== sport.value) : [...current, sport.value])} />;
        })}
      </View>
      {query.trim().length < 2 ? (
        <View style={styles.empty}>
          <Search size={26} color={colors.accent} />
          <AppText variant="heading">Encuentra cualquier partido</AppText>
          <AppText tone="muted" align="center">Escribe al menos dos letras. Sin ningún deporte seleccionado, buscaremos en toda la app.</AppText>
        </View>
      ) : loading ? (
        <AppText tone="muted" align="center" style={{ padding: 24 }}>Buscando en los deportes seleccionados…</AppText>
      ) : error ? (
        <AppText tone="error" align="center" style={{ padding: 24 }}>{error}</AppText>
      ) : results.length === 0 ? (
        <View style={styles.empty}><AppText variant="heading">Sin coincidencias</AppText><AppText tone="muted">Prueba otro equipo, liga o activa más deportes.</AppText></View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item) => `${item.sport}-${item.id}`}
          contentContainerStyle={{ padding: 16, gap: 8 }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const Icon = SPORT_ICONS[item.sport] || SPORT_ICONS.football;
            const score = item.homeScore != null && item.awayScore != null ? `${item.homeScore} – ${item.awayScore}` : null;
            const status = STATUS_LABELS[item.status || ''] || item.statusLabel || item.status || 'Partido';
            return (
              <Pressable onPress={() => open(item)} style={({ pressed }) => [styles.result, pressed && { opacity: 0.85 }]}>
                <View style={styles.resultIcon}><Icon size={22} color={colors.accent} /></View>
                <View style={{ flex: 1, gap: 2 }}>
                  <AppText variant="caption" tone="muted">{item.sportLabel} · {item.league || 'Competición'}</AppText>
                  <AppText variant="label" weight="bold">{item.homeTeam} <AppText variant="label" tone="muted">vs</AppText> {item.awayTeam}</AppText>
                  <AppText variant="caption" tone="secondary">{fmtDateTime(item.kickoff, tz)} · {status}</AppText>
                </View>
                {score && <AppText variant="mono" weight="bold">{score}</AppText>}
                <ArrowRight size={16} color={colors.muted} />
              </Pressable>
            );
          }}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  inputWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, borderRadius: radius.lg, backgroundColor: colors.surfaceSolid, borderWidth: 1, borderColor: colors.borderStrong, minHeight: 50 },
  input: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16, paddingVertical: 12 },
  close: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)', borderWidth: 1, borderColor: colors.border },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  empty: { alignItems: 'center', gap: 8, padding: 28 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid },
  resultIcon: { width: 42, height: 42, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
});
