import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { AppShell } from "@/components/shell";
import { StatusProvider } from "@/lib/client/hooks";
import { SessionProvider } from "@/lib/client/session";
import { WalletProvider } from "@/lib/client/wallet";
import "./globals.css";

export const metadata: Metadata = {
  title: "AuraPay — Your money. Without borders.",
  description: "Pay for airtime, data and electricity across Africa, invest in tokenised US stocks and borrow against them — with your Nimiq Pay wallet.",
  applicationName: "AuraPay",
};

export const viewport: Viewport = {
  themeColor: "#f6f4f2",
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
            <SessionProvider>
              <AppShell>{children}</AppShell>
            </SessionProvider>
          </WalletProvider>
        </StatusProvider>
      </body>
    </html>
  );
}
