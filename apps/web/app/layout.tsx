import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'haynesnetwork',
  description: 'SSO front door for *.haynesnetwork.com',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="hnet-dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
