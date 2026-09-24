import { readFileSync, readdirSync } from 'node:fs';

const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));

function findDefs(restr) {
  const re = new RegExp(restr);
  const hits = [];
  for (const f of files) {
    let s;
    try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
    const m = re.exec(s);
    if (m) hits.push({ file: f, idx: m.index, snippet: s.slice(m.index, m.index + 1800) });
  }
  return hits;
}

for (const [label, restr] of [
  ['PluginManifestToolMetadata', 'type PluginManifestToolMetadata'],
  ['PluginManifestToolMetadata interface', 'interface PluginManifestToolMetadata'],
  ['manifest toolMetadata field', 'toolMetadata'],
]) {
  console.log('\n########## ' + label + ' ##########');
  const hits = findDefs(restr);
  if (!hits.length) { console.log('NOT FOUND'); continue; }
  for (const h of hits.slice(0, 3)) {
    console.log('--- file=' + h.file + ' idx=' + h.idx + ' ---');
    console.log(h.snippet);
  }
}