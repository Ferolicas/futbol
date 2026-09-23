import { Children, useState } from 'react';
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { ChevronDown } from 'lucide-react-native';
import { AppText } from '@/components/ui';
import { colors, radius } from '@/theme/tokens';

/*
 * Piezas del "análisis completo" compartidas por los cuatro deportes. La
 * regla es la simetría: toda fila de datos se reparte en columnas de igual
 * ancho (nada de flex-wrap con anchos mínimos, que dejaba filas cojas), y las
 * secciones son acordeones como los GlassSection de la web.
 */

export const prob = (entry: any): number | null => {
  if (entry == null) return null;
  const raw = Number(entry?.rawProbability);
  if (Number.isFinite(raw)) return raw <= 1 ? raw * 100 : raw;
  const value = Number(typeof entry === 'object' ? entry?.probability : entry);
  return Number.isFinite(value) ? value : null;
};
export const pctText = (entry: any) => {
  const value = prob(entry);
  return value == null ? '—' : `${(Math.floor(Math.min(95, Math.max(0, value)) * 100) / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
};
export const numText = (value: any, decimals = 2) => value == null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(decimals);
const sortedLines = (lines: any) => Object.entries(lines || {}).sort((l, r) => Number(l[0]) - Number(r[0]));

/** Sección colapsable (abierta por defecto, igual que la web). */
export function AccordionSection({ title, icon, accent = colors.accent, count, hint, defaultOpen = true, children }: {
  title: string; icon?: React.ReactNode; accent?: string; count?: number | null; hint?: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.section}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.sectionHead} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        {icon ? <View style={[styles.sectionIcon, { backgroundColor: `${accent}1f` }]}>{icon}</View> : null}
        <AppText variant="heading" size={15} style={{ flex: 1 }} numberOfLines={2}>{title}</AppText>
        {count != null ? <View style={styles.countBadge}><AppText variant="mono" size={11} tone="accent">{count}</AppText></View> : null}
        <ChevronDown size={18} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open && (
        <View style={styles.sectionBody}>
          {hint ? <AppText variant="caption" tone="muted">{hint}</AppText> : null}
          {children}
        </View>
      )}
    </View>
  );
}

/** Acordeón secundario dentro de una sección (p. ej. cada categoría de jugadores). */
export function SubAccordion({ title, meta, defaultOpen = false, children }: { title: string; meta?: string; defaultOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <View style={styles.sub}>
      <Pressable onPress={() => setOpen((v) => !v)} style={styles.subHead} accessibilityRole="button" accessibilityState={{ expanded: open }}>
        <AppText variant="label" weight="bold" tone="accent" style={{ flex: 1 }} numberOfLines={1}>{title}</AppText>
        {meta ? <AppText variant="caption" tone="muted">{meta}</AppText> : null}
        <ChevronDown size={16} color={colors.muted} style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }} />
      </Pressable>
      {open && <View style={{ padding: 10, gap: 8 }}>{children}</View>}
    </View>
  );
}

/** Bloque interior con título pequeño (sustituye a las tarjetas sueltas). */
export function Panel({ title, children, style }: { title?: string; children: React.ReactNode; style?: ViewStyle }) {
  return (
    <View style={[styles.panel, style]}>
      {title ? <AppText variant="kicker" tone="muted" numberOfLines={1}>{title}</AppText> : null}
      {children}
    </View>
  );
}

/** Malla de N columnas de igual ancho; la última fila se completa con huecos. */
export function Grid({ columns = 2, gap = 8, children }: { columns?: number; gap?: number; children: React.ReactNode }) {
  const items = Children.toArray(children).filter(Boolean);
  if (!items.length) return null;
  const rows: React.ReactNode[][] = [];
  for (let i = 0; i < items.length; i += columns) rows.push(items.slice(i, i + columns));
  return (
    <View style={{ gap }}>
      {rows.map((row, r) => (
        <View key={r} style={{ flexDirection: 'row', gap }}>
          {row.map((item, c) => <View key={c} style={{ flex: 1, minWidth: 0 }}>{item}</View>)}
          {Array.from({ length: columns - row.length }).map((_, c) => <View key={`pad-${c}`} style={{ flex: 1 }} />)}
        </View>
      ))}
    </View>
  );
}

/** Dato centrado: etiqueta arriba, valor grande abajo. Todos miden lo mismo. */
export function StatTile({ label, value, color = colors.accent, sub }: { label: string; value: React.ReactNode; color?: string; sub?: string }) {
  return (
    <View style={styles.tile}>
      <AppText variant="caption" tone="muted" align="center" numberOfLines={1}>{label}</AppText>
      <AppText variant="mono" size={16} weight="bold" align="center" style={{ color }}>{value}</AppText>
      {sub ? <AppText variant="caption" tone="faint" align="center" numberOfLines={1}>{sub}</AppText> : null}
    </View>
  );
}

/** Probabilidad como tile (etiqueta + %). */
export function ProbTile({ label, value, color = colors.accent }: { label: string; value: any; color?: string }) {
  if (prob(value) == null) return null;
  return <StatTile label={label} value={pctText(value)} color={color} />;
}

/** Local / Total / Visitante con el mismo ancho. */
export function ExpectedRow({ value, homeName, awayName, totalLabel = 'Total' }: { value: any; homeName: string; awayName: string; totalLabel?: string }) {
  if (!value || ![value.home, value.total, value.away].some((v) => v != null && Number.isFinite(Number(v)))) return null;
  return (
    <Grid columns={3}>
      <StatTile label={homeName} value={numText(value.home)} sub="media" />
      <StatTile label={totalLabel} value={numText(value.total)} color={colors.cyan} sub="media" />
      <StatTile label={awayName} value={numText(value.away)} sub="media" />
    </Grid>
  );
}

/** Tabla simétrica: línea | Más | Menos. */
export function OverUnderTable({ lines, unit }: { lines: any; unit?: string }) {
  const entries = sortedLines(lines);
  if (!entries.length) return null;
  return (
    <View style={styles.table}>
      <View style={styles.tableHead}>
        <AppText variant="caption" tone="faint" style={styles.colLine}>Línea</AppText>
        <AppText variant="caption" tone="faint" align="center" style={styles.col}>Más</AppText>
        <AppText variant="caption" tone="faint" align="center" style={styles.col}>Menos</AppText>
      </View>
      {entries.map(([line, values]: any) => {
        const n = values?.evidence?.over?.n ?? values?.evidence?.under?.n;
        return (
          <View key={line} style={styles.tableRow}>
            <AppText variant="caption" weight="bold" style={styles.colLine} numberOfLines={1}>{line}{unit ? ` ${unit}` : ''}{n ? <AppText variant="caption" tone="faint">  n={n}</AppText> : null}</AppText>
            <AppText variant="mono" size={12} tone="accent" align="center" style={styles.col}>{pctText(values?.over)}</AppText>
            <AppText variant="mono" size={12} tone="warning" align="center" style={styles.col}>{pctText(values?.under)}</AppText>
          </View>
        );
      })}
    </View>
  );
}

/** Tabla simétrica por equipo: línea | local (más de) | visitante (más de). */
export function CompareTable({ homeLines, awayLines, homeName, awayName }: { homeLines: any; awayLines: any; homeName: string; awayName: string }) {
  const lines = [...new Set([...Object.keys(homeLines || {}), ...Object.keys(awayLines || {})])].map(Number).filter(Number.isFinite).sort((l, r) => l - r);
  if (!lines.length) return null;
  return (
    <View style={styles.table}>
      <View style={styles.tableHead}>
        <AppText variant="caption" tone="faint" style={styles.colLine}>Más de</AppText>
        <AppText variant="caption" weight="bold" tone="secondary" align="center" style={styles.col} numberOfLines={1}>{homeName}</AppText>
        <AppText variant="caption" weight="bold" tone="secondary" align="center" style={styles.col} numberOfLines={1}>{awayName}</AppText>
      </View>
      {lines.map((line) => (
        <View key={line} style={styles.tableRow}>
          <AppText variant="caption" weight="bold" style={styles.colLine}>{line}</AppText>
          <AppText variant="mono" size={12} tone="accent" align="center" style={styles.col}>{pctText(homeLines?.[line]?.over)}</AppText>
          <AppText variant="mono" size={12} tone="accent" align="center" style={styles.col}>{pctText(awayLines?.[line]?.over)}</AppText>
        </View>
      ))}
    </View>
  );
}

/** Hándicaps: una columna por equipo, mismas filas a ambos lados. */
export function SpreadColumns({ values, homeName, awayName }: { values: any; homeName: string; awayName: string }) {
  const home = sortedLines(values?.home);
  const away = sortedLines(values?.away);
  if (!home.length && !away.length) return null;
  const Column = ({ name, entries }: { name: string; entries: [string, any][] }) => (
    <View style={styles.table}>
      <View style={styles.tableHead}><AppText variant="caption" weight="bold" tone="secondary" numberOfLines={1}>{name}</AppText></View>
      {entries.map(([line, value]) => (
        <View key={line} style={styles.tableRow}>
          <AppText variant="caption" weight="bold" style={{ flex: 1 }}>{Number(line) > 0 ? '+' : ''}{line}</AppText>
          <AppText variant="mono" size={12} tone="accent">{pctText(value)}</AppText>
        </View>
      ))}
    </View>
  );
  return <Grid columns={2}><Column name={homeName} entries={home} /><Column name={awayName} entries={away} /></Grid>;
}

/** Fila clave/valor alineada (estadísticas de lanzador, etc.). */
export function KeyValue({ label, value, color = colors.accent }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <View style={styles.kv}>
      <AppText variant="caption" tone="secondary" style={{ flex: 1 }} numberOfLines={1}>{label}</AppText>
      <AppText variant="mono" size={12} weight="bold" style={{ color }}>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSolid, overflow: 'hidden' },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 14, paddingVertical: 13 },
  sectionIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  sectionBody: { paddingHorizontal: 12, paddingBottom: 14, gap: 12 },
  countBadge: { minWidth: 24, height: 22, paddingHorizontal: 6, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  sub: { borderRadius: radius.md, borderWidth: 1, borderColor: 'rgba(94,230,177,0.14)', overflow: 'hidden' },
  subHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 10, backgroundColor: 'rgba(94,230,177,0.04)' },
  panel: { gap: 8, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.025)' },
  tile: { flex: 1, minHeight: 58, alignItems: 'center', justifyContent: 'center', gap: 2, paddingVertical: 8, paddingHorizontal: 6, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, backgroundColor: 'rgba(255,255,255,0.035)' },
  table: { borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' },
  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: 'rgba(255,255,255,0.04)' },
  tableRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.border },
  colLine: { flex: 1 },
  col: { flex: 1 },
  kv: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: colors.border },
});
