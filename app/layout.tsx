import type { Metadata } from "next";
import { ITSSS_LOGO_SRC } from '../lib/branding';
import "./globals.css";

export const metadata: Metadata = {
  title: "ERP-ITSSS",
  description: "One workspace for your people, projects, and smarter business.",
  icons: {
    icon: { url: ITSSS_LOGO_SRC, type: 'image/png' },
    shortcut: ITSSS_LOGO_SRC,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
