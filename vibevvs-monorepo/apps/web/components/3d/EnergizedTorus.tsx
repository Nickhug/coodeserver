import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface EnergizedTorusProps {
  size?: number;
  color?: string;
  rotationSpeed?: number;
  energySpeed?: number;
  className?: string;
}

const EnergizedTorus: React.FC<EnergizedTorusProps> = ({
  size = 100,
  color = '#85ffc4',
  rotationSpeed = 0.01,
  energySpeed = 0.02,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const torusRef = useRef<THREE.Mesh | null>(null);

  useEffect(() => {
    if (!mountRef.current) return;

    // Scene setup
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Camera setup
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
    camera.position.z = 5;
    cameraRef.current = camera;

    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ 
      antialias: true,
      alpha: true 
    });
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    mountRef.current.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    // Create torus
    // Parameters: radius, tube radius, radial segments, tubular segments
    const geometry = new THREE.TorusGeometry(1.7, 0.68, 16, 100);
    
    // Create torus material
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.7,
      shininess: 80,
      emissive: new THREE.Color(color).getHex(),
      emissiveIntensity: 0.2,
    });

    // Create torus
    const torus = new THREE.Mesh(geometry, material);
    scene.add(torus);
    torusRef.current = torus;

    // Create energy flow effect (particles)
    const particlesGeometry = new THREE.BufferGeometry();
    const particleCount = 50;
    const positions = new Float32Array(particleCount * 3);
    const particleSize = 0.05;
    
    // Position particles along the torus
    for (let i = 0; i < particleCount; i++) {
      const t = i / particleCount * Math.PI * 2;
      const radius = 1.7; // Adjusted radius for particle positioning
      const tubeRadius = 0.68; // Adjusted tubeRadius for particle positioning
      
      // Distribute particles in a circle along the torus
      positions[i * 3] = (radius + tubeRadius * Math.cos(t * 5)) * Math.cos(t);
      positions[i * 3 + 1] = (radius + tubeRadius * Math.cos(t * 5)) * Math.sin(t);
      positions[i * 3 + 2] = tubeRadius * Math.sin(t * 5);
    }
    
    particlesGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    // Create particle material
    const particleMaterial = new THREE.PointsMaterial({
      color: new THREE.Color(color).getHex(),
      size: particleSize,
      transparent: true,
      opacity: 0.8,
      blending: THREE.AdditiveBlending,
    });
    
    const energyParticles = new THREE.Points(particlesGeometry, particleMaterial);
    torus.add(energyParticles);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    const pointLight = new THREE.PointLight(color, 1.5, 10);
    pointLight.position.set(0, 0, 2);
    scene.add(pointLight);

    // Animation loop
    let frameId: number;
    let time = 0;
    
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      time += energySpeed;
      
      if (torusRef.current) {
        // Rotation - removed horizontal orientation to make torus face camera directly
        // Now the face of the torus will point toward the camera
        torus.rotation.y += rotationSpeed;
        
        // Update particle positions for energy flow effect
        const positions = particlesGeometry.attributes.position.array as Float32Array;
        
        for (let i = 0; i < particleCount; i++) {
          const t = (i / particleCount * Math.PI * 2) + time;
          const radius = 1.7; // Adjusted radius for particle animation
          const tubeRadius = 0.68; // Adjusted tubeRadius for particle animation
          
          positions[i * 3] = (radius + tubeRadius * Math.cos(t * 5)) * Math.cos(t);
          positions[i * 3 + 1] = (radius + tubeRadius * Math.cos(t * 5)) * Math.sin(t);
          positions[i * 3 + 2] = tubeRadius * Math.sin(t * 5);
        }
        
        particlesGeometry.attributes.position.needsUpdate = true;
        
        // Pulse the glow
        pointLight.intensity = 1.5 + Math.sin(time * 2) * 0.5;
      }
      
      renderer.render(scene, camera);
    };
    
    animate();

    // Handle resize
    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      rendererRef.current.setSize(size, size);
    };

    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(frameId);
      
      if (mountRef.current && rendererRef.current) {
        mountRef.current.removeChild(rendererRef.current.domElement);
      }
      
      if (torusRef.current) {
        geometry.dispose();
        material.dispose();
        particlesGeometry.dispose();
        particleMaterial.dispose();
      }
    };
  }, [size, color, rotationSpeed, energySpeed]);

  return (
    <div 
      ref={mountRef} 
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default EnergizedTorus; 