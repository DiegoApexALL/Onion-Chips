import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { Session } from '@supabase/supabase-js'
import { initStore, loadExamples, store, supabase, type StoreMode } from './lib/store'
import { DEFAULT_SETTINGS, type Ingredient, type Recipe, type Settings } from './lib/types'
import Auth from './pages/Auth'
import Dashboard from './pages/Dashboard'
import Ingredients from './pages/Ingredients'
import Recipes from './pages/Recipes'

type Tab = 'dashboard' | 'ingredients' | 'recipes'
const isApp = Capacitor.isNativePlatform()

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
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
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
      const [ing, rec, set] = await Promise.all([store.list('ingredients'), store.list('recipes'), store.getSettings()])
      setIngredients(ing)
      setRecipes(rec)
      setSettings(set)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  const canUse = !supabase || !!session
  useEffect(() => {
    if (canUse && mode) reload()
  }, [canUse, mode, reload])

  async function saveSettings(next: Settings) {
    try {
      await store.saveSettings(next)
      setSettings(next)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

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
          <span className="badge">{mode === 'cloud' ? 'Salvo na nuvem' : isApp ? 'Neste celular' : 'Modo local'}</span>
        )}
      </header>
      <main className="content">
        {error && <div className="alert">Erro: {error}</div>}
        {mode === 'local' && !isApp && (
          <div className="hint">Modo de teste: os dados ficam salvos só neste navegador.</div>
        )}
        {tab === 'dashboard' && <Dashboard ingredients={ingredients} recipes={recipes} settings={settings} onSaveSettings={saveSettings} onGo={setTab} onExamples={examples} />}
        {tab === 'ingredients' && (
          <Ingredients ingredients={ingredients} recipes={recipes} reload={reload} onError={setError} />
        )}
        {tab === 'recipes' && (
          <Recipes ingredients={ingredients} recipes={recipes} settings={settings} reload={reload} onError={setError} />
        )}
      </main>
    </div>
  )
}
