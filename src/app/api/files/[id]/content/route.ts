import { NextResponse, type NextRequest } from "next/server";
import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { z } from "zod";
import { accessItem, type FileRecord } from "@/lib/drive-access";
import { requirePublicFile } from "@/lib/sharing";
import { errorResponse, getAccount, HttpError, logActivity } from "@/lib/security";
import { localPath, signedDownload } from "@/lib/storage";
export const runtime="nodejs";export const dynamic="force-dynamic";
export async function GET(request:NextRequest,{params}:{params:Promise<{id:string}>}){try{
  const id=z.string().uuid().parse((await params).id),token=request.nextUrl.searchParams.get("share"),download=request.nextUrl.searchParams.get("download")==="1";
  let file:FileRecord;let ttl=60;
  if(token){const result=await requirePublicFile(token,id);file=result.file;if(result.share.expiresAt)ttl=Math.max(1,Math.min(60,Math.floor((result.share.expiresAt.getTime()-Date.now())/1000)));}
  else{const user=await getAccount();if(!user)throw new HttpError(401,"Sign in to access this private file.");file=(await accessItem(id,"file",user.id)).item as FileRecord;if(download)await logActivity(file.userId,"File downloaded",file.name,file.id);}
  if(file.storageBackend==="supabase")return NextResponse.redirect(await signedDownload(file.storagePath,ttl,download?file.name:undefined),{status:307,headers:{"Cache-Control":"private, no-store"}});
  const target=localPath(file.storagePath);const info=await fs.stat(target).catch(()=>{throw new HttpError(404,"The file is missing from storage. Please contact your administrator.");});
  const inline=/^(image\/|video\/|audio\/|text\/)/.test(file.mimeType)||["application/pdf","application/json"].includes(file.mimeType);
  const disposition=`${download||!inline?"attachment":"inline"}; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g,"%27")}`;
  const headers:Record<string,string>={"Content-Type":file.mimeType,"Content-Disposition":disposition,"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; sandbox","Accept-Ranges":"bytes","Cross-Origin-Resource-Policy":"same-origin"};
  let start=0,end=info.size-1,status=200;const range=request.headers.get("range");
  if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2]))return new NextResponse(null,{status:416,headers:{"Content-Range":`bytes */${info.size}`}});if(!match[1]){start=Math.max(0,info.size-Number(match[2]));}else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(start>end||start>=info.size)return new NextResponse(null,{status:416,headers:{"Content-Range":`bytes */${info.size}`}});status=206;headers["Content-Range"]=`bytes ${start}-${end}/${info.size}`;}
  headers["Content-Length"]=String(Math.max(0,end-start+1));if(info.size===0)return new NextResponse(null,{headers});
  const stream=Readable.toWeb(createReadStream(target,{start,end})) as ReadableStream<Uint8Array>;
  return new NextResponse(stream,{status,headers});
}catch(error){return errorResponse(error);}}
