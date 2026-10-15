import { useState, type FormEvent } from 'react'
import { loginToEmail } from '../lib/perfil'
import { supabase } from '../lib/store'

export default function Auth() {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMsg(null)
    const { error } = await supabase!.auth.signInWithPassword({ email: loginToEmail(login), password })
    setBusy(false)
    if (error) setMsg(/invalid/i.test(error.message) ? 'Usuário ou senha/PIN incorretos.' : error.message)
  }

  return (
    <div className="center">
      <form className="card auth" onSubmit={submit}>
        <h1>🧅 Onion Cost</h1>
        <p className="muted">Entre com o usuário e o PIN que o responsável criou para você.</p>
        <label>
          Usuário ou e-mail
          <input required autoCapitalize="none" autoCorrect="off" autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} />
        </label>
        <label>
          PIN ou senha
          <input type="password" required minLength={6} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {msg && <div className="alert">{msg}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <p className="small muted">Não tem acesso? Peça ao responsável pelo Onion Cost.</p>
      </form>
    </div>
  )
}
