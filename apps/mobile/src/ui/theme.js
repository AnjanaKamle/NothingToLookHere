import { useColorScheme } from 'react-native';

const light = {
  background: '#f6f7f9',
  surface: '#ffffff',
  text: '#16181d',
  muted: '#5a6070',
  border: '#d9dde5',
  primary: '#1f5fd6',
  primaryText: '#ffffff',
  danger: '#b42318',
  dangerSurface: '#fdecea',
  warning: '#8a5300',
  warningSurface: '#fff4e0',
  success: '#146c2e',
  successSurface: '#e7f6ec',
  infoSurface: '#e8effc',
};

const dark = {
  background: '#101215',
  surface: '#1a1d22',
  text: '#eceef2',
  muted: '#a3a9b6',
  border: '#2d323a',
  primary: '#6c9cff',
  primaryText: '#0b1020',
  danger: '#ff8a80',
  dangerSurface: '#3a1715',
  warning: '#ffc266',
  warningSurface: '#33260f',
  success: '#7fd99a',
  successSurface: '#13301d',
  infoSurface: '#17243d',
};

export function useTheme() {
  return useColorScheme() === 'dark' ? dark : light;
}

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 };
