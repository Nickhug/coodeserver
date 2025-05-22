import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface GlowingSphereProps {
  size?: number;
  color?: string;
  glowIntensity?: number;
  rotationSpeed?: number;
  className?: string;
}

const GlowingSphere: React.FC<GlowingSphereProps> = ({
  size = 100,
  color = '#ffcf4b',
  glowIntensity = 1.2,
  rotationSpeed = 0.005,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sphereRef = useRef<THREE.Mesh | null>(null);

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

    // Create sphere
    const geometry = new THREE.SphereGeometry(2.04, 64, 64);
    
    // Create sphere material with glow effect
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.7,
      shininess: 50,
      emissive: new THREE.Color(color).getHex(),
      emissiveIntensity: 0.5,
    });

    // Create sphere
    const sphere = new THREE.Mesh(geometry, material);
    scene.add(sphere);
    sphereRef.current = sphere;

    // Create glow effect (outer sphere)
    const glowGeometry = new THREE.SphereGeometry(2.04 * 1.08333, 32, 32);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.2,
      side: THREE.BackSide,
    });
    const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
    glowMesh.scale.multiplyScalar(1.2);
    scene.add(glowMesh);

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    const pointLight = new THREE.PointLight(color, glowIntensity, 10);
    pointLight.position.set(0, 0, 3);
    scene.add(pointLight);

    // Animation loop
    let frameId: number;
    let time = 0;
    
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      time += 0.01;
      
      if (sphereRef.current) {
        // Rotation
        sphere.rotation.y += rotationSpeed;
        glowMesh.rotation.y = sphere.rotation.y;
        
        // Subtle breathing effect
        const scale = 1 + Math.sin(time) * 0.05;
        glowMesh.scale.set(scale * 1.2, scale * 1.2, scale * 1.2);
        
        // Pulse the light intensity
        pointLight.intensity = glowIntensity + Math.sin(time * 2) * 0.3;
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
      
      if (sphereRef.current) {
        geometry.dispose();
        material.dispose();
        glowGeometry.dispose();
        glowMaterial.dispose();
      }
    };
  }, [size, color, glowIntensity, rotationSpeed]);

  return (
    <div 
      ref={mountRef} 
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default GlowingSphere; 