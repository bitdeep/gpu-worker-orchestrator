/**
 * Divide um texto longo em trechos que cabem no limite de um motor, cortando em fim de frase.
 * Puro e determinístico: o mesmo texto sempre vira os mesmos trechos.
 */
export function dividirEmTrechos(texto: string, maximo: number): string[] {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (!limpo) return [];
  if (limpo.length <= maximo) return [limpo];
  const frases = limpo.match(/[^.!?…]+[.!?…]*\s*/g) ?? [limpo];
  const trechos: string[] = [];
  let atual = "";
  for (const frase of frases) {
    const f = frase.trim();
    if (!f) continue;
    if (f.length > maximo) {
      if (atual) { trechos.push(atual.trim()); atual = ""; }
      let pedaco = "";
      for (const palavra of f.split(" ")) {
        if ((pedaco + " " + palavra).trim().length > maximo && pedaco) {
          trechos.push(pedaco.trim());
          pedaco = "";
        }
        pedaco = `${pedaco} ${palavra}`;
      }
      if (pedaco.trim()) atual = pedaco.trim();
      continue;
    }
    if ((atual + " " + f).trim().length > maximo) {
      trechos.push(atual.trim());
      atual = f;
    } else {
      atual = `${atual} ${f}`;
    }
  }
  if (atual.trim()) trechos.push(atual.trim());
  return trechos;
}
