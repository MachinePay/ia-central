// @ts-nocheck
// Copiado do backend da AgarraMais (referencia que ja funciona). Mesmo nome de variaveis de ambiente.
// Parser da listagem "Dispositivos Cadastrados" do painel Machine Pay
// (maquinas.php?acao=maquinas). Função pura: recebe o HTML e devolve uma lista de
// máquinas. Isolada do serviço para poder ser testada com HTML de amostra.

const stripHtml = (html) =>
  String(html || "")
    .replace(/<ul[\s\S]*?<\/ul>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const parseMoney = (valorTexto) => {
  if (!valorTexto) return 0;
  const numero = String(valorTexto).replace(/\./g, "").replace(",", ".");
  const resultado = parseFloat(numero);
  return Number.isNaN(resultado) ? 0 : resultado;
};

const casar = (texto, regex, grupo = 1) => {
  const match = texto.match(regex);
  return match ? match[grupo] : null;
};

const SINAIS = {
  otimo: "OTIMO",
  bom: "BOM",
  fraco: "FRACO",
  ruim: "RUIM",
  sem_sinal: "SEM_SINAL",
};

// Divide o HTML em linhas da tabela. Não dá para dividir por "<tr>": as linhas
// offline às vezes vêm sem <tr> próprio. A célula de opções ("td_ops acao") é o
// único marcador presente exatamente uma vez por máquina.
const dividirLinhas = (html) =>
  String(html || "")
    .split(/class="td_ops acao"/)
    .slice(1);

export function parsearLinhaMaquina(linhaHtml) {
  const texto = stripHtml(linhaHtml);

  const posId = casar(linhaHtml, /Caixa:\s*(\d+)/);
  if (!posId) return null;

  const menu = linhaHtml.match(/mnu_op_maq\((\d+)\s*,\s*(\d+)\)/);
  const telemetria =
    casar(
      linhaHtml,
      /alt="(Consultado|Sem resposta|Devolvido|Aguardando|Expirado)"/i,
    ) || null;

  // Indicador ON/OFF: leitores WEBSOCKET/MQTT usam o raio (fa-bolt), leitores
  // Relé/POST usam outro ícone (wifi) com a mesma classe maq_on/maq_off. Sem
  // indicador, vale a última consulta de telemetria do painel.
  const indicador = casar(linhaHtml, /class="fa fa-[\w-]+ maq_(on|off)\b/);
  const online = indicador ? indicador === "on" : telemetria === "Consultado";

  // Badge ao lado do indicador ON/OFF: "3x" = caiu 3 vezes hoje; "ok" = nenhuma queda.
  const quedasTexto = casar(
    linhaHtml,
    /fa-[\w-]+ maq_\w+[^>]*><\/i>\s*<span[^>]*>\s*(\d+)x\s*</,
  );

  // Nome do ponto: texto entre o início da célula do caixa (<td onclick="stats(...)">,
  // não o item homônimo do menu de opções) e o nome do cliente.
  const celulaPonto = linhaHtml.match(
    /<td[^>]*onclick="stats\(\d+\);?"[^>]*>([\s\S]*?)<img[^>]*cliente-empresa\.png/,
  );
  const nomePonto = celulaPonto
    ? stripHtml(celulaPonto[1]).replace(/^Híbrido\s*/i, "").trim() || null
    : null;

  const gatewaySrc = casar(linhaHtml, /src="(?:img\/)?([\w-]+)\.png"\s+alt="Gateway"/);
  const sinalClasse = casar(linhaHtml, /snwifi-label (\w+)/);
  const ips = [...linhaHtml.matchAll(/href="http:\/\/([\d.]+)"/g)];

  const hoje = texto.match(/Hoje R\$\s*([\d.,]+)\s+(\d{2}:\d{2})/);
  const ontem = texto.match(/Ontem R\$\s*([\d.,]+)\s+(\d{2}:\d{2})/);
  const anterior = texto.match(
    /Ant\. R\$\s*([\d.,]+)\s+(\d{2}\/\d{2})\s+(\d{2}:\d{2})/,
  );

  let modoResposta = "SEM_RESPOSTA";
  if (/MQTT Instant[âa]neo/i.test(texto)) modoResposta = "MQTT_INSTANTANEO";
  else if (/MQTT Confirmado/i.test(texto)) modoResposta = "MQTT_CONFIRMADO";
  else if (/\bPOST\s+\d+\s*segundo/i.test(texto)) modoResposta = "POST";

  return {
    posId,
    idPainel: menu ? menu[1] : null,
    usrId: menu ? menu[2] : null,
    online,
    quedasHoje: quedasTexto ? parseInt(quedasTexto, 10) : 0,
    nomePonto,
    cliente: casar(linhaHtml, /cliente-empresa\.png[^>]*>\s*([^<]+?)\s*</),
    versao: casar(texto, /V\.\s*([\d.]+)/),
    tipoVersao: casar(texto, /Versão\s+(WEBSOCKET|MQTT [A-Za-zÀ-ú]+|Rel[ée])/),
    diasVencer: (() => {
      const valor = casar(texto, /(-?\d+)\s*à vencer/);
      return valor === null ? null : parseInt(valor, 10);
    })(),
    gateway: gatewaySrc ? gatewaySrc.replace(/logo$/i, "") : null,
    hibrido: /Híbrido/i.test(texto),
    serial: casar(texto, /Serial:\s*(\d+)/),
    pagamentoTeste: /pagteste/i.test(linhaHtml),
    telemetria,
    modoResposta,
    vendasHojeQtd: parseInt(casar(linhaHtml, /data-vendas-hoje="(\d+)"/) || "0", 10),
    vendasHojeValor: parseMoney(casar(texto, /Vendas\/Dia\s*R\$\s*([\d.,]+)/)),
    totalValor: parseMoney(casar(texto, /Total R\$\s*([\d.,]+)/)),
    totalQtd: parseInt(casar(texto, /Quant\. Vendas\s*(\d+)/) || "0", 10),
    pix: parseMoney(casar(texto, /PIX R\$\s*([\d.,]+)/)),
    debito: parseMoney(casar(texto, /Déb\. R\$\s*([\d.,]+)/)),
    credito: parseMoney(casar(texto, /Créd\. R\$\s*([\d.,]+)/)),
    ultimaVendaHoje: hoje ? { valor: parseMoney(hoje[1]), hora: hoje[2] } : null,
    ultimaVendaOntem: ontem ? { valor: parseMoney(ontem[1]), hora: ontem[2] } : null,
    ultimaVendaAnterior: anterior
      ? { valor: parseMoney(anterior[1]), data: anterior[2], hora: anterior[3] }
      : null,
    sinalWifi: SINAIS[sinalClasse] || "SEM_SINAL",
    dataEquipamento: casar(texto, /(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/),
    ip: ips.length ? ips[ips.length - 1][1] : null,
  };
}

export function parsearPainelMaquinas(html) {
  const maquinas = [];
  const vistos = new Set();
  for (const linha of dividirLinhas(html)) {
    const maquina = parsearLinhaMaquina(linha);
    if (!maquina || vistos.has(maquina.posId)) continue;
    vistos.add(maquina.posId);
    maquinas.push(maquina);
  }
  return maquinas;
}
