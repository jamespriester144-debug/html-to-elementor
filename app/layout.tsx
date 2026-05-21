import type { Metadata } from "next";

import { SiteHeader } from "@/components/SiteHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "Lovable to Elementor",
  description:
    "Converta sites Lovable baixados do GitHub em JSON para Elementor com download protegido por pagamento."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>
        <SiteHeader />
        {children}
      </body>
    </html>
  );
}
