import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=['server.mjs'];
for(const folder of ['lib','dist','desktop','scripts'])for(const item of await fs.readdir(path.join(root,folder)))if(/\.(?:js|cjs|mjs)$/.test(item))files.push(`${folder}/${item}`);
for(const file of files){const result=spawnSync(process.execPath,['--check',path.join(root,file)],{stdio:'pipe',windowsHide:true});if(result.status!==0){process.stderr.write(result.stderr||`Failed: ${file}`);process.exit(1);}}
console.log(`Syntax checked ${files.length} application files.`);
