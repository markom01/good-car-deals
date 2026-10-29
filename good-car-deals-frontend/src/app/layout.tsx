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
      <body className="min-h-screen flex flex-col">
        <Providers>{children}</Providers>
        <PushSubscribe />
      </body>
    </html>
  );
}
