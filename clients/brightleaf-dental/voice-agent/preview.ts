#!/usr/bin/env tsx
/**
 * Brightleaf Dental Voice Agent — Text Preview Harness
 *
 * Simulates an inbound call against the local cli-bridge server
 * using the Sam system prompt + knowledge base. Produces a
 * transcript the founder can review before the agent goes live.
 *
 * Usage:
 *   BRIDGE_BEARER=xxx npx tsx clients/brightleaf-dental/voice-agent/preview.ts <scenario>
 *
 * Scenarios: new-patient, emergency, delta-dental, reschedule
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BRIDGE_URL = process.env.BRIDGE_URL ?? 'http://127.0.0.1:3355'
const BRIDGE_BEARER = process.env.BRIDGE_BEARER ?? ''
const MODEL = process.env.PREVIEW_MODEL ?? 'pi/deepseek/deepseek-v4-pro'

const SCENARIOS: Record<string, string[]> = {
  'new-patient': [
    '(phone rings)',
    '[AGENT GREETING]',
    'Hi, I need to make an appointment. I just moved to the area.',
    '[AGENT]',
    "Sure, it's Marcus Chen. My number is 919-555-0142.",
    '[AGENT]',
    'Just a routine cleaning and exam.',
    '[AGENT]',
    'I have Delta Dental.',
    '[AGENT]',
  ],
  emergency: [
    '(phone rings)',
    '[AGENT GREETING]',
    "Hi, yeah, I broke a crown this morning and it's really sensitive. Can I come in today?",
    '[AGENT]',
    '2:15 works. Should I take anything before I come in?',
    '[AGENT]',
    "It's Jennifer Park, 919-555-0199.",
    '[AGENT]',
  ],
  'delta-dental': [
    '(phone rings)',
    '[AGENT GREETING]',
    'Do you take Delta Dental? And how soon can I get a cleaning?',
    '[AGENT]',
    'Yes, I have Delta Dental PPO.',
    '[AGENT]',
    "I'm new. I haven't been there before. Actually, I have a chipped tooth that's been bothering me, too. Can the dentist check both?",
    '[AGENT]',
    'Tuesday at 2:30 sounds great.',
    '[AGENT]',
  ],
  reschedule: [
    '(phone rings)',
    '[AGENT GREETING]',
    'Hi, this is Jennifer Park. I need to move my Thursday appointment.',
    '[AGENT]',
    'Friday at 10:00 works.',
    '[AGENT]',
    'No, same reason — cleaning.',
    '[AGENT]',
  ],
}

function loadPrompts(): { system: string; knowledge: string } {
  const base = resolve('clients/brightleaf-dental/voice-agent')
  const system = readFileSync(resolve(base, 'system-prompt.md'), 'utf-8')
  const knowledge = readFileSync(resolve(base, 'knowledge-base.md'), 'utf-8')
  return { system, knowledge }
}

function buildSystemMessage(system: string, knowledge: string): string {
  return `${system}\n\n---\n\nKNOWLEDGE BASE:\n${knowledge}\n\n---\n\nPREVIEW RULES (MUST FOLLOW):\n- This is a text preview of ONE voice call.\n- After each caller line, output EXACTLY ONE reply from Sam.\n- Output ONLY Sam's spoken words. No labels, no stage directions, no markdown, no "User:", no "Assistant:".\n- Speak at 150–170 words per minute: concise, warm, efficient.\n- The very first output must be the mandatory greeting exactly as written in the system prompt.\n- Stop after one reply. Do not write the caller's next line. Do not continue the conversation past your turn.`
}

async function chat(messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>): Promise<string> {
  if (!BRIDGE_BEARER) {
    throw new Error('BRIDGE_BEARER is required. Check .env or pass it as an env var.')
  }
  const res = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${BRIDGE_BEARER}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.6,
      max_tokens: 256,
      stream: false,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`bridge error ${res.status}: ${text}`)
  }
  const json = await res.json()
  return (json.choices?.[0]?.message?.content ?? '').trim()
}

async function runScenario(name: string): Promise<void> {
  const turns = SCENARIOS[name]
  if (!turns) {
    console.error(`Unknown scenario: ${name}. Available: ${Object.keys(SCENARIOS).join(', ')}`)
    process.exit(1)
  }

  const { system, knowledge } = loadPrompts()
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: buildSystemMessage(system, knowledge) },
  ]

  console.log(`\n=== Brightleaf Dental Voice Preview — Scenario: ${name} ===\n`)

  for (const turn of turns) {
    if (turn === '[AGENT GREETING]') {
      messages.push({ role: 'user', content: 'The call just connected. Say the greeting.' })
      const reply = await chat(messages)
      console.log(`SAM:    ${reply}\n`)
      messages.push({ role: 'assistant', content: reply })
      continue
    }
    if (turn === '[AGENT]') {
      const reply = await chat(messages)
      console.log(`SAM:    ${reply}\n`)
      messages.push({ role: 'assistant', content: reply })
      continue
    }
    if (turn.startsWith('(') && turn.endsWith(')')) {
      console.log(turn)
      continue
    }
    console.log(`CALLER: ${turn}`)
    messages.push({ role: 'user', content: turn })
  }
}

const scenario = process.argv[2] ?? 'emergency'
runScenario(scenario).catch((err) => {
  console.error(err)
  process.exit(1)
})
