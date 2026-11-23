import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import {
  Bot, CheckCheck, Cpu, Gauge, Home, LogOut, MessagesSquare, Moon, PanelLeftClose, PanelLeftOpen, Search, Settings, ShieldCheck, Sun, Wallet,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, setToken } from '../lib/api';
import { useToasts } from '../lib/toast';
import { cx } from '../ui';
import { CommandPalette } from './palette';

export const AREAS = [
  { to: '/', label: 'Início', icon: Home, color: 'var(--amber)', key: 'home' },
  { to: '/conversas', label: 'Conversas', icon: MessagesSquare, color: 'var(--cyan)', key: 'conv' },
  { to: '/aprovacoes', label: 'Aprovações', icon: CheckCheck, color: 'var(--amber)', key: 'appr' },
  { to: '/agentes', label: 'Agentes', icon: Bot, color: 'var(--text-2)', key: 'agents' },
  { to: '/sentinela', label: 'Sentinela', icon: ShieldCheck, color: 'var(--ok)', key: 'sent' },
  { to: '/custos', label: 'Custos', icon: Wallet, color: 'var(--lilac)', key: 'cost' },
  { to: '/totens', label: 'Totens', icon: Cpu, color: 'var(--coral)', key: 'totem' },
] as const;

export function useSummary() {
  return useQuery({ queryKey: ['summary'], queryFn: () => api('/api/summary'), staleTime: 30_000, refetchInterval: 60_000 });
}

function useTheme(): [string, () => void] {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('cc.theme') ?? 'dark'; } catch { return 'dark'; } });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('cc.theme', theme); } catch { /* ok */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export function Shell() {
  const summary = useSummary();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('cc.nav') === 'min'; } catch { return false; } });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const toasts = useToasts();
  const s = summary.data;
  const counts: Record<string, number> = {
    home: (s?.needsYou.approvals.length ?? 0) + (s?.needsYou.incidents.filter((i: any) => i.severity === 'CRITICAL').length ?? 0),
    conv: (s?.needsYou.unanswered.length ?? 0) + (s?.needsYou.takeovers ?? 0),
    appr: s?.needsYou.approvals.length ?? 0,
    sent: s?.needsYou.incidents.length ?? 0,
  };

  useEffect(() => {
    try { localStorage.setItem('cc.nav', collapsed ? 'min' : 'full'); } catch { /* ok */ }
  }, [collapsed]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  // contador no titulo da aba
  useEffect(() => {
    const n = counts.home;
    document.title = n ? `(${n}) Centro de Comando` : 'Centro de Comando';
  }, [counts.home]);

  return (
    <div className="flex h-full">
      <nav aria-label="Áreas" className={cx('flex shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-200', collapsed ? 'w-16' : 'w-[232px]')}>
        <div className="flex h-14 items-center gap-2 px-4">
          <Gauge size={20} className="shrink-0 text-amber" />
          {!collapsed && <span className="font-semibold">Centro de Comando</span>}
        </div>
        <button onClick={() => setPaletteOpen(true)} className={cx('mx-3 mb-3 flex h-8 cursor-pointer items-center gap-2 rounded-[6px] border border-line px-2 text-text-2 hover:text-text', collapsed && 'justify-center')}>
          <Search size={14} />{!collapsed && <><span className="text-[13px]">Buscar</span><kbd className="ml-auto text-[11px]">Ctrl K</kbd></>}
        </button>
        <ul className="flex-1 space-y-0.5 px-2">
          {AREAS.map((a) => {
            const active = a.to === '/' ? path === '/' : path.startsWith(a.to);
            const n = counts[a.key] ?? 0;
            return (
              <li key={a.to}>
                <Link to={a.to} preload="intent" title={a.label}
                  className={cx('relative flex h-9 items-center gap-3 rounded-[6px] px-2.5 text-[14px]', active ? 'bg-line text-text' : 'text-text-2 hover:bg-line/50 hover:text-text')}>
                  <a.icon size={18} style={{ color: active ? a.color : undefined }} className="shrink-0" />
                  {!collapsed && <span className="flex-1">{a.label}</span>}
                  {n > 0 && <span className={cx('tabular rounded-full bg-amber px-1.5 text-[11px] font-semibold leading-[18px] text-[var(--on-amber)]', collapsed && 'absolute top-0.5 right-0.5')}>{n}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="space-y-0.5 border-t border-line p-2">
          <NavButton collapsed={collapsed} to="/configuracoes" icon={<Settings size={18} />} label="Configurações" active={path.startsWith('/configuracoes')} />
          <NavAction collapsed={collapsed} onClick={toggleTheme} icon={theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />} label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'} />
          <NavAction collapsed={collapsed} onClick={() => { setToken(null); location.reload(); }} icon={<LogOut size={18} />} label="Sair" />
          <NavAction collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} icon={collapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />} label="Recolher menu" />
        </div>
      </nav>
      <main className="min-w-0 flex-1 overflow-hidden"><Outlet /></main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} toggleTheme={toggleTheme} />
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx('rounded-[10px] border bg-surface px-4 py-3 shadow-lg', t.tone === 'ok' ? 'border-ok/50' : 'border-crit/50')}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

function NavButton({ collapsed, to, icon, label, active }: { collapsed: boolean; to: string; icon: ReactNode; label: string; active: boolean }) {
  return (
    <Link to={to} title={label} className={cx('flex h-9 items-center gap-3 rounded-[6px] px-2.5', active ? 'bg-line text-text' : 'text-text-2 hover:bg-line/50 hover:text-text')}>
      {icon}{!collapsed && label}
    </Link>
  );
}
function NavAction({ collapsed, onClick, icon, label }: { collapsed: boolean; onClick: () => void; icon: ReactNode; label: string }) {
  return (
    <button onClick={onClick} title={label} className="flex h-9 w-full cursor-pointer items-center gap-3 rounded-[6px] px-2.5 text-text-2 hover:bg-line/50 hover:text-text">
      {icon}{!collapsed && label}
    </button>
  );
}
