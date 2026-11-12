import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import { displayBmi, driverInitials } from '../lib/ui/profileSummary.ts';
import { inchesToCm, poundsToKg, measurementsFromMetric, enterWeight, enterHeightCm, metricMeasurements } from '../lib/db/profileMeasurements.ts';
test('display BMI handles realistic metric and imperial inputs without changing stored measurements', () => {
  assert.equal(displayBmi(65, 165), 23.9);
  assert.equal(displayBmi(poundsToKg(180), inchesToCm(5, 10)), 25.8);
  let entry = measurementsFromMetric(null, null, 'cm', 'kg'); entry = enterHeightCm(entry, '165'); entry = enterWeight(entry, '65');
  assert.deepEqual(metricMeasurements(entry), { height_cm: 165, weight_kg: 65 });
  for (const pair of [[null,165],[65,null],[NaN,165],[65,Infinity],[65,0],[65,-165],[65,1.6],[999,5]] as const) assert.equal(displayBmi(pair[0], pair[1]), null);
  assert.equal(driverInitials('  María García López '), 'MG');
});
test('Subject ID stays internal and confirmation/editing preserve UUID and saved team labels', () => {
  const picker = readFileSync(new NodeURL('../components/DriverPicker.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(picker, /Subject ID|p\.custom_id|input\('custom_id'/);
  assert.match(picker, /custom_id: editing\?\.custom_id \?\? props.editProfile\?\.custom_id \?\? null/);
  const confirmation = readFileSync(new NodeURL('../components/DriverConfirmation.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(confirmation, /custom_id|Subject ID/); assert.match(confirmation, /onEdit/);
});
