import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ConfirmButton from '../ConfirmButton'
import type { Perfil } from '../lib/perfil'
import { supabase } from '../lib/store'
import { DIAS, dataCurta, dataLonga, diaSemana, hoje, hora } from '../lib/datas'

interface Unit { id: string; nome: string }
interface Lista { id: string; nome: string; dias_semana: number[]; todos_itens: boolean; ordem: number; ativo: boolean; chave?: string | null }
interface Item {
  id: string
  nome: string
  categoria: string
  medida: string
  unit_ids: string[]
  list_ids: string[]
  estoque_minimo: number | null
  custo: number | null
  ordem: number
  ativo: boolean
  ingredient_id?: string | null
}
interface Count {
  id: string
  item_id: string
  unit_id: string
  data: string
  quantidade: number
  contado_por: string | null
  contado_por_nome: string | null
  contado_em: string
}

const MEDIDAS = ['un', 'kg', 'g', 'L', 'ml', 'cx', 'pct', 'fardo', 'balde', 'saco', 'bandeja']

/** "1,5" ou "1.5" → 1.5; vazio → null; inválido → NaN */
export function parseQtd(s: string): number | null {
  const t = s.trim()
  if (!t) return null
  const n = Number(t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t)
  return Number.isFinite(n) && n >= 0 ? n : NaN
}
const fmtQtd = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 })
const fmtBRL = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const diasTexto = (d: number[]) => (d.length === 7 ? 'todos os dias' : [...d].sort().map((x) => DIAS[x]).join(', '))
const ordenar = (a: Item, b: Item) => a.categoria.localeCompare(b.categoria) || a.ordem - b.ordem || a.nome.localeCompare(b.nome)
const naLista = (i: Item, l: Lista, unitId: string) => i.ativo && i.unit_ids.includes(unitId) && (l.todos_itens || i.list_ids.includes(l.id))

