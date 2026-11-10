"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, FileWarning } from "lucide-react";
import type { PDFDocumentProxy, PDFDocumentLoadingTask, RenderTask } from "pdfjs-dist";
import { Spinner } from "./ui";
export default function PdfPreview({src,name}:{src:string;name:string}){
  const host=useRef<HTMLDivElement>(null),canvas=useRef<HTMLCanvasElement>(null);
  const [document,setDocument]=useState<PDFDocumentProxy|null>(null),[pageNumber,setPageNumber]=useState(1),[zoom,setZoom]=useState(1),[width,setWidth]=useState(600),[rendered,setRendered]=useState(false),[error,setError]=useState("");
  useEffect(()=>{const update=()=>{if(host.current)setWidth(Math.floor(host.current.clientWidth));};update();const observer=new ResizeObserver(update);if(host.current)observer.observe(host.current);return()=>observer.disconnect();},[]);
  useEffect(()=>{
    let cancelled=false,task:PDFDocumentLoadingTask|undefined;
    setDocument(null);setRendered(false);setError("");setPageNumber(1);setZoom(1);
    void (async()=>{try{const pdf=await import("pdfjs-dist");if(cancelled)return;pdf.GlobalWorkerOptions.workerSrc="/pdfjs/pdf.worker.min.mjs";task=pdf.getDocument({url:src,useSystemFonts:true,cMapUrl:"/pdfjs/cmaps/",cMapPacked:true,standardFontDataUrl:"/pdfjs/standard_fonts/",wasmUrl:"/pdfjs/wasm/",disableAutoFetch:true,disableStream:true});const loaded=await task.promise;if(!cancelled)setDocument(loaded);}catch(cause){if(!cancelled)setError(cause instanceof Error?cause.message:"This PDF could not be loaded.");}})();
    return()=>{cancelled=true;void task?.destroy().catch(()=>undefined);};
  },[src]);
  useEffect(()=>{
    if(!document||!canvas.current||width<1)return;let cancelled=false,task:RenderTask|undefined;setRendered(false);
    void (async()=>{try{const page=await document.getPage(pageNumber);if(cancelled||!canvas.current)return;const base=page.getViewport({scale:1}),scale=Math.max(.1,Math.min(1.6,(width-32)/base.width))*zoom,viewport=page.getViewport({scale}),ratio=Math.min(window.devicePixelRatio||1,2);const target=canvas.current;target.width=Math.ceil(viewport.width*ratio);target.height=Math.ceil(viewport.height*ratio);target.style.width=`${viewport.width}px`;target.style.height=`${viewport.height}px`;task=page.render({canvas:target,viewport,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});await task.promise;if(!cancelled)setRendered(true);}catch(cause){if(!cancelled&&!(cause instanceof Error&&cause.name==="RenderingCancelledException"))setError("This PDF couldn’t be rendered. You can still download the original.");}})();
    return()=>{cancelled=true;task?.cancel();};
  },[document,pageNumber,zoom,width]);
  return <div className="pdf-preview" ref={host} data-rendered={rendered?"true":"false"}><div className="pdf-controls"><div><button className="icon-button" aria-label="Previous PDF page" disabled={!document||pageNumber<=1} onClick={()=>setPageNumber(value=>value-1)}><ChevronLeft size={15}/></button><span>Page {document?pageNumber:"—"} <em>of {document?.numPages||"—"}</em></span><button className="icon-button" aria-label="Next PDF page" disabled={!document||pageNumber>=document.numPages} onClick={()=>setPageNumber(value=>value+1)}><ChevronRight size={15}/></button></div><div><button className="icon-button" aria-label="Zoom out PDF" disabled={!document||zoom<=.6} onClick={()=>setZoom(value=>Math.max(.5,value-.25))}><Minus size={13}/></button><span>{Math.round(zoom*100)}%</span><button className="icon-button" aria-label="Zoom in PDF" disabled={!document||zoom>=2} onClick={()=>setZoom(value=>Math.min(2,value+.25))}><Plus size={13}/></button><button className="icon-button" aria-label="Fit PDF to width" disabled={!document} onClick={()=>setZoom(1)}><RotateCcw size={12}/></button></div></div><div className="pdf-canvas-scroll">{error?<div className="pdf-loading"><FileWarning size={32}/><strong>We couldn’t preview this PDF</strong><p>{error}</p></div>:<>{!rendered&&<div className="pdf-loading" role="status"><Spinner size={25}/><p>Getting your document ready…</p></div>}<canvas ref={canvas} aria-label={`${name}, page ${pageNumber} of ${document?.numPages||1}`} style={{visibility:rendered?"visible":"hidden"}}/></>}</div></div>;
}
