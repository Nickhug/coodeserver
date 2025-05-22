import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface FuturisticCubeProps {
  size?: number;
  color?: string;
  wireframe?: boolean;
  rotationSpeed?: number;
  className?: string;
}

const FuturisticCube: React.FC<FuturisticCubeProps> = ({
  size = 100,
  color = '#ff3e88',
  wireframe = false,
  rotationSpeed = 0.01,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const cubeRef = useRef<THREE.Mesh | null>(null);

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

    // Create cube
    const geometry = new THREE.BoxGeometry(3.4, 3.4, 3.4);
    
    // Create edges for premium look
    const edges = new THREE.EdgesGeometry(geometry);
    const edgesMaterial = new THREE.LineBasicMaterial({ 
      color: new THREE.Color(color).getHex(),
      transparent: true,
      opacity: 0.8
    });
    const edgesLine = new THREE.LineSegments(edges, edgesMaterial);
    scene.add(edgesLine);

    // Create cube material
    const material = new THREE.MeshPhongMaterial({
      color: new THREE.Color(color).getHex(),
      wireframe,
      transparent: true,
      opacity: 0.15,
      shininess: 100,
    });

    // Create cube
    const cube = new THREE.Mesh(geometry, material);
    scene.add(cube);
    cubeRef.current = cube;

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
      
      if (cubeRef.current) {
        cube.rotation.x += rotationSpeed;
        cube.rotation.y += rotationSpeed * 0.8;
        edgesLine.rotation.x = cube.rotation.x;
        edgesLine.rotation.y = cube.rotation.y;
      }
      
      renderer.render(scene, camera);
    };
    
    animate();

    // Handle resize
    const handleResize = () => {
      if (!mountRef.current || !cameraRef.current || !rendererRef.current) return;
      
      // Keep aspect ratio 1:1 for the cube
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
      
      if (cubeRef.current) {
        geometry.dispose();
        material.dispose();
        edges.dispose();
        edgesMaterial.dispose();
      }
    };
  }, [size, color, wireframe, rotationSpeed]);

  return (
    <div 
      ref={mountRef} 
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default FuturisticCube; 