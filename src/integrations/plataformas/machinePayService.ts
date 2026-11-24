// @ts-nocheck
// Copiado do backend da AgarraMais (referencia que ja funciona). Mesmo nome de variaveis de ambiente.
import WebSocketClient from "ws";

const DEFAULT_LOGIN_URL =
  "https://www.cyberpix.com.br/pix-adesivo-clientes/";
const DEFAULT_API_TEMPLATE =
  "https://www.cyberpix.com.br/pix-adesivo-clientes/maquinas.php?acao=stats&posid={posid}&dataini={inicio64}&datafim={fim64}&chave={chave}";
const DEFAULT_FECHAMENTO_TEMPLATE =
  "https://www.cyberpix.com.br/pix-adesivo-clientes/maquinas.php?acao=fechamento&tipo=maq&dataini={inicio64}&datafim={fim64}&valor={valor64}&id={id}&pos_id={posid}";
const DEFAULT_MQTT_TEMPLATE =
  "https://www.cyberpix.com.br/pix-adesivo-clientes/salvar_credito_mqtt.php";

const required = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Configure ${name} no ambiente do backend`);
  }
  return value;
};

const encodeBase64 = (value) =>
  Buffer.from(String(value || ""), "utf8").toString("base64");

const extractCookies = (response) => {
  const getSetCookie = response.headers.getSetCookie;
  const values =
    typeof getSetCookie === "function"
      ? getSetCookie.call(response.headers)
      : [response.headers.get("set-cookie")].filter(Boolean);

  return values.map((cookie) => cookie.split(";")[0]).join("; ");
};

const mergeCookies = (...cookieHeaders) => {
  const cookies = new Map();

  for (const header of cookieHeaders.filter(Boolean)) {
    for (const item of header.split(/;\s*/)) {
      const separator = item.indexOf("=");
      if (separator <= 0) continue;
      cookies.set(item.slice(0, separator), item.slice(separator + 1));
    }
  }

  return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
};

const parseMoney = (value) => {
  if (!value) return 0;

  const normalized = String(value)
    .replace(/[^\d,.-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : 0;
};

// O extrato de transações (linha a linha, "Cliente Pagou"/"Banco Retirou"/
// "Você Recebeu") usa ponto como separador decimal (ex: "R$ 30.00"), ao
// contrário do bloco de totais agregados (PIX/Débito/Crédito) que usa
// vírgula (ex: "R$ 14.349,01") e é tratado por parseMoney acima.
const parseMoneyPontoDecimal = (value) => {
  if (!value) return 0;

  const normalized = String(value).replace(/[^\d.-]/g, "");
  const number = Number(normalized);

  return Number.isFinite(number) ? number : 0;
};

const stripHtml = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractValue = (text, pattern) => text.match(pattern)?.[1]?.trim() || "";

const parseStats = (html) => {
  const block =
    html.match(
      /<div class="custom-text-right">([\s\S]*?Soma das categorias:[\s\S]*?)<\/div>/i,
    )?.[1] || html;
  const text = stripHtml(block)
    .replace(/ComissÃƒÂ£o|ComissÃ£o/g, "Comissao")
    .replace(/LÃƒÂ­quido|LÃ­quido/g, "Liquido")
    .replace(/DÃƒÂ©bito|DÃ©bito/g, "Debito")
    .replace(/CrÃƒÂ©dito|CrÃ©dito/g, "Credito")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const pix = parseMoney(extractValue(text, /PIX:\s*(R\$\s*[\d.,]+)/i));
  const debito = parseMoney(
    extractValue(text, /Debito:\s*(R\$\s*[\d.,]+)/i),
  );
  const credito = parseMoney(
    extractValue(text, /Credito:\s*(R\$\s*[\d.,]+)/i),
  );
  const taxas = parseMoney(
    extractValue(text, /Taxas MP:\s*(R\$\s*[\d.,]+)/i),
  );
  const liquido = parseMoney(
    extractValue(text, /Liquido \(bruto - taxas\):\s*(R\$\s*[\d.,]+)/i),
  );
  const brutoComTaxasMp = parseMoney(
    extractValue(text, /Bruto com Taxas MP:\s*(R\$\s*[\d.,]+)/i),
  );

  if (
    !/Bruto com Taxas MP:/i.test(text)
  ) {
    throw new Error(
      "A Machine Pay não devolveu o campo Bruto com Taxas MP esperado",
    );
  }

  return {
    pix,
    debito,
    credito,
    cartao: Number((debito + credito).toFixed(2)),
    brutoComTaxasMp,
    cartaoPix: brutoComTaxasMp,
    taxas,
    liquido,
    percentualTaxaMedia:
      brutoComTaxasMp > 0
        ? Number(((taxas / brutoComTaxasMp) * 100).toFixed(4))
        : 0,
  };
};

// Percentual retido no "recebimento à parte" (ex.: poltronas do aeroporto,
// parede interna) — repassado a quem administra o espaço.
const PERCENTUAL_RETIDO_RECEBIMENTO_A_PARTE = 0.3;

// Máquinas marcadas com "recebimento à parte" (Maquina.recebimentoAParteMachinePay)
// têm o bruto vindo da Machine Pay recalculado antes de entrar no sistema:
// tira o percentual retido, divide o restante ao meio, soma com metade do
// percentual retido. Ex.: 30000 -> tira 30% (sobra 21000) -> divide por 2
// (10500) -> soma com metade dos 30% (9000/2 = 4500) -> 15000.
export const calcularRecebimentoAParteMachinePay = (valorBruto) => {
  const valor = Number(valorBruto || 0);
  const retido = valor * PERCENTUAL_RETIDO_RECEBIMENTO_A_PARTE;
  const restante = valor - retido;

  const parteRestante = restante / 2;
  const parteRetida = retido / 2;

  return Number((parteRestante + parteRetida).toFixed(2));
};

// Aplica o "recebimento à parte" em todo o resultado de
// consultarFechamentoMachinePay (não só no bruto), escalando pix/débito/
// crédito/taxas/líquido pelo mesmo fator do bruto — assim o resumo mostrado
// no Registrar Dinheiro continua com os números batendo entre si, e
// percentualTaxaMedia (proporção taxas/bruto) não muda.
export const ajustarStatsParaRecebimentoAParte = (dados) => {
  const brutoOriginal = Number(dados.brutoComTaxasMp || 0);
  const brutoAjustado = calcularRecebimentoAParteMachinePay(brutoOriginal);
  const fator = brutoOriginal > 0 ? brutoAjustado / brutoOriginal : 0;
  const escalar = (valor) => Number((Number(valor || 0) * fator).toFixed(2));

  return {
    ...dados,
    pix: escalar(dados.pix),
    debito: escalar(dados.debito),
    credito: escalar(dados.credito),
    cartao: escalar(dados.cartao),
    brutoComTaxasMp: brutoAjustado,
    cartaoPix: brutoAjustado,
    taxas: escalar(dados.taxas),
    liquido: escalar(dados.liquido),
  };
};

const formatInicio = (value) => String(value || "").slice(0, 10);
const formatFim = (value) => {
  const texto = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) {
    return `${texto}T23:59`;
  }
  return texto.slice(0, 16);
};

const formatMoneyBr = (value) => {
  const number = Number(value || 0);
  return `R$ ${(Number.isFinite(number) ? number : 0).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const buildStatsUrl = ({ posId, inicio, fim }) => {
  const inicioFormatado = formatInicio(inicio);
  const fimFormatado = formatFim(fim);

  return (
  (process.env.MACHINE_PAY_API_TEMPLATE || DEFAULT_API_TEMPLATE)
    .replaceAll("{posid}", encodeURIComponent(posId))
    .replaceAll("{inicio}", encodeURIComponent(inicioFormatado))
    .replaceAll("{fim}", encodeURIComponent(fimFormatado))
    .replaceAll("{dataInicio}", encodeURIComponent(inicioFormatado))
    .replaceAll("{dataFim}", encodeURIComponent(fimFormatado))
    .replaceAll("{inicio64}", encodeURIComponent(encodeBase64(inicioFormatado)))
    .replaceAll("{fim64}", encodeURIComponent(encodeBase64(fimFormatado)))
    .replaceAll(
      "{dataInicio64}",
      encodeURIComponent(encodeBase64(inicioFormatado)),
    )
    .replaceAll(
      "{dataFim64}",
      encodeURIComponent(encodeBase64(fimFormatado)),
    )
    .replaceAll(
      "{chave}",
      encodeURIComponent(process.env.MACHINE_PAY_CHAVE || ""),
    )
  );
};

const buildFechamentoUrl = ({ posId, inicio, fim, valor = 0 }) => {
  const inicioFormatado = formatInicio(inicio);
  const fimFormatado = formatFim(fim);
  const loginMachinePay = required("MACHINE_PAY_LOGIN");

  return (
    (process.env.MACHINE_PAY_FECHAMENTO_TEMPLATE ||
      DEFAULT_FECHAMENTO_TEMPLATE)
      .replaceAll("{posid}", encodeURIComponent(posId))
      .replaceAll("{pos_id}", encodeURIComponent(posId))
      .replaceAll("{inicio}", encodeURIComponent(inicioFormatado))
      .replaceAll("{fim}", encodeURIComponent(fimFormatado))
      .replaceAll("{dataInicio}", encodeURIComponent(inicioFormatado))
      .replaceAll("{dataFim}", encodeURIComponent(fimFormatado))
      .replaceAll(
        "{inicio64}",
        encodeURIComponent(encodeBase64(inicioFormatado)),
      )
      .replaceAll("{fim64}", encodeURIComponent(encodeBase64(fimFormatado)))
      .replaceAll(
        "{dataInicio64}",
        encodeURIComponent(encodeBase64(inicioFormatado)),
      )
      .replaceAll(
        "{dataFim64}",
        encodeURIComponent(encodeBase64(fimFormatado)),
      )
      .replaceAll("{valor}", encodeURIComponent(formatMoneyBr(valor)))
      .replaceAll(
        "{valor64}",
        encodeURIComponent(encodeBase64(formatMoneyBr(valor))),
      )
      .replaceAll("{id}", encodeURIComponent(loginMachinePay))
      .replaceAll("{usr}", encodeURIComponent(loginMachinePay))
  );
};

const login = async () => {
  const loginUrl = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  const initialResponse = await fetch(loginUrl, { redirect: "manual" });
  let cookies = extractCookies(initialResponse);

  const url = new URL("index.php", loginUrl);
  url.searchParams.set("acao", "login");
  url.searchParams.set("usr", encodeBase64(required("MACHINE_PAY_LOGIN")));
  url.searchParams.set("snh", encodeBase64(required("MACHINE_PAY_PASSWORD")));

  const loginResponse = await fetch(url, {
    headers: {
      Accept: "*/*",
      Cookie: cookies,
      Referer: loginUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
    redirect: "manual",
  });

  cookies = mergeCookies(cookies, extractCookies(loginResponse));
  const body = await loginResponse.text();

  if (!loginResponse.ok || /senha|login incorreto|acesso negado/i.test(body)) {
    throw new Error("Falha ao autenticar na Machine Pay");
  }

  return { cookies, loginUrl };
};

const replaceMachinePayTokens = ({
  template,
  posId,
  inicio,
  fim,
  creditos = 1,
}) => {
  const inicioFormatado = formatInicio(inicio);
  const fimFormatado = formatFim(fim);

  return template
    .replaceAll("{posid}", encodeURIComponent(posId))
    .replaceAll("{pos_id}", encodeURIComponent(posId))
    .replaceAll("{inicio}", encodeURIComponent(inicioFormatado))
    .replaceAll("{fim}", encodeURIComponent(fimFormatado))
    .replaceAll("{dataInicio}", encodeURIComponent(inicioFormatado))
    .replaceAll("{dataFim}", encodeURIComponent(fimFormatado))
    .replaceAll("{inicio64}", encodeURIComponent(encodeBase64(inicioFormatado)))
    .replaceAll("{fim64}", encodeURIComponent(encodeBase64(fimFormatado)))
    .replaceAll(
      "{dataInicio64}",
      encodeURIComponent(encodeBase64(inicioFormatado)),
    )
    .replaceAll(
      "{dataFim64}",
      encodeURIComponent(encodeBase64(fimFormatado)),
    )
    .replaceAll("{creditos}", encodeURIComponent(creditos))
    .replaceAll("{creditos64}", encodeURIComponent(encodeBase64(creditos)))
    .replaceAll(
      "{chave}",
      encodeURIComponent(process.env.MACHINE_PAY_CHAVE || ""),
    );
};

const fetchMachinePay = async (url, options = {}) => {
  const { cookies, loginUrl } = await login();
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      Accept: "*/*",
      Cookie: cookies,
      Referer: loginUrl,
      "X-Requested-With": "XMLHttpRequest",
      ...(options.headers || {}),
    },
    body: options.body,
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Machine Pay respondeu com status ${response.status}`);
  }

  return { status: response.status, body };
};

const tryParseJson = (body) => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const normalizarTexto = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

const parseDataHoraTabela = (texto) => {
  const match = String(texto || "").match(
    /(\d{2})\/(\d{2})\/(\d{4})-(\d{2}):(\d{2}):(\d{2})/,
  );
  if (!match) return null;

  const [, dia, mes, ano, hora, min, seg] = match;
  const data = new Date(`${ano}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`);
  return Number.isNaN(data.getTime()) ? null : data;
};

const capturarValorPorLabel = (rowHtml, label) => {
  // No HTML real o <b>valor</b> e o <span>rótulo</span> são irmãos dentro
  // de uma div flex, sem <br> entre eles — só espaço/quebra de linha.
  const regex = new RegExp(
    `<b[^>]*>([^<]*)<\\/b>\\s*(?:<br\\s*\\/?>\\s*)*<span[^>]*>\\s*${label}\\s*<\\/span>`, // aceita <br> no meio (layout novo)
    "i",
  );
  const match = rowHtml.match(regex);
  return match ? parseMoneyPontoDecimal(stripHtml(match[1])) : 0;
};

const capturarPulsoMachinePay = (rowHtml) => {
  // O status do pulso/tarifador vem do <select id="pgNNNN"> da coluna
  // Telemetrias (opções: "Consultado"/"Aguardando"/"Expirado ❌"), não de um
  // <b>Pulso...</b> como a marcação antiga assumia.
  const match = rowHtml.match(
    /<option\s+selected\s+value="([^"]*)">([^<]*)<\/option>/i,
  );
  if (!match) return { pulsoConsultado: false, pulsoStatus: "" };

  const valor = match[1];
  const pulsoStatus = stripHtml(match[2]);

  return {
    pulsoConsultado: valor === "ok" || /consultado/i.test(pulsoStatus),
    pulsoStatus,
  };
};

const parseLinhaExtratoMaquina = (rowHtml) => {
  const dataHoraTexto = extractValue(
    rowHtml,
    /✅\s*(\d{2}\/\d{2}\/\d{4}-\d{2}:\d{2}:\d{2})/u,
  );
  if (!dataHoraTexto) return null;

  const dataHora = parseDataHoraTabela(dataHoraTexto);

  // devolve('idpg') é a chamada real do botão "Devolver" (usa o ID de
  // pagamento, o mesmo do "ID PG:"/mostrar_mp). apagarRegistro2(id) é o
  // botão "Excluir" e usa um ID de registro interno diferente — não serve
  // como idwebhook, senão a devolução vai pro pagamento errado.
  const idwebhookMatch =
    rowHtml.match(/devolve\('(\d+)'\)/) ||
    rowHtml.match(/devolver\((\d+)\)/) ||
    rowHtml.match(/id="dv(\d+)"/) ||
    rowHtml.match(/change_pagto\((\d+)\)/) ||
    rowHtml.match(/apagarRegistro2\((\d+)\)/);
  const idwebhook = idwebhookMatch ? idwebhookMatch[1] : null;
  const id = idwebhook || dataHoraTexto;

  const valorPago = capturarValorPorLabel(rowHtml, "Cliente Pagou");
  const taxa = capturarValorPorLabel(rowHtml, "Banco Retirou");
  const liquido = capturarValorPorLabel(rowHtml, "Voc[eê] Recebeu");

  // Div do método/banco tem outras propriedades CSS entre font-size e o
  // fechamento do style (font-family, text-align, etc) e sempre começa com
  // ✅ (Pix) ou 💳 (cartão) — usa esse marcador em vez de tentar casar o
  // style inteiro, que muda conforme o meio de pagamento.
  const bancoMetodoMatch = rowHtml.match(
    /white-space:\s*nowrap;\s*text-shadow:[^"]*;">\s*([\s\S]*?)<\/div>/,
  );
  const bancoMetodo = bancoMetodoMatch ? stripHtml(bancoMetodoMatch[1]) : "";

  // O selo de situação (ex: "Venda Aprovada") fica num <span> com o badge
  // verde, não num <strong> — o único <strong> da linha é o ID PG.
  const statusMatch =
    rowHtml.match(
      /background-color:#e8f5e9;color:#28a745;[\s\S]*?>\s*(?:<img[^>]*>\s*)?([^<]+?)\s*<\/span>/,
    ) || rowHtml.match(/>(Venda [^<]+?)</);
  const statusVenda = statusMatch ? statusMatch[1].trim() : "";

  const referenciaVenda = extractValue(
    rowHtml,
    /\u{1F50D}\s*ID PG:\s*<strong[^>]*>([^<]+)<\/strong>/u,
  );

  const { pulsoConsultado, pulsoStatus } = capturarPulsoMachinePay(rowHtml);

  return {
    id,
    idwebhook,
    valorPago,
    taxa,
    liquido,
    bancoMetodo,
    statusVenda,
    referenciaVenda,
    pulsoConsultado,
    pulsoStatus,
    data: dataHora ? dataHora.toISOString() : null,
  };
};

const parseExtratoMaquina = (html) => {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];

  return rows
    .map((row) => {
      try {
        return parseLinhaExtratoMaquina(row[1]);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

export const consultarFechamentoMachinePay = async ({
  posId,
  inicio,
  fim,
}) => {
  const { cookies, loginUrl } = await login();
  const url = buildStatsUrl({ posId, inicio, fim });
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      Cookie: cookies,
      Referer: loginUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Machine Pay respondeu com status ${response.status}`);
  }

  return parseStats(body);
};

