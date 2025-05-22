import React, { useRef, useState, useEffect } from "react";
import { cn } from "../../lib/utils";

interface SpotlightProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  size?: number;
  children: React.ReactNode;
  color?: string;
  initialPosition?: {
    x: number;
    y: number;
  };
}

export const Spotlight = ({
  className,
  size = 400,
  children,
  color = "rgba(120, 119, 198, 0.15)",
  initialPosition = { x: 0, y: 0 },
  ...props
}: SpotlightProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(initialPosition);
  const [isHovered, setIsHovered] = useState(false);
  const [opacity, setOpacity] = useState(0);

  const updatePosition = (x: number, y: number) => {
    if (!containerRef.current) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    setPosition({
      x: x - rect.left,
      y: y - rect.top,
    });
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement> | MouseEvent) => {
    updatePosition(e.clientX, e.clientY);
    if (!isHovered) {
      setIsHovered(true);
      setOpacity(1);
    }
  };

  const handleMouseLeave = () => {
    setIsHovered(false);
    setOpacity(0);
  };

  useEffect(() => {
    const animateToRandomPosition = () => {
      if (isHovered || !containerRef.current) return;
      
      const rect = containerRef.current.getBoundingClientRect();
      const x = Math.random() * rect.width;
      const y = Math.random() * rect.height;
      
      updatePosition(x + rect.left, y + rect.top);
      setOpacity(0.3);
    };
    
    const interval = setInterval(animateToRandomPosition, 3000);
    return () => clearInterval(interval);
  }, [isHovered]);

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      className={cn("relative overflow-hidden", className)}
      {...props}
    >
      <div
        className="pointer-events-none absolute transition-opacity duration-300"
        style={{
          left: position.x - size / 2,
          top: position.y - size / 2,
          width: size,
          height: size,
          opacity: opacity,
          background: `radial-gradient(circle at center, ${color} 0%, transparent 70%)`,
          zIndex: 1,
        }}
      />
      <div className="relative z-10">
        {children}
      </div>
    </div>
  );
}; 