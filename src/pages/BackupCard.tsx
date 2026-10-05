import { useRef, useState } from 'react'
import { backupFilename, createBackup, parseBackup, restoreBackup, saveBackupFile, type Backup } from '../lib/backup'

const plural = (n: number, um: string, varios: string) => `${n} ${n === 1 ? um : varios}`
const resumo = (b: Backup) => `${plural(b.ingredients.length, 'ingrediente', 'ingredientes')} e ${plural(b.recipes.length, 'receita', 'receitas')}`

/** Exportar e restaurar todos os dados (ingredientes, receitas e meta de CMV). */
export default function BackupCard({ onRestored }: { onRestored: () => Promise<void> }) {
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null)
  const [code, setCode] = useState('')
  const [showCode, setShowCode] = useState(false)
  const [pasted, setPasted] = useState('')
  const [pending, setPending] = useState<Backup | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const say = (text: string, ok = true) => setMsg({ text, ok })

  async function saveFile() {
    setBusy(true)
    try {
      const b = await createBackup()
      const ok = await saveBackupFile(JSON.stringify(b, null, 1), backupFilename())
      if (ok) say(`Backup pronto: ${resumo(b)}.`)
      else await copyCode(b)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      if (err?.code === 'declined' || /cancel/i.test(err?.message ?? '')) say('Salvamento cancelado.', false)
      else await copyCode()
    } finally {
      setBusy(false)
    }
  }

  async function copyCode(existing?: Backup) {
    const b = existing ?? (await createBackup())
    const text = JSON.stringify(b)
    setCode(text)
    setShowCode(true)
    try {
      await navigator.clipboard.writeText(text)
      say('Código do backup copiado. Cole em um lugar seguro (WhatsApp, e-mail, bloco de notas).')
    } catch {
      say('Selecione o código abaixo e copie manualmente.', false)
    }
  }

  function prepare(text: string) {
    try {
      setPending(parseBackup(text))
      setMsg(null)
    } catch (e) {
      setPending(null)
      say((e as Error).message, false)
    }
  }

  async function onFile(file: File | undefined) {
    if (!file) return
    prepare(await file.text())
    if (fileRef.current) fileRef.current.value = ''
  }

  async function confirmRestore() {
    if (!pending) return
    setBusy(true)
    try {
      await restoreBackup(pending)
      await onRestored()
      say(`Backup restaurado: ${resumo(pending)}.`)
      setPending(null)
      setPasted('')
    } catch (e) {
      say(`Não foi possível restaurar: ${(e as Error).message}`, false)
    } finally {
      setBusy(false)
    }
  }

  const when = pending?.exported_at ? new Date(pending.exported_at).toLocaleString('pt-BR') : null

  return (
    <section className="card backup">
      <div>
        <h2>Backup</h2>
        <p className="muted small">Guarde uma cópia de todos os ingredientes, receitas e da meta de CMV. Serve também para passar os dados para outro aparelho.</p>
      </div>

      <div className="actions start">
        <button className="primary" disabled={busy} onClick={saveFile}>Salvar backup</button>
        <button className="ghost" disabled={busy} onClick={() => copyCode()}>Copiar código</button>
      </div>
      {showCode && (
        <label htmlFor="backup-code">
          Código do backup
          <textarea id="backup-code" readOnly rows={3} value={code} onFocus={(e) => e.currentTarget.select()} />
        </label>
      )}

      <div className="restore">
        <h3>Restaurar</h3>
        <div className="actions start">
          <button className="ghost" disabled={busy} onClick={() => fileRef.current?.click()}>Escolher arquivo</button>
          <input ref={fileRef} type="file" accept=".json,application/json,text/plain" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </div>
        <label htmlFor="backup-paste">
          ou cole o código
          <textarea id="backup-paste" rows={2} value={pasted} placeholder='{"app":"onion-cost", ...}'
            onChange={(e) => setPasted(e.target.value)} />
        </label>
        {pasted.trim() && !pending && (
          <div className="actions start">
            <button className="ghost" onClick={() => prepare(pasted)}>Ler código</button>
          </div>
        )}
        {pending && (
          <div className="confirm-box">
            <p>
              Backup {when ? `de ${when} ` : ''}com <strong>{resumo(pending)}</strong>. Restaurar <strong>substitui todos os dados atuais</strong>.
            </p>
            <div className="actions start">
              <button className="ghost" disabled={busy} onClick={() => setPending(null)}>Cancelar</button>
              <button className="danger armed" disabled={busy} onClick={confirmRestore}>Substituir e restaurar</button>
            </div>
          </div>
        )}
      </div>
      {msg && <p className={`small ${msg.ok ? 'pos' : 'neg'}`} role="status">{msg.text}</p>}
    </section>
  )
}
