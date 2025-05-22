"use client";

import React, { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { Navbar } from "../components/ui/navbar";
import { Section, SectionHeader, SectionContent } from "../components/ui/section";
import { Button } from "../components/ui/button";
import { GradientNoiseButton } from "../components/ui/gradient-noise-button";
import { DownloadButton } from "../components/ui/download-button";
import { Card, CardContent } from "../components/ui/card";
import { TextAnimator } from "../components/ui/text-animator";
import { BackgroundGradient } from "../components/ui/background-gradient";
import { BackgroundGradientAnimation } from "../components/ui/background-gradient-animation";
import { NoiseTexture } from "../components/ui/noise-texture";
import FeaturesSection from "../components/FeaturesSection3D";
import { 
  ChevronRightIcon, 
  ArrowRightIcon,
  GithubIcon,
  TwitterIcon,
} from "../components/icons";
import AiProviderLogos from "../components/AiProviderLogos";
import AnimatedLogo from "../components/AnimatedLogo";
import { Icon } from '@iconify/react';
import dynamic from 'next/dynamic';

// Dynamically import the ThreeJsBackground component with no SSR
const ThreeJsBackground = dynamic(
  () => import('../components/ThreeJsBackground'),
  { ssr: false }
);

// Import UI components
import { GlowingEffect } from "../components/ui/glowing-effect";
import { GlowingButton } from "../components/ui/glowing-button";

// Import components with relative paths instead of aliases
import FeatureCard3D from "../components/FeatureCard3D";
import { 
  GlowingSphere, 
  TorusKnot, 
  EnergizedTorus 
} from "../components/3d";

// Import a custom check icon from our icons file to avoid Lucide React issues
const CheckIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary mr-2 mt-1 flex-shrink-0">
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>
);

// Platform detection function
const usePlatformIcon = () => {
  const [platformIcon, setPlatformIcon] = useState<React.ReactNode>(null);
  
  useEffect(() => {
    // Only run on client side
    const platform = navigator.platform.toLowerCase();
    
    if (platform.includes('mac')) {
      setPlatformIcon(<Icon icon="mdi:apple" className="mr-2 w-5 h-5" />);
    } else if (platform.includes('win')) {
      setPlatformIcon(<Icon icon="mdi:microsoft-windows" className="mr-2 w-5 h-5" />);
    } else if (platform.includes('linux') || platform.includes('x11')) {
      setPlatformIcon(<Icon icon="mdi:linux" className="mr-2 w-5 h-5" />);
    } else {
      // Default icon for unknown platforms
      setPlatformIcon(<Icon icon="mdi:microsoft-windows" className="mr-2 w-5 h-5" />);
    }
  }, []);
  
  return platformIcon;
};

