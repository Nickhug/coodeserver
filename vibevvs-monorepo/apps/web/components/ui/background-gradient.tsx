"use client";
import React, { useState, useRef, useEffect } from "react";
import { cn } from "../../lib/utils";
import { motion } from "framer-motion";
import { NoiseTexture } from "./noise-texture";

export const BackgroundGradient = ({
  children,
  className,
  containerClassName,
  animate = true,
  gradientBackgroundStart = "#00ccb1", // Default start color
  gradientBackgroundEnd = "#1ca0fb",   // Default end color
  secondColor = "#7b61ff",
  thirdColor = "#ffc414",
  starsOpacity = 0,
  enableGrainTexture = false,
  grainOpacity = 0.05,
  grainBlendMode = "multiply",
}: {
  children?: React.ReactNode;
  className?: string;
  containerClassName?: string;
  animate?: boolean;
  gradientBackgroundStart?: string;
  gradientBackgroundEnd?: string;
  secondColor?: string;
  thirdColor?: string;
  starsOpacity?: number;
  enableGrainTexture?: boolean;
  grainOpacity?: number;
  grainBlendMode?: string;
}) => {
  const [isHovered, setIsHovered] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    setPosition({
      x: (x / rect.width) * 100,
      y: (y / rect.height) * 100,
    });
  };

  const variants = {
    initial: {
      backgroundPosition: "0 50%",
    },
    animate: {
      backgroundPosition: ["0% 50%", "100% 50%", "0% 50%"],
    },
  };

  const backgroundStyle = animate
    ? {
        backgroundSize: "400% 400%",
        backgroundImage: `radial-gradient(circle farthest-side at 0% 100%, ${gradientBackgroundStart}, transparent),
                         radial-gradient(circle farthest-side at 100% 0%, ${secondColor}, transparent),
                         radial-gradient(circle farthest-side at 100% 100%, ${thirdColor}, transparent),
                         radial-gradient(circle farthest-side at 0% 0%, ${gradientBackgroundEnd}, #141316)`,
      }
    : {
        backgroundImage: `radial-gradient(circle farthest-side at 0% 100%, ${gradientBackgroundStart}, transparent),
                         radial-gradient(circle farthest-side at 100% 0%, ${secondColor}, transparent),
                         radial-gradient(circle farthest-side at 100% 100%, ${thirdColor}, transparent),
                         radial-gradient(circle farthest-side at 0% 0%, ${gradientBackgroundEnd}, #141316)`,
      };

  // Style for the cursor spotlight
  const spotlightStyle = {
    background: `radial-gradient(circle at ${position.x}% ${position.y}%, ${gradientBackgroundStart}80 0%, transparent 65%)`,
  };

  return (
    <div 
      ref={containerRef}
      className={cn("relative p-[2px] overflow-hidden group", containerClassName)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onMouseMove={handleMouseMove}
    >
      {/* Default dark gray border */}
      <div className={cn(
        "absolute inset-0 rounded-[inherit] z-[1]",
        "bg-black border border-white/20",
        isHovered ? "opacity-0" : "opacity-100",
        "transition-opacity duration-300"
      )} />

      {/* Cursor spotlight effect */}
      {isHovered && (
        <div 
          style={spotlightStyle}
          className={cn(
            "absolute inset-0 rounded-[inherit] z-[3]",
            "opacity-70 pointer-events-none"
          )} 
        />
      )}

      {/* Animated gradient background that shows on hover */}
      <motion.div
        variants={animate ? variants : undefined}
        initial={animate ? "initial" : undefined}
        animate={animate ? "animate" : undefined}
        transition={
          animate
            ? {
                duration: 5,
                repeat: Infinity,
                repeatType: "reverse",
              }
            : undefined
        }
        style={backgroundStyle}
        className={cn(
          "absolute inset-0 rounded-[inherit] z-[1]",
          isHovered ? "opacity-60" : "opacity-0",
          "blur-xl transition-opacity duration-300 will-change-transform"
        )}
      />
      <motion.div
        variants={animate ? variants : undefined}
        initial={animate ? "initial" : undefined}
        animate={animate ? "animate" : undefined}
        transition={
          animate
            ? {
                duration: 5,
                repeat: Infinity,
                repeatType: "reverse",
              }
            : undefined
        }
        style={backgroundStyle}
        className={cn(
          "absolute inset-0 rounded-[inherit] z-[1]",
          isHovered ? "opacity-100" : "opacity-0",
          "transition-opacity duration-300 will-change-transform"
        )}
      />

      {/* Subtle glow effect */}
      <div
        className={cn(
          "absolute inset-0 rounded-[inherit] z-[2]",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-300",
          "bg-gradient-to-r from-transparent via-white/5 to-transparent"
        )}
      />

      {enableGrainTexture && (
        <NoiseTexture 
          opacity={grainOpacity} 
          blendMode={grainBlendMode} 
          zIndex={15}
          svgParams={{
            baseFrequency: 0.85,
            numOctaves: 3,
            seed: 1
          }}
        />
      )}

      <div className={cn("relative z-10 rounded-[inherit] h-full", className)}>{children}</div>

      {/* Animated gradient background that shows on hover */}
      <div className="absolute inset-[1px] rounded-[inherit] [mask:linear-gradient(black,transparent)] opacity-0 group-hover/gradient-card:opacity-20"></div>
      
      {Boolean(starsOpacity) && (
        <div 
          className="absolute inset-0 rounded-[inherit] opacity-0 mix-blend-overlay group-hover/gradient-card:opacity-100 transition-opacity duration-500" 
          style={{ opacity: starsOpacity }}
        >
          {/* Add stars background here */}
        </div>
      )}
    </div>
  );
}; 