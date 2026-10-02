import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { initStore, loadExamples, store, supabase, type StoreMode } from './lib/store'
import type { Ingredient, Recipe } from './lib/types'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Ingredients from './pages/Ingredients'
import Recipes from './pages/Recipes'

type Tab = 'dashboard' | 'ingredients' | 'recipes'
const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Painel' },
  { id: 'ingredients', label: 'Ingredientes' },
  { id: 'recipes', label: 'Receitas' },
]

export default function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [authReady, setAuthReady] = useState(!supabase)
  const [tab, setTab] = useState<Tab>('dashboard')
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<StoreMode | null>(null)

  useEffect(() => {
    initStore().then(setMode)
  }, [])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setAuthReady(true)
    })
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const reload = useCallback(async () => {
    try {
      const [ing, rec] = await Promise.all([store.list('ingredients'), store.list('recipes')])
      setIngredients(ing)
      setRecipes(rec)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const canUse = !supabase || !!session
  useEffect(() => {
    if (canUse && mode) reload()
  }, [canUse, mode, reload])

  async function examples() {
    try {
      await loadExamples()
    } catch (e) {
      setError((e as Error).message)
    }
    await reload()
  }

  if (!authReady || !mode) return <div className="center muted">Carregando…</div>
  if (!canUse) return <Auth />

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🧅 Onion Cost</div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {supabase ? (
          <button className="ghost small" onClick={() => supabase!.auth.signOut()}>
            Sair
          </button>
        ) : (
          <span className="badge">{mode === 'cloud' ? 'Salvo na nuvem' : 'Modo local'}</span>
        )}
      </header>
      <main className="content">
        {error && <div className="alert">Erro: {error}</div>}
        {mode === 'local' && (
          <div className="hint">Modo de teste: os dados ficam salvos só neste navegador.</div>
        )}
        {tab === 'dashboard' && <Dashboard ingredients={ingredients} recipes={recipes} onGo={setTab} onExamples={examples} />}
        {tab === 'ingredients' && (
          <Ingredients ingredients={ingredients} recipes={recipes} reload={reload} onError={setError} />
        )}
        {tab === 'recipes' && (
          <Recipes ingredients={ingredients} recipes={recipes} reload={reload} onError={setError} />
        )}
      </main>
    </div>
  )
}
