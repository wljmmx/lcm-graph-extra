import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
function dump(label, restr, len = 3000) {
  console.log('\n########## ' + label + ' ##########');
  for (const f of files) {
    let s;
    try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
    const m = new RegExp(restr).exec(s);
    if (m) {
      console.log('--- ' + f + ' @ ' + m.index + ' ---');
      console.log(s.slice(m.index, m.index + len));
      return;
    }
  }
  console.log('NOT FOUND');
}
dump('PLUGIN_MANIFEST_CONTRACT_KEYS', 'PLUGIN_MANIFEST_CONTRACT_KEYS');
dump('PluginManifest contracts/activation/uiHints fields', 'contracts\\?: PluginManifestContracts', 1600);
dump('PluginManifestContracts type', 'type PluginManifestContracts', 1800);