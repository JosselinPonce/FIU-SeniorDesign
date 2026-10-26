import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SENSI_MODE } from '../lib/assistant/mode.ts';
import { approvedAcknowledgment } from '../lib/assistant/safetyAcknowledgment.ts';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
function files(path: string): string[] { return readdirSync(path, { withFileTypes: true }).flatMap(item => item.isDirectory() ? files(join(path, item.name)) : [join(path, item.name)]); }
const shipped = ['components', 'lib', 'modules'].flatMap(dir => files(join(root, dir))).filter(path => /\.(tsx?|swift)$/.test(path));

test('application source has no OpenAI transport or imports of retired test fixtures', () => {
  for (const path of shipped) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /api\.openai\.com|functions\.invoke\(['"]driver-assistant|from ['"][^'"]*retired-ai|OPENAI_API_KEY/, path);
    assert.doesNotMatch(source, /from ['"][^'"]*(?:connectedProvider|phoneAssistantProvider|phoneConnectedReadiness|connectedReadiness)['"]/, path);
  }
});
test('Apple language-model implementation and exports are absent while native speech survives', () => {
  assert.equal(existsSync(join(root, 'modules/local-foundation-models/ios/DriverResponseInterpreter.swift')), false);
  for (const path of shipped.filter(path => path.endsWith('.swift'))) {
    assert.doesNotMatch(readFileSync(path, 'utf8'), /import FoundationModels|SystemLanguageModel|LanguageModelSession/, path);
  }
  const bridge = read('modules/local-foundation-models/ios/LocalFoundationModelsModule.swift');
  assert.doesNotMatch(bridge, /interpretDriverResponse|interpretConversation|cancelInterpretation|checkAvailability/);
  for (const method of ['listenOffline', 'cancelOfflineListening', 'checkOfflineSpeechCapability', 'listLocalVoices', 'speakLocal', 'cancelLocalSpeech']) assert.ok(bridge.includes(`AsyncFunction("${method}")`));
  assert.doesNotMatch(read('modules/local-foundation-models/index.ts'), /export (?:async )?function (?:interpretConversation|interpretDriverResponse|checkFoundationModelsAvailability)/);
});
test('Gemma is fixed in production wiring; persisted legacy mode cannot select a provider', () => {
  assert.equal(SENSI_MODE, 'gemma');
  const hook = read('lib/hooks/useDriveSession.ts');
  assert.match(hook, /assistantMode: \(\) => SENSI_MODE/); assert.match(hook, /voiceIO: phoneSensiVoiceIO/);
  assert.doesNotMatch(hook, /setSafetyAssistantMode|safetyAssistantMode\.current/);
  assert.doesNotMatch(read('components/SmartWheelScreen.tsx'), /assistantModeSettings|modeSettings|selectAssistantMode|LocalAITest|<DriverAssistant/);
});
test('Settings contains no provider selector/readiness/sign-in but retains voices, rehearsal and Gemma diagnostic', () => {
  const settings = read('components/SettingsView.tsx');
  assert.doesNotMatch(settings, /ASSISTANT_MODES|Assistant Mode|Connected AI|Local AI|DemoAuthPanel|PHONE_CONNECTED_READINESS|onAssistantModeChange/);
  for (const term of ['Sensi · Gemma on-device', '<VoicePicker', 'd.rehearseVoice()', 'props.gemmaDiagnostics']) assert.ok(settings.includes(term), term);
  assert.match(read('components/SmartWheelScreen.tsx'), /const GemmaDiagnostic = __DEV__ \?/);
});
test('retired implementations are removed from production locations, and no ordinary conversation UI remains', () => {
  for (const path of ['components/DriverAssistant.tsx', 'components/DemoAuthPanel.tsx', 'modules/local-foundation-models/LocalAITest.tsx', 'modules/local-foundation-models/VoiceConversationTest.tsx',
    'lib/assistant/provider.ts', 'lib/assistant/connectedProvider.ts', 'lib/assistant/phoneAssistantProvider.ts', 'lib/assistant/connectedReadiness.ts', 'lib/assistant/phoneConnectedReadiness.ts', 'lib/assistant/connectedPilotPolicy.ts']) assert.equal(existsSync(join(root, path)), false, path);
  assert.doesNotMatch(read('components/SensiStandby.tsx'), /TextInput|interpretConversation|\.generate\(/);
});
test('Gemma uses the same verified runtime with bounded allowlisted output and deterministic fallback', () => {
  assert.match(read('modules/gemma-poc/phone.ts'), /initLlama/); assert.match(read('modules/gemma-poc/phone.ts'), /verifiedModel\.verify/);
  assert.match(read('modules/gemma-poc/controller.ts'), /CONCERN_ACK_PROMPT/); assert.match(read('modules/gemma-poc/controller.ts'), /1500/);
  assert.equal(approvedAcknowledgment('Call your contact now, you have a medical condition.', 'en'), approvedAcknowledgment(null, 'en'));
  assert.match(read('lib/voice/speechIO.ts'), /listenOffline/); assert.match(read('components/VoicePicker.tsx'), /listVoices/);
});
test('mandatory onboarding and non-AI Supabase authentication/recording services stay intact', () => {
  assert.match(read('components/SmartWheelScreen.tsx'), /!setupState.ready && !ongoing/);
  assert.match(read('lib/onboarding/setup.ts'), /!this.state.notices \|\| !this.state.terms/);
  assert.match(read('components/DemoStartup.tsx'), /sensiSupabase.auth/);
  for (const file of ['profileSync', 'liveSync', 'deletion']) {
    assert.match(read(`lib/db/${file}.ts`), /import \{ supabase \} from '..\/supabase'/);
    assert.doesNotMatch(read(`lib/db/${file}.ts`), /sensiSupabase/);
  }
  const pkg = JSON.parse(read('package.json'));
  for (const dependency of ['llama.rn', 'expo-speech', 'expo-speech-recognition', '@supabase/supabase-js', 'expo-secure-store']) assert.ok(pkg.dependencies[dependency]);
  assert.equal(pkg.dependencies.openai, undefined);
  assert.ok(pkg.dependencies['@noble/hashes'], 'recording archive hashing remains a shared dependency');
});
