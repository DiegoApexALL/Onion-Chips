// Edge Function "admin-users" — o master cria usuários (login + PIN), troca PIN e remove usuários.
// Login vira um e-mail interno <login>@usuarios.onioncost.app (ninguém recebe e-mail).
// Editar nome, papel, módulos e unidades é feito direto na tabela profiles (RLS: só o master da conta).
// Cada master só mexe nos usuários da própria conta. Quem tem admin_sistema também cria contas novas
// (ação "create-conta": conta + configurações + listas de contagem padrão + o master dela).
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

async function criarUsuario(u: {
  login: unknown; pin: unknown; nome: unknown; papel: unknown; modulos: unknown; unit_ids: string[]; conta_id: string
}) {
  const login = String(u.login ?? '').trim().toLowerCase()
  if (!/^[a-z0-9._-]{3,30}$/.test(login)) throw new UserError('Usuário: use de 3 a 30 letras minúsculas, números, ponto, traço ou _.')
  const pin = String(u.pin ?? '')
  checkPin(pin)
  const nome = String(u.nome ?? '').trim()
  if (!nome) throw new UserError('Informe o nome.')
  const papel = ['master', 'gerente', 'equipe'].includes(String(u.papel)) ? String(u.papel) : 'equipe'
  const modulos = (Array.isArray(u.modulos) ? u.modulos : []).filter((m: string) => MODULOS.includes(m))
  const { data: exists } = await admin.from('profiles').select('user_id').eq('login', login).maybeSingle()
  if (exists) throw new UserError('Já existe um usuário com esse login.')
  const created = await admin.auth.admin.createUser({
    email: `${login}@${DOMAIN}`, password: pin, email_confirm: true, user_metadata: { nome, login },
  })
  if (created.error) throw new UserError(created.error.message)
  const ins = await admin.from('profiles').insert({
    user_id: created.data.user.id, nome, login, papel, modulos, unit_ids: u.unit_ids, ativo: true, conta_id: u.conta_id,
  })
  if (ins.error) {
    await admin.auth.admin.deleteUser(created.data.user.id)
    throw ins.error
  }
  return created.data.user.id
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const auth = token ? await admin.auth.getUser(token) : null
    if (!auth || auth.error || !auth.data.user) return json({ error: 'Entre no app.' }, 401)
    const { data: me } = await admin.from('profiles').select('papel, ativo, conta_id, admin_sistema').eq('user_id', auth.data.user.id).maybeSingle()
    if (!me?.ativo || me.papel !== 'master') return json({ error: 'Só o usuário master pode gerenciar usuários.' }, 403)

    /** Usuário alvo precisa ser da mesma conta de quem pede */
    async function daMinhaConta(userId: string) {
      const { data } = await admin.from('profiles').select('conta_id').eq('user_id', userId).maybeSingle()
      if (!data || data.conta_id !== me!.conta_id) throw new UserError('Usuário não encontrado.')
    }

    const b = await req.json().catch(() => ({}))
    if (b.action === 'create') {
      // só unidades da própria conta
      const pedidas = Array.isArray(b.unit_ids) ? b.unit_ids.map(String) : []
      const { data: minhas } = pedidas.length
        ? await admin.from('units').select('id').eq('conta_id', me.conta_id).in('id', pedidas)
        : { data: [] as { id: string }[] }
      const userId = await criarUsuario({
        login: b.login, pin: b.pin, nome: b.nome, papel: b.papel, modulos: b.modulos,
        unit_ids: (minhas ?? []).map((u) => u.id), conta_id: me.conta_id,
      })
      return json({ ok: true, user_id: userId })
    }
    if (b.action === 'create-conta') {
      if (!me.admin_sistema) return json({ error: 'Só o administrador do sistema cria contas.' }, 403)
      const contaNome = String(b.conta_nome ?? '').trim()
      if (!contaNome) throw new UserError('Informe o nome da conta.')
      const { data: conta, error } = await admin.from('contas').insert({ nome: contaNome }).select('id').single()
      if (error) throw error
      try {
        const set = await admin.from('settings').insert({ conta_id: conta.id })
        if (set.error) throw set.error
        // listas de contagem padrão (copiadas da conta de quem cria, sem os itens)
        const { data: listas } = await admin.from('count_lists').select('nome, dias_semana, todos_itens, ordem, ativo, chave').eq('conta_id', me.conta_id)
        if (listas?.length) {
          const ins = await admin.from('count_lists').insert(listas.map((l) => ({ ...l, conta_id: conta.id })))
          if (ins.error) throw ins.error
        }
        const userId = await criarUsuario({
          login: b.login, pin: b.pin, nome: b.nome, papel: 'master', modulos: MODULOS, unit_ids: [], conta_id: conta.id,
        })
        return json({ ok: true, conta_id: conta.id, user_id: userId })
      } catch (e) {
        await admin.from('count_lists').delete().eq('conta_id', conta.id)
        await admin.from('settings').delete().eq('conta_id', conta.id)
        await admin.from('contas').delete().eq('id', conta.id)
        throw e
      }
    }
    if (b.action === 'reset-pin') {
      const pin = String(b.pin ?? '')
      checkPin(pin)
      await daMinhaConta(String(b.user_id))
      const r = await admin.auth.admin.updateUserById(String(b.user_id), { password: pin })
      if (r.error) throw new UserError(r.error.message)
      return json({ ok: true })
    }
    if (b.action === 'delete') {
      if (String(b.user_id) === auth.data.user.id) throw new UserError('Você não pode remover o próprio usuário.')
      await daMinhaConta(String(b.user_id))
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
