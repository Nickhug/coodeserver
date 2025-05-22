"use client";

import React from 'react';

interface AiLogoProps {
  className?: string;
}

const AiProviderLogos: React.FC<AiLogoProps> = ({ className = '' }) => {
  const aiProviders = [
    {
      name: 'OpenAI GPT',
      icon: 'openai',
      url: 'https://openai.com/gpt-4',
      color: 'rgba(16, 163, 127, 0.3)' // OpenAI green, softer
    },
    {
      name: 'Gemini',
      icon: 'gemini',
      url: 'https://deepmind.google/technologies/gemini/',
      color: 'rgba(78, 115, 248, 0.3)' // Google blue, softer
    },
    {
      name: 'Claude',
      icon: 'anthropic',
      url: 'https://www.anthropic.com/claude',
      color: 'rgba(175, 77, 247, 0.3)' // Purple, softer
    },
    {
      name: 'GithubCopilot',
      icon: 'githubcopilot',
      url: 'https://github.com/features/copilot',
      color: 'rgba(138, 43, 226, 0.3)' // Purple/GitHub, softer
    },
    {
      name: 'Cursor',
      icon: 'cursor',
      url: 'https://cursor.sh',
      color: 'rgba(0, 122, 255, 0.3)' // Blue/Cursor, softer
    },
    {
      name: 'Cline',
      icon: 'Cline',
      url: 'https://cline.ai/',
      color: 'rgba(121, 218, 187, 0.3)' // Teal, softer
    }
  ];

  return (
    <div className={`flex flex-wrap justify-center items-center gap-12 md:gap-20 ${className}`}>
      {aiProviders.map((provider, index) => (
        <a 
          key={provider.name}
          href={provider.url} 
          target="_blank" 
          rel="noopener noreferrer"
          className="relative h-6 md:h-8 opacity-70 hover:opacity-100 transition-all duration-300 hover:scale-110 group"
          style={{
            animation: `pulse 4s ease-in-out infinite ${index * 0.5}s`,
          }}
        >
          {/* Glow Aura Effect */}
          <div 
            className="absolute inset-0 opacity-0 group-hover:opacity-100 rounded-lg transition-opacity duration-300 blur-xl -z-10"
            style={{ 
              background: provider.color,
            }}
          />
          <img 
            src={`https://unpkg.com/@lobehub/icons-static-svg@latest/icons/${provider.icon}.svg`}
            alt={provider.name} 
            className="h-full w-auto relative z-10 transition-transform duration-500 ease-in-out group-hover:rotate-y-360"
            style={{ filter: 'brightness(0) invert(1)' }} 
          />
        </a>
      ))}

      <style jsx global>{`
        @keyframes pulse {
          0%, 100% { opacity: 0.7; } 
          50% { opacity: 1; }   
        }
        .group:hover .group-hover\:rotate-y-360 {
          transform: rotateY(360deg);
        }
      `}</style>
    </div>
  );
};

export default AiProviderLogos; 