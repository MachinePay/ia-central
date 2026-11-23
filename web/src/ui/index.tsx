import { AlertTriangle, Check, CircleAlert, Pause, RotateCw, X } from 'lucide-react';
import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AGENTS, type AgentKey } from '../lib/format';

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');
export { cx };

// ------------------------------------------------------------------ botao
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'subtle'; size?: 'sm' | 'md'; icon?: ReactNode; busy?: boolean };
export function Button({ variant = 'subtle', size = 'md', icon, busy, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || busy}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-[6px] font-semibold transition-colors duration-150 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-9 px-3.5 text-[14px]',
        variant === 'primary' && 'bg-amber text-[var(--on-amber)] hover:brightness-110',
        variant === 'subtle' && 'bg-line/60 text-text hover:bg-line',
        variant === 'ghost' && 'text-text-2 hover:text-text hover:bg-line/50',
        variant === 'danger' && 'bg-crit/15 text-crit hover:bg-crit/25',
        className,
      )}
    >
      {busy ? <RotateCw size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ estados com cor + icone + texto
const STATUS: Record<string, { color: string; icon: ReactNode; label: string }> = {
  OK: { color: 'text-ok', icon: <Check size={14} />, label: 'Ok' },
  WARN: { color: 'text-warn', icon: <AlertTriangle size={14} />, label: 'Aviso' },
  WARNING: { color: 'text-warn', icon: <AlertTriangle size={14} />, label: 'Aviso' },
  FAIL: { color: 'text-crit', icon: <CircleAlert size={14} />, label: 'Falha' },
  CRITICAL: { color: 'text-crit', icon: <CircleAlert size={14} className="pulse-crit" />, label: 'Crítico' },
  INFO: { color: 'text-cyan', icon: <Check size={14} />, label: 'Info' },
  SUSPENDED: { color: 'text-idle', icon: <Pause size={14} />, label: 'Suspenso' },
  UNKNOWN: { color: 'text-idle', icon: <Pause size={14} />, label: 'Sem dados' },
  DEPLOYING: { color: 'text-cyan', icon: <RotateCw size={14} className="animate-spin" />, label: 'Publicando' },
  OPEN: { color: 'text-crit', icon: <CircleAlert size={14} />, label: 'Aberto' },
  ACKNOWLEDGED: { color: 'text-warn', icon: <AlertTriangle size={14} />, label: 'Reconhecido' },
  RESOLVED: { color: 'text-ok', icon: <Check size={14} />, label: 'Resolvido' },
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? STATUS.UNKNOWN;
  return <span className={cx('inline-flex items-center gap-1 text-[12px] font-semibold', s.color)}>{s.icon}{label ?? s.label}</span>;
}

export function Pill({ children, tone = 'default', title }: { children: ReactNode; tone?: 'default' | 'amber' | 'cyan' | 'crit' | 'ok' | 'coral'; title?: string }) {
  return (
    <span title={title} className={cx(
      'inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold leading-none',
      tone === 'default' && 'bg-line/70 text-text-2',
      tone === 'amber' && 'bg-amber/15 text-amber',
      tone === 'cyan' && 'bg-cyan/15 text-cyan',
      tone === 'crit' && 'bg-crit/15 text-crit',
      tone === 'ok' && 'bg-ok/15 text-ok',
      tone === 'coral' && 'bg-coral/15 text-coral',
    )}>{children}</span>
  );
}

export function AgentAvatar({ agent, size = 24 }: { agent: string | null | undefined; size?: number }) {
  const a = AGENTS[(agent ?? 'LEO') as AgentKey] ?? AGENTS.LEO;
  return (
    <span title={`${a.name} · ${a.role}`} className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{ width: size, height: size, fontSize: size * 0.45, background: `${a.color}22`, color: a.color, border: `1px solid ${a.color}55` }}>
      {a.name[0]}
    </span>
  );
}

