import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { costPerBase, money, money4, pct, UNITS } from '../lib/cost'
import { store, supabase } from '../lib/store'
import type { Ingredient, Recipe, Unit } from '../lib/types'

interface Item {
  chave: string
  n_item: number
  emit_doc: string | null
  emit_nome: string | null
  dh_emi: string | null
  codigo: string | null
  descricao: string
  unidade: string | null
  quantidade: number | null
  valor_total: number | null
  desconto: number
}

interface Link { id: string; emit_doc: string; codigo: string; descricao: string | null; ingredient_id: string; fator: number }
interface Price { ingredient_id: string; dh_emi: string | null; emit_nome: string | null; package_price: number; package_qty: number }

interface Produto {
  key: string
  emit_doc: string
  codigo: string
  emit_nome: string
  descricao: string
  unidade: string
  ultimo: Item
  compras: number
  gasto: number
  custoUnit: number // R$ por unidade comercial (uCom), com desconto
}

const BASE: Record<Unit, string> = { g: 'g', kg: 'kg', ml: 'ml', l: 'L', un: 'un' }
const dia = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' }) : '—')
const custoItem = (i: Item) => {
  const q = Number(i.quantidade ?? 0)
  return q > 0 ? (Number(i.valor_total ?? 0) - Number(i.desconto ?? 0)) / q : 0
}
/** Custo por unidade do ingrediente (R$/kg, R$/L, R$/un) — mais fácil de ler que por grama */
const custoPorUnidade = (price: number, qty: number) => (qty > 0 ? price / qty : 0)

/** Tenta descobrir quanto vale 1 unidade da nota a partir da descrição (ex.: "CX 20KG", "OLEO 900ML"). */
export function sugerirFator(descricao: string, unidadeNota: string, unit: Unit): number | null {
  const u = unidadeNota.trim().toUpperCase()
  const direto: Record<string, [number, 'kg' | 'l' | 'un']> = { KG: [1, 'kg'], KGS: [1, 'kg'], G: [0.001, 'kg'], GR: [0.001, 'kg'], L: [1, 'l'], LT: [1, 'l'], ML: [0.001, 'l'], UN: [1, 'un'], UND: [1, 'un'], UNID: [1, 'un'] }
  let qtd: number | null = null
  let dim: 'kg' | 'l' | 'un' | null = null
  if (direto[u] && u !== 'UN' && u !== 'UND' && u !== 'UNID') {
    qtd = direto[u][0]
    dim = direto[u][1]
  } else {
    const m = descricao.toUpperCase().match(/(\d+(?:[.,]\d+)?)\s?(KG|KGS|G|GR|GRS|L|LT|LTS|ML)\b/)
    if (m) {
      const n = Number(m[1].replace(',', '.'))
      const k = m[2].replace(/S$/, '').replace('GR', 'G').replace('LT', 'L')
      qtd = k === 'KG' || k === 'L' ? n : n / 1000
      dim = k === 'KG' || k === 'G' ? 'kg' : 'l'
      const pack = descricao.toUpperCase().match(/(\d+)\s?X\s?\d/) // "12X900ML"
      if (pack) qtd *= Number(pack[1])
    } else if (direto[u]) {
      qtd = direto[u][0]
      dim = direto[u][1]
    }
  }
  if (qtd == null || dim == null) return null
  if (dim === 'un') return unit === 'un' ? qtd : null
  if (dim === 'kg') return unit === 'kg' ? qtd : unit === 'g' ? qtd * 1000 : null
  return unit === 'l' ? qtd : unit === 'ml' ? qtd * 1000 : null
}

const nomeBonito = (s: string) => s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()).replace(/\s+/g, ' ').trim()
const toNum = (s: string) => Number(s.trim().replace(',', '.'))

