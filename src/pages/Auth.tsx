import { useState, type FormEvent } from 'react'
import { supabase } from '../lib/store'

export default function Auth() {
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { data, error } =
      mode === 'login'
        ? await supabase!.auth.signInWithPassword({ email, password })
        : await supabase!.auth.signUp({ email, password })
    setBusy(false)
    if (error) setMsg(error.message)
    else if (mode === 'signup' && !data.session) setMsg('Conta criada! Confirme pelo e-mail e depois entre.')
  }

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>🧅 Onion Cost</h1>
        <p className="muted">Calcule o custo e o preço de venda dos seus produtos.</p>
        <label>
          E-mail
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label>
          Senha
          <input type="password" required minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <div className="alert">{msg}</div>}
        <button className="primary" disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
          {mode === 'login' ? 'Não tem conta? Cadastre-se' : 'Já tem conta? Entrar'}
        </button>
      </form>
    </div>
  )
}