export default function Home() {
  const [scrollY, setScrollY] = useState(0);
  const navbarRef = useRef<HTMLDivElement>(null);
  const [navbarHeight, setNavbarHeight] = useState(0);
  const platformIcon = usePlatformIcon();

  useEffect(() => {
    // Get initial navbar height for proper spacing
    if (navbarRef.current) {
      setNavbarHeight(navbarRef.current.offsetHeight);
    }

    const handleScroll = () => {
      setScrollY(window.scrollY);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const isScrolled = scrollY > 50;

  return (
    <main className="min-h-screen bg-black">
      {/* Fixed Header Container - This div's height (including its pt-4) is measured by navbarRef */}
      <div 
        ref={navbarRef}
        className="fixed top-0 left-0 right-0 z-50 pointer-events-none"
        style={{ 
          // The height style here is mostly for the initial render pass or if navbarRef fails,
          // as setNavbarHeight will override based on measured offsetHeight of this div's content.
          // The crucial part is that this div itself doesn't have height, its content (the div below) does.
          // Let's remove explicit height style here, it's determined by content + setNavbarHeight
        }}
      >
        {/* Inner container providing the consistent top padding for "floating" effect & max-width/centering */}
        <div 
          className="w-full max-w-7xl mx-auto px-4 pt-4 pointer-events-auto"
        >
          {/* This div is the styled navbar box: rounded corners, conditional background/border/glow */}
          <div className={`
            rounded-xl overflow-hidden 
            ${isScrolled 
              ? "backdrop-blur-md bg-black/70 border border-[#d81b60]/10 ring-1 ring-[#d81b60]/5 shadow-[0_4px_20px_0px_rgba(0,0,0,0.3),_0_0_0_1px_rgba(216,27,96,0.05),_0_0_15px_0_rgba(255,255,255,0.1),_0_0_8px_2px_rgba(216,27,96,0.15)]" 
              : "bg-transparent border-0 border-transparent"
            }
            transition-colors transition-shadow transition-background duration-300 ease-in-out
          `}>
            <Navbar 
              // Pass transparent={false} to Navbar component to prevent it from applying its own `fixed` positioning.
              transparent={false}
              // Pass sticky={false} explicitly, though it's the default.
              sticky={false}
              // Conditionally pass a className to Navbar to make its own <header> background transparent
              // when the page is not scrolled. This attempts to override Navbar's default background 
              // that it would get from transparent={false}.
              className={!isScrolled ? "bg-transparent dark:bg-transparent" : ""}
              rightAlignMenu={true}
              menuItems={[
                { label: "Features", href: "#features" },
                { label: "Why Coode", href: "#why-void" },
                { label: "Testimonials", href: "#testimonials" },
                { label: "Demo", href: "/demo" },
              ]}
              logo={
                <Link href="/" className="flex items-center h-10 md:h-12">
                  <div className="flex items-center">
                    <AnimatedLogo width={79.2} height={31.68} />
                    <span 
                      className="text-2xl font-bold tracking-tight ml-[-5px] flex items-center" 
                      style={{ 
                        fontFamily: 'var(--font-cooper)',
                        transform: 'translateY(-1px)'
                      }}
                    >
                      COODE
                    </span>
                  </div>
                </Link>
              }
              actions={
                <>
                  <Button variant="outline" size="default" className="border-0">
                    Sign In
                  </Button>
                  <GlowingButton
                    variant="default"
                    size="default"
                    wrapperClassName="z-20"
                    className="bg-white text-black hover:bg-white/90"
                  >
                    Download
                  </GlowingButton>
                </>
              }
            />
          </div>
        </div>
      </div>

      {/* Spacer to prevent content from being hidden behind fixed navbar. 
          Its height is dynamically set to match the measured height of navbarRef's content. 
          A fallback height is provided for initial render or if measurement fails. 
          The 'calc(64px + 1rem)' is an estimate if direct measurement isn't ready, adjust if needed.
          (1rem corresponds to pt-4) */}
      <div style={{ height: navbarHeight > 0 ? `${navbarHeight}px` : 'calc(64px + 1rem)' }} />

      {/* Hero Section */}
      <Section className="pt-20 md:pt-28 pb-3">
        <BackgroundGradientAnimation 
          gradientBackgroundStart="#c04848" 
          gradientBackgroundEnd="#480048"
          firstColor="192, 72, 72"     // Burgundy red
          secondColor="139, 0, 0"      // Dark red
          thirdColor="74, 26, 99"      // Purple
          fourthColor="183, 28, 28"    // Deep red
          fifthColor="216, 27, 96"     // Dark pink
          pointerColor="255, 64, 129"  // Bright pink
          size="180%"                  // Larger size for more coverage
          blendingValue="lighten"      // Changed blend mode
          containerClassName="w-full rounded-3xl overflow-hidden h-auto min-h-[600px] relative"
        >
          {/* Vignette overlay */}
          <div className="absolute inset-0 z-[5] bg-[radial-gradient(circle,transparent_20%,rgba(0,0,0,0.5)_100%)]"></div>
          
          {/* Paper/grain texture overlay */}
          <NoiseTexture 
            opacity={0.16} 
            blendMode="soft-light" 
            zIndex={6}
            svgParams={{
              baseFrequency: 0.55,
              numOctaves: 4,
              seed: 2
            }}
          />
          
          <div className="relative z-10 flex flex-col items-center px-6 py-20 md:py-32">
            <div className="animate-fade-in text-center">
              <h1 className="text-4xl md:text-5xl lg:text-7xl font-bold tracking-tight mb-6 text-white drop-shadow-md">
                The AI Code Editor
              </h1>
              <h2 className="text-xl md:text-2xl lg:text-4xl mb-8 max-w-3xl mx-auto text-white/90">
                Built to make you <TextAnimator 
                  className="bg-clip-text text-transparent bg-gradient-to-r from-amber-200 to-amber-100 font-semibold drop-shadow-md" 
                  words={["extraordinarily productive", "write better code", "10x faster", "more creative"]} 
                />
              </h2>
              <p className="text-white/80 text-lg max-w-2xl mx-auto mb-10 drop-shadow-sm">
                Coode is the best way to code with AI. The Coode Editor understands your codebase and helps you write, test, and improve code faster than ever.
              </p>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
                <GlowingButton
                  variant="default"
                  size="xl"
                  className="min-w-44 bg-white text-black hover:bg-white/90"
                  wrapperClassName="z-20"
                  glowBorderWidth={1}
                  glowSpread={35}
                >
                  <div className="flex items-center">
                    {platformIcon}
                    Download Now
                  </div>
                </GlowingButton>
                
                <GlowingButton
                  variant="outline"
                  size="xl"
                  className="min-w-44"
                  wrapperClassName="z-20"
                >
                  Learn More <ChevronRightIcon className="ml-2" />
                </GlowingButton>
              </div>
            </div>

            <div className="mt-16 w-full max-w-5xl">
              <div className="relative rounded-xl overflow-hidden shadow-2xl backdrop-blur-sm bg-black/20">
                <Image 
                  src="/image.png" 
                  alt="Coode Editor Screenshot" 
                  width={1200} 
                  height={800}
                  className="w-full"
                />
              </div>
            </div>
          </div>
        </BackgroundGradientAnimation>
      </Section>

      {/* Social Proof with Grid Background */}
      <div className="relative py-2">
        {/* Grid Background */}
        <div className="absolute inset-0 w-full opacity-70">
          <div
            className="absolute inset-0 [background-size:40px_40px] [background-image:linear-gradient(to_right,#262626_1px,transparent_1px),linear-gradient(to_bottom,#262626_1px,transparent_1px)]"
          />
          {/* Radial gradient for the container to give a faded look - increased vignette effect by 20% */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black [mask-image:radial-gradient(ellipse_at_center,transparent_5%,black)]"></div>
        </div>
        
        {/* Social Proof Content */}
        <Section className="py-2 bg-transparent relative z-10">
          <div className="text-center mb-4">
            <p className="text-sm text-white/50 uppercase tracking-widest">Powered by the same AI models that drive</p>
          </div>
          <AiProviderLogos />
        </Section>
      </div>

      {/* Features Section */}
      <FeaturesSection className="pb-8 pt-0 bg-black" />

      {/* Why Coode Section */}
      <Section id="why-void" className="py-16 md:py-24 bg-black">
        <SectionHeader 
          title="Why Developers Love Coode"
          description="We've built Coode with developers in mind, focusing on the features that matter most."
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 mt-12">
          <div className="flex flex-col justify-center">
            <h3 className="text-2xl font-bold mb-4">Intelligent Code Completion</h3>
            <p className="text-lg text-muted-foreground mb-6">
              Our AI understands not just the syntax but the intent of your code, providing suggestions that fit your coding style and project requirements.
            </p>
            <ul className="space-y-2">
              {[
                "Smart auto-completion based on your codebase",
                "Full function and class implementations",
                "Context-aware suggestions that respect your project",
                "Seamless integration with your workflow"
              ].map((item, index) => (
                <li key={index} className="flex items-start">
                  <CheckIcon />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-800">
            <div className="w-full h-96 bg-background/80 dark:bg-gray-800/80 backdrop-blur-md flex items-center justify-center relative">
              <span className="text-gray-400">Code completion demo</span>
            </div>
          </div>
          </div>
          
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 mt-24">
          <div className="rounded-xl overflow-hidden shadow-lg border border-gray-200 dark:border-gray-800 order-2 lg:order-1">
            <div className="w-full h-96 bg-background/80 dark:bg-gray-800/80 backdrop-blur-md flex items-center justify-center relative">
              <span className="text-gray-400">Code explanation demo</span>
            </div>
          </div>
          <div className="flex flex-col justify-center order-1 lg:order-2">
            <h3 className="text-2xl font-bold mb-4">Codebase Understanding</h3>
            <p className="text-lg text-muted-foreground mb-6">
              Coode doesn't just edit code, it understands it. Ask questions about your codebase and get intelligent, context-aware answers.
            </p>
            <ul className="space-y-2">
              {[
                "Natural language queries about your code",
                "Detailed explanations of complex functions",
                "Find relevant code sections quickly",
                "Learn and understand new codebases faster"
              ].map((item, index) => (
                <li key={index} className="flex items-start">
                  <CheckIcon />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Section>

      {/* Testimonials Section */}
      <Section id="testimonials" className="py-16 md:py-24 bg-black">
        <SectionHeader 
          title="Loved by Developers"
          description="Hear what our users have to say about their experience with Coode."
        />

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12">
          {[
            {
              quote: "Coode has changed how I approach coding. The AI feels like a pair programmer that's always available.",
              author: "Sarah Johnson",
              role: "Senior Developer at TechCorp"
            },
            {
              quote: "I've tried many code editors, but Coode is the first one that truly understands my code and helps me write better software.",
              author: "Michael Chen",
              role: "Fullstack Engineer"
            },
            {
              quote: "The speed at which I can implement features now is incredible. Coode has easily doubled my productivity.",
              author: "Alex Rodriguez",
              role: "Lead Developer at StartupXYZ"
            },
          ].map((testimonial, index) => (
            <div key={index} className="relative h-full rounded-[30px] overflow-hidden">
              <Card 
                className="h-full bg-black dark:bg-black backdrop-blur-md border border-white/10 rounded-[28px] relative overflow-hidden"
              >
                <GlowingEffect 
                  spread={40}
                  blur={5}
                  proximity={80}
                  glow={true}
                  disabled={false}
                  variant="default"
                  borderWidth={1}
                  inactiveZone={0.01}
                />
                <CardContent className="pt-6">
                  <div className="space-y-4">
                    <div className="h-6 flex">
                      {[1, 2, 3, 4, 5].map((star) => (
                        <svg 
                          key={star} 
                          className="h-5 w-5 text-yellow-500 fill-current"
                          viewBox="0 0 20 20"
                        >
                          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                        </svg>
                      ))}
                    </div>
                    <p className="text-base text-white">{testimonial.quote}</p>
                    <div>
                      <p className="font-semibold text-white">{testimonial.author}</p>
                      <p className="text-sm text-white/80">{testimonial.role}</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      </Section>

      {/* CTA Section */}
      <Section className="py-20 bg-black relative overflow-hidden">
        {/* Replace the existing wave background with the new ThreeJsBackground */}
        <ThreeJsBackground />
        
        <div className="max-w-4xl mx-auto px-6 py-12 bg-black/[.09] backdrop-blur-sm rounded-3xl border-0 shadow-2xl relative z-10 flex items-center">
          {/* Vignette overlay - ensure it covers the card */}
          <div className="absolute inset-0 bg-[radial-gradient(circle,transparent_30%,rgba(0,0,0,0.4)_100%)] rounded-3xl pointer-events-none"></div>
          <div className="absolute inset-0 bg-gradient-to-b from-white/5 to-transparent rounded-3xl pointer-events-none"></div>

          {/* Left-aligned text content */}
          <div className="text-left flex-grow pr-8 relative z-10">
            <h2 className="text-3xl md:text-4xl font-bold mb-4 text-white">Try Coode Now</h2>
            <p className="text-lg text-white/80 mb-6 max-w-xl">
              Join thousands of developers who are already using Coode to code faster, smarter, and more efficiently.
            </p>
            <p className="text-sm text-white/60">
              Available for Windows, macOS, and Linux
            </p>
          </div>

          {/* Right-aligned button */}
          <div className="ml-auto flex-shrink-0 relative z-10">
            <GlowingButton
              variant="default" 
              size="xl"
              className="bg-white text-black hover:bg-white/90 min-w-44"
            >
              <div className="flex items-center justify-center">
                {platformIcon}
                Download Now
              </div>
            </GlowingButton>
          </div>
        </div>
      </Section>

      {/* Footer */}
      <footer className="bg-black text-white py-12">
        <div className="container mx-auto px-4">
          <div className="flex justify-center mb-8 h-12 md:h-14">
            <Link href="/" className="flex items-center h-full">
              <AnimatedLogo width={96} height={48} />
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            <div>
              <h3 className="font-bold text-lg mb-4">Product</h3>
              <ul className="space-y-2">
                <li><Link href="#" className="text-gray-400 hover:text-white">Features</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Pricing</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Docs</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Changelog</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold text-lg mb-4">Company</h3>
              <ul className="space-y-2">
                <li><Link href="#" className="text-gray-400 hover:text-white">About</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Blog</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Careers</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Contact</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold text-lg mb-4">Resources</h3>
              <ul className="space-y-2">
                <li><Link href="#" className="text-gray-400 hover:text-white">Community</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Help Center</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Privacy</Link></li>
                <li><Link href="#" className="text-gray-400 hover:text-white">Terms</Link></li>
              </ul>
            </div>
            <div>
              <h3 className="font-bold text-lg mb-4">Connect</h3>
              <div className="flex space-x-4 mb-4">
                <Link href="#" className="text-gray-400 hover:text-white">
                  <TwitterIcon />
                </Link>
                <Link href="#" className="text-gray-400 hover:text-white">
                  <GithubIcon />
                </Link>
              </div>
              <p className="text-gray-400">hello@coode.dev</p>
            </div>
          </div>
          <div className="border-t border-gray-800 mt-12 pt-8 flex flex-col md:flex-row justify-between items-center">
            <p className="text-gray-400 text-sm">© 2023 Coode. All rights reserved.</p>
            <div className="flex space-x-6 mt-4 md:mt-0">
              <Link href="#" className="text-gray-400 hover:text-white text-sm">Privacy Policy</Link>
              <Link href="#" className="text-gray-400 hover:text-white text-sm">Terms of Service</Link>
              <Link href="#" className="text-gray-400 hover:text-white text-sm">Cookie Policy</Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
