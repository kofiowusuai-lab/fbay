import './globals.css'

export const metadata = { title: 'FBay' }

export default function RootLayout ({ children }) {
  return (
    <html lang="en">
      <body><div className="wrap">{children}</div></body>
    </html>
  )
}
