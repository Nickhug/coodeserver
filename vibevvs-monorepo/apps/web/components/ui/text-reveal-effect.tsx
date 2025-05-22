import React, { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/utils";

interface TextRevealProps extends React.HTMLAttributes<HTMLDivElement> {
  text: string;
  revealText: string;
  className?: string;
  revealClassName?: string;
  children?: React.ReactNode;
  autoRevert?: boolean;
  revealDuration?: number;
}

export function TextRevealEffect({
  text,
  revealText,
  className,
  revealClassName,
  children,
  autoRevert = false,
  revealDuration = 2000,
  ...props
}: TextRevealProps) {
  const [isRevealed, setIsRevealed] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = () => {
    setIsRevealed(true);
    
    if (autoRevert && timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
  };

  const handleMouseLeave = () => {
    if (autoRevert) {
      timeoutRef.current = setTimeout(() => {
        setIsRevealed(false);
      }, revealDuration);
    }
  };

  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <div
      className={cn("relative cursor-pointer overflow-hidden", className)}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      {...props}
    >
      <div className="relative z-10 transition-transform duration-300 ease-in-out">
        <div
          className={cn("transform transition-transform duration-500", {
            "translate-y-full": isRevealed,
          })}
        >
          {text}
        </div>
        <div
          className={cn(
            "absolute inset-0 transform transition-transform duration-500",
            revealClassName,
            {
              "translate-y-full": !isRevealed,
              "translate-y-0": isRevealed,
            }
          )}
        >
          {revealText}
        </div>
      </div>
      {children}
    </div>
  );
} 