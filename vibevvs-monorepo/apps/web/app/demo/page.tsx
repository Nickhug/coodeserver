"use client";

import React from "react";
import { Navbar } from "../../components/ui/navbar";
import { Section, SectionHeader } from "../../components/ui/section";
import { Button } from "../../components/ui/button";
import BackgroundGradientDemo from "../../components/background-gradient-demo";
import { BackgroundGradient } from "../../components/ui/background-gradient";
import { Card, CardContent } from "../../components/ui/card";
import Link from "next/link";

export default function DemoPage() {
  return (
    <main className="min-h-screen">
      <Navbar 
        logo={
          <Link href="/" className="flex items-center">
            <span className="text-xl font-bold">VVS</span>
          </Link>
        }
        menuItems={[
          { label: "Home", href: "/" },
          { label: "Components", href: "/demo" },
        ]}
        actions={
          <Button variant="outline" asChild>
            <Link href="/">Back to Home</Link>
          </Button>
        }
      />

      <Section className="pt-24">
        <SectionHeader 
          title="Gradient Background Demo"
          description="A showcase of the animated gradient background components"
        />

        <div className="mt-12 grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-xl font-semibold mb-4">Product Card Example</h3>
            <BackgroundGradientDemo />
          </div>

          <div className="space-y-8">
            <div>
              <h3 className="text-xl font-semibold mb-4">Button Example</h3>
              <BackgroundGradient containerClassName="inline-block rounded-full">
                <Button 
                  className="rounded-full bg-white/90 text-black dark:bg-gray-900/90 dark:text-white backdrop-blur-md border-none" 
                  size="lg"
                >
                  Gradient Button
                </Button>
              </BackgroundGradient>
            </div>

            <div>
              <h3 className="text-xl font-semibold mb-4">Card Example</h3>
              <BackgroundGradient containerClassName="rounded-2xl">
                <Card className="bg-white/80 dark:bg-gray-900/80 backdrop-blur-md">
                  <CardContent className="p-6">
                    <h4 className="text-lg font-medium mb-2">Gradient Card</h4>
                    <p className="text-muted-foreground">
                      This is a card with a beautiful animated gradient border that uses our BackgroundGradient component.
                    </p>
                  </CardContent>
                </Card>
              </BackgroundGradient>
            </div>
          </div>
        </div>

        <div className="mt-12">
          <h3 className="text-xl font-semibold mb-4">Text Container Example</h3>
          <BackgroundGradient containerClassName="rounded-3xl">
            <div className="p-8 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md rounded-3xl">
              <h4 className="text-2xl font-bold mb-4">Beautiful Gradient Containers</h4>
              <p className="text-lg mb-4">
                This component can be used to create visually striking containers for any content, adding a touch of modern design to your application.
              </p>
              <p className="text-muted-foreground">
                The gradient animates subtly to catch the user's attention without being distracting. Perfect for highlighting important content or calls to action.
              </p>
            </div>
          </BackgroundGradient>
        </div>

        <div className="mt-12 pb-16">
          <h3 className="text-xl font-semibold mb-4">Implementation Example</h3>
          <BackgroundGradient containerClassName="rounded-xl">
            <div className="p-6 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md rounded-xl">
              <pre className="font-mono text-sm overflow-x-auto p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
                {`<BackgroundGradient containerClassName="rounded-3xl">
  <div className="p-8 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md rounded-3xl">
    <h4 className="text-2xl font-bold mb-4">Your Content Here</h4>
    <p className="text-lg">The content of your component goes here.</p>
  </div>
</BackgroundGradient>`}
              </pre>
            </div>
          </BackgroundGradient>
        </div>
      </Section>
    </main>
  );
} 