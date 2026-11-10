import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Filebox — A little space. Endless possibilities.",
  description: "Your files, beautifully organized. A private, secure workspace to store, organize, and share your best work.",
};
export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="en" suppressHydrationWarning><head><script dangerouslySetInnerHTML={{__html:"try{document.documentElement.dataset.theme=localStorage.getItem('filebox-theme')||'light'}catch(e){}"}}/><link rel="icon" href="/favicon.svg" type="image/svg+xml"/></head><body>{children}</body></html>;
}
