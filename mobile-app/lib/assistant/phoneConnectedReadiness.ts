import { Platform } from 'react-native';
import { connectedPilotReadiness } from './connectedPilotPolicy';

// Frozen per JS bundle. Release/non-iOS builds cannot opt in even with the flag.
// The compatibility field "verified" is launch permission here, not a server probe.
export const PHONE_CONNECTED_READINESS = connectedPilotReadiness(
  __DEV__, Platform.OS, process.env.EXPO_PUBLIC_SENSI_CONNECTED_PILOT,
);
