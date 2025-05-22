import React from 'react';
import FeatureCard3D from './FeatureCard3D';
import { Section, SectionHeader } from './ui/section';

interface FeaturesSectionProps {
  className?: string;
}

const FeaturesSection: React.FC<FeaturesSectionProps> = ({ className = '' }) => {
  // Color palette based on the site's primary pink/crimson theme
  // Primary theme color: #be185d (crimson pink)
  const colors = {
    primary: '#be185d',     // Primary crimson pink
    lighter: '#db2777',     // Lighter pink
    darker: '#9d174d',      // Darker crimson
    vibrant: '#ec4899',     // Vibrant pink
    deep: '#831843',        // Deep magenta 
    subtle: '#f472b6',      // Subtle light pink
  };

  return (
    <Section id="features" className={`py-16 md:py-24 ${className}`}>
      <SectionHeader 
        title="Superior AI Features"
        description="Enhance your coding workflow with powerful AI assistance that understands your codebase."
      />

      <ul className="grid grid-cols-1 md:grid-cols-3 gap-8 mt-12 lg:gap-4">
        {/* Feature 5 (Feels Familiar) - Large Vertical Card on Left */}
        <FeatureCard3D
          title="Feels Familiar"
          description="Import all your extensions, themes, and keybindings in one click. Try it out for yourself."
          type3D="sphere"
          colorA={colors.darker}
          className="md:row-span-2 md:col-span-1 h-full"
        />

        {/* Container for the 2x2 grid */}
        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-8 lg:gap-4">
          {/* Feature 1 (Knows Your Codebase) */}
          <FeatureCard3D
            title="Knows Your Codebase"
            description="Get answers from your codebase or refer to files or docs. Use the model's code in one click."
            type3D="octahedron"
            colorA={colors.deep}
            className="h-full"
          />

          {/* Feature 2 (Edit in Natural Language) */}
          <FeatureCard3D
            title="Edit in Natural Language"
            description="Cursor lets you write code using instructions. Update entire classes or functions with a simple prompt."
            type3D="cube"
            colorA={colors.primary}
            className="h-full"
          />

          {/* Feature 3 (Build Software Faster) */}
          <FeatureCard3D
            title="Build Software Faster"
            description="Intelligent, fast, and familiar. The best way to code with AI. Seriously."
            type3D="torus"
            colorA={colors.vibrant}
            className="h-full"
          />

          {/* Feature 4 (Frontier Intelligence) */}
          <FeatureCard3D
            title="Frontier Intelligence"
            description="Powered by a mix of purpose-built and frontier models, smart and fast."
            type3D="torusKnot"
            colorA={colors.primary}
            className="h-full"
          />
        </div>
      </ul>
    </Section>
  );
};

export default FeaturesSection; 