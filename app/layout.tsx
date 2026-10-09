import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ITSSS-ERP",
  description: "One workspace for your people, projects, and smarter business.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
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
