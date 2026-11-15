import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import * as endpoint from '../../runtime/client/operator-endpoint.ts';
import * as pairing from '@goodvibes-jev/engine/platform/platform/pairing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { getSharedHostedSessionFeed, resetSharedHostedSessionFeed } from '../../views/hosted-session-feed.ts';
const guardedFetch=globalThis.fetch;
const attached=new Set<string>();const calls:string[]=[];let failDetach=false;let aborted=0;let streams=0;let output:string[]=[];let history:{role:string;content:string;at?:number}[]=[];let replay='';let historyAsOf:number|undefined;
const record=(id:string)=>({id,workspaceRoot:'/synthetic/work',title:id,status:'idle',detachPolicy:'survive',effectiveDetachPolicy:'survive',attachedClients:attached.has(id)?['synthetic']:[],createdAt:1,updatedAt:1,turnCount:0,messageCount:0,restoredFromDisk:false,contractIds:[]});
const verbs={probe:()=>({available:false,reason:'synthetic'}),async invoke(method:string,input:{sessionId:string}){const id=input.sessionId;calls.push(`${method}:${id}`);if(method==='sessions.hosted.attach'){attached.add(id);return {session:record(id),history,...(historyAsOf===undefined?{}:{historyAsOf})};}if(method==='sessions.hosted.detach'){if(failDetach) throw new Error('synthetic refusal');attached.delete(id);return {session:record(id)};}throw new Error(`unexpected ${method}`);}};
mock.module('../../runtime/client/operator-endpoint.ts',()=>({...endpoint,createDaemonVerbCaller:()=>verbs,resolveControlPlaneBaseUrl:()=> 'http://127.0.0.1:3421',resolveDaemonStateDirectory:()=>'/synthetic/daemon'}));
mock.module('@goodvibes-jev/engine/platform/platform/pairing',()=>({...pairing,getOrCreateCompanionToken:()=>({token:'synthetic-local-fixture'})}));
const {registerHostedRuntimeCommands}=await import('../../input/commands/hosted-runtime.ts');
let registry:CommandRegistry;
const context=():CommandContext=>({platform:{configManager:{}},workspace:{shellPaths:{homeDirectory:'/synthetic',workingDirectory:'/synthetic/work'}},print:(s:string)=>output.push(s),openAgents:()=>{}} as unknown as CommandContext);
const run=(...args:string[])=>registry.execute('hosted',args,context());
beforeEach(()=>{resetSharedHostedSessionFeed();attached.clear();calls.length=0;failDetach=false;aborted=0;streams=0;output=[];history=[];historyAsOf=undefined;replay='';registry=new CommandRegistry();registerHostedRuntimeCommands(registry);globalThis.fetch=(async(input,init)=>{
 const url=String(input);if(url!=='http://127.0.0.1:3421/api/control-plane/events?domains=turn%2Ctools%2Csession'||init?.method!=='GET') return guardedFetch(input,init);
 streams++;return new Response(new ReadableStream<Uint8Array>({start(controller){if(replay) controller.enqueue(new TextEncoder().encode(replay));init?.signal?.addEventListener('abort',()=>{aborted++;controller.close();},{once:true});}}),{headers:{'content-type':'text/event-stream'}});
}) as typeof fetch;});
afterEach(()=>{getSharedHostedSessionFeed().closeStream();globalThis.fetch=guardedFetch;resetSharedHostedSessionFeed();});
test('actual command + actual hosted/SSE stream: detach refusal must expose disconnected feed',async()=>{
 await run('attach','A');expect(streams).toBe(1);expect(getSharedHostedSessionFeed().getState().streaming).toBe(true);
 failDetach=true;await run('detach');await run('status');
 expect(aborted).toBe(1);expect(attached.has('A')).toBe(true);expect(getSharedHostedSessionFeed().getState().streaming).toBe(false);
 expect(output.at(-1)).toContain('no live stream'); expect(output.at(-1)).not.toContain('live event stream open');
 failDetach=false;await run('attach','A');expect(streams).toBe(2);expect(getSharedHostedSessionFeed().getState().streaming).toBe(true);
});

const turnFrame=(ts:number,prompt:string)=>`event: turn\ndata: ${JSON.stringify({type:'TURN_SUBMITTED',sessionId:'A',ts,payload:{prompt}})}\n\n`;
test('actual /hosted attach: a replayed frame the backfill already shows is dropped and a later one is appended',async()=>{
 history=[{role:'user',content:'asked before attach',at:200}];
 replay=turnFrame(150,'older than the history')+turnFrame(200,'asked before attach')+turnFrame(300,'asked after attach');
 const feed=getSharedHostedSessionFeed();
 const seen=new Promise<void>(resolve=>{const stop=feed.subscribe(()=>{if(feed.getState().rows.some(row=>row.text==='asked after attach')){stop();resolve();}});});
 await run('attach','A');await seen;
 expect(feed.getState().rows.map(row=>row.text)).toEqual(['asked before attach','asked after attach']);
});

test('actual /hosted attach: the daemon-supplied historyAsOf drops replayed frames when the history rows carry no time',async()=>{
 history=[{role:'user',content:'asked before attach'}];historyAsOf=200;
 replay=turnFrame(150,'older than the history')+turnFrame(200,'asked before attach')+turnFrame(300,'asked after attach');
 const feed=getSharedHostedSessionFeed();
 const seen=new Promise<void>(resolve=>{const stop=feed.subscribe(()=>{if(feed.getState().rows.some(row=>row.text==='asked after attach')){stop();resolve();}});});
 await run('attach','A');await seen;
 expect(feed.getState().rows.map(row=>row.text)).toEqual(['asked before attach','asked after attach']);
});
