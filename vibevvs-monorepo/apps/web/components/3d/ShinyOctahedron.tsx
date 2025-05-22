import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface ShinyOctahedronProps {
  size?: number;
  color?: string;
  rotationSpeed?: number;
  className?: string;
}

const ShinyOctahedron: React.FC<ShinyOctahedronProps> = ({
  size = 100,
  color = '#85ffc4',
  rotationSpeed = 0.01,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const octahedronRef = useRef<THREE.Mesh | null>(null);

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

    // Create octahedron
    const geometry = new THREE.OctahedronGeometry(2.04);
    
    // Create edges for premium look
    const edges = new THREE.EdgesGeometry(geometry);
    const edgesMaterial = new THREE.LineBasicMaterial({ 
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.8
    });
    const edgesLine = new THREE.LineSegments(edges, edgesMaterial);
    scene.add(edgesLine);

    // Create octahedron material
    const material = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.2,
      metalness: 0.9,
      roughness: 0.1,
      reflectivity: 1,
      clearcoat: 1.0,
    });

    // Create octahedron
    const octahedron = new THREE.Mesh(geometry, material);
    scene.add(octahedron);
    octahedronRef.current = octahedron;

    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(1, 1, 1);
    scene.add(directionalLight);

    const pointLight = new THREE.PointLight(color, 1, 10);
    pointLight.position.set(2, 2, 2);
    scene.add(pointLight);

    // Animation loop
    let frameId: number;
    
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      
      if (octahedronRef.current) {
        octahedron.rotation.x += rotationSpeed;
        octahedron.rotation.y += rotationSpeed * 0.8;
        edgesLine.rotation.x = octahedron.rotation.x;
        edgesLine.rotation.y = octahedron.rotation.y;
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
      
      if (octahedronRef.current) {
        geometry.dispose();
        material.dispose();
        edges.dispose();
        edgesMaterial.dispose();
      }
    };
  }, [size, color, rotationSpeed]);

  return (
    <div 
      ref={mountRef} 
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default ShinyOctahedron; 