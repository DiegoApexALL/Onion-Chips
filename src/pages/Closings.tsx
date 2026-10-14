import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import ConfirmButton from '../ConfirmButton'
import { money } from '../lib/cost'
import {
  conferencia, emptyFechamento, emptyPagamentos, matchUnidade, parseFechamento, PROMPT_META_AI, quebra,
  totalDelivery, totalDespesas, type Fechamento, type Pagamentos, type Unidade,
} from '../lib/fechamento'
import { supabase } from '../lib/store'

interface Company { id: string; name: string; cnpj: string }
interface Row {
  id: string
  unit_id: string
  data: string
  abertura_at: string | null
  fechamento_at: string | null
  responsavel: string | null
  vendas_qtd: number
  vendas_total: number
  valor_abertura: number
  sistema: Pagamentos
  contado: Pagamentos
  maquininhas: Fechamento['maquininhas']
  delivery: Fechamento['delivery']
  despesas: Fechamento['despesas']
  repasse: number
  troco: number
  observacoes: string | null
}

type View = { kind: 'list' } | { kind: 'import' } | { kind: 'edit'; id?: string; unitId: string; f: Fechamento; avisos: string[]; texto?: string }

const FORMAS: [keyof Pagamentos, string][] = [['dinheiro', 'Dinheiro'], ['debito', 'Débito'], ['credito', 'Crédito'], ['pix', 'Pix'], ['outros', 'Outros / apps']]
const n = (v: unknown) => Number(v ?? 0) || 0
const dataBR = (iso: string) => iso.split('-').reverse().join('/')
const mesAtual = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 7)

function rowToFechamento(r: Row, unidade?: Unidade): Fechamento {
  return {
    ...emptyFechamento(),
    unidade_texto: unidade?.nome ?? '',
    data: r.data,
    abertura_at: r.abertura_at?.slice(0, 16) ?? null,
    fechamento_at: r.fechamento_at?.slice(0, 16) ?? null,
    responsavel: r.responsavel ?? '',
    vendas_qtd: n(r.vendas_qtd),
    vendas_total: n(r.vendas_total),
    valor_abertura: n(r.valor_abertura),
    sistema: { ...emptyPagamentos(), ...r.sistema },
    contado: { ...emptyPagamentos(), ...r.contado },
    maquininhas: r.maquininhas ?? [],
    delivery: r.delivery ?? [],
    despesas: r.despesas ?? [],
    repasse: n(r.repasse),
    troco: n(r.troco),
    observacoes: r.observacoes ?? '',
  }
}

function QuebraChip({ v }: { v: number }) {
  if (Math.abs(v) < 1) return <span className="chip chip-ok">Bateu</span>
  return <span className={`chip ${v > 0 ? 'chip-low' : 'chip-high'}`}>{v > 0 ? 'Sobra' : 'Falta'} {money(Math.abs(v))}</span>
}