export const fecharFechamentoMachinePay = async ({
  posId,
  inicio,
  fim,
  valor = 0,
}) => {
  const { cookies, loginUrl } = await login();
  const url = buildFechamentoUrl({ posId, inicio, fim, valor });
  const response = await fetch(url, {
    headers: {
      Accept: "*/*",
      Cookie: cookies,
      Referer: loginUrl,
      "X-Requested-With": "XMLHttpRequest",
    },
  });
  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Machine Pay respondeu com status ${response.status}`);
  }

  const concluido =
    /maquinasFechamentoConcluido|fechamento\s+conclu/i.test(body);

  return {
    concluido,
    status: response.status,
  };
};

let _adminUsrCache = null;

const descobrirAdminUsr = async () => {
  if (_adminUsrCache) return _adminUsrCache;
  const loginUrl = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  try {
    const { body } = await fetchMachinePay(
      `${loginUrl}maquinas.php?acao=maquinas`,
      { headers: { "X-Requested-With": "XMLHttpRequest" } },
    );
    const match = body.match(/copiarDadosMaquina\((\d{10,20})/);
    if (match) {
      _adminUsrCache = match[1];
      return _adminUsrCache;
    }
  } catch {}
  return null;
};

const buscarStatusViaFiltro = async ({ usrId, posId }) => {
  const loginUrl = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  const chave = Buffer.from(String(posId), "utf8").toString("base64");
  const url = `${loginUrl}maquinas.php?acao=filtro&idusr=${usrId}&chave=${encodeURIComponent(chave)}`;
  const { body } = await fetchMachinePay(url, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });
  if (!body.includes(String(posId)) && !body.includes("maq_on") && !body.includes("maq_off")) {
    return null;
  }
  const offline = body.includes("maq_off");
  const online = body.includes("maq_on") && !offline;
  return { online: online && !offline, status: offline ? "offline" : online ? "online" : "desconhecido" };
};

export const descobrirUsrDePosId = async ({ posId }) => {
  const usrIds = (process.env.MACHINE_PAY_USR || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  for (const usrId of usrIds) {
    const resultado = await buscarStatusViaFiltro({ usrId, posId });
    if (resultado) return { usrId, ...resultado };
  }

  const adminUsr = await descobrirAdminUsr();
  if (adminUsr) {
    const resultado = await buscarStatusViaFiltro({ usrId: adminUsr, posId });
    if (resultado) return { usrId: adminUsr, ...resultado };
  }

  return null;
};

export const consultarStatusMachinePay = async ({ posId, usrId: usrIdParam }) => {
  const envUsrId = (process.env.MACHINE_PAY_USR || "").split(",")[0].trim();
  const usrId = usrIdParam || envUsrId || (await descobrirAdminUsr());

  if (!usrId) {
    return {
      httpStatus: 0,
      consultadoEm: new Date().toISOString(),
      online: false,
      status: "desconhecido",
      bruto: null,
    };
  }

  const resultado = await buscarStatusViaFiltro({ usrId, posId });

  if (!resultado) {
    return {
      httpStatus: 200,
      consultadoEm: new Date().toISOString(),
      online: false,
      status: "desconhecido",
      bruto: null,
    };
  }

  return {
    httpStatus: 200,
    consultadoEm: new Date().toISOString(),
    ...resultado,
    bruto: resultado.status,
  };
};

export const consultarTransacoesMachinePay = async ({ posId, inicio, fim }) => {
  const url = buildStatsUrl({ posId, inicio, fim });
  const { body, status } = await fetchMachinePay(url);
  const registros = parseExtratoMaquina(body);

  const inicioData = inicio ? new Date(`${inicio}-03:00`) : null;
  const fimData = fim ? new Date(`${fim}-03:00`) : null;

  const transacoes = registros
    .filter((registro) => {
      if (!registro.data) return true;
      const dataRegistro = new Date(registro.data);
      if (inicioData && dataRegistro < inicioData) return false;
      if (fimData && dataRegistro > fimData) return false;
      return true;
    })
    .map((registro) => {
      const aprovada = /aprova/i.test(registro.statusVenda || "");
      const jaDevolvido = /devolv/i.test(registro.statusVenda || "");
      const pagamentoReal = !/manual/i.test(registro.bancoMetodo || "");
      const podeDevolver = Boolean(
        registro.idwebhook && pagamentoReal && aprovada && !jaDevolvido,
      );

      return {
        id: registro.id,
        idwebhook: registro.idwebhook,
        data: registro.data,
        tipo: registro.bancoMetodo || "Transacao",
        status: registro.statusVenda || "-",
        valor: registro.valorPago,
        taxa: registro.taxa,
        liquido: registro.liquido,
        referencia: registro.referenciaVenda,
        pulsoConsultado: registro.pulsoConsultado,
        pulsoStatus: registro.pulsoStatus,
        pagamentoReal,
        jaDevolvido,
        podeDevolver,
      };
    });

  return {
    httpStatus: status,
    inicio,
    fim,
    transacoes,
    total: Number(
      transacoes.reduce((sum, item) => sum + Number(item.valor || 0), 0).toFixed(2),
    ),
    quantidade: transacoes.length,
  };
};

const formatarDataHoraBrasilia = (data) =>
  new Intl.DateTimeFormat("sv-SE", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(data)
    .replace(" ", "T");

// Soma o valor recebido (pagamentos aprovados, excluindo devoluções) na
// Machine Pay num intervalo. Centraliza a formatação de data (Brasília) e a
// filtragem de devoluções usada tanto pelo cálculo de estoque real quanto
// pela preservação de dados antes de um fechamento (ver
// MachinePayColetaPendente em registroDinheiroController), pra não duplicar
// essa conta em mais de um lugar.
export const calcularTotalRecebidoMachinePay = async ({
  posId,
  inicio,
  fim,
}) => {
  const inicioFormatado = formatarDataHoraBrasilia(new Date(inicio));
  const fimFormatado = formatarDataHoraBrasilia(new Date(fim));

  const { transacoes } = await consultarTransacoesMachinePay({
    posId,
    inicio: inicioFormatado,
    fim: fimFormatado,
  });

  const total = transacoes
    .filter((transacao) => !transacao.jaDevolvido)
    .reduce((soma, transacao) => soma + Number(transacao.valor || 0), 0);

  return Number(total.toFixed(2));
};

// Calcula o estoque real de uma máquina com "desconto automático via
// Machine Pay": a cada pagamento aprovado desde a última coleta, a máquina
// libera 1 pulso/ficha sem gerar uma nova movimentação, então o totalPos
// registrado fica desatualizado. Usado tanto pela sugestão de Total Pré
// (movimentacaoController) quanto pelos alertas de estoque
// (relatorioController), pra não duplicar essa conta em dois lugares.
//
// `dataUltimaMovimentacao` deve ser o ponto de partida já ajustado pelo
// chamador (a data da última movimentação, ou a data do fechamento mais
// recente que já teve seu extrato preservado em MachinePayColetaPendente,
// o que for mais recente) e `totalAcumuladoPendente` é o valor já
// preservado de fechamentos anteriores que zeraram o extrato na Machine
// Pay para o período anterior a essa data — ver registroDinheiroController.
export const calcularEstoqueRealMachinePay = async ({
  posId,
  valorDesconto,
  totalPosAnterior,
  dataUltimaMovimentacao,
  totalAcumuladoPendente = 0,
}) => {
  const totalRecebidoConsulta = await calcularTotalRecebidoMachinePay({
    posId,
    inicio: dataUltimaMovimentacao,
    fim: new Date(),
  });

  const totalRecebido = Number(
    (totalRecebidoConsulta + Number(totalAcumuladoPendente || 0)).toFixed(2),
  );

  const pulsos = Math.floor(totalRecebido / valorDesconto);
  const estoqueReal = Math.max(0, totalPosAnterior - pulsos);

  return {
    estoqueReal,
    totalRecebidoDesdeUltimaMovimentacao: totalRecebido,
    pulsos,
  };
};

export const devolverPagamentoMachinePay = async ({ idwebhook }) => {
  const loginUrl = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  const url = `${loginUrl}maquinas.php?acao=devolver&idwebhook=${encodeURIComponent(idwebhook)}`;
  const { body, status } = await fetchMachinePay(url, {
    headers: { "X-Requested-With": "XMLHttpRequest" },
  });

  const textoNormalizado = normalizarTexto(body);
  const alertMatch = body.match(/alert\("([^"]*)"\)/i);
  const mensagem = alertMatch ? alertMatch[1] : "";

  const sucesso =
    textoNormalizado.includes("solicitacao de devolucao") &&
    textoNormalizado.includes(String(idwebhook));

  if (!sucesso) {
    throw new Error(
      mensagem || "Nao foi possivel solicitar a devolucao na Machine Pay.",
    );
  }

  return {
    httpStatus: status,
    sucesso: true,
    mensagem,
  };
};

const publicarMqttWebSocket = async (posId, valorFinal, idwebhook) => {
  const dominio = process.env.MACHINE_PAY_WS_DOMINIO || "cyberpix.com.br";
  const token = process.env.MACHINE_PAY_WS_TOKEN || "1";
  const usuario = process.env.MACHINE_PAY_WS_USUARIO || "1";
  const loginUrl = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  const wsUrl = `wss://${dominio}:65501/?token=${encodeURIComponent(token)}&scope=panel`;

  const { cookies } = await login();

  return new Promise((resolve, reject) => {
    const ws = new WebSocketClient(wsUrl, {
      headers: {
        Cookie: cookies,
        Origin: loginUrl.replace(/\/$/, ""),
      },
      rejectUnauthorized: false,
    });

    let settled = false;
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      ok ? resolve() : reject(err);
    };

    const timeout = setTimeout(
      () => done(false, new Error("Timeout ao conectar WebSocket Machine Pay")),
      10000,
    );

    ws.on("open", () => {
      ws.send(JSON.stringify({ acao: "inscrever", canal: String(posId) }));
      ws.send(
        JSON.stringify({
          acao: "publicar",
          canal: String(posId),
          mensagem: {
            origem: usuario,
            dados: JSON.stringify({ retorno: valorFinal, idwebhook }),
          },
        }),
      );
      clearTimeout(timeout);
      setTimeout(() => done(true), 1500);
    });

    ws.on("error", (err) =>
      done(false, new Error(`WebSocket Machine Pay: ${err.message}`)),
    );
  });
};

