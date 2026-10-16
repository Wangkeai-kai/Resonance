import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// Only the desktop's operating-system vault can persist API keys. Browser and
// CLI mode keep their existing memory-only behavior; no plaintext fallback.
export async function attachProviderVault(engine,vault){
  engine.credentialStorage=vault?'encrypted':'memory';
  if(!vault)return;
  const file=path.join(engine.runtime,'provider-credentials.json');
  try{
    const saved=JSON.parse(await fs.readFile(file,'utf8'));
    if(saved.version!==1||typeof saved.sealed!=='string'||saved.epoch!==engine.state.config.credentialEpoch)throw new Error('invalid-vault');
    const entries=JSON.parse(await vault.unseal(saved.sealed));
    if(!Array.isArray(entries))throw new Error('invalid-vault');
    for(const entry of entries){const provider=engine.state.config.providers.find(p=>p.id===entry.id&&p.baseUrl===entry.baseUrl&&p.type===entry.type);if(provider&&typeof entry.key==='string'&&entry.key.length<=16000&&!/[\r\n]/.test(entry.key))engine.keys.set(provider.id,entry.key);}
  }catch(error){if(error.code!=='ENOENT')engine.credentialStorage='memory';}
  const original=engine.applyConfig.bind(engine);
  engine.applyConfig=async input=>{
    // Persist a new generation with the configuration before replacing its
    // ciphertext. An older file can never resurrect a removed/changed key.
    const oldEpoch=engine.state.config.credentialEpoch;
    engine.state.config.credentialEpoch=randomUUID();
    let result;
    try{result=await original(input);}catch(error){engine.state.config.credentialEpoch=oldEpoch;throw error;}
    const entries=engine.state.config.providers.filter(p=>engine.keys.has(p.id)).map(p=>({id:p.id,type:p.type,baseUrl:p.baseUrl,key:engine.keys.get(p.id)}));
    try{const sealed=await vault.seal(JSON.stringify(entries));await fs.writeFile(`${file}.tmp`,JSON.stringify({version:1,epoch:engine.state.config.credentialEpoch,sealed}),{mode:0o600});await fs.rename(`${file}.tmp`,file);engine.credentialStorage='encrypted';}
    catch{engine.credentialStorage='memory';}
    return {...result,credentialStorage:engine.credentialStorage};
  };
}
