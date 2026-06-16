import { useEffect, useRef } from "react";
import * as THREE from "three";
import "./ParticleTitle.css";

type ParticleTitleProps = {
  text: string;
  className?: string;
};

const vertexShader = `
  attribute float size;
  attribute vec3 customColor;
  varying vec3 vColor;

  void main() {
    vColor = customColor;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * (300.0 / -mvPosition.z);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = `
  uniform vec3 color;
  uniform sampler2D pointTexture;
  varying vec3 vColor;

  void main() {
    gl_FragColor = vec4(color * vColor, 1.0);
    gl_FragColor = gl_FragColor * texture2D(pointTexture, gl_PointCoord);
  }
`;

function createPointTexture() {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(204,224,255,0.95)");
  gradient.addColorStop(0.45, "rgba(147,177,255,0.65)");
  gradient.addColorStop(1, "rgba(147,177,255,0)");

  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function sampleTextPoints(text: string, width: number, height: number) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return [];
  }

  canvas.width = Math.max(900, Math.floor(width * 2));
  canvas.height = Math.max(260, Math.floor(height * 2));

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#ffffff";
  context.textAlign = "center";
  context.textBaseline = "middle";

  const fontSize = Math.floor(Math.min(canvas.width / (text.length * 0.58), canvas.height * 0.62));
  context.font = `900 ${fontSize}px Manrope, Arial, sans-serif`;
  context.fillText(text, canvas.width / 2, canvas.height / 2);

  const imageData = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const gap = Math.max(4, Math.floor(canvas.width / 280));
  const points: { x: number; y: number; tint: number }[] = [];

  for (let y = 0; y < canvas.height; y += gap) {
    for (let x = 0; x < canvas.width; x += gap) {
      const alpha = imageData[(y * canvas.width + x) * 4 + 3];
      if (alpha > 120) {
        points.push({
          x: x - canvas.width / 2,
          y: canvas.height / 2 - y,
          tint: x / canvas.width,
        });
      }
    }
  }

  const scale = Math.min(width / canvas.width, height / canvas.height) * 0.92;
  return points.map((point) => ({
    x: point.x * scale,
    y: point.y * scale,
    tint: point.tint,
  }));
}

export default function ParticleTitle({ text, className = "" }: ParticleTitleProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, 1, 1, 2000);
    camera.position.set(0, 0, 340);

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    const texture = createPointTexture();
    const pointer = { x: 9999, y: 9999 };
    let frameId = 0;
    let pointsMesh: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial> | null = null;
    let basePositions: Float32Array | null = null;
    let positionAttribute: THREE.BufferAttribute | null = null;
    let colorAttribute: THREE.BufferAttribute | null = null;
    let sizeAttribute: THREE.BufferAttribute | null = null;

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width - 0.5) * rect.width;
      pointer.y = (0.5 - (event.clientY - rect.top) / rect.height) * rect.height;
    };

    const onPointerLeave = () => {
      pointer.x = 9999;
      pointer.y = 9999;
    };

    const buildParticles = () => {
      const width = Math.max(container.clientWidth, 320);
      const height = Math.max(container.clientHeight, 160);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();

      if (pointsMesh) {
        scene.remove(pointsMesh);
        pointsMesh.geometry.dispose();
        pointsMesh.material.dispose();
        pointsMesh = null;
      }

      const points = sampleTextPoints(text, width, height);
      const positions = new Float32Array(points.length * 3);
      const colors = new Float32Array(points.length * 3);
      const sizes = new Float32Array(points.length);

      for (let index = 0; index < points.length; index += 1) {
        const point = points[index];
        const offset = index * 3;
        positions[offset] = point.x;
        positions[offset + 1] = point.y;
        positions[offset + 2] = (Math.random() - 0.5) * 10;

        const cool = new THREE.Color().setRGB(0.78, 0.87, 1.0);
        const warm = new THREE.Color().setRGB(1.0, 0.9, 0.78);
        const tint = cool.clone().lerp(warm, Math.min(1, Math.max(0, point.tint * 1.1)));
        colors[offset] = tint.r;
        colors[offset + 1] = tint.g;
        colors[offset + 2] = tint.b;
        sizes[index] = 2.6 + Math.random() * 1.6;
      }

      basePositions = positions.slice();
      positionAttribute = new THREE.BufferAttribute(positions, 3);
      colorAttribute = new THREE.BufferAttribute(colors, 3);
      sizeAttribute = new THREE.BufferAttribute(sizes, 1);

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", positionAttribute);
      geometry.setAttribute("customColor", colorAttribute);
      geometry.setAttribute("size", sizeAttribute);

      const material = new THREE.ShaderMaterial({
        uniforms: {
          color: { value: new THREE.Color(0xffffff) },
          pointTexture: { value: texture },
        },
        vertexShader,
        fragmentShader,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        transparent: true,
      });

      pointsMesh = new THREE.Points(geometry, material);
      scene.add(pointsMesh);
    };

    const animate = () => {
      frameId = window.requestAnimationFrame(animate);
      if (!basePositions || !positionAttribute || !sizeAttribute) {
        renderer.render(scene, camera);
        return;
      }

      const now = performance.now() * 0.001;
      const positions = positionAttribute.array as Float32Array;
      const sizes = sizeAttribute.array as Float32Array;

      for (let index = 0; index < sizes.length; index += 1) {
        const offset = index * 3;
        const originX = basePositions[offset];
        const originY = basePositions[offset + 1];
        const originZ = basePositions[offset + 2];

        const dx = originX - pointer.x;
        const dy = originY - pointer.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;
        const influence = Math.max(0, 1 - distance / 120);
        const repelStrength = influence * influence * 22;

        const waveX = Math.sin(now * 1.8 + originY * 0.02) * 0.55;
        const waveY = Math.cos(now * 1.5 + originX * 0.02) * 0.45;
        const targetX = originX + waveX + (dx / distance) * repelStrength;
        const targetY = originY + waveY + (dy / distance) * repelStrength;
        const targetZ = originZ + influence * 18;

        positions[offset] += (targetX - positions[offset]) * 0.08;
        positions[offset + 1] += (targetY - positions[offset + 1]) * 0.08;
        positions[offset + 2] += (targetZ - positions[offset + 2]) * 0.08;
        sizes[index] += (2.8 + influence * 1.8 - sizes[index]) * 0.16;
      }

      positionAttribute.needsUpdate = true;
      sizeAttribute.needsUpdate = true;
      renderer.render(scene, camera);
    };

    const resizeObserver = new ResizeObserver(buildParticles);
    resizeObserver.observe(container);
    container.addEventListener("pointermove", onPointerMove);
    container.addEventListener("pointerleave", onPointerLeave);

    buildParticles();
    animate();

    return () => {
      resizeObserver.disconnect();
      container.removeEventListener("pointermove", onPointerMove);
      container.removeEventListener("pointerleave", onPointerLeave);
      window.cancelAnimationFrame(frameId);
      texture.dispose();
      if (pointsMesh) {
        pointsMesh.geometry.dispose();
        pointsMesh.material.dispose();
      }
      renderer.dispose();
      if (container.contains(renderer.domElement)) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [text]);

  return (
    <div className={`particle-title ${className}`.trim()} ref={containerRef}>
      <span className="sr-only">{text}</span>
    </div>
  );
}
