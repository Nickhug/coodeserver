"use client";
import { cn } from "../../lib/utils";
import { useEffect, useState } from "react";

interface NoiseTextureProps {
  opacity?: number;
  blendMode?: string;
  className?: string;
  zIndex?: number;
  useDataURL?: boolean;
  svgParams?: {
    baseFrequency?: number;
    numOctaves?: number;
    seed?: number;
  };
}

export function NoiseTexture({
  opacity = 0.15,
  blendMode = "soft-light",
  className,
  zIndex = 10,
  useDataURL = true,
  svgParams = {
    baseFrequency: 0.55,
    numOctaves: 4,
    seed: 0,
  },
}: NoiseTextureProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    // Set CSS variables
    const root = document.documentElement;
    root.style.setProperty("--noise-opacity", opacity.toString());
    root.style.setProperty("--noise-blend-mode", blendMode);
    root.style.setProperty("--noise-z-index", zIndex.toString());
  }, [opacity, blendMode, zIndex]);

  if (!mounted) return null;

  // Inline SVG method
  if (!useDataURL) {
    return (
      <div
        className={cn(
          "absolute inset-0 w-full h-full pointer-events-none",
          `z-[var(--noise-z-index)]`,
          `[mix-blend-mode:var(--noise-blend-mode)]`,
          `opacity-[var(--noise-opacity)]`,
          className
        )}
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
          className="w-full h-full"
        >
          <filter id="paper-noise">
            <feTurbulence
              type="fractalNoise"
              baseFrequency={svgParams.baseFrequency}
              numOctaves={svgParams.numOctaves}
              seed={svgParams.seed}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
            <feComponentTransfer>
              <feFuncR type="linear" slope="2" intercept="-0.2" />
              <feFuncG type="linear" slope="2" intercept="-0.2" />
              <feFuncB type="linear" slope="2" intercept="-0.2" />
            </feComponentTransfer>
          </filter>
          <rect width="100%" height="100%" filter="url(#paper-noise)" />
        </svg>
      </div>
    );
  }

  // Data URL method (more performant and cleaner)
  return (
    <div
      className={cn(
        "absolute inset-0 w-full h-full pointer-events-none",
        `z-[var(--noise-z-index)]`,
        `[mix-blend-mode:var(--noise-blend-mode)]`,
        `opacity-[var(--noise-opacity)]`,
        className
      )}
      style={{
        backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='${svgParams.baseFrequency}' numOctaves='${svgParams.numOctaves}' seed='${svgParams.seed}' stitchTiles='stitch' /%3E%3CfeColorMatrix type='saturate' values='0' /%3E%3CfeComponentTransfer%3E%3CfeFuncR type='linear' slope='2' intercept='-0.2' /%3E%3CfeFuncG type='linear' slope='2' intercept='-0.2' /%3E%3CfeFuncB type='linear' slope='2' intercept='-0.2' /%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' /%3E%3C/svg%3E")`,
        backgroundSize: "200px 200px",
      }}
    />
  );
} 