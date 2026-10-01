import { useState, type FormEvent } from 'react'
import { costPerBase, money, money4, UNITS } from '../lib/cost'
import { store } from '../lib/store'
import type { Ingredient, Recipe, Unit } from '../lib/types'

interface Props {
  ingredients: Ingredient[]
  recipes: Recipe[]
  reload: () => Promise<void>
  onError: (msg: string) => void
}

const BASE_LABEL: Record<Unit, string> = { g: 'g', kg: 'g', ml: 'ml', l: 'ml', un: 'un' }
const empty = { name: '', unit: 'kg' as Unit, package_price: '', package_qty: '1' }

export default function Ingredients({ ingredients, recipes, reload, onError }: Props) {
  const [form, setForm] = useState(empty)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      await store.save('ingredients', {
        ...(editingId ? { id: editingId } : {}),
        name: form.name.trim(),
        unit: form.unit,
        package_price: Number(form.package_price),
        package_qty: Number(form.package_qty),
      })
      setForm(empty)
      setEditingId(null)
      await reload()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function edit(i: Ingredient) {
    setEditingId(i.id)
    setForm({ name: i.name, unit: i.unit, package_price: String(i.package_price), package_qty: String(i.package_qty) })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function remove(i: Ingredient) {
    const used = recipes.filter((r) => r.items.some((it) => it.ingredient_id === i.id)).map((r) => r.name)
    const warn = used.length ? `\n\nEle é usado em: ${used.join(', ')}.` : ''
    if (!confirm(`Excluir "${i.name}"?${warn}`)) return
    try {
      await store.remove('ingredients', i.id)
      await reload()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <>
      <form className="card form-grid" onSubmit={submit}>
        <h2 className="full">{editingId ? 'Editar ingrediente' : 'Novo ingrediente'}</h2>
        <label className="full">
          Nome
          <input required placeholder="Ex.: Cebola roxa" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Preço pago (R$)
          <input required type="number" min="0" step="0.01" placeholder="0,00" value={form.package_price}
            onChange={(e) => setForm({ ...form, package_price: e.target.value })} />
        </label>
        <label>
          Quantidade comprada
          <div className="input-group">
            <input required type="number" min="0.0001" step="any" value={form.package_qty}
              onChange={(e) => setForm({ ...form, package_qty: e.target.value })} />
            <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value as Unit })}>
              {UNITS.map((u) => <option key={u.value} value={u.value}>{u.label}</option>)}
            </select>
          </div>
        </label>
        <div className="full actions">
          {editingId && (
            <button type="button" className="ghost" onClick={() => { setEditingId(null); setForm(empty) }}>
              Cancelar
            </button>
          )}
          <button className="primary" disabled={busy}>{editingId ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </form>

      <section className="card">
        <h2>Ingredientes ({ingredients.length})</h2>
        {ingredients.length === 0 ? (
          <p className="muted">Nenhum ingrediente cadastrado.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Nome</th>
                  <th className="num">Compra</th>
                  <th className="num">Custo por unidade</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {ingredients.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    <td className="num">{money(i.package_price)} / {i.package_qty.toLocaleString('pt-BR')} {i.unit}</td>
                    <td className="num">{money4(costPerBase(i))} / {BASE_LABEL[i.unit]}</td>
                    <td className="row-actions">
                      <button className="ghost small" onClick={() => edit(i)}>Editar</button>
                      <button className="danger small" onClick={() => remove(i)}>Excluir</button>
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
