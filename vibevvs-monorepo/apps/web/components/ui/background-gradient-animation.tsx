"use client";
import { cn } from "../../lib/utils";
import { useEffect, useRef, useState } from "react";

export const BackgroundGradientAnimation = ({
  gradientBackgroundStart = "#c04848",
  gradientBackgroundEnd = "#480048",
  firstColor = "192, 72, 72",    // Red
  secondColor = "139, 0, 0",     // Dark red
  thirdColor = "74, 26, 99",     // Purple
  fourthColor = "183, 28, 28",   // Deep red
  fifthColor = "216, 27, 96",    // Dark pink
  pointerColor = "255, 64, 129", // Bright pink
  size = "100%",
  blendingValue = "overlay",
  children,
  className,
  interactive = true,
  containerClassName,
  enableGrainTexture = false,
  grainOpacity = 0.05,
  grainDensity = 0.9,
  grainBlending = "multiply",
}: {
  gradientBackgroundStart?: string;
  gradientBackgroundEnd?: string;
  firstColor?: string;
  secondColor?: string;
  thirdColor?: string;
  fourthColor?: string;
  fifthColor?: string;
  pointerColor?: string;
  size?: string;
  blendingValue?: string;
  children?: React.ReactNode;
  className?: string;
  interactive?: boolean;
  containerClassName?: string;
  enableGrainTexture?: boolean;
  grainOpacity?: number;
  grainDensity?: number;
  grainBlending?: string;
}) => {
  const interactiveRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  const [curX, setCurX] = useState(0);
  const [curY, setCurY] = useState(0);
  const [tgX, setTgX] = useState(0);
  const [tgY, setTgY] = useState(0);
  
  // Refs for each gradient's position
  const firstPosition = useRef({ x: -25, y: -25 });
  const secondPosition = useRef({ x: 25, y: -25 });
  const thirdPosition = useRef({ x: 0, y: 0 });
  const fourthPosition = useRef({ x: -25, y: 25 });
  const fifthPosition = useRef({ x: 25, y: 25 });
  
  useEffect(() => {
    setMounted(true);
    
    // Initialize random positions
    firstPosition.current = { x: Math.random() * 50 - 25, y: Math.random() * 50 - 25 };
    secondPosition.current = { x: Math.random() * 50 - 25, y: Math.random() * 50 - 25 };
    thirdPosition.current = { x: Math.random() * 50 - 25, y: Math.random() * 50 - 25 };
    fourthPosition.current = { x: Math.random() * 50 - 25, y: Math.random() * 50 - 25 };
    fifthPosition.current = { x: Math.random() * 50 - 25, y: Math.random() * 50 - 25 };
    
    // Set default mouse position in the middle
    if (containerRef.current && interactiveRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setTgX(rect.width / 2);
      setTgY(rect.height / 2);
    }
    
    // Create local CSS variables
    const root = document.documentElement;
    root.style.setProperty("--gradient-background-start", gradientBackgroundStart);
    root.style.setProperty("--gradient-background-end", gradientBackgroundEnd);
    root.style.setProperty("--first-color", firstColor);
    root.style.setProperty("--second-color", secondColor);
    root.style.setProperty("--third-color", thirdColor);
    root.style.setProperty("--fourth-color", fourthColor);
    root.style.setProperty("--fifth-color", fifthColor);
    root.style.setProperty("--pointer-color", pointerColor);
    root.style.setProperty("--size", size);
    root.style.setProperty("--blending-value", blendingValue);
    root.style.setProperty("--grain-opacity", grainOpacity.toString());
    root.style.setProperty("--grain-density", grainDensity.toString());
    root.style.setProperty("--grain-blending", grainBlending);
    
    // Positions for each gradient
    root.style.setProperty("--first-position-x", `${firstPosition.current.x}%`);
    root.style.setProperty("--first-position-y", `${firstPosition.current.y}%`);
    root.style.setProperty("--second-position-x", `${secondPosition.current.x}%`);
    root.style.setProperty("--second-position-y", `${secondPosition.current.y}%`);
    root.style.setProperty("--third-position-x", `${thirdPosition.current.x}%`);
    root.style.setProperty("--third-position-y", `${thirdPosition.current.y}%`);
    root.style.setProperty("--fourth-position-x", `${fourthPosition.current.x}%`);
    root.style.setProperty("--fourth-position-y", `${fourthPosition.current.y}%`);
    root.style.setProperty("--fifth-position-x", `${fifthPosition.current.x}%`);
    root.style.setProperty("--fifth-position-y", `${fifthPosition.current.y}%`);
    
    // Start a random movement when not interactive
    if (!interactive) {
      const interval = setInterval(() => {
        if (containerRef.current) {
          const rect = containerRef.current.getBoundingClientRect();
          setTgX(Math.random() * rect.width);
          setTgY(Math.random() * rect.height);
        }
      }, 3000);
      
      return () => clearInterval(interval);
    }
  }, [gradientBackgroundStart, gradientBackgroundEnd, firstColor, secondColor, 
      thirdColor, fourthColor, fifthColor, pointerColor, size, blendingValue, 
      interactive, grainOpacity, grainDensity, grainBlending]);

  useEffect(() => {
    let animationFrame: number;
    
    function move() {
      if (!interactiveRef.current || !mounted) return;
      
      setCurX(curX + (tgX - curX) / 20);
      setCurY(curY + (tgY - curY) / 20);
      
      interactiveRef.current.style.transform = `translate(${Math.round(curX)}px, ${Math.round(curY)}px)`;
      
      animationFrame = requestAnimationFrame(move);
    }
    
    animationFrame = requestAnimationFrame(move);
    
    return () => cancelAnimationFrame(animationFrame);
  }, [curX, curY, tgX, tgY, mounted]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setTgX(event.clientX - rect.left);
      setTgY(event.clientY - rect.top);
    }
  };

  const [isSafari, setIsSafari] = useState(false);
  useEffect(() => {
    setIsSafari(/^((?!chrome|android).)*safari/i.test(navigator.userAgent));
  }, []);

  return (
    <div
      ref={containerRef}
      onMouseMove={interactive ? handleMouseMove : undefined}
      className={cn(
        "relative overflow-hidden bg-[linear-gradient(40deg,var(--gradient-background-start),var(--gradient-background-end))]",
        containerClassName
      )}
    >
      <svg className="hidden">
        <defs>
          <filter id="blurMe">
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation="10"
              result="blur"
            />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -8"
              result="goo"
            />
            <feBlend in="SourceGraphic" in2="goo" />
          </filter>
          
          {/* Noise texture filter */}
          <filter id="noise" x="0%" y="0%" width="100%" height="100%">
            <feTurbulence 
              type="fractalNoise" 
              baseFrequency="0.65" 
              numOctaves="3" 
              stitchTiles="stitch" 
              result="noise" 
            />
            <feColorMatrix
              type="matrix"
              values="1 0 0 0 0
                      0 1 0 0 0
                      0 0 1 0 0
                      0 0 0 0.05 0"
              result="coloredNoise"
            />
            <feBlend 
              in="SourceGraphic" 
              in2="coloredNoise" 
              mode="multiply"
            />
          </filter>
        </defs>
      </svg>
      <div className={cn("relative z-20", className)}>{children}</div>
      <div
        className={cn(
          "gradients-container absolute inset-0 h-full w-full blur-lg",
          isSafari ? "blur-2xl" : "[filter:url(#blurMe)_blur(40px)]"
        )}
      >
        <div
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--first-color),0.85)_0,_rgba(var(--first-color),0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)]`,
            `top-[calc(50%+var(--first-position-y))] left-[calc(50%+var(--first-position-x))]`,
            `-translate-x-1/2 -translate-y-1/2`,
            `[transform-origin:center_center]`,
            `animate-first`,
            `opacity-90`
          )}
        ></div>
        <div
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--second-color),_0.85)_0,_rgba(var(--second-color),_0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)]`,
            `top-[calc(50%+var(--second-position-y))] left-[calc(50%+var(--second-position-x))]`,
            `-translate-x-1/2 -translate-y-1/2`,
            `[transform-origin:center_center]`,
            `animate-second`,
            `opacity-90`
          )}
        ></div>
        <div
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--third-color),_0.85)_0,_rgba(var(--third-color),_0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)]`,
            `top-[calc(50%+var(--third-position-y))] left-[calc(50%+var(--third-position-x))]`,
            `-translate-x-1/2 -translate-y-1/2`,
            `[transform-origin:center_center]`,
            `animate-third`,
            `opacity-90`
          )}
        ></div>
        <div
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--fourth-color),_0.85)_0,_rgba(var(--fourth-color),_0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)]`,
            `top-[calc(50%+var(--fourth-position-y))] left-[calc(50%+var(--fourth-position-x))]`,
            `-translate-x-1/2 -translate-y-1/2`,
            `[transform-origin:center_center]`,
            `animate-fourth`,
            `opacity-90`
          )}
        ></div>
        <div
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--fifth-color),_0.85)_0,_rgba(var(--fifth-color),_0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[var(--size)] h-[var(--size)]`,
            `top-[calc(50%+var(--fifth-position-y))] left-[calc(50%+var(--fifth-position-x))]`,
            `-translate-x-1/2 -translate-y-1/2`,
            `[transform-origin:center_center]`,
            `animate-fifth`,
            `opacity-90`
          )}
        ></div>

        <div
          ref={interactiveRef}
          className={cn(
            `absolute [background:radial-gradient(circle_at_center,_rgba(var(--pointer-color),_0.85)_0,_rgba(var(--pointer-color),_0)_70%)_no-repeat]`,
            `[mix-blend-mode:var(--blending-value)] w-[150%] h-[150%] -top-[25%] -left-[25%]`,
            `opacity-90`
          )}
        ></div>
      </div>
      
      {/* Grain/Noise texture overlay */}
      {enableGrainTexture && (
        <div 
          className={cn(
            "absolute inset-0 z-10 w-full h-full pointer-events-none",
            `[mix-blend-mode:var(--grain-blending)]`
          )}
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch' /%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' /%3E%3C/svg%3E")`,
            opacity: grainOpacity
          }}
        />
      )}
    </div>
  );
}; 