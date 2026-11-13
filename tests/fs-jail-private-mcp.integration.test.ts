/** Actual bwrap native child + maintained Hub stdio SDK + trusted HTTP relay. No inference. */
import { createHash } from 'node:crypto'
import { mkdir,mkdtemp,readFile,readdir,realpath,rm,writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname,join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HubClient } from '@tangle-network/hub-sdk'
import { expect,it,vi } from 'vitest'
import { LinuxBwrapJail } from '../src/jail/linux-bwrap.js'
import { loadConfig,startServer } from '../src/server.js'

const native = String.raw`
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),readline=require('node:readline');
if(process.argv.includes('--version')){console.log('native-protocol 1.0.0');process.exit(0)}
async function main(){
 const claude=process.argv.includes('--mcp-config');let servers;
 if(claude)servers=JSON.parse(fs.readFileSync(process.argv[process.argv.indexOf('--mcp-config')+1],'utf8')).mcpServers;
 else{
  const toml=fs.readFileSync(path.join(process.env.CODEX_HOME,'config.toml'),'utf8');
  const block=name=>new RegExp('\\[mcp_servers\\.'+name+'\\]([\\s\\S]*?)(?=\\n\\[|$)').exec(toml)?.[1]??'';
  const str=(part,key)=>JSON.parse(new RegExp(key+'\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")').exec(part)[1]);
  const stdio=name=>{const part=block(name);return{command:str(part,'command'),args:JSON.parse(/args\s*=\s*(\[[^\n]*\])/.exec(part)[1]),env:Object.fromEntries([...part.matchAll(/([A-Z_]+) = ("(?:[^"\\]|\\.)*")/g)].map(m=>[m[1],JSON.parse(m[2])]))}};
  servers={hub:stdio('hub'),local:stdio('local'),coord:{url:str(block('coord'),'url')}};
 }
 const children=[];
 try{
  async function rpc(server){
   const child=cp.spawn(server.command,server.args,{env:{...process.env,...server.env},stdio:['pipe','pipe','pipe']});children.push(child);child.stderr.pipe(process.stderr);
   const pending=new Map();readline.createInterface({input:child.stdout}).on('line',line=>{const reply=JSON.parse(line);pending.get(reply.id)?.(reply)});
   let id=0;const call=(method,params)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,reply=>{pending.delete(key);reply.error?reject(new Error('MCP returned error')):resolve(reply.result)});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:key,method,params})+'\n')});
   await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'native-protocol-proof',version:'1'}});
   child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');return call;
  }
  const local=await rpc(servers.local);const localResult=await local('tools/call',{name:'private',arguments:{}});
  const hub=await rpc(servers.hub);const listed=await hub('tools/list',{});if(!listed.tools?.length)throw new Error('Hub tools absent');
  const invoked=await hub('tools/call',{name:listed.tools[0].name,arguments:{proof:true}});if(invoked.isError)throw new Error('Hub tool refused');
  const coord=await fetch(servers.coord.url,{method:'POST',headers:{Authorization:'Bearer ignored-native-header'},body:'owned-coordination-call'});if(coord.status!==200)throw new Error('Coordination denied');
  const canonical=fs.readFileSync('canonical-coordination','utf8');
  let escaped=false;try{const response=await fetch(canonical,{method:'POST',signal:AbortSignal.timeout(1000)});escaped=true}catch{}
  if(escaped)throw new Error('Native process escaped to original host loopback');
  const echo=JSON.stringify([localResult,await coord.text(),servers.hub.env.TANGLE_HUB_MCP_ENDPOINT,servers.coord.url]);
  const id='00000000-0000-4000-8000-000000000042';
  const home=claude?path.join(process.env.HOME,'.claude'):process.env.CODEX_HOME;
  const directory=path.join(home,claude?'projects/owned-native':'sessions/2026/11/12');fs.mkdirSync(directory,{recursive:true});
  const vendor=path.join(directory,claude?id+'.jsonl':'rollout-2026-11-12T00-00-00-'+id+'.jsonl');
  const records=claude?[{type:'user',sessionId:id,cwd:process.cwd(),message:{role:'user',content:'private native proof'}},{type:'assistant',sessionId:id,message:{role:'assistant',content:[{type:'text',text:echo}]}}]:[{type:'session_meta',payload:{id,cwd:process.cwd()}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:echo}]}}];
  fs.writeFileSync(vendor,records.map(record=>JSON.stringify(record)).join('\n')+'\n');fs.writeFileSync('vendor-path',vendor);
  const events=claude?[{type:'system',subtype:'init',session_id:id},{type:'assistant',message:{content:[{type:'text',text:echo}]}},{type:'result',subtype:'success',session_id:id,usage:{input_tokens:0,output_tokens:0}}]:[{type:'thread.started',thread_id:id},{type:'item.completed',item:{type:'agent_message',text:echo}},{type:'turn.completed',usage:{input_tokens:0,output_tokens:0}}];
  for(const event of events){const bytes=Buffer.from(JSON.stringify(event)+'\n');for(let at=0;at<bytes.length;at+=7){process.stdout.write(bytes.subarray(at,at+7));await new Promise(resolve=>setImmediate(resolve))}}
 }finally{for(const child of children)child.kill('SIGTERM')}
}main().catch(()=>{console.error('native trusted-service protocol failed');process.exitCode=1});
`