export default function Compras({ ingredients, recipes, reload, onError }: {
  ingredients: Ingredient[]
  recipes: Recipe[]
  reload: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [items, setItems] = useState<Item[]>([])
  const [links, setLinks] = useState<Link[]>([])
  const [prices, setPrices] = useState<Price[]>([])
  const [loaded, setLoaded] = useState(false)
  const [filtro, setFiltro] = useState<'sem' | 'com'>('sem')
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.all([
      supabase!.from('nfe_items').select('chave, n_item, emit_doc, emit_nome, dh_emi, codigo, descricao, unidade, quantidade, valor_total, desconto')
        .order('dh_emi', { ascending: false }).limit(3000),
      supabase!.from('ingredient_links').select('*'),
      supabase!.from('ingredient_prices').select('ingredient_id, dh_emi, emit_nome, package_price, package_qty').order('dh_emi', { ascending: false }).limit(2000),
    ])
    const err = a.error ?? b.error ?? c.error
    if (err) {
      onError(/nfe_items|ingredient_links|ingredient_prices|schema cache|does not exist/i.test(err.message)
        ? 'As tabelas de compras ainda não existem no banco. Rode o arquivo supabase/compras.sql no Supabase.'
        : err.message)
    } else {
      setItems((a.data ?? []) as Item[])
      setLinks((b.data ?? []).map((l) => ({ ...l, fator: Number(l.fator) })) as Link[])
      setPrices((c.data ?? []).map((p) => ({ ...p, package_price: Number(p.package_price), package_qty: Number(p.package_qty) })) as Price[])
    }
    setLoaded(true)
  }, [onError])

  useEffect(() => {
    load()
  }, [load])

  const produtos = useMemo(() => {
    const map = new Map<string, Produto>()
    for (const i of items) {
      if (!i.emit_doc || !i.codigo) continue
      const key = `${i.emit_doc}|${i.codigo}`
      const p = map.get(key)
      const gasto = Number(i.valor_total ?? 0) - Number(i.desconto ?? 0)
      if (p) {
        p.compras++
        p.gasto += gasto
      } else {
        map.set(key, {
          key, emit_doc: i.emit_doc, codigo: i.codigo, emit_nome: i.emit_nome ?? i.emit_doc, descricao: i.descricao,
          unidade: i.unidade ?? 'UN', ultimo: i, compras: 1, gasto, custoUnit: custoItem(i),
        })
      }
    }
    return [...map.values()]
  }, [items])

  const linkDe = useMemo(() => new Map(links.map((l) => [`${l.emit_doc}|${l.codigo}`, l])), [links])
  const ingDe = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients])

  // Variação do custo de cada ingrediente entre as duas últimas compras vinculadas
  const altas = useMemo(() => {
    const porIng = new Map<string, Price[]>()
    for (const p of prices) porIng.set(p.ingredient_id, [...(porIng.get(p.ingredient_id) ?? []), p])
    const out: { ing: Ingredient; antes: number; agora: number; var: number; ultima: Price; receitas: string[] }[] = []
    for (const [id, ps] of porIng) {
      const ing = ingDe.get(id)
      if (!ing || ps.length < 2) continue
      const agora = custoPorUnidade(ps[0].package_price, ps[0].package_qty)
      const antes = custoPorUnidade(ps[1].package_price, ps[1].package_qty)
      if (antes <= 0) continue
      const v = (agora / antes - 1) * 100
      if (Math.abs(v) < 5) continue
      out.push({ ing, antes, agora, var: v, ultima: ps[0], receitas: recipes.filter((r) => r.items.some((it) => it.ingredient_id === id)).map((r) => r.name) })
    }
    return out.sort((a, b) => b.var - a.var)
  }, [prices, ingDe, recipes])

  const termo = busca.trim().toLowerCase()
  const lista = produtos
    .filter((p) => (filtro === 'com' ? linkDe.has(p.key) : !linkDe.has(p.key)))
    .filter((p) => !termo || `${p.descricao} ${p.emit_nome} ${p.codigo}`.toLowerCase().includes(termo))
  const semVinculo = produtos.filter((p) => !linkDe.has(p.key)).length

  async function desvincular(l: Link) {
    const { error } = await supabase!.from('ingredient_links').delete().eq('id', l.id)
    if (error) return onError(error.message)
    await Promise.all([load(), reload()])
  }

  if (loaded && items.length === 0) {
    return (
      <section className="card empty">
        <h2>Compras pelas notas fiscais</h2>
        <p className="muted">
          Ainda não há itens de notas de compra. Eles chegam sozinhos com as próximas NF-e baixadas da SEFAZ (aba Empresas).
          Depois é só ligar cada produto do fornecedor a um ingrediente uma vez: o custo passa a se atualizar a cada compra.
        </p>
      </section>
    )
  }

  return (
    <>
      {altas.length > 0 && (
        <section className="card">
          <h2>Mudanças de preço</h2>
          <p className="muted small">Comparação entre as duas últimas compras de cada ingrediente (variação a partir de 5%).</p>
          <ul className="note-list">
            {altas.map((a) => (
              <li key={a.ing.id}>
                <div>
                  <div className="strong">{a.ing.name}</div>
                  <div className="small muted">
                    {money(a.antes)}/{BASE[a.ing.unit]} → {money(a.agora)}/{BASE[a.ing.unit]} · {a.ultima.emit_nome ?? 'fornecedor'} em {dia(a.ultima.dh_emi)}
                  </div>
                  {a.receitas.length > 0 && <div className="small">Afeta: {a.receitas.join(', ')}</div>}
                </div>
                <div className={`num strong ${a.var > 0 ? 'tone-high' : 'tone-ok'}`}>{a.var > 0 ? '▲' : '▼'} {pct(Math.abs(a.var))}</div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <div className="row-between">
          <h2>Produtos comprados</h2>
          <nav className="day-chips">
            <button type="button" className={`day-chip${filtro === 'sem' ? ' on' : ''}`} onClick={() => setFiltro('sem')}>Sem vínculo ({semVinculo})</button>
            <button type="button" className={`day-chip${filtro === 'com' ? ' on' : ''}`} onClick={() => setFiltro('com')}>Vinculados ({produtos.length - semVinculo})</button>
          </nav>
        </div>
        <p className="muted small">
          Ligue cada produto da nota ao ingrediente correspondente, uma vez só. A partir daí o custo do ingrediente
          (e das receitas) se atualiza sozinho a cada compra nova.
        </p>
        <input className="search" placeholder="Buscar produto ou fornecedor" value={busca} onChange={(e) => setBusca(e.target.value)} />
        {loaded && lista.length === 0 && (
          <p className="muted">{filtro === 'sem' ? 'Todos os produtos já estão vinculados.' : 'Nenhum produto vinculado ainda.'}</p>
        )}
        <ul className="note-list cost-list">
          {lista.map((p) => {
            const l = linkDe.get(p.key)
            const ing = l ? ingDe.get(l.ingredient_id) : undefined
            return (
              <li key={p.key}>
                <div>
                  <div className="strong">{p.descricao}</div>
                  <div className="small muted">
                    {p.emit_nome} · última compra {dia(p.ultimo.dh_emi)} · {p.compras} compra{p.compras > 1 ? 's' : ''} · {money(p.gasto)} no total
                  </div>
                  {l && ing && (
                    <div className="small">
                      → <b>{ing.name}</b> (1 {p.unidade} = {l.fator.toLocaleString('pt-BR')} {BASE[ing.unit]}) ·{' '}
                      {money(custoPorUnidade(ing.package_price, ing.package_qty))}/{BASE[ing.unit]}
                    </div>
                  )}
                </div>
                <div className="num">{money(p.custoUnit)} / {p.unidade}</div>
                <div className="row-actions cost-actions">
                  <button className="ghost small" onClick={() => setAberto(aberto === p.key ? null : p.key)}>
                    {aberto === p.key ? 'Fechar' : l ? 'Alterar vínculo' : 'Vincular a ingrediente'}
                  </button>
                  {l && <button className="ghost small" onClick={() => desvincular(l)}>Desvincular</button>}
                </div>
                {aberto === p.key && (
                  <VinculoForm produto={p} link={l} ingredients={ingredients} onError={onError}
                    onDone={async () => { setAberto(null); await Promise.all([load(), reload()]) }} />
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </>
  )
}

function VinculoForm({ produto: p, link, ingredients, onDone, onError }: {
  produto: Produto
  link?: Link
  ingredients: Ingredient[]
  onDone: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [ingId, setIngId] = useState(link?.ingredient_id ?? '')
  const [novoNome, setNovoNome] = useState(nomeBonito(p.descricao))
  const [novaUnit, setNovaUnit] = useState<Unit>('kg')
  const [fator, setFator] = useState(link ? String(link.fator).replace('.', ',') : '')
  const [busy, setBusy] = useState(false)
  const novo = ingId === '__novo'
  const ing = ingredients.find((i) => i.id === ingId)
  const unit: Unit = novo ? novaUnit : ing?.unit ?? 'kg'
  const f = toNum(fator)
  const custoNovo = f > 0 ? p.custoUnit / f : null
  const custoAtual = ing ? custoPorUnidade(ing.package_price, ing.package_qty) : null

  // Sugere o fator pela descrição sempre que muda o ingrediente/unidade (se ainda não foi digitado)
  useEffect(() => {
    if (link && ingId === link.ingredient_id) return
    const s = sugerirFator(p.descricao, p.unidade, unit)
    setFator(s ? String(Number(s.toFixed(4))).replace('.', ',') : '')
  }, [ingId, unit, p.descricao, p.unidade, link])

  async function salvar(e: FormEvent) {
    e.preventDefault()
    if (!(f > 0)) return onError(`Informe quanto vale 1 ${p.unidade} em ${BASE[unit]}.`)
    setBusy(true)
    try {
      let ingredientId = ingId
      if (novo) {
        const created = await store.save('ingredients', { name: novoNome.trim(), unit: novaUnit, package_price: p.custoUnit, package_qty: f })
        ingredientId = created.id
      }
      if (!ingredientId) throw new Error('Escolha o ingrediente.')
      const row = { emit_doc: p.emit_doc, codigo: p.codigo, descricao: p.descricao, ingredient_id: ingredientId, fator: f }
      const { error } = link
        ? await supabase!.from('ingredient_links').update(row).eq('id', link.id)
        : await supabase!.from('ingredient_links').insert(row)
      if (error) throw error
      await onDone()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="link-form form-grid" onSubmit={salvar}>
      <label className="full">
        Ingrediente
        <select required value={ingId} onChange={(e) => setIngId(e.target.value)}>
          <option value="" disabled>Escolha…</option>
          <option value="__novo">+ Criar ingrediente novo</option>
          {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name} ({BASE[i.unit]})</option>)}
        </select>
      </label>
      {novo && (
        <>
          <label>
            Nome do ingrediente
            <input required value={novoNome} onChange={(e) => setNovoNome(e.target.value)} />
          </label>
          <label>
            Unidade do ingrediente
            <select value={novaUnit} onChange={(e) => setNovaUnit(e.target.value as Unit)}>
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </label>
        </>
      )}
      {(ing || novo) && (
        <label className="full">
          Quanto vem em 1 {p.unidade} da nota?
          <div className="input-group">
            <span className="muted">1 {p.unidade} =</span>
            <input required inputMode="decimal" placeholder="Ex.: 20" value={fator} onChange={(e) => setFator(e.target.value)} />
            <span className="muted">{BASE[unit]}</span>
          </div>
        </label>
      )}
      {custoNovo !== null && (
        <div className="full hint">
          Custo pela última compra: <b>{money(custoNovo)}/{BASE[unit]}</b> ({money(p.custoUnit)} ÷ {fator} {BASE[unit]})
          {custoAtual !== null && custoAtual > 0 && (
            <> · hoje no cadastro: {money(custoAtual)}/{BASE[unit]} ({custoNovo >= custoAtual ? '+' : ''}{pct((custoNovo / custoAtual - 1) * 100)})</>
          )}
          {ing && <div className="small muted">Por grama/ml/unidade: {money4(costPerBase({ ...ing, package_price: p.custoUnit, package_qty: f }))}</div>}
        </div>
      )}
      <div className="full actions">
        <button className="primary" disabled={busy || !ingId}>{busy ? 'Salvando…' : 'Salvar vínculo'}</button>
      </div>
    </form>
  )
}
