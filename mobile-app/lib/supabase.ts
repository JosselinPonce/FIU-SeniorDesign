import 'react-native-url-polyfill/auto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL!;
const supabasePublishableKey =
  process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  // Demo Auth is session-only: never store refresh/access tokens in SQLite or
  // unencrypted native storage. Restarting the app requires another sign-in.
  { auth: { persistSession: false, detectSessionInUrl: false } }
);
