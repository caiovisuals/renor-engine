/**
 * Benchmark-shaped fixture sessions for the session-router tests: two sessions where the user mentions adopting a
 * cat (in a short turn, between long assistant answers), and two that are about something else.
 */
export const LEDGER = 'System/Memory Events Ledger.md';
export const QUESTION = 'Question date: 2023/05/30 (Tue) 12:00\nWhat are the names of the cats I adopted?';
export const LONG = (topic: string) => `Here is a detailed answer about ${topic}. ` + 'It covers every option, the trade-offs between them, and what to check before deciding. '.repeat(12);

export type Turn = { role: 'user' | 'assistant'; content: string };
export const SESSIONS: Array<{ id: string; date: string; turns: Turn[] }> = [
  {
    id: 'sess-cats-1', date: '2023/05/01 (Mon) 10:00', turns: [
      { role: 'user', content: "I'm thinking about pet insurance. By the way, I adopted a rescue cat named Miso last week." },
      { role: 'assistant', content: LONG('pet insurance') },
      { role: 'user', content: 'Thanks! Miso is three years old.' },
      { role: 'assistant', content: "You're welcome! Enjoy Miso." },
    ],
  },
  {
    id: 'sess-cook-2', date: '2023/05/10 (Wed) 18:30', turns: [
      { role: 'user', content: 'Can you suggest a quick dinner recipe with lentils?' },
      { role: 'assistant', content: LONG('lentil recipes') },
    ],
  },
  {
    id: 'sess-cats-3', date: '2023/05/20 (Sat) 09:15', turns: [
      { role: 'user', content: 'Planning a vet visit. I also adopted a second cat, Tofu, from the shelter yesterday.' },
      { role: 'assistant', content: LONG('vet visits') },
    ],
  },
  {
    id: 'sess-trip-4', date: '2023/05/25 (Thu) 14:00', turns: [
      { role: 'user', content: 'Help me plan a weekend in Lisbon.' },
      { role: 'assistant', content: LONG('Lisbon') },
    ],
  },
];
