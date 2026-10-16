import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

// Windows scanners can briefly hold a destination open. Retry the atomic
// rename; never unlink a valid snapshot to work around a sharing violation.
export async function replaceSnapshotFile(source, destination, {rename = fs.rename, wait = delay, platform = process.platform} = {}) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(source, destination); return; }
    catch (error) {
      if (platform !== 'win32' || !['EPERM','EACCES','EBUSY'].includes(error.code) || attempt >= 7) throw error;
      await wait(Math.min(20 * 2 ** attempt, 250));
    }
  }
}

// Callers serialize writes and hold the workspace owner lock. Unchanged
// snapshots must not replace a useful previous version during startup.
export async function saveSnapshot(file, snapshot) {
  let previous;
  try { previous = await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous === snapshot) return;
  const temp = `${file}.tmp`;
  const handle = await fs.open(temp, 'w');
  try { await handle.writeFile(snapshot); await handle.sync(); }
  finally { await handle.close(); }
  if (previous !== undefined) {
    const backup = path.join(path.dirname(file), `${path.basename(file, '.json')}.previous.json`);
    const backupTemp = `${backup}.tmp`;
    await fs.writeFile(backupTemp, previous);
    await replaceSnapshotFile(backupTemp, backup);
  }
  await replaceSnapshotFile(temp, file);
}

export async function exists(file) {
  try { await fs.access(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
