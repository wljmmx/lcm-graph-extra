import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
// OpenClawPluginApi interface - print region around "registerTool:" back a bit to find "on:"
for (const f of files) {
  let s;
  try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
  if (!s.includes('type PluginHookName')) continue;
  // find "on:" followed by PluginHookName or similar within 300 chars
  const re = /on:\s*<?[^;]{0,300}/g;
  let m;
  let printed = 0;
  while ((m = re.exec(s)) && printed < 6) {
    if (/PluginHookName|hook/i.test(m[0])) {
      console.log('FILE=' + f + ' @ ' + m.index);
      console.log(m[0].replace(/\n/g, ' ').slice(0, 400));
      console.log('---');
      printed++;
    }
  }
  if (printed) break;
}