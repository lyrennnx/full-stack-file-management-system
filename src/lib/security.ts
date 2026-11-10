import { randomBytes, createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions, rateLimits, activityLogs } from "@/db/schema";
import { ZodError } from "zod";
const scryptAsync = promisify(scrypt);
export const SESSION_COOKIE = "filebox_session";
export const randomToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token:string) => createHash("sha256").update(token).digest("hex");
export class HttpError extends Error { constructor(public status:number,message:string){super(message);} }
export async function hashPassword(password:string) { const salt=randomBytes(16).toString("hex");const hash=await scryptAsync(password,salt,64) as Buffer;return `${salt}:${hash.toString("hex")}`; }
export async function verifyPassword(password:string,stored:string) {try{const [salt,hash]=stored.split(":");const computed=await scryptAsync(password,salt,64) as Buffer;const actual=Buffer.from(hash,"hex");return actual.length===computed.length&&timingSafeEqual(actual,computed);}catch{return false;} }
export async function getAccount() {
  const token=(await cookies()).get(SESSION_COOKIE)?.value;if(!token)return null;
  const [row]=await db.select({user:users}).from(sessions).innerJoin(users,eq(sessions.userId,users.id)).where(and(eq(sessions.tokenHash,hashToken(token)),gt(sessions.expiresAt,new Date()))).limit(1);
  return row?.user || null;
}
export async function requireAccount(){const account=await getAccount();if(!account)throw new HttpError(401,"Your session has expired. Refresh the page to continue.");return account;}
export async function createSession(userId:string) {
  const jar=await cookies();const old=jar.get(SESSION_COOKIE)?.value;if(old)await db.delete(sessions).where(eq(sessions.tokenHash,hashToken(old)));
  const token=randomToken();const expires=new Date(Date.now()+7*86400000);await db.insert(sessions).values({tokenHash:hashToken(token),userId,expiresAt:expires});
  jar.set(SESSION_COOKIE,token,{httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax",path:"/",expires});
}
export function checkOrigin(request:NextRequest) {
  const origin=request.headers.get("origin");if(!origin)return;
  const allowed=[request.headers.get("host"),request.headers.get("x-forwarded-host"),new URL(request.url).host];
  if(!allowed.includes(new URL(origin).host))throw new HttpError(403,"Cross-origin requests are not allowed.");
}
export async function rateLimit(request:NextRequest,scope:string,limit=30,windowMs=900000) {
  const ip=request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()||"local";const bucket=Math.floor(Date.now()/windowMs);const key=hashToken(`${scope}:${ip}:${bucket}`);
  const [row]=await db.insert(rateLimits).values({key,count:1,expiresAt:new Date((bucket+1)*windowMs)}).onConflictDoUpdate({target:rateLimits.key,set:{count:sql`${rateLimits.count}+1`}}).returning();
  if(row.count>limit)throw new HttpError(429,"A few too many attempts. Please wait a little and try again.");
}
export function errorResponse(error:unknown) {
  if(error instanceof HttpError)return NextResponse.json({error:error.message},{status:error.status});
  if(error instanceof ZodError)return NextResponse.json({error:error.issues[0]?.message||"Please check your input."},{status:400});
  if(error instanceof SyntaxError)return NextResponse.json({error:"Invalid request body."},{status:400});
  console.error("Filebox request error:",error);return NextResponse.json({error:"We couldn’t complete that request. Please try again."},{status:500});
}
export function safeName(name:string){const clean=name.normalize("NFC").replace(/[\x00-\x1f\x7f/\\]/g,"").trim();if(!clean||clean==="."||clean===".."||clean.length>255)throw new HttpError(400,"Choose a valid name between 1 and 255 characters.");return clean;}
export async function logActivity(userId:string,action:string,name:string,fileId?:string,folderId?:string){await db.insert(activityLogs).values({userId,action,name,fileId,folderId});}
export type DbUser = typeof users.$inferSelect;