export default function Closings({ onError }: { onError: (msg: string) => void }) {
  const [units, setUnits] = useState<Unidade[]>([])
  const [companies, setCompanies] = useState<Company[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [mes, setMes] = useState(mesAtual())
  const [view, setView] = useState<View>({ kind: 'list' })
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (!supabase) return
    const [y, m] = mes.split('-').map(Number)
    const fim = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    const [u, c, r] = await Promise.all([
      supabase.from('units').select('*').order('nome'),
      supabase.from('companies').select('id, name, cnpj').order('name'),
      supabase.from('cash_closings').select('*').gte('data', `${mes}-01`).lte('data', fim).order('data', { ascending: false }),
    ])
    const err = u.error ?? c.error ?? r.error
    if (err) {
      onError(/units|cash_closings|does not exist|schema cache/i.test(err.message)
        ? 'As tabelas de fechamento ainda não existem no banco. Rode supabase/fechamentos.sql no Supabase.'
        : err.message)
    }
    const comps = (c.data ?? []) as Company[]
    setCompanies(comps)
    setUnits(((u.data ?? []) as Unidade[]).map((x) => ({ ...x, cnpj: comps.find((k) => k.id === x.company_id)?.cnpj ?? null })))
    setRows((r.data ?? []) as Row[])
    setLoaded(true)
  }, [mes, onError])

  useEffect(() => {
    load()
  }, [load])

  if (!supabase) {
    return <section className="card empty"><h2>Fechamentos</h2><p className="muted">Os fechamentos de caixa precisam do banco na nuvem (Supabase) e de login.</p></section>
  }

  if (view.kind === 'import') {
    return (
      <ImportView
        onCancel={() => setView({ kind: 'list' })}
        onRead={(texto) => {
          const { fechamento, avisos } = parseFechamento(texto)
          const unit = matchUnidade(units, fechamento, texto)
          if (!unit) avisos.push('Não reconheci a unidade: escolha na lista.')
          setView({ kind: 'edit', unitId: unit?.id ?? '', f: fechamento, avisos, texto })
        }}
      />
    )
  }

  if (view.kind === 'edit') {
    return (
      <EditView
        key={view.id ?? 'novo'}
        view={view}
        units={units}
        existing={rows}
        onCancel={() => setView({ kind: 'list' })}
        onSaved={async (data) => {
          setMes(data.slice(0, 7))
          setView({ kind: 'list' })
          await load()
        }}
        onError={onError}
      />
    )
  }

  return (
    <>
      <section className="card closings-head">
        <div className="row-between">
          <h2>Fechamentos de caixa</h2>
          <label className="inline-label">
            Mês
            <input type="month" value={mes} onChange={(e) => e.target.value && setMes(e.target.value)} />
          </label>
        </div>
        <p className="small muted">
          No grupo do WhatsApp, mande as fotos do fechamento e cole o pedido abaixo para a Meta AI. Depois copie a resposta dela e importe aqui.
        </p>
        <div className="actions start">
          <button className="primary" onClick={() => setView({ kind: 'import' })}>Importar fechamento</button>
          <CopyPrompt />
          <button className="ghost" onClick={() => setView({ kind: 'edit', unitId: units[0]?.id ?? '', f: { ...emptyFechamento(), data: new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10) }, avisos: [] })}>
            Lançar à mão
          </button>
        </div>
      </section>

      <MonthSummary units={units} rows={rows} mes={mes} />

      <section className="card">
        <h2>Dias fechados ({rows.length})</h2>
        {loaded && rows.length === 0 && <p className="muted">Nenhum fechamento neste mês.</p>}
        <ul className="closing-list">
          {rows.map((r) => {
            const unit = units.find((u) => u.id === r.unit_id)
            const f = rowToFechamento(r, unit)
            return (
              <li key={r.id}>
                <button className="closing-row" onClick={() => setView({ kind: 'edit', id: r.id, unitId: r.unit_id, f, avisos: [] })}>
                  <span className="strong">{dataBR(r.data)}</span>
                  <span className="muted">{unit?.nome ?? 'Unidade?'}</span>
                  <span className="num">{money(n(r.vendas_total))}</span>
                  <QuebraChip v={quebra(f)} />
                </button>
              </li>
            )
          })}
        </ul>
      </section>

      <UnitsCard units={units} companies={companies} onChanged={load} onError={onError} />
    </>
  )
}

function CopyPrompt() {
  const [copiado, setCopiado] = useState(false)
  const [mostrar, setMostrar] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(PROMPT_META_AI)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2500)
    } catch {
      setMostrar(true)
    }
  }
  return (
    <>
      <button className="ghost" onClick={copy}>{copiado ? 'Pedido copiado!' : 'Copiar pedido para a Meta AI'}</button>
      {mostrar && <textarea className="prompt-box" readOnly rows={8} value={PROMPT_META_AI} onFocus={(e) => e.target.select()} />}
    </>
  )
}

