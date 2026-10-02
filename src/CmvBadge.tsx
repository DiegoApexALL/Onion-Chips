import { CMV_LABEL, cmvStatus, pct, priceRangeForCmv, money } from './lib/cost'
import type { Settings } from './lib/types'

/** CMV com a etiqueta Na meta / Acima / Abaixo. */
export function CmvValue({ cmv, settings }: { cmv: number | null; settings: Settings }) {
  const status = cmvStatus(cmv, settings)
  if (cmv == null || !status) return <>—</>
  return (
    <span className="cmv">
      {pct(cmv)} <span className={`chip chip-${status}`}>{CMV_LABEL[status]}</span>
    </span>
  )
}

/** Faixa de preço que coloca o CMV dentro da meta. */
export function TargetPrice({ unitCost, settings }: { unitCost: number; settings: Settings }) {
  const range = priceRangeForCmv(unitCost, settings)
  if (!range) return <>—</>
  return <>{money(range[0])} a {money(range[1])}</>
}
