# Subir a IA Central: backend no Render, painel na Vercel

Tempo: uns 30 minutos (a maior parte é esperar o build).

## 1. GitHub (repositório privado)

1. Crie um repositório **privado** no GitHub, por exemplo `ia-central` (sem README).
2. No PC, na pasta `ia-central`:
   ```bash
   git remote add origin https://github.com/SEU-USUARIO/ia-central.git
   git push -u origin main
   ```
   O `.env` (senhas e chaves) **não** vai para o GitHub — está no `.gitignore`.

## 2. Render (banco + n8n + WhatsApp)

1. render.com → **New** → **Blueprint** → conecte o GitHub e escolha o repositório `ia-central`.
2. O Render lê o `render.yaml` e mostra: `ia-central-db`, `ia-central-n8n`, `ia-central-evolution`.
3. Ele pede alguns valores. Preencha:

   | Variável | O que colocar |
   |---|---|
   | `ADMIN_SENHA` | a senha que você vai usar para entrar no painel (usuário: `admin`) |
   | `ADMIN_NOME` | seu nome |
   | `OPENAI_API_KEY` | sua chave da OpenAI (gere uma **nova** em platform.openai.com) |
   | `ANTHROPIC_API_KEY` | opcional (reserva Claude) — pode deixar vazio |
   | `TELEGRAM_BOT_TOKEN` | opcional — vazio |
   | `RENDER_API_KEY` | opcional: Render → Account Settings → API Keys (para monitorar seus serviços) |
   | `VERCEL_TOKEN` | opcional: vercel.com → Account Settings → Tokens |
   | `VERCEL_TEAM_ID` | só se seus projetos da Vercel forem de um time |

4. **Apply**. Espere os 3 ficarem verdes ("Live"). O n8n demora mais no primeiro deploy (~5–10 min).
5. Abra o serviço **ia-central-n8n** e copie o endereço dele (ex.: `https://ia-central-n8n.onrender.com`).
6. **Logo em seguida**, abra esse endereço no navegador e crie a conta de dono do n8n
   (quem abrir primeiro vira o dono — faça isso você).

Custo: 2 serviços pagos (0.5 CPU / 512 MB) + disco de 1 GB + Postgres pequeno. Veja os valores na tela
antes de confirmar. O plano free não serve: ele hiberna e o monitor e o WhatsApp param.

## 3. Vercel (painel)

1. No arquivo `painel/vercel.json`, troque `TROQUE-PELO-ENDERECO-DO-N8N.onrender.com` pelo endereço do
   passo 2.5 (sem `https://` duplicado). Salve, `git commit -am "endereco do n8n"` e `git push`.
2. vercel.com → **Add New** → **Project** → importe o repositório `ia-central`.
3. Em **Root Directory** escolha `painel`. O resto ele detecta (Vite). **Deploy**.
4. Pronto: o painel fica em `https://<seu-projeto>.vercel.app` (com HTTPS — microfone funciona no celular).

## 4. Fazer funcionar

1. Abra o painel da Vercel e entre com `admin` + a `ADMIN_SENHA`.
2. **Antes de conectar o WhatsApp no Render**, desligue o local (senão os dois respondem):
   no painel **local** (localhost:5173) → cartão WhatsApp → **Desconectar**; depois `docker compose down`.
3. No painel da Vercel: Privacidade → **Meu WhatsApp** → seu número.
4. Cartão **WhatsApp** → **Conectar com QR code** → no celular: Aparelhos conectados → Conectar aparelho.
5. Mande "oi" na sua conversa **"Você"** no WhatsApp. A IA responde com 🤖.
6. No celular, abra o painel da Vercel e use "Adicionar à tela inicial".
7. Cadastre seus sites pelo chat ("monitora https://meusite.com") — os do Render/Vercel entram sozinhos
   se você colocou as chaves.

## Depois

- Mudou algo no código: `git push` → Render e Vercel atualizam sozinhos. O n8n reimporta os workflows a
  cada deploy (dados e memórias ficam no banco).
- Mudar uma chave: Render → `ia-central-n8n` → Environment → salvar (ele reinicia).
- Os dados do PC (memórias, usuários) **não** vão para o Render: lá começa do zero.
