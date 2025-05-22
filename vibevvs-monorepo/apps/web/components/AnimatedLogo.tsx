"use client";

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';

interface AnimatedLogoProps {
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}

export default function AnimatedLogo({ 
  width = 150, 
  height = 60,
  className = "",
  style = {}
}: AnimatedLogoProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Setup
    const container = containerRef.current;
    
    // Configure scene with transparent background
    const scene = new THREE.Scene();
    
    // Configure camera
    const camera = new THREE.OrthographicCamera(
      -width / 2, width / 2, 
      height / 2, -height / 2, 
      0.1, 1000
    );
    camera.position.z = 10;
    
    // Configure renderer with high pixel ratio for better resolution
    const renderer = new THREE.WebGLRenderer({ 
      antialias: true,
      alpha: true,
      precision: 'highp'
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 3));
    renderer.setClearColor(0x000000, 0); // Transparent background
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;
    
    // Create the gradient shader material
    const gradientMaterial = new THREE.ShaderMaterial({
      transparent: true,
      side: THREE.DoubleSide, // Render both sides of the shapes
      uniforms: {
        time: { value: 0.0 },
        color1: { value: new THREE.Color("#aaaaaa") },
        color2: { value: new THREE.Color("#bbbbbb") },
        color3: { value: new THREE.Color("#cccccc") },
        color4: { value: new THREE.Color("#dddddd") },
        color5: { value: new THREE.Color("#eeeeee") },
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform float time;
        uniform vec3 color1;
        uniform vec3 color2;
        uniform vec3 color3;
        uniform vec3 color4;
        uniform vec3 color5;
        varying vec2 vUv;
        
        void main() {
          // Moving gradient effect along the path
          float t = mod(vUv.x * 2.0 - time * 0.2, 5.0);
          vec3 color;
          
          if (t < 1.0) {
            color = mix(color1, color2, t);
          } else if (t < 2.0) {
            color = mix(color2, color3, t - 1.0);
          } else if (t < 3.0) {
            color = mix(color3, color4, t - 2.0);
          } else if (t < 4.0) {
            color = mix(color4, color5, t - 3.0);
          } else {
            color = mix(color5, color1, t - 4.0);
          }
          
          gl_FragColor = vec4(color, 1.0);
        }
      `
    });
    
    // Load SVG
    const loader = new SVGLoader();
    loader.load('/infinity.svg', (data) => {
      // Create the SVG group
      const svgGroup = new THREE.Group();
      
      // First, calculate overall bounding box to scale properly
      const box = new THREE.Box3();
      const paths = data.paths;
      
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const shapes = SVGLoader.createShapes(path);
        
        for (let j = 0; j < shapes.length; j++) {
          const shape = shapes[j];
          const geometry = new THREE.ShapeGeometry(shape);
          const mesh = new THREE.Mesh(geometry);
          box.expandByObject(mesh);
        }
      }
      
      // Calculate scale to fit container
      const size = new THREE.Vector3();
      box.getSize(size);
      const scale = Math.min(width / size.x, height / size.y) * 0.85;
      
      // Center offset
      const center = new THREE.Vector3();
      box.getCenter(center);
      
      // Create filled shapes from SVG
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        const shapes = SVGLoader.createShapes(path);
        
        for (let j = 0; j < shapes.length; j++) {
          const shape = shapes[j];
          
          // Create shape geometry
          const geometry = new THREE.ShapeGeometry(shape);
          
          // Generate custom UVs based on position for the gradient flow
          const positions = geometry.attributes.position.array;
          const uvs = [];
          
          // Get the range of the geometry
          const tempBox = new THREE.Box3().setFromBufferAttribute(
            geometry.attributes.position as THREE.BufferAttribute
          );
          const tempSize = new THREE.Vector3();
          tempBox.getSize(tempSize);
          
          // Create UVs based on normalized x position
          for (let k = 0; k < positions.length; k += 3) {
            const x = positions[k];
            const normalizedX = (x - tempBox.min.x) / tempSize.x;
            uvs.push(normalizedX, 0);
          }
          
          geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
          
          // Transform geometry to fit viewport
          geometry.translate(-center.x, -center.y, 0);
          geometry.scale(scale, scale, scale);
          
          // Create the mesh with our custom material
          const mesh = new THREE.Mesh(geometry, gradientMaterial);
          svgGroup.add(mesh);
        }
      }
      
      scene.add(svgGroup);
    });
    
    // Animation loop
    let time = 0;
    const clock = new THREE.Clock();
    let rafId: number;
    
    function animate() {
      rafId = requestAnimationFrame(animate);
      
      time += clock.getDelta() * 0.5; // Slow, smooth animation
      
      // Update all shader materials
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial) {
          object.material.uniforms.time.value = time;
        }
      });
      
      renderer.render(scene, camera);
    }
    
    animate();
    
    // Cleanup
    return () => {
      cancelAnimationFrame(rafId);
      if (rendererRef.current && container.contains(rendererRef.current.domElement)) {
        container.removeChild(rendererRef.current.domElement);
      }
      rendererRef.current?.dispose();
    };
  }, [width, height]);
  
  return (
    <div 
      ref={containerRef} 
      className={className}
      style={{ 
        width: `${width}px`, 
        height: `${height}px`,
        position: 'relative',
        display: 'inline-block',
        ...style
      }} 
    />
  );
} 