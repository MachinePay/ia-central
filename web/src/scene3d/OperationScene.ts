import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Maquete 3D da operacao, visual neon/holograma.
 * Centro: IA central (orquestrador, globo de linhas). Em volta: uma plataforma hexagonal por numero/pessoa e a do Sentinela.
 * Tudo e desenhado com linhas brilhantes + preenchimentos translucidos; o brilho vem do bloom (tema escuro)
 * e de sprites aditivos. A cena e imperativa (Three.js); a interface em volta (busca, doca, painel) e React.
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
  x: number; z: number; color: string; g: THREE.Group; mats: THREE.Material[];
  w: number; d: number; hx: number; hz: number; top: number; items: Item[]; label?: HTMLButtonElement; faded?: boolean;
};
type Portal = { id: string; name: string; color: string; x: number; z: number; g?: THREE.Group; inner?: THREE.Object3D; labelPos?: THREE.Vector3 };
/** line: traco neon (cor solida); fill: preenchimento translucido; body: corpo meio solido das figuras; glow: brilho aditivo (vira normal e mais fraco no tema claro) */
type Kind = 'line' | 'fill' | 'glow' | 'body';

// ------------------------------------------------------------------ texturas desenhadas
function radialTex() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
}
function beamTex() {
  const c = document.createElement('canvas'); c.width = 8; c.height = 128;
  const g = c.getContext('2d')!; const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.7, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,1)');
  g.fillStyle = gr; g.fillRect(0, 0, 8, 128); return new THREE.CanvasTexture(c);
}

// ------------------------------------------------------------------ construtor de linhas (LineSegments)
class LB {
  s: number[] = [];
  seg(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number) { this.s.push(x1, y1, z1, x2, y2, z2); return this; }
  poly(p: number[][], closed = true) {
    for (let i = 0; i < p.length - (closed ? 0 : 1); i++) { const a = p[i], b = p[(i + 1) % p.length]; this.seg(a[0], a[1], a[2], b[0], b[1], b[2]); }
    return this;
  }
  rectY(cx: number, y: number, cz: number, w: number, d: number) {
    return this.poly([[cx - w / 2, y, cz - d / 2], [cx + w / 2, y, cz - d / 2], [cx + w / 2, y, cz + d / 2], [cx - w / 2, y, cz + d / 2]]);
  }
  rectZ(cx: number, cy: number, z: number, w: number, h: number) {
    return this.poly([[cx - w / 2, cy - h / 2, z], [cx + w / 2, cy - h / 2, z], [cx + w / 2, cy + h / 2, z], [cx - w / 2, cy + h / 2, z]]);
  }
  box(cx: number, cy: number, cz: number, w: number, h: number, d: number) {
    this.rectY(cx, cy - h / 2, cz, w, d); this.rectY(cx, cy + h / 2, cz, w, d);
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) this.seg(cx + sx * w / 2, cy - h / 2, cz + sz * d / 2, cx + sx * w / 2, cy + h / 2, cz + sz * d / 2);
    return this;
  }
  /** circulo/poligono regular no plano dado */
  ring(cx: number, cy: number, cz: number, r: number, n: number, plane: 'xz' | 'xy' | 'yz' = 'xz', a0 = 0) {
    const p: number[][] = [];
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * Math.PI * 2, u = Math.cos(a) * r, v = Math.sin(a) * r;
      p.push(plane === 'xz' ? [cx + u, cy, cz + v] : plane === 'xy' ? [cx + u, cy + v, cz] : [cx, cy + v, cz + u]);
    }
    return this.poly(p);
  }
  /** prisma/tronco de n lados entre y1 e y2 */
  prism(cx: number, cz: number, r1: number, r2: number, y1: number, y2: number, n: number) {
    this.ring(cx, y1, cz, r1, n); this.ring(cx, y2, cz, r2, n);
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; this.seg(cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1, cx + Math.cos(a) * r2, y2, cz + Math.sin(a) * r2); }
    return this;
  }
  geo() { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(this.s, 3)); return g; }
}

const hexPts = (sx: number, sz: number): Array<[number, number]> => [[sx, 0], [sx / 2, sz], [-sx / 2, sz], [-sx, 0], [-sx / 2, -sz], [sx / 2, -sz]];
/** hexagono (achatado em x) que cobre um retangulo w x d de itens (cantos com folga) */
function hexDims(kind: SceneArea['kind'], w: number, d: number) {
  if (kind === 'hub') return { hx: 4.9, hz: 4.9 * 0.866 };
  const wi = w - 1.2, di = d - 1.0, hz = di / 2 + 0.55;
  return { hx: Math.max((wi / 2) / (1 - 0.5 * (di / 2) / hz), hz * 1.1547), hz };
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o: any) => {
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => { if (m && !m.userData.shared) m.dispose(); });
  });
}
const shared = <T extends { userData: Record<string, any> }>(o: T) => { o.userData.shared = true; return o; };

