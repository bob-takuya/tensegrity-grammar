import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { useAppState } from '../state/context';
import { DiagramData, DiagramNode, DiagramEdge, Vec2 } from '../types';
import { sub, add, scale, normalize, length, perp } from '../engine/geometry';

/**
 * 3D Viewer for the tensegrity structure.
 *
 * Renders:
 *  - Compression members as 3D rectangular plates (boxes)
 *  - Tension members as thin cables (lines/cylinders)
 *  - Nodes as small spheres
 *  - Supports as ground markers
 *  - Force arrows
 *
 * The 2D diagram is extruded into 3D using plate thickness.
 * OrbitControls-style interaction (rotate, pan, zoom) is implemented manually.
 */

const WORLD_SCALE = 1; // 1 world unit = 1 Three.js unit

export function Viewer3D() {
  const { state } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const frameRef = useRef<number>(0);
  const [size, setSize] = useState({ w: 600, h: 500 });

  // Orbit state
  const orbitRef = useRef({
    theta: Math.PI / 4,
    phi: Math.PI / 3,
    distance: 8,
    target: new THREE.Vector3(2, 0, 1),
    isDragging: false,
    isPanning: false,
    lastX: 0,
    lastY: 0,
  });

  const { diagram, equilibrium } = state;

  // Initialize Three.js
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0xf0f0ee);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    cameraRef.current = camera;

    // Lighting
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(5, 10, 7);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 1024;
    dirLight.shadow.mapSize.height = 1024;
    scene.add(dirLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
    fillLight.position.set(-3, 5, -5);
    scene.add(fillLight);

    // Ground plane
    const groundGeo = new THREE.PlaneGeometry(20, 20);
    const groundMat = new THREE.MeshStandardMaterial({
      color: 0xe8e8e5,
      roughness: 0.9,
    });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.01;
    ground.receiveShadow = true;
    ground.name = '__ground';
    scene.add(ground);

    // Grid helper
    const grid = new THREE.GridHelper(20, 40, 0xcccccc, 0xdddddd);
    grid.name = '__grid';
    scene.add(grid);

    // Resize observer
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setSize({ w: width, h: height });
        renderer.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      }
    });
    ro.observe(container);

    // Animation loop
    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      updateCamera(camera, orbitRef.current);
      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(frameRef.current);
      ro.disconnect();
      renderer.dispose();
      container.removeChild(renderer.domElement);
    };
  }, []);

  // Update scene when diagram changes
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old structure objects (keep lights, ground, grid)
    const toRemove: THREE.Object3D[] = [];
    scene.traverse((obj) => {
      if (obj.userData.isStructure) toRemove.push(obj);
    });
    toRemove.forEach((obj) => {
      if (obj.parent) obj.parent.remove(obj);
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });

    const nodeMap = new Map(diagram.nodes.map((n) => [n.id, n]));
    const forces = equilibrium?.forces || new Map<string, number>();

    // Materials
    const plateMat = new THREE.MeshStandardMaterial({
      color: 0xd4a574,
      roughness: 0.7,
      metalness: 0.1,
    });
    const cableMat = new THREE.MeshStandardMaterial({
      color: 0x3388dd,
      roughness: 0.3,
      metalness: 0.6,
    });
    const nodeMat = new THREE.MeshStandardMaterial({
      color: 0x444444,
      roughness: 0.5,
      metalness: 0.3,
    });
    const supportMat = new THREE.MeshStandardMaterial({
      color: 0x4caf50,
      roughness: 0.6,
    });

    // Coordinate mapping: diagram (x, y, z) → Three.js (x, z_up=y, -y)
    // diagram.x → 3D X, diagram.z → 3D Y (up), diagram.y → 3D -Z
    const toThree = (n: { x: number; y: number; z: number }) =>
      new THREE.Vector3(n.x, n.z, -n.y);

    // Draw edges
    for (const edge of diagram.edges) {
      const src = nodeMap.get(edge.source);
      const tgt = nodeMap.get(edge.target);
      if (!src || !tgt) continue;

      const start = toThree(src);
      const end = toThree(tgt);
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(end, start);
      const edgeLen = dir.length();
      if (edgeLen < 1e-6) continue;

      if (edge.elementType === 'compression') {
        // Plate: box with width and thickness
        const pw = edge.plateWidth * WORLD_SCALE;
        const pt = (edge.plateThickness / 100) * WORLD_SCALE;
        const geo = new THREE.BoxGeometry(edgeLen, pt, pw);
        const mesh = new THREE.Mesh(geo, plateMat.clone());
        mesh.position.copy(mid);

        // Align box X-axis with the edge direction using lookAt + quaternion
        const dirN = dir.clone().normalize();
        const quat = new THREE.Quaternion();
        quat.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dirN);
        mesh.quaternion.copy(quat);

        // Apply plate rotation around the edge axis
        if (edge.plateAngle !== 0) {
          const axisRot = new THREE.Quaternion();
          axisRot.setFromAxisAngle(dirN, (edge.plateAngle * Math.PI) / 180);
          mesh.quaternion.premultiply(axisRot);
        }

        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.isStructure = true;
        mesh.userData.edgeId = edge.id;
        scene.add(mesh);
      } else {
        // Cable: thin cylinder
        const radius = 0.015;
        const geo = new THREE.CylinderGeometry(radius, radius, edgeLen, 6);
        geo.rotateZ(Math.PI / 2); // align along X
        const mesh = new THREE.Mesh(geo, cableMat.clone());
        mesh.position.copy(mid);

        const dirN = dir.clone().normalize();
        const quat = new THREE.Quaternion();
        quat.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dirN);
        mesh.quaternion.copy(quat);

        mesh.castShadow = true;
        mesh.userData.isStructure = true;
        mesh.userData.edgeId = edge.id;
        scene.add(mesh);
      }
    }

    // Draw nodes
    const nodeGeo = new THREE.SphereGeometry(0.06, 12, 8);
    for (const node of diagram.nodes) {
      const mesh = new THREE.Mesh(
        nodeGeo,
        node.support !== 'free' ? supportMat.clone() : nodeMat.clone()
      );
      const pos = toThree(node);
      mesh.position.copy(pos);
      mesh.castShadow = true;
      mesh.userData.isStructure = true;
      mesh.userData.nodeId = node.id;
      scene.add(mesh);

      // Support marker
      if (node.support !== 'free') {
        const markerGeo = new THREE.ConeGeometry(0.08, 0.15, 4);
        const marker = new THREE.Mesh(markerGeo, supportMat.clone());
        marker.position.copy(pos).add(new THREE.Vector3(0, -0.1, 0));
        marker.rotation.x = Math.PI;
        marker.userData.isStructure = true;
        scene.add(marker);
      }

      // External force arrow
      const ef = node.externalForce;
      if (Math.abs(ef.x) > 0.001 || Math.abs(ef.y) > 0.001) {
        const fLen = Math.sqrt(ef.x * ef.x + ef.y * ef.y);
        const arrowDir = new THREE.Vector3(ef.x / fLen, 0, -ef.y / fLen);
        const arrowOrigin = pos.clone().add(arrowDir.clone().multiplyScalar(-fLen * 0.3));
        const arrow = new THREE.ArrowHelper(arrowDir, arrowOrigin, fLen * 0.5, 0x9c27b0, 0.1, 0.06);
        arrow.userData.isStructure = true;
        scene.add(arrow);
      }
    }

    // Auto-fit camera to structure
    if (diagram.nodes.length > 0) {
      const positions = diagram.nodes.map(toThree);
      const xs = positions.map((p) => p.x);
      const ys = positions.map((p) => p.y);
      const zs = positions.map((p) => p.z);
      const center = new THREE.Vector3(
        (Math.min(...xs) + Math.max(...xs)) / 2,
        (Math.min(...ys) + Math.max(...ys)) / 2,
        (Math.min(...zs) + Math.max(...zs)) / 2
      );
      const range = Math.max(
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys),
        Math.max(...zs) - Math.min(...zs),
        2
      );
      orbitRef.current.target.copy(center);
      orbitRef.current.distance = range * 1.8;
    }
  }, [diagram, equilibrium]);

  // Mouse interaction (orbit controls)
  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      orbitRef.current.isDragging = true;
    } else if (e.button === 2 || e.button === 1) {
      orbitRef.current.isPanning = true;
    }
    orbitRef.current.lastX = e.clientX;
    orbitRef.current.lastY = e.clientY;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const orbit = orbitRef.current;
    const dx = e.clientX - orbit.lastX;
    const dy = e.clientY - orbit.lastY;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;

    if (orbit.isDragging) {
      orbit.theta -= dx * 0.005;
      orbit.phi = Math.max(0.1, Math.min(Math.PI - 0.1, orbit.phi - dy * 0.005));
    }
    if (orbit.isPanning) {
      const camera = cameraRef.current;
      if (camera) {
        const right = new THREE.Vector3();
        const up = new THREE.Vector3(0, 1, 0);
        right.crossVectors(camera.getWorldDirection(new THREE.Vector3()), up).normalize();
        orbit.target.addScaledVector(right, -dx * 0.005 * orbit.distance);
        orbit.target.y += dy * 0.005 * orbit.distance;
      }
    }
  };

  const handleMouseUp = () => {
    orbitRef.current.isDragging = false;
    orbitRef.current.isPanning = false;
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    orbitRef.current.distance *= e.deltaY > 0 ? 1.1 : 0.9;
    orbitRef.current.distance = Math.max(1, Math.min(50, orbitRef.current.distance));
  };

  return (
    <div
      ref={containerRef}
      className="canvas-container viewer-3d"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onWheel={handleWheel}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="viewer-3d-label">3D View</div>
    </div>
  );
}

function updateCamera(
  camera: THREE.PerspectiveCamera,
  orbit: { theta: number; phi: number; distance: number; target: THREE.Vector3 }
) {
  camera.position.set(
    orbit.target.x + orbit.distance * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    orbit.target.y + orbit.distance * Math.cos(orbit.phi),
    orbit.target.z + orbit.distance * Math.sin(orbit.phi) * Math.sin(orbit.theta)
  );
  camera.lookAt(orbit.target);
}
