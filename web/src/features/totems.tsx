import { Cpu } from 'lucide-react';
import { EmptyState, PageHeader } from '../ui';

export function Totems() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Totens" accent="var(--coral)" />
      <EmptyState
        title="Os totens ainda não mandam sinal para o sistema."
        text="Esta área mostra cada totem em campo (online, impressora, leitor de cartão) assim que os equipamentos começarem a enviar heartbeat para a API. Os problemas que os clientes relatam já aparecem em Conversas e nos chamados da Clara."
        action={<Cpu className="mt-2 text-coral" />}
      />
    </div>
  );
}
