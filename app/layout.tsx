import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LankaMet — Sri Lanka Cloud & Rain Watch',
  description: 'Near-real-time INSAT-3DS cloud analytics, cloud-motion nowcast and Open-Meteo rain outlook for Sri Lankan estates.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0b1220' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
