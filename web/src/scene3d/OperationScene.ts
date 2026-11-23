import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Maquete 3D da operacao (portada do prototipo "Centro de Comando 3D").
 * Centro: IA central (orquestrador). Em volta: uma ilha por numero/pessoa e a ilha do Sentinela.
 * A cena e imperativa (Three.js); a interface em volta (busca, doca, painel) e React.
 */

export type Status = 'ok' | 'warn' | 'crit';
export type SceneArea = { id: string; kind: 'hub' | 'desks' | 'racks'; name: string; who: string; state?: string; color?: string };
export type SceneItem = { id: string; area: string; name: string; sub: string; status: Status; extra: Record<string, string>; link?: string };

type Callbacks = {
  onArea: (id: string) => void;
  onItem: (item: SceneItem) => void;
};

export const STATUS_COL: Record<Status, string> = { ok: '#43B884', warn: '#F2B33D', crit: '#EF5A5A' };
const PALETTE = ['#A796E8', '#F2B33D', '#43B884', '#F08A6C', '#E8857A', '#9FD36B', '#5CC8D7'];
export const areaColor = (a: SceneArea, i: number) => a.color ?? (a.id === 'central' ? '#5CC8D7' : a.id === 'sentinela' ? '#6CB4E4' : PALETTE[i % PALETTE.length]);

const css = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = () => document.documentElement.dataset.theme !== 'light' &&
  (document.documentElement.dataset.theme === 'dark' || !matchMedia('(prefers-color-scheme: light)').matches);
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

type Item = SceneItem & { group?: THREE.Group; mats: THREE.Material[]; dim?: boolean; anim?: any };
type Area = SceneArea & {
  x: number; z: number; color: string; g: THREE.Group; slabMat: THREE.MeshStandardMaterial; rimMat: THREE.LineBasicMaterial;
  glowMat: THREE.MeshBasicMaterial; w: number; d: number; top: number; items: Item[]; label?: HTMLButtonElement; line?: THREE.Line;
};