const formatDecimalMachinePay = (value) => {
  const number = Number(value || 0);
  return (Number.isFinite(number) ? number : 0).toFixed(2);
};

export const enviarCreditosMqttMachinePay = async ({ posId, creditos = 1 }) => {
  const idwebhook = Math.floor(
    Math.random() * 900000000000 + 100000000000,
  ).toString();
  const valorFinal = formatDecimalMachinePay(creditos);

  let wsOk = false;
  let wsErro = null;
  try {
    await publicarMqttWebSocket(posId, valorFinal, idwebhook);
    wsOk = true;
  } catch (err) {
    wsErro = err.message;
  }

  const method = (process.env.MACHINE_PAY_MQTT_METHOD || "POST").toUpperCase();
  const url = replaceMachinePayTokens({
    template: process.env.MACHINE_PAY_MQTT_TEMPLATE || DEFAULT_MQTT_TEMPLATE,
    posId,
    creditos,
  });
  const formData = new URLSearchParams({
    acao: process.env.MACHINE_PAY_MQTT_ACAO || "creditar",
    pos_id: String(posId),
    valor: valorFinal,
    idwebhook,
    origem: process.env.MACHINE_PAY_MQTT_ORIGEM || "1",
    tpagto: process.env.MACHINE_PAY_MQTT_TPAGTO || "Manual",
    banco: process.env.MACHINE_PAY_MQTT_BANCO || "Pagto manual criado",
  });

  const { body, status } = await fetchMachinePay(url, {
    method,
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: formData,
  });
  const json = tryParseJson(body);
  const text = normalizarTexto(stripHtml(body));
  const dbOk =
    json?.ok === true ||
    json?.status === "ok" ||
    json?.success === true ||
    /gravado com sucesso|sucesso|enviado|credito|mqtt/.test(text);

  return {
    httpStatus: status,
    sucesso: wsOk && dbOk,
    wsOk,
    wsErro,
    creditos: Number(creditos || 1),
    online: json?.stsock ? normalizarTexto(json.stsock) === "online" : null,
    idwebhook: json?.idwebhook || idwebhook,
    resposta: json || text.slice(0, 500),
  };
};

