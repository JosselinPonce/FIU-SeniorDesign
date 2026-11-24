// Expo inlines this explicit profile at bundle time. Ordinary Debug and Release
// builds keep their existing behavior unless the standalone profile is selected.
export const STANDALONE_DEMO = process.env.EXPO_PUBLIC_DRIVESENSE_PROFILE === 'standalone-demo';
export const TELEMETRY_HOLD_KEY = 'telemetry_sync_resume_required';
