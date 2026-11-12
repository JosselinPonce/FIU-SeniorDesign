import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRealContactPreference, saveRealContactPreference, REAL_CONTACT_DEMO_SETTING } from '../lib/voice/realContactPreference.ts';
import { hasSystemPhoneConfirmation } from '../lib/voice/phoneHandoff.ts';
test('feature preference defaults off; strict boolean local value restores and contains no contact/authorization', async () => {
  for (const raw of [null,'','true','yes','{}','0']) assert.equal(await readRealContactPreference(async () => raw),false);
  const settings = new Map<string,string>();
  await saveRealContactPreference(async (k,v) => { settings.set(k,v); },true);
  assert.equal(await readRealContactPreference(async k => settings.get(k) ?? null),true);
  assert.deepEqual([...settings],[[REAL_CONTACT_DEMO_SETTING,'1']]);
  await saveRealContactPreference(async (k,v) => { settings.set(k,v); },false);
  assert.equal(await readRealContactPreference(async k => settings.get(k) ?? null),false);
});
test('settings failures propagate so the UI cannot claim a saved/restored enablement', async () => {
  await assert.rejects(readRealContactPreference(async () => { throw Error('storage'); }),/storage/);
  await assert.rejects(saveRealContactPreference(async () => { throw Error('storage'); },true),/storage/);
});
test('system confirmation assurance is limited to documented iOS versions', () => {
  for (const version of [10.3,15.1,26,'26.6.2']) assert.equal(hasSystemPhoneConfirmation('ios',version),true);
  for (const [os,version] of [['ios',10.2],['ios','unknown'],['android',26],['web',26]] as const) assert.equal(hasSystemPhoneConfirmation(os,version),false);
});
