import { useState } from 'react'
import { money, pct, recipeCost } from '../lib/cost'
import type { Ingredient, Recipe } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  recipes: Recipe[]
  onGo: (tab: 'ingredients' | 'recipes') => void
  onExamples: () => Promise<void>
}

export default function Dashboard({ ingredients, recipes, onGo, onExamples }: Props) {
  const [loading, setLoading] = useState(false)
  const rows = recipes.map((r) => ({ r, c: recipeCost(r, ingredients) }))
  const priced = rows.filter((x) => x.c.realMarginPct != null)
  const avgMargin = priced.length ? priced.reduce((s, x) => s + x.c.realMarginPct!, 0) / priced.length : null

  if (!ingredients.length && !recipes.length) {
    return (
      <div className="card empty">
        <h2>Bem-vindo! 👋</h2>
        <p>Comece cadastrando seus ingredientes (ex.: cebola, óleo, sal, embalagem) com o preço que você paga.</p>
        <p>Depois monte uma receita dizendo quanto de cada ingrediente usa e quantas unidades ela rende.</p>
        <div className="actions center-actions">
          <button className="primary" onClick={() => onGo('ingredients')}>
            Cadastrar ingredientes
          </button>
          <button className="ghost" disabled={loading} onClick={async () => { setLoading(true); await onExamples(); setLoading(false) }}>
            {loading ? 'Carregando…' : 'Carregar exemplo de onion chips'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="stats">
        <Stat label="Ingredientes" value={String(ingredients.length)} />
        <Stat label="Receitas" value={String(recipes.length)} />
        <Stat label="Margem média real" value={avgMargin == null ? '—' : pct(avgMargin)} />
      </div>
      <section className="card">
        <div className="row-between">
          <h2>Resumo das receitas</h2>
          <button className="ghost small" onClick={() => onGo('recipes')}>
            Ver receitas
          </button>
        </div>
        {rows.length === 0 ? (
          <p className="muted">Nenhuma receita ainda.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Receita</th>
                  <th className="num">Custo do lote</th>
                  <th className="num">Custo/un</th>
                  <th className="num">Preço sugerido</th>
                  <th className="num">Preço atual</th>
                  <th className="num">Lucro/un</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ r, c }) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td className="num">{money(c.batchCost)}</td>
                    <td className="num">{money(c.unitCost)}</td>
                    <td className="num">{money(c.suggestedPrice)}</td>
                    <td className="num">{c.salePrice == null ? '—' : money(c.salePrice)}</td>
                    <td className={`num ${c.unitProfit != null && c.unitProfit < 0 ? 'neg' : 'pos'}`}>
                      {c.unitProfit == null ? '—' : money(c.unitProfit)}
                    </td>
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  )
}
