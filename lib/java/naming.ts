// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Business-friendly Java names derived from COBOL names: technical prefixes removed,
 * abbreviations expanded, camelCase.
 *
 * The dictionary covers common English abbreviations and a few French ones, because a lot
 * of European mainframe code is written with French data names.
 */

const ABBREV: Record<string, string> = {
  // English
  ACCT: "account", ACC: "account", AMT: "amount", BAL: "balance", AVG: "average", CUST: "customer", XFER: "transfer",
  TXN: "transaction", TXNS: "transactions", INS: "insurance", LEN: "length", NO: "number", NUM: "number", NBR: "number",
  QTY: "quantity", PCT: "percent", RC: "returnCode", RET: "return", REC: "record", DT: "date", SEG: "segment",
  CALC: "calc", INT: "interest", CTR: "counter", TOT: "total", CUM: "cumulative", PREV: "previous", REF: "reference",
  MTH: "month", YR: "year", DESC: "description", ADDR: "address", ID: "id", CODE: "code",
  // French
  CPT: "compte", CPTE: "compte", MT: "montant", MNT: "montant", MTT: "montant", TX: "taux", CLI: "client",
  VIR: "virement", ECH: "echeance", LG: "longueur", MENS: "mensualite", CR: "codeRetour", QTE: "quantite",
  LIB: "libelle", MVT: "mouvement", MVTS: "mouvements", ENR: "enregistrement", PRT: "pret", CTRT: "contrat",
  ANC: "ancien", NOUV: "nouveau", ASSUR: "assurance",
};

const TECH_PREFIX = new Set(["WS", "LK", "LS", "W", "L", "WK", "WRK", "LNK", "WSS", "Z"]);
const GROUP_SUFFIX = new Set(["REC", "RECORD", "DATA", "STRUCT", "ENREG", "ZONE", "E", "ENR"]);

const JAVA_RESERVED = new Set(["abstract", "assert", "boolean", "break", "byte", "case", "catch", "char", "class", "const", "continue", "default", "do", "double", "else", "enum", "extends", "final", "finally", "float", "for", "goto", "if", "implements", "import", "instanceof", "int", "interface", "long", "native", "new", "package", "private", "protected", "public", "return", "short", "static", "strictfp", "super", "switch", "synchronized", "this", "throw", "throws", "transient", "try", "void", "volatile", "while", "var", "record", "sql", "pic", "external"]);

const STOP_WORDS = new Set([
  "A", "AN", "THE", "OF", "FOR", "ON", "IN", "TO", "BY", "AND", "OR", "WITH", "FROM", "AT", "ONE", "EACH",
  "DE", "DES", "DU", "LA", "LE", "LES", "ET", "AU", "AUX", "SUR", "POUR", "PAR", "UN", "UNE", "EN", "D", "L", "DANS", "AVEC", "SELON", "SANS", "OU",
]);

function cap(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function words(name: string): string[] {
  return name.toUpperCase().split(/[-_]+/).filter(Boolean);
}

function expand(w: string): string {
  return ABBREV[w] ?? w.toLowerCase();
}

export function toCamel(parts: string[]): string {
  const ws = parts.map(expand).flatMap((p) => p.split(/(?=[A-Z])/));
  let s = ws.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w.toLowerCase()))).join("");
  s = s.replace(/[^A-Za-z0-9]/g, "");
  if (/^\d/.test(s)) s = "v" + s;
  if (!s) s = "value";
  if (JAVA_RESERVED.has(s)) s = s + "Value";
  return s;
}

/** Field name: technical prefix and the group's common prefix removed. */
export function fieldName(cobol: string, groupPrefix?: string): string {
  let ws = words(cobol);
  if (groupPrefix && cobol.toUpperCase().startsWith(groupPrefix + "-") && ws.length > 1) ws = ws.slice(words(groupPrefix).length);
  while (ws.length > 1 && TECH_PREFIX.has(ws[0])) ws = ws.slice(1);
  return toCamel(ws);
}

/** Common prefix of a group's children (e.g. "ACCT" for ACCT-NUMBER, ACCT-BALANCE). */
export function commonPrefix(names: string[]): string | undefined {
  if (names.length < 2) {
    const w = names[0] ? words(names[0]) : [];
    return w.length > 1 ? w[0] : undefined;
  }
  const first = words(names[0])[0];
  if (names.every((n) => words(n)[0] === first && words(n).length > 1)) return first;
  return undefined;
}

export function className(cobolGroup: string): string {
  let ws = words(cobolGroup);
  while (ws.length > 1 && TECH_PREFIX.has(ws[0])) ws = ws.slice(1);
  if (ws.length > 1 && GROUP_SUFFIX.has(ws[ws.length - 1])) ws = ws.slice(0, -1);
  const name = cap(toCamel(ws));
  return TAKEN_CLASSES.has(name) ? name + "Area" : name;
}

/** Class name of a program, from the first words of its title comment when there is one. */
export function programClassName(programId: string, title?: string): string {
  if (title) {
    const ws = title
      .toUpperCase()
      .replace(/[’']/g, " ")
      .replace(/[^A-Z0-9À-Ü ]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w) && w.length > 1)
      .slice(0, 3);
    const name = ws.map((w) => cap(w.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, ""))).join("");
    if (ws.length >= 2 && /^[A-Z][A-Za-z0-9]*$/.test(name) && !TAKEN_CLASSES.has(name)) return name;
  }
  // PROGRAM-ID such as CALC-INT or PAY#01: keep only what a Java class name allows.
  const id = programId
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => cap(w.toLowerCase()))
    .join("");
  if (!id) return "Program";
  if (/^\d/.test(id)) return "Program" + id;
  return TAKEN_CLASSES.has(id) ? id + "Program" : id;
}

/** Types the generated code imports or uses unqualified: a program class must not reuse them. */
const TAKEN_CLASSES = new Set(["Pic", "Sql", "Row", "Cursor", "Environment", "ProgramExit", "ExternalPrograms", "BigDecimal", "MathContext", "RoundingMode", "String", "Object", "System", "Math", "Integer", "Boolean", "Override"]);

export function methodName(paragraph: string): string {
  let ws = words(paragraph);
  while (ws.length > 1 && /^\d+[A-Z]?$/.test(ws[0])) ws = ws.slice(1);
  const s = toCamel(ws);
  return /^\d/.test(s) ? "paragraph" + s : s;
}

export function constName(cobol: string): string {
  let ws = words(cobol);
  while (ws.length > 1 && TECH_PREFIX.has(ws[0])) ws = ws.slice(1);
  const name = ws.map((w) => expand(w).replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()).join("_").replace(/[^A-Z0-9_]/g, "");
  return /^[A-Z_]/.test(name) ? name : "V_" + name;
}

export function conditionMethod(cobol: string): string {
  return toCamel(words(cobol).filter((w, i, a) => !(i === 0 && a.length > 1 && TECH_PREFIX.has(w))));
}

export function uniq(name: string, used: Set<string>): string {
  let n = name;
  let k = 2;
  while (used.has(n)) n = name + k++;
  used.add(n);
  return n;
}
