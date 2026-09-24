import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
for (const [label, restr] of [
  ['PluginManifestCapabilityProviderMetadata', 'type PluginManifestCapabilityProviderMetadata'],
  ['PluginManifest (main)', 'type PluginManifest ='],
]) {
  console.log('\n########## ' + label + ' ##########');
  let found = false;
  for (const f of files) {
    let s;
    try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
    const m = new RegExp(restr).exec(s);
    if (m) {
      console.log('--- ' + f + ' @ ' + m.index + ' ---');
      console.log(s.slice(m.index, m.index + 2200));
      found = true;
      break;
    }
  }
  if (!found) console.log('NOT FOUND');
}