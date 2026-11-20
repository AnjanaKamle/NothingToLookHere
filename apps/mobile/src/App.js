import { StatusBar } from 'expo-status-bar';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useColorScheme } from 'react-native';
import { EnrollmentProvider, useEnrollment } from './state/EnrollmentContext';
import { LoadingView } from './ui/components';
import SignInScreen from './screens/SignInScreen';
import RecoverScreen from './screens/RecoverScreen';
import EnrollScreen from './screens/EnrollScreen';
import HomeScreen from './screens/HomeScreen';
import ScanScreen from './screens/ScanScreen';
import ApproveScreen from './screens/ApproveScreen';
import SessionsScreen from './screens/SessionsScreen';
import DevicesScreen from './screens/DevicesScreen';
import RecoveryScreen from './screens/RecoveryScreen';

const Stack = createNativeStackNavigator();

/** Two navigators: setup (not enrolled) and trusted phone (enrolled). */
function Navigator() {
  const { status } = useEnrollment();
  if (status === 'loading') return <LoadingView label="Starting…" />;

  return (
    <Stack.Navigator>
      {status === 'enrolled' ? (
        <>
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Trusted phone' }} />
          <Stack.Screen name="Scan" component={ScanScreen} options={{ title: 'Scan QR code' }} />
          <Stack.Screen
            name="Approve"
            component={ApproveScreen}
            options={{ title: 'Sign-in request' }}
          />
          <Stack.Screen
            name="Sessions"
            component={SessionsScreen}
            options={{ title: 'Browsers' }}
          />
          <Stack.Screen name="Devices" component={DevicesScreen} options={{ title: 'Phones' }} />
          <Stack.Screen
            name="Recovery"
            component={RecoveryScreen}
            options={{ title: 'Recovery' }}
          />
        </>
      ) : (
        <>
          <Stack.Screen name="SignIn" component={SignInScreen} options={{ title: 'Sign in' }} />
          <Stack.Screen
            name="Recover"
            component={RecoverScreen}
            options={{ title: 'Recover account' }}
          />
          <Stack.Screen name="Enroll" component={EnrollScreen} options={{ title: 'Secure key' }} />
        </>
      )}
    </Stack.Navigator>
  );
}

export default function App() {
  const scheme = useColorScheme();
  return (
    <SafeAreaProvider>
      <EnrollmentProvider>
        <NavigationContainer theme={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <Navigator />
        </NavigationContainer>
      </EnrollmentProvider>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  );
}
