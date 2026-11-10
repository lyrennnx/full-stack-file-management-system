import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { users, sessions, storageUsage } from "@/db/schema";
import { checkOrigin, createSession, errorResponse, getAccount, hashPassword, hashToken, HttpError, logActivity, randomToken, rateLimit, requireAccount, SESSION_COOKIE, verifyPassword } from "@/lib/security";
import { authClient, cloudAuth, quota } from "@/lib/storage";
import { seedWorkspace } from "@/lib/seed";
export const runtime="nodejs";
const input=z.object({action:z.enum(["workspace","register","login","logout","forgot","reset","profile"]),email:z.string().email("Enter a valid email address.").max(254).optional(),password:z.string().max(1024).optional(),fullName:z.string().trim().min(1).max(100).optional(),recoveryCode:z.string().max(150).optional(),accessToken:z.string().max(6000).nullable().optional(),refreshToken:z.string().max(6000).nullable().optional()});
export async function POST(request:NextRequest){try{
  checkOrigin(request);const body=input.parse(await request.json());
  if(body.action==="workspace"){
    const existing=await getAccount();if(existing)return NextResponse.json({ok:true});
    await rateLimit(request,"workspace",80,3600000);
    const [user]=await db.insert(users).values({email:`guest-${randomToken()}@workspace.local`,fullName:"Alex Morgan",isGuest:true}).returning();
    try{await seedWorkspace(user.id);await createSession(user.id);}catch(error){await db.delete(users).where(eq(users.id,user.id));throw error;}
    return NextResponse.json({ok:true});
  }
  if(body.action==="logout"){const jar=await cookies();const token=jar.get(SESSION_COOKIE)?.value;if(token)await db.delete(sessions).where(eq(sessions.tokenHash,hashToken(token)));jar.delete(SESSION_COOKIE);return NextResponse.json({ok:true});}
  if(body.action==="profile"){const user=await requireAccount();if(!body.fullName)throw new HttpError(400,"Please enter your display name.");await db.update(users).set({fullName:body.fullName,updatedAt:new Date()}).where(eq(users.id,user.id));return NextResponse.json({ok:true});}
  await rateLimit(request,`auth-${body.action}`,body.action==="login"?20:8,900000);
  const email=body.email?.trim().toLowerCase();
  if(body.action!=="reset"&&!email)throw new HttpError(400,"An email address is required.");
  if(["register","reset"].includes(body.action)&&(!body.password||body.password.length<8))throw new HttpError(400,"Use a password with at least 8 characters.");
  if(body.action==="register"){
    if(!body.fullName)throw new HttpError(400,"Please enter your name.");
    const [existing]=await db.select().from(users).where(eq(users.email,email!)).limit(1);if(existing)throw new HttpError(409,"An account with this email already exists. Try signing in.");
    if(cloudAuth){const {data,error}=await authClient().auth.signUp({email:email!,password:body.password!,options:{data:{full_name:body.fullName},emailRedirectTo:new URL(request.url).origin}});if(error)throw new HttpError(400,error.message);if(!data.session||!data.user)return NextResponse.json({message:"Check your email to confirm your account."});const [user]=await db.insert(users).values({id:data.user.id,email:email!,fullName:body.fullName,authProvider:"supabase"}).returning();await db.insert(storageUsage).values({userId:user.id,totalStorage:quota});await createSession(user.id);return NextResponse.json({ok:true});}
    const recoveryCode=randomToken();const passwordHash=await hashPassword(body.password!);const guest=await getAccount();let userId:string;
    if(guest?.isGuest){await db.update(users).set({email:email!,fullName:body.fullName,passwordHash,recoveryHash:hashToken(recoveryCode),isGuest:false,updatedAt:new Date()}).where(and(eq(users.id,guest.id),eq(users.isGuest,true)));userId=guest.id;}
    else{const [user]=await db.insert(users).values({email:email!,fullName:body.fullName,passwordHash,recoveryHash:hashToken(recoveryCode)}).returning();userId=user.id;await db.insert(storageUsage).values({userId,totalStorage:quota});}
    await createSession(userId);await logActivity(userId,"Account created","Your workspace is here to stay");return NextResponse.json({ok:true,recoveryCode});
  }
  if(body.action==="login"){
    if(!body.password)throw new HttpError(400,"Please enter your password.");const [local]=await db.select().from(users).where(eq(users.email,email!)).limit(1);
    if(local?.authProvider==="local"&&local.passwordHash){if(!await verifyPassword(body.password,local.passwordHash))throw new HttpError(401,"That email and password don’t match. Please try again.");await createSession(local.id);return NextResponse.json({ok:true});}
    if(cloudAuth){const {data,error}=await authClient().auth.signInWithPassword({email:email!,password:body.password});if(error||!data.user)throw new HttpError(401,"That email and password don’t match. Please try again.");await db.insert(users).values({id:data.user.id,email:data.user.email!,fullName:data.user.user_metadata?.full_name||email!.split("@")[0],authProvider:"supabase"}).onConflictDoNothing();await db.insert(storageUsage).values({userId:data.user.id,totalStorage:quota}).onConflictDoNothing();await createSession(data.user.id);return NextResponse.json({ok:true});}
    await hashPassword(body.password);throw new HttpError(401,"That email and password don’t match. Please try again.");
  }
  if(body.action==="forgot"){
    if(cloudAuth){await authClient().auth.resetPasswordForEmail(email!,{redirectTo:new URL(request.url).origin});return NextResponse.json({ok:true});}
    const [user]=await db.select().from(users).where(eq(users.email,email!)).limit(1);
    if(!body.recoveryCode||!user?.recoveryHash||hashToken(body.recoveryCode.trim())!==user.recoveryHash)throw new HttpError(400,"The email and recovery code don’t match. Check the code saved when you registered.");
    if(!body.password||body.password.length<8)throw new HttpError(400,"Use a new password with at least 8 characters.");const recoveryCode=randomToken();await db.update(users).set({passwordHash:await hashPassword(body.password),recoveryHash:hashToken(recoveryCode),updatedAt:new Date()}).where(eq(users.id,user.id));await db.delete(sessions).where(eq(sessions.userId,user.id));await createSession(user.id);return NextResponse.json({ok:true,recoveryCode});
  }
  if(body.action==="reset"){
    if(!cloudAuth||!body.accessToken||!body.refreshToken)throw new HttpError(400,"Open the password-reset link from your email to continue.");const client=authClient();const {error:sessionError}=await client.auth.setSession({access_token:body.accessToken,refresh_token:body.refreshToken});if(sessionError)throw new HttpError(400,"This reset link has expired. Request a new one.");const {data,error}=await client.auth.updateUser({password:body.password!});if(error||!data.user)throw new HttpError(400,"Unable to reset this password. Request a new link.");await db.delete(sessions).where(eq(sessions.userId,data.user.id));await createSession(data.user.id);return NextResponse.json({ok:true});
  }
  throw new HttpError(400,"Unknown account action.");
}catch(error){return errorResponse(error);}}
