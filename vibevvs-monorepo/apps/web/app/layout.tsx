import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Script from "next/script";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Coode - The AI Code Editor",
  description: "The intelligent code editor for the next generation of developers",
  keywords: ["code editor", "AI", "programming", "IDE", "development", "Coode"],
  authors: [{ name: "Coode Team" }],
  openGraph: {
    title: "Coode - The AI Code Editor",
    description: "The intelligent code editor for the next generation of developers",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Coode - The AI Code Editor",
    description: "The intelligent code editor for the next generation of developers",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ClerkProvider
      appearance={{
        baseTheme: dark,
        variables: {
          colorPrimary: "#d81b60",
          colorText: "white",
          colorTextOnPrimaryBackground: "white",
          colorBackground: "black",
          colorInputBackground: "rgba(0, 0, 0, 0.6)",
          colorInputText: "white",
        }
      }}
    >
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <Script
          src="https://unpkg.com/three@0.159.0/build/three.min.js"
          strategy="beforeInteractive"
        />
        <Script
          src="https://unpkg.com/three@0.159.0/examples/jsm/loaders/SVGLoader.js"
          strategy="beforeInteractive"
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
        >
          {children}
      </body>
    </html>
    </ClerkProvider>
  );
}
