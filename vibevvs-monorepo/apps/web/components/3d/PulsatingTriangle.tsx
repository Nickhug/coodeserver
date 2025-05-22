import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

interface PulsatingTriangleProps {
  size?: number;
  colorA?: string;
  colorB?: string;
  colorC?: string;
  pulsateSpeed?: number;
  rotationSpeed?: number;
  className?: string;
}

const PulsatingTriangle: React.FC<PulsatingTriangleProps> = ({
  size = 120,
  colorA = '#ff3e88',
  colorB = '#ffcf4b',
  colorC = '#85ffc4',
  pulsateSpeed = 0.01,
  rotationSpeed = 0.005,
  className = '',
}) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const triangleRef = useRef<THREE.Mesh | null>(null);

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

    // Create a triangle geometry
    const geometry = new THREE.BufferGeometry();
    
    // Define vertices for a simple triangle
    const vertices = new Float32Array([
      0, 2, 0,     // top
      -1.73, -1, 0, // bottom left
      1.73, -1, 0   // bottom right
    ]);
    
    // Define vertex colors (RGB for each vertex)
    const colors = new Float32Array([
      ...new THREE.Color(colorA).toArray(),
      ...new THREE.Color(colorB).toArray(),
      ...new THREE.Color(colorC).toArray()
    ]);
    
    // Set attributes
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    
    // Create gradient material
    const material = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8
    });
    
    // Create triangle mesh
    const triangle = new THREE.Mesh(geometry, material);
    scene.add(triangle);
    triangleRef.current = triangle;
    
    // Create wireframe for the edges
    const wireGeometry = new THREE.EdgesGeometry(geometry);
    const wireMaterial = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9
    });
    const wireframe = new THREE.LineSegments(wireGeometry, wireMaterial);
    triangle.add(wireframe);
    
    // Add lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    // Create a point light that follows the triangle
    const pointLight = new THREE.PointLight(0xffffff, 1, 10);
    pointLight.position.set(0, 0, 3);
    scene.add(pointLight);

    // Animation loop
    let frameId: number;
    let time = 0;
    
    const animate = () => {
      frameId = requestAnimationFrame(animate);
      time += pulsateSpeed;
      
      if (triangleRef.current) {
        // Rotation
        triangle.rotation.x += rotationSpeed;
        triangle.rotation.y += rotationSpeed * 0.7;
        triangle.rotation.z += rotationSpeed * 0.3;
        
        // Pulsating effect
        const scale = 0.9 + Math.sin(time) * 0.1;
        triangle.scale.set(scale, scale, scale);
        
        // Add a subtle hover effect
        triangle.position.y = Math.sin(time * 0.5) * 0.2;
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
      
      if (triangleRef.current) {
        geometry.dispose();
        material.dispose();
        wireGeometry.dispose();
        wireMaterial.dispose();
      }
    };
  }, [size, colorA, colorB, colorC, pulsateSpeed, rotationSpeed]);

  return (
    <div 
      ref={mountRef} 
      className={`relative ${className}`}
      style={{ width: size, height: size }}
    />
  );
};

export default PulsatingTriangle; 