import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, createRoute, createRouter, lazyRouteComponent, RouterProvider } from '@tanstack/react-router';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startRealtime } from './app/realtime';
import { Shell } from './app/shell';
import { Login } from './features/login';
import { getToken } from './lib/api';
import './ui/tokens.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: true } },
});

// filtros vivem na URL: qualquer combinacao vira um link compartilhavel
const looseSearch = (s: Record<string, unknown>) => s as Record<string, any>;

const root = createRootRoute({ component: Shell });
const r = (path: string, load: () => Promise<any>, name: string) =>
  createRoute({ getParentRoute: () => root, path, validateSearch: looseSearch, component: lazyRouteComponent(load, name) });

const routeTree = root.addChildren([
  r('/', () => import('./features/home'), 'Home'),
  r('/conversas', () => import('./features/conversations'), 'Conversations'),
  r('/conversas/$id', () => import('./features/conversations'), 'Conversations'),
  r('/aprovacoes', () => import('./features/approvals'), 'Approvals'),
  r('/agentes', () => import('./features/agents'), 'Agents'),
  r('/sentinela', () => import('./features/sentinel'), 'Sentinel'),
  r('/custos', () => import('./features/costs'), 'Costs'),
  r('/totens', () => import('./features/totems'), 'Totems'),
  r('/configuracoes', () => import('./features/settings'), 'Settings'),
]);

// rotas criadas por um helper: sem registro de tipos global (links usam caminhos em texto)
const router = createRouter({ routeTree, defaultPreload: 'intent', defaultPreloadStaleTime: 0 });

function App() {
  const [logged, setLogged] = useState(!!getToken());
  useEffect(() => {
    const out = () => setLogged(false);
    window.addEventListener('cc:logout', out);
    return () => window.removeEventListener('cc:logout', out);
  }, []);
  useEffect(() => (logged ? startRealtime(queryClient) : undefined), [logged]);
  if (!logged) return <Login onDone={() => setLogged(true)} />;
  return <RouterProvider router={router} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
  </StrictMode>,
);
