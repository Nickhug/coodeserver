import React from 'react';
import { 
  FuturisticCube, 
  PulsatingTriangle, 
  GlowingSphere, 
  ShinyOctahedron, 
  TorusKnot, 
  EnergizedTorus 
} from './3d';
import { Card, CardContent } from './ui/card';
import { GlowingEffect } from './ui/glowing-effect';
import { cn } from '../lib/utils';

type Feature3DType = 'cube' | 'triangle' | 'sphere' | 'octahedron' | 'torusKnot' | 'torus' | 'none';

interface FeatureCard3DProps {
  title: string;
  description: string;
  type3D: Feature3DType;
  colorA?: string;
  colorB?: string;
  colorC?: string;
  className?: string;
}

const FeatureCard3D: React.FC<FeatureCard3DProps> = ({
  title,
  description,
  type3D,
  colorA = '#ff3e88',
  colorB = '#ffcf4b',
  colorC = '#85ffc4',
  className = '',
}) => {
  const D3ObjectSize = 54; // Increased by 20% from 45px
  const iconBoxSizeClasses = "w-14 h-14"; // Keeping the container size the same

  const get3DElement = () => {
    const commonWrapperClasses =
      `w-fit rounded-lg border border-white/20 bg-white/5 p-2 shadow-md`;

    switch (type3D) {
      case 'cube':
        return (
          <div className={commonWrapperClasses}>
            <FuturisticCube 
              size={D3ObjectSize} 
              color={colorA}
              rotationSpeed={0.01}
            />
          </div>
        );
      case 'triangle':
        return (
          <div className={commonWrapperClasses}>
            <PulsatingTriangle 
              size={D3ObjectSize} 
              colorA={colorA}
              colorB={colorB}
              colorC={colorC}
              pulsateSpeed={0.008}
              rotationSpeed={0.004}
            />
          </div>
        );
      case 'sphere':
        return (
          <div className={commonWrapperClasses}>
            <GlowingSphere 
              size={D3ObjectSize} 
              color={colorA}
              glowIntensity={1.2}
              rotationSpeed={0.005}
            />
          </div>
        );
      case 'octahedron':
        return (
          <div className={commonWrapperClasses}>
            <ShinyOctahedron 
              size={D3ObjectSize} 
              color={colorA}
              rotationSpeed={0.01}
            />
          </div>
        );
      case 'torusKnot':
        return (
          <div className={commonWrapperClasses}>
            <TorusKnot 
              size={D3ObjectSize} 
              color={colorA}
              rotationSpeed={0.01}
            />
          </div>
        );
      case 'torus':
        return (
          <div className={commonWrapperClasses}>
            <EnergizedTorus 
              size={D3ObjectSize} 
              color={colorA}
              rotationSpeed={0.01}
              energySpeed={0.02}
            />
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <li className={cn("min-h-[14rem] list-none", className)}>
      <div className="relative h-full rounded-2xl border border-white/10 p-2 md:rounded-3xl md:p-3">
        <GlowingEffect
          spread={40}
          glow={true}
          disabled={false}
          proximity={64}
          inactiveZone={0.01}
        />
        <div className="relative flex h-full flex-col justify-start gap-6 overflow-hidden rounded-xl border border-white/10 bg-black p-6 dark:shadow-[0px_0px_27px_0px_#2D2D2D]">
          <div className="relative flex flex-1 flex-col justify-start gap-3">
            <div className="w-fit rounded-lg border border-white/20 bg-white/5 p-2">
              {get3DElement()}
            </div>
            <div className="space-y-3">
              <h3 className="pt-0.5 font-sans text-xl/[1.375rem] font-semibold text-balance text-white md:text-2xl/[1.875rem]">
                {title}
              </h3>
              <p className="font-sans text-sm/[1.125rem] text-white/80 md:text-base/[1.375rem]">
                {description}
              </p>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
};

export default FeatureCard3D; 