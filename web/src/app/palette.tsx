import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { incidentCode } from '../lib/format';
import { AREAS } from './shell';

/** Ctrl/⌘ K: vai para qualquer tela, conversa, contato, incidente ou acao. */
export function CommandPalette({ open, onClose, toggleTheme }: { open: boolean; onClose: () => void; toggleTheme: () => void }) {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const navigate = useNavigate();
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 180); return () => clearTimeout(t); }, [q]);
  useEffect(() => { if (!open) setQ(''); }, [open]);
  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api(`/api/search?q=${encodeURIComponent(debounced)}`),
    enabled: open && debounced.trim().length >= 2 && !debounced.startsWith('>'),
    staleTime: 30_000,
  });
  if (!open) return null;
  const go = (to: string, search?: Record<string, unknown>) => { onClose(); void navigate({ to, search: search as any }); };
  const r = search.data;
  const item = 'flex cursor-pointer items-center gap-2 rounded-[6px] px-3 py-2 text-[14px] data-[selected=true]:bg-line';
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/40 pt-[12vh]" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-[min(640px,92vw)] overflow-hidden rounded-[10px] border border-line bg-surface shadow-2xl">
        <Command label="Paleta de comandos" shouldFilter={!r}>
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder="Buscar contato, conversa, incidente… ou > para ações"
            className="h-12 w-full border-b border-line bg-transparent px-4 text-[16px] outline-none placeholder:text-text-2"
            onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
          <Command.List className="max-h-[50vh] overflow-y-auto p-2">
            <Command.Empty className="px-3 py-6 text-center text-text-2">{search.isFetching ? 'Buscando…' : 'Nada encontrado.'}</Command.Empty>
            {!r && (
              <Command.Group heading="Ir para" className="text-[12px] text-text-2">
                {AREAS.map((a) => <Command.Item key={a.to} className={item} onSelect={() => go(a.to)}><a.icon size={16} />{a.label}</Command.Item>)}
                <Command.Item className={item} onSelect={() => go('/configuracoes')}>Configurações</Command.Item>
                <Command.Item className={item} value=">tema" onSelect={() => { toggleTheme(); onClose(); }}>Alternar tema claro/escuro</Command.Item>
                <Command.Item className={item} value=">aprovar" onSelect={() => go('/aprovacoes')}>Decidir aprovações pendentes</Command.Item>
                <Command.Item className={item} value=">monitor novo site" onSelect={() => go('/sentinela', { aba: 'monitores', novo: 1 })}>Vigiar um site novo</Command.Item>
                <Command.Item className={item} value=">base conhecimento" onSelect={() => go('/agentes', { aba: 'base' })}>Base de conhecimento</Command.Item>
              </Command.Group>
            )}
            {r?.contacts?.length > 0 && (
              <Command.Group heading="Contatos">
                {r.contacts.map((c: any) => (
                  <Command.Item key={c.id} value={`c-${c.id}`} className={item} onSelect={() => c.thread_id && go(`/conversas/${c.thread_id}`)}>
                    {c.name} <span className="text-text-2">{c.company ?? ''}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {r?.messages?.length > 0 && (
              <Command.Group heading="Mensagens">
                {r.messages.map((m: any, i: number) => (
                  <Command.Item key={i} value={`m-${i}-${m.thread_id}`} className={item} onSelect={() => go(`/conversas/${m.thread_id}`)}>
                    <span className="font-semibold">{m.contact}</span><span className="truncate text-text-2">{m.snippet.replace(/^⁣/, '')}</span>
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {r?.incidents?.length > 0 && (
              <Command.Group heading="Incidentes">
                {r.incidents.map((i: any) => (
                  <Command.Item key={i.id} value={`i-${i.id}`} className={item} onSelect={() => go('/sentinela', { incidente: i.id })}>
                    <span className="tabular text-text-2">{incidentCode(i.id)}</span>{i.title}
                  </Command.Item>
                ))}
              </Command.Group>
            )}
            {r?.knowledge?.length > 0 && (
              <Command.Group heading="Base de conhecimento">
                {r.knowledge.map((k: any) => (
                  <Command.Item key={k.id} value={`k-${k.id}`} className={item} onSelect={() => go('/agentes', { aba: 'base', q: k.title })}>{k.title}</Command.Item>
                ))}
              </Command.Group>
            )}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
