'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import * as THREE from 'three';

const SHANGHAI_OFFSET = 8 * 60 * 60 * 1000;

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  weekday: 'long',
  timeZone: 'Asia/Shanghai',
});

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
  timeZone: 'Asia/Shanghai',
});

function getClockAngles(now: Date) {
  const shanghaiTime = new Date(now.getTime() + SHANGHAI_OFFSET);
  const milliseconds = shanghaiTime.getUTCMilliseconds();
  const seconds = shanghaiTime.getUTCSeconds() + milliseconds / 1000;
  const minutes = shanghaiTime.getUTCMinutes() + seconds / 60;
  const hours = (shanghaiTime.getUTCHours() % 12) + minutes / 60;

  return {
    hour: hours * 30,
    minute: minutes * 6,
    second: seconds * 6,
  };
}

function polarPosition(index: number, total: number, radius: number): CSSProperties {
  const angle = (index / total) * Math.PI * 2;
  return {
    left: `${50 + Math.sin(angle) * radius}%`,
    top: `${50 - Math.cos(angle) * radius}%`,
  };
}

export function LiveEarthClock() {
  const containerRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance',
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.setClearColor(0x000000, 0);

    const textureLoader = new THREE.TextureLoader();
    const dayTexture = textureLoader.load('/assets/images/earth-clock-daymap.jpg');
    const nightTexture = textureLoader.load('/assets/images/earth-clock-night.jpg');
    const normalTexture = textureLoader.load('/assets/images/earth-clock-normal.png');
    const specularTexture = textureLoader.load('/assets/images/earth-clock-specular.png');
    const cloudTexture = textureLoader.load('/assets/images/earth-clock-clouds.jpg');

    dayTexture.colorSpace = THREE.SRGBColorSpace;
    nightTexture.colorSpace = THREE.SRGBColorSpace;
    cloudTexture.colorSpace = THREE.SRGBColorSpace;

    const earthSystem = new THREE.Group();
    earthSystem.rotation.z = THREE.MathUtils.degToRad(-23.4);
    earthSystem.position.y = 0;
    scene.add(earthSystem);

    const earthGeometry = new THREE.SphereGeometry(1, 72, 72);
    const earthMaterial = new THREE.MeshPhongMaterial({
      map: dayTexture,
      normalMap: normalTexture,
      normalScale: new THREE.Vector2(0.65, 0.65),
      specularMap: specularTexture,
      specular: new THREE.Color(0x315b86),
      shininess: 13,
    });
    const earth = new THREE.Mesh(earthGeometry, earthMaterial);
    earth.rotation.y = -1.35;
    earthSystem.add(earth);

    const nightMaterial = new THREE.MeshBasicMaterial({
      map: nightTexture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.74,
      transparent: true,
    });
    const night = new THREE.Mesh(earthGeometry, nightMaterial);
    night.rotation.copy(earth.rotation);
    night.scale.setScalar(1.002);
    earthSystem.add(night);

    const cloudGeometry = new THREE.SphereGeometry(1.022, 72, 72);
    const cloudMaterial = new THREE.MeshPhongMaterial({
      alphaMap: cloudTexture,
      map: cloudTexture,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      opacity: 0.3,
      transparent: true,
    });
    const clouds = new THREE.Mesh(cloudGeometry, cloudMaterial);
    clouds.rotation.y = -1.15;
    earthSystem.add(clouds);

    const atmosphereGeometry = new THREE.SphereGeometry(1.075, 72, 72);
    const atmosphereMaterial = new THREE.ShaderMaterial({
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.BackSide,
      transparent: true,
      vertexShader: `
        varying vec3 vertexNormal;
        void main() {
          vertexNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vertexNormal;
        void main() {
          float intensity = pow(0.72 - dot(vertexNormal, vec3(0.0, 0.0, 1.0)), 2.2);
          gl_FragColor = vec4(0.22, 0.54, 1.0, 1.0) * intensity;
        }
      `,
    });
    const atmosphere = new THREE.Mesh(atmosphereGeometry, atmosphereMaterial);
    earthSystem.add(atmosphere);

    const starCount = 900;
    const starPositions = new Float32Array(starCount * 3);
    for (let index = 0; index < starCount; index += 1) {
      const radius = 7 + ((index * 37) % 100) / 16;
      const theta = index * 2.399963;
      const phi = Math.acos(1 - (2 * (index + 0.5)) / starCount);
      starPositions[index * 3] = radius * Math.sin(phi) * Math.cos(theta);
      starPositions[index * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
      starPositions[index * 3 + 2] = radius * Math.cos(phi);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    const starMaterial = new THREE.PointsMaterial({
      color: 0xc7dcff,
      opacity: 0.72,
      size: 0.018,
      sizeAttenuation: true,
      transparent: true,
    });
    const stars = new THREE.Points(starGeometry, starMaterial);
    scene.add(stars);

    scene.add(new THREE.HemisphereLight(0x9dc5ff, 0x061027, 0.72));
    const sunLight = new THREE.DirectionalLight(0xfff0d8, 3.4);
    sunLight.position.set(-3.8, 1.7, 3.6);
    scene.add(sunLight);
    const rimLight = new THREE.PointLight(0x4f7dff, 18, 12, 2);
    rimLight.position.set(3.2, -1.2, -1.5);
    scene.add(rimLight);

    const clock = new THREE.Clock();
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frameId = 0;
    let isVisible = true;

    const renderFrame = () => {
      frameId = window.requestAnimationFrame(renderFrame);
      const angles = getClockAngles(new Date());
      container.style.setProperty('--hour-angle', `${angles.hour}deg`);
      container.style.setProperty('--minute-angle', `${angles.minute}deg`);
      container.style.setProperty('--second-angle', `${angles.second}deg`);

      const delta = Math.min(clock.getDelta(), 0.05);
      if (isVisible && !document.hidden && !mediaQuery.matches) {
        earth.rotation.y += delta * 0.16;
        night.rotation.y += delta * 0.16;
        clouds.rotation.y += delta * 0.205;
        stars.rotation.y += delta * 0.004;
      }
      if (isVisible && !document.hidden) renderer.render(scene, camera);
    };

    const resize = () => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      isVisible = entry?.isIntersecting ?? true;
    });
    intersectionObserver.observe(container);
    resize();
    renderFrame();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      earthGeometry.dispose();
      cloudGeometry.dispose();
      atmosphereGeometry.dispose();
      starGeometry.dispose();
      earthMaterial.dispose();
      nightMaterial.dispose();
      cloudMaterial.dispose();
      atmosphereMaterial.dispose();
      starMaterial.dispose();
      dayTexture.dispose();
      nightTexture.dispose();
      normalTexture.dispose();
      specularTexture.dispose();
      cloudTexture.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <section ref={containerRef} className="earth-clock-react" aria-label="3D 旋转地球时钟">
      <canvas ref={canvasRef} className="earth-webgl-canvas" aria-hidden="true" />

      <div className="earth-clock-eyebrow" aria-hidden="true">
        <span /> LIVE EARTH · CST
      </div>

      <div className="analog-clock-face" aria-hidden="true">
        <div className="clock-orbit-ring clock-orbit-ring-outer" />
        <div className="clock-orbit-ring clock-orbit-ring-inner" />
        <div className="clock-marks">
          {Array.from({ length: 60 }, (_, index) => (
            <i
              className={index % 5 === 0 ? 'clock-mark clock-mark-hour' : 'clock-mark'}
              key={index}
              style={{
                ...polarPosition(index, 60, 47),
                transform: `translate(-50%, -50%) rotate(${index * 6}deg)`,
              }}
            />
          ))}
        </div>
        <div className="clock-numerals">
          {Array.from({ length: 12 }, (_, index) => {
            const numeral = index + 1;
            return (
              <span key={numeral} style={polarPosition(numeral, 12, 39.5)}>
                {numeral}
              </span>
            );
          })}
        </div>
        <i className="clock-hand-react clock-hand-hour" />
        <i className="clock-hand-react clock-hand-minute" />
        <i className="clock-hand-react clock-hand-second" />
        <i className="clock-center-dot" />
      </div>

    </section>
  );
}

export function ShanghaiTimeReadout() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const update = () => setNow(new Date());
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="home-time-readout" aria-live="polite">
      <time className="home-digital-time">
        {now ? timeFormatter.format(now) : '--:--:--'}
      </time>
      <time className="home-calendar-date">
        {now ? dateFormatter.format(now) : '正在同步时间'}
      </time>
    </div>
  );
}
