import {createServer} from 'node:http';
import {createRequire} from 'node:module';

// Run from the repository root: `node docs/spikes/a-tab-runs-a-published-processor-bundle/measure.mjs chromium,firefox,webkit`.
// It serves a page, the processor bundle `test/aTabRunsAPublishedProcessorBundle.test.ts` builds (the same
// esbuild flags the examples use), and the page's own script, each under the SAME Content-Security-Policy header,
// then runs `loadProcessorBundle` on the main thread and inside a dedicated module worker. Results: README.md.
const require = createRequire(new URL('../../../packages/browser/package.json', import.meta.url));
const {build} = require('esbuild');
const {chromium, firefox, webkit} = require('@playwright/test');
const P=new URL('../../../packages/browser', import.meta.url).pathname;
const page = (await build({entryPoints:[new URL('./page.ts', import.meta.url).pathname],bundle:true,format:'esm',platform:'browser',write:false,logLevel:'silent'})).outputFiles[0].contents;
const proc = (await build({entryPoints:[P+'/test/fixtures/published-processor/processor.ts'],bundle:true,format:'esm',minify:true,write:false})).outputFiles[0].contents;
let csp=null;
const server=createServer((req,res)=>{
  const h={}; if(csp) h['content-security-policy']=csp;
  if(req.url==='/') { res.writeHead(200,{...h,'content-type':'text/html'}).end('<html><body><script type="module" src="/page.js"></script></body></html>'); return;}
  if(req.url==='/page.js') { res.writeHead(200,{...h,'content-type':'text/javascript'}).end(Buffer.from(page)); return;}
  if(req.url==='/processor.bundle.js') { res.writeHead(200,{...h,'content-type':'text/javascript'}).end(Buffer.from(proc)); return;}
  res.writeHead(404).end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const engines={chromium, firefox, webkit};
for (const name of (process.argv[2]||'chromium').split(',')) {
  let browser;
  try { browser = await engines[name].launch(); } catch(e){ console.log(name,'launch failed',e.message.split('\n')[0]); continue;}
  for (const policy of [null, "script-src 'self'", "script-src 'self' blob:", "script-src 'self' data:"]) {
    csp=policy;
    const p = await browser.newPage();
    await p.goto(origin+'/');
    await p.waitForFunction(()=>typeof globalThis.run==='function');
    const main = await p.evaluate(()=>globalThis.run());
    const worker = await p.evaluate(()=>new Promise((res)=>{const w=new Worker('/page.js',{type:'module'}); w.onmessage=(e)=>res(e.data); w.onerror=(e)=>res({error:String(e.message)}); w.postMessage(1);}));
    console.log(name, JSON.stringify(policy), '\n  main:', JSON.stringify({...main, why: main.why?.slice(0,300)}), '\n  worker:', JSON.stringify({...worker, why: worker.why?.slice(0,300)}));
    await p.close();
  }
  await browser.close();
}
server.close();
