import {
  createGoodVibesPlatform,
  createMemoryTokenStore,
  type GoodVibesCurrentAuth,
  type GoodVibesLoginOutput,
} from '@goodvibes-jev/engine/platform';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@goodvibes-jev/engine/platform/contracts';
import { createOperatorApiClient } from '@goodvibes-jev/engine/platform/operator';
import { createPeerApiClient } from '@goodvibes-jev/engine/platform/peer';

async function verifyTypedPlatformSurface(): Promise<void> {
  const platformClient = createGoodVibesPlatform({
    baseUrl: 'http://127.0.0.1:3210',
    tokenStore: createMemoryTokenStore(),
  });

  const login: GoodVibesLoginOutput = await platformClient.auth.login({
    username: 'alice',
    password: 'secret',
  });
  const token: string = login.token;

  const current: GoodVibesCurrentAuth = await platformClient.auth.current();
  const authenticated: boolean = current.authenticated;

  const currentViaOperator = await platformClient.operator.control.auth.current();
  const currentPrincipalId: string | null = currentViaOperator.principalId;

  const typedInvokeLogin = await platformClient.operator.invoke('control.auth.login', {
    username: 'alice',
    password: 'secret',
  });
  const typedInvokeToken: string = typedInvokeLogin.token;

  const knowledgeAskMethodId: OperatorTypedMethodId = 'knowledge.ask';
  const refinementTasksMethodId: OperatorTypedMethodId = 'knowledge.refinement.tasks.list';
  const knowledgeAskInput: OperatorMethodInput<'knowledge.ask'> = {
    query: 'what features does the TV have?',
    includeSources: true,
    includeLinkedObjects: true,
  };
  const knowledgeAskOutput = await platformClient.operator.invoke(knowledgeAskMethodId, knowledgeAskInput);
  const typedKnowledgeAskOutput: OperatorMethodOutput<'knowledge.ask'> = knowledgeAskOutput;
  const refinementTasksOutput = await platformClient.operator.invoke(refinementTasksMethodId);
  const typedRefinementTasksOutput: OperatorMethodOutput<'knowledge.refinement.tasks.list'> = refinementTasksOutput;

  const pairRequest = await platformClient.peer.invoke('pair.request', {
    peerKind: 'node',
    label: 'Pixel companion',
    requestedId: 'device-1',
  });
  const challenge: string = pairRequest.challenge;

  void token;
  void authenticated;
  void currentPrincipalId;
  void typedInvokeToken;
  void typedKnowledgeAskOutput;
  void typedRefinementTasksOutput;
  void challenge;
}

void verifyTypedPlatformSurface;

// Verify well-known disposal symbols (using declarations, ES2025 / TC39 explicit resource management)
{
  using operatorApiClient = createOperatorApiClient({ baseUrl: 'http://127.0.0.1:3210' });
  using peerApiClient = createPeerApiClient({ baseUrl: 'http://127.0.0.1:3210' });
  void operatorApiClient;
  void peerApiClient;
}
