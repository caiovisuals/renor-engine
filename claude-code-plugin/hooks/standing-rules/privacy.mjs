// Privacy markers (feature I8's rule), applied to every stored value before it is put in front of the agent:
//
//   <private>...</private>   the region is removed and a visible `[private]` stands in its place.
//   #norecall                a value that starts with it (after whitespace) is not shown at all.
//
// Copied line for line from PR 861 (claude/i8-privacy-markers at c94aa9d4, cli/lib/privacy.mjs), which is not on main:
// stored values predate any screening, so the hook applies the rule itself, always, whatever RENOR_PRIVACY_MARKERS is.
// tests/claude-code-plugin/standing-rules.test.ts runs PR 861's vectors (tests/fixtures/privacy-markers-861.json).
// When I8 lands, import its module here instead and delete this copy.

/** What stands in place of a stripped region. */
export const PRIVATE_MARKER = '[private]'

// #norecall at the very start, after whitespace; or, in a note, at the start of its body after a leading YAML
// frontmatter block (`---` to the first `---` or `...` line after it), where the note's own text begins.
const NORECALL = /^\s*#norecall(?![A-Za-z0-9_-])/i
const NORECALL_AFTER_FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:(?!(?:---|\.\.\.)[ \t]*\r?(?:\n|$))[^\n]*\n)*(?:---|\.\.\.)[ \t]*(?:\r?\n|$)\s*#norecall(?![A-Za-z0-9_-])/i
const MAY_MARK = /<\/?private/i
const OPEN = /<private(?:\s[^<>]*)?>/iy
const CLOSE = /<\/private\s*>/iy

function escapedAt(text, at) {
  let n = 0
  for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) n++
  return n % 2 === 1
}

function matchAt(re, text, at) {
  re.lastIndex = at
  const m = re.exec(text)
  return m ? at + m[0].length : -1
}

/**
 * @param {string} text the user's words
 * @returns {{ text: string, norecall: boolean, regions: number }} the text with every private region replaced by
 *   `[private]` ('' when norecall), whether it started with #norecall, and how many outermost regions were replaced
 */
export function stripPrivate(text) {
  if (NORECALL.test(text) || NORECALL_AFTER_FRONTMATTER.test(text)) return { text: '', norecall: true, regions: 0 }
  if (!MAY_MARK.test(text)) return { text, norecall: false, regions: 0 }
  let out = ''
  let depth = 0
  let regions = 0
  let from = 0
  let at = text.indexOf('<')
  while (at !== -1) {
    const escaped = escapedAt(text, at)
    const open = matchAt(OPEN, text, at)
    const close = open === -1 ? matchAt(CLOSE, text, at) : -1
    if (depth === 0) {
      if (open !== -1 && !escaped) {
        out += text.slice(from, at)
        depth = 1
        regions++
        from = open
      }
    } else if (open !== -1) {
      depth++
      from = open
    } else if (close !== -1 && !escaped) {
      depth--
      from = close
      if (depth === 0) out += PRIVATE_MARKER
    }
    // A tag holds no `<` after its first character, so the next candidate is past this one either way.
    at = text.indexOf('<', at + 1)
  }
  out += depth === 0 ? text.slice(from) : PRIVATE_MARKER
  return { text: out, norecall: false, regions }
}
