import * as repo from '../db/repositories';
import { AppState } from 'react-native';
import { gemmaPoc } from '../../modules/gemma-poc/phone';
import { SensiSetup } from './setup';
export const sensiSetup = new SensiSetup(repo, gemmaPoc, () => AppState.currentState === 'active');
