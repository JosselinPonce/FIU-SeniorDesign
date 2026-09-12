import { useState } from 'react';
import {
  Button,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase } from './lib/supabase';
import * as Speech from 'expo-speech';

type PiMessage = {
  heart_rate: number;
  spo2: number;
  status: 'NORMAL' | 'HIGH_HEART_RATE' | 'LOW_HEART_RATE' | 'LOW_SPO2';
  severity: 'normal' | 'warning' | 'critical';
  timestamp: string;
};

export default function App() {
  const [reading, setReading] = useState('');
  const [status, setStatus] = useState('Waiting...');

  const [piMessage, setPiMessage] = useState<PiMessage | null>(null);

function simulatePiMessage() {
  const message: PiMessage = {
    heart_rate: 135,
    spo2: 97,
    status: 'HIGH_HEART_RATE',
    severity: 'warning',
    timestamp: new Date().toISOString(),
  };

  handlePiMessage(message);
}

function handlePiMessage(message: PiMessage) {
  setPiMessage(message);

  if (message.status === 'NORMAL') {
    setStatus('Biometric readings are normal.');
    return;
  }

  setStatus(`Abnormal condition detected: ${message.status}`);

  if (message.status === 'HIGH_HEART_RATE') {
    Speech.speak(
      'An abnormal heart rate has been detected. Are you feeling okay?'
    );
  }
}

  async function sendTestReading() {
    const numericReading = Number(reading);

    if (reading.trim() === '' || Number.isNaN(numericReading)) {
      setStatus('Please enter a valid number.');
      return;
    }

    setStatus('Sending...');

    const { error } = await supabase
      .from('test_readings')
      .insert({
        value: numericReading,
        device_name: 'test-iphone',
      });

    if (error) {
      console.error(error);
      setStatus(`Error: ${error.message}`);
      return;
    }

    setStatus(`Reading ${numericReading} sent successfully!`);
    setReading('');
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sensor Test App</Text>

      <TextInput
        style={styles.input}
        placeholder="Enter test reading"
        keyboardType="decimal-pad"
        value={reading}
        onChangeText={setReading}
      />

      <Button
        title="SEND TEST READING"
        onPress={sendTestReading}
      />

      <Button
        title="SIMULATE PI MESSAGE"
        onPress={simulatePiMessage}
      />

      {piMessage && (
        <View>
        <Text>Heart Rate: {piMessage.heart_rate} BPM</Text>
        <Text>SpO₂: {piMessage.spo2}%</Text>
        <Text>Status: {piMessage.status}</Text>
        <Text>Severity: {piMessage.severity}</Text>
        </View>
      )}

      <Text style={styles.status}>{status}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
    padding: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
  },
  input: {
    width: '80%',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    fontSize: 18,
  },
  status: {
    fontSize: 16,
    textAlign: 'center',
  },
});
