import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { and, eq, isNull, asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { files, folders, users, shareGrants } from "@/db/schema";
import { resolveShare, hasShareAccess, requirePublicFile } from "@/lib/sharing";
import { ancestors, toDriveItem, type FileRecord } from "@/lib/drive-access";
import { checkOrigin, errorResponse, hashToken, HttpError, randomToken, rateLimit, verifyPassword } from "@/lib/security";
import { mutateDrive } from "@/lib/drive-mutations";
type Context={params:Promise<{token:string}>};
export async function GET(request:NextRequest,{params}:Context){try{
  const {token}=await params;const {share,item:root}=await resolveShare(token);
  if(!await hasShareAccess(share))return NextResponse.json({locked:true});
  let item=root;const folderId=request.nextUrl.searchParams.get("folderId");
  if(folderId){z.string().uuid().parse(folderId);if(!share.folderId||!(await ancestors(folderId)).includes(share.folderId))throw new HttpError(403,"This folder is outside the shared workspace.");const [folder]=await db.select().from(folders).where(and(eq(folders.id,folderId),eq(folders.userId,share.ownerId),isNull(folders.deletedAt)));if(!folder)throw new HttpError(404,"Folder not found.");item=folder;}
  const kind=share.folderId?"folder":"file";
  const [owner]=await db.select({name:users.fullName}).from(users).where(eq(users.id,share.ownerId));
  let children:ReturnType<typeof toDriveItem>[]=[];let breadcrumbs:{id:string;name:string}[]=[];
  if(kind==="folder"){const [childFiles,childFolders]=await Promise.all([db.select().from(files).where(and(eq(files.folderId,item.id),eq(files.userId,share.ownerId),isNull(files.deletedAt))).orderBy(asc(files.name)).limit(200),db.select().from(folders).where(and(eq(folders.parentFolderId,item.id),eq(folders.userId,share.ownerId),isNull(folders.deletedAt))).orderBy(asc(folders.name)).limit(200)]);children=[...childFolders.map(row=>toDriveItem(row,"folder",true)),...childFiles.map(row=>toDriveItem(row,"file",true))];const lineage=(await ancestors(item.id)).reverse();const scoped=lineage.slice(lineage.indexOf(share.folderId!));const rows=scoped.length?await db.select({id:folders.id,name:folders.name}).from(folders).where(inArray(folders.id,scoped)):[];breadcrumbs=scoped.map(id=>({id,name:rows.find(row=>row.id===id)?.name||"Folder"}));}
  return NextResponse.json({locked:false,item:toDriveItem(item,kind,true),children,breadcrumbs,ownerName:owner?.name||"A Filebox user",permission:share.permission,expiresAt:share.expiresAt?.toISOString()||null},{headers:{"Cache-Control":"private, no-store"}});
}catch(error){return errorResponse(error);}}
export async function POST(request:NextRequest,{params}:Context){try{
  checkOrigin(request);await rateLimit(request,"share-password",15,900000);const {token}=await params,{share}=await resolveShare(token);const {password}=z.object({password:z.string().min(1).max(200)}).parse(await request.json());if(!share.passwordHash||!await verifyPassword(password,share.passwordHash))throw new HttpError(401,"That password isn’t quite right. Please try again.");const grant=randomToken(),expiresAt=new Date(Math.min(Date.now()+3600000,share.expiresAt?.getTime()||Infinity));await db.insert(shareGrants).values({tokenHash:hashToken(grant),shareId:share.id,expiresAt});(await cookies()).set(`fb_share_${share.id}`,grant,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires:expiresAt});return NextResponse.json({ok:true});
}catch(error){return errorResponse(error);}}
export async function PATCH(request:NextRequest,{params}:Context){try{
  checkOrigin(request);await rateLimit(request,"share-editor",60,900000);const {token}=await params,{share}=await resolveShare(token);if(!await hasShareAccess(share))throw new HttpError(401,"Unlock this shared workspace first.");if(share.permission!=="editor")throw new HttpError(403,"This link only allows viewing and downloading.");const body=z.object({id:z.string().uuid(),kind:z.enum(["file","folder"]),name:z.string().min(1).max(255)}).parse(await request.json());
  if(body.kind==="file")await requirePublicFile(token,body.id);else if(!share.folderId||!(await ancestors(body.id)).includes(share.folderId))throw new HttpError(403,"This folder is not included in the shared link.");const [owner]=await db.select().from(users).where(eq(users.id,share.ownerId));if(!owner)throw new HttpError(404,"The owner account is unavailable.");await mutateDrive(owner,{action:"rename",items:[{id:body.id,kind:body.kind}],name:body.name});return NextResponse.json({ok:true});
}catch(error){return errorResponse(error);}}
