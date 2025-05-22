import React, { useState, useEffect, useRef } from "react";
import { cn } from "../../lib/utils";

interface TextAnimatorProps {
  words: string[];
  className?: string;
  speed?: number;
  delay?: number;
  loop?: boolean;
  cursor?: boolean;
  tag?: keyof JSX.IntrinsicElements;
}

export function TextAnimator({
  words,
  className,
  speed = 100,
  delay = 1500,
  loop = true,
  cursor = true,
  tag: Tag = "span",
}: TextAnimatorProps) {
  const [currentWordIndex, setCurrentWordIndex] = useState(0);
  const [currentText, setCurrentText] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (words.length === 0) return;

    const currentWord = words[currentWordIndex];

    // Clear existing timer
    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    if (isPaused) {
      timerRef.current = setTimeout(() => {
        setIsPaused(false);
        setIsDeleting(true);
      }, delay);
      return;
    }

    if (isDeleting) {
      if (currentText.length === 0) {
        setIsDeleting(false);
        setCurrentWordIndex((prev) => (loop || prev < words.length - 1 ? (prev + 1) % words.length : prev));
      } else {
        timerRef.current = setTimeout(() => {
          setCurrentText(currentText.slice(0, -1));
        }, speed / 1.5); // Delete faster than typing
      }
    } else {
      if (currentText === currentWord) {
        setIsPaused(true);
      } else {
        timerRef.current = setTimeout(() => {
          setCurrentText(currentWord.slice(0, currentText.length + 1));
        }, speed);
      }
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [currentText, currentWordIndex, isDeleting, isPaused, words, speed, delay, loop]);

  return (
    <Tag className={className}>
      {currentText}
      {cursor && <span className="animate-blink">|</span>}
    </Tag>
  );
} 