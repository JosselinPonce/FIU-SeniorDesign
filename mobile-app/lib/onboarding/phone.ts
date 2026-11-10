import * as repo from '../db/repositories';
import { AppState } from 'react-native';
import { gemmaPoc, withGemmaMaintenance } from '../../modules/gemma-poc/phone';
import { SensiSetup } from './setup';
export const sensiSetup = new SensiSetup(repo, {
  get state() { return gemmaPoc.state; },
  subscribe: listener => gemmaPoc.subscribe(listener),
  load: force => gemmaPoc.load(force), provision: () => gemmaPoc.provision(),
  dispose: () => gemmaPoc.dispose(), cancel: () => gemmaPoc.cancel(), maintenance: withGemmaMaintenance,
}, () => AppState.currentState === 'active');
