import { useState, type FormEvent } from 'react'
import { LogIn } from 'lucide-react'
import { api, token, type Usuario } from '../api'
import { Orbe } from './Orbe'

export function Login({ aoEntrar }: { aoEntrar: (u: Usuario) => void }) {
  const [login, setLogin] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(false)

  async function entrar(e: FormEvent) {
    e.preventDefault()
    setErro('')
    setCarregando(true)
    try {
      const r = await api.login(login.trim(), senha)
      token.set(r.token)
      aoEntrar(r.usuario)
    } catch (err) {
      setErro(err instanceof Error ? err.message : 'Nao foi possivel entrar')
    } finally {
      setCarregando(false)
    }
  }

  return (
    <div className="login-tela">
      <form className="hud login-caixa" onSubmit={entrar}>
        <div style={{ display: 'grid', placeItems: 'center' }}>
          <Orbe estado={carregando ? 'pensando' : 'parado'} tamanho={200} />
        </div>
        <h1>N<span>Ú</span>CLEO</h1>
        <p>IA Central · acesso restrito</p>
        {erro && <div className="aviso erro">{erro}</div>}
        <div className="campo">
          <label htmlFor="login">Usuário</label>
          <input id="login" autoComplete="username" autoCapitalize="none" value={login} onChange={e => setLogin(e.target.value)} required />
        </div>
        <div className="campo">
          <label htmlFor="senha">Senha</label>
          <input id="senha" type="password" autoComplete="current-password" value={senha} onChange={e => setSenha(e.target.value)} required />
        </div>
        <button className="botao" disabled={carregando} style={{ marginTop: 8 }}>
          <LogIn size={15} /> {carregando ? 'Conectando…' : 'Entrar'}
        </button>
      </form>
    </div>
  )
}
