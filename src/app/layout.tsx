import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Providers } from "@/components/providers";
import { getSetting } from "@/lib/settings";
import "./globals.css";

// Self-hosted so the portal looks the same on every OS and needs no font CDN.
const inter = localFont({
  src: [
    { path: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", style: "normal" },
    { path: "../../node_modules/@fontsource-variable/inter/files/inter-latin-wght-italic.woff2", style: "italic" },
  ],
  weight: "100 900",
  variable: "--font-inter",
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const branding = await getSetting("branding").catch(() => ({ appName: "AI Portal" }));
  return { title: branding.appName, description: "Internal AI assistant portal" };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="h-full overflow-hidden antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