// ---- Monitoramento dos leitores (página "Machine Pay") ----

export class MachinePayServiceError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "MachinePayServiceError";
    this.status = status;
  }
}

const baseUrlPainel = () => {
  const url = process.env.MACHINE_PAY_LOGIN_URL || DEFAULT_LOGIN_URL;
  return url.endsWith("/") ? url : `${url}/`;
};

// Listagem "Dispositivos Cadastrados" (acao=maquinas) de uma conta; o HTML é
// interpretado por machinePayPainelParser.js.
export const listarMaquinasCadastradas = async ({ usrId } = {}) => {
  const query = usrId ? `&usr=${encodeURIComponent(usrId)}` : "";
  try {
    const { body } = await fetchMachinePay(
      `${baseUrlPainel()}maquinas.php?acao=maquinas${query}`,
    );
    return body;
  } catch (error) {
    throw new MachinePayServiceError(
      502,
      `Falha ao listar máquinas na Machine Pay: ${error.message}`,
    );
  }
};

// O extrato de um caixa (acao=stats&posid=) lista os pagamentos com
// mostrar_mp('<idPagamento>', <usrDoCliente>) — dá o dono do posId sem saber
// o usr de antemão. Só funciona se o caixa teve pagamento no período padrão.
export const descobrirUsrPorExtrato = async (posId) => {
  if (!posId) return null;
  const { body } = await fetchMachinePay(
    `${baseUrlPainel()}maquinas.php?acao=stats&posid=${encodeURIComponent(posId)}`,
  );
  const match = body.match(/mostrar_mp\('[^']*'\s*,\s*(\d+)\s*\)/);
  return match ? match[1] : null;
};

// Login reaproveitado pela criação de caixas (machinePayCaixasService.js).
export { login as loginMachinePay };
