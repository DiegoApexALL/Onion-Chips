import { useCallback, useEffect, useState, type FormEvent } from 'react'
import ConfirmButton from '../ConfirmButton'
import { money } from '../lib/cost'
import { supabase } from '../lib/store'

const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO']

interface Company {
  id: string
  cnpj: string
  name: string
  uf: string
  cert_subject: string | null
  cert_valid_until: string | null
  last_sync_at: string | null
  next_sync_at: string | null
  last_status: string | null
  nfce_sync_at: string | null
  nfce_status: string | null
}

interface MonthInfo { count: number; total: number; cancelled: number }
interface NfceInfo { quantidade: number; canceladas: number; baixadas: number; total_chaves: number; valor: number }
interface Note { chave: string; emit_doc: string | null; emit_nome: string | null; dh_emi: string | null; valor: number | null; situacao: string }

const onlyDigits = (s: string) => s.replace(/\D/g, '')
export const fmtCnpj = (c: string) => c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')

function maskCnpj(v: string) {
  const d = onlyDigits(v).slice(0, 14)
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

function validCnpj(c: string) {
  if (!/^\d{14}$/.test(c) || /^(\d)\1+$/.test(c)) return false
  const dv = (base: string) => {
    let sum = 0
    let w = base.length - 7
    for (const ch of base) {
      sum += Number(ch) * w--
      if (w < 2) w = 9
    }
    const r = sum % 11
    return r < 2 ? 0 : 11 - r
  }
  const d1 = dv(c.slice(0, 12))
  const d2 = dv(c.slice(0, 12) + d1)
  return c.endsWith(`${d1}${d2}`)
}

function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' }).formatToParts(new Date())
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`
}

function monthLabel(m: string) {
  const [y, mo] = m.split('-').map(Number)
  const s = new Date(y, mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const time = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
const dateTime = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? `hoje às ${time(iso)}` : d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

async function callFunction<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase!.functions.invoke('nfe', { body })
  if (error) {
    let msg = error.message
    const res = (error as { context?: Response }).context
    if (res && typeof res.json === 'function') {
      if (res.status === 404) msg = 'A função "nfe" ainda não foi publicada no Supabase (veja o README).'
      try {
        const j = await res.clone().json()
        if (j?.error) msg = j.error
      } catch {
        /* resposta sem JSON */
      }
    } else if (/fetch|send/i.test(msg)) {
      msg = 'Não foi possível falar com a função "nfe". Confira a internet e se ela foi publicada no Supabase.'
    }
    throw new Error(msg)
  }
  return data as T
}

const emptyForm = { name: '', cnpj: '', uf: 'SP' }

export default function Companies({ onError }: { onError: (msg: string) => void }) {
  const [companies, setCompanies] = useState<Company[]>([])
  const [months, setMonths] = useState<Record<string, MonthInfo>>({})
  const [nfce, setNfce] = useState<Record<string, NfceInfo>>({})
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const month = currentMonth()

  const load = useCallback(async () => {
    if (!supabase) return
    try {
      const [c, d, e] = await Promise.all([
        supabase.from('companies').select('*').order('name'),
        supabase.from('nfe_docs').select('company_id, valor, situacao').eq('competencia', month),
        supabase.from('nfce_resumo').select('*').eq('competencia', month),
      ])
      if (c.error) throw c.error
      if (d.error) throw d.error
      const nf: Record<string, NfceInfo> = {}
      for (const r of e.data ?? []) {
        nf[r.company_id] = {
          quantidade: Number(r.quantidade), canceladas: Number(r.canceladas), baixadas: Number(r.baixadas),
          total_chaves: Number(r.total_chaves), valor: Number(r.valor),
        }
      }
      setNfce(nf)
      setCompanies(c.data ?? [])
      const m: Record<string, MonthInfo> = {}
      for (const n of d.data ?? []) {
        const cur = (m[n.company_id] ??= { count: 0, total: 0, cancelled: 0 })
        if (n.situacao === 'autorizada') {
          cur.count++
          cur.total += Number(n.valor ?? 0)
        } else if (n.situacao === 'cancelada') cur.cancelled++
      }
      setMonths(m)
    } catch (e) {
      const msg = (e as Error).message
      onError(/companies|nfe_docs|schema cache|does not exist/i.test(msg)
        ? 'As tabelas de empresas ainda não existem no banco. Rode o arquivo supabase/empresas.sql no Supabase (veja o README).'
        : msg)
    } finally {
      setLoaded(true)
    }
  }, [month, onError])

  useEffect(() => {
    load()
  }, [load])

  if (!supabase) {
    return (
      <section className="card empty">
        <h2>Cadastro Empresas</h2>
        <p className="muted">A consulta de notas fiscais precisa do banco na nuvem (Supabase) e de login. Ela não funciona no modo local.</p>
      </section>
    )
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const cnpj = onlyDigits(form.cnpj)
    if (!validCnpj(cnpj)) return onError('CNPJ inválido. Confira os 14 números.')
    setBusy(true)
    try {
      const row = { name: form.name.trim(), cnpj, uf: form.uf }
      const { error } = editingId
        ? await supabase!.from('companies').update(row).eq('id', editingId)
        : await supabase!.from('companies').insert(row)
      if (error) throw error.code === '23505' ? new Error('Esse CNPJ já está cadastrado.') : error
      setForm(emptyForm)
      setEditingId(null)
      await load()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  function edit(c: Company) {
    setEditingId(c.id)
    setForm({ name: c.name, cnpj: maskCnpj(c.cnpj), uf: c.uf })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function remove(c: Company) {
    const { error } = await supabase!.from('companies').delete().eq('id', c.id)
    if (error) onError(error.message)
    await load()
  }

  return (
    <>
      <form className="card form-grid" onSubmit={submit}>
        <h2 className="full">{editingId ? 'Editar empresa' : 'Nova empresa'}</h2>
        <label className="full">
          Nome
          <input required placeholder="Ex.: Onion Chips Ltda" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          CNPJ
          <input required inputMode="numeric" placeholder="00.000.000/0000-00" value={form.cnpj}
            onChange={(e) => setForm({ ...form, cnpj: maskCnpj(e.target.value) })} />
        </label>
        <label>
          Estado (UF)
          <select value={form.uf} onChange={(e) => setForm({ ...form, uf: e.target.value })}>
            {UFS.map((u) => <option key={u}>{u}</option>)}
          </select>
        </label>
        <div className="full actions">
          {editingId && (
            <button type="button" className="ghost" onClick={() => { setEditingId(null); setForm(emptyForm) }}>
              Cancelar
            </button>
          )}
          <button className="primary" disabled={busy}>{editingId ? 'Salvar' : 'Adicionar'}</button>
        </div>
      </form>

      <section className="company-list">
        <h2>Empresas ({companies.length})</h2>
        {loaded && companies.length === 0 && <p className="card muted">Nenhuma empresa cadastrada.</p>}
        {companies.map((c) => (
          <CompanyCard key={c.id} company={c} month={month} info={months[c.id]} nfce={nfce[c.id]} onEdit={() => edit(c)}
            onRemove={() => remove(c)} onChanged={load} onError={onError} />
        ))}
      </section>
    </>
  )
}

function CompanyCard({ company: c, month, info, nfce, onEdit, onRemove, onChanged, onError }: {
  company: Company
  month: string
  info?: MonthInfo
  nfce?: NfceInfo
  onEdit: () => void
  onRemove: () => void
  onChanged: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [consulting, setConsulting] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [showCert, setShowCert] = useState(false)
  const [notes, setNotes] = useState<Note[] | null>(null)

  const certOk = !!c.cert_valid_until && new Date(c.cert_valid_until).getTime() > Date.now()
  const certExpiresSoon = certOk && new Date(c.cert_valid_until!).getTime() - Date.now() < 30 * 86400_000
  const waitUntil = c.next_sync_at && new Date(c.next_sync_at).getTime() > Date.now() ? c.next_sync_at : null

  async function consult() {
    setConsulting(true)
    setStatus('Buscando os dados mais recentes…')
    try {
      let res: { status: string; pending: boolean; fetched: number }
      let rounds = 0
      let fetched = 0
      do {
        res = await callFunction({ action: 'consult', company_id: c.id })
        fetched += res.fetched
        if (res.pending) setStatus(`Baixando notas… ${fetched} até agora`)
      } while (res.pending && ++rounds < 5)
      setStatus(null)
      setNotes(null)
      await onChanged()
    } catch (e) {
      setStatus(null)
      onError(`${c.name}: ${(e as Error).message}`)
    } finally {
      setConsulting(false)
    }
  }

  async function toggleNotes() {
    if (notes) return setNotes(null)
    const { data, error } = await supabase!.from('nfe_docs')
      .select('chave, emit_doc, emit_nome, dh_emi, valor, situacao')
      .eq('company_id', c.id).eq('competencia', month).order('dh_emi', { ascending: false })
    if (error) return onError(error.message)
    setNotes(data ?? [])
  }

  return (
    <article className="card company">
      <div className="row-between">
        <div>
          <h3>{c.name}</h3>
          <div className="muted small">{fmtCnpj(c.cnpj)} · {c.uf}</div>
        </div>
        <div className="row-actions">
          <button className="ghost small" onClick={onEdit}>Editar</button>
          <ConfirmButton onConfirm={onRemove} title="Apaga a empresa, o certificado e as notas baixadas" />
        </div>
      </div>

      <div className="nfe-blocks">
        <div className="nfe-month">
        <div className="muted small">Notas recebidas em {monthLabel(month)}</div>
        <div className="stat-value">{info?.count ?? 0}</div>
        <div className="small">
          {money(info?.total ?? 0)}
          {info?.cancelled ? <span className="muted"> · {info.cancelled} cancelada(s), fora da conta</span> : null}
        </div>
        {c.last_sync_at && (
          <div className="muted small">
            Atualizado {dateTime(c.last_sync_at)}
            {waitUntil && ` · próxima atualização automática a partir de ${time(waitUntil)}`}
          </div>
        )}
        {c.last_status && <div className="small">{c.last_status}</div>}
        {!c.last_sync_at && certOk && <div className="muted small">A primeira consulta à SEFAZ acontece automaticamente em até 15 minutos.</div>}
      </div>
        <div className="nfe-month">
          <div className="muted small">NFC-e emitidas em {monthLabel(month)}</div>
          {c.uf !== 'SP' ? (
            <div className="muted small">A consulta de NFC-e emitidas só está disponível para empresas de SP (serviço da SEFAZ-SP).</div>
          ) : (
            <>
              <div className="stat-value">{nfce?.quantidade ?? 0}</div>
              <div className="small">
                {money(nfce?.valor ?? 0)}
                {nfce && nfce.baixadas < nfce.total_chaves && (
                  <span className="muted"> · valor de {nfce.baixadas} de {nfce.total_chaves} notas (o resto está sendo baixado)</span>
                )}
                {nfce?.canceladas ? <span className="muted"> · {nfce.canceladas} cancelada(s), fora da conta</span> : null}
              </div>
              {c.nfce_sync_at && <div className="muted small">Atualizado {dateTime(c.nfce_sync_at)}</div>}
              {c.nfce_status && <div className="small">{c.nfce_status}</div>}
              {!c.nfce_sync_at && certOk && <div className="muted small">A primeira consulta acontece automaticamente em até 15 minutos.</div>}
            </>
          )}
        </div>
      </div>

      {status && <div className="hint">{status}</div>}

      <div className="actions start">
        <button className="primary" disabled={consulting || !certOk} onClick={consult}>
          {consulting ? 'Atualizando…' : 'Atualizar'}
        </button>
        {(info?.count || info?.cancelled) ? (
          <button className="ghost" onClick={toggleNotes}>{notes ? 'Esconder notas' : 'Ver notas'}</button>
        ) : null}
        <button className="ghost" onClick={() => setShowCert((v) => !v)}>Certificado</button>
      </div>

      <div className={`small ${certOk ? (certExpiresSoon ? 'tone-low' : 'muted') : 'tone-high'}`}>
        {certOk
          ? `Certificado A1 válido até ${new Date(c.cert_valid_until!).toLocaleDateString('pt-BR')}${certExpiresSoon ? ' (vence em breve)' : ''}`
          : c.cert_valid_until ? 'Certificado vencido: envie o novo para consultar.' : 'Sem certificado: envie o A1 da empresa para consultar.'}
      </div>

      {showCert && <CertForm company={c} hasCert={!!c.cert_valid_until} onDone={async () => { setShowCert(false); await onChanged() }} onError={onError} />}

      {notes && (
        <ul className="note-list">
          {notes.map((n) => (
            <li key={n.chave} className={n.situacao !== 'autorizada' ? 'muted' : ''}>
              <div>
                <div className="strong">{n.emit_nome ?? 'Emitente não informado'}</div>
                <div className="small muted">
                  {n.dh_emi ? new Date(n.dh_emi).toLocaleDateString('pt-BR') : '—'}
                  {n.emit_doc && n.emit_doc.length === 14 ? ` · ${fmtCnpj(n.emit_doc)}` : ''}
                  {n.situacao !== 'autorizada' && ` · ${n.situacao}`}
                </div>
              </div>
              <div className="num">{n.valor != null ? money(Number(n.valor)) : '—'}</div>
            </li>
          ))}
        </ul>
      )}
    </article>
  )
}

function CertForm({ company, hasCert, onDone, onError }: {
  company: Company
  hasCert: boolean
  onDone: () => Promise<void>
  onError: (msg: string) => void
}) {
  const [file, setFile] = useState<File | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  async function send(e: FormEvent) {
    e.preventDefault()
    if (!file) return
    setBusy(true)
    try {
      const buf = new Uint8Array(await file.arrayBuffer())
      let bin = ''
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
      await callFunction({ action: 'save-cert', company_id: company.id, pfx: btoa(bin), password })
      setPassword('')
      await onDone()
    } catch (err) {
      onError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function removeCert() {
    try {
      await callFunction({ action: 'remove-cert', company_id: company.id })
      await onDone()
    } catch (err) {
      onError((err as Error).message)
    }
  }

  return (
    <form className="cert-form" onSubmit={send}>
      <p className="small muted">
        Envie o certificado digital <strong>A1</strong> (arquivo .pfx ou .p12) de {company.name}. Ele fica guardado criptografado no
        servidor e só é usado para consultar a SEFAZ.
      </p>
      <label>
        Arquivo do certificado
        <input type="file" accept=".pfx,.p12,application/x-pkcs12" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label>
        Senha do certificado
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <div className="actions start">
        <button className="primary" disabled={busy || !file}>{busy ? 'Enviando…' : 'Enviar certificado'}</button>
        {hasCert && <ConfirmButton label="Remover certificado" onConfirm={removeCert} />}
      </div>
    </form>
  )
}
