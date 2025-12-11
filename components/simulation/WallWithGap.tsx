import React from 'react';
import * as THREE from 'three';

export const WallWithGap: React.FC = () => {
  const wallHeight = 3;
  const wallThickness = 0.5;
  const wallLength = 40;
  const gapWidth = 6;
  const boundarySize = 28; // ±14 boundaries
  
  return (
    <group>
      {/* Central wall with gap at z=0 */}
      {/* Left wall segment (west of gap) */}
      <mesh position={[-(wallLength/2 + gapWidth/2)/2, wallHeight/2, 0]} castShadow receiveShadow>
        <boxGeometry args={[wallLength/2 - gapWidth/2, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.8} metalness={0.2} />
      </mesh>
      
      {/* Right wall segment (east of gap) */}
      <mesh position={[(wallLength/2 + gapWidth/2)/2, wallHeight/2, 0]} castShadow receiveShadow>
        <boxGeometry args={[wallLength/2 - gapWidth/2, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#1a1a1a" roughness={0.8} metalness={0.2} />
      </mesh>
      
      {/* Boundary walls around entire environment */}
      {/* North wall (positive z) */}
      <mesh position={[0, wallHeight/2, boundarySize/2]} castShadow receiveShadow>
        <boxGeometry args={[boundarySize, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#333333" roughness={0.8} metalness={0.2} />
      </mesh>
      
      {/* South wall (negative z) */}
      <mesh position={[0, wallHeight/2, -boundarySize/2]} castShadow receiveShadow>
        <boxGeometry args={[boundarySize, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#333333" roughness={0.8} metalness={0.2} />
      </mesh>
      
      {/* East wall (positive x) */}
      <mesh position={[boundarySize/2, wallHeight/2, 0]} rotation={[0, Math.PI/2, 0]} castShadow receiveShadow>
        <boxGeometry args={[boundarySize, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#333333" roughness={0.8} metalness={0.2} />
      </mesh>
      
      {/* West wall (negative x) */}
      <mesh position={[-boundarySize/2, wallHeight/2, 0]} rotation={[0, Math.PI/2, 0]} castShadow receiveShadow>
        <boxGeometry args={[boundarySize, wallHeight, wallThickness]} />
        <meshStandardMaterial color="#333333" roughness={0.8} metalness={0.2} />
      </mesh>
    </group>
  );
};
