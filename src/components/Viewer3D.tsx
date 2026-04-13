import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { useAppState } from '../state/context';

export function Viewer3D() {
  const { state, dispatch } = useAppState();
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const frameRef = useRef<number>(0);
  // Remember which node count we last auto-fitted for, so live search
  // ticks that add a couple of nodes at a time don't keep re-framing
  // the camera and fighting with the user's manual orbit.
  const lastFitCountRef = useRef(0);
  const [size, setSize] = useState({ w: 600, h: 500 });

  const orbitRef = useRef({
    theta: Math.PI / 4, phi: Math.PI / 3, distance: 8,
    target: new THREE.Vector3(0, 1, 0),
    isDragging: false, isPanning: false, lastX: 0, lastY: 0,
  });

  // Initialize Three.js
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0xf5f5f0);
    renderer.shadowMap.enabled = true;
    container.appendChild(renderer.domElement);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    cameraRef.current = camera;

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(5, 10, 7); dir.castShadow = true;
    scene.add(dir);
    scene.add(new THREE.DirectionalLight(0xffffff, 0.3).translateX(-3).translateY(5).translateZ(-5));

    // Ground
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.MeshStandardMaterial({ color: 0xe8e8e5, roughness: 0.9 })
    );
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.name = '__ground';
    scene.add(ground);
    const grid = new THREE.GridHelper(30, 60, 0xcccccc, 0xdddddd);
    grid.name = '__grid'; scene.add(grid);

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        setSize({ w: e.contentRect.width, h: e.contentRect.height });
        renderer.setSize(e.contentRect.width, e.contentRect.height);
        camera.aspect = e.contentRect.width / e.contentRect.height;
        camera.updateProjectionMatrix();
      }
    });
    ro.observe(container);

    const animate = () => {
      frameRef.current = requestAnimationFrame(animate);
      updateCamera(camera, orbitRef.current);
      renderer.render(scene, camera);
    };
    animate();

    return () => { cancelAnimationFrame(frameRef.current); ro.disconnect(); renderer.dispose(); container.removeChild(renderer.domElement); };
  }, []);

  // Rebuild scene from morpho state
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;

    // Remove old structure objects
    const toRemove: THREE.Object3D[] = [];
    scene.traverse(obj => { if (obj.userData.isStructure) toRemove.push(obj); });
    toRemove.forEach(obj => {
      obj.parent?.remove(obj);
      if (obj instanceof THREE.Mesh) { obj.geometry.dispose(); if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose()); else obj.material.dispose(); }
    });

    const morpho = state.morpho;
    const nodeMap = new Map(morpho.nodes.map(n => [n.node_id, n]));
    const selectedNodes = new Set(state.selectedNodeIds);
    const selectedEdges = new Set(state.selectedMemberIds);

    // Materials
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x607d8b, roughness: 0.4, metalness: 0.3 });
    const cableMat = new THREE.MeshStandardMaterial({ color: 0xff5722, roughness: 0.3, metalness: 0.1 });
    const selectedMat = new THREE.MeshStandardMaterial({ color: 0xffeb3b, roughness: 0.3, emissive: 0x333300 });

    // Members
    for (const member of morpho.members) {
      const a = nodeMap.get(member.node_a), b = nodeMap.get(member.node_b);
      if (!a || !b) continue;

      const start = new THREE.Vector3(a.x, a.z, -a.y); // y→z, z→y
      const end = new THREE.Vector3(b.x, b.z, -b.y);
      const mid = new THREE.Vector3().addVectors(start, end).multiplyScalar(0.5);
      const dir = new THREE.Vector3().subVectors(end, start);
      const len = dir.length();
      if (len < 1e-6) continue;

      const isSelected = selectedEdges.has(member.member_id);
      const mat = isSelected ? selectedMat.clone() : (member.type === 'strut' ? strutMat.clone() : cableMat.clone());

      if (member.type === 'strut') {
        // Thick cylinder for struts
        const geo = new THREE.CylinderGeometry(0.04, 0.04, len, 8);
        geo.rotateZ(Math.PI / 2);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(mid);
        const q = new THREE.Quaternion();
        q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
        mesh.quaternion.copy(q);
        mesh.castShadow = true;
        mesh.userData = { isStructure: true, memberId: member.member_id };
        scene.add(mesh);
      } else {
        // Thin line for cables
        const geo = new THREE.CylinderGeometry(0.012, 0.012, len, 4);
        geo.rotateZ(Math.PI / 2);
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.copy(mid);
        const q = new THREE.Quaternion();
        q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir.clone().normalize());
        mesh.quaternion.copy(q);
        mesh.userData = { isStructure: true, memberId: member.member_id };
        scene.add(mesh);
      }
    }

    // Nodes
    const nodeGeo = new THREE.SphereGeometry(0.06, 12, 8);
    for (const node of morpho.nodes) {
      const isSelected = selectedNodes.has(node.node_id);
      const mesh = new THREE.Mesh(nodeGeo,
        isSelected ? selectedMat.clone() : new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5 })
      );
      mesh.position.set(node.x, node.z, -node.y);
      mesh.castShadow = true;
      mesh.userData = { isStructure: true, nodeId: node.node_id };
      scene.add(mesh);
    }

    // Auto-fit camera — but only when the node count *grows* past
    // the last point we fitted for (or shrinks back to zero). Every
    // live search tick reruns this effect; re-framing on every tick
    // would make the viewer jump around while the user is trying to
    // inspect the search. We still re-fit after Phase 2 adhesions
    // add new nodes, and on the final done-tick.
    const nodeCount = morpho.nodes.length;
    const running = state.search.status === 'running';
    const shouldFit =
      nodeCount === 0 ||
      !running ||
      nodeCount > lastFitCountRef.current;
    if (shouldFit && nodeCount > 0) {
      const positions = morpho.nodes.map(n => new THREE.Vector3(n.x, n.z, -n.y));
      const box = new THREE.Box3().setFromPoints(positions);
      const center = box.getCenter(new THREE.Vector3());
      const sz = box.getSize(new THREE.Vector3());
      orbitRef.current.target.copy(center);
      orbitRef.current.distance = Math.max(sz.x, sz.y, sz.z, 3) * 2;
      lastFitCountRef.current = nodeCount;
    } else if (nodeCount === 0) {
      lastFitCountRef.current = 0;
    }
  }, [state.morpho, state.selectedNodeIds, state.selectedMemberIds, state.search.status]);

  // Mouse interaction
  const dragStartRef = useRef<[number, number]>([0, 0]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) orbitRef.current.isDragging = true;
    else if (e.button === 2 || e.button === 1) orbitRef.current.isPanning = true;
    orbitRef.current.lastX = e.clientX; orbitRef.current.lastY = e.clientY;
    dragStartRef.current = [e.clientX, e.clientY];
  };
  const handleMouseMove = (e: React.MouseEvent) => {
    const o = orbitRef.current;
    const dx = e.clientX - o.lastX, dy = e.clientY - o.lastY;
    o.lastX = e.clientX; o.lastY = e.clientY;
    if (o.isDragging) { o.theta -= dx * 0.005; o.phi = Math.max(0.1, Math.min(Math.PI - 0.1, o.phi - dy * 0.005)); }
    if (o.isPanning) {
      const camera = cameraRef.current;
      if (camera) {
        const right = new THREE.Vector3();
        right.crossVectors(camera.getWorldDirection(new THREE.Vector3()), new THREE.Vector3(0, 1, 0)).normalize();
        o.target.addScaledVector(right, -dx * 0.005 * o.distance);
        o.target.y += dy * 0.005 * o.distance;
      }
    }
  };
  const handleMouseUp = (e: React.MouseEvent) => {
    const wasDrag = Math.abs(e.clientX - dragStartRef.current[0]) + Math.abs(e.clientY - dragStartRef.current[1]) > 5;
    orbitRef.current.isDragging = false;
    orbitRef.current.isPanning = false;

    // Click (not drag) → raycast to select edge
    if (!wasDrag && e.button === 0 && sceneRef.current && cameraRef.current && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const mouse = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1
      );
      const raycaster = new THREE.Raycaster();
      raycaster.params.Line = { threshold: 0.1 };
      raycaster.setFromCamera(mouse, cameraRef.current);

      const hits = raycaster.intersectObjects(sceneRef.current.children, false);
      const memberHit = hits.find(h => h.object.userData.memberId !== undefined);
      if (memberHit) {
        const mid = memberHit.object.userData.memberId as number;
        const prev = state.selectedMemberIds;
        if (e.shiftKey) {
          // Shift+click: toggle in multi-selection (up to 2)
          const has = prev.includes(mid);
          const next = has ? prev.filter(id => id !== mid) : [...prev, mid].slice(-2);
          dispatch({ type: 'SELECT_MEMBERS', ids: next });
        } else {
          dispatch({ type: 'SELECT_MEMBERS', ids: [mid] });
        }
      } else {
        dispatch({ type: 'SELECT_MEMBERS', ids: [] });
      }
    }
  };
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    orbitRef.current.distance *= e.deltaY > 0 ? 1.1 : 0.9;
    orbitRef.current.distance = Math.max(1, Math.min(50, orbitRef.current.distance));
  };

  const search = state.search;
  const running = search.status === 'running';
  const showSearchOverlay = running || search.status === 'timeout';
  const elapsedSec = (search.elapsedMs / 1000).toFixed(2);
  const budgetSec = (search.timeoutMs / 1000).toFixed(1);

  return (
    <div ref={containerRef} className="canvas-container viewer-3d"
      onMouseDown={handleMouseDown} onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}
      onWheel={handleWheel} onContextMenu={e => e.preventDefault()}>
      <div className="viewer-3d-label">3D View</div>

      {showSearchOverlay && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(255, 255, 255, 0.88)',
            border: '1px solid #ccc',
            borderRadius: 4,
            padding: '6px 12px',
            fontFamily: 'monospace',
            fontSize: 11,
            color: search.status === 'timeout' ? '#b71c1c' : '#1565c0',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)',
          }}
        >
          {running
            ? `▶ ${search.phase} · tick ${search.tick} · ${elapsedSec}s / ${budgetSec}s`
            : `⏱ timed out after ${elapsedSec}s`}
        </div>
      )}
    </div>
  );
}

function updateCamera(c: THREE.PerspectiveCamera, o: { theta: number; phi: number; distance: number; target: THREE.Vector3 }) {
  c.position.set(
    o.target.x + o.distance * Math.sin(o.phi) * Math.cos(o.theta),
    o.target.y + o.distance * Math.cos(o.phi),
    o.target.z + o.distance * Math.sin(o.phi) * Math.sin(o.theta)
  );
  c.lookAt(o.target);
}
