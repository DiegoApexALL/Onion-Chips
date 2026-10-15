import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConfirmButton from '../ConfirmButton'
import type { Perfil } from '../lib/perfil'
import { supabase } from '../lib/store'

interface Unit { id: string; nome: string }
interface Item {
  id: string
  titulo: string
  descricao: string | null
  grupo: string
  unit_ids: string[]
  dias_semana: number[]
  exige_foto: boolean
  ordem: number
  ativo: boolean
}
interface Done {
  id: string
  item_id: string
  unit_id: string
  data: string
  feito_por: string | null
  feito_por_nome: string | null
  feito_em: string
  foto_path: string | null
}

const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const BUCKET = 'checklist'

function hoje() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date())
}
const diaSemana = (iso: string) => new Date(`${iso}T12:00:00`).getDay()
const hora = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dataLonga = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit' })

/** Reduz a foto para no máximo 1280 px e JPEG ~70% (economiza dados e espaço). */
async function comprimir(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((ok, err) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = err
      i.src = url
    })
    const escala = Math.min(1, 1280 / Math.max(img.width, img.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.width * escala)
    canvas.height = Math.round(img.height * escala)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((ok) => canvas.toBlob((b) => ok(b ?? file), 'image/jpeg', 0.7))
  } catch {
    return file
  } finally {
    URL.revokeObjectURL(url)
  }
}

