import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
function dump(label, restr, len = 2200) {
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
dump('definePluginEntry', 'declare function definePluginEntry', 400);
dump('OpenClawPluginDefinition', 'type OpenClawPluginDefinition =', 2200);
dump('OpenClawPluginFactory/DefineOptions', 'type DefinePluginEntryOptions', 2200);
dump('before_reset hook', 'before_reset', 400);