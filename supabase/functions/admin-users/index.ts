// Edge Function "admin-users" — o master cria usuários (login + PIN), troca PIN e remove usuários.
// Login vira um e-mail interno <login>@usuarios.onioncost.app (ninguém recebe e-mail).
// Editar nome, papel, módulos e unidades é feito direto na tabela profiles (RLS: só o master).
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const DOMAIN = 'usuarios.onioncost.app'
const MODULOS = ['custos', 'fechamentos', 'notas', 'contagem', 'checklist']
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } })

class UserError extends Error {}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

function checkPin(pin: string) {
  if (!/^\d{6}$/.test(pin)) throw new UserError('O PIN precisa ter 6 números.')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const auth = token ? await admin.auth.getUser(token) : null
    if (!auth || auth.error || !auth.data.user) return json({ error: 'Entre no app.' }, 401)
    const { data: me } = await admin.from('profiles').select('papel, ativo').eq('user_id', auth.data.user.id).maybeSingle()
    if (!me?.ativo || me.papel !== 'master') return json({ error: 'Só o usuário master pode gerenciar usuários.' }, 403)

    const b = await req.json().catch(() => ({}))
    if (b.action === 'create') {
      const login = String(b.login ?? '').trim().toLowerCase()
      if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw new UserError('Usuário: use de 3 a 30 letras minúsculas, números, ponto, traço ou _.')
      const pin = String(b.pin ?? '')
      checkPin(pin)
      const nome = String(b.nome ?? '').trim()
      if (!nome) throw new UserError('Informe o nome.')
      const papel = ['master', 'gerente', 'equipe'].includes(b.papel) ? b.papel : 'equipe'
      const modulos = (Array.isArray(b.modulos) ? b.modulos : []).filter((m: string) => MODULOS.includes(m))
      const unit_ids = Array.isArray(b.unit_ids) ? b.unit_ids.map(String) : []
      const { data: exists } = await admin.from('profiles').select('user_id').eq('login', login).maybeSingle()
      if (exists) throw new UserError('Já existe um usuário com esse login.')
      const created = await admin.auth.admin.createUser({
        email: `${login}@${DOMAIN}`, password: pin, email_confirm: true, user_metadata: { nome, login },
      })
      if (created.error) throw new UserError(created.error.message)
      const ins = await admin.from('profiles').insert({ user_id: created.data.user.id, nome, login, papel, modulos, unit_ids, ativo: true })
      if (ins.error) {
        await admin.auth.admin.deleteUser(created.data.user.id)
        throw ins.error
      }
      return json({ ok: true, user_id: created.data.user.id })
    }
    if (b.action === 'reset-pin') {
      const pin = String(b.pin ?? '')
      checkPin(pin)
      const r = await admin.auth.admin.updateUserById(String(b.user_id), { password: pin })
      if (r.error) throw new UserError(r.error.message)
      return json({ ok: true })
    }
    if (b.action === 'delete') {
      if (String(b.user_id) === auth.data.user.id) throw new UserError('Você não pode remover o próprio usuário.')
      const r = await admin.auth.admin.deleteUser(String(b.user_id))
      if (r.error) throw new UserError(r.error.message)
      return json({ ok: true })
    }
    throw new UserError('Ação desconhecida.')
  } catch (e) {
    const msg = (e as { message?: string })?.message ?? String(e)
    console.error(msg)
    return json({ error: msg }, e instanceof UserError ? 400 : 500)
  }
})
