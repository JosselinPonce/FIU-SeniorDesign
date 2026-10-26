// Historical test fixture only. Never import from application code.
import { sensiSupabase } from '../../../../lib/assistant/sensiSupabase';
import { uuidv4 } from '../../../../lib/ble/protocol';
import { checkDriverAssistantAvailability, interpretConversation, cancelDriverInterpretation } from '../../modules/local-foundation-models';
import { connectedAssistantProvider } from './connectedProvider';
import { PHONE_CONNECTED_READINESS } from './phoneConnectedReadiness';
import { localAssistantProvider, selectAssistantProvider } from './provider';

/** Production wiring only; importing creates no provider, Auth request or function call. */
export function phoneAssistantProvider(mode: 'local' | 'connected', onInvalidated: () => void) {
  return selectAssistantProvider(mode, {
    local: () => localAssistantProvider({ check: checkDriverAssistantAvailability,
      interpret: interpretConversation, cancel: cancelDriverInterpretation }),
    connected: () => connectedAssistantProvider(sensiSupabase, { requestId: uuidv4, onInvalidated, readiness: PHONE_CONNECTED_READINESS }),
  });
}
