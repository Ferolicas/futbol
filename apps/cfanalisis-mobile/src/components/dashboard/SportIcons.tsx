import Svg, { Circle, Ellipse, Line, Path } from 'react-native-svg';
import { colors } from '@/theme/tokens';

interface IconProps { size?: number; color?: string }

export function FutbolIcon({ size = 20, color = colors.text }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M12 7.2l4.2 3-1.6 5H9.4l-1.6-5z" />
      <Path d="M12 7.2V2.6M16.2 10.2l4.4-1.4M14.6 15.2l2.6 3.8M9.4 15.2l-2.6 3.8M7.8 10.2 3.4 8.8" />
    </Svg>
  );
}

export function BaseballIcon({ size = 20, color = colors.text }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={12} cy={12} r={9.5} />
      <Path d="M5.6 5.2c3 2.2 3 11.4 0 13.6M18.4 5.2c-3 2.2-3 11.4 0 13.6" />
      <Path d="M7.2 8.4l1.4 .6M7 12h1.6M7.2 15.6l1.4-.6M16.8 8.4l-1.4 .6M17 12h-1.6M16.8 15.6l-1.4-.6" />
    </Svg>
  );
}

export function BaloncestoIcon({ size = 20, color = colors.text }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Circle cx={12} cy={12} r={9.5} />
      <Line x1={2.5} y1={12} x2={21.5} y2={12} />
      <Line x1={12} y1={2.5} x2={12} y2={21.5} />
      <Path d="M5.3 5.3c3.7 3.7 3.7 9.7 0 13.4M18.7 5.3c-3.7 3.7-3.7 9.7 0 13.4" />
    </Svg>
  );
}

export function FutbolAmericanoIcon({ size = 20, color = colors.text }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Ellipse cx={12} cy={12} rx={10} ry={6.2} transform="rotate(-35 12 12)" />
      <Path d="M8.4 15.6l7.2-7.2M9.6 12.2l1.2 1.2M11.4 10.4l1.2 1.2M13.2 8.6l1.2 1.2" />
    </Svg>
  );
}

export const SPORT_ICONS = {
  football: FutbolIcon,
  baseball: BaseballIcon,
  basketball: BaloncestoIcon,
  american_football: FutbolAmericanoIcon,
} as const;

export type SportKey = keyof typeof SPORT_ICONS;

export const DASHBOARD_SPORTS: Array<{ value: SportKey; label: string; meta: string; slug: string }> = [
  { value: 'football', label: 'Fútbol', meta: 'Ligas y copas', slug: 'football' },
  { value: 'baseball', label: 'Béisbol', meta: 'MLB', slug: 'baseball' },
  { value: 'basketball', label: 'Baloncesto', meta: 'NBA y NCAA', slug: 'baloncesto' },
  { value: 'american_football', label: 'Fútbol americano', meta: 'NFL y NCAA', slug: 'futbol-americano' },
];
