const processorSrc = 'export const fold = (s, e) => s + e;';
async function attempt(label, fn) {
  try { return label + ': OK -> ' + (await fn()); }
  catch (e) { return label + ': REFUSED -> ' + (e && e.name) + ': ' + (e && e.message); }
}
export default { async fetch() {
  const out = [];
  out.push(await attempt('import(data: base64)', async () => { const m = await import('data:text/javascript;base64,' + btoa(processorSrc)); return 'fold(1,2)=' + m.fold(1, 2); }));
  out.push(await attempt('import(data: plain) ', async () => { const m = await import('data:text/javascript,' + encodeURIComponent(processorSrc)); return 'fold(1,2)=' + m.fold(1, 2); }));
  out.push(await attempt('import(blob:)       ', async () => { const u = URL.createObjectURL(new Blob([processorSrc], {type: 'text/javascript'})); const m = await import(u); return 'fold(1,2)=' + m.fold(1, 2); }));
  out.push(await attempt('new Function        ', async () => new Function('a', 'b', 'return a+b')(1, 2)));
  out.push(await attempt('eval                ', async () => eval('1+2')));
  out.push(await attempt('CONTROL static code ', async () => 'plain code runs: ' + (1 + 2)));
  return new Response(out.join('\n') + '\n');
}};
