import React from "react";
import { cn } from "../../lib/utils";

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children: React.ReactNode;
  glow?: boolean;
  border?: boolean;
  borderClassName?: string;
}

export function Card({
  className,
  children,
  glow = false,
  border = false,
  borderClassName,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "relative rounded-xl backdrop-blur-sm transition-all duration-300",
        {
          "shadow-lg hover:shadow-xl": glow,
        },
        className
      )}
      {...props}
    >
      {border && (
        <div
          className={cn(
            "absolute inset-0 rounded-xl opacity-50 transition-opacity duration-300 group-hover:opacity-100",
            borderClassName
          )}
          style={{
            background: "linear-gradient(145deg, rgba(74, 47, 189, 0.5), rgba(99, 102, 241, 0.2))",
            WebkitMask: "linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)",
            WebkitMaskComposite: "xor",
            maskComposite: "exclude",
            padding: "1px",
            pointerEvents: "none",
          }}
        />
      )}
      {children}
    </div>
  );
}

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children: React.ReactNode;
}

export function CardHeader({
  className,
  children,
  ...props
}: CardHeaderProps) {
  return (
    <div
      className={cn("px-6 pt-6", className)}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children: React.ReactNode;
}

export function CardContent({
  className,
  children,
  ...props
}: CardContentProps) {
  return (
    <div
      className={cn("px-6 py-4", className)}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardFooterProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
  children: React.ReactNode;
}

export function CardFooter({
  className,
  children,
  ...props
}: CardFooterProps) {
  return (
    <div
      className={cn("px-6 pb-6 pt-0", className)}
      {...props}
    >
      {children}
    </div>
  );
}

interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  className?: string;
  children: React.ReactNode;
  as?: React.ElementType;
}

export function CardTitle({
  className,
  children,
  as: Component = "h3",
  ...props
}: CardTitleProps) {
  return (
    <Component
      className={cn("text-xl font-semibold tracking-tight", className)}
      {...props}
    >
      {children}
    </Component>
  );
}

interface CardDescriptionProps extends React.HTMLAttributes<HTMLParagraphElement> {
  className?: string;
  children: React.ReactNode;
}

export function CardDescription({
  className,
  children,
  ...props
}: CardDescriptionProps) {
  return (
    <p
      className={cn("text-sm text-gray-500 dark:text-gray-400", className)}
      {...props}
    >
      {children}
    </p>
  );
} 