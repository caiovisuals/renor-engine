import type { ExtractorChatClient } from './extractionClient';

export interface ExtractedFact {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export async function extractFacts(
  client: ExtractorChatClient,
  noteTitle: string,
  noteBody: string,
  model = 'gpt-4o-mini',
): Promise<ExtractedFact[]> {
  // Truncate body to ~3000 chars to stay within reasonable token budget
  const body = noteBody.substring(0, 3000);

  const response = await client.chat.completions.create({
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: `Extract factual statements from the note. Return JSON: {"facts": [{"subject": "...", "predicate": "...", "object": "...", "confidence": 0.0-1.0}]}

Rules:
- subject: the entity the fact is about (use the note title if the note is about one main entity)
- predicate: a short verb phrase (e.g. "works_at", "uses", "depends_on", "is_a", "located_in", "deadline", "created_by")
- object: the target entity or value
- confidence: 0.0-1.0 based on how explicitly the fact is stated
- Extract 0-10 facts. Only extract facts clearly stated in the text.
- Do NOT extract facts from frontmatter metadata — those are handled separately.
- Keep predicates consistent and snake_case.`
      },
      {
        role: 'user',
        content: `Note: "${noteTitle}"\n\n${body}`
      }
    ]
  });

  const content = response.choices[0]?.message.content;
  if (!content) {
    throw new Error('Fact extraction returned empty content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('Fact extraction returned invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { facts?: unknown }).facts)) {
    throw new Error('Fact extraction response is missing a facts array');
  }

  return (parsed as { facts: Array<Partial<Record<keyof ExtractedFact, unknown>>> }).facts.filter((f): f is ExtractedFact =>
    Boolean(f.subject && f.predicate && f.object && typeof f.confidence === 'number')
  );
}
