/**
 * Choose who is driving, or add a new driver. Selecting a driver is how the
 * app knows whose baseline to compare against (proposal: user profiles).
 */
import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { measurementsFromMetric, enterWeight, enterHeightCm, selectHeight, switchHeightUnit, switchWeightUnit,
  metricMeasurements, measurementLabel, type HeightUnit, type WeightUnit } from '../lib/db/profileMeasurements';
import { profileFormValues } from '../lib/db/profileEditing';
import * as repo from '../lib/db/repositories';
import { deleteDriverEverywhere } from '../lib/db/deletion';
import type { DriverProfile, Gender } from '../lib/db/repositories';
import { CONDITIONS, MEDICATIONS, bmi, bmiCategory } from '../lib/analysis/profileModel';
import { Btn, C, Card, SectionTitle } from './ui';

const GENDERS: { key: Gender; label: string }[] = [
  { key: 'male', label: 'Male' },
  { key: 'female', label: 'Female' },
  { key: 'other', label: 'Other' },
  { key: 'prefer_not_to_say', label: 'Prefer not' },
];

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

export function DriverPicker(props: {
  profiles: DriverProfile[];
  onPick: (p: DriverProfile) => void;
  onCreated: () => Promise<void>;
  editProfile?: DriverProfile;
  onSaveProfile?: (input: repo.NewProfileInput) => Promise<void>;
  onCancelEdit?: () => void;
}) {
  const [adding, setAdding] = useState(!!props.editProfile || props.profiles.length === 0);
  const [editing, setEditing] = useState<DriverProfile | null>(null);
  const blank = { custom_id: '', display_name: '', weight_kg: '', age: '', height_cm: '', emergency_name: '', emergency_phone: '' };
  const [form, setForm] = useState(blank);
  const [measurements, setMeasurements] = useState(() => measurementsFromMetric());
  const [heightSelector, setHeightSelector] = useState<'feet' | 'inches' | null>(null);
  const [gender, setGender] = useState<Gender | null>(null);
  const [conditions, setConditions] = useState<string[]>([]);
  const [medications, setMedications] = useState<string[]>([]);
  const [language, setLanguage] = useState<'en' | 'es'>('en');
  const toggle = (list: string[], set: (v: string[]) => void, key: string) =>
    set(list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);
  const liveBmi = bmi(measurements.weightKg, measurements.heightCm);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Blank stays null rather than becoming 0: an unrecorded weight and a weight
  // of zero are different facts.
  function optionalNumber(raw: string, label: string): number | null {
    const t = raw.trim();
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive number.`);
    return n;
  }

  /** Long-press a driver: reopen the form with their details. */
  function edit(p: DriverProfile) {
    setEditing(p);
    const values = profileFormValues(p);
    setForm(values.form);
    setMeasurements(measurementsFromMetric(p.height_cm, p.weight_kg));
    setGender(values.gender);
    setConditions(values.conditions);
    setMedications(values.medications);
    setLanguage(values.language);
    setAdding(true);
  }

  useEffect(() => { if (props.editProfile) edit(props.editProfile); }, [props.editProfile]);

  async function create() {
    try {
      setError(null);
      if (!form.display_name.trim()) {
        setError('Please enter a name.');
        return;
      }
      setBusy(true);
      const save = props.onSaveProfile ?? (editing ? (input: repo.NewProfileInput) => repo.updateProfile(editing.id, input, editing.updated_at) : repo.createProfile);
      await save({
        custom_id: form.custom_id,
        display_name: form.display_name,
        ...metricMeasurements(measurements),
        age: optionalNumber(form.age, 'Age'),
        gender,
        conditions,
        medications,
        language,
        emergency_name: form.emergency_name,
        emergency_phone: form.emergency_phone,
      });
      if (props.onSaveProfile) return;
      setForm(blank);
      setMeasurements(measurementsFromMetric());
      setGender(null);
      setConditions([]);
      setMedications([]);
      setLanguage('en');
      setEditing(null);
      setAdding(false);
      await props.onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const input = (key: keyof typeof form, placeholder: string, numeric = false) => (
    <TextInput
      style={st.input}
      placeholder={placeholder}
      placeholderTextColor={C.faint}
      keyboardType={numeric ? 'decimal-pad' : 'default'}
      accessibilityLabel={key === 'emergency_name' ? 'Emergency contact name' : key === 'emergency_phone' ? 'Emergency contact phone' : placeholder}
      editable={!busy}
      value={form[key]}
      onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
    />
  );

  return (
    <ScrollView contentContainerStyle={st.container} automaticallyAdjustKeyboardInsets={true} keyboardDismissMode="interactive" keyboardShouldPersistTaps="handled">
      <Text style={st.hello}>{props.editProfile ? 'Edit Driver Profile' : "Who's driving?"}</Text>
      <Text style={st.lead}>{props.editProfile ? 'Changes apply to this driver. Existing drives, calibration and learned baselines are preserved.' : <>
        Pick a driver so readings are saved to the right profile and compared with their usual range. Long-press a driver to
        edit their profile.
      </>}</Text>

      {(props.editProfile ? [] : props.profiles).map((p) => (
        <Pressable
          key={p.id}
          accessibilityRole="button"
          onPress={() => props.onPick(p)}
          onLongPress={() => edit(p)}
          accessibilityHint="Long-press to edit this driver's profile"
          style={({ pressed }) => [st.driver, pressed && { opacity: 0.7 }]}
        >
          <View style={st.avatar}>
            <Text style={st.avatarText}>{initials(p.display_name)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={st.name}>{p.display_name}</Text>
            <Text style={st.meta}>
              {[
                p.custom_id,
                p.age ? `${p.age} y` : null,
                bmi(p.weight_kg, p.height_cm) ? `BMI ${bmi(p.weight_kg, p.height_cm)}` : null,
                repo.parseList(p.conditions).length ? `${repo.parseList(p.conditions).length} condition(s)` : null,
                p.language === 'es' ? 'Español' : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'No details'}
            </Text>
          </View>
          <Text style={st.chev}>›</Text>
        </Pressable>
      ))}

      {!adding ? (
        <Btn title="+ Add a driver" kind="ghost" onPress={() => { setMeasurements(measurementsFromMetric()); setAdding(true); }} />
      ) : (
        <Card>
          <SectionTitle>{editing ? `Edit ${editing.display_name}` : 'New driver'}</SectionTitle>
          {input('display_name', 'Name *')}
          {input('custom_id', 'Subject ID (e.g. SUBJ-001)')}
          {input('age', 'Age', true)}
          <Text style={st.label}>Height (optional)</Text>
          <View style={st.genders}>{(['ft/in', 'cm'] as HeightUnit[]).map(unit =>
            <Pressable key={unit} accessibilityRole="radio" accessibilityLabel={`Height unit ${unit}`}
              accessibilityState={{ selected: measurements.heightUnit === unit }} disabled={busy}
              style={[st.chip, measurements.heightUnit === unit && st.chipOn]}
              onPress={() => { try { setMeasurements(switchHeightUnit(measurements, unit)); setError(null); }
                catch (e) { setError((e as Error).message); } }}>
              <Text style={[st.chipText, measurements.heightUnit === unit && st.chipTextOn]}>{unit}</Text>
            </Pressable>)}</View>
          {measurements.heightUnit === 'cm' ? <TextInput style={st.input} placeholder="Height cm" accessibilityLabel="Height centimeters"
            placeholderTextColor={C.faint} keyboardType="decimal-pad" editable={!busy} value={measurements.heightText}
            onChangeText={text => setMeasurements(s => enterHeightCm(s, text))} /> :
            <View style={{ gap: 8 }}><View style={st.row3}>
              <Btn style={{ flex: 1 }} title={measurements.feet == null ? 'Select feet' : `${measurements.feet} ft`} disabled={busy} onPress={() => setHeightSelector('feet')} />
              <Btn style={{ flex: 1 }} title={measurements.inches == null ? 'Select inches' : `${measurementLabel(measurements.inches)} in`} disabled={busy} onPress={() => setHeightSelector('inches')} />
            </View>
              <Btn title="Clear height" kind="ghost" disabled={busy} onPress={() => setMeasurements(s => selectHeight(s, null, null))} />
            </View>}
          {measurements.heightError ? <Text style={st.error}>{measurements.heightError}</Text> : null}
          <Text style={st.label}>Weight (optional)</Text>
          <View style={st.genders}>{(['lbs', 'kg'] as WeightUnit[]).map(unit =>
            <Pressable key={unit} accessibilityRole="radio" accessibilityLabel={`Weight unit ${unit}`}
              accessibilityState={{ selected: measurements.weightUnit === unit }} disabled={busy}
              style={[st.chip, measurements.weightUnit === unit && st.chipOn]}
              onPress={() => { try { setMeasurements(switchWeightUnit(measurements, unit)); setError(null); }
                catch (e) { setError((e as Error).message); } }}>
              <Text style={[st.chipText, measurements.weightUnit === unit && st.chipTextOn]}>{unit}</Text>
            </Pressable>)}</View>
          <TextInput style={st.input} placeholder={`Weight ${measurements.weightUnit}`} accessibilityLabel={`Weight ${measurements.weightUnit}`}
            placeholderTextColor={C.faint} keyboardType="decimal-pad" editable={!busy} value={measurements.weightText}
            onChangeText={text => setMeasurements(s => enterWeight(s, text))} />
          {measurements.weightError ? <Text style={st.error}>{measurements.weightError}</Text> : null}
          <Text style={st.hint}>Unit switches preserve the exact measurement. Display values may be rounded; saved values stay in cm and kg.</Text>
          <Modal visible={heightSelector !== null} transparent animationType="fade" onRequestClose={() => setHeightSelector(null)}>
            <View style={st.selectorBackdrop}><Card style={st.selectorCard}>
              <SectionTitle>Select {heightSelector}</SectionTitle>
              <ScrollView>
                {(heightSelector === 'feet' ? Array.from({ length: 33 }, (_, i) => i) :
                  [...Array.from({ length: 12 }, (_, i) => i), ...(measurements.inches != null && !Number.isInteger(measurements.inches) ? [measurements.inches] : [])].sort((a,b) => a-b))
                  .map(value => <Btn key={value} title={`${measurementLabel(value)} ${heightSelector === 'feet' ? 'ft' : 'in'}`}
                    kind="ghost" onPress={() => {
                      setMeasurements(s => selectHeight(s, heightSelector === 'feet' ? value : s.feet,
                        heightSelector === 'inches' ? value : s.inches));
                      setHeightSelector(null);
                    }} />)}
              </ScrollView>
              <Btn title="Cancel" kind="ghost" onPress={() => setHeightSelector(null)} />
            </Card></View>
          </Modal>
          {liveBmi ? (
            <Text style={st.hint}>
              BMI {liveBmi} · {bmiCategory(liveBmi)} (calculated from height and weight)
            </Text>
          ) : null}
          <View style={st.genders}>
            {GENDERS.map((g) => (
              <Pressable
                key={g.key}
                disabled={busy}
                onPress={() => setGender(gender === g.key ? null : g.key)}
                style={[st.chip, gender === g.key && st.chipOn]}
              >
                <Text style={[st.chipText, gender === g.key && st.chipTextOn]}>{g.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={st.label}>Health conditions (optional)</Text>
          <Text style={st.hint}>Used to set what heart rate is normal for this driver. Stays with the profile.</Text>
          <View style={st.genders}>
            {CONDITIONS.map((c) => (
              <Pressable
                key={c.key}
                disabled={busy}
                onPress={() => toggle(conditions, setConditions, c.key)}
                style={[st.chip, conditions.includes(c.key) && st.chipOn]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: conditions.includes(c.key) }}
              >
                <Text style={[st.chipText, conditions.includes(c.key) && st.chipTextOn]}>{c.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={st.label}>Medications (optional)</Text>
          <View style={st.genders}>
            {MEDICATIONS.map((m) => (
              <Pressable
                key={m.key}
                disabled={busy}
                onPress={() => toggle(medications, setMedications, m.key)}
                style={[st.chip, medications.includes(m.key) && st.chipOn]}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: medications.includes(m.key) }}
              >
                <Text style={[st.chipText, medications.includes(m.key) && st.chipTextOn]}>{m.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={st.label}>Voice check language</Text>
          <View style={st.genders}>
            {(
              [
                ['en', 'English'],
                ['es', 'Español'],
              ] as ['en' | 'es', string][]
            ).map(([k, label]) => (
              <Pressable key={k} disabled={busy} onPress={() => setLanguage(k)} style={[st.chip, language === k && st.chipOn]}>
                <Text style={[st.chipText, language === k && st.chipTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={st.label}>Emergency contact (optional, stays on this phone)</Text>
          {input('emergency_name', 'Name')}
          {input('emergency_phone', 'Phone', false)}
          {!form.emergency_phone.trim() ? <Text style={st.hint}>No emergency contact number is configured. Saved-contact phone handoff will be unavailable.</Text> : null}
          {error ? <Text style={st.error}>{error}</Text> : null}
          <Btn title="Save driver" onPress={create} busy={busy} />
          {editing && !props.editProfile ? (
            <Btn
              title={`Delete ${editing.display_name}`}
              kind="danger"
              onPress={() =>
                Alert.alert(
                  `Delete ${editing.display_name}?`,
                  'This removes the driver and every drive, reading, alert and waveform recorded for them — on this phone and on the dashboard. It cannot be undone.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    {
                      text: 'Delete everywhere',
                      style: 'destructive',
                      onPress: async () => {
                        setBusy(true);
                        const where = await deleteDriverEverywhere(editing.id);
                        setBusy(false);
                        setEditing(null);
                        setAdding(false);
                        setForm(blank);
                setMeasurements(measurementsFromMetric());
                        await props.onCreated();
                        if (where === 'queued') {
                          Alert.alert('Deleted on this phone', 'The dashboard copy will be deleted automatically the next time the phone is online.');
                        }
                      },
                    },
                  ],
                )
              }
            />
          ) : null}
          {props.profiles.length ? <Btn
              title="Cancel"
              kind="ghost"
              disabled={busy}
              onPress={() => {
                if (props.onCancelEdit) { props.onCancelEdit(); return; }
                setAdding(false);
                setEditing(null);
                setForm(blank);
                setMeasurements(measurementsFromMetric());
              }}
            /> : null}
        </Card>
      )}
    </ScrollView>
  );
}

const st = StyleSheet.create({
  selectorBackdrop: { flex: 1, backgroundColor: '#0006', justifyContent: 'center', padding: 20 },
  selectorCard: { maxHeight: '70%' },
  container: { padding: 20, paddingTop: 70, gap: 12, backgroundColor: C.bg, flexGrow: 1 },
  hello: { fontSize: 30, fontWeight: '800', color: C.ink },
  lead: { fontSize: 15, color: C.sub, marginBottom: 6, lineHeight: 21 },
  driver: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    backgroundColor: C.card,
    padding: 14,
    borderRadius: 18,
    shadowColor: '#0f172a',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: C.brandSoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: C.brand, fontWeight: '800', fontSize: 17 },
  name: { fontSize: 18, fontWeight: '700', color: C.ink },
  meta: { fontSize: 13, color: C.sub, marginTop: 2 },
  chev: { fontSize: 28, color: C.faint },
  input: { borderWidth: 1, borderColor: C.line, borderRadius: 12, padding: 12, fontSize: 16, color: C.ink, backgroundColor: '#fff' },
  row3: { flexDirection: 'row', gap: 8 },
  genders: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: C.line },
  chipOn: { backgroundColor: C.brand, borderColor: C.brand },
  chipText: { color: C.sub, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  error: { color: C.bad },
  label: { fontSize: 14, fontWeight: '700', color: C.ink, marginTop: 6 },
  hint: { fontSize: 12, color: C.sub },
});
