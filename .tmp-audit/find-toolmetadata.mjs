import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
const needle = 'toolMetadata';
for (const f of files) {
  let s;
  try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
  let i = s.indexOf(needle);
  while (i !== -1) {
    // find enclosing region marker before
    const region = s.lastIndexOf('//#region', i);
    const regionName = region !== -1 ? s.slice(region, s.indexOf('\n', region)) : '(none)';
    console.log('FILE=' + f + ' idx=' + i + ' ' + regionName);
    console.log('  CTX: ...' + s.slice(Math.max(0, i - 160), i + 160).replace(/\n/g, ' ') + '...');
    i = s.indexOf(needle, i + 1);
    if (i > 2000000) break;
  }
}