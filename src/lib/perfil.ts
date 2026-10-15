// Usuários e permissões (tabela profiles). As regras valem no banco (RLS); aqui só decidimos o que mostrar.
import { supabase } from './store'

export type Papel = 'master' | 'gerente' | 'equipe'
export type Modulo = 'custos' | 'fechamentos' | 'notas' | 'contagem' | 'checklist'

export interface Perfil {
  user_id: string
  nome: string
  login: string | null
  papel: Papel
  modulos: Modulo[]
  unit_ids: string[]
  ativo: boolean
}

export const MODULOS: { id: Modulo; nome: string; desc: string }[] = [
  { id: 'custos', nome: 'Custos', desc: 'Painel, ingredientes e receitas' },
  { id: 'fechamentos', nome: 'Fechamentos', desc: 'Fechamento de caixa das suas unidades' },
  { id: 'notas', nome: 'Notas fiscais', desc: 'Empresas, certificados, NF-e e NFC-e' },
  { id: 'contagem', nome: 'Contagem', desc: 'Contagem de itens da loja (em breve)' },
  { id: 'checklist', nome: 'Checklist', desc: 'Tarefas do dia (gerente também cadastra as tarefas)' },
]

export const PAPEIS: { id: Papel; nome: string; desc: string; modulos: Modulo[] }[] = [
  { id: 'master', nome: 'Master', desc: 'Vê e altera tudo, em todas as unidades, e gerencia usuários', modulos: ['custos', 'fechamentos', 'notas', 'contagem', 'checklist'] },
  { id: 'gerente', nome: 'Gerente', desc: 'Fechamentos, contagem e checklist das unidades dele', modulos: ['fechamentos', 'contagem', 'checklist'] },
  { id: 'equipe', nome: 'Equipe (cozinha)', desc: 'Checklist e contagem da unidade', modulos: ['contagem', 'checklist'] },
]

/** Login sem @ vira o e-mail interno criado pela função admin-users. */
export const LOGIN_DOMAIN = 'usuarios.onioncost.app'
export const loginToEmail = (login: string) => (login.includes('@') ? login.trim() : `${login.trim().toLowerCase()}@${LOGIN_DOMAIN}`)

export async function loadPerfil(userId: string): Promise<Perfil | null> {
  const { data, error } = await supabase!.from('profiles').select('*').eq('user_id', userId).maybeSingle()
  if (error) {
    // Banco ainda sem a tabela de perfis: mantém o comportamento antigo (acesso total)
    if (/profiles|does not exist|schema cache/i.test(error.message)) {
      return { user_id: userId, nome: '', login: null, papel: 'master', modulos: MODULOS.map((m) => m.id), unit_ids: [], ativo: true }
    }
    throw error
  }
  return data as Perfil | null
}

export const pode = (p: Perfil | null, m: Modulo) => !!p?.ativo && (p.papel === 'master' || p.modulos.includes(m))
