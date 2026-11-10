import { cp, mkdir } from 'node:fs/promises';
import path from 'node:path';
const source=path.join(process.cwd(),'node_modules/pdfjs-dist');
const target=path.join(process.cwd(),'public/pdfjs');
await mkdir(target,{recursive:true});
await cp(path.join(source,'build/pdf.worker.min.mjs'),path.join(target,'pdf.worker.min.mjs'));
for(const folder of ['standard_fonts','cmaps','wasm'])await cp(path.join(source,folder),path.join(target,folder),{recursive:true});
console.log('PDF.js worker, fonts, encodings, and WASM assets copied to public/pdfjs.');
