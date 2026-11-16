// Confirmacoes e avisos do painel (SweetAlert2 com o visual do Nucleo).
// Use no lugar do confirm()/alert() do navegador: nunca e bloqueado e fica com a cara do painel.
import Swal from 'sweetalert2'

const base = Swal.mixin({
  buttonsStyling: false,
  reverseButtons: true,
  focusCancel: true,
  showClass: { popup: 'nucleo-entra' },
  hideClass: { popup: 'nucleo-sai' },
  customClass: {
    container: 'nucleo-alerta-fundo',
    popup: 'nucleo-alerta',
    title: 'nucleo-alerta-titulo',
    htmlContainer: 'nucleo-alerta-texto',
    actions: 'nucleo-alerta-acoes',
    confirmButton: 'botao',
    cancelButton: 'botao secundario',
    icon: 'nucleo-alerta-icone',
  },
})

/** Pergunta antes de uma acao importante. Resolve true se a pessoa confirmou. */
export async function confirmar(o: { titulo: string; texto?: string; botao?: string; perigo?: boolean; cancelar?: string }): Promise<boolean> {
  const r = await base.fire({
    icon: o.perigo ? 'warning' : 'question',
    title: o.titulo,
    html: o.texto,
    showCancelButton: true,
    confirmButtonText: o.botao || 'Confirmar',
    cancelButtonText: o.cancelar || 'Cancelar',
    customClass: {
      container: 'nucleo-alerta-fundo', popup: `nucleo-alerta ${o.perigo ? 'perigo' : ''}`, title: 'nucleo-alerta-titulo',
      htmlContainer: 'nucleo-alerta-texto', actions: 'nucleo-alerta-acoes', icon: 'nucleo-alerta-icone',
      confirmButton: `botao ${o.perigo ? 'perigo' : ''}`, cancelButton: 'botao secundario',
    },
  })
  return r.isConfirmed
}

/** Aviso rapido no canto (some sozinho). */
export function avisar(titulo: string, tipo: 'success' | 'error' | 'info' | 'warning' = 'success', texto?: string) {
  void Swal.fire({
    toast: true, position: 'top-end', timer: tipo === 'error' ? 6000 : 3500, timerProgressBar: true, showConfirmButton: false,
    icon: tipo, title: titulo, text: texto,
    customClass: { popup: 'nucleo-toast', title: 'nucleo-alerta-titulo' },
  })
}
