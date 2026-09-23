import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Screen } from '@/components/ui';
import { DashboardHeader } from '@/components/dashboard/DashboardHeader';
import { AssistantLauncher } from '@/components/dashboard/AssistantLauncher';
import type { SportKey } from '@/components/dashboard/SportIcons';
import { FootballDashboard } from '@/features/football/FootballDashboard';
import { BaseballDashboard } from '@/features/baseball/BaseballDashboard';
import { MultisportDashboard } from '@/features/multisport/MultisportDashboard';
import { getUserTz, todayInTz } from '@/lib/timezone';

const SPORTS = new Set<SportKey>(['football', 'baseball', 'basketball', 'american_football']);

/** Panel deportivo único: el selector cambia el deporte y conserva la jornada elegida. */
export default function DashboardScreen() {
  const params = useLocalSearchParams<{ sport?: string }>();
  const requested = SPORTS.has(params.sport as SportKey) ? (params.sport as SportKey) : 'football';
  const [activeSport, setActiveSport] = useState<SportKey>(requested);
  const [userTz] = useState(getUserTz);
  const [date, setDate] = useState(() => todayInTz(getUserTz()));
  const onSportChange = useCallback((sport: SportKey) => setActiveSport(sport), []);
  // Cada dashboard avisa si muestra "Ver combinada" para subir el botón "Preguntar" por encima.
  const [comboBar, setComboBar] = useState(false);
  const shared = { date, userTz, onDateChange: setDate, activeSport, onSportChange, onComboBarChange: setComboBar };

  return (
    <Screen edges={[]}>
      <DashboardHeader />
      <View style={{ flex: 1 }}>
        {activeSport === 'football' && <FootballDashboard {...shared} />}
        {activeSport === 'baseball' && <BaseballDashboard {...shared} />}
        {activeSport === 'basketball' && <MultisportDashboard {...shared} sport="basketball" slug="baloncesto" title="baloncesto" scoreLabel="puntos" />}
        {activeSport === 'american_football' && <MultisportDashboard {...shared} sport="american_football" slug="futbol-americano" title="fútbol americano" scoreLabel="puntos" />}
        {/* Solo en el dashboard; el partido desplegado (Modal fullscreen) lo tapa. */}
        <AssistantLauncher lifted={comboBar} />
      </View>
    </Screen>
  );
}
