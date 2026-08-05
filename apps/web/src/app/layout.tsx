import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WalletProviders } from "@/components/WalletProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "rostr — fantasy sports on Solana",
  description:
    "Immutable league rules, escrowed prize pools, and automatic settlement. No commissioner to trust.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <WalletProviders>
          <header className="border-b border-white/10">
            <nav className="mx-auto flex max-w-4xl items-center justify-between px-6 py-4">
              <a href="/" className="text-lg font-semibold tracking-tight">
                rostr
              </a>
              <a
                href="/leagues/new"
                className="rounded bg-[--color-turf] px-3 py-1.5 text-sm font-medium text-black"
              >
                Create league
              </a>
            </nav>
          </header>
          <main className="mx-auto max-w-4xl px-6 py-10">{children}</main>
          <footer className="mx-auto max-w-4xl px-6 py-10 text-xs text-white/40">
            Not audited. Do not use with funds you cannot lose.
          </footer>
        </WalletProviders>
      </body>
    </html>
  );
}
