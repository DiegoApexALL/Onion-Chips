import { useState } from 'react'
import { compatibleUnits, itemCost, money, pct, recipeCost } from '../lib/cost'
import ConfirmButton from '../ConfirmButton'
import { store } from '../lib/store'
import type { Ingredient, Recipe, RecipeItem } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  recipes: Recipe[]
  reload: () => Promise<void>
  onError: (msg: string) => void
}

type Draft = Omit<Recipe, 'id'> & { id?: string }
const newDraft = (): Draft => ({
  name: '', yield_qty: 10, yield_label: 'pacotes', extra_costs: 0, margin_pct: 100, sale_price: null, notes: '', items: [],
})

export default function Recipes({ ingredients, recipes, reload, onError }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null)

  async function remove(r: Recipe) {
    try {
      await store.remove('recipes', r.id)
      await reload()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  if (draft) {
    return (
      <Editor
        draft={draft}
        ingredients={ingredients}
        onCancel={() => setDraft(null)}
        onSave={async (d) => {
          try {
            await store.save('recipes', d)
            setDraft(null)
            await reload()
          } catch (err) {
            onError((err as Error).message)
          }
        }}
      />
    )
  }

  return (
    <>
      <div className="row-between">
        <h2>Receitas ({recipes.length})</h2>
        <button className="primary" onClick={() => setDraft(newDraft())} disabled={!ingredients.length}>
          + Nova receita
        </button>
      </div>
      {!ingredients.length && <p className="muted">Cadastre ingredientes antes de criar uma receita.</p>}
      <div className="cards">
        {recipes.map((r) => {
          const c = recipeCost(r, ingredients)
          return (
            <article key={r.id} className="card recipe-card">
              <h3>{r.name}</h3>
              <p className="muted small">Rende {r.yield_qty.toLocaleString('pt-BR')} {r.yield_label}</p>
              <dl>
                <dt>Custo do lote</dt><dd>{money(c.batchCost)}</dd>
                <dt>Custo por unidade</dt><dd>{money(c.unitCost)}</dd>
                <dt>Preço sugerido ({pct(r.margin_pct)})</dt><dd className="strong">{money(c.suggestedPrice)}</dd>
                {c.salePrice != null && (
                  <>
                    <dt>Preço atual</dt><dd>{money(c.salePrice)}</dd>
                    <dt>Lucro por unidade</dt>
                    <dd className={c.unitProfit! < 0 ? 'neg' : 'pos'}>
                      {money(c.unitProfit!)} {c.realMarginPct != null && `(${pct(c.realMarginPct)})`}
                    </dd>
                  </>
                )}
              </dl>
              <div className="actions">
                <button className="ghost small" onClick={() => setDraft(structuredClone(r))}>Editar</button>
                <button className="ghost small" onClick={() => setDraft({ ...structuredClone(r), id: undefined, name: `${r.name} (cópia)` })}>Duplicar</button>
                <ConfirmButton onConfirm={() => remove(r)} />
              </div>
            </article>
          )
        })}
      </div>
    </>
  )
}

function Editor({ draft: initial, ingredients, onCancel, onSave }: {
  draft: Draft
  ingredients: Ingredient[]
  onCancel: () => void
  onSave: (d: Draft) => Promise<void>
}) {
  const [d, setD] = useState<Draft>(initial)
  const [busy, setBusy] = useState(false)
  const byId = new Map(ingredients.map((i) => [i.id, i]))
  const c = recipeCost({ ...d, id: d.id ?? '' }, ingredients)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD({ ...d, [k]: v })
  const setItem = (idx: number, patch: Partial<RecipeItem>) =>
    set('items', d.items.map((it, i) => (i === idx ? { ...it, ...patch } : it)))

  function addItem() {
    const ing = ingredients.find((i) => !d.items.some((it) => it.ingredient_id === i.id)) ?? ingredients[0]
    const unit = ing.unit === 'kg' ? 'g' : ing.unit === 'l' ? 'ml' : ing.unit
    set('items', [...d.items, { ingredient_id: ing.id, quantity: 0, unit }])
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    await onSave({ ...d, name: d.name.trim() })
    setBusy(false)
  }

  return (
    <form className="editor" onSubmit={submit}>
      <div className="card form-grid">
        <h2 className="full">{d.id ? 'Editar receita' : 'Nova receita'}</h2>
        <label className="full">
          Nome do produto
          <input required placeholder="Ex.: Onion chips 100g" value={d.name} onChange={(e) => set('name', e.target.value)} />
        </label>
        <label>
          Rendimento
          <div className="input-group">
            <input required type="number" min="0.0001" step="any" value={d.yield_qty}
              onChange={(e) => set('yield_qty', Number(e.target.value))} />
            <input className="narrow" value={d.yield_label} onChange={(e) => set('yield_label', e.target.value)} />
          </div>
        </label>
        <label>
          Outros custos do lote (R$)
          <input type="number" min="0" step="0.01" value={d.extra_costs} title="Gás, energia, mão de obra…"
            onChange={(e) => set('extra_costs', Number(e.target.value))} />
        </label>
        <label>
          Margem desejada (%)
          <input type="number" min="0" step="any" value={d.margin_pct} onChange={(e) => set('margin_pct', Number(e.target.value))} />
        </label>
        <label>
          Preço de venda atual (R$, opcional)
          <input type="number" min="0" step="0.01" value={d.sale_price ?? ''}
            onChange={(e) => set('sale_price', e.target.value === '' ? null : Number(e.target.value))} />
        </label>
      </div>

      <div className="card">
        <div className="row-between">
          <h2>Ingredientes usados</h2>
          <button type="button" className="ghost small" onClick={addItem}>+ Adicionar</button>
        </div>
        {d.items.length === 0 && <p className="muted">Adicione os ingredientes e a quantidade usada no lote.</p>}
        {d.items.map((it, idx) => {
          const ing = byId.get(it.ingredient_id)
          return (
            <div key={idx} className="item-row">
              <select value={it.ingredient_id} onChange={(e) => {
                const next = byId.get(e.target.value)!
                const unit = compatibleUnits(next.unit).includes(it.unit) ? it.unit : next.unit
                setItem(idx, { ingredient_id: next.id, unit })
              }}>
                {!ing && <option value={it.ingredient_id}>(ingrediente excluído)</option>}
                {ingredients.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
              <div className="input-group">
                <input type="number" min="0" step="any" value={it.quantity}
                  onChange={(e) => setItem(idx, { quantity: Number(e.target.value) })} />
                <select value={it.unit} onChange={(e) => setItem(idx, { unit: e.target.value as RecipeItem['unit'] })}>
                  {(ing ? compatibleUnits(ing.unit) : [it.unit]).map((u) => <option key={u} value={u}>{u === 'l' ? 'L' : u}</option>)}
                </select>
              </div>
              <span className="num item-cost">{money(itemCost(ing, it.quantity, it.unit))}</span>
              <button type="button" className="danger small" aria-label="Remover"
                onClick={() => set('items', d.items.filter((_, i) => i !== idx))}>✕</button>
            </div>
          )
        })}
        <label className="full notes">
          Observações
          <textarea rows={2} value={d.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>

      <div className="card summary">
        <dl>
          <dt>Ingredientes</dt><dd>{money(c.ingredientsCost)}</dd>
          <dt>Outros custos</dt><dd>{money(d.extra_costs || 0)}</dd>
          <dt>Custo do lote</dt><dd className="strong">{money(c.batchCost)}</dd>
          <dt>Custo por {d.yield_label.replace(/s$/, '') || 'unidade'}</dt><dd className="strong">{money(c.unitCost)}</dd>
          <dt>Preço sugerido</dt><dd className="strong accent">{money(c.suggestedPrice)}</dd>
          {c.unitProfit != null && (
            <>
              <dt>Lucro com preço atual</dt>
              <dd className={c.unitProfit < 0 ? 'neg' : 'pos'}>
                {money(c.unitProfit)} / un · lote {money(c.unitProfit * d.yield_qty)}
              </dd>
            </>
          )}
        </dl>
        <div className="actions">
          <button type="button" className="ghost" onClick={onCancel}>Cancelar</button>
          <button className="primary" disabled={busy}>Salvar receita</button>
        </div>
      </div>
    </form>
  )
}
