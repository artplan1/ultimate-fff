/**
 * What the `search` tool returns as its details, for the transcript renderer. Paths are relative to the searched
 * working directory; a content item also carries its line, the line's text and the context around it. A glob limits
 * both kinds to matching paths.
 */
export type SearchResult = {
  kind: 'files' | 'content'
  items: Array<{
    path: string
    /** 1-based line of the match; content searches only. */
    line?: number
    /** The matching line; content searches only. */
    text?: string
    /** Lines before the match, oldest first; content searches only, absent without context. */
    before?: string[]
    /** Lines after the match, in order; content searches only, absent without context. */
    after?: string[]
  }>
  /**
   * Exact for files; for content, the number returned. A full content count would require scanning every file.
   */
  total: number
  /**
   * Further matches that are not in `items`: exact for files; for content 1 only when another match was found beyond
   * the page, so the count is a lower bound rather than a guess from unscanned files.
   */
  more: number
}
