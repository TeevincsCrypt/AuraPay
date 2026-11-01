import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AppShell } from "@/components/shell";
import { StatusProvider } from "@/lib/client/hooks";
import { WalletProvider } from "@/lib/client/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuraPay — Your money. Without borders.",
  description: "Invest in global markets, borrow against your investments and pay for airtime, data and electricity across Africa with Nimiq Pay.",
  applicationName: "AuraPay",
};

export const viewport: Viewport = {
  themeColor: "#07070b",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable} antialiased`}>
      <body>
        <StatusProvider>
          <WalletProvider>
            <AppShell>{children}</AppShell>
          </WalletProvider>
        </StatusProvider>
      </body>
    </html>
  );
}
