import { Linking } from 'react-native';

export function normalizePhone(value: string): string {
  // Preserve digits, a leading +, and international prefixes exactly as entered.
  const phone = value.trim().replace(/[\s().-]/g, '');
  if (!/^\+?[0-9]+$/.test(phone)) {
    throw new Error('Enter a phone number using digits and an optional leading +. Extensions and other symbols are not supported.');
  }
  return phone;
}

export async function openPhone(phone: string): Promise<void> {
  const uri = `tel:${normalizePhone(phone)}`;
  try {
    await Linking.openURL(uri);
  } catch {
    throw new Error('Could not open the phone interface. Check that this device supports phone calls and try again.');
  }
}
