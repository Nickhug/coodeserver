"use client";

import React from "react";
import { Button, ButtonProps } from "./button";
import { GlowingEffect } from "./glowing-effect";
import { cn } from "../../lib/utils";

interface GlowingButtonProps extends ButtonProps {
  glowClassName?: string;
  glowVariant?: "default" | "white";
  glowSpread?: number;
  glowBlur?: number;
  glowProximity?: number;
  glowInactiveZone?: number;
  glowBorderWidth?: number;
  wrapperClassName?: string;
}

export const GlowingButton = React.forwardRef<HTMLButtonElement, GlowingButtonProps>(
  ({ 
    className,
    glowClassName, 
    glowVariant = "default",
    glowSpread = 40,
    glowBlur = 0,
    glowProximity = 64,
    glowInactiveZone = 0.01,
    glowBorderWidth = 1.2,
    wrapperClassName,
    variant = "default",
    children,
    ...props 
  }, ref) => {
    return (
      <div className={cn("relative rounded-xl", wrapperClassName)}>
        <div className="relative rounded-xl p-1.5">
          <GlowingEffect
            spread={glowSpread}
            glow={true}
            disabled={false}
            proximity={glowProximity}
            inactiveZone={glowInactiveZone}
            borderWidth={glowBorderWidth}
            variant={glowVariant}
            blur={glowBlur}
            className={glowClassName}
          />
          <Button 
            ref={ref}
            variant={variant}
            className={cn(
              "relative z-10",
              // Only apply these styles for outline variant
              variant === "outline" && "backdrop-blur-sm bg-black/60 hover:bg-black/80 border-0",
              className
            )}
            {...props}
          >
            {children}
          </Button>
        </div>
      </div>
    );
  }
);

GlowingButton.displayName = "GlowingButton"; 