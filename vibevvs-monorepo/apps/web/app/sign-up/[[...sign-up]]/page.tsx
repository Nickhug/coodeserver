"use client";

import { SignUp } from "@clerk/nextjs";
import { BackgroundGradientAnimation } from "../../../components/ui/background-gradient-animation";
import { NoiseTexture } from "../../../components/ui/noise-texture";
import Link from "next/link";
import { dark } from "@clerk/themes";

export default function SignUpPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-black">
      <div className="w-full max-w-md">
              <SignUp 
                appearance={{
                  elements: {
              rootBox: "mx-auto",
              card: "bg-black/40 border border-white/10 shadow-xl",
              headerTitle: "text-white",
              headerSubtitle: "text-white/70",
              formButtonPrimary: "bg-[#d81b60] hover:bg-[#d81b60]/90",
              footerActionLink: "text-[#d81b60] hover:text-[#d81b60]/90",
              formFieldInput: "bg-black/60 border-white/10 text-white",
              formFieldLabel: "text-white/70",
              identityPreview: "bg-black/60 border-white/10"
            }
          }}
          path="/sign-up"
          redirectUrl="/dashboard"
          signInUrl="/login"
              />
            </div>
          </div>
  );
} 