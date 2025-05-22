import React from "react";
import { cn } from "../../lib/utils";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "./card";
import { BackgroundGradient } from "./background-gradient";

interface FeatureCardProps extends React.HTMLAttributes<HTMLDivElement> {
  title: string;
  description: string;
  icon?: React.ReactNode;
  className?: string;
  iconClassName?: string;
  bgClassName?: string;
  gradient?: boolean;
  highlighted?: boolean;
}

export function FeatureCard({
  title,
  description,
  icon,
  className,
  iconClassName,
  bgClassName,
  gradient = false,
  highlighted = false,
  ...props
}: FeatureCardProps) {
  const cardContent = (
    <Card 
      className={cn(
        "h-full transition-all duration-300 hover:shadow-md",
        {
          "border border-primary/10 bg-primary/5": highlighted,
          "border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900": !highlighted,
        },
        className
      )}
      glow={highlighted}
      {...props}
    >
      <CardHeader>
        {icon && (
          <div className={cn(
            "flex h-12 w-12 items-center justify-center rounded-lg mb-4",
            {
              "bg-primary/10 text-primary": highlighted,
              "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100": !highlighted,
            },
            iconClassName
          )}>
            {icon}
          </div>
        )}
        <CardTitle className="text-xl font-semibold">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <CardDescription className="text-muted-foreground">{description}</CardDescription>
      </CardContent>
    </Card>
  );

  if (gradient) {
    return (
      <BackgroundGradient className={bgClassName}>
        {cardContent}
      </BackgroundGradient>
    );
  }

  return cardContent;
} 