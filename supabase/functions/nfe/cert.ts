// Leitura do certificado A1 (.pfx/.p12) com node-forge.
// @deno-types="npm:@types/node-forge@1.3.11"
import forge from 'npm:node-forge@1.3.1'

export class UserError extends Error {}

export interface Pem { cert: string; key: string; subject: string; cnpj: string | null; notAfter: Date }

export function readPfx(pfxB64: string, password: string): Pem {
  let p12: forge.pkcs12.Pkcs12Pfx
  try {
    p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.decode64(pfxB64)), false, password)
  } catch (e) {
    const m = String((e as Error)?.message ?? e)
    if (/password|MAC/i.test(m)) throw new UserError('Senha do certificado incorreta.')
    throw new UserError(`Não foi possível ler o certificado (.pfx): ${m}`)
  }
  const { oids } = forge.pki
  const keyBag = p12.getBags({ bagType: oids.pkcs8ShroudedKeyBag })[oids.pkcs8ShroudedKeyBag]?.[0] ??
    p12.getBags({ bagType: oids.keyBag })[oids.keyBag]?.[0]
  const certs = (p12.getBags({ bagType: oids.certBag })[oids.certBag] ?? []).map((b) => b.cert).filter(Boolean) as forge.pki.Certificate[]
  const key = keyBag?.key as forge.pki.rsa.PrivateKey | undefined
  if (!key || !certs.length) throw new UserError('O arquivo não contém certificado e chave privada (precisa ser um A1 .pfx).')
  const leaf = certs.find((c) => (c.publicKey as forge.pki.rsa.PublicKey).n?.equals(key.n)) ?? certs[0]
  const chain = [leaf, ...certs.filter((c) => c !== leaf && !c.isIssuer(c))]
  const cn = String(leaf.subject.getField('CN')?.value ?? '')
  const cnpj = cn.match(/(\d{14})\s*$/)?.[1] ?? cn.match(/\d{14}/)?.[0] ?? null
  return {
    cert: chain.map((c) => forge.pki.certificateToPem(c)).join(''),
    key: forge.pki.privateKeyInfoToPem(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(key))),
    subject: cn,
    cnpj,
    notAfter: leaf.validity.notAfter,
  }
}
