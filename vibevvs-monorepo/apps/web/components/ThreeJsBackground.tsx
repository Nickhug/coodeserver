'use client';

import React, { useRef, useEffect } from 'react';
import * as THREE from 'three';

export default function ThreeJsBackground() {
  const containerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    if (!containerRef.current) return;
    
    // Scene setup
    const scene = new THREE.Scene();
    
    // Camera setup
    const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, 5);
    
    // Renderer setup
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    containerRef.current.appendChild(renderer.domElement);
    
    // Create a plane for the fluid effect
    const planeGeometry = new THREE.PlaneGeometry(20, 20, 96, 96);
    
    // Define the shader material
    const shaderMaterial = new THREE.ShaderMaterial({
      vertexShader: `
        uniform float uTime;
        uniform float uElevation;
        
        varying vec2 vUv;
        varying float vElevation;
        
        // Simplex noise function
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
        vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
        
        float snoise(vec3 v) {
          const vec2 C = vec2(1.0/6.0, 1.0/3.0);
          const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
          
          // First corner
          vec3 i  = floor(v + dot(v, C.yyy));
          vec3 x0 = v - i + dot(i, C.xxx);
          
          // Other corners
          vec3 g = step(x0.yzx, x0.xyz);
          vec3 l = 1.0 - g;
          vec3 i1 = min(g.xyz, l.zxy);
          vec3 i2 = max(g.xyz, l.zxy);
          
          vec3 x1 = x0 - i1 + C.xxx;
          vec3 x2 = x0 - i2 + C.yyy;
          vec3 x3 = x0 - D.yyy;
          
          // Permutations
          i = mod289(i);
          vec4 p = permute(permute(permute(
                     i.z + vec4(0.0, i1.z, i2.z, 1.0))
                   + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                   + i.x + vec4(0.0, i1.x, i2.x, 1.0));
                   
          // Gradients
          float n_ = 0.142857142857;
          vec3 ns = n_ * D.wyz - D.xzx;
          
          vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
          
          vec4 x_ = floor(j * ns.z);
          vec4 y_ = floor(j - 7.0 * x_);
          
          vec4 x = x_ * ns.x + ns.yyyy;
          vec4 y = y_ * ns.x + ns.yyyy;
          vec4 h = 1.0 - abs(x) - abs(y);
          
          vec4 b0 = vec4(x.xy, y.xy);
          vec4 b1 = vec4(x.zw, y.zw);
          
          vec4 s0 = floor(b0) * 2.0 + 1.0;
          vec4 s1 = floor(b1) * 2.0 + 1.0;
          vec4 sh = -step(h, vec4(0.0));
          
          vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
          vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
          
          vec3 p0 = vec3(a0.xy, h.x);
          vec3 p1 = vec3(a0.zw, h.y);
          vec3 p2 = vec3(a1.xy, h.z);
          vec3 p3 = vec3(a1.zw, h.w);
          
          // Normalise gradients
          vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
          p0 *= norm.x;
          p1 *= norm.y;
          p2 *= norm.z;
          p3 *= norm.w;
          
          // Mix final noise value
          vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
          m = m * m;
          return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
        }
        
        void main() {
          vUv = uv;
          
          // Create an undulating, flowing surface using noise
          vec3 pos = position;
          float noiseFreq = 1.0; // Reduced frequency for slower waves
          float noiseAmp = uElevation;
          
          vec3 noisePos = vec3(
            pos.x * noiseFreq + uTime * 0.04, // Slowed down time factor (0.05 * 0.8)
            pos.y * noiseFreq + uTime * 0.08, // Slowed down time factor (0.1 * 0.8)
            pos.z * noiseFreq + uTime * 0.04 // Slowed down time factor (0.05 * 0.8)
          );
          
          // Main undulation
          float noise = snoise(noisePos);
          
          // Secondary, faster waves - also slowed down
          float noise2 = snoise(noisePos * 1.5 + uTime * 0.16) * 0.4; // Slowed (0.2*0.8) and reduced amplitude
          
          // Combine noise patterns
          vElevation = noise + noise2;
          
          // Apply the elevation to the z position
          pos.z += vElevation * noiseAmp;
          
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform float uTime;
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform vec3 uColorC;
        
        varying vec2 vUv;
        varying float vElevation;
      
        void main() {
          // Create flowing color gradients based on position and time - slowed down
          float mixStrength = sin(vUv.x * 3.0 + uTime * 0.20) * 0.5 + 0.5; // Slowed down (0.25*0.8) and reduced frequency
          vec3 colorA = uColorA;
          vec3 colorB = uColorB;
          vec3 colorC = uColorC;
          
          vec3 mixedColor = mix(
            mix(colorA, colorB, mixStrength),
            colorC,
            sin(vUv.y * 2.0 + uTime * 0.08) * 0.5 + 0.5 // Slowed down (0.1*0.8) and reduced frequency
          );
          
          // Add some depth based on elevation
          mixedColor *= 0.8 + vElevation * 0.4;
          
          // Add rim lighting effect
          float rim = 1.0 - vElevation;
          rim = pow(rim, 4.0);
          mixedColor += rim * 0.07; // Significantly reduced rim light intensity
          
          gl_FragColor = vec4(mixedColor, 1.0);
        }
      `,
      uniforms: {
        uTime: { value: 0 },
        uElevation: { value: 0.315 }, // Increased base elevation by 5% (0.3 * 1.05)
        uColorA: { value: new THREE.Color('#be185d').convertSRGBToLinear() }, // Hero section's fifthColor (Dark Pink)
        uColorB: { value: new THREE.Color('#db2777').convertSRGBToLinear() }, // Hero section's fifthColor (Dark Pink)
        uColorC: { value: new THREE.Color('#9d174d').convertSRGBToLinear() }  // Hero section's fifthColor (Dark Pink)
      }
    });
    
    const plane = new THREE.Mesh(planeGeometry, shaderMaterial);
    plane.rotation.x = -Math.PI / 3;
    scene.add(plane);
    
    // Add lighting
    const ambientLight = new THREE.AmbientLight(0x000000, 0.5); // Black ambient light
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0x000000, 1); // Black directional light
    directionalLight.position.set(10, 10, 5);
    scene.add(directionalLight);
    
    // Handle window resize
    const handleResize = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      
      renderer.setSize(width, height);
    };
    
    window.addEventListener('resize', handleResize);
    
    // Animation loop
    const clock = new THREE.Clock();
    
    const animate = () => {
      const elapsedTime = clock.getElapsedTime();
      
      // Update shader uniforms - slow down the animation by multiplying time by smaller values
      shaderMaterial.uniforms.uTime.value = elapsedTime * 0.4; // Slowed down by 20% (0.5 * 0.8)
      const pulseAmount = Math.sin(elapsedTime * 0.08) * 0.105 + 0.315; // Slowed down pulse (0.1*0.8) and increased amplitude/base for wave height
      shaderMaterial.uniforms.uElevation.value = pulseAmount;
      
      // Update plane rotation for subtle movement - slowed down
      plane.rotation.z = Math.sin(elapsedTime * 0.02) * 0.05; // (0.025 * 0.8)
      
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    
    animate();
    
    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      scene.traverse(object => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          if (object.material instanceof THREE.Material) {
            object.material.dispose();
          } else if (Array.isArray(object.material)) {
            object.material.forEach(material => material.dispose());
          }
        }
      });
      renderer.dispose();
      if (containerRef.current) {
        containerRef.current.removeChild(renderer.domElement);
      }
    };
  }, []);
  
  return (
    <div ref={containerRef} className="absolute inset-0 z-0" />
  );
} 