import { expect, test } from 'bun:test';
import { createTerminalCommandRegistry } from '../terminal-shell/src/command-registry.ts';

test('nested dispatch across independently composed registries cannot mint a new keyboard owner', async () => {
  const a = createTerminalCommandRegistry<{invokedByModel?: boolean}>();
  const b = createTerminalCommandRegistry<{invokedByModel?: boolean}>();
  const outer = new a.CommandRegistry(), inner = new b.CommandRegistry();
  const owners: boolean[] = [];
  inner.register({name:'effect',description:'Synthetic owner-only effect',handler:(_args,ctx)=>{owners.push(b.isDirectOwnerCommandContext(ctx,'effect'));}});
  outer.register({name:'relay',description:'Synthetic nested dispatch',handler:async(_args,ctx)=>{await inner.executeFromOwner('effect',[],ctx);await inner.executeFromOwner('effect',[],{...ctx});}});
  await outer.executeFromOwner('relay',[],{});
  await inner.executeFromOwner('effect',[],{});
  await inner.executeFromOwner('effect',[],{invokedByModel:true});
  expect(owners).toEqual([false,false,true,false]);
});
