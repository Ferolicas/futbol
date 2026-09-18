import { StyleSheet, View, type ViewProps } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { colors } from '@/theme/tokens';

interface Props extends ViewProps { edges?: Array<'top' | 'bottom'> }

export function Screen({ edges = ['top'], style, ...rest }: Props) {
  const insets = useSafeAreaInsets();
  return (
    <View
      {...rest}
      style={[styles.base, { paddingTop: edges.includes('top') ? insets.top : 0, paddingBottom: edges.includes('bottom') ? insets.bottom : 0 }, style]}
    />
  );
}

const styles = StyleSheet.create({ base: { flex: 1, backgroundColor: colors.bg } });
