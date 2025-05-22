"use client";

import React, { useRef, useEffect, useState } from "react";
import { Button, ButtonProps } from "./button";
import { NoiseTexture } from "./noise-texture";
import { cn } from "../../lib/utils";

interface GradientNoiseButtonProps extends ButtonProps {
  noiseOpacity?: number;
  noiseBlendMode?: string;
  noiseZIndex?: number;
  containerClassName?: string;
}

export function GradientNoiseButton({
  children,
  className,
  containerClassName,
  noiseOpacity = 0.13,
  noiseBlendMode = "soft-light",
  noiseZIndex = 5,
  ...props
}: GradientNoiseButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [buttonRect, setButtonRect] = useState({ width: 0, height: 0, borderRadius: '0px' });
  
  // Measure the button's dimensions and border radius when it renders
  useEffect(() => {
    if (buttonRef.current) {
      const computedStyle = window.getComputedStyle(buttonRef.current);
      setButtonRect({
        width: buttonRef.current.offsetWidth,
        height: buttonRef.current.offsetHeight,
        borderRadius: computedStyle.borderRadius || 
                     computedStyle.getPropertyValue('--radius') || 
                     '0.5rem'
      });
    }
  }, []);

  return (
    <div className={cn("relative inline-block", containerClassName)}>
      <Button 
        ref={buttonRef}
        className={cn("relative", className)} 
        {...props}
      >
        {children}
      </Button>
      
      <div 
        className="absolute top-0 left-0 pointer-events-none overflow-hidden"
        style={{
          width: `${buttonRect.width}px`,
          height: `${buttonRect.height}px`,
          borderRadius: buttonRect.borderRadius
        }}
      >
        <NoiseTexture
          opacity={noiseOpacity}
          blendMode={noiseBlendMode}
          zIndex={noiseZIndex}
          className="w-full h-full"
          svgParams={{
            baseFrequency: 0.55,
            numOctaves: 4,
            seed: 3,
          }}
        />
      </div>
    </div>
  );
} 