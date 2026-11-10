import { NextResponse, type NextRequest } from "next/server";
import { and, or, eq, isNull, isNotNull, ilike, inArray, asc, desc, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { files, folders, fileShares, storageUsage, activityLogs } from "@/db/schema";
import { errorResponse, requireAccount, checkOrigin, HttpError } from "@/lib/security";
import { activeShare, accessItem, ancestors, descendantIds, toDriveItem } from "@/lib/drive-access";
import { cloudStorage, cloudAuth, quota } from "@/lib/storage";
import { mutateDrive } from "@/lib/drive-mutations";
import type { DriveItem } from "@/lib/types";
export const dynamic="force-dynamic";
export async function GET(request:NextRequest){try{
  const user=await requireAccount();const params=request.nextUrl.searchParams;const view=params.get("view")||"all",folderId=params.get("folderId"),query=(params.get("q")||"").trim().slice(0,200),filter=params.get("filter")||"all",sort=params.get("sort")||"updated-desc",page=Math.min(100000,Math.max(0,parseInt(params.get("page")||"0")||0));
  if(folderId&&!/^[0-9a-f-]{36}$/i.test(folderId))throw new HttpError(400,"Invalid folder.");
  if(params.get("tree")){const tree=await db.select().from(folders).where(and(eq(folders.userId,user.id),isNull(folders.deletedAt))).orderBy(asc(folders.name));return NextResponse.json({folders:tree.map(row=>toDriveItem(row,"folder"))});}
  let ownerId=user.id,permission:"viewer"|"editor"|undefined;
  if(folderId){const access=await accessItem(folderId,"folder",user.id);ownerId=access.item.userId;if(access.permission!=="owner")permission=access.permission;}
  const [allFolders,ownShares,incomingShares]=await Promise.all([
    db.select().from(folders).where(eq(folders.userId,ownerId)),
    db.select().from(fileShares).where(and(eq(fileShares.ownerId,user.id),activeShare())),
    view==="shared"||permission?db.select().from(fileShares).where(and(eq(fileShares.recipientId,user.id),activeShare())):Promise.resolve([]),
  ]);
  const ownTree=ownerId===user.id?allFolders:await db.select().from(folders).where(eq(folders.userId,user.id));
  const ownFolderShares=new Set(ownShares.flatMap(share=>share.folderId?[share.folderId]:[]));let added=true;while(added){added=false;for(const folder of ownTree){if(folder.parentFolderId&&ownFolderShares.has(folder.parentFolderId)&&!ownFolderShares.has(folder.id)){ownFolderShares.add(folder.id);added=true;}}}
  let scopedFolderIds:string[]=[];
  if(permission&&folderId){
    if(view==="trash")throw new HttpError(403,"Only the owner can view this workspace’s trash.");
    const lineage=(await ancestors(folderId)).reverse();
    const sharedRoot=lineage.find(id=>incomingShares.some(share=>share.folderId===id));
    if(!sharedRoot)throw new HttpError(403,"This shared folder is no longer available.");
    scopedFolderIds=await descendantIds(ownerId,sharedRoot);
  }
  const ownFileShares=ownShares.flatMap(share=>share.fileId?[share.fileId]:[]);
  const fileConditions:(SQL|undefined)[]=[eq(files.userId,ownerId),permission?inArray(files.folderId,scopedFolderIds):undefined];
  const folderConditions:(SQL|undefined)[]=[eq(folders.userId,ownerId),permission?inArray(folders.id,scopedFolderIds):undefined];
  if(view==="trash"){fileConditions.push(isNotNull(files.deletedAt),or(isNull(files.trashBatch),sql`${files.trashBatch}=${files.id}`));folderConditions.push(isNotNull(folders.deletedAt),or(isNull(folders.trashBatch),sql`${folders.trashBatch}=${folders.id}`));}
  else{fileConditions.push(isNull(files.deletedAt));folderConditions.push(isNull(folders.deletedAt));}
  if(view==="shared"){
    fileConditions[0]=inArray(files.id,incomingShares.flatMap(share=>share.fileId?[share.fileId]:[]));folderConditions[0]=inArray(folders.id,incomingShares.flatMap(share=>share.folderId?[share.folderId]:[]));
  }else if(view==="starred"){fileConditions.push(eq(files.isStarred,true));folderConditions.push(eq(folders.isStarred,true));}
  else if(view==="recent"){fileConditions.push(isNotNull(files.openedAt));folderConditions.push(sql`false`);}
  else if(view==="all"&&!query){fileConditions.push(folderId?eq(files.folderId,folderId):isNull(files.folderId));folderConditions.push(folderId?eq(folders.parentFolderId,folderId):isNull(folders.parentFolderId));}
  if(query){const search=`%${query.replace(/[\\%_]/g,"\\$&")}%`;fileConditions.push(or(ilike(files.name,search),ilike(files.mimeType,search),ilike(files.extension,search)));folderConditions.push(ilike(folders.name,search));}
  const image=ilike(files.mimeType,"image/%"),video=ilike(files.mimeType,"video/%"),audio=ilike(files.mimeType,"audio/%"),pdf=eq(files.mimeType,"application/pdf"),document=or(ilike(files.mimeType,"text/%"),inArray(files.extension,["doc","docx","xls","xlsx","ppt","pptx","json"])),archive=inArray(files.extension,["zip","rar","7z","gz","tar"]);
  const filters:Record<string,SQL|undefined>={images:image,videos:video,audio,pdfs:pdf,documents:document,archives:archive,other:sql`NOT (${image} OR ${video} OR ${audio} OR ${pdf} OR ${document} OR ${archive})`};
  if(filter!=="all"){if(filters[filter])fileConditions.push(filters[filter]);folderConditions.push(sql`false`);}
  const order=sort==="name-asc"?asc(files.name):sort==="name-desc"?desc(files.name):sort==="size-desc"?desc(files.size):sort==="size-asc"?asc(files.size):sort==="created-desc"?desc(files.createdAt):sort==="type-asc"?asc(files.extension):view==="recent"?desc(files.openedAt):desc(files.updatedAt);
  const sharedCountCondition=or(ownFileShares.length?inArray(files.id,ownFileShares):sql`false`,ownFolderShares.size?inArray(files.folderId,[...ownFolderShares]):sql`false`);
  const [fileRows,folderRows,quickRows,fileStats,folderStats,sharedStats,usage,activity,counts]=await Promise.all([
    db.select().from(files).where(and(...fileConditions)).orderBy(order,asc(files.id)).limit(51).offset(page*50),
    db.select().from(folders).where(and(...folderConditions)).orderBy(asc(folders.name)).limit(200),
    db.select().from(files).where(and(eq(files.userId,user.id),isNull(files.deletedAt),isNotNull(files.openedAt))).orderBy(desc(files.openedAt)).limit(4),
    db.select({count:sql<number>`count(*) FILTER (WHERE ${files.deletedAt} IS NULL)::int`,used:sql<number>`coalesce(sum(${files.size}),0)::bigint`}).from(files).where(eq(files.userId,user.id)),
    db.select({count:sql<number>`count(*)::int`}).from(folders).where(and(eq(folders.userId,user.id),isNull(folders.deletedAt))),
    db.select({count:sql<number>`count(*)::int`}).from(files).where(and(eq(files.userId,user.id),isNull(files.deletedAt),sharedCountCondition)),
    db.select().from(storageUsage).where(eq(storageUsage.userId,user.id)).limit(1),
    db.select().from(activityLogs).where(eq(activityLogs.userId,user.id)).orderBy(desc(activityLogs.createdAt)).limit(30),
    db.select({folderId:files.folderId,count:sql<number>`count(*)::int`}).from(files).where(and(eq(files.userId,ownerId),isNull(files.deletedAt))).groupBy(files.folderId),
  ]);
  const isShared=(id:string,parent:string|null)=>ownFileShares.includes(id)||(parent?ownFolderShares.has(parent):false);
  const getIncoming=(id:string,kind:string)=>incomingShares.some(share=>(kind==="file"?share.fileId:share.folderId)===id&&share.permission==="editor")?"editor" as const:"viewer" as const;
  const fileItems=fileRows.slice(0,50).map(row=>toDriveItem(row,"file",isShared(row.id,row.folderId),view==="shared"?getIncoming(row.id,"file"):permission));
  const folderItems=folderRows.map(row=>({...toDriveItem(row,"folder",ownFolderShares.has(row.id),view==="shared"?getIncoming(row.id,"folder"):permission),count:counts.find(count=>count.folderId===row.id)?.count||0}));
  let items:DriveItem[]=fileItems;let displayFolders:DriveItem[]=folderItems;
  if(view!=="all"||query||filter!=="all"){items=[...(page===0?folderItems:[]),...fileItems];displayFolders=[];}
  const lineage=folderId?(await ancestors(folderId)).reverse():[];
  const breadcrumbs=lineage.filter(id=>!permission||scopedFolderIds.includes(id)).map(id=>({id,name:allFolders.find(folder=>folder.id===id)?.name||"Shared folder"}));
  return NextResponse.json({user:{id:user.id,email:user.email,fullName:user.fullName,isGuest:user.isGuest},items,folders:displayFolders,quickAccess:quickRows.map(row=>toDriveItem(row,"file",isShared(row.id,row.folderId))),breadcrumbs,hasMore:fileRows.length>50,stats:{totalFiles:fileStats[0].count,totalFolders:folderStats[0].count,used:Number(fileStats[0].used),total:usage[0]?.totalStorage||quota,shared:sharedStats[0].count},activity:activity.map(row=>({id:row.id,action:row.action,name:row.name,createdAt:row.createdAt.toISOString()})),backend:{storage:cloudStorage?"supabase":"local",auth:cloudAuth?"supabase":"local"}},{headers:{"Cache-Control":"private, no-store"}});
}catch(error){return errorResponse(error);}}
export async function POST(request:NextRequest){try{checkOrigin(request);const user=await requireAccount();await mutateDrive(user,await request.json());return NextResponse.json({ok:true});}catch(error){return errorResponse(error);}}
