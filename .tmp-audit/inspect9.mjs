import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
// find all "on:" declarations that mention before_reset within 400 chars
for (const f of files) {
  let s;
  try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
  let i = s.indexOf('before_reset');
  while (i !== -1) {
    const near = s.slice(Math.max(0, i - 600), i + 100);
    if (/on:|PluginHook|HookEvent|hookName/i.test(near)) {
      console.log('FILE=' + f + ' idx=' + i);
      console.log(near.replace(/\n/g, ' '));
      console.log('---');
      break;
    }
    i = s.indexOf('before_reset', i + 1);
  }
}