function ImportView({ onCancel, onRead }: { onCancel: () => void; onRead: (texto: string) => void }) {
  const [texto, setTexto] = useState('')
  async function colar() {
    try {
      setTexto(await navigator.clipboard.readText())
    } catch {
      /* sem permissão: a pessoa cola à mão */
    }
  }
  return (
    <section className="card import-view">
      <h2>Importar fechamento</h2>
      <p className="small muted">Cole aqui a resposta da Meta AI (o texto que começa com <b>#FECHAMENTO ONION COST</b>).</p>
      <textarea rows={14} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="#FECHAMENTO ONION COST&#10;UNIDADE: ..." />
      <div className="actions">
        <button className="ghost" onClick={onCancel}>Cancelar</button>
        <button className="ghost" onClick={colar}>Colar</button>
        <button className="primary" disabled={!texto.trim()} onClick={() => onRead(texto)}>Ler texto</button>
      </div>
    </section>
  )
}

function NumInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [txt, setTxt] = useState(value ? String(value).replace('.', ',') : '')
  useEffect(() => {
    setTxt((t) => (Number(t.replace(/\./g, '').replace(',', '.')) === value ? t : value ? String(value).replace('.', ',') : ''))
  }, [value])
  return (
    <input inputMode="decimal" value={txt} placeholder="0,00"
      onChange={(e) => {
        setTxt(e.target.value)
        const v = Number(e.target.value.replace(/\./g, '').replace(',', '.'))
        onChange(Number.isFinite(v) ? v : 0)
      }} />
  )
}

