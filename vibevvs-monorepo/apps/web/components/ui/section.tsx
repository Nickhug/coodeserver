import React from "react";
import { cn } from "../../lib/utils";

interface SectionProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
  className?: string;
  containerClassName?: string;
  fullWidth?: boolean;
  id?: string;
}

export function Section({
  children,
  className,
  containerClassName,
  fullWidth = false,
  id,
  ...props
}: SectionProps) {
  return (
    <section
      id={id}
      className={cn(
        "py-16 md:py-24",
        className
      )}
      {...props}
    >
      <div
        className={cn(
          {
            "container mx-auto px-4": !fullWidth,
            "px-4": fullWidth,
          },
          containerClassName
        )}
      >
        {children}
      </div>
    </section>
  );
}

interface SectionHeaderProps {
  title: string;
  description?: string;
  align?: "left" | "center" | "right";
  titleClassName?: string;
  descriptionClassName?: string;
  className?: string;
}

export function SectionHeader({
  title,
  description,
  align = "center",
  titleClassName,
  descriptionClassName,
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "mb-12 md:mb-16",
        {
          "text-center": align === "center",
          "text-left": align === "left",
          "text-right": align === "right",
        },
        className
      )}
    >
      <h2
        className={cn(
          "text-3xl font-bold tracking-tight md:text-4xl lg:text-5xl",
          titleClassName
        )}
      >
        {title}
      </h2>
      {description && (
        <p
          className={cn(
            "mt-4 max-w-3xl text-lg text-muted-foreground",
            {
              "mx-auto": align === "center",
              "ml-auto": align === "right",
            },
            descriptionClassName
          )}
        >
          {description}
        </p>
      )}
    </div>
  );
}

interface SectionContentProps {
  children: React.ReactNode;
  className?: string;
}

export function SectionContent({
  children,
  className,
}: SectionContentProps) {
  return (
    <div className={cn("relative", className)}>
      {children}
    </div>
  );
} 