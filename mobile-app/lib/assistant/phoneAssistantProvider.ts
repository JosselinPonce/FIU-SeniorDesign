import { sensiSupabase } from './sensiSupabase';
import { uuidv4 } from '../ble/protocol';
import { checkDriverAssistantAvailability, interpretConversation, cancelDriverInterpretation } from '../../modules/local-foundation-models';
import { connectedAssistantProvider } from './connectedProvider';
import { localAssistantProvider, selectAssistantProvider } from './provider';

/** Production wiring only; importing creates no provider, Auth request or function call. */
export function phoneAssistantProvider(mode: 'local' | 'connected', onInvalidated: () => void) {
  return selectAssistantProvider(mode, {
    local: () => localAssistantProvider({ check: checkDriverAssistantAvailability,
      interpret: interpretConversation, cancel: cancelDriverInterpretation }),
    connected: () => connectedAssistantProvider(sensiSupabase, { requestId: uuidv4, onInvalidated }),
  });
}
