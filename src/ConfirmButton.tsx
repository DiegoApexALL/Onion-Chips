import { useEffect, useState } from 'react'

/** Botão de excluir em dois toques (sem depender de window.confirm). */
export default function ConfirmButton({ onConfirm, label = 'Excluir', title }: {
  onConfirm: () => void
  label?: string
  title?: string
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 4000)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      type="button"
      className={`danger small${armed ? ' armed' : ''}`}
      title={armed ? title : undefined}
      onClick={() => (armed ? (setArmed(false), onConfirm()) : setArmed(true))}
    >
      {armed ? 'Confirmar?' : label}
    </button>
  )
}
