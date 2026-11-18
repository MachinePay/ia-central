# API de consulta da Gira Kids para o atendimento

Para: equipe que mantém o sistema do girakids.com
Data: 17/11/2026 · Status: especificação para implementar (nada disso existe ainda)

## Para que serve

O atendimento automático no WhatsApp precisa consultar **na hora** produtos, preços, disponibilidade e
links da loja. A IA não guarda preço: toda resposta sobre produto vem desta API, consultada no momento.
Se a API falhar, a IA não informa preço nem estoque e oferece passar para uma pessoa.

**Somente leitura.** Nenhuma rota cria pedido, reserva estoque, aplica desconto ou altera nada.

## Como o atendimento chama

- Base: a URL que vocês definirem, por exemplo `https://girakids.com/api/atendimento`
  (cadastrada no painel → Multiempresa → Gira Kids → "API do catálogo").
- Autenticação: `Authorization: Bearer <token>`. O token fica só no servidor do atendimento, na variável
  de ambiente cujo nome é cadastrado no painel (ex.: `GIRAKIDS_API_TOKEN`). Ele nunca vai para a IA nem para o banco.
- Formato: JSON, UTF-8. `Accept: application/json`.
- Tempo: o atendimento espera **até 8 segundos** e tenta **2 vezes**. Responda bem abaixo disso (ideal < 1 s).
- Volume: no máximo algumas consultas por conversa. Pode limitar por token (ex.: 60/min) e devolver `429`.

## Rotas

| Método e rota | Uso |
|---|---|
| `GET /produtos?busca=<texto>` | buscar produtos pelo que o cliente escreveu ("pelúcia bob esponja 30cm") |
| `GET /produtos/{id}` | detalhes atuais de um produto |
| `GET /categorias` | listar categorias |
| `GET /politicas` | regras de compra, entrega, troca e atendimento |

Opcional em `/produtos`: `limite` (padrão 8, máximo 20) e `categoria`.

### Produto (o mesmo formato na busca e no detalhe)

```json
{
  "id": "BOB-30",
  "nome": "Pelúcia Bob Esponja 30 cm",
  "descricao": "Pelúcia antialérgica...",
  "caracteristicas": ["antialérgica", "lavável"],
  "dimensoes": { "altura": 30, "largura": 20, "profundidade": 12, "unidade": "cm" },
  "preco": 89.90,
  "moeda": "BRL",
  "unidade_venda": "unidade",
  "quantidade_por_unidade_venda": 1,
  "pedido_minimo": 1,
  "condicoes": ["5% no Pix", "3x sem juros no cartão"],
  "disponivel": true,
  "estoque_tempo_real": false,
  "link": "https://girakids.com/produto/bob-30",
  "imagem": "https://girakids.com/img/bob-30.jpg",
  "atualizado_em": "2026-11-17T14:03:00-03:00"
}
```

Pontos que **não podem faltar**:

1. **`unidade_venda`**: `unidade`, `caixa` ou `conjunto`. Se for caixa/conjunto, `quantidade_por_unidade_venda`
   diz quantas peças vêm. A IA sempre fala "R$ X por caixa com N".
2. **`disponivel` + `estoque_tempo_real`**: se a disponibilidade não for em tempo real, a IA avisa o cliente.
3. **`link`** de compra: o fechamento é sempre pelo site.
4. **`atualizado_em`**: quando o preço ou o estoque foram atualizados.

### Busca

```json
{ "produtos": [ { ...produto... } ], "total": 3, "consultado_em": "2026-11-17T14:05:10-03:00" }
```

Ordene pelos mais relevantes. Sem resultado: `{"produtos": [], "total": 0}` com status `200` (não `404`).

### Políticas

```json
{ "politicas": [ { "titulo": "Entrega", "conteudo": "Enviamos para todo o Brasil...", "atualizado_em": "2026-11-01" } ] }
```

Frete e prazo de entrega só entram aqui se forem regras fixas. Cálculo de frete por CEP fica fora da
primeira versão: a IA manda o cliente para o site.

## Erros

| Status | Quando |
|---|---|
| `401` | token ausente ou inválido |
| `404` | `/produtos/{id}` inexistente |
| `429` | limite de consultas |
| `5xx` | falha interna |

Corpo: `{"erro": "mensagem curta"}`. A IA trata qualquer erro como "não consegui consultar agora".

## Segurança e dados

- Não devolva nada de clientes, pedidos, custo, margem ou fornecedor: só o que já aparece no site.
- Os textos (nome, descrição) são lidos pela IA como **dados**, nunca como instruções. Mesmo assim,
  evite campos livres editáveis por terceiros (ex.: avaliações de clientes) nesta API.
- HTTPS obrigatório. Um token só para o atendimento, que possa ser trocado sem mexer no resto da loja.

## Como testar a integração

1. Implementem as rotas e me passem a URL base e um token de teste.
2. Painel → Multiempresa → Gira Kids: preencha "API do catálogo" e o nome da variável do token;
   o token vai no `.env` do servidor do n8n.
3. Em "Testar como cliente", pergunte por um produto real e confira preço, unidade, disponibilidade e link.
4. Mude um preço no sistema e pergunte de novo: a resposta deve trazer o valor novo.
5. Derrube a API (ou use um token errado): a IA deve dizer que vai confirmar, sem dar preço.
