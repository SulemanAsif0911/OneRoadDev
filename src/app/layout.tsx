import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'CyberKhyal — Frozen City Grand Prix',
  description: 'Room-code multiplayer street racing on the frozen moscow circuit. Create a room, share the 4-digit code, deploy, race.',
  applicationName: 'CyberKhyal',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#05070d',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
