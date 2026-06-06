import type { Metadata } from 'next'
import { M_PLUS_Rounded_1c } from 'next/font/google'

import './globals.css'

const mplusRounded1c = M_PLUS_Rounded_1c({
  weight: ['400', '700'], // Specify the weights you need
  subsets: ['latin'], // Or 'japanese' if you need specific Japanese characters
  display: 'swap', // Recommended for better performance
})

export const metadata: Metadata = {
  title: 'Agent',
  description: 'Agent',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang='ja'>
      <body className={`${mplusRounded1c.className} antialiased`}>{children}</body>
    </html>
  )
}
