import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/lib/providers';
import { PushSubscribe } from '@/components/push-subscribe';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ??
      'https://good-car-deals-frontend.vercel.app',
  ),
  title: 'Good Car Deals',
  description:
    'Find underpriced used cars — classified listings scored against a market price model, updated weekly.',
  openGraph: {
    title: 'Good Car Deals',
    description:
      'Find underpriced used cars — classified listings scored against a market price model, updated weekly.',
    type: 'website',
    url: '/',
    siteName: 'Good Car Deals',
  },
  twitter: {
    card: 'summary',
    title: 'Good Car Deals',
    description:
      'Find underpriced used cars — classified listings scored against a market price model, updated weekly.',
  },
  other: {
    'apple-mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-title': 'Good Car Deals',
    'apple-mobile-web-app-status-bar-style': 'default',
  },
  icons: {
    icon: [
      { url: '/wheelrank-logo.svg', sizes: '512x512', type: 'image/svg+xml' },
    ],
    apple: [
      { url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased scroll-smooth`}
    >
      <head>
        <link rel="manifest" href="/manifest.json" />
        <link
          rel="apple-touch-icon"
          href="/apple-touch-icon.png"
          sizes="180x180"
          type="image/png"
        />
      </head>
      <body className="min-h-screen flex flex-col">
        <Providers>{children}</Providers>
        <PushSubscribe />
      </body>
    </html>
  );
}
