import { useCallback, useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import type { Session } from '@supabase/supabase-js'
import { initStore, loadExamples, store, supabase, type StoreMode } from './lib/store'
import { DEFAULT_SETTINGS, type Ingredient, type Recipe, type Settings } from './lib/types'
import { loadPerfil, pode, type Modulo, type Perfil } from './lib/perfil'
import Auth from './pages/Auth'
import Checklist from './pages/Checklist'
import Closings from './pages/Closings'
import Companies from './pages/Companies'
import Contagem from './pages/Contagem'
import Dashboard from './pages/Dashboard'
import Ingredients from './pages/Ingredients'
import Recipes from './pages/Recipes'
import Users from './pages/Users'

type Tab = 'dashboard' | 'ingredients' | 'recipes' | 'closings' | 'checklist' | 'contagem' | 'companies' | 'users' | 'soon'
const isApp = Capacitor.isNativePlatform()

// modulo null = só o master
const TABS: { id: Tab; label: string; modulo: Modulo | null }[] = [
  { id: 'dashboard', label: 'Painel', modulo: 'custos' },
  { id: 'ingredients', label: 'Ingredientes', modulo: 'custos' },
  { id: 'recipes', label: 'Receitas', modulo: 'custos' },
  { id: 'closings', label: 'Fechamentos', modulo: 'fechamentos' },
  { id: 'checklist', label: 'Checklist', modulo: 'checklist' },
  { id: 'contagem', label: 'Contagem', modulo: 'contagem' },
  { id: 'companies', label: 'Empresas', modulo: 'notas' },
  { id: 'users', label: 'Usuários', modulo: null },
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
  const [perfil, setPerfil] = useState<Perfil | null>(null)
  const [perfilReady, setPerfilReady] = useState(!supabase)

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
  const userId = session?.user.id
  useEffect(() => {
    if (!supabase || !userId) return
    setPerfilReady(false)
    loadPerfil(userId)
      .then((p) => setPerfil(p))
      .catch((e) => setError((e as Error).message))
      .finally(() => setPerfilReady(true))
  }, [userId])

  // Sem Supabase (modo local) tudo é liberado
  // Checklist e contagem dependem do banco/login: somem no modo local
  const allowed = TABS.filter((t) => (!supabase ? t.id !== 'checklist' && t.id !== 'contagem' : t.modulo ? pode(perfil, t.modulo) : perfil?.papel === 'master'))
  const visibleTab: Tab = allowed.some((t) => t.id === tab) ? tab : allowed[0]?.id ?? 'soon'

  useEffect(() => {
    if (canUse && mode && (!supabase || pode(perfil, 'custos'))) reload()
  }, [canUse, mode, reload, perfil])

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
  if (!perfilReady) return <div className="center muted">Carregando…</div>
  if (supabase && (!perfil || !perfil.ativo)) {
    return (
      <div className="center">
        <div className="card auth">
          <h1>🧅 Onion Cost</h1>
          <p>Seu acesso ainda não foi liberado. Peça ao responsável pelo Onion Cost para ativar o seu usuário.</p>
          <button className="ghost" onClick={() => supabase!.auth.signOut()}>Sair</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🧅 Onion Cost</div>
        <nav className="tabs">
          {allowed.map((t) => (
            <button key={t.id} className={visibleTab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {supabase ? (
          <span className="user-box">
            {perfil?.nome && <span className="small muted">{perfil.nome}</span>}
            <button className="ghost small" onClick={() => supabase!.auth.signOut()}>
              Sair
            </button>
          </span>
        ) : (
          <span className="badge">{mode === 'cloud' ? 'Salvo na nuvem' : isApp ? 'Neste celular' : 'Modo local'}</span>
        )}
      </header>
      <main className="content">
        {error && <div className="alert">Erro: {error}</div>}
        {mode === 'local' && !isApp && (
          <div className="hint">Modo de teste: os dados ficam salvos só neste navegador.</div>
        )}
        {visibleTab === 'dashboard' && <Dashboard ingredients={ingredients} recipes={recipes} settings={settings} onSaveSettings={saveSettings} onGo={setTab} onExamples={examples} onRestored={reload} />}
        {visibleTab === 'ingredients' && (
          <Ingredients ingredients={ingredients} recipes={recipes} reload={reload} onError={setError} />
        )}
        {visibleTab === 'recipes' && (
          <Recipes ingredients={ingredients} recipes={recipes} settings={settings} reload={reload} onError={setError} />
        )}
        {visibleTab === 'closings' && <Closings onError={setError} isMaster={!supabase || perfil?.papel === 'master'} />}
        {visibleTab === 'checklist' && perfil && <Checklist perfil={perfil} onError={setError} />}
        {visibleTab === 'contagem' && perfil && <Contagem perfil={perfil} onError={setError} />}
        {visibleTab === 'companies' && <Companies onError={setError} />}
        {visibleTab === 'users' && perfil && <Users me={perfil} onError={setError} />}
        {visibleTab === 'soon' && (
          <section className="card empty">
            <h2>Olá{perfil?.nome ? `, ${perfil.nome}` : ''}!</h2>
            <p className="muted">Seu usuário ainda não tem nenhuma área liberada. Peça ao responsável.</p>
          </section>
        )}
      </main>
    </div>
  )
}
