import type { Metadata } from "next"
import { Archivo } from "next/font/google"

const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
})

export const metadata: Metadata = {
  title: "WheelRank — Used Vehicle Deals, Ranked.",
  description:
    "WheelRank analyzes used vehicle listings and assigns every deal a Deal Score — an objective 0-100 rating based on market data. Part of Raising Starts 2026.",
}

export default function WheelRankLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <div className={`${archivo.variable} min-h-screen`} style={{ fontFamily: 'var(--font-archivo)' }}>
      {children}
    </div>
  )
}
