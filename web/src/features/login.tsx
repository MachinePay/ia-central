import { Gauge } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { post, setToken } from '../lib/api';
import { Button, Field, inputCls } from '../ui';

export function Login({ onDone }: { onDone: () => void }) {
  const [user, setUser] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await post<{ token: string }>('/api/login', { user, password });
      setToken(r.token);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-[360px] space-y-4 rounded-[10px] border border-line bg-surface p-6">
        <div className="flex items-center gap-2"><Gauge className="text-amber" /><h1 className="text-[19px] font-semibold">Centro de Comando</h1></div>
        <Field label="Usuário"><input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" /></Field>
        <Field label="Senha"><input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus /></Field>
        {error && <p role="alert" className="text-crit">{error}</p>}
        <Button variant="primary" className="w-full" busy={busy} type="submit">Entrar</Button>
      </form>
    </div>
  );
}
