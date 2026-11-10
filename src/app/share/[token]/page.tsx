import type { Metadata } from "next";
import SharedWorkspace from "@/components/shared-workspace";
export const metadata:Metadata={title:"Shared with you — Filebox",robots:{index:false,follow:false}};
export default async function SharePage({params}:{params:Promise<{token:string}>}){return <SharedWorkspace token={(await params).token}/>;}
