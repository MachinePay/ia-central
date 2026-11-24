import PDFDocument from 'pdfkit';

/** PDF simples do pedido/orcamento (para a Girakids, que so gera o PDF no navegador). */
export type PdfPedido = {
  loja: string; titulo: string; numero: string | number; cliente?: string; data?: Date;
  itens: Array<{ nome: string; detalhe?: string; quantidade: string; total: number }>;
  subtotal?: number; frete?: number; total: number; rodape?: string[];
};

const brl = (n: number) => `R$ ${Number(n).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

export function pdfPedido(p: PdfPedido): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width - 96;
    doc.font('Helvetica-Bold').fontSize(20).fillColor('#111').text(p.loja, 48, 48);
    doc.font('Helvetica').fontSize(12).fillColor('#444').text(`${p.titulo} nº ${p.numero}`);
    doc.text(`Data: ${(p.data ?? new Date()).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);
    if (p.cliente) doc.text(`Cliente: ${p.cliente}`);
    doc.moveDown(1);

    const cols = { nome: 48, qtd: 48 + W * 0.6, total: 48 + W * 0.78 };
    const header = (y: number) => {
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#111');
      doc.text('Produto', cols.nome, y); doc.text('Qtd', cols.qtd, y); doc.text('Total', cols.total, y, { width: W * 0.22, align: 'right' });
      doc.moveTo(48, y + 14).lineTo(48 + W, y + 14).strokeColor('#ccc').stroke();
      return y + 20;
    };
    let y = header(doc.y);
    doc.font('Helvetica').fontSize(10).fillColor('#222');
    for (const it of p.itens) {
      const nome = it.detalhe ? `${it.nome}\n${it.detalhe}` : it.nome;
      const h = Math.max(doc.heightOfString(nome, { width: W * 0.58 }), 12);
      if (y + h > doc.page.height - 120) { doc.addPage(); y = header(48); doc.font('Helvetica').fontSize(10).fillColor('#222'); }
      doc.text(nome, cols.nome, y, { width: W * 0.58 });
      doc.text(it.quantidade, cols.qtd, y, { width: W * 0.18 });
      doc.text(brl(it.total), cols.total, y, { width: W * 0.22, align: 'right' });
      y += h + 8;
    }
    doc.moveTo(48, y).lineTo(48 + W, y).strokeColor('#ccc').stroke();
    y += 10;
    const linha = (l: string, v: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 13 : 11).fillColor('#111');
      doc.text(l, cols.qtd - 60, y, { width: W * 0.2 + 60 }); doc.text(brl(v), cols.total, y, { width: W * 0.22, align: 'right' });
      y += bold ? 20 : 16;
    };
    if (p.subtotal != null && p.frete) linha('Produtos', p.subtotal);
    if (p.frete) linha('Frete', p.frete);
    linha('Total', p.total, true);
    if (p.rodape?.length) {
      doc.font('Helvetica').fontSize(9).fillColor('#666').text(p.rodape.join('\n'), 48, y + 16, { width: W });
    }
    doc.end();
  });
}