async function files(directory:string):Promise<Buffer[]> {
  const result:Buffer[]=[];
  for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await files(path));else if(entry.isFile())result.push(await readFile(path))}
  return result;
}

it.skipIf(!new LinuxBwrapJail().isAvailable()).each(['claude-code','codex'] as const)('keeps %s private tools scoped through an actual filesystem jail',async harness=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'native-private-jail-'))),workspace=join(root,'workspace'),state=join(root,'state'),capture=join(root,'frames');
 await mkdir(workspace);await mkdir(capture,{mode:0o700});vi.stubEnv('BRIDGE_RAW_CAPTURE_DIR',capture);
 const toolSecret='private-stdio-canary-39ad',coordSecret='private-coordination-canary-81ce',hubKey='private-hub-key-canary-21dc';
 const tokens:string[]=[];let hubCalls=0,coordCalls=0;
 const upstream=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  if(req.url==='/mcp'){if(req.method!=='POST'||req.headers.authorization!==`Bearer ${coordSecret}`){res.writeHead(403).end();return}coordCalls++;res.end(coordSecret);return}
  if(req.headers.authorization!==`Bearer ${hubKey}`){res.writeHead(403).end();return}
  const data=req.url==='/v1/hub/connections'?{connections:[{id:'hubconn_fixture',providerId:'fixture',status:'active'}]}:req.url==='/v1/hub/tools/describe'?{tool:{path:'fixture.proof',requiredConnectionProviderId:'fixture',inputSchema:{type:'object'}}}:req.url==='/v1/hub/exec'?(hubCalls++,{result:{ok:JSON.parse(body).connectionId==='hubconn_fixture'}}):undefined;
  res.writeHead(data?200:404,{'content-type':'application/json'}).end(JSON.stringify({success:!!data,data}));
 });
 await new Promise<void>(resolve=>upstream.listen(0,'127.0.0.1',resolve));const address=upstream.address();if(!address||typeof address==='string')throw new Error('tool peer did not bind');
 const coordUrl=`http://127.0.0.1:${address.port}/mcp`,bin=join(workspace,'native.cjs'),tool=join(workspace,'private-tool.cjs');
 await writeFile(bin,`#!${process.execPath}\n${native}`,{mode:0o700});
 await writeFile(join(workspace,'canonical-coordination'),coordUrl);
 await writeFile(tool,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const r=JSON.parse(line);if(!r.id)return;const result=r.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'private-tool',version:'1'}}:{content:[{type:'text',text:process.env.MCP_PRIVATE}]};console.log(JSON.stringify({jsonrpc:'2.0',id:r.id,result}))})`);
 const hubEntry=fileURLToPath(import.meta.resolve('@tangle-network/hub-sdk/mcp/stdio'));
 const config={...loadConfig({BRIDGE_HOST:'127.0.0.1',BRIDGE_DATA_DIR:state,BRIDGE_BACKENDS:harness==='codex'?'codex':'claude',CODEX_BIN:bin,CLAUDE_BIN:bin,BRIDGE_TRACE:'off',BRIDGE_JAIL_MODE:'fs-jail',BRIDGE_JAIL_FALLBACK:'deny',BRIDGE_JAIL_NETWORK:'none'}),port:0};
 // Explicit installed code mounts for the unbundled SDK fixture; the CLI ships its own stdio bundle.
 config.jailReadablePaths=[await realpath(join(process.cwd(),'node_modules')),dirname(dirname(dirname(hubEntry)))];
 let server:Awaited<ReturnType<typeof startServer>>|undefined;const lifetime=new AbortController();
 try{
  server=await startServer({config,cwd:workspace,quiet:true,handleSignals:false,mcpSecrets:{async get(key){return key==='private-tool'?toolSecret:undefined}},hub:{client:new HubClient({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:hubKey}),hash:value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex'),serverForGrant(token){tokens.push(token);return{transport:'stdio',command:process.execPath,args:[{kind:'public',value:hubEntry}],env:{TANGLE_HUB_MCP_ENDPOINT:{kind:'public',value:`${server!.url}/hub/mcp/grants/${token}`}}}}}});
  const profile={name:'trusted-private-tools',connections:[{connectionId:'hubconn_fixture',capabilities:['fixture.proof'],alias:'hub'}],mcp:{local:{command:process.execPath,args:[{kind:'public',value:tool}],env:{MCP_PRIVATE:{kind:'secret-ref',key:'private-tool'}}}}};
  const body={stream:true,model:`${harness}/protocol-proof`,run_id:`private-native-${harness}`,session_id:`private-native-${harness}`,cwd:workspace,agent_profile:profile,messages:[{role:'user',content:'Use the scoped private tools'}],env:{AGENT_RUNTIME_COORDINATION_TOKEN:coordSecret},runtime_attachments:{mcp:{coord:{transport:'http',url:coordUrl,headers:{Authorization:{kind:'secret-ref',key:'AGENT_RUNTIME_COORDINATION_TOKEN',format:'bearer'}}}}}};
  const dispatch=(value:typeof body)=>fetch(`${server!.url}/v1/chat/completions`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(value)});
  const denied=await dispatch({...body,run_id:`unregistered-private-${harness}`});
  expect(denied.status).not.toBe(200);expect(await denied.text()).toContain('live host-owned listener');expect(coordCalls).toBe(0);expect(hubCalls).toBe(0);
  await expect(readFile(join(workspace,'vendor-path'))).rejects.toMatchObject({code:'ENOENT'});
  for(const token of tokens)expect((await fetch(`${server.url}/hub/mcp/grants/${token}/tools`)).status).toBe(403);
  server.registerCoordinationEndpoint({runId:'owned-root',actorId:'owned-actor',url:coordUrl,signal:lifetime.signal});
  const response=await dispatch(body);
  const text=await response.text();expect(response.status,text).toBe(200);expect(text).toContain('[redacted:MCP]');expect(hubCalls).toBe(1);expect(coordCalls).toBe(1);
  const terminal=await fetch(`${server.url}/v1/runs/private-native-${harness}`).then(r=>r.json()) as {nativeCapture:{status:string;path:string}};expect(terminal.nativeCapture.status).toBe('retained');
  const manifestBytes=await readFile(terminal.nativeCapture.path),manifest=JSON.parse(manifestBytes.toString());expect(manifest.nativeSessions[0].complete).toBe(false);
  const vendorPath=await readFile(join(workspace,'vendor-path'),'utf8'),original=await readFile(vendorPath),sourceHash=createHash('sha256').update(original).digest('hex');
  expect(original.toString()).toContain(toolSecret);expect(original.toString()).toContain(coordSecret);
  const caps=[...new Set([...original.toString().matchAll(/http:\/\/127\.0\.0\.1:3128\/([A-Za-z0-9_-]+)/g)].map(match=>match[1]!))];expect(caps).toHaveLength(2);
  const retained=await files(capture),streams=new Map<string,Buffer[]>();
  for(const bytes of retained)for(const line of bytes.toString().split('\n')){try{const frame=JSON.parse(line);if(typeof frame.processId==='string'&&typeof frame.stream==='string'&&typeof frame.base64Bytes==='string'){const key=`${frame.processId}/${frame.stream}`,chunks=streams.get(key)??[];chunks.push(Buffer.from(frame.base64Bytes,'base64'));streams.set(key,chunks)}}catch{}}
  const decoded=[...streams.values()].map(chunks=>Buffer.concat(chunks));expect(decoded.length).toBeGreaterThan(0);
  for(const value of [toolSecret,coordSecret,hubKey,...tokens,...caps])for(const bytes of [...retained,...decoded,Buffer.from(text),Buffer.from(JSON.stringify(terminal))])expect(bytes.includes(Buffer.from(value))).toBe(false);
  expect(createHash('sha256').update(await readFile(vendorPath)).digest('hex')).toBe(sourceHash);
  expect(manifest.bridge.files.some((file:{sourceSha256:string})=>file.sourceSha256===`sha256:${sourceHash}`)).toBe(true);
  lifetime.abort();expect((await fetch(`${server.url}/hub/mcp/grants/${tokens[0]}/tools`)).status).toBe(403);
 }finally{lifetime.abort();await server?.close();await new Promise<void>(resolve=>upstream.close(()=>resolve()));vi.unstubAllEnvs();await rm(root,{recursive:true,force:true})}
},60000);
