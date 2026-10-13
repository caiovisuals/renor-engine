import { describe, it, expect } from 'vitest';
import { chunkNote } from '../../src/indexer/chunker';
import { parseNote } from '../../src/indexer/parser';
import { CONVERSATION_MIN_TURNS, isConversationShaped, isTurnLabel } from '../../src/retrieval/conversationShape';

/**
 * Is a note shaped like a conversation? The session expansion limits a statement to 100 tokens in a conversation (where
 * the answer-bearing remark is short and a long turn is an assistant's answer) and to 200 in a document (where the
 * paragraph that answers is often 100 to 200 tokens). The rule is told from the note's own headings, so a chat that was
 * exported and a benchmark session look the same, and it leans to "document": a wrong "document" costs a saving, a wrong
 * "conversation" would drop paragraphs the limit was never measured on.
 */
describe('isTurnLabel: a heading that only says who spoke or which turn it is', () => {
  it.each([
    'Turn 7 — User', 'Turn 12 - Assistant', 'User', 'Assistant:', '### Human', 'AI', 'Q3', 'A', '🧑 User', '**You:**', 'Message 4', 'Question 2', 'Response',
  ])('%s is a turn label', heading => {
    expect(isTurnLabel(heading)).toBe(true);
  });

  it.each([
    'User flow', 'Responses to errors', 'Prompt engineering', 'Answer key for the exam', 'Rollback', 'Merge policy', 'Session abc', '', '—', '2026-10-07',
    'Assistant settings', 'Turn the dial', 'Q3 revenue',
  ])('%s is not', heading => {
    expect(isTurnLabel(heading)).toBe(false);
  });
});

describe('isConversationShaped', () => {
  const session = (turns: number) => ['Session s1', ...Array.from({ length: turns }, (_, i) => `Session s1 > Turn ${i + 1} — ${i % 2 ? 'Assistant' : 'User'}`)];

  it('calls a session one section per turn a conversation, from the minimum turns up', () => {
    expect(CONVERSATION_MIN_TURNS).toBe(4);
    expect(isConversationShaped(session(CONVERSATION_MIN_TURNS))).toBe(true);
    expect(isConversationShaped(session(12))).toBe(true);
    expect(isConversationShaped(session(CONVERSATION_MIN_TURNS - 1))).toBe(false);
    expect(isConversationShaped(session(1))).toBe(false);
  });

  it('reads the last heading of each path, and counts a path once however many chunks it has', () => {
    const paths = [...session(5), ...session(5), 'Session s1 > Turn 2 — Assistant'];
    expect(isConversationShaped(paths)).toBe(true);
    // A turn cut into paragraphs repeats its path, and the repeats are one path: this note has two turn paths, not six.
    expect(isConversationShaped(['Chat', 'Chat > User', 'Chat > User', 'Chat > Assistant', 'Chat > Assistant', 'Chat > User', 'Chat > Assistant'])).toBe(false);
  });

  it('needs a section per turn: bare role headings repeat their path, so such a note has no statement to limit', () => {
    // Every "## User" of a chat shares one heading path, so none is a whole section the expansion could add (and the
    // note is not called a conversation); numbered labels give each turn its own path, as the benchmark's sessions do.
    expect(isConversationShaped(['Chat', 'Chat > User', 'Chat > Assistant', 'Chat > User', 'Chat > Assistant', 'Chat > User'])).toBe(false);
    expect(isConversationShaped(['Chat', 'Chat > User 1', 'Chat > Assistant 1', 'Chat > User 2', 'Chat > Assistant 2'])).toBe(true);
    expect(isConversationShaped(['Q1', 'A1', 'Q2', 'A2'])).toBe(true);
  });

  it('calls a document a document, however it is structured', () => {
    expect(isConversationShaped([])).toBe(false);
    expect(isConversationShaped(['Launch operations'])).toBe(false);
    expect(isConversationShaped(['Launch operations', 'Launch operations > Signup mode', 'Launch operations > Rollback', 'Launch operations > Billing'])).toBe(false);
  });

  it('keeps a document with a few role-word headings a document: they must be at least half of its sections', () => {
    const doc = ['API', 'API > Prompt', 'API > Response', 'API > Question', 'API > Answer', 'API > Errors', 'API > Limits', 'API > Pricing', 'API > Auth'];
    expect(doc.filter(p => isTurnLabel(p.split(' > ').pop()!)).length).toBe(CONVERSATION_MIN_TURNS); // enough turn labels, too few of the sections
    expect(isConversationShaped(doc)).toBe(false);
    expect(isConversationShaped(doc.filter(p => p !== 'API > Auth'))).toBe(true); // one section fewer and they are half
  });

  it('is told from real Markdown through the product chunker: a rendered session, and a document', () => {
    const turns = ['User', 'Assistant', 'User', 'Assistant', 'User'].map((role, i) => `### Turn ${i + 1} — ${role}\n\nSomething said in turn ${i + 1}.`).join('\n\n');
    const chat = chunkNote(parseNote('Sessions/s1.md', `---\nkind: longmemeval-session\n---\n# Session s1\n\nTimestamp: 2023/05/10\n\n${turns}\n`));
    expect(chat.length).toBeGreaterThan(CONVERSATION_MIN_TURNS);
    expect(isConversationShaped(chat.map(c => c.headingPath))).toBe(true);
    const doc = chunkNote(parseNote('docs/ops.md', '# Ops\n\nIntro.\n\n## Signup mode\n\nOpen or waitlist.\n\n## Rollback\n\nRevert the flip.\n\n### Per tenant\n\nSet the variable.\n'));
    expect(isConversationShaped(doc.map(c => c.headingPath))).toBe(false);
  });

  it('does not look at front matter, file names or sources: a document marked as a chat is still a document', () => {
    const marked = chunkNote(parseNote('Sessions/chat.md', '---\nkind: chat-session\nsource: chatgpt\n---\n# Notes on pricing\n\n## Plans\n\nThree plans.\n\n## Limits\n\nTen seats.\n'));
    expect(isConversationShaped(marked.map(c => c.headingPath))).toBe(false);
  });
});