function radialTex() {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!; const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}
function rr(w: number, d: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2;
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y); return s;
}
const std = (o: THREE.MeshStandardMaterialParameters) => new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.08, transparent: true, opacity: 1, ...o });
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export class OperationScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(38, 1, 0.1, 400);
  private controls: OrbitControls;
  private hemi = new THREE.HemisphereLight(0xffffff, 0x223b44, 2.4);
  private sun = new THREE.DirectionalLight(0xffffff, 2.2);
  private RT = radialTex();
  private grid1?: THREE.GridHelper; private grid2?: THREE.GridHelper;
  private floorGlowMat: THREE.MeshBasicMaterial;
  private dashMat = new THREE.LineDashedMaterial({ color: '#235566', dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.9 });
  private areas: Area[] = [];
  private items: Item[] = [];
  private pickables: THREE.Object3D[] = [];
  private pulses: Array<{ kind: 'ring' | 'beam'; m: THREE.Mesh; mat: THREE.MeshBasicMaterial; it: Item }> = [];
  private heads: Array<{ m: THREE.Mesh; base: number; ph: number }> = [];
  private spinners: THREE.Object3D[] = [];
  private roleMats: Record<'desk' | 'agent' | 'rack', THREE.MeshStandardMaterial[]> = { desk: [], agent: [], rack: [] };
  private portals: Array<{ id: string; name: string; color: string; x: number; z: number; ring?: THREE.Mesh }> = [
    { id: 'wa', name: 'WhatsApp', color: '#43B884', x: -26, z: -2 },
    { id: 'gm', name: 'Gmail', color: '#E8857A', x: 26, z: -2 },
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
  private HOME = { target: new THREE.Vector3(0, 0, 2), cam: new THREE.Vector3(30, 31, 38) };
  private running = true; private raf = 0; private last = performance.now(); private time = 0;
  private W = 0; private H = 0; private pr: number; private frames = 0; private acc = 0;
  private hoverIt: Item | null = null; private down = { x: 0, y: 0 }; private pendingMove: PointerEvent | null = null;
  private filter = { status: 'all' as 'all' | Status, q: '', area: null as string | null };
  private ro: ResizeObserver;
  private cleanup: Array<() => void> = [];

  constructor(private canvas: HTMLCanvasElement, private labelsEl: HTMLElement, private tip: HTMLElement, private cb: Callbacks) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    if (!this.renderer.getContext()) throw new Error('sem WebGL');
    this.pr = Math.min(window.devicePixelRatio || 1, 1.75);
    this.renderer.setPixelRatio(this.pr);
    this.camera.position.copy(this.HOME.cam);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.copy(this.HOME.target);
    this.controls.enableDamping = true; this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = 1.22; this.controls.minDistance = 7; this.controls.maxDistance = 95;
    this.controls.autoRotateSpeed = 0.3; this.controls.autoRotate = !reduce();
    this.controls.addEventListener('start', () => { this.tween = null; });
    this.sun.position.set(12, 24, 14);
    this.scene.add(this.hemi, this.sun);
    this.floorGlowMat = new THREE.MeshBasicMaterial({ map: this.RT, color: '#5CC8D7', transparent: true, opacity: 0.12, depthWrite: false });
    const floorGlow = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), this.floorGlowMat);
    floorGlow.rotation.x = -Math.PI / 2; floorGlow.position.set(0, 0.006, 2); this.scene.add(floorGlow);
    const MAXP = 320;
    this.pPos = new Float32Array(MAXP * 3); this.pCol = new Float32Array(MAXP * 3);
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    this.pMat = new THREE.PointsMaterial({ size: 0.6, map: this.RT, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
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
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(canvas.parentElement!);
    this.resize(); this.applyTheme();
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------------ dados
  setData(areasIn: SceneArea[], itemsIn: SceneItem[]) {
    // remove o que existia (ilhas e itens) e monta de novo: e barato e mantem a cena igual aos dados
    for (const a of this.areas) { this.scene.remove(a.g); if (a.line) this.scene.remove(a.line); a.label?.remove(); }
    this.labels = this.labels.filter((l) => !l.el.classList.contains('area'));
    this.areas = []; this.items = []; this.pickables = []; this.pulses = []; this.heads = []; this.spinners = [];
    this.roleMats = { desk: [], agent: [], rack: [] };
    const ring = areasIn.filter((a) => a.kind !== 'hub');
    ring.forEach((a, i) => { (a as any)._i = i; });
    const R = Math.max(13, 4.2 * ring.length);
    areasIn.forEach((a, idx) => {
      let x = 0, z = 0;
      if (a.kind !== 'hub') {
        const i = (a as any)._i as number;
        const ang = -Math.PI / 2 + (i / ring.length) * Math.PI * 2;
        x = Math.cos(ang) * R; z = Math.sin(ang) * R * 0.78 + 2;
      }
      this.buildArea({ ...a, x, z, color: areaColor(a, idx) } as Area);
    });
    for (const it of itemsIn) {
      const A = this.areas.find((a) => a.id === it.area); if (!A) continue;
      A.items.push({ ...it, mats: [] });
    }
    for (const A of this.areas) this.layoutItems(A);
    this.items = this.areas.flatMap((a) => a.items);
    this.buildPaths();
    this.applyTheme();
    this.applyFilter();
  }

  private buildArea(a: Area) {
    const g = new THREE.Group(); g.position.set(a.x, 0, a.z); this.scene.add(g);
    let geo: THREE.BufferGeometry, w: number, d: number;
    if (a.kind === 'hub') { geo = new THREE.CylinderGeometry(4.6, 4.6, 0.5, 6); geo.translate(0, 0.25, 0); w = d = 9.2; }
    else {
      [w, d] = a.kind === 'racks' ? [9.2, 6.4] : [8.8, 7.2];
      geo = new THREE.ExtrudeGeometry(rr(w, d, 0.55), { depth: 0.4, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, curveSegments: 8 });
      geo.rotateX(-Math.PI / 2); geo.translate(0, 0.05, 0);
    }
    const slabMat = std({ color: '#16394A', roughness: 0.92 });
    const slab = new THREE.Mesh(geo, slabMat); slab.userData.area = a.id; g.add(slab); this.pickables.push(slab);
    const rimMat = new THREE.LineBasicMaterial({ color: a.state && a.state !== 'open' ? STATUS_COL.crit : a.color, transparent: true, opacity: 0.9 });
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), rimMat));
    const glowMat = new THREE.MeshBasicMaterial({ map: this.RT, color: a.color, transparent: true, opacity: 0.22, depthWrite: false });
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.9, d * 1.9), glowMat);
    glow.rotation.x = -Math.PI / 2; glow.position.y = 0.008; g.add(glow);
    if (a.kind !== 'hub') {
      const geoL = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(a.x, 0.03, a.z)]);
      a.line = new THREE.Line(geoL, this.dashMat); a.line.computeLineDistances(); this.scene.add(a.line);
    }
    Object.assign(a, { g, slabMat, rimMat, glowMat, w, d, top: 0.5, items: [] });
    this.areas.push(a);
    // rotulo
    const el = document.createElement('button');
    el.className = 'lbl area'; el.style.setProperty('--c', a.color);
    el.addEventListener('click', () => this.cb.onArea(a.id));
    this.labelsEl.appendChild(el); a.label = el;
    const y = a.kind === 'hub' ? 5.6 : 3.1;
    this.labels.push({ el, pos: new THREE.Vector3(a.x, y, a.kind === 'hub' ? a.z : a.z - d / 2 + 0.4) });
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

  private finish(it: Item, group: THREE.Group, meshes: THREE.Object3D[]) {
    it.group = group;
    meshes.forEach((m) => { m.userData.item = it; this.pickables.push(m); });
    it.mats.forEach((m) => { m.userData.base = m.opacity; });
  }
  private marker(g: THREE.Group, it: Item, y: number, z = 0) {
    const m = new THREE.MeshBasicMaterial({ color: STATUS_COL[it.status], transparent: true });
    const o = new THREE.Mesh(new THREE.OctahedronGeometry(0.15), m); o.position.set(0, y, z);
    g.add(o); it.mats.push(m); this.spinners.push(o);
    if (it.status === 'crit') {
      const rm = new THREE.MeshBasicMaterial({ color: STATUS_COL.crit, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false });
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.55, 0.68, 48), rm);
      ring.rotation.x = -Math.PI / 2; ring.position.set(0, 0.02, z); g.add(ring); it.mats.push(rm);
      this.pulses.push({ kind: 'ring', m: ring, mat: rm, it });
    }
    return [o];
  }
  private desk(A: Area, it: Item, px: number, pz: number) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const deskMat = std({ color: '#24505F' }); this.roleMats.desk.push(deskMat);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.08, 0.8), deskMat); top.position.y = 0.72;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.68, 0.06), deskMat); panel.position.set(0, 0.36, -0.3);
    const scr = it.status === 'ok' ? A.color : STATUS_COL[it.status];
    const scrMat = std({ color: '#0b1a1f', emissive: scr, emissiveIntensity: it.status === 'ok' ? 0.7 : 1.2 });
    const mon = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.5, 0.05), scrMat); mon.position.set(0, 1.06, -0.22);
    const bodyMat = std({ color: '#AFC3C4' }); this.roleMats.agent.push(bodyMat);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.35, 4, 10), bodyMat); body.position.set(0, 0.62, 0.68);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), bodyMat); head.position.set(0, 1.14, 0.68);
    this.heads.push({ m: head, base: 1.14, ph: Math.random() * 6.28 });
    g.add(top, panel, mon, body, head);
    it.mats = [deskMat, scrMat, bodyMat];
    const extra = it.status !== 'ok' ? this.marker(g, it, 1.62, 0.68) : [];
    this.finish(it, g, [top, panel, mon, body, head, ...extra]);
  }
  private rack(A: Area, it: Item, px: number, pz: number) {
    const g = new THREE.Group(); g.position.set(px, A.top, pz); A.g.add(g);
    const rackMat = std({ color: '#1C4452', metalness: 0.35, roughness: 0.5 }); this.roleMats.rack.push(rackMat);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.7, 0.62), rackMat); body.position.y = 0.85;
    const ledMat = new THREE.MeshBasicMaterial({ color: STATUS_COL[it.status], transparent: true });
    const leds: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) { const led = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 0.02), ledMat); led.position.set(0, 0.35 + i * 0.38, 0.32); g.add(led); leds.push(led); }
    g.add(body); it.mats = [rackMat, ledMat];
    const extra: THREE.Object3D[] = [];
    if (it.status === 'crit') {
      const bm = new THREE.MeshBasicMaterial({ color: STATUS_COL.crit, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 8, 24, 1, true), bm); beam.position.y = 5.7;
      g.add(beam); it.mats.push(bm); this.pulses.push({ kind: 'beam', m: beam, mat: bm, it });
    }
    if (it.status !== 'ok') extra.push(...this.marker(g, it, 2.1));
    this.finish(it, g, [body, ...leds, ...extra]);
  }
  private buildHub(A: Area, it: Item) {
    const g = new THREE.Group(); g.position.y = A.top; A.g.add(g);
    const pedMat = std({ color: '#24505F' }); this.roleMats.desk.push(pedMat);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.95, 1.1, 6), pedMat); ped.position.y = 0.55;
    const icoMat = new THREE.MeshBasicMaterial({ color: '#5CC8D7', wireframe: true, transparent: true, opacity: 0.8 });
    const ico = new THREE.Mesh(new THREE.IcosahedronGeometry(1.5, 1), icoMat); ico.position.y = 2.5;
    const coreMat = new THREE.MeshBasicMaterial({ color: '#43B884', transparent: true, opacity: 0.32 });
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.0, 24, 16), coreMat); core.position.y = 2.5;
    const ringMat = new THREE.MeshBasicMaterial({ color: '#F2B33D', transparent: true, opacity: 0.85 });
    const r1 = new THREE.Mesh(new THREE.TorusGeometry(2.25, 0.028, 8, 120), ringMat); r1.position.y = 2.5; r1.rotation.x = Math.PI / 2 - 0.25;
    const r2 = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.022, 8, 120), ringMat); r2.position.y = 2.5; r2.rotation.set(Math.PI / 2 + 0.45, 0.5, 0);
    g.add(ped, ico, core, r1, r2);
    it.mats = [pedMat, icoMat, coreMat, ringMat]; it.anim = { ico, r1, r2, core };
    this.hub = it;
    this.finish(it, g, [ped, ico, core]);
  }
  private layoutItems(A: Area) {
    const list = A.items;
    if (A.kind === 'hub') { const h = list[0]; if (h) this.buildHub(A, h); }
    else if (A.kind === 'desks') {
      const cols = list.length > 9 ? 4 : 3, rows = Math.max(1, Math.ceil(list.length / cols));
      const sx = cols === 4 ? 2.0 : 2.6, sz = rows > 3 ? 1.7 : 2.4;
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.desk(A, it, (c - (cols - 1) / 2) * sx, (r - (rows - 1) / 2) * sz - 0.2); });
    } else {
      const cols = 5, rows = Math.max(1, Math.ceil(list.length / cols));
      list.forEach((it, i) => { const c = i % cols, r = Math.floor(i / cols); this.rack(A, it, (c - 2) * 1.6, (r - (rows - 1) / 2) * 1.8); });
    }
    this.refreshLabel(A);
  }

  // ------------------------------------------------------------------ portais e particulas
  private buildPortals() {
    for (const p of this.portals) {
      const g = new THREE.Group(); g.position.set(p.x, 0, p.z); this.scene.add(g);
      const m = new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.9 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.07, 12, 80), m); ring.position.y = 2.3; ring.rotation.y = Math.PI / 2;
      const dm = new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false });
      const disc = new THREE.Mesh(new THREE.CircleGeometry(1.55, 48), dm); disc.position.y = 2.3; disc.rotation.y = Math.PI / 2;
      const pm = std({ color: '#24505F' }); this.roleMats.desk.push(pm);
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.7, 0.6, 6), pm); ped.position.y = 0.3;
      g.add(ring, disc, ped); p.ring = ring;
      const gm = new THREE.MeshBasicMaterial({ map: this.RT, color: p.color, transparent: true, opacity: 0.25, depthWrite: false });
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(7, 7), gm); glow.rotation.x = -Math.PI / 2; glow.position.y = 0.008; g.add(glow);
      const el = document.createElement('span'); el.className = 'lbl portal'; el.style.setProperty('--c', p.color); el.textContent = p.name;
      this.labelsEl.appendChild(el); this.labels.push({ el, pos: new THREE.Vector3(p.x, 4.6, p.z) });
    }
  }
  private buildPaths() {
    this.paths.clear(); this.parts = [];
    this.portals.forEach((p, pi) => this.areas.filter((a) => a.kind === 'desks').forEach((a) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(p.x, 2.3, p.z), new THREE.Vector3(p.x * 0.55, 4.6, p.z * 0.5),
        new THREE.Vector3(0, 2.5, 0), new THREE.Vector3(a.x * 0.5, 4.4, a.z * 0.5), new THREE.Vector3(a.x, 1.7, a.z),
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
    const bg = new THREE.Color(css('--scene-bg') || (dark ? '#0B2128' : '#E1EBEA'));
    this.scene.background = bg; this.scene.fog = new THREE.Fog(bg, 60, 150);
    if (this.grid1) this.scene.remove(this.grid1, this.grid2!);
    this.grid1 = new THREE.GridHelper(200, 100, css('--grid') || '#143540', css('--grid') || '#143540');
    this.grid2 = new THREE.GridHelper(200, 20, css('--grid-strong') || '#235566', css('--grid-strong') || '#235566');
    this.grid1.position.y = 0.002; this.grid2.position.y = 0.004; this.scene.add(this.grid1, this.grid2);
    this.dashMat.color.set(css('--grid-strong') || '#235566');
    const base = new THREE.Color(css('--slab-base') || '#16394A');
    for (const A of this.areas) {
      A.slabMat.color.copy(base).lerp(new THREE.Color(A.color), dark ? 0.14 : 0.1);
      A.glowMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending; A.glowMat.opacity = dark ? 0.22 : 0.16; A.glowMat.needsUpdate = true;
    }
    this.roleMats.desk.forEach((m) => m.color.set(css('--desk') || '#24505F'));
    this.roleMats.agent.forEach((m) => m.color.set(css('--agent') || '#AFC3C4'));
    this.roleMats.rack.forEach((m) => m.color.set(css('--rack') || '#1C4452'));
    this.pMat.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending; this.pMat.needsUpdate = true;
    this.floorGlowMat.opacity = dark ? 0.12 : 0.08;
    this.hemi.intensity = dark ? 2.4 : 3; this.hemi.groundColor.set(dark ? 0x223b44 : 0xb9cccd);
  }
  setFilter(f: Partial<typeof this.filter>) { Object.assign(this.filter, f); this.applyFilter(); }
  private norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  private applyFilter(): number {
    const q = this.norm(this.filter.q.trim());
    let n = 0;
    for (const it of this.items) {
      const ok = (this.filter.status === 'all' || it.status === this.filter.status) &&
        (!q || this.norm(`${it.name} ${it.sub} ${Object.values(it.extra).join(' ')}`).includes(q)) &&
        (!this.filter.area || it.area === this.filter.area);
      it.dim = !ok; it.mats.forEach((m) => { m.opacity = (m.userData.base ?? 1) * (ok ? 1 : 0.1); });
      if (ok) n++;
    }
    for (const A of this.areas) {
      const faded = (this.filter.area && this.filter.area !== A.id) || (A.items.length > 0 && !A.items.some((i) => !i.dim));
      A.slabMat.opacity = faded ? 0.35 : 1; A.rimMat.opacity = faded ? 0.25 : 0.9;
      A.label?.classList.toggle('dim', !!faded);
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
    this.flyTo(t, t.clone().add(A.kind === 'hub' ? new THREE.Vector3(8, 9, 11) : new THREE.Vector3(7.5, 9.5, 11)));
  }
  focusItem(id: string) {
    const it = this.items.find((i) => i.id === id); if (!it?.group) return;
    this.controls.autoRotate = false;
    const p = new THREE.Vector3(); it.group.getWorldPosition(p); p.y += 0.8;
    this.flyTo(p, p.clone().add(new THREE.Vector3(3.2, 4, 4.6)));
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
    this.hoverIt = it; if (it?.group && it !== this.hub) it.group.scale.setScalar(1.08);
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
      this.tween.t = Math.min(1, this.tween.t + dt / 0.85); const k = 1 - Math.pow(1 - this.tween.t, 3);
      this.controls.target.lerpVectors(this.tween.ft, this.tween.tt, k); this.camera.position.lerpVectors(this.tween.fc, this.tween.tc, k);
      if (this.tween.t >= 1) this.tween = null;
    }
    this.controls.update();
    if (!reduce()) {
      const h = this.hub?.anim;
      if (h) { h.ico.rotation.y += dt * 0.25; h.ico.rotation.x += dt * 0.08; h.r1.rotation.z += dt * 0.5; h.r2.rotation.z -= dt * 0.35; h.core.scale.setScalar(1 + Math.sin(this.time * 1.6) * 0.04); }
      for (const s of this.spinners) s.rotation.y += dt * 1.4;
      for (const hd of this.heads) hd.m.position.y = hd.base + Math.sin(this.time * 2.2 + hd.ph) * 0.025;
      for (const p of this.pulses) {
        const k = (Math.sin(this.time * Math.PI) + 1) / 2; const base = p.mat.userData.base ?? 0.6;
        if (p.kind === 'ring') { p.m.scale.setScalar(1 + k * 0.5); p.mat.opacity = base * (p.it.dim ? 0.1 : 1) * (1 - k * 0.6); }
        else p.mat.opacity = base * (p.it.dim ? 0.1 : 1) * (0.55 + k * 0.45);
      }
      for (const p of this.portals) if (p.ring) p.ring.rotation.x += dt * 0.6;
      this.updateParticles(dt);
    } else if (this.flowOn) this.updateParticles(dt * 0.4);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels();
    this.frames++; this.acc += dt;
    if (this.acc > 2) {
      const fps = this.frames / this.acc;
      if (fps < 40 && this.pr > 1) { this.pr = 1; this.renderer.setPixelRatio(1); this.resize(); }
      else if (fps < 30) this.ambientEvery = 2;
      this.frames = 0; this.acc = 0;
    }
    this.raf = requestAnimationFrame(this.loop);
  };

  dispose() {
    this.running = false; cancelAnimationFrame(this.raf);
    this.ro.disconnect(); this.cleanup.forEach((f) => f());
    this.controls.dispose(); this.renderer.dispose();
    this.labelsEl.innerHTML = '';
    this.scene.traverse((o: any) => { o.geometry?.dispose?.(); (Array.isArray(o.material) ? o.material : [o.material]).forEach((m: any) => m?.dispose?.()); });
  }
}