export default function Checklist({ perfil, onError }: { perfil: Perfil; onError: (msg: string) => void }) {
  const [units, setUnits] = useState<Unit[]>([])
  const [unitId, setUnitId] = useState('')
  const [data, setData] = useState(hoje())
  const [items, setItems] = useState<Item[]>([])
  const [done, setDone] = useState<Done[]>([])
  const [fotos, setFotos] = useState<Record<string, string>>({})
  const [view, setView] = useState<'dia' | 'cadastro'>('dia')
  const [loaded, setLoaded] = useState(false)

  const isMaster = perfil.papel === 'master'
  const canManage = isMaster || (perfil.papel === 'gerente' && perfil.modulos.includes('checklist'))

  const loadBase = useCallback(async () => {
    const [u, i] = await Promise.all([
      supabase!.from('units').select('id, nome').order('nome'),
      supabase!.from('checklist_items').select('*').order('grupo').order('ordem').order('titulo'),
    ])
    const err = u.error ?? i.error
    if (err) {
      onError(/checklist|does not exist|schema cache/i.test(err.message) ? 'As tabelas do checklist ainda não existem no banco (supabase/checklist.sql).' : err.message)
    }
    const us = (u.data ?? []) as Unit[]
    setUnits(us)
    setUnitId((cur) => (cur && us.some((x) => x.id === cur) ? cur : us[0]?.id ?? ''))
    setItems((i.data ?? []) as Item[])
    setLoaded(true)
  }, [onError])

  const loadDone = useCallback(async () => {
    if (!unitId) return
    const { data: rows, error } = await supabase!.from('checklist_done').select('*').eq('unit_id', unitId).eq('data', data)
    if (error) return onError(error.message)
    const ds = (rows ?? []) as Done[]
    setDone(ds)
    const paths = ds.map((d) => d.foto_path).filter((p): p is string => !!p)
    if (paths.length) {
      const { data: signed } = await supabase!.storage.from(BUCKET).createSignedUrls(paths, 3600)
      setFotos(Object.fromEntries((signed ?? []).filter((s) => s.signedUrl).map((s) => [s.path ?? '', s.signedUrl as string])))
    } else setFotos({})
  }, [unitId, data, onError])

  useEffect(() => {
    loadBase()
  }, [loadBase])
  useEffect(() => {
    loadDone()
  }, [loadDone])

  if (view === 'cadastro') {
    return (
      <Cadastro items={items} units={isMaster ? units : units.filter((u) => perfil.unit_ids.includes(u.id))} isMaster={isMaster}
        onClose={() => setView('dia')} onChanged={loadBase} onError={onError} />
    )
  }

  const dow = diaSemana(data)
  const doDia = items
    .filter((i) => i.ativo && i.unit_ids.includes(unitId) && i.dias_semana.includes(dow))
    .sort((a, b) => a.grupo.localeCompare(b.grupo) || a.ordem - b.ordem || a.titulo.localeCompare(b.titulo))
  const grupos = [...new Set(doDia.map((i) => i.grupo))]
  const feitos = doDia.filter((i) => done.some((d) => d.item_id === i.id)).length
  const futuro = data > hoje()

  return (
    <>
      <section className="card checklist-head">
        <div className="row-between">
          <h2>Checklist</h2>
          {canManage && <button className="ghost small" onClick={() => setView('cadastro')}>Cadastro de tarefas</button>}
        </div>
        <div className="form-grid">
          {units.length > 1 && (
            <label>
              Unidade
              <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                {units.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
              </select>
            </label>
          )}
          <label>
            Data
            <input type="date" value={data} max={canManage ? undefined : hoje()} onChange={(e) => e.target.value && setData(e.target.value)} />
          </label>
        </div>
        <div className="muted small cap">{dataLonga(data)}{units.length === 1 ? ` · ${units[0].nome}` : ''}</div>
        {doDia.length > 0 && (
          <div className="progress" aria-label={`${feitos} de ${doDia.length} feitos`}>
            <div className="progress-bar" style={{ width: `${(feitos / doDia.length) * 100}%` }} />
            <span>{feitos} de {doDia.length} feitas</span>
          </div>
        )}
      </section>

      {loaded && !units.length && <section className="card muted">Seu usuário ainda não tem unidade. Peça ao responsável.</section>}
      {loaded && units.length > 0 && !doDia.length && (
        <section className="card empty">
          <p className="muted">Nenhuma tarefa para este dia.</p>
          {canManage && <button className="primary" onClick={() => setView('cadastro')}>Cadastrar tarefas</button>}
        </section>
      )}

      {grupos.map((g) => (
        <section key={g} className="card">
          <h2>{g}</h2>
          <ul className="task-list">
            {doDia.filter((i) => i.grupo === g).map((i) => (
              <Task key={i.id} item={i} done={done.find((d) => d.item_id === i.id)} foto={fotos}
                unitId={unitId} data={data} perfil={perfil} canManage={canManage} disabled={futuro}
                onChanged={loadDone} onError={onError} />
            ))}
          </ul>
        </section>
      ))}
    </>
  )
}

function Task({ item, done, foto, unitId, data, perfil, canManage, disabled, onChanged, onError }: {
  item: Item
  done?: Done
  foto: Record<string, string>
  unitId: string
  data: string
  perfil: Perfil
  canManage: boolean
  disabled: boolean
  onChanged: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  async function marcar(file?: File) {
    setBusy(true)
    try {
      let foto_path: string | null = null
      if (file) {
        const blob = await comprimir(file)
        foto_path = `${unitId}/${data}/${item.id}-${crypto.randomUUID().slice(0, 8)}.jpg`
        const up = await supabase!.storage.from(BUCKET).upload(foto_path, blob, { contentType: 'image/jpeg' })
        if (up.error) throw up.error
      }
      const { error } = await supabase!.from('checklist_done').insert({
        item_id: item.id, unit_id: unitId, data, feito_por: perfil.user_id, feito_por_nome: perfil.nome || null, foto_path,
      })
      if (error) throw error.code === '23505' ? new Error('Esta tarefa já foi marcada por outra pessoa.') : error
      await onChanged()
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function desfazer() {
    if (!done) return
    const { error } = await supabase!.from('checklist_done').delete().eq('id', done.id)
    if (error) return onError(error.message)
    await onChanged()
  }

  const podeDesfazer = done && (done.feito_por === perfil.user_id || canManage)

  return (
    <li className={`task ${done ? 'task-done' : ''}`}>
      <div className="task-main">
        <div className="task-check" aria-hidden>{done ? '✓' : ''}</div>
        <div className="task-text">
          <div className="strong">{item.titulo}</div>
          {item.descricao && <div className="small muted">{item.descricao}</div>}
          {item.exige_foto && !done && <span className="chip chip-low">Foto obrigatória</span>}
          {done && (
            <div className="small muted">
              Feito {done.feito_por_nome ? `por ${done.feito_por_nome} ` : ''}às {hora(done.feito_em)}
            </div>
          )}
        </div>
      </div>
      {done?.foto_path && foto[done.foto_path] && (
        <a href={foto[done.foto_path]} target="_blank" rel="noreferrer" className="task-photo">
          <img src={foto[done.foto_path]} alt={`Foto: ${item.titulo}`} loading="lazy" />
        </a>
      )}
      <div className="task-actions">
        {!done && (
          item.exige_foto ? (
            <>
              <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden
                onChange={(e) => e.target.files?.[0] && marcar(e.target.files[0])} />
              <button className="primary" disabled={busy || disabled} onClick={() => fileRef.current?.click()}>
                {busy ? 'Enviando foto…' : 'Tirar foto e concluir'}
              </button>
            </>
          ) : (
            <button className="primary" disabled={busy || disabled} onClick={() => marcar()}>{busy ? 'Salvando…' : 'Feito'}</button>
          )
        )}
        {podeDesfazer && <ConfirmButton label="Desfazer" onConfirm={desfazer} />}
      </div>
    </li>
  )
}

type Draft = Omit<Item, 'id'> & { id?: string }

function Cadastro({ items, units, isMaster, onClose, onChanged, onError }: {
  items: Item[]
  units: Unit[]
  isMaster: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const gruposExistentes = useMemo(() => [...new Set(items.map((i) => i.grupo))].sort(), [items])
  const unitNome = (id: string) => units.find((u) => u.id === id)?.nome

  const novo = (): Draft => ({
    titulo: '', descricao: '', grupo: gruposExistentes[0] ?? 'Abertura', unit_ids: units.length === 1 ? [units[0].id] : [],
    dias_semana: [0, 1, 2, 3, 4, 5, 6], exige_foto: false, ordem: 0, ativo: true,
  })

  async function save() {
    if (!draft) return
    if (!draft.titulo.trim()) return onError('Informe a tarefa.')
    if (!draft.unit_ids.length) return onError('Escolha pelo menos uma unidade.')
    if (!draft.dias_semana.length) return onError('Escolha pelo menos um dia da semana.')
    setBusy(true)
    const row = {
      titulo: draft.titulo.trim(), descricao: draft.descricao?.trim() || null, grupo: draft.grupo.trim() || 'Geral',
      unit_ids: draft.unit_ids, dias_semana: [...draft.dias_semana].sort(), exige_foto: draft.exige_foto, ordem: draft.ordem, ativo: draft.ativo,
    }
    const { error } = draft.id
      ? await supabase!.from('checklist_items').update(row).eq('id', draft.id)
      : await supabase!.from('checklist_items').insert(row)
    setBusy(false)
    if (error) return onError(error.message)
    setDraft(null)
    await onChanged()
  }

  async function remove(i: Item) {
    const { error } = await supabase!.from('checklist_items').delete().eq('id', i.id)
    if (error) return onError(error.message)
    await onChanged()
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const grupos = [...new Set(items.map((i) => i.grupo))].sort()

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>Cadastro de tarefas</h2>
          <div className="row-actions">
            <button className="ghost small" onClick={onClose}>Voltar ao checklist</button>
            {!draft && <button className="primary small" onClick={() => setDraft(novo())}>+ Nova tarefa</button>}
          </div>
        </div>
        <p className="small muted">As tarefas aparecem automaticamente no checklist das unidades e dias escolhidos.</p>
      </section>

      {draft && (
        <section className="card form-grid">
          <h2 className="full">{draft.id ? 'Editar tarefa' : 'Nova tarefa'}</h2>
          <label className="full">
            Tarefa
            <input value={draft.titulo} placeholder="Ex.: Limpar a chapa" onChange={(e) => setDraft({ ...draft, titulo: e.target.value })} />
          </label>
          <label className="full">
            Como fazer (opcional)
            <textarea rows={2} value={draft.descricao ?? ''} onChange={(e) => setDraft({ ...draft, descricao: e.target.value })} />
          </label>
          <label>
            Grupo
            <input list="grupos-checklist" value={draft.grupo} placeholder="Abertura, Fechamento, Limpeza…" onChange={(e) => setDraft({ ...draft, grupo: e.target.value })} />
            <datalist id="grupos-checklist">
              {['Abertura', 'Fechamento', 'Limpeza', 'Recebimento', ...gruposExistentes].filter((g, i, a) => a.indexOf(g) === i).map((g) => <option key={g} value={g} />)}
            </datalist>
          </label>
          <label>
            Ordem na lista
            <input inputMode="numeric" value={draft.ordem || ''} placeholder="0" onChange={(e) => setDraft({ ...draft, ordem: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </label>
          <fieldset className="full choice">
            <legend>Dias da semana</legend>
            <div className="day-chips">
              {DIAS.map((d, i) => (
                <button key={d} type="button" className={`day-chip ${draft.dias_semana.includes(i) ? 'on' : ''}`}
                  onClick={() => setDraft({ ...draft, dias_semana: toggle(draft.dias_semana, i) })}>{d}</button>
              ))}
            </div>
          </fieldset>
          <fieldset className="full choice">
            <legend>Unidades</legend>
            {units.map((u) => (
              <label key={u.id} className="check">
                <input type="checkbox" checked={draft.unit_ids.includes(u.id)} onChange={() => setDraft({ ...draft, unit_ids: toggle(draft.unit_ids, u.id) })} />
                <span>{u.nome}</span>
              </label>
            ))}
          </fieldset>
          <label className="check full">
            <input type="checkbox" checked={draft.exige_foto} onChange={(e) => setDraft({ ...draft, exige_foto: e.target.checked })} />
            <span><b>Exige foto</b> <span className="muted small">— só conclui tirando uma foto na hora</span></span>
          </label>
          <label className="check full">
            <input type="checkbox" checked={draft.ativo} onChange={(e) => setDraft({ ...draft, ativo: e.target.checked })} />
            <span>Tarefa ativa</span>
          </label>
          <div className="full actions">
            <button className="ghost" onClick={() => setDraft(null)}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar tarefa'}</button>
          </div>
        </section>
      )}

      {items.length === 0 && !draft && <section className="card muted">Nenhuma tarefa cadastrada ainda.</section>}
      {grupos.map((g) => (
        <section key={g} className="card">
          <h2>{g}</h2>
          <ul className="closing-list">
            {items.filter((i) => i.grupo === g).sort((a, b) => a.ordem - b.ordem || a.titulo.localeCompare(b.titulo)).map((i) => {
              const editavel = isMaster || i.unit_ids.every((u) => units.some((x) => x.id === u))
              return (
                <li key={i.id} className="unit-row">
                  <div>
                    <div className="strong">
                      {i.titulo} {i.exige_foto && <span className="chip chip-low">Foto</span>} {!i.ativo && <span className="chip chip-high">Inativa</span>}
                    </div>
                    <div className="small muted">
                      {i.dias_semana.length === 7 ? 'Todos os dias' : i.dias_semana.map((d) => DIAS[d]).join(', ')}
                      {' · '}{i.unit_ids.map(unitNome).filter(Boolean).join(', ') || 'outras unidades'}
                    </div>
                  </div>
                  {editavel && (
                    <div className="row-actions">
                      <button className="ghost small" onClick={() => setDraft({ ...i })}>Editar</button>
                      <ConfirmButton onConfirm={() => remove(i)} title="Apaga a tarefa e o histórico dela" />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </>
  )
}
