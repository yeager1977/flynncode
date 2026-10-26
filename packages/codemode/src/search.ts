/**
 * Split a query into lowercased search terms. camelCase boundaries are split
 * (`resolveLibrary` -> `resolve library`) and every non-alphanumeric character is a
 * separator, so `resolve-library-id`, `resolveLibraryId`, and `resolve library id` all
 * tokenize alike. Empties and the `*` wildcard are dropped.
 */
export const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*")

/**
 * A term plus its naive singular variants (trailing "s"/"es" stripped), so a plural
 * query term ("issues") still matches indexed text that only carries the singular
 * ("issue"). Matching is one-directional substring containment, so the variants are
 * needed only on the query side; scoring weights are unchanged - each field check
 * passes when ANY form matches.
 */
export const termForms = (term: string): Array<string> => {
  const forms = [term]
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2))
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1))
  return forms
}

/** Query terms, each expanded to its singular forms, ready for `score`. */
export const terms = (query: string): Array<Array<string>> => tokenize(query).map(termForms)

/** Lowercased fields of one searchable entry. */
export type Fields = {
  /** Exact names the entry answers to, e.g. the whole path and its final segment. */
  readonly names: ReadonlyArray<string>
  readonly path: string
  readonly description: string
  /** Every searchable text, including input parameter names and descriptions. */
  readonly searchText: string
}

/**
 * Additive field-weighted scoring, summed across terms: exact name (20) > path
 * substring (8) > description substring (4) > any searchable text (2).
 */
export const score = (query: ReadonlyArray<ReadonlyArray<string>>, fields: Fields): number =>
  query.reduce(
    (total, forms) =>
      total +
      (forms.some((form) => fields.names.includes(form)) ? 20 : 0) +
      (forms.some((form) => fields.path.includes(form)) ? 8 : 0) +
      (forms.some((form) => fields.description.includes(form)) ? 4 : 0) +
      (forms.some((form) => fields.searchText.includes(form)) ? 2 : 0),
    0,
  )

export * as Search from "./search.js"
