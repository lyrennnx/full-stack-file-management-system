import { and, eq, gt, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { files, folders, fileShares } from "@/db/schema";
import { HttpError } from "./security";
import type { DriveItem } from "./types";
export type FileRecord=typeof files.$inferSelect;
export type FolderRecord=typeof folders.$inferSelect;
export const activeShare=()=>and(isNull(fileShares.revokedAt),or(isNull(fileShares.expiresAt),gt(fileShares.expiresAt,new Date())));
export async function ancestors(folderId:string|null){const ids:string[]=[];let current=folderId;while(current&&ids.length<100){if(ids.includes(current))throw new HttpError(400,"A folder cycle was detected.");ids.push(current);const [row]=await db.select({parent:folders.parentFolderId}).from(folders).where(eq(folders.id,current)).limit(1);current=row?.parent||null;}return ids;}
export async function descendantIds(userId:string,rootId:string){const all=await db.select({id:folders.id,parent:folders.parentFolderId}).from(folders).where(eq(folders.userId,userId));const ids=new Set([rootId]);let added=true;while(added){added=false;for(const row of all){if(row.parent&&ids.has(row.parent)&&!ids.has(row.id)){ids.add(row.id);added=true;}}}return [...ids];}
export async function accessItem(id:string,kind:"file"|"folder",userId:string,edit=false,includeDeleted=false){
  const [item]=kind==="file"?await db.select().from(files).where(eq(files.id,id)).limit(1):await db.select().from(folders).where(eq(folders.id,id)).limit(1);
  if(!item||(!includeDeleted&&item.deletedAt))throw new HttpError(404,"This item isn’t available.");
  if(item.userId===userId)return{item,permission:"owner" as const};
  if(includeDeleted)throw new HttpError(404,"This item isn’t available.");
  const lineage=await ancestors(kind==="folder"?item.id:(item as FileRecord).folderId);
  const shares=await db.select().from(fileShares).where(and(eq(fileShares.recipientId,userId),activeShare()));
  const matching=shares.filter(share=>(kind==="file"&&share.fileId===id)||(share.folderId&&lineage.includes(share.folderId)));
  const permission=matching.some(share=>share.permission==="editor")?"editor":matching.length?"viewer":null;
  if(!permission||(edit&&permission!=="editor"))throw new HttpError(403,edit?"You need editor permission to change this item.":"You don’t have access to this item.");
  return{item,permission:permission as "viewer"|"editor"};
}
export async function ownedItem(id:string,kind:"file"|"folder",userId:string,includeDeleted=false){const result=await accessItem(id,kind,userId,false,includeDeleted);if(result.permission!=="owner")throw new HttpError(403,"Only the owner can perform this action.");return result.item;}
export function toDriveItem(row:FileRecord|FolderRecord,kind:"file"|"folder",shared=false,permission?:"viewer"|"editor"):DriveItem{return{id:row.id,name:row.name,kind,size:kind==="file"?(row as FileRecord).size:0,mimeType:kind==="file"?(row as FileRecord).mimeType:"inode/directory",extension:kind==="file"?(row as FileRecord).extension:"",isStarred:row.isStarred,isShared:shared,createdAt:row.createdAt.toISOString(),updatedAt:row.updatedAt.toISOString(),folderId:kind==="file"?(row as FileRecord).folderId:(row as FolderRecord).parentFolderId,deletedAt:row.deletedAt?.toISOString()||null,...(kind==="folder"?{color:(row as FolderRecord).color}:{}),...(permission?{permission}:{} )};}
export async function uniqueName(userId:string,folderId:string|null,name:string,kind:"file"|"folder",exclude?:string){
  const rows=kind==="file"?await db.select({name:files.name,id:files.id}).from(files).where(and(eq(files.userId,userId),folderId?eq(files.folderId,folderId):isNull(files.folderId),isNull(files.deletedAt))):await db.select({name:folders.name,id:folders.id}).from(folders).where(and(eq(folders.userId,userId),folderId?eq(folders.parentFolderId,folderId):isNull(folders.parentFolderId),isNull(folders.deletedAt)));
  const names=new Set(rows.filter(row=>row.id!==exclude).map(row=>row.name.toLowerCase()));if(!names.has(name.toLowerCase()))return name;
  const dot=kind==="file"?name.lastIndexOf("."):-1;const stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):"";let n=1;while(names.has(`${stem} (${n})${ext}`.toLowerCase()))n++;return`${stem.slice(0,240-ext.length)} (${n})${ext}`;
}