export class OperationScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 400);
  private controls: OrbitControls;
  private composer: EffectComposer;
  private renderPass: RenderPass;
  private bloom: UnrealBloomPass;
  private outPass: OutputPass;
  private bloomOn = true; private bloomOff = false;
  private RT = radialTex();
  private BEAM = beamTex();
  // geometrias compartilhadas (nao sao liberadas ao refazer a cena, so no dispose)
  private G = {
    ring: shared(new THREE.RingGeometry(0.5, 0.58, 40).rotateX(-Math.PI / 2)),
    glow: shared(new THREE.PlaneGeometry(1.9, 1.9).rotateX(-Math.PI / 2)),
    marker: shared(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.16))),
    beam: shared(new THREE.PlaneGeometry(0.08, 1).translate(0, 0.5, 0)),
    pDesk: shared(new THREE.BoxGeometry(1.8, 1.6, 2.0).translate(0, 0.8, 0.3)),
    pRack: shared(new THREE.BoxGeometry(0.84, 2.2, 0.76).translate(0, 1.1, 0)),
    pTotem: shared(new THREE.BoxGeometry(0.8, 2.0, 0.6).translate(0, 1.0, 0)),
    pHub: shared(new THREE.SphereGeometry(1.5, 16, 12).translate(0, 2.15, 0)),
  };
  private proxyMat = shared(new THREE.MeshBasicMaterial({ visible: false }));
  private floorMat = new THREE.MeshBasicMaterial({ color: '#070A12' });
  private grid?: THREE.GridHelper;
  private mats = new Set<THREE.Material>();
  private TK: Record<Kind, number> = { line: 1, fill: 1, glow: 1, body: 1 };
  private dark = true;
  private areas: Area[] = [];
  private items: Item[] = [];
  private pickables: THREE.Object3D[] = [];
  private pulses: Array<{ kind: 'ring' | 'halo'; m: THREE.Object3D; mat: THREE.Material; it: Item }> = [];
  private heads: Array<{ m: THREE.Object3D; base: number; ph: number }> = [];
  private spinners: THREE.Object3D[] = [];
  private portals: Portal[] = [
    { id: 'wa', name: 'WhatsApp', color: '#3FAE7C', x: -22, z: -2 },
    { id: 'gm', name: 'E-mail', color: '#E5484D', x: 22, z: -2 },
  ];
  private links?: THREE.Group;
  private linkPaths: Array<{ path: THREE.Vector3[]; col: THREE.Color }> = [];
  private paths = new Map<string, THREE.Vector3[]>();
  private pGeo = new THREE.BufferGeometry();
  private pPos: Float32Array; private pCol: Float32Array;
  private pMat: THREE.PointsMaterial;
  private parts: Array<{ path: THREE.Vector3[]; t: number; speed: number; col: THREE.Color }> = [];
  private flowOn = true; private labelsOn = true;
  private ambientEvery = 0.6; private ambientAcc = 0;
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
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.pr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.renderer.setPixelRatio(this.pr);

    // bloom: o brilho neon de verdade (so no tema escuro; desliga sozinho se o FPS cair)
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, rt);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.5, 0.35, 0.45);
    this.outPass = new OutputPass();
    this.composer.addPass(this.renderPass); this.composer.addPass(this.bloom); this.composer.addPass(this.outPass);
    this.composer.setPixelRatio(this.pr);

    this.camera.position.copy(this.HOME.cam);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.HOME.target);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.2; this.controls.minDistance = 6; this.controls.maxDistance = 95;
    this.controls.autoRotateSpeed = 0.3; this.controls.autoRotate = false;
    this.controls.addEventListener('start', () => { this.tween = null; });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), this.floorMat);
    floor.rotation.x = -Math.PI / 2; floor.position.y = -0.01; this.scene.add(floor);

    const MAXP = 360;
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

  // ------------------------------------------------------------------ materiais neon
  private val(m: THREE.Material) { const u = m.userData; return (u.base0 ?? 1) * this.TK[(u.kind ?? 'line') as Kind] * (u.dimF ?? 1); }
  private refresh(m: THREE.Material) {
    m.opacity = Math.min(1, this.val(m));
    // corpos das figuras escrevem profundidade (parecem solidos); apagados pelo filtro, nao
    if (m.userData.kind === 'body') m.depthWrite = (m.userData.dimF ?? 1) >= 1;
  }
  private track<T extends THREE.Material>(m: T, kind: Kind, base: number): T {
    m.transparent = true; m.depthWrite = false;
    Object.assign(m.userData, { kind, base0: base, dimF: 1 });
    if (kind === 'glow') m.blending = this.dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    this.mats.add(m); this.refresh(m); return m;
  }
  private line(color: THREE.ColorRepresentation, base = 0.95) { return this.track(new THREE.LineBasicMaterial({ color }), 'line', base); }
  private solid(color: THREE.ColorRepresentation, base = 0.95) { return this.track(new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }), 'line', base); }
  private fill(color: THREE.ColorRepresentation, base = 0.1) { return this.track(new THREE.MeshBasicMaterial({ color }), 'fill', base); }
  /** corpo translucido das figuras: cor da area um pouco escurecida para as arestas neon aparecerem por cima */
  private body(color: THREE.ColorRepresentation, base = 0.55) {
    return this.track(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).lerp(new THREE.Color('#000000'), 0.22) }), 'body', base);
  }
  private glow(color: THREE.ColorRepresentation, base = 0.4, map: THREE.Texture | null = this.RT) {
    return this.track(new THREE.MeshBasicMaterial({ color, map, side: THREE.DoubleSide }), 'glow', base);
  }
  private sprite(color: THREE.ColorRepresentation, base = 0.5) { return this.track(new THREE.SpriteMaterial({ color, map: this.RT }), 'glow', base); }
  private untrack(root: THREE.Object3D) {
    root.traverse((o: any) => (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m && this.mats.delete(m)));
  }
  /** feixe de luz vertical (dois planos cruzados com gradiente) */
  private beam(parent: THREE.Object3D, x: number, y: number, z: number, h: number, color: THREE.ColorRepresentation, base = 0.55) {
    const m = this.glow(color, base, this.BEAM);
    for (const r of [0, Math.PI / 2]) { const b = new THREE.Mesh(this.G.beam, m); b.position.set(x, y, z); b.scale.y = h; b.rotation.y = r + Math.PI / 4; parent.add(b); }
    const dot = new THREE.Sprite(this.sprite(color, base)); dot.position.set(x, y + 0.05, z); dot.scale.setScalar(0.9); parent.add(dot);
    return [m, dot.material];
  }

  // ------------------------------------------------------------------ dados
  setData(areasIn: SceneArea[], itemsIn: SceneItem[]) {
    // remove o que existia (ilhas e itens), libera a memoria da GPU e monta de novo
    for (const a of this.areas) { this.scene.remove(a.g); this.untrack(a.g); disposeTree(a.g); a.label?.remove(); }
    if (this.links) { this.scene.remove(this.links); this.untrack(this.links); disposeTree(this.links); this.links = undefined; }
    this.labels = this.labels.filter((l) => !l.el.classList.contains('area'));
    this.areas = []; this.items = []; this.pickables = []; this.pulses = []; this.heads = []; this.spinners = [];
    this.hub = undefined; this.hoverIt = null;

    // tamanho de cada ilha a partir da quantidade de itens
    const byArea = new Map<string, SceneItem[]>();
    for (const it of itemsIn) { const l = byArea.get(it.area) ?? []; l.push(it); byArea.set(it.area, l); }
    const sizeOf = (a: SceneArea) => { const s = this.areaSize(a.kind, byArea.get(a.id)?.length ?? 0); return { ...s, ...hexDims(a.kind, s.w, s.d) }; };
    const ring = areasIn.filter((a) => a.kind !== 'hub');
    const sizes = ring.map(sizeOf);
    const maxHX = Math.max(5, ...sizes.map((s) => s.hx)), maxHZ = Math.max(3.8, ...sizes.map((s) => s.hz));
    const R = Math.max(13, 3.3 * ring.length, (ring.length * (maxHX * 1.6 + 1.2)) / (Math.PI * 2), (5.2 + maxHZ + 1.8) / 0.78);
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

    // camera, neblina e portais acompanham o tamanho do anel
    this.K = Math.max(1, (R + 5) / 17);
    this.HOME.cam.set(32, 33, 40).multiplyScalar(this.K);
    this.controls.maxDistance = Math.max(95, this.HOME.cam.length() * 1.6);
    this.camera.far = 400 * this.K; this.camera.updateProjectionMatrix();
    const px = R + maxHX * 0.5 + 6;
    this.portals.forEach((p, pi) => {
      p.x = pi === 0 ? -px : px;
      p.g?.position.set(p.x, 0, p.z); p.labelPos?.set(p.x, 3.4, p.z);
    });

    this.buildLinks();
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
    const H = a.kind === 'hub' ? 0.4 : 0.32;
    const { hx, hz } = a, col = new THREE.Color(a.color);
    const pts = hexPts(hx, hz);
    // corpo translucido (tambem e o alvo do clique na area)
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    const body = new THREE.ExtrudeGeometry(shape, { depth: H, bevelEnabled: false }); body.rotateX(-Math.PI / 2);
    const fillM = this.fill(a.color, 0.12);
    const slab = new THREE.Mesh(body, fillM); slab.userData.area = a.id; slab.renderOrder = -1;
    // contornos neon: borda de cima/baixo e arestas verticais; anel interno e anel no chao mais fracos
    const L = new LB();
    L.poly(pts.map(([x, z]) => [x, H, z])); L.poly(pts.map(([x, z]) => [x, 0.01, z]));
    for (const [x, z] of pts) L.seg(x, 0.01, z, x, H, z);
    const edges = new THREE.LineSegments(L.geo(), this.line(a.color, 1));
    const L2 = new LB(); L2.poly(pts.map(([x, z]) => [x * 0.88, H + 0.005, z * 0.88]));
    const inner = new THREE.LineSegments(L2.geo(), this.line(a.color, 0.4));
    const L3 = new LB(); L3.poly(pts.map(([x, z]) => [x * 1.1, 0.012, z * 1.1]));
    const outer = new THREE.LineSegments(L3.geo(), this.line(a.color, 0.2));
    // brilho interno no tampo e halo no chao
    const topGlowM = this.glow(a.color, 0.28);
    const topGlow = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2, hz * 2).rotateX(-Math.PI / 2), topGlowM); topGlow.position.y = H + 0.01;
    const haloM = this.glow(a.color, 0.22);
    const halo = new THREE.Mesh(new THREE.PlaneGeometry(hx * 2.8, hz * 2.8).rotateX(-Math.PI / 2), haloM); halo.position.y = 0.005;
    g.add(slab, edges, inner, outer, topGlow, halo); this.pickables.push(slab);
    const mats: THREE.Material[] = [fillM, edges.material as THREE.Material, inner.material as THREE.Material, outer.material as THREE.Material, topGlowM, haloM];
    // feixes de luz verticais nos cantos de tras
    const beamCol = col.clone().lerp(new THREE.Color('#ffffff'), 0.25);
    if (a.kind === 'hub') mats.push(...this.beam(g, 0, H, 0, 14, beamCol, 0.35));
    else {
      const [bx, bz] = pts[(a as any)._i % 2 ? 4 : 5];
      mats.push(...this.beam(g, bx, 0.01, bz, 7 + ((a as any)._i % 3) * 1.5, beamCol, 0.6));
    }
    Object.assign(a, { g, mats, top: H, items: [] });
    this.areas.push(a);
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

  /** guarda o grupo no item, cria o alvo invisivel de clique/hover */
  private finish(it: Item, group: THREE.Group, proxyGeo: THREE.BufferGeometry) {
    it.group = group;
    const proxy = new THREE.Mesh(proxyGeo, this.proxyMat); proxy.userData.item = it;
    group.add(proxy); this.pickables.push(proxy);
  }
  /** status de cada figura: anel + brilho no chao na cor do status; atencao/critico ganham um losango girando em cima */
  private status(g: THREE.Group, it: Item, markerY: number, z = 0) {
    const c = STATUS_COL[it.status], ok = it.status === 'ok';
    const rm = this.glow(c, ok ? 0.45 : 0.9, null);
    const ring = new THREE.Mesh(this.G.ring, rm); ring.position.set(0, 0.02, z);
    const gm = this.glow(c, ok ? 0.2 : 0.5);
    const gl = new THREE.Mesh(this.G.glow, gm); gl.position.set(0, 0.015, z);
    g.add(ring, gl); it.mats.push(rm, gm);
    if (!ok) {
      const mm = this.line(c, 1);
      const o = new THREE.LineSegments(this.G.marker, mm); o.position.set(0, markerY, z);
      const sm = this.sprite(c, 0.55); const s = new THREE.Sprite(sm); s.scale.setScalar(0.8); s.position.set(0, markerY, z);
      g.add(o, s); it.mats.push(mm, sm); this.spinners.push(o);
    }
    if (it.status === 'crit') this.pulses.push({ kind: 'ring', m: ring, mat: rm, it });
  }

  // geometrias holograficas por ilha (uma de cada por ilha, compartilhada entre os itens)
  private deskGeos() {
    const L = new LB();
    L.box(0, 0.72, 0, 1.6, 0.04, 0.72);
    for (const x of [-0.76, 0.76]) { L.seg(x, 0, -0.32, x, 0.7, -0.32); L.seg(x, 0, 0.32, x, 0.7, 0.32); L.seg(x, 0.04, -0.32, x, 0.04, 0.32); }
    L.box(0, 1.12, -0.235, 0.84, 0.5, 0.03); L.seg(0, 0.74, -0.24, 0, 0.87, -0.24); L.rectY(0, 0.745, -0.24, 0.26, 0.14);
    L.rectY(0, 0.76, 0.08, 0.5, 0.15);
    // cadeira
    L.box(0, 0.48, 0.74, 0.5, 0.06, 0.46); L.box(0, 0.8, 0.98, 0.46, 0.5, 0.05); L.seg(0, 0.45, 0.74, 0, 0.05, 0.74); L.ring(0, 0.04, 0.74, 0.26, 5);
    // pessoa: tronco em prisma, bracos em linhas
    L.prism(0, 0.7, 0.2, 0.15, 0.6, 1.12, 6);
    const arms: Array<[number[], number[]]> = [];
    for (const s of [-1, 1]) arms.push([[s * 0.19, 1.08, 0.7], [s * 0.26, 0.86, 0.46]], [[s * 0.26, 0.86, 0.46], [s * 0.14, 0.8, 0.16]]);
    for (const [a, b] of arms) L.seg(a[0], a[1], a[2], b[0], b[1], b[2]);
    const H = new LB(); H.ring(0, 0, 0, 0.15, 16, 'xz'); H.ring(0, 0, 0, 0.15, 16, 'xy'); H.ring(0, 0, 0, 0.15, 16, 'yz');
    // corpos preenchidos (uma geometria so por ilha, compartilhada pelas mesas)
    const B = (w: number, h: number, d: number, x: number, y: number, z: number) => new THREE.BoxGeometry(w, h, d).translate(x, y, z);
    const C = (r1: number, r2: number, h: number, n: number, x: number, y: number, z: number) => new THREE.CylinderGeometry(r1, r2, h, n).rotateY(Math.PI / 6).translate(x, y, z);
    const up = new THREE.Vector3(0, 1, 0);
    const rod = (a: number[], b: number[], r: number) => {
      const va = new THREE.Vector3(a[0], a[1], a[2]), vb = new THREE.Vector3(b[0], b[1], b[2]), d = vb.clone().sub(va);
      const g = new THREE.CylinderGeometry(r, r, d.length(), 6);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(up, d.normalize()));
      const m = va.add(vb).multiplyScalar(0.5); return g.translate(m.x, m.y, m.z);
    };
    const parts = [
      B(1.6, 0.04, 0.72, 0, 0.72, 0),
      ...[[-0.76, -0.32], [0.76, -0.32], [-0.76, 0.32], [0.76, 0.32]].map(([x, z]) => B(0.04, 0.7, 0.04, x, 0.35, z)),
      B(0.84, 0.5, 0.03, 0, 1.12, -0.235), B(0.04, 0.14, 0.04, 0, 0.81, -0.24), B(0.26, 0.01, 0.14, 0, 0.745, -0.24), B(0.5, 0.02, 0.15, 0, 0.75, 0.08),
      B(0.5, 0.06, 0.46, 0, 0.48, 0.74), B(0.46, 0.5, 0.05, 0, 0.8, 0.98), C(0.03, 0.03, 0.42, 6, 0, 0.25, 0.74), C(0.26, 0.26, 0.02, 5, 0, 0.04, 0.74),
      C(0.15, 0.2, 0.52, 6, 0, 0.86, 0.7), ...arms.map(([a, b]) => rod(a, b, 0.045)),
    ];
    const fill = mergeGeometries(parts)!; parts.forEach((p) => p.dispose());
    const headFill = new THREE.SphereGeometry(0.14, 14, 10);
    const scr = new THREE.PlaneGeometry(0.76, 0.42); scr.translate(0, 1.12, -0.218);
    return { body: L.geo(), head: H.geo(), fill, headFill, screen: scr };
  }
  private desk(A: Area, it: Item, px: number, pz: number, G: ReturnType<OperationScene['deskGeos']>) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const edge = new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), 0.2);
    const lm = this.line(edge, 0.95), bm = this.body(A.color, 0.55);
    const body = new THREE.LineSegments(G.body, lm);
    const fill = new THREE.Mesh(G.fill, bm);
    const head = new THREE.LineSegments(G.head, lm); head.position.set(0, 1.33, 0.7);
    head.add(new THREE.Mesh(G.headFill, bm));
    // tela acesa: face clara e solida + brilho atras
    const ok = it.status === 'ok';
    const sm = this.solid(new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), ok ? 0.45 : 0.15), ok ? 0.95 : 0.5);
    const scr = new THREE.Mesh(G.screen, sm);
    const gm = this.glow(A.color, ok ? 0.5 : 0.2, null);
    const scrGlow = new THREE.Mesh(G.screen, gm); scrGlow.scale.setScalar(1.12); scrGlow.position.set(0, -0.134, 0.03);
    this.heads.push({ m: head, base: 1.33, ph: Math.random() * 6.28 });
    g.add(fill, body, head, scr, scrGlow);
    it.mats = [lm, bm, sm, gm];
    this.status(g, it, 1.8, 0.7);
    this.finish(it, g, this.G.pDesk);
  }
  private rackGeos() {
    const L = new LB(); L.box(0, 1, 0, 0.74, 2, 0.66);
    L.seg(-0.37, 2, -0.33, 0.37, 2, 0.33); L.seg(0.37, 2, -0.33, -0.37, 2, 0.33);
    const S = new LB();
    for (let i = 1; i < 8; i++) { const y = i * 0.25; S.seg(-0.3, y, 0.336, 0.3, y, 0.336); S.seg(0.372, y, -0.28, 0.372, y, 0.28); S.seg(-0.372, y, -0.28, -0.372, y, 0.28); }
    const fill = new THREE.BoxGeometry(0.74, 2, 0.66); fill.translate(0, 1, 0);
    const face = new THREE.PlaneGeometry(0.64, 1.86); face.translate(0, 1, 0.334);
    const led = new THREE.PlaneGeometry(0.1, 0.035);
    return { lines: L.geo(), slots: S.geo(), fill, face, led };
  }
  private rack(A: Area, it: Item, px: number, pz: number, G: ReturnType<OperationScene['rackGeos']>) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const edge = new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), 0.2);
    const lm = this.line(edge, 0.95), bm = this.body(A.color, 0.5);
    const sl = this.line(new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), 0.5), 0.9);
    const fg = this.glow(A.color, 0.25, null);
    const ledM = this.solid(STATUS_COL[it.status], 1), led2 = this.solid(new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), 0.4), 1);
    g.add(new THREE.Mesh(G.fill, bm), new THREE.Mesh(G.face, fg), new THREE.LineSegments(G.lines, lm), new THREE.LineSegments(G.slots, sl));
    for (let i = 0; i < 5; i++) {
      const l = new THREE.Mesh(G.led, i % 2 ? led2 : ledM); l.position.set(-0.22 + (i % 2) * 0.16, 0.38 + i * 0.34, 0.342); g.add(l);
    }
    it.mats = [lm, bm, sl, fg, ledM, led2];
    this.status(g, it, 2.4);
    this.finish(it, g, this.G.pRack);
  }
  private totemGeos() {
    const L = new LB(); L.box(0, 1.0, 0, 0.56, 1.8, 0.22);
    L.ring(0, 0.02, 0, 0.38, 6); L.ring(0, 0.1, 0, 0.3, 6); L.seg(0, 0.1, 0, 0, 0.1, 0);
    L.rectZ(0, 1.2, 0.115, 0.42, 0.8);
    const scr = new THREE.PlaneGeometry(0.42, 0.8); scr.translate(0, 1.2, 0.12);
    const strip = new THREE.PlaneGeometry(0.3, 0.04); strip.translate(0, 1.78, 0.12);
    const parts = [new THREE.BoxGeometry(0.56, 1.8, 0.22).translate(0, 1.0, 0), new THREE.CylinderGeometry(0.3, 0.38, 0.1, 6).translate(0, 0.05, 0)];
    const fill = mergeGeometries(parts)!; parts.forEach((g) => g.dispose());
    return { lines: L.geo(), screen: scr, strip, fill };
  }
  private totem(A: Area, it: Item, px: number, pz: number, G: ReturnType<OperationScene['totemGeos']>) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const off = it.status === 'crit';
    const lm = this.line(off ? STATUS_COL.crit : A.color, 0.9);
    const sm = this.glow(A.color, off ? 0.05 : 0.4, null);
    const st = this.solid(STATUS_COL[it.status], 1), bm = this.body(A.color, 0.5);
    const face = this.solid(new THREE.Color(A.color).lerp(new THREE.Color('#ffffff'), 0.4), off ? 0.08 : 0.85);
    const scrFace = new THREE.Mesh(G.screen, face); scrFace.position.z = 0.002;
    g.add(new THREE.Mesh(G.fill, bm), new THREE.LineSegments(G.lines, lm), new THREE.Mesh(G.screen, sm), scrFace, new THREE.Mesh(G.strip, st));
    it.mats = [lm, sm, st, bm, face];
    this.status(g, it, 2.3);
    this.finish(it, g, this.G.pTotem);
  }
  private buildHub(A: Area, it: Item) {
    const g = new THREE.Group(); g.position.y = A.top; A.g.add(g);
    const col = new THREE.Color(A.color), light = col.clone().lerp(new THREE.Color('#ffffff'), 0.45);
    // pedestal
    const P = new LB(); P.prism(0, 0, 0.85, 0.55, 0, 0.75, 6); P.ring(0, 0.02, 0, 1.3, 6); P.ring(0, 0.02, 0, 1.6, 48);
    const pm = this.line(A.color, 0.9);
    const ped = new THREE.LineSegments(P.geo(), pm);
    // globo de latitude/longitude
    const R = 1.35, S = new LB();
    for (const lat of [-60, -30, 0, 30, 60]) { const a = (lat * Math.PI) / 180; S.ring(0, Math.sin(a) * R, 0, Math.cos(a) * R, 48); }
    for (let m = 0; m < 12; m++) {
      const lon = (m / 12) * Math.PI * 2, p: number[][] = [];
      for (let k = 0; k <= 24; k++) { const a = -Math.PI / 2 + (k / 24) * Math.PI; p.push([Math.cos(a) * R * Math.cos(lon), Math.sin(a) * R, Math.cos(a) * R * Math.sin(lon)]); }
      S.poly(p, false);
    }
    const gm = this.line(A.color, 0.9);
    const globe = new THREE.LineSegments(S.geo(), gm); globe.position.y = 2.15;
    const cm = this.line(light, 1);
    const core = new THREE.LineSegments(new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.45, 1)), cm); core.position.y = 2.15;
    const glowM = this.sprite(A.color, 0.55), coreGM = this.sprite(light, 0.8);
    const glowS = new THREE.Sprite(glowM); glowS.scale.setScalar(6); glowS.position.y = 2.15;
    const coreS = new THREE.Sprite(coreGM); coreS.scale.setScalar(1.8); coreS.position.y = 2.15;
    const rm = this.line(light, 0.7);
    const r1 = new THREE.LineSegments(new LB().ring(0, 0, 0, 1.85, 96, 'xy').geo(), rm); r1.position.y = 2.15; r1.rotation.x = Math.PI / 2 - 0.25;
    const r2 = new THREE.LineSegments(new LB().ring(0, 0, 0, 2.15, 96, 'xy').geo(), rm); r2.position.y = 2.15; r2.rotation.set(Math.PI / 2 + 0.5, 0.5, 0);
    g.add(ped, globe, core, glowS, coreS, r1, r2);
    it.mats = [pm, gm, cm, glowM, coreGM, rm]; it.anim = { core, r1, r2, globe };
    this.hub = it;
    this.finish(it, g, this.G.pHub);
  }
  private layoutItems(A: Area) {
    const list = A.items;
    if (A.kind === 'hub') { const h = list[0]; if (h) this.buildHub(A, h); }
    else if (A.kind === 'desks') {
      const G = this.deskGeos();
      const cols = list.length > 6 ? 4 : 3, rows = Math.max(1, Math.ceil(list.length / cols));
      const sx = cols === 4 ? 1.95 : 2.5, sz = 2.6;
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.desk(A, it, (c - (cols - 1) / 2) * sx, (r - (rows - 1) / 2) * sz - 0.45, G); });
    } else if (A.kind === 'totems') {
      const G = this.totemGeos();
      const rows = Math.max(1, Math.ceil(list.length / 5));
      list.forEach((it, i) => { const c = i % 5, r = Math.floor(i / 5); this.totem(A, it, (c - 2) * 2.2, (r - (rows - 1) / 2) * 2.0, G); });
    } else {
      const G = this.rackGeos();
      const cols = Math.max(5, Math.ceil(Math.sqrt(list.length * 1.3))), rows = Math.max(1, Math.ceil(list.length / cols));
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.rack(A, it, (c - (cols - 1) / 2) * 1.5, (r - (rows - 1) / 2) * 1.95, G); });
    }
    this.refreshLabel(A);
  }

  // ------------------------------------------------------------------ portais, ligacoes e particulas
  private buildPortals() {
    for (const p of this.portals) {
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); this.scene.add(g);
      const light = new THREE.Color(p.color).lerp(new THREE.Color('#ffffff'), 0.35);
      const tm = this.solid(p.color, 1);
      const torus = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.06, 10, 96), tm); torus.rotation.x = Math.PI / 2; torus.position.y = 0.35;
      const t2 = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.025, 8, 96), tm); t2.rotation.x = Math.PI / 2; t2.position.y = 0.55;
      const im = this.line(light, 0.85);
      const inner = new THREE.LineSegments(new LB().ring(0, 0, 0, 0.95, 64, 'xy').geo(), im); inner.position.y = 1.25;
      const hm = this.line(p.color, 0.4);
      const hex = new THREE.LineSegments(new LB().poly(hexPts(2.2, 2.2 * 0.866).map(([x, z]) => [x, 0.012, z])).geo(), hm);
      const gm = this.glow(p.color, 0.7);
      const gl = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 5.5).rotateX(-Math.PI / 2), gm); gl.position.y = 0.01;
      const sm = this.sprite(p.color, 0.45);
      const s = new THREE.Sprite(sm); s.scale.setScalar(3.6); s.position.y = 0.6;
      g.add(torus, t2, inner, hex, gl, s);
      this.beam(g, 0, 0.01, 0, 6, light, 0.45);
      p.g = g; p.inner = inner;
      const el = document.createElement('span'); el.className = 'lbl portal'; el.style.setProperty('--c', p.color); el.textContent = p.name;
      p.labelPos = new THREE.Vector3(p.x, 3.4, p.z);
      this.labelsEl.appendChild(el); this.labels.push({ el, pos: p.labelPos });
    }
  }
  /** linhas neon no chao: hub -> cada ilha e portais -> hub */
  private buildLinks() {
    const g = new THREE.Group(); this.scene.add(g); this.links = g; this.linkPaths = [];
    const hubA = this.areas.find((a) => a.kind === 'hub');
    const hx = hubA?.x ?? 0, hz = hubA?.z ?? 0, hr = hubA ? hubA.hz + 0.3 : 0.5;
    const edge = (A: { hx: number; hz: number }, dx: number, dz: number) => 1 / Math.hypot(dx / (A.hx * 1.02), dz / (A.hz * 1.02));
    const seg = (x1: number, z1: number, x2: number, z2: number, color: string, base: number) => {
      const L = new LB(); L.seg(x1, 0.03, z1, x2, 0.03, z2);
      // tracinhos paralelos dao corpo a linha
      const nx = -(z2 - z1), nz = x2 - x1, nl = Math.hypot(nx, nz) || 1, o = 0.09;
      L.seg(x1 + (nx / nl) * o, 0.025, z1 + (nz / nl) * o, x2 + (nx / nl) * o, 0.025, z2 + (nz / nl) * o);
      L.seg(x1 - (nx / nl) * o, 0.025, z1 - (nz / nl) * o, x2 - (nx / nl) * o, 0.025, z2 - (nz / nl) * o);
      const m = this.line(color, base); g.add(new THREE.LineSegments(L.geo(), m));
      const path = new THREE.LineCurve3(new THREE.Vector3(x1, 0.12, z1), new THREE.Vector3(x2, 0.12, z2)).getSpacedPoints(40);
      this.linkPaths.push({ path, col: new THREE.Color(color) });
      return m;
    };
    for (const A of this.areas) {
      if (A.kind === 'hub') continue;
      const dx = A.x - hx, dz = A.z - hz, l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
      const e = edge(A, ux, uz);
      if (l - e - hr < 0.5) continue;
      A.mats.push(seg(hx + ux * hr, hz + uz * hr, A.x - ux * e, A.z - uz * e, A.color, 0.55));
    }
    for (const p of this.portals) {
      const dx = hx - p.x, dz = hz - p.z, l = Math.hypot(dx, dz) || 1, ux = dx / l, uz = dz / l;
      seg(p.x + ux * 2.2, p.z + uz * 2.2, hx - ux * hr, hz - uz * hr, p.color, 0.3);
    }
  }
  private buildPaths() {
    this.paths.clear(); this.parts = [];
    this.portals.forEach((p, pi) => this.areas.filter((a) => a.kind === 'desks').forEach((a) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(p.x, 1.25, p.z), new THREE.Vector3(p.x * 0.55, 4.8, p.z * 0.5),
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
    if (this.flowOn && (this.paths.size || this.linkPaths.length)) {
      this.ambientAcc += dt;
      if (this.ambientAcc > this.ambientEvery) {
        this.ambientAcc = 0;
        if (this.linkPaths.length && (!this.paths.size || Math.random() < 0.55)) {
          const l = this.linkPaths[Math.floor(Math.random() * this.linkPaths.length)];
          this.parts.push({ path: l.path, t: 0, speed: 0.35 + Math.random() * 0.15, col: l.col.clone().multiplyScalar(0.9) });
        } else {
          const keys = [...this.paths.keys()];
          const k = keys[Math.floor(Math.random() * keys.length)];
          this.parts.push({ path: this.paths.get(k)!, t: 0, speed: 0.16 + Math.random() * 0.05, col: new THREE.Color(this.portals[+k[0]].color).multiplyScalar(0.7) });
        }
      }
    }
    let n = 0;
    for (let i = this.parts.length - 1; i >= 0; i--) { this.parts[i].t += this.parts[i].speed * dt; if (this.parts[i].t >= 1) this.parts.splice(i, 1); }
    for (const p of this.parts) {
      if (p.t < 0 || n >= 360) continue;
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
    const dark = isDark(); this.dark = dark;
    const bg = new THREE.Color(css('--scene-bg') || css('--bg') || (dark ? '#05070D' : '#E6E8EC'));
    this.scene.background = bg; this.scene.fog = new THREE.Fog(bg, 70 * this.K, 170 * this.K);
    this.floorMat.color.set(css('--floor') || (dark ? '#070A12' : '#DCE0E5'));
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); (this.grid.material as THREE.Material).dispose(); }
    const gc = css('--grid') || (dark ? '#141A2A' : '#C6CCD4');
    this.grid = new THREE.GridHelper(200, 100, gc, gc);
    const gm = this.grid.material as THREE.Material; gm.transparent = true; gm.opacity = dark ? 0.4 : 0.55; gm.depthWrite = false;
    this.grid.position.y = 0.002; this.scene.add(this.grid);
    // tema claro: mesmas linhas neon, preenchimento um pouco mais forte e brilho bem mais fraco (sem bloom)
    this.TK = dark ? { line: 1, fill: 0.75, glow: 0.45, body: 0.8 } : { line: 1, fill: 1.6, glow: 0.4, body: 1.1 };
    for (const m of this.mats) {
      if (m.userData.kind === 'glow') { const b = dark ? THREE.AdditiveBlending : THREE.NormalBlending; if (m.blending !== b) { m.blending = b; m.needsUpdate = true; } }
      this.refresh(m);
    }
    this.bloomOn = dark && !this.bloomOff;
    this.pMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending; this.pMat.needsUpdate = true;
    this.pMat.size = dark ? 0.42 : 0.5;
  }
  setFilter(f: Partial<typeof this.filter>) { Object.assign(this.filter, f); this.applyFilter(); }
  private norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  private setDim(it: Item, dim: boolean) {
    if (it.dim === dim) return; it.dim = dim;
    for (const m of it.mats) { m.userData.dimF = dim ? 0.12 : 1; this.refresh(m); }
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
        for (const m of A.mats) { m.userData.dimF = faded ? 0.3 : 1; this.refresh(m); }
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
    if (this.hoverIt?.group) { this.hoverIt.group.scale.setScalar(1); for (const m of this.hoverIt.mats) this.refresh(m); }
    this.hoverIt = it;
    if (it?.group && it !== this.hub) { it.group.scale.setScalar(1.08); for (const m of it.mats) m.opacity = Math.min(1, this.val(m) * 1.5); }
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
    this.renderer.setSize(this.W, this.H, false);
    this.composer.setPixelRatio(this.pr); this.composer.setSize(Math.max(1, this.W), Math.max(1, this.H));
    this.camera.aspect = this.W / Math.max(1, this.H); this.camera.updateProjectionMatrix();
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
      if (h) {
        h.r1.rotation.z += dt * 0.45; h.r2.rotation.z -= dt * 0.3; h.globe.rotation.y += dt * 0.25;
        h.core.rotation.y += dt * 0.6; h.core.scale.setScalar(1 + Math.sin(this.time * 1.6) * 0.06);
      }
      for (const s of this.spinners) s.rotation.y += dt * 1.4;
      for (const hd of this.heads) hd.m.position.y = hd.base + Math.sin(this.time * 2 + hd.ph) * 0.02;
      for (const p of this.pulses) {
        const k = (Math.sin(this.time * Math.PI) + 1) / 2, v = this.val(p.mat);
        if (p.kind === 'ring') { p.m.scale.setScalar(1 + k * 0.6); p.mat.opacity = v * (1 - k * 0.6); }
        else { p.m.scale.setScalar(0.9 + k * 0.25); p.mat.opacity = v * (0.5 + k * 0.5); }
      }
      for (const p of this.portals) if (p.inner) p.inner.rotation.y += dt * 0.8;
      this.updateParticles(dt);
    } else if (this.flowOn) this.updateParticles(dt * 0.4);
    if (this.bloomOn) this.composer.render(dt); else this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.frames++; this.acc += dt;
    if (this.acc > 2) {
      const fps = this.frames / this.acc;
      if (fps < 40) {
        // degrada aos poucos: resolucao, depois sem bloom (fica so o brilho dos sprites), depois menos particulas
        this.lowSteps++;
        if (this.lowSteps === 1 && this.pr > 1) { this.pr = 1; this.renderer.setPixelRatio(1); this.resize(); }
        else if (this.lowSteps === 2) { this.bloomOff = true; this.bloomOn = false; }
        else if (this.lowSteps === 3) { this.ambientEvery = 2; }
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
    Object.values(this.G).forEach((g) => g.dispose()); this.proxyMat.dispose();
    this.mats.clear();
    this.RT.dispose(); this.BEAM.dispose();
    this.renderPass.dispose(); this.bloom.dispose(); this.outPass.dispose(); this.composer.dispose();
    this.renderer.dispose();
  }
}
