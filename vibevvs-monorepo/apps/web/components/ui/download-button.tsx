"use client";

import React from "react";
import { GradientNoiseButton } from "./gradient-noise-button";
import { cn } from "../../lib/utils";

interface DownloadButtonProps {
  size?: "default" | "lg" | "xl";
  className?: string;
  children?: React.ReactNode;
  fullText?: boolean;
}

export function DownloadButton({
  size = "default",
  className,
  children,
  fullText = false,
}: DownloadButtonProps) {
  return (
    <GradientNoiseButton
      variant="gradient"
      size={size}
      className={cn(
        "bg-gradient-to-r from-[#c04848] to-[#480048] hover:from-[#d05858] hover:to-[#580058] border-0",
        "rounded-md overflow-hidden text-black font-semibold",
        className
      )}
      noiseOpacity={0.15}
      noiseBlendMode="soft-light"
      containerClassName="rounded-md overflow-hidden"
    >
      {children || (fullText ? "Download for Free" : "Download")}
    </GradientNoiseButton>
  );
} 