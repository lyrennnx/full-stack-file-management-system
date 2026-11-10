import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { files, pendingUploads, storageUsage } from "@/db/schema";
import { checkOrigin, errorResponse, HttpError, logActivity, requireAccount, safeName, rateLimit } from "@/lib/security";
import { ownedItem, uniqueName } from "@/lib/drive-access";
import { adminClient, bucket, cloudStorage, deleteObject, localPath, signedDownload, storageBackend, validateMagic, validateUpload } from "@/lib/storage";
export const runtime="nodejs";export const maxDuration=60;
const initSchema=z.object({action:z.literal("init"),name:z.string().min(1).max(255),size:z.number().int().positive(),mimeType:z.string().max(150).optional(),folderId:z.string().uuid().nullable().optional(),uploadId:z.string().uuid().nullable().optional()});
const completeSchema=z.object({action:z.literal("complete"),id:z.string().uuid()});
async function getPending(id:string,userId:string){const [upload]=await db.select().from(pendingUploads).where(and(eq(pendingUploads.id,id),eq(pendingUploads.userId,userId),gt(pendingUploads.expiresAt,new Date())));if(!upload)throw new HttpError(404,"This upload has expired. Choose the file again to restart.");return upload;}
export async function POST(request:NextRequest){try{
  checkOrigin(request);const user=await requireAccount();await rateLimit(request,`uploads-${user.id}`,400,3600000);const raw=await request.json();
  if(raw.action==="init"){
    const body=initSchema.parse(raw),name=safeName(body.name),{extension,mimeType}=validateUpload(name,body.size);if(body.folderId)await ownedItem(body.folderId,"folder",user.id);
    const expired=await db.select().from(pendingUploads).where(and(eq(pendingUploads.userId,user.id),lt(pendingUploads.expiresAt,new Date())));for(const upload of expired){await deleteObject(upload.storagePath,upload.storageBackend).catch(()=>undefined);await db.delete(pendingUploads).where(eq(pendingUploads.id,upload.id));}
    let upload=body.uploadId?await getPending(body.uploadId,user.id).catch(()=>null):null;
    if(upload&&(upload.name!==name||upload.size!==body.size||upload.folderId!==(body.folderId||null)))upload=null;
    if(!upload){const id=randomUUID(),storagePath=`${user.id}/${id}${extension?"."+extension:""}`;
      upload=await db.transaction(async tx=>{const [usage]=await tx.select().from(storageUsage).where(eq(storageUsage.userId,user.id)).for("update");const [reserved]=await tx.select({total:sql<number>`coalesce(sum(${pendingUploads.size}),0)::bigint`}).from(pendingUploads).where(and(eq(pendingUploads.userId,user.id),gt(pendingUploads.expiresAt,new Date())));if(!usage||usage.usedStorage+Number(reserved.total)+body.size>usage.totalStorage)throw new HttpError(413,"There isn’t enough storage for this file. Free up some space and try again.");const [row]=await tx.insert(pendingUploads).values({id,userId:user.id,folderId:body.folderId||null,name,size:body.size,mimeType,extension,storagePath,storageBackend,expiresAt:new Date(Date.now()+24*3600000)}).returning();return row;});
      if(!cloudStorage){await fs.mkdir(path.dirname(localPath(storagePath)),{recursive:true});await fs.writeFile(localPath(storagePath),Buffer.alloc(0),{flag:"wx"});}
    }
    if(upload.storageBackend==="supabase"){const {data,error}=await adminClient().storage.from(bucket).createSignedUploadUrl(upload.storagePath);if(error||!data)throw new HttpError(502,"Cloud uploads aren’t ready. Check your private storage bucket in Settings.");return NextResponse.json({id:upload.id,storage:"supabase",offset:0,endpoint:`${process.env.SUPABASE_URL}/storage/v1/upload/resumable`,token:data.token,path:upload.storagePath,bucket});}
    return NextResponse.json({id:upload.id,storage:"local",offset:upload.uploaded});
  }
  const body=completeSchema.parse(raw),upload=await getPending(body.id,user.id);
  if(upload.folderId)await ownedItem(upload.folderId,"folder",user.id);
  let actualSize:number,head:Buffer;
  if(upload.storageBackend==="local"){const info=await fs.stat(localPath(upload.storagePath));actualSize=info.size;const handle=await fs.open(localPath(upload.storagePath),"r");try{const buffer=Buffer.alloc(Math.min(4096,info.size));await handle.read(buffer,0,buffer.length,0);head=buffer;}finally{await handle.close();}}
  else{const {data,error}=await adminClient().storage.from(bucket).info(upload.storagePath);if(error||!data)throw new HttpError(400,"The cloud upload is not complete yet. Please retry.");actualSize=Number(data.size);const response=await fetch(await signedDownload(upload.storagePath,30),{headers:{Range:"bytes=0-4095"}});if(!response.ok||!response.body)throw new HttpError(502,"Could not verify the uploaded file.");const reader=response.body.getReader();const first=await reader.read();head=Buffer.from(first.value||[]).subarray(0,4096);await reader.cancel();}
  if(actualSize!==upload.size)throw new HttpError(400,"This upload is incomplete. Retry to resume where you left off.");validateMagic(head,upload.extension);
  const finalName=await uniqueName(user.id,upload.folderId,upload.name,"file");
  const file=await db.transaction(async tx=>{const [locked]=await tx.select().from(pendingUploads).where(and(eq(pendingUploads.id,upload.id),eq(pendingUploads.userId,user.id))).for("update");if(!locked)throw new HttpError(409,"This upload has already been saved.");const [usage]=await tx.select().from(storageUsage).where(eq(storageUsage.userId,user.id)).for("update");if(!usage||usage.usedStorage+upload.size>usage.totalStorage)throw new HttpError(413,"Your storage is full. Free up space before completing this upload.");const [row]=await tx.insert(files).values({id:upload.id,userId:user.id,folderId:upload.folderId,name:finalName,originalName:upload.name,storagePath:upload.storagePath,storageBackend:upload.storageBackend,mimeType:upload.mimeType,extension:upload.extension,size:upload.size,openedAt:new Date()}).returning();await tx.update(storageUsage).set({usedStorage:usage.usedStorage+upload.size,updatedAt:new Date()}).where(eq(storageUsage.userId,user.id));await tx.delete(pendingUploads).where(eq(pendingUploads.id,upload.id));return row;});
  await logActivity(user.id,"File uploaded",file.name,file.id);return NextResponse.json({id:file.id,name:file.name});
}catch(error){return errorResponse(error);}}
export async function PATCH(request:NextRequest){try{
  checkOrigin(request);const user=await requireAccount();const id=z.string().uuid().parse(request.nextUrl.searchParams.get("id"));const expected=Number(request.headers.get("x-upload-offset"));if(!Number.isSafeInteger(expected)||expected<0)throw new HttpError(400,"Invalid upload offset.");
  const max=5*1024*1024;if(Number(request.headers.get("content-length"))>max)throw new HttpError(413,"Upload chunks must be 5 MB or smaller.");
  if(!request.body)throw new HttpError(400,"An upload chunk is required.");const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>max){await reader.cancel();throw new HttpError(413,"Upload chunks must be 5 MB or smaller.");}chunks.push(value);}if(!length)throw new HttpError(400,"An empty chunk cannot be uploaded.");const buffer=Buffer.concat(chunks);
  const offset=await db.transaction(async tx=>{const [upload]=await tx.select().from(pendingUploads).where(and(eq(pendingUploads.id,id),eq(pendingUploads.userId,user.id),gt(pendingUploads.expiresAt,new Date()))).for("update");if(!upload||upload.storageBackend!=="local")throw new HttpError(404,"Upload not found.");if(upload.uploaded!==expected)throw new HttpError(409,"The upload offset changed. Retry to resume your upload.");if(expected+length>upload.size)throw new HttpError(413,"This chunk exceeds the declared file size.");const handle=await fs.open(localPath(upload.storagePath),"r+");try{await handle.write(buffer,0,buffer.length,expected);await handle.truncate(expected+buffer.length);}finally{await handle.close();}await tx.update(pendingUploads).set({uploaded:expected+length}).where(eq(pendingUploads.id,id));return expected+length;});return NextResponse.json({offset});
}catch(error){return errorResponse(error);}}
export async function DELETE(request:NextRequest){try{checkOrigin(request);const user=await requireAccount(),id=z.string().uuid().parse(request.nextUrl.searchParams.get("id"));const upload=await getPending(id,user.id);await deleteObject(upload.storagePath,upload.storageBackend);await db.delete(pendingUploads).where(and(eq(pendingUploads.id,id),eq(pendingUploads.userId,user.id)));return NextResponse.json({ok:true});}catch(error){return errorResponse(error);}}
