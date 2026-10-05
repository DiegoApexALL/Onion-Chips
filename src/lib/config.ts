// Dados do projeto Supabase (Project Settings > API).
// A chave "anon/publishable" é pública por natureza: o banco só libera dados para quem fez login.
// Também podem vir das variáveis VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.
const SUPABASE_URL = ''
const SUPABASE_ANON_KEY = ''

const isArtifact = import.meta.env.VITE_TARGET === 'artifact'

export const supabaseUrl = isArtifact ? '' : (import.meta.env.VITE_SUPABASE_URL as string | undefined) || SUPABASE_URL
export const supabaseKey = isArtifact ? '' : (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || SUPABASE_ANON_KEY