export default function Contagem({ perfil, onError }: { perfil: Perfil; onError: (msg: string) => void }) {
  const [units, setUnits] = useState<Unit[]>([])
  const [unitId, setUnitId] = useState('')
  const [data, setData] = useState(hoje())
  const [lists, setLists] = useState<Lista[]>([])
  const [listId, setListId] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [counts, setCounts] = useState<Count[]>([])
  const [antes, setAntes] = useState<Record<string, Count>>({})
  const [valores, setValores] = useState<Record<string, string>>({})
  const [view, setView] = useState<'contar' | 'cadastro' | 'historico'>('contar')
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [aviso, setAviso] = useState('')
  const inputs = useRef<(HTMLInputElement | null)[]>([])

  const isMaster = perfil.papel === 'master'
  const canManage = isMaster || (perfil.papel === 'gerente' && perfil.modulos.includes('contagem'))

  const loadBase = useCallback(async () => {
    const [u, l, i] = await Promise.all([
      supabase!.from('units').select('id, nome').order('nome'),
      supabase!.from('count_lists').select('*').order('ordem').order('nome'),
      supabase!.from('count_items').select('*').order('categoria').order('ordem').order('nome'),
    ])
    const err = u.error ?? l.error ?? i.error
    if (err) onError(/count_|does not exist|schema cache/i.test(err.message) ? 'As tabelas da contagem ainda não existem no banco (supabase/contagem.sql).' : err.message)
    const us = (u.data ?? []) as Unit[]
    setUnits(us)
    setUnitId((cur) => (cur && us.some((x) => x.id === cur) ? cur : us[0]?.id ?? ''))
    setLists((l.data ?? []) as Lista[])
    setItems(((i.data ?? []) as Item[]).map((x) => ({ ...x, list_ids: x.list_ids ?? [] })))
    setLoaded(true)
  }, [onError])

  const loadCounts = useCallback(async () => {
    if (!unitId) return
    const [dia, ant] = await Promise.all([
      supabase!.from('counts').select('*').eq('unit_id', unitId).eq('data', data),
      supabase!.from('counts').select('*').eq('unit_id', unitId).lt('data', data).order('data', { ascending: false }).limit(1000),
    ])
    const err = dia.error ?? ant.error
    if (err) return onError(err.message)
    setCounts((dia.data ?? []) as Count[])
    const ult: Record<string, Count> = {}
    for (const c of (ant.data ?? []) as Count[]) if (!ult[c.item_id]) ult[c.item_id] = c
    setAntes(ult)
    setValores({})
  }, [unitId, data, onError])

  useEffect(() => {
    loadBase()
  }, [loadBase])
  useEffect(() => {
    loadCounts()
  }, [loadCounts])

  const dow = diaSemana(data)
  const ativas = lists.filter((l) => l.ativo)
  const doDia = ativas.filter((l) => l.dias_semana.includes(dow))
  const visiveis = canManage ? ativas : doDia
  const lista = visiveis.find((l) => l.id === listId) ?? doDia[0] ?? (canManage ? ativas[0] : undefined)

  useEffect(() => {
    setAviso('')
  }, [listId, unitId, data])

  const doc = useMemo(
    () => (lista ? items.filter((i) => naLista(i, lista, unitId)).sort(ordenar) : []),
    [items, lista, unitId],
  )

  if (view === 'cadastro') {
    return (
      <Cadastro items={items} lists={lists} units={isMaster ? units : units.filter((u) => perfil.unit_ids.includes(u.id))}
        isMaster={isMaster} onClose={() => setView('contar')} onChanged={loadBase} onError={onError} />
    )
  }
  if (view === 'historico') {
    return <Historico units={units} lists={ativas} items={items} onClose={() => setView('contar')} onError={onError} />
  }

  const editavel = canManage || data === hoje()
  const salvo = (id: string) => counts.find((c) => c.item_id === id)
  const atual = (id: string): number | null => {
    if (valores[id] !== undefined) {
      const v = parseQtd(valores[id])
      return v === null || Number.isNaN(v) ? null : v
    }
    return salvo(id)?.quantidade ?? null
  }
  const contados = doc.filter((i) => atual(i.id) !== null).length
  const mudados = doc.filter((i) => {
    if (valores[i.id] === undefined) return false
    const v = parseQtd(valores[i.id])
    return v !== null && !Number.isNaN(v) && v !== salvo(i.id)?.quantidade
  })
  const invalidos = doc.filter((i) => valores[i.id] !== undefined && Number.isNaN(parseQtd(valores[i.id])))
  const abaixo = doc.filter((i) => i.estoque_minimo != null && atual(i.id) !== null && atual(i.id)! < i.estoque_minimo)
  const valorEstoque = canManage && doc.some((i) => i.custo) ? doc.reduce((s, i) => s + (atual(i.id) ?? 0) * (i.custo ?? 0), 0) : null
  const categorias = [...new Set(doc.map((i) => i.categoria))]
  const unitNome = units.find((u) => u.id === unitId)?.nome ?? ''

  async function salvar() {
    if (invalidos.length) return onError(`Quantidade inválida em: ${invalidos.map((i) => i.nome).join(', ')}`)
    if (!mudados.length) return
    setBusy(true)
    const rows = mudados.map((i) => ({
      item_id: i.id, unit_id: unitId, data, quantidade: parseQtd(valores[i.id]) as number,
      contado_por: perfil.user_id, contado_por_nome: perfil.nome || null, contado_em: new Date().toISOString(),
    }))
    const { error } = await supabase!.from('counts').upsert(rows, { onConflict: 'item_id,unit_id,data' })
    setBusy(false)
    if (error) return onError(error.message)
    setAviso(`${rows.length} ${rows.length === 1 ? 'item salvo' : 'itens salvos'}.`)
    await loadCounts()
  }

  async function copiarCompras() {
    const linhas = abaixo.map((i) => `• ${i.nome}: ${fmtQtd(atual(i.id)!)} ${i.medida} (mín. ${fmtQtd(i.estoque_minimo!)})`)
    const texto = `${unitNome} — abaixo do mínimo em ${dataCurta(data)}\n${linhas.join('\n')}`
    try {
      await navigator.clipboard.writeText(texto)
      setAviso('Lista copiada. Cole no WhatsApp.')
    } catch {
      window.prompt('Copie a lista:', texto)
    }
  }

  let idx = 0
  return (
    <>
      <section className="card checklist-head">
        <div className="row-between">
          <h2>Contagem</h2>
          {canManage && (
            <div className="row-actions">
              <button className="ghost small" onClick={() => setView('historico')}>Histórico</button>
              <button className="ghost small" onClick={() => setView('cadastro')}>Cadastro</button>
            </div>
          )}
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
            <input type="date" value={data} max={hoje()} onChange={(e) => e.target.value && setData(e.target.value)} />
          </label>
        </div>
        <div className="muted small cap">{dataLonga(data)}{units.length === 1 ? ` · ${units[0].nome}` : ''}</div>
        {visiveis.length > 0 && (
          <div className="day-chips" role="tablist" aria-label="Lista de contagem">
            {visiveis.map((l) => (
              <button key={l.id} type="button" role="tab" aria-selected={lista?.id === l.id}
                className={`day-chip ${lista?.id === l.id ? 'on' : ''}`} onClick={() => setListId(l.id)}
                title={diasTexto(l.dias_semana)}>
                {l.nome}{!l.dias_semana.includes(dow) ? ' · fora do dia' : ''}
              </button>
            ))}
          </div>
        )}
        {doc.length > 0 && (
          <div className="progress" aria-label={`${contados} de ${doc.length} contados`}>
            <div className="progress-bar" style={{ width: `${(contados / doc.length) * 100}%` }} />
            <span>{contados} de {doc.length} contados</span>
          </div>
        )}
        {!editavel && <div className="small muted">Contagem de dia anterior: só o gerente corrige.</div>}
      </section>

      {loaded && !units.length && <section className="card muted">Seu usuário ainda não tem unidade. Peça ao responsável.</section>}
      {loaded && units.length > 0 && !visiveis.length && (
        <section className="card empty"><p className="muted">Nenhuma contagem para este dia.</p></section>
      )}
      {loaded && lista && !doc.length && (
        <section className="card empty">
          <p className="muted">Nenhum item nesta lista para esta unidade.</p>
          {canManage && <button className="primary" onClick={() => setView('cadastro')}>Cadastrar itens</button>}
        </section>
      )}

      {categorias.map((cat) => (
        <section key={cat} className="card">
          <h2>{cat}</h2>
          <ul className="count-list">
            {doc.filter((i) => i.categoria === cat).map((i) => {
              const my = idx++
              const s = salvo(i.id)
              const a = antes[i.id]
              const v = atual(i.id)
              const baixo = i.estoque_minimo != null && v !== null && v < i.estoque_minimo
              const invalido = valores[i.id] !== undefined && Number.isNaN(parseQtd(valores[i.id]))
              return (
                <li key={i.id} className={`count-row ${s ? 'count-done' : ''}`}>
                  <div className="count-info">
                    <label htmlFor={`q-${i.id}`} className="strong">{i.nome}</label>
                    <div className="small muted">
                      {a ? `Antes: ${fmtQtd(a.quantidade)} ${i.medida} (${dataCurta(a.data)})` : 'Sem contagem anterior'}
                      {i.estoque_minimo != null ? ` · mín. ${fmtQtd(i.estoque_minimo)}` : ''}
                    </div>
                    {s && <div className="small muted">Contado {s.contado_por_nome ? `por ${s.contado_por_nome} ` : ''}às {hora(s.contado_em)}</div>}
                    {baixo && <span className="chip chip-high">Abaixo do mínimo</span>}
                  </div>
                  <div className="count-input">
                    <input id={`q-${i.id}`} ref={(el) => { inputs.current[my] = el }} inputMode="decimal" enterKeyHint="next"
                      aria-invalid={invalido} className={invalido ? 'invalid' : ''} disabled={!editavel}
                      placeholder="—" value={valores[i.id] ?? (s ? fmtQtd(s.quantidade) : '')}
                      onChange={(e) => setValores({ ...valores, [i.id]: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          inputs.current[my + 1]?.focus()
                        }
                      }} />
                    <span className="muted small">{i.medida}</span>
                  </div>
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {doc.length > 0 && abaixo.length > 0 && (
        <section className="card">
          <div className="row-between">
            <h2>Abaixo do mínimo ({abaixo.length})</h2>
            <button className="ghost small" onClick={copiarCompras}>Copiar lista</button>
          </div>
          <ul className="closing-list">
            {abaixo.map((i) => (
              <li key={i.id} className="unit-row">
                <span>{i.nome}</span>
                <span className="small"><b>{fmtQtd(atual(i.id)!)}</b> / mín. {fmtQtd(i.estoque_minimo!)} {i.medida}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {doc.length > 0 && editavel && (
        <div className="sticky-actions actions">
          {aviso && <span className="small muted" role="status">{aviso}</span>}
          {valorEstoque !== null && <span className="small muted">Estoque desta lista: <b>{fmtBRL(valorEstoque)}</b></span>}
          <button className="primary" disabled={busy || !mudados.length} onClick={salvar}>
            {busy ? 'Salvando…' : mudados.length ? `Salvar contagem (${mudados.length})` : 'Contagem salva'}
          </button>
        </div>
      )}
    </>
  )
}

function Historico({ units, lists, items, onClose, onError }: {
  units: Unit[]
  lists: Lista[]
  items: Item[]
  onClose: () => void
  onError: (msg: string) => void
}) {
  const [unitId, setUnitId] = useState(units[0]?.id ?? '')
  const [listId, setListId] = useState(lists[0]?.id ?? '')
  const [rows, setRows] = useState<Count[]>([])
  const lista = lists.find((l) => l.id === listId)
  const doc = lista ? items.filter((i) => naLista(i, lista, unitId)).sort(ordenar) : []

  useEffect(() => {
    if (!unitId) return
    const desde = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10)
    supabase!.from('counts').select('*').eq('unit_id', unitId).gte('data', desde).order('data', { ascending: false }).limit(5000)
      .then(({ data, error }) => (error ? onError(error.message) : setRows((data ?? []) as Count[])))
  }, [unitId, onError])

  const ids = new Set(doc.map((i) => i.id))
  const datas = [...new Set(rows.filter((r) => ids.has(r.item_id)).map((r) => r.data))].slice(0, 10)
  const val = (item: string, d: string) => rows.find((r) => r.item_id === item && r.data === d)?.quantidade

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>Histórico da contagem</h2>
          <button className="ghost small" onClick={onClose}>Voltar</button>
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
            Lista
            <select value={listId} onChange={(e) => setListId(e.target.value)}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.nome}</option>)}
            </select>
          </label>
        </div>
        <p className="small muted">Últimas {datas.length || ''} contagens (45 dias). A diferença mostra quanto saiu de um dia para o outro (sem contar as compras).</p>
      </section>
      <section className="card">
        {!datas.length ? (
          <p className="muted">Nenhuma contagem nesta lista ainda.</p>
        ) : (
          <div className="table-wrap">
            <table className="count-table">
              <thead>
                <tr>
                  <th>Item</th>
                  {datas.map((d) => <th key={d} className="num">{dataCurta(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {doc.map((i) => (
                  <tr key={i.id}>
                    <td>{i.nome} <span className="muted small">{i.medida}</span></td>
                    {datas.map((d, k) => {
                      const v = val(i.id, d)
                      const prev = datas[k + 1] ? val(i.id, datas[k + 1]) : undefined
                      const diff = v !== undefined && prev !== undefined ? v - prev : undefined
                      const baixo = v !== undefined && i.estoque_minimo != null && v < i.estoque_minimo
                      return (
                        <td key={d} className={`num ${baixo ? 'neg' : ''}`}>
                          {v === undefined ? '—' : fmtQtd(v)}
                          {diff !== undefined && diff !== 0 && <div className="small muted">{diff > 0 ? '+' : ''}{fmtQtd(diff)}</div>}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  )
}

type ItemDraft = Omit<Item, 'id'> & { id?: string }
type ListaDraft = Omit<Lista, 'id' | 'chave'> & { id?: string }

function Cadastro({ items, lists, units, isMaster, onClose, onChanged, onError }: {
  items: Item[]
  lists: Lista[]
  units: Unit[]
  isMaster: boolean
  onClose: () => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [draft, setDraft] = useState<ItemDraft | null>(null)
  const [ldraft, setLdraft] = useState<ListaDraft | null>(null)
  const [mins, setMins] = useState({ min: '', custo: '' })
  const [busy, setBusy] = useState(false)
  const [filtro, setFiltro] = useState('')
  const categoriasExistentes = useMemo(() => [...new Set(items.map((i) => i.categoria))].sort(), [items])
  const unitNome = (id: string) => units.find((u) => u.id === id)?.nome
  const listNome = (id: string) => lists.find((l) => l.id === id)?.nome
  const especificas = lists.filter((l) => !l.todos_itens)
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])

  const abrir = (i?: Item) => {
    setLdraft(null)
    setDraft(i ? { ...i } : {
      nome: '', categoria: 'Embalagens', medida: 'kg', unit_ids: units.length === 1 ? [units[0].id] : units.map((u) => u.id),
      list_ids: [], estoque_minimo: null, custo: null, ordem: 0, ativo: true,
    })
    setMins({ min: i?.estoque_minimo != null ? fmtQtd(i.estoque_minimo) : '', custo: i?.custo != null ? String(i.custo).replace('.', ',') : '' })
  }

  async function salvarItem() {
    if (!draft) return
    if (!draft.nome.trim()) return onError('Informe o item.')
    if (!draft.unit_ids.length) return onError('Escolha pelo menos uma unidade.')
    const min = parseQtd(mins.min)
    const custo = parseQtd(mins.custo)
    if (Number.isNaN(min) || Number.isNaN(custo)) return onError('Estoque mínimo ou custo inválido.')
    setBusy(true)
    const row = {
      nome: draft.nome.trim(), categoria: draft.categoria.trim() || 'Geral', medida: draft.medida.trim() || 'un',
      unit_ids: draft.unit_ids, list_ids: draft.list_ids, estoque_minimo: min, ordem: draft.ordem, ativo: draft.ativo,
      ...(draft.ingredient_id ? {} : { custo }),
    }
    const { error } = draft.id
      ? await supabase!.from('count_items').update(row).eq('id', draft.id)
      : await supabase!.from('count_items').insert(row)
    setBusy(false)
    if (error) return onError(error.message)
    setDraft(null)
    await onChanged()
  }

  async function salvarLista() {
    if (!ldraft) return
    if (!ldraft.nome.trim()) return onError('Informe o nome da lista.')
    if (!ldraft.dias_semana.length) return onError('Escolha pelo menos um dia da semana.')
    setBusy(true)
    const row = { nome: ldraft.nome.trim(), dias_semana: [...ldraft.dias_semana].sort(), todos_itens: ldraft.todos_itens, ordem: ldraft.ordem, ativo: ldraft.ativo }
    const { error } = ldraft.id
      ? await supabase!.from('count_lists').update(row).eq('id', ldraft.id)
      : await supabase!.from('count_lists').insert(row)
    setBusy(false)
    if (error) return onError(error.message)
    setLdraft(null)
    await onChanged()
  }

  async function remover(tabela: 'count_items' | 'count_lists', id: string) {
    const { error } = await supabase!.from(tabela).delete().eq('id', id)
    if (error) return onError(error.message)
    await onChanged()
  }

  const visiveis = items.filter((i) => !filtro || i.nome.toLowerCase().includes(filtro.toLowerCase())).sort(ordenar)
  const categorias = [...new Set(visiveis.map((i) => i.categoria))]

  return (
    <>
      <section className="card">
        <div className="row-between">
          <h2>Listas de contagem</h2>
          <div className="row-actions">
            <button className="ghost small" onClick={onClose}>Voltar à contagem</button>
            {!ldraft && <button className="ghost small" onClick={() => { setDraft(null); setLdraft({ nome: '', dias_semana: [0, 1, 2, 3, 4, 5, 6], todos_itens: false, ordem: lists.length + 1, ativo: true }) }}>+ Nova lista</button>}
          </div>
        </div>
        <ul className="closing-list">
          {lists.map((l) => (
            <li key={l.id} className="unit-row">
              <div>
                <div className="strong">{l.nome} {!l.ativo && <span className="chip chip-high">Inativa</span>}</div>
                <div className="small muted cap">
                  {diasTexto(l.dias_semana)} · {l.todos_itens ? 'todos os itens' : `${items.filter((i) => i.list_ids.includes(l.id)).length} itens`}
                </div>
              </div>
              <div className="row-actions">
                <button className="ghost small" onClick={() => { setDraft(null); setLdraft({ ...l }) }}>Editar</button>
                <ConfirmButton onConfirm={() => remover('count_lists', l.id)} title="Apaga a lista (os itens e as contagens ficam)" />
              </div>
            </li>
          ))}
        </ul>
      </section>

      {ldraft && (
        <section className="card form-grid">
          <h2 className="full">{ldraft.id ? 'Editar lista' : 'Nova lista'}</h2>
          <label className="full">
            Nome
            <input value={ldraft.nome} placeholder="Ex.: Diária – Proteínas" onChange={(e) => setLdraft({ ...ldraft, nome: e.target.value })} />
          </label>
          <fieldset className="full choice">
            <legend>Dias em que é feita</legend>
            <div className="day-chips">
              {DIAS.map((d, i) => (
                <button key={d} type="button" className={`day-chip ${ldraft.dias_semana.includes(i) ? 'on' : ''}`}
                  onClick={() => setLdraft({ ...ldraft, dias_semana: toggle(ldraft.dias_semana, i) })}>{d}</button>
              ))}
            </div>
          </fieldset>
          <label className="check full">
            <input type="checkbox" checked={ldraft.todos_itens} onChange={(e) => setLdraft({ ...ldraft, todos_itens: e.target.checked })} />
            <span><b>Todos os itens</b> <span className="muted small">— contagem geral: entra todo item ativo da unidade</span></span>
          </label>
          <label className="check full">
            <input type="checkbox" checked={ldraft.ativo} onChange={(e) => setLdraft({ ...ldraft, ativo: e.target.checked })} />
            <span>Lista ativa</span>
          </label>
          <div className="full actions">
            <button className="ghost" onClick={() => setLdraft(null)}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={salvarLista}>{busy ? 'Salvando…' : 'Salvar lista'}</button>
          </div>
        </section>
      )}

      <section className="card">
        <div className="row-between">
          <h2>Itens</h2>
          {!draft && <button className="primary small" onClick={() => abrir()}>+ Novo item</button>}
        </div>
        <p className="small muted">Os ingredientes entram aqui sozinhos (checks de contagem no cadastro de Ingredientes). Cadastre aqui o que não é ingrediente: embalagens, limpeza…</p>
        {items.length > 8 && <input type="search" placeholder="Buscar item" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Buscar item" />}
      </section>

      {draft && (
        <section className="card form-grid">
          <h2 className="full">{draft.id ? 'Editar item' : 'Novo item'}</h2>
          {draft.ingredient_id && (
            <p className="full small muted">Item vindo dos <b>Ingredientes</b>: nome, custo e os checks de contagem diária/semanal são alterados lá.</p>
          )}
          <label className="full">
            Item
            <input value={draft.nome} disabled={!!draft.ingredient_id} placeholder="Ex.: Coxão mole" onChange={(e) => setDraft({ ...draft, nome: e.target.value })} />
          </label>
          <label>
            Categoria
            <input list="cat-contagem" value={draft.categoria} placeholder="Proteínas, Embalagens…" onChange={(e) => setDraft({ ...draft, categoria: e.target.value })} />
            <datalist id="cat-contagem">
              {['Proteínas', 'Congelados', 'Hortifruti', 'Molhos', 'Embalagens', 'Bebidas', 'Limpeza', ...categoriasExistentes].filter((g, i, a) => a.indexOf(g) === i).map((g) => <option key={g} value={g} />)}
            </datalist>
          </label>
          <label>
            Medida
            <input list="medidas-contagem" value={draft.medida} onChange={(e) => setDraft({ ...draft, medida: e.target.value })} />
            <datalist id="medidas-contagem">{MEDIDAS.map((m) => <option key={m} value={m} />)}</datalist>
          </label>
          <label>
            Estoque mínimo (opcional)
            <input inputMode="decimal" value={mins.min} placeholder="Ex.: 5" onChange={(e) => setMins({ ...mins, min: e.target.value })} />
          </label>
          <label>
            Custo por {draft.medida || 'medida'} (R$, opcional)
            <input inputMode="decimal" value={mins.custo} disabled={!!draft.ingredient_id} placeholder="Ex.: 42,90" onChange={(e) => setMins({ ...mins, custo: e.target.value })} />
          </label>
          {especificas.length > 0 && (
            <fieldset className="full choice">
              <legend>Entra nas listas</legend>
              {especificas.filter((l) => !(draft.ingredient_id && l.chave === 'diaria')).map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={draft.list_ids.includes(l.id)} onChange={() => setDraft({ ...draft, list_ids: toggle(draft.list_ids, l.id) })} />
                  <span>{l.nome} <span className="muted small">({diasTexto(l.dias_semana)})</span></span>
                </label>
              ))}
              {lists.some((l) => l.todos_itens) && (
                <span className="small muted">Entra sempre em: {lists.filter((l) => l.todos_itens).map((l) => l.nome).join(', ')}.</span>
              )}
            </fieldset>
          )}
          <fieldset className="full choice">
            <legend>Unidades</legend>
            {units.map((u) => (
              <label key={u.id} className="check">
                <input type="checkbox" checked={draft.unit_ids.includes(u.id)} onChange={() => setDraft({ ...draft, unit_ids: toggle(draft.unit_ids, u.id) })} />
                <span>{u.nome}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Ordem na lista
            <input inputMode="numeric" value={draft.ordem || ''} placeholder="0" onChange={(e) => setDraft({ ...draft, ordem: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={draft.ativo} onChange={(e) => setDraft({ ...draft, ativo: e.target.checked })} />
            <span>Item ativo</span>
          </label>
          <div className="full actions">
            <button className="ghost" onClick={() => setDraft(null)}>Cancelar</button>
            <button className="primary" disabled={busy} onClick={salvarItem}>{busy ? 'Salvando…' : 'Salvar item'}</button>
          </div>
        </section>
      )}

      {items.length === 0 && !draft && <section className="card muted">Nenhum item cadastrado ainda.</section>}
      {categorias.map((c) => (
        <section key={c} className="card">
          <h2>{c}</h2>
          <ul className="closing-list">
            {visiveis.filter((i) => i.categoria === c).map((i) => {
              const editavel = isMaster || i.unit_ids.every((u) => units.some((x) => x.id === u))
              const nomes = i.list_ids.map(listNome).filter(Boolean)
              return (
                <li key={i.id} className="unit-row">
                  <div>
                    <div className="strong">
                      {i.nome} <span className="muted small">({i.medida})</span> {i.ingredient_id && <span className="chip chip-low">Ingrediente</span>} {!i.ativo && <span className="chip chip-high">Inativo</span>}
                    </div>
                    <div className="small muted">
                      {nomes.length ? nomes.join(', ') : 'Só nas listas gerais'}
                      {' · '}{i.unit_ids.map(unitNome).filter(Boolean).join(', ') || 'outras unidades'}
                      {i.estoque_minimo != null ? ` · mín. ${fmtQtd(i.estoque_minimo)}` : ''}
                      {i.custo != null ? ` · ${fmtBRL(i.custo)}/${i.medida}` : ''}
                    </div>
                  </div>
                  {editavel && (
                    <div className="row-actions">
                      <button className="ghost small" onClick={() => abrir(i)}>Editar</button>
                      {!i.ingredient_id && <ConfirmButton onConfirm={() => remover('count_items', i.id)} title="Apaga o item e as contagens dele" />}
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
