import {loadProcessorBundle} from '../../../packages/browser/src/processorBundle.ts';
(globalThis as any).run = async () => {
  const outcome = await loadProcessorBundle('/processor.bundle.js');
  const {processor, processorModule, ...rest} = outcome as any;
  return {...rest, hasProcessor: !!processor, entities: processor?.entities?.length};
};
if (typeof (globalThis as any).document === 'undefined') {
  (globalThis as any).onmessage = async () => { (globalThis as any).postMessage(await (globalThis as any).run()); };
}
