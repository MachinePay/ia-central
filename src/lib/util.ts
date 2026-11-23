export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function todayIn(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function nowLabel(tz: string): string {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(new Date());
}

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];

/** "seg-sex 08:00-18:00" */
export function isBusinessHours(spec: string, tz: string, at = new Date()): boolean {
  const m = spec.match(/(\w{3})-(\w{3})\s+(\d{2}):(\d{2})-(\d{2}):(\d{2})/);
  if (!m) return true;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const t = (Number(get('hour')) % 24) * 60 + Number(get('minute'));
  const d0 = DIAS.indexOf(m[1]);
  const d1 = DIAS.indexOf(m[2]);
  const inDays = d0 <= d1 ? wd >= d0 && wd <= d1 : wd >= d0 || wd <= d1;
  return inDays && t >= +m[3] * 60 + +m[4] && t < +m[5] * 60 + +m[6];
}

/** Escapa conteudo externo antes de colocar entre tags no prompt. */
export function fence(tag: string, text: string): string {
  const safe = String(text ?? '').replace(new RegExp(`</?${tag}>`, 'gi'), '');
  return `<${tag}>${safe}</${tag}>`;
}
