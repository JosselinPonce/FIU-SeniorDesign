import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cmToFeetInches, inchesToCm, poundsToKg, kgToPounds, measurementsFromMetric, metricMeasurements,
  enterHeightCm, enterWeight, selectHeight, switchHeightUnit, switchWeightUnit } from '../lib/db/profileMeasurements.ts';
import { validateProfile } from '../lib/db/profileEditing.ts';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} differs from ${expected}`);

test('exact unit constants convert feet/inches and decimal pounds to metric', () => {
  near(inchesToCm(5, 10), 177.8);
  near(inchesToCm(6, 0), 182.88);
  near(poundsToKg(150.5), 68.265651685);
  near(kgToPounds(poundsToKg(150.5)), 150.5);
  for (const cm of [12.34, 152.4, 165, 180, 182.88, 999.99]) {
    const height = cmToFeetInches(cm);
    near(inchesToCm(height.feet, height.inches), cm);
  }
});

test('new profiles default to US units and accept optional empty measurements', () => {
  const s = measurementsFromMetric();
  assert.equal(s.heightUnit, 'ft/in'); assert.equal(s.weightUnit, 'lbs');
  assert.deepEqual(metricMeasurements(s), { height_cm: null, weight_kg: null });
  assert.deepEqual(metricMeasurements(switchWeightUnit(switchHeightUnit(s, 'cm'), 'kg')), { height_cm: null, weight_kg: null });
});

test('creating in either system validates the converted saved metrics', () => {
  let us = measurementsFromMetric();
  us = selectHeight(us, 5, 10); us = enterWeight(us, '150.5');
  const usProfile = validateProfile({ display_name: 'US Driver', ...metricMeasurements(us) });
  near(usProfile.height_cm!, 177.8); near(usProfile.weight_kg!, 68.265651685);
  let metric = measurementsFromMetric(null, null, 'cm', 'kg');
  metric = enterHeightCm(metric, '177.8'); metric = enterWeight(metric, '68.265651685');
  const metricProfile = validateProfile({ display_name: 'Metric Driver', ...metricMeasurements(metric) });
  near(metricProfile.height_cm!, usProfile.height_cm!); near(metricProfile.weight_kg!, usProfile.weight_kg!);
});

test('editing and repeated unit switches preserve exact metric values despite rounded display labels', () => {
  for (const [height, weight] of [[180, 80], [165.123456789, 70.123456789], [999.99, 999.99]]) {
    let s = measurementsFromMetric(height, weight);
    near(inchesToCm(s.feet!, s.inches!), height);
    for (let i = 0; i < 100; i++) {
      s = switchHeightUnit(s, 'cm'); s = switchWeightUnit(s, 'kg');
      s = switchHeightUnit(s, 'ft/in'); s = switchWeightUnit(s, 'lbs');
    }
    assert.deepEqual(metricMeasurements(s), { height_cm: height, weight_kg: weight });
    const unchanged = validateProfile({ display_name: 'Unchanged', ...metricMeasurements(s) });
    assert.equal(unchanged.height_cm, height); assert.equal(unchanged.weight_kg, weight);
  }
});

test('edits in either system change only the intended measurement', () => {
  let s = measurementsFromMetric(180, 80);
  s = selectHeight(s, 6, 0);
  near(s.heightCm!, 182.88); assert.equal(s.weightKg, 80);
  s = enterWeight(s, '160.25'); near(s.weightKg!, poundsToKg(160.25));
  s = switchHeightUnit(s, 'cm'); s = enterHeightCm(s, '175.25');
  s = switchWeightUnit(s, 'kg'); s = enterWeight(s, '72.125');
  assert.deepEqual(metricMeasurements(s), { height_cm: 175.25, weight_kg: 72.125 });
});

test('invalid and incomplete fields block saving and switching without silently reusing older measurements', () => {
  const original = measurementsFromMetric(180, 80);
  for (const raw of ['0', '-5', 'abc', '1e2', 'Infinity', '1,500', '999999']) {
    const s = enterWeight(original, raw);
    assert.throws(() => metricMeasurements(s)); assert.throws(() => switchWeightUnit(s, 'kg'));
    assert.equal(s.weightText, raw); assert.equal(original.weightKg, 80);
  }
  let partial = selectHeight(measurementsFromMetric(), 5, null);
  assert.throws(() => metricMeasurements(partial), /Select both/);
  assert.throws(() => switchHeightUnit(partial, 'cm'));
  partial = selectHeight(partial, 5, 0); assert.equal(metricMeasurements(partial).height_cm, 152.4);
  for (const [feet, inches] of [[5, 12], [-1, 1], [33, 0], [0, 0], [32, 11]])
    assert.throws(() => metricMeasurements(selectHeight(original, feet, inches)));
  for (const raw of ['0', '-1', '1000', 'abc']) assert.throws(() => metricMeasurements(enterHeightCm(original, raw)));
  assert.throws(() => metricMeasurements(enterWeight(switchWeightUnit(original, 'kg'), '1000')));
  assert.equal(metricMeasurements(enterWeight(original, '   ')).weight_kg, null);
  assert.equal(metricMeasurements(enterHeightCm(original, '')).height_cm, null);
  assert.equal(metricMeasurements(selectHeight(original, null, null)).height_cm, null);
});

test('selecting the current height or receiving unchanged display text cannot quantize saved values', () => {
  const s = measurementsFromMetric(165.123456789, 70.123456789);
  assert.deepEqual(metricMeasurements(selectHeight(s, s.feet, s.inches)), metricMeasurements(s));
  assert.deepEqual(metricMeasurements(enterWeight(s, s.weightText)), metricMeasurements(s));
  const metric = switchWeightUnit(switchHeightUnit(s, 'cm'), 'kg');
  assert.deepEqual(metricMeasurements(enterHeightCm(metric, metric.heightText)), metricMeasurements(s));
  assert.deepEqual(metricMeasurements(enterWeight(metric, metric.weightText)), metricMeasurements(s));
});
