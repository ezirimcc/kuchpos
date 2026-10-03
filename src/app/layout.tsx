import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import { EnvironmentBanner } from "@/components/environment-banner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "KuchPos",
  description: "Point of sale and inventory",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // The light/dark choice is remembered in the browser and applied before the page is drawn.
  const dark = (await cookies()).get("kuchpos_theme")?.value === "dark";
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${dark ? " dark" : ""}`}
    >
      <body className="min-h-full flex flex-col">
        <EnvironmentBanner />
        {children}
      </body>
    </html>
  );
}
