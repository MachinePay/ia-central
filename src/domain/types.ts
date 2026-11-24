export type Channel = 'WHATSAPP' | 'GMAIL';
export type Agent = 'LEO' | 'JOAO' | 'CLARA' | 'GABRIEL' | 'HUMAN';
export type Specialist = 'JOAO' | 'CLARA' | 'GABRIEL';

export type MediaItem = {
  kind: 'audio' | 'image' | 'pdf' | 'other';
  description: string;
  mimeType?: string;
  fileName?: string;
  seconds?: number;
};

export type InboundEvent = {
  channel: Channel;
  instance: string;              // instancia da Evolution ou conta do Gmail
  externalMessageId: string;     // key.id (Evolution) ou message.id (Gmail)
  externalThreadId: string;      // remoteJid ou threadId do Gmail
  sender: { phone?: string; email?: string; name?: string; jid?: string };
  content: string;
  media: MediaItem[];
  needsMedia: boolean;           // tem midia ainda nao transformada em texto
  metadata: {
    subject?: string;
    inReplyTo?: string;
    messageIdHeader?: string;
    references?: string[];
    quotedMessageId?: string;
    quotedText?: string;
    late?: boolean;              // chegou atrasado (reenvio da Evolution): so registra, nao responde
    raw?: unknown;               // payload da midia para o worker de midia
  };
  receivedAt: string;
};

export type Contact = {
  id: string;
  name: string | null;
  phone: string | null;
  wa_jid: string | null;
  email: string | null;
  company: string | null;
  role: string;
  tags: string[];
  crm_stage: string;
  notes: string | null;
  treatment?: string | null; // como o dono do numero trata este contato (aprendido das mensagens)
  treatment_manual?: boolean;
  logins?: { girakids?: { id: string; email: string | null; nome: string; documento?: string | null }; primeplush?: { documento: string; nome: string } };
  opted_out: boolean;
  consent_at: Date | null;
};

export type Thread = {
  id: string;
  contact_id: string;
  channel: Channel;
  instance: string;
  external_id: string;
  subject: string | null;
  company_slug: string | null;
  active_agent: Agent;
  status: 'OPEN' | 'PAUSED' | 'WAITING_APPROVAL' | 'CLOSED';
  summary: string | null;
  summary_at?: Date | null;
  facts: Record<string, unknown>;
  pending_handoff: { to: Specialist; reason: string; summary: string } | null;
  agent_switches: Array<{ at: string; to: Agent }>;
  msgs_since_summary: number;
  last_inbound_at: Date | null;
  last_outbound_at: Date | null;
  last_bot_at: Date | null;
  ai_enabled?: boolean; // a IA deste numero responde este contato
  ai_auto?: boolean; // e manda sozinha, sem rascunho
};

export type Message = {
  id: string;
  thread_id: string;
  external_id: string | null;
  direction: 'INBOUND' | 'OUTBOUND';
  sender: Agent | null;
  status: string;
  content: string;
  media: MediaItem[] | null;
  metadata: Record<string, any>;
  created_at: Date;
};
