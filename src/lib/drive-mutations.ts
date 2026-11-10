import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { files, folders, storageUsage } from "@/db/schema";
import { accessItem, ownedItem, descendantIds, uniqueName, type FileRecord, type FolderRecord } from "./drive-access";
import { HttpError, logActivity, safeName, type DbUser } from "./security";
import { copyObject, deleteObject } from "./storage";
const mutation=z.object({action:z.enum(["create-folder","rename","star","delete","restore","permanent","move","copy","open"]),items:z.array(z.object({id:z.string().uuid(),kind:z.enum(["file","folder"])})).max(100).optional().default([]),name:z.string().max(255).optional(),folderId:z.string().uuid().nullable().optional(),value:z.boolean().optional()});
async function ensureFolder(folderId:string|null|undefined,userId:string){if(folderId)await ownedItem(folderId,"folder",userId);}
async function duplicate(item:FileRecord|FolderRecord,kind:"file"|"folder",target:string|null,userId:string){
  const sourceFolders=kind==="folder"?await db.select().from(folders).where(and(eq(folders.userId,userId),inArray(folders.id,await descendantIds(userId,item.id)),isNull(folders.deletedAt))):[];
  const sourceFiles=kind==="file"?[item as FileRecord]:await db.select().from(files).where(and(eq(files.userId,userId),inArray(files.folderId,sourceFolders.map(folder=>folder.id)),isNull(files.deletedAt)));
  const bytes=sourceFiles.reduce((sum,file)=>sum+file.size,0);const folderMap=new Map(sourceFolders.map(folder=>[folder.id,randomUUID()]));const rootName=await uniqueName(userId,target,item.name,kind);const copied:{path:string;backend:string}[]=[];
  try{await db.transaction(async tx=>{
    const [usage]=await tx.select().from(storageUsage).where(eq(storageUsage.userId,userId)).for("update");if(!usage||usage.usedStorage+bytes>usage.totalStorage)throw new HttpError(413,"There isn’t enough room for this copy. Free up a little storage first.");
    for(const folder of sourceFolders){await tx.insert(folders).values({id:folderMap.get(folder.id)!,userId,name:folder.id===item.id?rootName:folder.name,parentFolderId:null,color:folder.color,isStarred:false});}
    for(const folder of sourceFolders){await tx.update(folders).set({parentFolderId:folder.id===item.id?target:folderMap.get(folder.parentFolderId!)||null}).where(eq(folders.id,folderMap.get(folder.id)!));}
    for(const file of sourceFiles){const id=randomUUID(),storagePath=`${userId}/${id}${file.extension?"."+file.extension:""}`;await copyObject(file.storagePath,storagePath,file.storageBackend);copied.push({path:storagePath,backend:file.storageBackend});await tx.insert(files).values({id,userId,folderId:kind==="file"?target:folderMap.get(file.folderId!)||folderMap.get(item.id)!,name:kind==="file"?rootName:file.name,originalName:file.originalName,storagePath,storageBackend:file.storageBackend,mimeType:file.mimeType,extension:file.extension,size:file.size});}
    await tx.update(storageUsage).set({usedStorage:usage.usedStorage+bytes,updatedAt:new Date()}).where(eq(storageUsage.userId,userId));
  });}catch(error){await Promise.all(copied.map(object=>deleteObject(object.path,object.backend).catch(()=>undefined)));throw error;}
}
export async function mutateDrive(user:DbUser,input:unknown){
  const body=mutation.parse(input),now=new Date();
  if(body.action==="create-folder"){const name=safeName(body.name||"");await ensureFolder(body.folderId,user.id);const finalName=await uniqueName(user.id,body.folderId||null,name,"folder");const [folder]=await db.insert(folders).values({userId:user.id,parentFolderId:body.folderId||null,name:finalName}).returning();await logActivity(user.id,"Folder created",finalName,undefined,folder.id);return;}
  if(!body.items.length)throw new HttpError(400,"Select at least one item.");
  if(["rename","open"].includes(body.action)&&body.items.length!==1)throw new HttpError(400,"Select one item for this action.");
  if(["move","copy"].includes(body.action))await ensureFolder(body.folderId,user.id);
  for(const target of body.items){
    const access=body.action==="rename"||body.action==="open"?await accessItem(target.id,target.kind,user.id,body.action==="rename"):null;
    const item=access?.item||await ownedItem(target.id,target.kind,user.id,["restore","permanent"].includes(body.action));
    if(body.action==="open"){if(target.kind==="file"&&item.userId===user.id){await db.update(files).set({openedAt:now}).where(eq(files.id,item.id));await logActivity(user.id,"File opened",item.name,item.id);}continue;}
    if(body.action==="rename"){
      const name=safeName(body.name||"");if(target.kind==="file"){const file=item as FileRecord;const extension=name.includes(".")?name.split(".").pop()!.toLowerCase():"";if(extension!==file.extension)throw new HttpError(400,`Keep the original ${file.extension?"."+file.extension:"file"} extension when renaming.`);const finalName=await uniqueName(item.userId,file.folderId,name,"file",item.id);await db.update(files).set({name:finalName,updatedAt:now}).where(eq(files.id,item.id));}
      else{const finalName=await uniqueName(item.userId,(item as FolderRecord).parentFolderId,name,"folder",item.id);await db.update(folders).set({name:finalName,updatedAt:now}).where(eq(folders.id,item.id));}await logActivity(item.userId,"Renamed",`${item.name} → ${name}`);continue;
    }
    if(body.action==="star"){if(target.kind==="file")await db.update(files).set({isStarred:body.value??!item.isStarred}).where(eq(files.id,item.id));else await db.update(folders).set({isStarred:body.value??!item.isStarred}).where(eq(folders.id,item.id));await logActivity(user.id,body.value===false?"Removed from starred":"Added to starred",item.name);continue;}
    if(body.action==="delete"){
      if(target.kind==="file")await db.update(files).set({deletedAt:now,trashBatch:item.id,updatedAt:now}).where(eq(files.id,item.id));
      else{const ids=await descendantIds(user.id,item.id);await db.transaction(async tx=>{await tx.update(folders).set({deletedAt:now,trashBatch:item.id,updatedAt:now}).where(and(eq(folders.userId,user.id),inArray(folders.id,ids),isNull(folders.deletedAt)));await tx.update(files).set({deletedAt:now,trashBatch:item.id,updatedAt:now}).where(and(eq(files.userId,user.id),inArray(files.folderId,ids),isNull(files.deletedAt)));});}
      await logActivity(user.id,"Moved to trash",item.name);continue;
    }
    if(body.action==="restore"){
      if(!item.deletedAt)continue;
      if(target.kind==="file"){const file=item as FileRecord;let folderId=file.folderId;if(folderId){const [parent]=await db.select().from(folders).where(eq(folders.id,folderId));if(!parent||parent.deletedAt)folderId=null;}const name=await uniqueName(user.id,folderId,file.name,"file",file.id);await db.update(files).set({deletedAt:null,trashBatch:null,updatedAt:now,folderId,name}).where(eq(files.id,item.id));}
      else{const folder=item as FolderRecord;let parentFolderId=folder.parentFolderId;if(parentFolderId){const [parent]=await db.select().from(folders).where(eq(folders.id,parentFolderId));if(!parent||parent.deletedAt)parentFolderId=null;}await db.transaction(async tx=>{await tx.update(folders).set({deletedAt:null,trashBatch:null,updatedAt:now}).where(and(eq(folders.userId,user.id),eq(folders.trashBatch,item.id)));await tx.update(folders).set({parentFolderId}).where(eq(folders.id,item.id));await tx.update(files).set({deletedAt:null,trashBatch:null,updatedAt:now}).where(and(eq(files.userId,user.id),eq(files.trashBatch,item.id)));});}
      await logActivity(user.id,"Restored from trash",item.name);continue;
    }
    if(body.action==="permanent"){
      if(!item.deletedAt)throw new HttpError(400,"Move the item to trash before permanently deleting it.");
      const ids=target.kind==="folder"?await descendantIds(user.id,item.id):[];
      const toDelete=target.kind==="file"?[item as FileRecord]:await db.select().from(files).where(and(eq(files.userId,user.id),inArray(files.folderId,ids)));
      await Promise.all(toDelete.map(file=>deleteObject(file.storagePath,file.storageBackend)));
      await db.transaction(async tx=>{
        const [usage]=await tx.select().from(storageUsage).where(eq(storageUsage.userId,user.id)).for("update");
        let freed=0;
        if(toDelete.length){const removed=await tx.delete(files).where(and(eq(files.userId,user.id),inArray(files.id,toDelete.map(file=>file.id)))).returning({size:files.size});freed=removed.reduce((sum,file)=>sum+file.size,0);}
        if(ids.length)await tx.delete(folders).where(and(eq(folders.userId,user.id),inArray(folders.id,ids)));
        if(usage)await tx.update(storageUsage).set({usedStorage:Math.max(0,usage.usedStorage-freed),updatedAt:now}).where(eq(storageUsage.userId,user.id));
      });
      await logActivity(user.id,"Permanently deleted",item.name);continue;
    }
    if(body.action==="move"){
      if(target.kind==="folder"){const descendants=await descendantIds(user.id,item.id);if(body.folderId&&descendants.includes(body.folderId))throw new HttpError(400,"A folder can’t be moved inside itself.");const name=await uniqueName(user.id,body.folderId||null,item.name,"folder",item.id);await db.update(folders).set({parentFolderId:body.folderId||null,name,updatedAt:now}).where(eq(folders.id,item.id));}
      else{const name=await uniqueName(user.id,body.folderId||null,item.name,"file",item.id);await db.update(files).set({folderId:body.folderId||null,name,updatedAt:now}).where(eq(files.id,item.id));}await logActivity(user.id,"Moved to folder",item.name);continue;
    }
    if(body.action==="copy"){if(target.kind==="folder"&&body.folderId&&(await descendantIds(user.id,item.id)).includes(body.folderId))throw new HttpError(400,"Choose a destination outside the folder being copied.");await duplicate(item,target.kind,body.folderId||null,user.id);await logActivity(user.id,"Copy created",item.name);}
  }
}
