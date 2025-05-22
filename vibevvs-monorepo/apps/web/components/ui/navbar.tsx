"use client";

import { useState, useEffect } from "react";
import { cn } from "../../lib/utils";
import Link from "next/link";
import { Button } from "./button";

interface NavbarProps extends React.HTMLAttributes<HTMLElement> {
  logo?: React.ReactNode;
  menuItems?: Array<{
    label: string;
    href: string;
  }>;
  actions?: React.ReactNode;
  transparent?: boolean;
  sticky?: boolean;
  className?: string;
  rightAlignMenu?: boolean;
}

export function Navbar({
  logo,
  menuItems = [],
  actions,
  transparent = false,
  sticky = false,
  className,
  rightAlignMenu = false,
  ...props
}: NavbarProps) {
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  useEffect(() => {
    if (!transparent && !sticky) return;

    const handleScroll = () => {
      const offset = window.scrollY;
      setIsScrolled(offset > 50);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, [transparent, sticky]);

  return (
    <header
      className={cn(
        "w-full z-50 transition-all duration-300",
        {
          "fixed top-0 left-0 right-0": transparent || sticky,
          "bg-background/80 backdrop-blur-md shadow-sm": isScrolled || !transparent,
          "bg-transparent": transparent && !isScrolled,
          "sticky top-0": sticky,
        },
        className
      )}
      {...props}
    >
      <div className="container mx-auto px-4 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center">
            {logo && <div className="mr-6">{logo}</div>}
            
            <nav className={cn(
              "hidden md:flex space-x-6",
              rightAlignMenu && "absolute left-1/2 right-0 transform -translate-x-1/2 justify-center"
            )}>
              {menuItems.map((item, index) => (
                <Link 
                  key={index} 
                  href={item.href}
                  className="text-sm font-medium text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>

          <div className="hidden md:flex items-center space-x-4">
            {actions}
          </div>

          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className="md:hidden flex items-center"
            aria-label="Toggle menu"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {isMobileMenuOpen ? (
                <path
                  d="M6 18L18 6M6 6L18 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : (
                <path
                  d="M4 6H20M4 12H20M4 18H20"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              )}
            </svg>
          </button>
        </div>

        {isMobileMenuOpen && (
          <div className="md:hidden py-4">
            <nav className="flex flex-col space-y-4">
              {menuItems.map((item, index) => (
                <Link
                  key={index}
                  href={item.href}
                  className="text-sm font-medium text-gray-700 dark:text-gray-200 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  {item.label}
                </Link>
              ))}
            </nav>
            <div className="flex flex-col space-y-4 mt-6">
              {actions}
            </div>
          </div>
        )}
      </div>
    </header>
  );
} 