function EditView({ view, units, existing, onCancel, onSaved, onError }: {
  view: Extract<View, { kind: 'edit' }>
  units: Unidade[]
  existing: Row[]
  onCancel: () => void
  onSaved: (data: string) => Promise<void>
  onError: (msg: string) => void
}) {
  const [unitId, setUnitId] = useState(view.unitId)
  const [f, setF] = useState<Fechamento>(view.f)
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof Fechamento>(k: K, v: Fechamento[K]) => setF((x) => ({ ...x, [k]: v }))
  const conf = useMemo(() => conferencia(f), [f])
  const q = quebra(f)

  async function save() {
    if (!unitId) return onError('Escolha a unidade.')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.data)) return onError('Informe a data do fechamento.')
    setBusy(true)
    try {
      const row = {
        unit_id: unitId,
        data: f.data,
        abertura_at: f.abertura_at,
        fechamento_at: f.fechamento_at,
        responsavel: f.responsavel || null,
        vendas_qtd: f.vendas_qtd,
        vendas_total: f.vendas_total,
        valor_abertura: f.valor_abertura,
        sistema: f.sistema,
        contado: f.contado,
        maquininhas: f.maquininhas,
        delivery: f.delivery,
        despesas: f.despesas,
        repasse: f.repasse,
        troco: f.troco,
        observacoes: f.observacoes || null,
        updated_at: new Date().toISOString(),
        ...(view.texto ? { texto_original: view.texto } : {}),
      }
      const { error } = view.id
        ? await supabase!.from('cash_closings').update(row).eq('id', view.id)
        : await supabase!.from('cash_closings').upsert(row, { onConflict: 'unit_id,data' })
      if (error) throw error
      await onSaved(f.data)
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!view.id) return
    const { error } = await supabase!.from('cash_closings').delete().eq('id', view.id)
    if (error) return onError(error.message)
    await onSaved(f.data)
  }

  const duplicado = !view.id && existing.some((r) => r.unit_id === unitId && r.data === f.data)

  return (
    <div className="closing-edit">
      <section className="card form-grid">
        <h2 className="full">{view.id ? 'Fechamento' : 'Conferir e salvar'}</h2>
        {view.avisos.map((a) => <div key={a} className="hint full">{a}</div>)}
        {duplicado && <div className="alert full">Já existe fechamento desta unidade neste dia. Ao salvar, ele será substituído.</div>}
        <label>
          Unidade
          <select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            <option value="">Escolha…</option>
            {units.map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        </label>
        <label>
          Data
          <input type="date" value={f.data} onChange={(e) => set('data', e.target.value)} />
        </label>
        <label>
          Abertura
          <input type="datetime-local" value={f.abertura_at ?? ''} onChange={(e) => set('abertura_at', e.target.value || null)} />
        </label>
        <label>
          Fechamento
          <input type="datetime-local" value={f.fechamento_at ?? ''} onChange={(e) => set('fechamento_at', e.target.value || null)} />
        </label>
        <label>
          Responsável
          <input value={f.responsavel} onChange={(e) => set('responsavel', e.target.value)} />
        </label>
        <label>
          Quantidade de vendas
          <input inputMode="numeric" value={f.vendas_qtd || ''} onChange={(e) => set('vendas_qtd', Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </label>
        <label>
          Total de vendas (PDV)
          <NumInput value={f.vendas_total} onChange={(v) => set('vendas_total', v)} />
        </label>
        <label>
          Valor de abertura (troco inicial)
          <NumInput value={f.valor_abertura} onChange={(v) => set('valor_abertura', v)} />
        </label>
      </section>

      <section className="card">
        <h2>Formas de pagamento</h2>
        <div className="pay-grid">
          <span />
          <span className="small muted">Sistema</span>
          <span className="small muted">Contado</span>
          {FORMAS.map(([k, label]) => (
            <Fragment3 key={k} label={label}
              a={<NumInput value={f.sistema[k]} onChange={(v) => set('sistema', { ...f.sistema, [k]: v })} />}
              b={<NumInput value={f.contado[k]} onChange={(v) => set('contado', { ...f.contado, [k]: v })} />} />
          ))}
        </div>
      </section>

      <ListEditor title="Maquininhas" items={f.maquininhas} onChange={(v) => set('maquininhas', v)}
        blank={{ nome: '', debito: 0, credito: 0, pix: 0 }}
        cols={[['nome', 'Nome', 'text'], ['debito', 'Débito', 'num'], ['credito', 'Crédito', 'num'], ['pix', 'Pix', 'num']]} />
      <ListEditor title="Delivery" items={f.delivery} onChange={(v) => set('delivery', v)}
        blank={{ canal: '', pedidos: 0, valor: 0 }}
        cols={[['canal', 'App', 'text'], ['pedidos', 'Pedidos', 'int'], ['valor', 'Valor', 'num']]} />
      <ListEditor title="Despesas do caixa" items={f.despesas} onChange={(v) => set('despesas', v)}
        blank={{ descricao: '', valor: 0 }}
        cols={[['descricao', 'Descrição', 'text'], ['valor', 'Valor', 'num']]} />

      <section className="card form-grid">
        <label>
          Repasse
          <NumInput value={f.repasse} onChange={(v) => set('repasse', v)} />
        </label>
        <label>
          Troco deixado
          <NumInput value={f.troco} onChange={(v) => set('troco', v)} />
        </label>
        <label className="full">
          Observações
          <textarea rows={2} value={f.observacoes} onChange={(e) => set('observacoes', e.target.value)} />
        </label>
      </section>

      <section className="card">
        <div className="row-between">
          <h2>Conferência</h2>
          <QuebraChip v={q} />
        </div>
        <ul className="conf-list">
          {conf.map((l) => (
            <li key={l.item} className={Math.abs(l.diferenca) < 0.01 ? '' : 'conf-diff'}>
              <span>{l.item}</span>
              <span className="num">{money(l.esperado)} × {money(l.conferido)}</span>
              <span className={`num strong ${Math.abs(l.diferenca) < 0.01 ? 'pos' : l.diferenca > 0 ? 'tone-low' : 'neg'}`}>
                {Math.abs(l.diferenca) < 0.01 ? 'ok' : `${l.diferenca > 0 ? '+' : '−'}${money(Math.abs(l.diferenca))}`}
              </span>
            </li>
          ))}
        </ul>
        <p className="small muted">
          Delivery: {money(totalDelivery(f))} · Balcão: {money(Math.max(0, f.vendas_total - totalDelivery(f)))} · Despesas: {money(totalDespesas(f))}
        </p>
      </section>

      <div className="actions sticky-actions">
        {view.id && <ConfirmButton onConfirm={remove} />}
        <button className="ghost" onClick={onCancel}>Cancelar</button>
        <button className="primary" disabled={busy} onClick={save}>{busy ? 'Salvando…' : 'Salvar fechamento'}</button>
      </div>
    </div>
  )
}

function Fragment3({ label, a, b }: { label: string; a: ReactNode; b: ReactNode }) {
  return (
    <>
      <span className="pay-label">{label}</span>
      {a}
      {b}
    </>
  )
}

type Col<T> = [keyof T & string, string, 'text' | 'num' | 'int']

function ListEditor<T extends object>({ title, items, onChange, blank, cols }: {
  title: string
  items: T[]
  onChange: (v: T[]) => void
  blank: T
  cols: Col<T>[]
}) {
  const upd = (i: number, k: keyof T, v: string | number) => onChange(items.map((it, j) => (j === i ? { ...it, [k]: v } : it)))
  const get = (it: T, k: keyof T) => (it as Record<keyof T, unknown>)[k]
  return (
    <section className="card">
      <div className="row-between">
        <h2>{title}</h2>
        <button className="ghost small" onClick={() => onChange([...items, { ...blank }])}>+ Adicionar</button>
      </div>
      {items.length === 0 && <p className="small muted">Nenhum item.</p>}
      {items.map((it, i) => (
        <div key={i} className="list-row" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr)) auto` }}>
          {cols.map(([k, label, type]) => (
            <label key={k}>
              <span className="small">{label}</span>
              {type === 'text' ? (
                <input value={String(get(it, k) ?? '')} onChange={(e) => upd(i, k, e.target.value)} />
              ) : type === 'int' ? (
                <input inputMode="numeric" value={Number(get(it, k)) || ''} onChange={(e) => upd(i, k, Number(e.target.value.replace(/\D/g, '')) || 0)} />
              ) : (
                <NumInput value={Number(get(it, k)) || 0} onChange={(v) => upd(i, k, v)} />
              )}
            </label>
          ))}
          <button className="danger small" onClick={() => onChange(items.filter((_, j) => j !== i))} aria-label="Remover">×</button>
        </div>
      ))}
    </section>
  )
}

function MonthSummary({ units, rows, mes }: { units: Unidade[]; rows: Row[]; mes: string }) {
  if (!rows.length) return null
  const [y, m] = mes.split('-').map(Number)
  const label = new Date(y, m - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  const porUnidade = units.map((u) => {
    const rs = rows.filter((r) => r.unit_id === u.id).map((r) => rowToFechamento(r, u))
    const vendas = rs.reduce((s, f) => s + f.vendas_total, 0)
    const delivery = new Map<string, { pedidos: number; valor: number }>()
    for (const f of rs) for (const d of f.delivery) {
      const k = d.canal.trim().toUpperCase() || 'DELIVERY'
      const cur = delivery.get(k) ?? { pedidos: 0, valor: 0 }
      delivery.set(k, { pedidos: cur.pedidos + d.pedidos, valor: cur.valor + d.valor })
    }
    const totalDel = [...delivery.values()].reduce((s, d) => s + d.valor, 0)
    const pag = emptyPagamentos()
    for (const f of rs) for (const [k] of FORMAS) pag[k] += f.contado[k]
    return {
      u, dias: rs.length, vendas, totalDel, delivery,
      despesas: rs.reduce((s, f) => s + totalDespesas(f), 0),
      quebra: rs.reduce((s, f) => s + quebra(f), 0),
      pag,
    }
  }).filter((x) => x.dias)

  return (
    <section className="card">
      <h2>Resumo de {label}</h2>
      <div className="unit-summary">
        {porUnidade.map((x) => (
          <article key={x.u.id} className="nfe-month">
            <div className="strong">{x.u.nome}</div>
            <div className="small muted">{x.dias} dia(s) fechado(s)</div>
            <div className="stat-value">{money(x.vendas)}</div>
            <dl>
              <dt>Balcão</dt><dd>{money(Math.max(0, x.vendas - x.totalDel))}</dd>
              {[...x.delivery.entries()].map(([k, d]) => (
                <Fragment2 key={k} dt={`${k} (${d.pedidos})`} dd={money(d.valor)} />
              ))}
              {FORMAS.map(([k, l]) => x.pag[k] ? <Fragment2 key={k} dt={`Recebido em ${l.toLowerCase()}`} dd={money(x.pag[k])} /> : null)}
              <dt>Despesas do caixa</dt><dd>{money(x.despesas)}</dd>
              <dt>Quebra de caixa</dt><dd><QuebraChip v={x.quebra} /></dd>
            </dl>
          </article>
        ))}
      </div>
    </section>
  )
}

function Fragment2({ dt, dd }: { dt: string; dd: string }) {
  return (
    <>
      <dt>{dt}</dt>
      <dd>{dd}</dd>
    </>
  )
}

function UnitsCard({ units, companies, onChanged, onError }: {
  units: Unidade[]
  companies: Company[]
  onChanged: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [edit, setEdit] = useState<Partial<Unidade> | null>(null)

  async function save() {
    if (!edit?.nome?.trim()) return onError('Informe o nome da unidade.')
    const row = { nome: edit.nome.trim(), cidade: edit.cidade?.trim() ?? '', apelidos: edit.apelidos?.trim() || null, company_id: edit.company_id || null }
    const { error } = edit.id
      ? await supabase!.from('units').update(row).eq('id', edit.id)
      : await supabase!.from('units').insert(row)
    if (error) return onError(error.message)
    setEdit(null)
    await onChanged()
  }

  async function remove(u: Unidade) {
    const { error } = await supabase!.from('units').delete().eq('id', u.id)
    if (error) return onError(error.message)
    await onChanged()
  }

  return (
    <section className="card">
      <div className="row-between">
        <h2>Unidades ({units.length})</h2>
        <button className="ghost small" onClick={() => setOpen((v) => !v)}>{open ? 'Fechar' : 'Gerenciar'}</button>
      </div>
      {open && (
        <>
          <ul className="closing-list">
            {units.map((u) => (
              <li key={u.id} className="unit-row">
                <div>
                  <div className="strong">{u.nome}</div>
                  <div className="small muted">{u.cidade}{u.apelidos ? ` · reconhece: ${u.apelidos}` : ''}</div>
                </div>
                <div className="row-actions">
                  <button className="ghost small" onClick={() => setEdit(u)}>Editar</button>
                  <ConfirmButton onConfirm={() => remove(u)} title="Apaga a unidade e os fechamentos dela" />
                </div>
              </li>
            ))}
          </ul>
          {edit ? (
            <div className="form-grid">
              <label>Nome<input value={edit.nome ?? ''} onChange={(e) => setEdit({ ...edit, nome: e.target.value })} /></label>
              <label>Cidade<input value={edit.cidade ?? ''} onChange={(e) => setEdit({ ...edit, cidade: e.target.value })} /></label>
              <label className="full">
                Como aparece nos comprovantes (separe por vírgula)
                <input placeholder="Ex.: ONION CHIPS ARAÇA, MARIO COVAS, 62014797" value={edit.apelidos ?? ''} onChange={(e) => setEdit({ ...edit, apelidos: e.target.value })} />
              </label>
              <label className="full">
                Empresa (CNPJ) para cruzar com as notas fiscais
                <select value={edit.company_id ?? ''} onChange={(e) => setEdit({ ...edit, company_id: e.target.value || null })}>
                  <option value="">Nenhuma</option>
                  {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
              <div className="full actions">
                <button className="ghost" onClick={() => setEdit(null)}>Cancelar</button>
                <button className="primary" onClick={save}>Salvar unidade</button>
              </div>
            </div>
          ) : (
            <button className="ghost small" onClick={() => setEdit({ nome: '', cidade: '', apelidos: '' })}>+ Nova unidade</button>
          )}
        </>
      )}
    </section>
  )
}
