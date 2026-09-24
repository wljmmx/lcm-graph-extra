import { readFileSync, readdirSync } from 'node:fs';
const dir = '/workspace/node_modules/openclaw/dist';
const files = readdirSync(dir).filter((f) => f.endsWith('.d.ts'));
for (const f of files) {
  let s;
  try { s = readFileSync(dir + '/' + f, 'utf8'); } catch { continue; }
  const m = /type OpenClawPluginApi = \{/.exec(s) || /interface OpenClawPluginApi \{/.exec(s);
  if (!m) continue;
  const chunk = s.slice(m.index, m.index + 60000);
  console.log('FILE=' + f + ' interface@' + m.index);
  // list top-level member names
  const members = chunk.match(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm) || [];
  console.log('MEMBERS: ' + members.map(x => x.trim()).join(', '));
  // print 'on:' and 'register' related lines
  const onRe = /^\s{2}on\??:[^\n]{0,300}/gm;
  let om; let c = 0;
  while ((om = onRe.exec(chunk)) && c < 3) { console.log('ON>>> ' + om[0].trim()); c++; }
  break;
}