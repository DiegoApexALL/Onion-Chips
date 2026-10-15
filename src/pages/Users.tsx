import { useCallback, useEffect, useState } from 'react'
import ConfirmButton from '../ConfirmButton'
import { MODULOS, PAPEIS, type Modulo, type Papel, type Perfil } from '../lib/perfil'
import { supabase } from '../lib/store'

interface Unit { id: string; nome: string }
type Draft = { user_id?: string; nome: string; login: string; pin: string; papel: Papel; modulos: Modulo[]; unit_ids: string[]; ativo: boolean }

const novo = (): Draft => ({ nome: '', login: '', pin: '', papel: 'equipe', modulos: [...PAPEIS[2].modulos], unit_ids: [], ativo: true })

async function callAdmin(body: Record<string, unknown>) {
  const { data, error } = await supabase!.functions.invoke('admin-users', { body })
  if (error) {
    let msg = error.message
    const res = (error as { context?: Response }).context
    try {
      const j = await res?.clone().json()
      if (j?.error) msg = j.error
    } catch {
      /* sem JSON */
    }
    throw new Error(msg)
  }
  return data
}

const papelNome = (p: Papel) => PAPEIS.find((x) => x.id === p)?.nome ?? p

export default function Users({ me, onError }: { me: Perfil; onError: (msg: string) => void }) {
  const [users, setUsers] = useState<Perfil[]>([])
  const [units, setUnits] = useState<Unit[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pinFor, setPinFor] = useState<Perfil | null>(null)
  const [busy, setBusy] = useState(false)
  const [ok, setOk] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [u, un] = await Promise.all([
      supabase!.from('profiles').select('*').order('nome'),
      supabase!.from('units').select('id, nome').order('nome'),
    ])
    if (u.error) return onError(u.error.message)
    setUsers((u.data ?? []) as Perfil[])
    setUnits((un.data ?? []) as Unit[])
  }, [onError])

  useEffect(() => {
    load()
  }, [load])

  function toggle<T>(list: T[], v: T) {
    return list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  }

  async function save() {
    if (!draft) return
    if (!draft.nome.trim()) return onError('Informe o nome.')
    if (draft.papel !== 'master' && !draft.unit_ids.length) return onError('Escolha pelo menos uma unidade.')
    setBusy(true)
    try {
      if (draft.user_id) {
        const { error } = await supabase!.from('profiles').update({
          nome: draft.nome.trim(), papel: draft.papel, modulos: draft.modulos, unit_ids: draft.unit_ids, ativo: draft.ativo,
        }).eq('user_id', draft.user_id)
        if (error) throw error
        setOk(`${draft.nome} atualizado.`)
      } else {
        await callAdmin({ action: 'create', nome: draft.nome, login: draft.login, pin: draft.pin, papel: draft.papel, modulos: draft.modulos, unit_ids: draft.unit_ids })
        setOk(`Usuário criado. Login: ${draft.login.trim().toLowerCase()} · PIN: ${draft.pin}`)
      }
      setDraft(null)
      await load()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function resetPin(u: Perfil, pin: string) {
    try {
      await callAdmin({ action: 'reset-pin', user_id: u.user_id, pin })
      setOk(`PIN de ${u.nome} trocado para ${pin}.`)
      setPinFor(null)
    } catch (e) {
      onError((e as Error).message)
    }
  }

  async function remove(u: Perfil) {
    try {
      await callAdmin({ action: 'delete', user_id: u.user_id })
      setOk(`${u.nome} removido.`)
      await load()
    } catch (e) {
      onError((e as Error).message)
    }
  }

  const unitNames = (ids: string[]) => ids.map((id) => units.find((u) => u.id === id)?.nome).filter(Boolean).join(', ')

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>Usuários ({users.length})</h2>
          {!draft && <button className="primary" onClick={() => { setOk(null); setDraft(novo()) }}>+ Novo usuário</button>}
        </div>
        {ok && <div className="hint">{ok}</div>}
        <ul className="closing-list">
          {users.map((u) => (
            <li key={u.user_id} className="unit-row">
              <div>
                <div className="strong">
                  {u.nome} {!u.ativo && <span className="chip chip-high">Desativado</span>}
                </div>
                <div className="small muted">
                  {papelNome(u.papel)}{u.login ? ` · login: ${u.login}` : ''}
                  {u.papel !== 'master' && ` · ${unitNames(u.unit_ids) || 'sem unidade'}`}
                </div>
                {u.papel !== 'master' && (
                  <div className="small muted">{u.modulos.map((m) => MODULOS.find((x) => x.id === m)?.nome).join(', ') || 'nenhum módulo'}</div>
                )}
              </div>
              {u.user_id !== me.user_id && (
                <div className="row-actions wrap">
                  <button className="ghost small" onClick={() => { setOk(null); setDraft({ ...u, login: u.login ?? '', pin: '' }) }}>Editar</button>
                  {u.login && <button className="ghost small" onClick={() => setPinFor(u)}>Trocar PIN</button>}
                  <ConfirmButton label="Remover" onConfirm={() => remove(u)} title="Apaga o acesso desta pessoa" />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {pinFor && <PinForm user={pinFor} onCancel={() => setPinFor(null)} onSave={(pin) => resetPin(pinFor, pin)} />}

      {draft && (
        <section className="card form-grid">
          <h2 className="full">{draft.user_id ? `Editar ${draft.nome}` : 'Novo usuário'}</h2>
          <label className="full">
            Nome
            <input value={draft.nome} placeholder="Ex.: André (gerente Araçá)" onChange={(e) => setDraft({ ...draft, nome: e.target.value })} />
          </label>
          {!draft.user_id && (
            <>
              <label>
                Usuário (para entrar)
                <input value={draft.login} autoCapitalize="none" placeholder="ex.: cozinha.araca"
                  onChange={(e) => setDraft({ ...draft, login: e.target.value.toLowerCase().replace(/\s/g, '') })} />
              </label>
              <label>
                PIN (6 números)
                <input inputMode="numeric" maxLength={6} value={draft.pin} placeholder="000000"
                  onChange={(e) => setDraft({ ...draft, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} />
              </label>
            </>
          )}
          <fieldset className="full choice">
            <legend>Perfil</legend>
            {PAPEIS.map((p) => (
              <label key={p.id} className="check">
                <input type="radio" name="papel" checked={draft.papel === p.id}
                  onChange={() => setDraft({ ...draft, papel: p.id, modulos: [...p.modulos] })} />
                <span><b>{p.nome}</b> <span className="muted small">— {p.desc}</span></span>
              </label>
            ))}
          </fieldset>
          {draft.papel !== 'master' && (
            <>
              <fieldset className="full choice">
                <legend>Unidades</legend>
                {units.map((u) => (
                  <label key={u.id} className="check">
                    <input type="checkbox" checked={draft.unit_ids.includes(u.id)}
                      onChange={() => setDraft({ ...draft, unit_ids: toggle(draft.unit_ids, u.id) })} />
                    <span>{u.nome}</span>
                  </label>
                ))}
              </fieldset>
              <fieldset className="full choice">
                <legend>O que pode acessar</legend>
                {MODULOS.map((m) => (
                  <label key={m.id} className="check">
                    <input type="checkbox" checked={draft.modulos.includes(m.id)}
                      onChange={() => setDraft({ ...draft, modulos: toggle(draft.modulos, m.id) })} />
                    <span><b>{m.nome}</b> <span className="muted small">— {m.desc}</span></span>
                  </label>
                ))}
              </fieldset>
            </>
          )}
          {draft.user_id && (
            <label className="check full">
              <input type="checkbox" checked={draft.ativo} onChange={(e) => setDraft({ ...draft, ativo: e.target.checked })} />
              <span>Acesso ativo</span>
            </label>
          )}
          <div className="full actions">
            <button className="ghost" onClick={() => setDraft(null)}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={save}>{busy ? 'Salvando…' : draft.user_id ? 'Salvar' : 'Criar usuário'}</button>
          </div>
        </section>
      )}
    </>
  )
}

function PinForm({ user, onCancel, onSave }: { user: Perfil; onCancel: () => void; onSave: (pin: string) => void }) {
  const [pin, setPin] = useState('')
  return (
    <section className="card form-grid">
      <h2 className="full">Novo PIN para {user.nome}</h2>
      <label className="full">
        PIN (6 números)
        <input inputMode="numeric" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} />
      </label>
      <div className="full actions">
        <button className="ghost" onClick={onCancel}>Cancelar</button>
        <button className="primary" disabled={pin.length !== 6} onClick={() => onSave(pin)}>Trocar PIN</button>
      </div>
    </section>
  )
}