// ------------------------------------------------------------------ vazio, erro, carregando
export function EmptyState({ title, text, action }: { title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <p className="text-[16px] font-semibold">{title}</p>
      {text && <p className="max-w-[48ch] text-text-2">{text}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div role="alert" className="m-4 flex items-start gap-3 rounded-[10px] border border-crit/40 bg-crit/10 p-4">
      <CircleAlert size={18} className="mt-0.5 shrink-0 text-crit" />
      <div className="flex-1">
        <p className="font-semibold">Não foi possível carregar.</p>
        <p className="text-text-2">{(error as Error)?.message ?? 'Erro desconhecido.'}</p>
      </div>
      {retry && <Button size="sm" onClick={retry} icon={<RotateCw size={14} />}>Tentar de novo</Button>}
    </div>
  );
}
export function Skeleton({ lines = 6 }: { lines?: number }) {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-full bg-line/50" />
          <div className="flex-1 space-y-1.5"><div className="h-3 w-1/3 rounded bg-line/60" /><div className="h-3 w-2/3 rounded bg-line/40" /></div>
        </div>
      ))}
    </div>
  );
}
/** Barra fina no topo enquanto atualiza dados que ja estao na tela. */
export function RefreshBar({ active }: { active: boolean }) {
  return <div className={cx('h-[2px] w-full transition-opacity', active ? 'bg-cyan/70 opacity-100' : 'opacity-0')} />;
}

// ------------------------------------------------------------------ cabecalho da pagina e painel lateral
export function PageHeader({ title, accent, children, tabs }: { title: string; accent: string; children?: ReactNode; tabs?: ReactNode }) {
  return (
    <header className="glass m-2 mb-0" style={{ boxShadow: `inset 0 2px 0 ${accent}` }}>
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4 pb-3">
        <h1 className="text-[23px] font-semibold leading-tight">{title}</h1>
        <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div>
      </div>
      {tabs && <div className="flex gap-1 overflow-x-auto px-4">{tabs}</div>}
    </header>
  );
}
export function Tab({ active, onClick, children, count }: { active: boolean; onClick: () => void; children: ReactNode; count?: number }) {
  return (
    <button onClick={onClick} className={cx('relative -mb-px cursor-pointer border-b-2 px-3 py-2 text-[13px] font-semibold whitespace-nowrap', active ? 'border-amber text-text' : 'border-transparent text-text-2 hover:text-text')}>
      {children}{count ? <span className="ml-1.5 tabular text-amber">{count}</span> : null}
    </button>
  );
}

export function SidePanel({ title, onClose, children, actions }: { title: ReactNode; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest('input,textarea')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <aside className="glass m-2 flex min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1 truncate font-semibold">{title}</div>
        {actions}
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Fechar (Esc)"><X size={16} /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

export function Section({ title, children, right }: { title: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-3">
      <div className="mb-2 flex items-center gap-2"><h3 className="text-[12px] font-semibold text-text-2">{title}</h3><div className="ml-auto">{right}</div></div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('glass', className)}>{children}</div>;
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: string }) {
  return (
    <Card className="p-4">
      <p className="text-[12px] text-text-2">{label}</p>
      <p className="tabular mt-1 text-[28px] font-semibold leading-none" style={tone ? { color: tone } : undefined}>{value}</p>
      {hint && <p className="mt-1.5 text-[12px] text-text-2">{hint}</p>}
    </Card>
  );
}

// ------------------------------------------------------------------ campos
export const inputCls = 'h-9 w-full rounded-[6px] border border-line bg-bg px-2.5 text-[14px] text-text placeholder:text-text-2/70 focus:border-cyan focus:outline-none';
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[12px] font-semibold text-text-2">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-text-2">{hint}</span>}
    </label>
  );
}

export function Chip({ label, onRemove, onClick, active }: { label: ReactNode; onRemove?: () => void; onClick?: () => void; active?: boolean }) {
  return (
    <span className={cx('inline-flex h-7 items-center gap-1 rounded-[6px] border px-2 text-[12px] font-semibold', active ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-line text-text-2')}>
      <button onClick={onClick} className="cursor-pointer">{label}</button>
      {onRemove && <button onClick={onRemove} aria-label="Remover filtro" className="cursor-pointer opacity-70 hover:opacity-100"><X size={12} /></button>}
    </span>
  );
}

export function Toast({ text, tone = 'ok' }: { text: string; tone?: 'ok' | 'crit' }) {
  return (
    <div role="status" className={cx('fixed right-4 bottom-4 z-50 rounded-[10px] border px-4 py-3 shadow-lg', tone === 'ok' ? 'border-ok/40 bg-surface' : 'border-crit/40 bg-surface')}>
      {text}
    </div>
  );
}
