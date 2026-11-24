import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Maquete 3D da operacao (portada do prototipo "Centro de Comando", versao realista).
 * Centro: IA central (orquestrador). Em volta: uma ilha por numero/pessoa e a ilha do Sentinela.
 * A cena e imperativa (Three.js); a interface em volta (busca, doca, painel) e React.
 */

export type Status = 'ok' | 'warn' | 'crit';
export type SceneArea = { id: string; kind: 'hub' | 'desks' | 'racks' | 'totems'; name: string; who: string; state?: string; color?: string };
export type SceneItem = { id: string; area: string; name: string; sub: string; status: Status; extra: Record<string, string>; link?: string };

type Callbacks = {
  onArea: (id: string) => void;
  onItem: (item: SceneItem) => void;
};

export const STATUS_COL: Record<Status, string> = { ok: '#3FAE7C', warn: '#F0A93B', crit: '#E5484D' };
const PALETTE = ['#E9A23B', '#3FAE7C', '#9B7BEA', '#E77D5F', '#D96C9A', '#5FB0B7', '#8FA85A'];
export const areaColor = (a: SceneArea, i: number) => a.color ?? (a.id === 'central' ? '#6C83FF' : a.id === 'sentinela' ? '#4BA3D9' : PALETTE[i % PALETTE.length]);

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => { const t = document.documentElement.dataset.theme; return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

type Item = SceneItem & { group?: THREE.Group; mats: THREE.Material[]; dim?: boolean; anim?: any };
type Area = SceneArea & {
  x: number; z: number; color: string; g: THREE.Group; baseMat: THREE.MeshStandardMaterial; carpetMat: THREE.MeshStandardMaterial;
  w: number; d: number; top: number; items: Item[]; label?: HTMLButtonElement; faded?: boolean;
};
type Portal = { id: string; name: string; color: string; x: number; z: number; g?: THREE.Group; inner?: THREE.Mesh; labelPos?: THREE.Vector3 };

// ------------------------------------------------------------------ texturas desenhadas
function radialTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.4, 'rgba(255,255,255,.5)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}
function rrect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function tex(c: HTMLCanvasElement) { const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t; }
function screenTex(accent: string) {
  const c = document.createElement('canvas'); c.width = 256; c.height = 160; const g = c.getContext('2d')!;
  g.fillStyle = '#0F1218'; g.fillRect(0, 0, 256, 160);
  g.fillStyle = '#1B2029'; g.fillRect(0, 0, 72, 160);
  for (let i = 0; i < 6; i++) { g.fillStyle = i === 1 ? accent : '#2A303B'; g.globalAlpha = i === 1 ? 0.6 : 1; rrect(g, 8, 12 + i * 22, 56, 14, 4); g.fill(); }
  g.globalAlpha = 1;
  ([[84, 14, 104, 0], [126, 40, 118, 1], [84, 66, 86, 0], [150, 92, 94, 1], [84, 118, 126, 0]] as const).forEach(([x, y, w, me]) => {
    g.fillStyle = me ? accent : '#2A303B'; g.globalAlpha = me ? 0.8 : 1; rrect(g, x, y, w, 18, 7); g.fill();
  });
  g.globalAlpha = 1; return tex(c);
}
function kioskTex(accent: string) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 240; const g = c.getContext('2d')!;
  g.fillStyle = '#F7F7F8'; g.fillRect(0, 0, 128, 240);
  g.fillStyle = accent; g.fillRect(0, 0, 128, 26);
  for (let r = 0; r < 3; r++) for (let k = 0; k < 2; k++) {
    g.fillStyle = '#E4E6EA'; rrect(g, 8 + k * 60, 36 + r * 58, 52, 50, 6); g.fill();
    g.fillStyle = r === 0 && k === 0 ? accent : '#C9CDD4'; g.globalAlpha = 0.55; rrect(g, 16 + k * 60, 42 + r * 58, 36, 24, 5); g.fill(); g.globalAlpha = 1;
  }
  g.fillStyle = accent; rrect(g, 10, 212, 108, 20, 8); g.fill(); return tex(c);
}
function rackTex() {
  const c = document.createElement('canvas'); c.width = 64; c.height = 160; const g = c.getContext('2d')!;
  g.fillStyle = '#2A2E35'; g.fillRect(0, 0, 64, 160); g.fillStyle = '#16181D';
  for (let y = 6; y < 156; y += 6) for (let x = 6; x < 60; x += 6) { g.beginPath(); g.arc(x, y, 1.4, 0, 6.3); g.fill(); }
  return tex(c);
}

// ------------------------------------------------------------------ geometria e materiais
function rr(w: number, d: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
}
function slabGeo(w: number, d: number, r: number, depth: number, bevel: number) {
  const g = new THREE.ExtrudeGeometry(rr(w, d, r), { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 10 });
  g.rotateX(-Math.PI / 2); g.translate(0, bevel, 0); return g;
}
const M = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.7, metalness: 0, ...o });
const MAT = {
  wood: () => M({ color: '#CDB08A', roughness: 0.55 }),
  metal: () => M({ color: '#B9BEC6', metalness: 1, roughness: 0.32 }),
  dark: () => M({ color: '#22252B', roughness: 0.5 }),
  fabric: () => M({ color: '#3A3F48', roughness: 0.95 }),
  skin: () => M({ color: '#ECE7E1', roughness: 0.6 }),
  white: () => M({ color: '#F1F2F4', roughness: 0.35 }),
};
function shadows(group: THREE.Object3D) {
  group.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.noShadow) { o.castShadow = true; o.receiveShadow = true; } });
}
function disposeTree(root: THREE.Object3D) {
  root.traverse((o: any) => {
    o.geometry?.dispose?.();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m?.dispose?.());
  });
}

