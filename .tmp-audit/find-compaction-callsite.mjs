import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.mjs') || f.endsWith('.js'));
// find call sites of a compaction provider's summarize
const re = /\.summarize\(\{/g;
for (const f of files) {
  let s;
  try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
  if (!/compactionProvider|CompactionProvider|resolveCompactionProvider|registeredCompactionProviders/.test(s)) continue;
  let m;
  let count = 0;
  while ((m = re.exec(s)) && count < 3) {
    console.log('FILE=' + f + ' idx=' + m.index);
    console.log(s.slice(Math.max(0, m.index - 500), m.index + 400).replace(/\n/g, ' '));
    console.log('---');
    count++;
  }
}