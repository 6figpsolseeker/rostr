import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WalletProviders } from "@/components/WalletProviders";
import "./globals.css";

export const metadata: Metadata = {
  title: "rostr — fantasy sports on Solana",
  description:
    "Immutable league rules, escrowed prize pools, and automatic settlement. No commissioner to trust.",
};

/**
 * Document, providers, and nothing else.
 *
 * The header, the fixed-width column and the footer moved into `(app)` when the
 * marketing page arrived, because the landing page needs the opposite frame:
 * full-bleed sections and its own sticky nav. Anything added here is added to
 * both, which is the test for whether it belongs.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