// three >= r155 usa luzes fisicamente corretas: o prototipo (r147, modo legado) precisa de x PI para o mesmo brilho
const LEGACY = Math.PI;

export class OperationScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
  private controls: OrbitControls;
  private sun = new THREE.DirectionalLight(0xffffff, 1.6 * LEGACY);
  private fill = new THREE.AmbientLight(0xffffff, 0.15 * LEGACY);
  private envTex: THREE.Texture | null = null;
  private RT = radialTex();
  private RACK_TEX = rackTex();
  private areaTex: THREE.Texture[] = [];
  private floorMat = new THREE.MeshStandardMaterial({ color: '#E3E6EA', roughness: 1 });
  private grid?: THREE.GridHelper;
  private areas: Area[] = [];
  private items: Item[] = [];
  private pickables: THREE.Object3D[] = [];
  private pulses: Array<{ kind: 'ring' | 'halo'; m: THREE.Mesh; mat: THREE.MeshBasicMaterial; it: Item }> = [];
  private heads: Array<{ m: THREE.Mesh; base: number; ph: number }> = [];
  private spinners: THREE.Object3D[] = [];
  private portals: Portal[] = [
    { id: 'wa', name: 'WhatsApp', color: '#3FAE7C', x: -22, z: -2 },
    { id: 'gm', name: 'Gmail', color: '#E5484D', x: 22, z: -2 },
  ];
  private paths = new Map<string, THREE.Vector3[]>();
  private pGeo = new THREE.BufferGeometry();
  private pPos: Float32Array; private pCol: Float32Array;
  private pMat: THREE.PointsMaterial;
  private parts: Array<{ path: THREE.Vector3[]; t: number; speed: number; col: THREE.Color }> = [];
  private flowOn = true; private labelsOn = true;
  private ambientEvery = 0.9; private ambientAcc = 0;
  private hub?: Item;
  private labels: Array<{ el: HTMLElement; pos: THREE.Vector3 }> = [];
  private ray = new THREE.Raycaster(); private mouse = new THREE.Vector2();
  private tween: null | { t: number; ft: THREE.Vector3; fc: THREE.Vector3; tt: THREE.Vector3; tc: THREE.Vector3 } = null;
  private HOME = { target: new THREE.Vector3(0, 0, 3), cam: new THREE.Vector3(32, 33, 40) };
  private K = 1; // escala do anel (1 = tamanho do prototipo)
  private running = true; private raf = 0; private last = performance.now(); private time = 0;
  private W = 0; private H = 0; private pr: number; private frames = 0; private acc = 0; private lowSteps = 0;
  private hoverIt: Item | null = null; private down = { x: 0, y: 0 }; private pendingMove: PointerEvent | null = null;
  private filter = { status: 'all' as 'all' | Status, q: '', area: null as string | null };
  private ro: ResizeObserver;
  private cleanup: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private labelsEl: HTMLElement, private tip: HTMLElement, private cb: Callbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    if (!this.renderer.getContext()) throw new Error('sem WebGL');
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.pr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(this.pr);

    // reflexos suaves de estudio
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.envTex = pmrem.fromScene(room, 0.04).texture;
    room.dispose(); pmrem.dispose();
    this.scene.environment = this.envTex;
    this.scene.environmentIntensity = 1;

    this.camera.position.copy(this.HOME.cam);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.HOME.target);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.2; this.controls.minDistance = 6; this.controls.maxDistance = 95;
    this.controls.autoRotateSpeed = 0.3; this.controls.autoRotate = false;
    this.controls.addEventListener('start', () => { this.tween = null; });

    this.sun.position.set(14, 30, 18); this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004; this.sun.shadow.normalBias = 0.02;
    this.fitShadow(30);
    this.scene.add(this.sun, this.fill);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.floorMat);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.scene.add(floor);

    const MAXP = 320;
    this.pPos = new Float32Array(MAXP * 3); this.pCol = new Float32Array(MAXP * 3);
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.pMat = new THREE.PointsMaterial({ size: 0.42, map: this.RT, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const points = new THREE.Points(this.pGeo, this.pMat); points.frustumCulled = false; this.scene.add(points);
    this.buildPortals();

    const onMove = (ev: PointerEvent) => { this.pendingMove = ev; };
    const onLeave = () => { this.setHover(null); this.tip.classList.remove('show'); };
    const onDown = (ev: PointerEvent) => { this.down = { x: ev.clientX, y: ev.clientY }; };
    const onUp = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - this.down.x, ev.clientY - this.down.y) > 5) return;
      const h = this.pick(ev); if (!h) return;
      if ('item' in h) { this.cb.onItem(h.item); } else this.cb.onArea(h.area);
    };
    canvas.addEventListener('pointermove', onMove); canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
    this.cleanup.push(() => { canvas.removeEventListener('pointermove', onMove); canvas.removeEventListener('pointerleave', onLeave); canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); });
    const onVis = () => { this.running = !document.hidden; if (this.running) { this.last = performance.now(); this.raf = requestAnimationFrame(this.loop); } };
    document.addEventListener('visibilitychange', onVis); this.cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
    const mq = matchMedia('(prefers-color-scheme: dark)'); const onScheme = () => this.applyTheme();
    mq.addEventListener('change', onScheme); this.cleanup.push(() => mq.removeEventListener('change', onScheme));
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement!);
    this.resize(); this.applyTheme();
    this.raf = requestAnimationFrame(this.loop);
  }

  private fitShadow(ext: number) {
    const c = this.sun.shadow.camera;
    Object.assign(c, { left: -ext, right: ext, top: ext, bottom: -ext, near: 1, far: 90 * this.K });
    c.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ dados
  setData(areasIn: SceneArea[], itemsIn: SceneItem[]) {
    // remove o que existia (ilhas e itens), libera a memoria da GPU e monta de novo
    for (const a of this.areas) { this.scene.remove(a.g); disposeTree(a.g); a.label?.remove(); }
    this.areaTex.forEach((t) => t.dispose()); this.areaTex = [];
    this.labels = this.labels.filter((l) => !l.el.classList.contains('area'));
    this.areas = []; this.items = []; this.pickables = []; this.pulses = []; this.heads = []; this.spinners = [];
    this.hub = undefined; this.hoverIt = null;

    // tamanho de cada ilha a partir da quantidade de itens
    const byArea = new Map<string, SceneItem[]>();
    for (const it of itemsIn) { const l = byArea.get(it.area) ?? []; l.push(it); byArea.set(it.area, l); }
    const sizeOf = (a: SceneArea) => this.areaSize(a.kind, byArea.get(a.id)?.length ?? 0);
    const ring = areasIn.filter((a) => a.kind !== 'hub');
    const sizes = ring.map(sizeOf);
    const maxW = Math.max(8.6, ...sizes.map((s) => s.w)), maxD = Math.max(6.6, ...sizes.map((s) => s.d));
    const R = Math.max(13, 3.3 * ring.length, (ring.length * (maxW + 1.2)) / (Math.PI * 2), (6.1 + maxD / 2 + 2) / 0.78);
    ring.forEach((a, i) => { (a as any)._i = i; });
    areasIn.forEach((a, idx) => {
      let x = 0, z = 0;
      if (a.kind !== 'hub') {
        const i = (a as any)._i as number;
        const ang = -Math.PI / 2 + (i / ring.length) * Math.PI * 2;
        x = Math.cos(ang) * R; z = Math.sin(ang) * R * 0.78 + 2;
      }
      this.buildArea({ ...a, x, z, color: areaColor(a, idx), ...sizeOf(a) } as Area);
    });
    for (const it of itemsIn) {
      const A = this.areas.find((a) => a.id === it.area); if (!A) continue;
      A.items.push({ ...it, mats: [] });
    }
    for (const A of this.areas) this.layoutItems(A);
    this.items = this.areas.flatMap((a) => a.items);

    // camera, sombra, neblina e portais acompanham o tamanho do anel
    this.K = Math.max(1, (R + 5) / 17);
    this.HOME.cam.set(32, 33, 40).multiplyScalar(this.K);
    this.controls.maxDistance = Math.max(95, this.HOME.cam.length() * 1.6);
    this.camera.far = 400 * this.K; this.camera.updateProjectionMatrix();
    this.sun.position.set(14, 30, 18).multiplyScalar(this.K);
    this.fitShadow(R + 10);
    const px = R + 9;
    this.portals.forEach((p, pi) => {
      p.x = pi === 0 ? -px : px;
      p.g?.position.set(p.x, 0, p.z); p.labelPos?.set(p.x, 4.6, p.z);
    });

    this.buildPaths();
    this.applyTheme();
    this.applyFilter();
  }

  private areaSize(kind: SceneArea['kind'], n: number) {
    if (kind === 'hub') return { w: 9, d: 9 };
    if (kind === 'racks') {
      const cols = Math.max(5, Math.ceil(Math.sqrt(n * 1.3))), rows = Math.max(1, Math.ceil(n / cols));
      return { w: Math.max(8.6, cols * 1.5 + 1.2), d: Math.max(6.6, rows * 1.95 + 1.2) };
    }
    if (kind === 'totems') {
      const rows = Math.max(1, Math.ceil(n / 5));
      return { w: 12.4, d: Math.max(4.8, rows * 2.0 + 0.8) };
    }
    const cols = n > 6 ? 4 : 3, rows = Math.max(1, Math.ceil(n / cols));
    return { w: Math.max(8.6, cols * (cols === 4 ? 1.95 : 2.5) + 1.2), d: Math.max(6.6, rows * 2.6 + 1.4) };
  }

  private buildArea(a: Area) {
    const g = new THREE.Group(); g.position.set(a.x, 0, a.z); this.scene.add(g);
    let base: THREE.BufferGeometry, carpet: THREE.BufferGeometry;
    if (a.kind === 'hub') {
      base = new THREE.CylinderGeometry(4.5, 4.6, 0.45, 6); base.translate(0, 0.225, 0);
      carpet = new THREE.CylinderGeometry(3.9, 3.9, 0.04, 6); carpet.translate(0, 0.47, 0);
    } else {
      base = slabGeo(a.w, a.d, 0.6, 0.35, 0.05);
      carpet = slabGeo(a.w - 0.8, a.d - 0.8, 0.4, 0.02, 0.01); carpet.translate(0, 0.44, 0);
    }
    const baseMat = M({ color: '#F3F4F6', roughness: 0.45 });
    const carpetMat = M({ color: a.color, roughness: 0.98 });
    const bm = new THREE.Mesh(base, baseMat), cm = new THREE.Mesh(carpet, carpetMat);
    bm.castShadow = bm.receiveShadow = true; cm.receiveShadow = true;
    bm.userData.area = cm.userData.area = a.id;
    g.add(bm, cm); this.pickables.push(bm, cm);
    Object.assign(a, { g, baseMat, carpetMat, top: 0.47, items: [] });
    this.areas.push(a);
    if (a.kind === 'desks') { this.plant(a, a.w / 2 - 0.55, a.d / 2 - 0.55); this.plant(a, -a.w / 2 + 0.55, -a.d / 2 + 0.55); }
    // rotulo
    const el = document.createElement('button');
    el.className = 'lbl area'; el.style.setProperty('--c', a.color);
    el.addEventListener('click', () => this.cb.onArea(a.id));
    this.labelsEl.appendChild(el); a.label = el;
    const y = a.kind === 'hub' ? 5.1 : a.kind === 'racks' ? 3.5 : a.kind === 'totems' ? 3.2 : 3.0;
    this.labels.push({ el, pos: new THREE.Vector3(a.x, y, a.kind === 'hub' ? a.z : a.z - a.d / 2 + 0.4) });
  }

  private refreshLabel(A: Area) {
    if (!A.label) return;
    const c = { total: A.items.length, warn: A.items.filter((i) => i.status === 'warn').length, crit: A.items.filter((i) => i.status === 'crit').length };
    const off = A.state && A.state !== 'open';
    A.label.innerHTML = `${esc(A.name)} <span class="n">${A.kind === 'hub' ? '' : c.total}</span>` +
      (off ? '<span class="bad crit">desconectado</span>' : '') +
      (c.crit ? `<span class="bad crit">${c.crit}</span>` : '') + (c.warn ? `<span class="bad warn">${c.warn}</span>` : '');
    A.label.setAttribute('aria-label', `${A.name}: ${c.total} itens`);
  }

  private finish(it: Item, group: THREE.Group) {
    it.group = group; shadows(group);
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.userData.item = it; this.pickables.push(o); } });
    it.mats.forEach((m) => { m.userData.base = m.opacity; m.userData.baseT = m.transparent; m.userData.baseDW = m.depthWrite; });
  }
  private marker(g: THREE.Group, it: Item, y: number, z = 0) {
    const m = new THREE.MeshStandardMaterial({ color: STATUS_COL[it.status], emissive: STATUS_COL[it.status], emissiveIntensity: 0.6, roughness: 0.3 });
    const o = new THREE.Mesh(new THREE.OctahedronGeometry(0.15), m); o.position.set(0, y, z);
    g.add(o); it.mats.push(m); this.spinners.push(o);
    if (it.status === 'crit') {
      const rm = new THREE.MeshBasicMaterial({ color: STATUS_COL.crit, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.6, 0.72, 48), rm);
      ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.03, z); ring.userData.noShadow = true;
      g.add(ring); it.mats.push(rm); this.pulses.push({ kind: 'ring', m: ring, mat: rm, it });
    }
  }
  private desk(A: Area, it: Item, px: number, pz: number, screen: THREE.Texture) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const wood = MAT.wood(), metal = MAT.metal(), dark = MAT.dark(), fabric = MAT.fabric(), skin = MAT.skin();
    const shirt = M({ color: A.color, roughness: 0.85 });
    const scr = M({ map: screen, emissive: '#ffffff', emissiveMap: screen, emissiveIntensity: it.status === 'ok' ? 0.55 : 0.25, roughness: 0.25 });
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.06, 0.8), wood); top.position.y = 0.74;
    const legGeo = new THREE.BoxGeometry(0.05, 0.72, 0.05);
    ([[-0.78, -0.33], [0.78, -0.33], [-0.78, 0.33], [0.78, 0.33]] as const).forEach(([x, z]) => { const l = new THREE.Mesh(legGeo, metal); l.position.set(x, 0.36, z); g.add(l); });
    const standB = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.16), metal); standB.position.set(0, 0.78, -0.22);
    const standN = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.26, 0.04), metal); standN.position.set(0, 0.9, -0.25);
    const bezel = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.52, 0.035), dark); bezel.position.set(0, 1.12, -0.22);
    const mon = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.46), scr); mon.position.set(0, 1.12, -0.2); mon.userData.noShadow = true;
    const kb = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.02, 0.16), dark); kb.position.set(0, 0.78, 0.08);
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.08, 0.48), fabric); seat.position.set(0, 0.48, 0.72);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.48, 0.55, 0.06), fabric); back.position.set(0, 0.82, 0.97);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4, 8), metal); stem.position.set(0, 0.24, 0.72);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.03, 5), metal); foot.position.set(0, 0.03, 0.72);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.32, 6, 14), shirt); body.position.set(0, 0.85, 0.7);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 24, 16), skin); head.position.set(0, 1.33, 0.68);
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.3, 4, 8), shirt); armL.position.set(-0.22, 0.86, 0.5); armL.rotation.x = 1.2;
    const armR = armL.clone(); armR.position.x = 0.22;
    this.heads.push({ m: head, base: 1.33, ph: Math.random() * 6.28 });
    g.add(top, standB, standN, bezel, mon, kb, seat, back, stem, foot, body, head, armL, armR);
    it.mats = [wood, metal, dark, fabric, skin, shirt, scr];
    if (it.status !== 'ok') this.marker(g, it, 1.8, 0.68);
    this.finish(it, g);
  }
  private rack(A: Area, it: Item, px: number, pz: number) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const body = M({ color: '#2B2F36', metalness: 0.6, roughness: 0.42 });
    const door = M({ map: this.RACK_TEX, metalness: 0.5, roughness: 0.5 });
    const led = new THREE.MeshStandardMaterial({ color: STATUS_COL[it.status], emissive: STATUS_COL[it.status], emissiveIntensity: 1.4 });
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.74, 2.0, 0.66), body); box.position.y = 1.0;
    const front = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 1.75), door); front.position.set(0, 1.0, 0.331);
    g.add(box, front);
    const ledGeo = new THREE.BoxGeometry(0.06, 0.025, 0.01);
    for (let i = 0; i < 5; i++) { const l = new THREE.Mesh(ledGeo, led); l.position.set(-0.24, 0.3 + i * 0.34, 0.34); l.userData.noShadow = true; g.add(l); }
    it.mats = [body, door, led];
    if (it.status !== 'ok') this.marker(g, it, 2.35);
    this.finish(it, g);
  }
  private totem(A: Area, it: Item, px: number, pz: number, kiosk: THREE.Texture) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const shell = M({ color: '#DADDE2', roughness: 0.3, metalness: 0.05 });
    const metal = MAT.metal();
    const off = it.status === 'crit';
    const scr = off ? M({ color: '#14161B', roughness: 0.15, metalness: 0.2 }) : M({ map: kiosk, emissive: '#ffffff', emissiveMap: kiosk, emissiveIntensity: 0.45, roughness: 0.2 });
    const led = new THREE.MeshStandardMaterial({ color: STATUS_COL[it.status], emissive: STATUS_COL[it.status], emissiveIntensity: 1.3 });
    const bodyGeo = new THREE.ExtrudeGeometry(rr(0.56, 1.8, 0.12), { depth: 0.22, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 3, curveSegments: 8 });
    bodyGeo.translate(0, 1.0, -0.11);
    const body = new THREE.Mesh(bodyGeo, shell);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 32), metal); base.position.y = 0.03;
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.8), scr); screen.position.set(0, 1.18, 0.135); screen.userData.noShadow = true;
    const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.02), led); strip.position.set(0, 1.78, 0.135); strip.userData.noShadow = true;
    g.add(body, base, screen, strip);
    it.mats = [shell, metal, scr, led];
    if (off) {
      const bm = new THREE.MeshBasicMaterial({ map: this.RT, color: STATUS_COL.crit, transparent: true, opacity: 0.5, depthWrite: false });
      const halo = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), bm); halo.rotation.x = -Math.PI / 2; halo.position.y = 0.02; halo.userData.noShadow = true;
      g.add(halo); it.mats.push(bm); this.pulses.push({ kind: 'halo', m: halo, mat: bm, it });
    }
    if (it.status !== 'ok') this.marker(g, it, 2.25);
    this.finish(it, g);
  }
  private buildHub(A: Area, it: Item) {
    const g = new THREE.Group(); g.position.y = A.top; A.g.add(g);
    const metal = MAT.metal(), white = MAT.white();
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 1.2, 48), white); ped.position.y = 0.6;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.06, 48), metal); cap.position.y = 1.23;
    const glass = new THREE.MeshPhysicalMaterial({ color: '#DCE3FF', roughness: 0.05, metalness: 0, transmission: 0.92, thickness: 0.8, ior: 1.4, clearcoat: 1, clearcoatRoughness: 0.05 });
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(1.25, 64, 48), glass); sphere.position.y = 2.55; sphere.userData.noShadow = true;
    const coreMat = new THREE.MeshStandardMaterial({ color: A.color, emissive: A.color, emissiveIntensity: 1.6 });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 2), coreMat); core.position.y = 2.55;
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(1.85, 0.035, 16, 160), metal); r1.position.y = 2.55; r1.rotation.x = Math.PI / 2 - 0.25;
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(2.15, 0.025, 16, 160), metal); r2.position.y = 2.55; r2.rotation.set(Math.PI / 2 + 0.5, 0.5, 0);
    g.add(ped, cap, sphere, core, r1, r2);
    it.mats = [metal, white, glass, coreMat]; it.anim = { core, r1, r2 };
    this.hub = it;
    this.finish(it, g);
  }
  private plant(A: Area, x: number, z: number) {
    const g = new THREE.Group(); g.position.set(x, 0.47, z); A.g.add(g);
    const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.38, 24), MAT.white()); pot.position.y = 0.19;
    const leafMat = M({ color: '#4E7A58', roughness: 0.9 });
    ([[0, 0.62, 0, 0.3], [0.13, 0.82, 0.06, 0.22], [-0.12, 0.78, -0.05, 0.2], [0.02, 1.0, -0.02, 0.16]] as const).forEach(([px, py, pz, r]) => {
      const l = new THREE.Mesh(new THREE.IcosahedronGeometry(r, 1), leafMat); l.position.set(px, py, pz); g.add(l);
    });
    g.add(pot); shadows(g);
  }
  private layoutItems(A: Area) {
    const list = A.items;
    if (A.kind === 'hub') { const h = list[0]; if (h) this.buildHub(A, h); }
    else if (A.kind === 'desks') {
      const screen = screenTex(A.color); this.areaTex.push(screen);
      const cols = list.length > 6 ? 4 : 3, rows = Math.max(1, Math.ceil(list.length / cols));
      const sx = cols === 4 ? 1.95 : 2.5, sz = 2.6;
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.desk(A, it, (c - (cols - 1) / 2) * sx, (r - (rows - 1) / 2) * sz - 0.45, screen); });
    } else if (A.kind === 'totems') {
      const kiosk = kioskTex(A.color); this.areaTex.push(kiosk);
      const rows = Math.max(1, Math.ceil(list.length / 5));
      list.forEach((it, i) => { const c = i % 5, r = Math.floor(i / 5); this.totem(A, it, (c - 2) * 2.2, (r - (rows - 1) / 2) * 2.0, kiosk); });
    } else {
      const cols = Math.max(5, Math.ceil(Math.sqrt(list.length * 1.3))), rows = Math.max(1, Math.ceil(list.length / cols));
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.rack(A, it, (c - (cols - 1) / 2) * 1.5, (r - (rows - 1) / 2) * 1.95); });
    }
    this.refreshLabel(A);
  }

  // ------------------------------------------------------------------ portais e particulas
  private buildPortals() {
    for (const p of this.portals) {
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); this.scene.add(g);
      const metal = MAT.metal();
      const frame = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.09, 20, 96), metal); frame.position.y = 2.35; frame.rotation.y = Math.PI / 2;
      const lightMat = new THREE.MeshStandardMaterial({ color: p.color, emissive: p.color, emissiveIntensity: 1.5 });
      const inner = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.025, 12, 96), lightMat); inner.position.y = 2.35; inner.rotation.y = Math.PI / 2;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.85, 0.5, 48), MAT.white()); base.position.y = 0.25;
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.7, 16), metal); post.position.y = 0.7;
      g.add(frame, inner, base, post); shadows(g); p.g = g; p.inner = inner;
      const el = document.createElement('span'); el.className = 'lbl portal'; el.style.setProperty('--c', p.color); el.textContent = p.name;
      p.labelPos = new THREE.Vector3(p.x, 4.6, p.z);
      this.labelsEl.appendChild(el); this.labels.push({ el, pos: p.labelPos });
    }
  }
  private buildPaths() {
    this.paths.clear(); this.parts = [];
    this.portals.forEach((p, pi) => this.areas.filter((a) => a.kind === 'desks').forEach((a) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(p.x, 2.35, p.z), new THREE.Vector3(p.x * 0.55, 4.8, p.z * 0.5),
        new THREE.Vector3(0, 2.55, 0), new THREE.Vector3(a.x * 0.5, 4.6, a.z * 0.5), new THREE.Vector3(a.x, 1.9, a.z),
      ]);
      this.paths.set(`${pi}:${a.id}`, curve.getSpacedPoints(160));
    }));
  }
  /** Mensagem chegando de verdade: rajada de particulas do portal ate a ilha da pessoa. */
  burst(channel: 'WHATSAPP' | 'GMAIL', areaId: string, n = 7) {
    const pi = channel === 'GMAIL' ? 1 : 0;
    const path = this.paths.get(`${pi}:${areaId}`) ?? [...this.paths.entries()].find(([k]) => k.startsWith(`${pi}:`))?.[1];
    if (!path || !this.flowOn) return;
    for (let i = 0; i < n; i++) this.parts.push({ path, t: -i * 0.025, speed: 0.2 + Math.random() * 0.06, col: new THREE.Color(this.portals[pi].color) });
  }
  private updateParticles(dt: number) {
    if (this.flowOn && this.paths.size) {
      this.ambientAcc += dt;
      if (this.ambientAcc > this.ambientEvery) {
        this.ambientAcc = 0;
        const keys = [...this.paths.keys()];
        const k = keys[Math.floor(Math.random() * keys.length)];
        this.parts.push({ path: this.paths.get(k)!, t: 0, speed: 0.16 + Math.random() * 0.05, col: new THREE.Color(this.portals[+k[0]].color).multiplyScalar(0.7) });
      }
    }
    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) { this.parts[i].t += this.parts[i].speed * dt; if (this.parts[i].t >= 1) this.parts.splice(i, 1); }
    for (const p of this.parts) {
      if (p.t < 0 || n >= 320) continue;
      const L = p.path.length - 1, f = p.t * L, i0 = Math.floor(f), k = f - i0;
      const a = p.path[i0], b = p.path[Math.min(L, i0 + 1)];
      this.pPos[n * 3] = a.x + (b.x - a.x) * k; this.pPos[n * 3 + 1] = a.y + (b.y - a.y) * k; this.pPos[n * 3 + 2] = a.z + (b.z - a.z) * k;
      this.pCol[n * 3] = p.col.r; this.pCol[n * 3 + 1] = p.col.g; this.pCol[n * 3 + 2] = p.col.b; n++;
    }
    this.pGeo.setDrawRange(0, n);
    (this.pGeo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.pGeo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // ------------------------------------------------------------------ tema, filtros, camera
  applyTheme() {
    const dark = isDark();
    const bg = new THREE.Color(css('--scene-bg') || css('--bg') || (dark ? '#101217' : '#E6E8EC'));
    this.scene.background = bg; this.scene.fog = new THREE.Fog(bg, 60 * this.K, 150 * this.K);
    this.floorMat.color.set(css('--floor') || (dark ? '#0D0F13' : '#DCE0E5'));
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    const gc = css('--grid') || (dark ? '#1F232A' : '#C6CCD4');
    this.grid = new THREE.GridHelper(200, 100, gc, gc);
    const gm = this.grid.material as THREE.Material; gm.transparent = true; gm.opacity = 0.55;
    this.grid.position.y = 0.003; this.scene.add(this.grid);
    this.renderer.toneMappingExposure = dark ? 0.8 : 0.78;
    this.sun.intensity = (dark ? 1.1 : 1.6) * LEGACY; this.fill.intensity = (dark ? 0.08 : 0.15) * LEGACY;
    const isl = new THREE.Color(css('--island') || css('--slab-base') || (dark ? '#2A2E36' : '#EEF0F3'));
    const mix = dark ? new THREE.Color('#1A1D23') : new THREE.Color('#FFFFFF');
    for (const A of this.areas) {
      A.baseMat.color.copy(isl);
      const off = A.state && A.state !== 'open';
      A.carpetMat.color.set(off ? STATUS_COL.crit : A.color).lerp(mix, dark ? 0.62 : 0.22);
    }
    this.pMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending; this.pMat.needsUpdate = true;
    this.pMat.size = dark ? 0.42 : 0.5;
  }
  setFilter(f: Partial<typeof this.filter>) { Object.assign(this.filter, f); this.applyFilter(); }
  private norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  private setDim(it: Item, dim: boolean) {
    if (it.dim === dim) return; it.dim = dim;
    for (const m of it.mats) {
      const t = dim || m.userData.baseT === true;
      if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; }
      m.opacity = (m.userData.base ?? 1) * (dim ? 0.12 : 1);
      m.depthWrite = dim ? false : m.userData.baseDW !== false;
    }
    it.group?.traverse((o) => { if ((o as THREE.Mesh).isMesh && !o.userData.noShadow) o.castShadow = !dim; });
  }
  private applyFilter(): number {
    const q = this.norm(this.filter.q.trim());
    let n = 0;
    for (const it of this.items) {
      const ok = (this.filter.status === 'all' || it.status === this.filter.status) &&
        (!q || this.norm(`${it.name} ${it.sub} ${Object.values(it.extra).join(' ')}`).includes(q)) &&
        (!this.filter.area || it.area === this.filter.area);
      this.setDim(it, !ok);
      if (ok) n++;
    }
    for (const A of this.areas) {
      const faded = !!((this.filter.area && this.filter.area !== A.id) || (A.items.length > 0 && !A.items.some((i) => !i.dim)));
      if (A.faded !== faded) {
        A.faded = faded;
        for (const m of [A.baseMat, A.carpetMat]) { m.transparent = faded; m.opacity = faded ? 0.45 : 1; m.depthWrite = !faded; m.needsUpdate = true; }
      }
      A.label?.classList.toggle('dim', faded);
    }
    return n;
  }
  count() { return this.items.filter((i) => !i.dim).length; }
  firstVisible() { return this.items.find((i) => !i.dim); }
  setLabels(on: boolean) { this.labelsOn = on; }
  setFlow(on: boolean) { this.flowOn = on; if (!on) this.parts = []; }
  setSpin(on: boolean) { this.controls.autoRotate = on; }
  private flyTo(target: THREE.Vector3, cam: THREE.Vector3) {
    if (reduce()) { this.controls.target.copy(target); this.camera.position.copy(cam); return; }
    this.tween = { t: 0, ft: this.controls.target.clone(), fc: this.camera.position.clone(), tt: target.clone(), tc: cam.clone() };
  }
  focusArea(id: string) {
    const A = this.areas.find((a) => a.id === id); if (!A) return;
    this.controls.autoRotate = false;
    const t = new THREE.Vector3(A.x, 0.8, A.z);
    const off = A.kind === 'totems' ? new THREE.Vector3(10, 11, 14) : A.kind === 'hub' ? new THREE.Vector3(9, 9, 12) : new THREE.Vector3(9, 10, 12);
    off.multiplyScalar(Math.max(1, Math.max(A.w / 8.6, A.d / 6.6) * 0.9));
    this.flyTo(t, t.clone().add(off));
  }
  focusItem(id: string) {
    const it = this.items.find((i) => i.id === id); if (!it?.group) return;
    this.controls.autoRotate = false;
    const p = new THREE.Vector3(); it.group.getWorldPosition(p); p.y += 0.9;
    this.flyTo(p, p.clone().add(new THREE.Vector3(3.4, 3.6, 4.8)));
  }
  home() { this.flyTo(this.HOME.target, this.HOME.cam); }

  // ------------------------------------------------------------------ interacao e laco
  private pick(ev: PointerEvent): { item: SceneItem } | { area: string } | null {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.mouse, this.camera);
    for (const h of this.ray.intersectObjects(this.pickables, false)) {
      const u = h.object.userData;
      if (u.item && !u.item.dim) return { item: u.item };
      if (u.area) return { area: u.area };
    }
    return null;
  }
  private setHover(it: Item | null) {
    if (this.hoverIt === it) return;
    if (this.hoverIt?.group) this.hoverIt.group.scale.setScalar(1);
    this.hoverIt = it; if (it?.group && it !== this.hub) it.group.scale.setScalar(1.06);
  }
  private handleMove() {
    const ev = this.pendingMove; this.pendingMove = null; if (!ev) return;
    const h = this.pick(ev);
    if (h && 'item' in h) {
      this.setHover(h.item as Item);
      this.tip.innerHTML = `<strong>${esc(h.item.name)}</strong>${esc(h.item.sub)}`;
      const r = this.canvas.getBoundingClientRect();
      this.tip.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 270)}px`; this.tip.style.top = `${ev.clientY - r.top + 14}px`;
      this.tip.classList.add('show'); this.canvas.style.cursor = 'pointer';
    } else {
      this.setHover(null); this.tip.classList.remove('show');
      this.canvas.style.cursor = h ? 'pointer' : 'grab';
    }
  }
  private resize() {
    const p = this.canvas.parentElement!; this.W = p.clientWidth; this.H = p.clientHeight;
    this.renderer.setSize(this.W, this.H, false); this.camera.aspect = this.W / Math.max(1, this.H); this.camera.updateProjectionMatrix();
  }
  private vtmp = new THREE.Vector3();
  private updateLabels() {
    for (const L of this.labels) {
      this.vtmp.copy(L.pos).project(this.camera);
      const vis = this.labelsOn && this.vtmp.z < 1 && Math.abs(this.vtmp.x) < 1.2 && Math.abs(this.vtmp.y) < 1.2;
      L.el.style.display = vis ? '' : 'none';
      if (vis) L.el.style.transform = `translate(${(this.vtmp.x * 0.5 + 0.5) * this.W}px, ${(-this.vtmp.y * 0.5 + 0.5) * this.H}px) translate(-50%, -100%)`;
    }
  }
  private loop = (now: number) => {
    if (!this.running) return;
    const dt = Math.min(0.05, (now - this.last) / 1000); this.last = now; this.time += dt;
    if (this.pendingMove) this.handleMove();
    if (this.tween) {
      this.tween.t = Math.min(1, this.tween.t + dt / 0.9); const k = 1 - Math.pow(1 - this.tween.t, 3);
      this.controls.target.lerpVectors(this.tween.ft, this.tween.tt, k); this.camera.position.lerpVectors(this.tween.fc, this.tween.tc, k);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.controls.update();
    if (!reduce()) {
      const h = this.hub?.anim;
      if (h) { h.r1.rotation.z += dt * 0.45; h.r2.rotation.z -= dt * 0.3; h.core.rotation.y += dt * 0.6; h.core.scale.setScalar(1 + Math.sin(this.time * 1.6) * 0.05); }
      for (const s of this.spinners) s.rotation.y += dt * 1.4;
      for (const hd of this.heads) hd.m.position.y = hd.base + Math.sin(this.time * 2 + hd.ph) * 0.018;
      for (const p of this.pulses) {
        const k = (Math.sin(this.time * Math.PI) + 1) / 2, dimF = p.it.dim ? 0.12 : 1, base = p.mat.userData.base ?? 0.55;
        if (p.kind === 'ring') { p.m.scale.setScalar(1 + k * 0.5); p.mat.opacity = base * dimF * (1 - k * 0.6); }
        else { p.m.scale.setScalar(0.9 + k * 0.25); p.mat.opacity = base * dimF * (0.5 + k * 0.5); }
      }
      for (const p of this.portals) if (p.inner) p.inner.rotation.x += dt * 0.8;
      this.updateParticles(dt);
    } else if (this.flowOn) this.updateParticles(dt * 0.4);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.frames++; this.acc += dt;
    if (this.acc > 2) {
      const fps = this.frames / this.acc;
      if (fps < 40) {
        // degrada aos poucos: resolucao, depois sombra menor, depois sem sombra
        this.lowSteps++;
        if (this.lowSteps === 1 && this.pr > 1) { this.pr = 1; this.renderer.setPixelRatio(1); this.resize(); }
        else if (this.lowSteps === 2) { this.sun.shadow.mapSize.set(1024, 1024); this.sun.shadow.map?.dispose(); this.sun.shadow.map = null; }
        else if (this.lowSteps === 3) { this.sun.castShadow = false; this.ambientEvery = 2; }
      }
      this.frames = 0; this.acc = 0;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.ro.disconnect(); this.cleanup.forEach((f) => f());
    this.controls.dispose();
    this.labelsEl.innerHTML = '';
    disposeTree(this.scene);
    this.areaTex.forEach((t) => t.dispose()); this.areaTex = [];
    this.RT.dispose(); this.RACK_TEX.dispose(); this.envTex?.dispose(); this.envTex = null;
    this.sun.shadow.map?.dispose();
    this.renderer.dispose();
  }
}
